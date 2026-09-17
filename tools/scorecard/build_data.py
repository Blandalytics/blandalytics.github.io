"""Assemble scorecard data: statfast pitch data + statsapi feed -> scorecard_<pk>.json"""
import json
import sys
import pandas as pd
from collections import defaultdict, Counter

BASE = {"1B": 1, "2B": 2, "3B": 3, "score": 4}
STRIKE_CODES = set("CSFTLMWXDE")          # everything but B, *B, H
AIR = {"fly_ball": "F", "popup": "P", "line_drive": "L"}

# outcome weights: colour scale and the wOBA numerator both read from this
WEIGHT = {"home_run": 2.0, "triple": 1.6, "double": 1.25, "single": 0.9,
          "walk": 0.7, "intent_walk": 0.7, "hit_by_pitch": 0.7,
          "catcher_interf": 0.7}


# set per game by build(); the helpers below read them
feed = box = line = plays = df = None


# Batted ball quality, from Tango's Statcast Lab barrels post (comment #37).
# Evaluated in order, first match wins, exactly as the original CASE expression.
# The Flare-or-Burner class is then split: burners are the flat ones (LA <= 20).
HIT_LABEL = {"single": "1B", "double": "2B", "triple": "3B", "home_run": "HR"}

BB_LABEL = {6: "BRL", 5: "SLD", 3: "UND", 2: "TOP", 1: "WEAK", 0: "UNC"}


def batted_ball(speed, angle):
    """Return (code, short label) for an exit velocity / launch angle pair."""
    if speed is None or angle is None:
        return None, None
    if ((speed * 1.5 - angle) >= 117 and (speed + angle) >= 124
            and speed >= 98 and 4 <= angle <= 50):
        code = 6
    elif ((speed * 1.5 - angle) >= 111 and (speed + angle) >= 119
            and speed >= 95 and 0 <= angle <= 52):
        code = 5
    elif speed <= 59:
        code = 1
    elif ((speed * 2 - angle) >= 87 and angle <= 41 and (speed * 2 + angle) <= 175
            and (speed + angle * 1.3) >= 89 and 59 <= speed <= 72):
        code = 4
    elif ((speed + angle * 1.3) <= 112 and (speed + angle * 1.55) >= 92
            and 72 <= speed <= 86):
        code = 4
    elif angle <= 20 and (speed + angle * 2.4) >= 98 and 86 <= speed <= 95:
        code = 4
    elif ((speed - angle) >= 76 and (speed + angle * 2.4) >= 98
            and speed >= 95 and angle <= 30):
        code = 4
    elif (speed + angle * 2) >= 116:
        code = 3
    elif (speed + angle * 2) <= 116:
        code = 2
    else:
        code = 0
    if code == 4:
        return code, ("BRN" if angle <= 20 else "FLR")
    return code, BB_LABEL[code]


def hit_info(play):
    for e in reversed(play.get("playEvents", [])):
        if e.get("hitData"):
            return e["hitData"].get("trajectory"), e["hitData"].get("location")
    return None, None


def fielding_chain(play, only_putout=False):
    """Position-number chain, e.g. 6-3, from runner credits."""
    seen, chain = set(), []
    for r in play["runners"]:
        for c in r.get("credits", []):
            kind = c["credit"]
            if kind not in ("f_assist", "f_putout"):
                continue
            if only_putout and kind != "f_putout":
                continue
            key = (c["player"]["id"], kind)
            if key in seen:
                continue
            seen.add(key)
            chain.append(c["position"]["code"])
    return "-".join(chain)


DP_LABEL = {"grounded_into_double_play": "DP", "double_play": "DP",
            "strikeout_double_play": "DP", "grounded_into_triple_play": "TP",
            "triple_play": "TP", "strikeout_triple_play": "TP"}


AUTO_CALL = ("Automatic Ball", "Automatic Strike")


def merged_seq(play, pitch_rows):
    """The scraper's tracked pitches with automatic ball/strike calls put back
    where they happened. Those are not pitches, so the scraper skips them, but
    they belong in the sequence: one can end the plate appearance."""
    out, i = [], 0
    for e in play.get("playEvents") or []:
        det = e.get("details") or {}
        desc = det.get("description") or ""
        if e.get("isPitch") and e.get("pitchData"):
            if i < len(pitch_rows):
                out.append(pitch_rows[i])
                i += 1
        elif desc.startswith(AUTO_CALL):
            out.append([None, "", None, desc])       # un-numbered: not a pitch
    out.extend(pitch_rows[i:])                       # anything unaccounted for
    return out


def clock_violation(play):
    """True when a pitch timer violation, not a pitch, ended the plate
    appearance: an automatic ball four or automatic strike three."""
    events = play.get("playEvents") or []
    if not events:
        return False
    v = (events[-1].get("details") or {}).get("violation") or {}
    return "timer" in (v.get("type") or "")


def notation(play):
    ev = play["result"]["eventType"]
    desc = play["result"]["description"]
    traj, _ = hit_info(play)
    if ev == "strikeout":
        return "K"                        # k_looking flag drives the backwards K
    if ev in ("walk", "intent_walk"):
        return "IBB" if ev == "intent_walk" else "BB"
    if ev == "hit_by_pitch":
        return "HBP"
    if ev == "home_run":
        return "HR"
    if ev in ("single", "double", "triple"):
        return {"single": "1B", "double": "2B", "triple": "3B"}[ev]
    if ev == "field_error":
        return "E" + (fielding_chain(play) or "")
    chain = fielding_chain(play)
    prefix = ""
    if ev in ("fielders_choice", "fielders_choice_out"):
        prefix = "FC "
    elif ev in ("grounded_into_double_play", "double_play", "strikeout_double_play"):
        prefix = ""                       # DP goes on its own line, see dp_label
    elif ev in ("grounded_into_triple_play", "triple_play", "strikeout_triple_play"):
        prefix = ""
    elif ev == "sac_fly":
        prefix = "SF "
    elif ev == "sac_bunt":
        prefix = "SAC "
    if traj in AIR and chain and "-" not in chain:
        return prefix + AIR[traj] + chain
    if traj == "ground_ball" and chain and "-" not in chain:
        return prefix + chain + "U"          # unassisted putout
    return (prefix + chain).strip() or play["result"]["event"]


# --- lineups, keeping substitutions in their slot -------------------------
def lineup(side):
    slots = defaultdict(list)
    for key, p in box["teams"][side]["players"].items():
        bo = p.get("battingOrder")
        if not bo:
            continue
        s = p["stats"]["batting"]
        slots[int(bo) // 100].append({
            "order": int(bo), "id": p["person"]["id"],
            "name": p["person"]["fullName"],
            "pos": "/".join(dict.fromkeys(x["abbreviation"] for x in p.get("allPositions", [])))
                   or p["position"]["abbreviation"],
            "sub": int(bo) % 100 != 0,
            "ab": s.get("atBats", 0), "r": s.get("runs", 0), "h": s.get("hits", 0),
            "rbi": s.get("rbi", 0), "bb": s.get("baseOnBalls", 0),
            "k": s.get("strikeOuts", 0), "lob": s.get("leftOnBase", 0),
            "pa": s.get("plateAppearances", 0), "sb": s.get("stolenBases", 0),
            "hbp": s.get("hitByPitch", 0), "ci": s.get("catchersInterference", 0),
            "double": s.get("doubles", 0), "triple": s.get("triples", 0),
            "hr": s.get("homeRuns", 0),
            "summary": s.get("summary", ""),
        })
    return [sorted(v, key=lambda x: x["order"]) for _, v in sorted(slots.items())]


def pitchers(side):
    out = []
    for pid in box["teams"][side]["pitchers"]:
        p = box["teams"][side]["players"]["ID%d" % pid]
        s = p["stats"]["pitching"]
        g = df[df.pitcher == pid]
        mix = []
        if len(g):
            vc = g.pitch_type.value_counts()
            for pt in vc[vc > 0].index[:4]:
                sub = g[g.pitch_type == pt]
                mix.append({"type": str(pt), "n": int(len(sub)),
                            "pct": round(100 * len(sub) / len(g)),
                            "velo": round(float(sub.release_speed.mean()), 1)})
        out.append({
            "id": pid, "name": p["person"]["fullName"],
            "ip": s.get("inningsPitched", "0.0"), "h": s.get("hits", 0),
            "r": s.get("runs", 0), "er": s.get("earnedRuns", 0),
            "bb": s.get("baseOnBalls", 0), "k": s.get("strikeOuts", 0),
            "hr": s.get("homeRuns", 0), "bf": s.get("battersFaced", 0),
            "note": s.get("note", ""),
            "pitches": int(len(g)),
            "strikes": int(g.call_code.isin(STRIKE_CODES).sum()) if len(g) else 0,
            "avg_velo": round(float(g.release_speed.mean()), 1) if len(g) else None,
            "max_velo": round(float(g.release_speed.max()), 1) if len(g) else None,
            "mix": mix,
        })
    return out


def team(side):
    t = box["teams"][side]
    bs = t["teamStats"]["batting"]
    return {
        "side": side, "name": t["team"]["name"],
        "abbr": feed["gameData"]["teams"][side].get("abbreviation", ""),
        "nickname": feed["gameData"]["teams"][side].get("teamName", ""),
        "record": feed["gameData"]["teams"][side].get("record", {}),
        "lineup": lineup(side), "pitchers": pitchers(side),
        "totals": {k: bs.get(k, 0) for k in
                   ("atBats", "runs", "hits", "rbi", "baseOnBalls", "strikeOuts", "leftOnBase",
                    "plateAppearances", "stolenBases", "hitByPitch", "catchersInterference",
                    "doubles", "triples", "homeRuns")},
    }


def build(game_pk, feed_json, pitches_df):
    """Assemble the scorecard dict for one game from its feed and pitch data."""
    global feed, box, line, plays, df
    feed = feed_json
    box = feed["liveData"]["boxscore"]
    line = feed["liveData"]["linescore"]
    plays = feed["liveData"]["plays"]["allPlays"]
    df = pitches_df

    # --- per-at-bat aggregates from the scraper -------------------------------
    pit = {}
    for abi, g in df.groupby("at_bat_index", observed=True):
        last = g.iloc[-1]
        bip = g.dropna(subset=["launch_speed"])
        pit[int(abi)] = {
            "pitches": len(g),
            "strikes": int(g.call_code.isin(STRIKE_CODES).sum()),
            "ev": round(float(bip.launch_speed.iloc[-1]), 1) if len(bip) else None,
            "la": int(bip.launch_angle.iloc[-1]) if len(bip) else None,
            "dist": int(bip.hit_distance.iloc[-1]) if len(bip) and pd.notna(bip.hit_distance.iloc[-1]) else None,
            # every pitch of the plate appearance: number, type, velo, result
            "seq": [[int(r.pitch_number),
                     str(r.pitch_type) if pd.notna(r.pitch_type) else "--",
                     round(float(r.release_speed), 1), str(r.description)]
                    for r in g.itertuples()],
            "bb_label": (batted_ball(float(bip.launch_speed.iloc[-1]),
                                     float(bip.launch_angle.iloc[-1]))[1] if len(bip) else None),
            "final_pitch": str(last.pitch_type) if pd.notna(last.pitch_type) else None,
            "final_velo": round(float(last.release_speed), 1),
            # the count the batter was in for the deciding pitch: the count after the
            # pitch before it (statcast counts are post-pitch), so 3-2 is the ceiling
            "cnt_b": int(g.iloc[-2].balls) if len(g) > 1 else 0,
            "cnt_s": int(g.iloc[-2].strikes) if len(g) > 1 else 0,
        }

    # --- walk each half inning, tracking every batter as a runner -------------
    halves = defaultdict(list)
    for p in plays:
        halves[(p["about"]["inning"], p["about"]["halfInning"])].append(p)

    pas = []                                    # one record per plate appearance
    for (inning, half), hp in sorted(halves.items()):
        live = {}                               # runner id -> their PA record
        for play in hp:
            bid = play["matchup"]["batter"]["id"]
            abi = play["about"]["atBatIndex"]
            traj, loc = hit_info(play)
            rec = {
                "inning": inning, "half": half, "batter": bid, "abi": abi,
                "pitcher": play["matchup"]["pitcher"]["id"],
                "notation": notation(play), "event": play["result"]["event"],
                "dp_label": DP_LABEL.get(play["result"]["eventType"]),
            "clock_violation": clock_violation(play),
                "k_looking": play["result"]["eventType"] == "strikeout"
                             and "swinging" not in play["result"]["description"],
                "eventType": play["result"]["eventType"],
                "desc": play["result"]["description"],
                "rbi": play["result"]["rbi"], "reached": 0, "scored": False,
                "weight": WEIGHT.get(play["result"]["eventType"], 0.0),
                "play_outs": sorted(r["movement"]["outNumber"] for r in play["runners"]
                                    if r["movement"].get("isOut")
                                    and r["movement"].get("outNumber")),
                "out": False, "out_number": None, "traj": traj, "loc": loc,
                "balls": play["count"]["balls"], "strikes_count": play["count"]["strikes"],
            }
            rec.update(pit.get(abi, {}))
            rec["seq"] = merged_seq(play, rec.get("seq") or [])
            # the pitch put in play carries the batted ball result instead of a
            # pitch description: what it went for, how hard, and at what angle
            if rec.get("seq") and rec.get("ev") is not None:
                hit = HIT_LABEL.get(rec["eventType"], "Out")
                for row in rec["seq"]:
                    if row[3].startswith("In play"):
                        row.extend([hit, rec["ev"], rec["la"]])
            pas.append(rec)
            live[bid] = rec                     # batter is now the tracked runner
            for r in play["runners"]:
                rid = r["details"]["runner"]["id"]
                tracked = live.get(rid)
                if tracked is None:
                    continue
                mv = r["movement"]
                end = BASE.get(mv.get("end") or "")
                if end:
                    tracked["reached"] = max(tracked["reached"], end)
                    if end == 4:
                        tracked["scored"] = True
                        live.pop(rid, None)
                if mv.get("isOut"):
                    tracked["out"] = True
                    tracked["out_number"] = mv.get("outNumber")
                    tracked["out_base"] = mv.get("outBase")
                    live.pop(rid, None)

            # how far the batter got on this play alone; anything past this he
            # took later, on someone else's plate appearance
            rec["reached_pa"] = rec["reached"]

    # a PA that ends the inning with the batter still on base is neither out nor scored
    for r in pas:
        r["stranded"] = not r["out"] and not r["scored"]

    # the first and last plate appearances of each half inning are its boundaries,
    # and get the corner brackets in the grid
    by_half = defaultdict(list)
    for r in pas:
        by_half[(r["inning"], r["half"])].append(r)
    for group in by_half.values():
        group[0]["inning_start"] = True
        group[-1]["inning_end"] = True

    data = {
        "game_pk": game_pk,
        "date": feed["gameData"]["datetime"]["officialDate"],
        "venue": feed["gameData"]["venue"]["name"],
        "weather": feed["gameData"].get("weather", {}),
        "info": box.get("info", []),
        "away": team("away"), "home": team("home"),
        "linescore": {
            "innings": [{"num": i["num"],
                         "away": i.get("away", {}).get("runs"),
                         "home": i.get("home", {}).get("runs")} for i in line["innings"]],
            "totals": {s: {"r": line["teams"][s].get("runs", 0),
                           "h": line["teams"][s].get("hits", 0),
                           "e": line["teams"][s].get("errors", 0)} for s in ("away", "home")},
        },
        "pas": pas,
        "pitch_count": len(df),
    }
    return data


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    game_pk = int(argv[0]) if argv else 824638
    data = build(game_pk,
                 json.load(open("feed_%d.json" % game_pk, encoding="utf-8")),
                 pd.read_parquet("pitches_%d.parquet" % game_pk))
    json.dump(data, open("scorecard_%d.json" % game_pk, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    pas = data["pas"]
    print("PAs:", len(pas), "| pitches:", data["pitch_count"])
    print("scored PAs:", sum(r["scored"] for r in pas), "vs runs:",
          data["linescore"]["totals"]["away"]["r"] + data["linescore"]["totals"]["home"]["r"])
    print("outs recorded:", sum(r["out"] for r in pas))
    print("notations:", Counter(r["notation"] for r in pas).most_common(14))


if __name__ == "__main__":
    main()
