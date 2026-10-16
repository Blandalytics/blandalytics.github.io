"""Build the lineup simulator's data file from cached play-by-play and FanGraphs.

    python -I tools/lineup_sims/build.py 2026        # writes lineup-sims/data/2026.json

Inputs, under tools/lineup_sims/ (README.md says how each is made):
    cache/pbp/<season>/*.json        fetch_pbp.py
    cache/fangraphs/<season>.json    fangraphs_extract.js, run by hand in a browser

Output, all for the regular season:
    players     every hitter's plate appearances by simulator outcome, and the side he bats
    teams       per team: the nine lineup spots (every hitter who batted there, pooled),
                FanGraphs' most-used batting orders, and the team's actual batting per
                27 outs in innings 1-9
    mlb         the same spots and actuals for the whole league
    running     league-average running game before a plate appearance, by base-out state
    advance     league-average runner advancement on each outcome, by base-out state
    pitchers    every pitcher's batters faced by simulator outcome, with starts and the
                outs recorded in them
    pitching    the outcome counts of every plate appearance (the league baseline for
                log5 matchups) and of those against relievers (the bullpen)

Platoon splits: players, lineup spots, the league and relievers also carry `cells`, the
same counts by the pitcher's hand and the side the batter hit from, keyed hand + side
("RL" is a left-handed batter against a right-hander; a switch hitter's PAs land in the
side he batted from). Pitchers carry theirs by batter side ("L", "R"). Empty cells are
left out.
"""
import collections
import datetime as dt
import json
import pathlib
import sys

import numpy as np
import requests

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # `python -I` leaves it off
import pbp  # noqa: E402

TOOL = pathlib.Path(__file__).resolve().parent
CACHE = TOOL / "cache"
REPO = TOOL.parent.parent
API = "https://statsapi.mlb.com/api"
UA = {"User-Agent": "blandalytics-lineup-sim/0.1"}
CATS = pbp.CATS
# FanGraphs abbreviations that differ from the Stats API's
FG_ABBR = {"ARI": "AZ", "CHW": "CWS", "KCR": "KC", "SDP": "SD", "SFG": "SF", "TBR": "TB", "WSN": "WSH"}
NON_AB = {"walk", "intent_walk", "hit_by_pitch", "sac_fly", "sac_fly_double_play", "sac_bunt",
          "sac_bunt_double_play", "catcher_interf"}


def cached_json(path, url, params):
    if not path.exists():
        r = requests.get(url, params=params, headers=UA, timeout=60)
        r.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(r.text, encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


class Line:
    """A batting line from plate-appearance events, plus outs made and runs scored."""
    FIELDS = ["PA", "AB", "H", "1B", "2B", "3B", "HR", "BB", "IBB", "HBP", "SF", "SH", "K", "R", "outs"]

    def __init__(self):
        self.c = collections.Counter()

    def add_pa(self, event):
        c = self.c
        c["PA"] += 1
        if event not in NON_AB:
            c["AB"] += 1
        hit = {"single": "1B", "double": "2B", "triple": "3B", "home_run": "HR"}.get(event)
        if hit:
            c["H"] += 1
            c[hit] += 1
        c["BB"] += event == "walk"
        c["IBB"] += event == "intent_walk"
        c["HBP"] += event == "hit_by_pitch"
        c["SF"] += event in ("sac_fly", "sac_fly_double_play")
        c["SH"] += event in ("sac_bunt", "sac_bunt_double_play")
        c["K"] += event in ("strikeout", "strikeout_double_play", "strikeout_triple_play")

    def summary(self, w):
        """Per-27-out counts and rate stats, both without intentional walks (as the
        simulator has none): BB is unintentional walks and OBP leaves IBB out."""
        c = self.c
        outs = c["outs"]
        tb = c["1B"] + 2 * c["2B"] + 3 * c["3B"] + 4 * c["HR"]
        obp_den = c["AB"] + c["BB"] + c["HBP"] + c["SF"]
        woba = (w["wBB"] * c["BB"] + w["wHBP"] * c["HBP"] + w["w1B"] * c["1B"] + w["w2B"] * c["2B"]
                + w["w3B"] * c["3B"] + w["wHR"] * c["HR"]) / obp_den
        per27 = {k: round(c[k] * 27 / outs, 4) for k in ("R", "H", "HR", "K", "BB")}
        return {**per27, "AVG": round(c["H"] / c["AB"], 4), "OBP": round((c["H"] + c["BB"] + c["HBP"]) / obp_den, 4),
                "SLG": round(tb / c["AB"], 4), "wOBA": round(woba, 4), "PA27": round(c["PA"] * 27 / outs, 3),
                "outs": outs, "PA": c["PA"]}


def tradeoff_axis(players, w, spot_profiles, min_pa=200, anchor_pa=300, max_range=3.0):
    """The contact-vs-power axis: how 2026 hitters with the same wOBA differ.

    Each hitter's eleven outcome rates are regressed on the hitter's wOBA (PA-weighted); the
    residuals are what wOBA doesn't explain, and they already sum to zero and carry
    zero wOBA. Their first principal component is the axis: more strikeouts, walks
    and homers one way, more singles and balls in play the other. Moving any profile
    along it leaves its wOBA exactly where it was.

    Returns the rate change per standard deviation of hitters along the axis, the
    hitters furthest toward each end, and the sliders' reach: as far as 2026 regulars
    (anchor_pa+) go toward the nearer of the two ends, to the tenth, so a setting at either
    end is one some regular actually has; capped at max_range and where some given
    profile's rate would go below zero.
    """
    wv = np.array([0, w["wBB"], w["wHBP"], w["w1B"], w["w2B"], w["w3B"], w["wHR"], 0, 0, 0, 0])
    rows = [(pid, name, np.array(c, float)) for pid, name, _, c, *_ in players if sum(c) >= min_pa]
    X = np.array([c for *_, c in rows])
    n = X.sum(1)
    R = X / n[:, None]
    weight = n / n.sum()
    A = np.column_stack([np.ones(len(R)), R @ wv])
    beta = np.linalg.solve(A.T @ (A * weight[:, None]), A.T @ (R * weight[:, None]))
    E = R - A @ beta
    vals, vecs = np.linalg.eigh((E * weight[:, None]).T @ E)
    top = np.argmax(vals)
    axis = vecs[:, top] * (1 if vecs[0, top] > 0 else -1)  # + is the strikeout (power) end
    sd = np.sqrt(vals[top])
    per_sd = axis * sd
    assert abs(per_sd.sum()) < 1e-12 and abs(per_sd @ wv) < 1e-12
    score = (E @ axis) / sd
    regulars = sorted((score[i], rows[i][0], rows[i][1]) for i in range(len(rows)) if n[i] >= anchor_pa)
    ends = [[pid, name, round(float(s), 2)] for s, pid, name in regulars[:4] + regulars[-4:]]
    reach = min(max_range, round(min(-regulars[0][0], regulars[-1][0]), 1))
    for p in spot_profiles:
        for c in range(len(CATS)):
            if per_sd[c] < 0:
                reach = min(reach, p[c] / -per_sd[c])
            elif per_sd[c] > 0:
                reach = min(reach, p[c] / per_sd[c])
    return {"per_sd": [float(x) for x in per_sd], "hitters": len(rows), "min_pa": min_pa,
            "share": round(float(vals[top] / vals.sum()), 3), "range": float(np.floor(reach * 10) / 10),
            "ends": ends}


def main(season):
    fg = json.loads((CACHE / "fangraphs" / f"{season}.json").read_text(encoding="utf-8"))
    guts = fg["guts"]
    w = {k: guts[k] for k in ("wBB", "wHBP", "w1B", "w2B", "w3B", "wHR")}

    people = cached_json(CACHE / f"players_{season}.json", f"{API}/v1/sports/1/players",
                         {"season": season})["people"]
    name_of = {p["id"]: p["fullName"] for p in people}
    bats_of = {p["id"]: (p.get("batSide") or {}).get("code", "") for p in people}  # L, R or S (switch)
    team_meta = cached_json(CACHE / f"teams_{season}.json", f"{API}/v1/teams",
                            {"sportId": 1, "season": season})["teams"]
    team_by_abbr = {t["abbreviation"]: t for t in team_meta}

    player_counts = collections.defaultdict(collections.Counter)  # batter -> cat counts
    player_line = collections.defaultdict(Line)
    player_last = {}                                                # batter -> (date, team)
    spot_counts = collections.defaultdict(collections.Counter)      # (team, spot) -> cat counts
    spot_players = collections.defaultdict(collections.Counter)     # (team, spot) -> batter PAs
    team_line_all = collections.defaultdict(Line)                   # every inning, to check vs FanGraphs
    team_line_9 = collections.defaultdict(Line)                     # innings 1-9, for comparisons
    running = collections.defaultdict(collections.Counter)          # "mask,outs" -> run code counts
    advance = collections.defaultdict(collections.Counter)          # "cat,mask,outs" -> event code counts
    starting = collections.defaultdict(collections.Counter)         # team -> starting order counts
    pitcher_counts = collections.defaultdict(collections.Counter)  # pitcher -> cat counts faced
    pitcher_bf = collections.Counter()                              # official batters faced
    pitcher_last = {}                                               # pitcher -> (date, team)
    pitcher_throws = {}
    starts = collections.Counter()                                  # pitcher -> games started
    start_outs = collections.Counter()                              # pitcher -> outs recorded in those starts
    relief = collections.Counter()                                  # cat counts against relievers
    # platoon cells, keyed pitcher hand + batter side ("RL": a lefty batting against a righty)
    cells = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))  # who -> cell -> cat counts
    skipped = 0

    for g in pbp.load_games(season, CACHE):
        abbr = {side: g["teams"][side]["abbr"] for side in ("away", "home")}
        fielding = {"away": abbr["home"], "home": abbr["away"]}
        spot_of = {side: {int(pid): int(code) // 100 for pid, code in g["order"][side].items()}
                   for side in ("away", "home")}
        # the first pitcher each lineup faced started against it
        starter = {}
        for p in g["plays"]:
            starter.setdefault("away" if p[2] else "home", p[6])
        for pid in starter.values():
            starts[pid] += 1
        for side in ("away", "home"):
            starters = sorted((int(code), int(pid)) for pid, code in g["order"][side].items() if int(code) % 100 == 0)
            if len(starters) == 9:
                starting[abbr[side]][tuple(pid for _, pid in starters)] += 1
        for r in pbp.replay(g):
            if "skip" in r:
                skipped += 1
                continue
            team = abbr[r["side"]]
            for line in (team_line_all[team],) + ((team_line_9[team], team_line_9["MLB"]) if r["inning"] <= 9 else ()):
                line.c["R"] += r["runs"]
                line.c["outs"] += r["run_outs"] + r["event_outs"]
                if r["is_pa"]:
                    line.add_pa(r["event"])
            if r["inning"] <= 9 and r["state0"][0]:
                running["%d,%d" % r["state0"]][r["run_code"]] += 1
            pid = r["pitcher"]
            in_start = pid == starter[r["side"]]
            if in_start:
                start_outs[pid] += r["run_outs"] + r["event_outs"]
            if not r["is_pa"]:
                continue
            b = r["batter"]
            player_line[b].add_pa(r["event"])
            player_last[b] = max(player_last.get(b, ("", "")), (g["date"], team))
            pitcher_bf[pid] += 1
            pitcher_last[pid] = max(pitcher_last.get(pid, ("", "")), (g["date"], fielding[r["side"]]))
            pitcher_throws[pid] = r["throws"]
            cat = pbp.category(r["event"], r["traj"])
            if cat is None:
                continue
            pitcher_counts[pid][cat] += 1
            hs = r["throws"] + r["stand"]
            cells[("pitcher", pid)][r["stand"]][cat] += 1
            cells["league"][hs][cat] += 1
            if not in_start:
                relief[cat] += 1
                cells["relief"][hs][cat] += 1
            spot = spot_of[r["side"]].get(b)
            player_counts[b][cat] += 1
            cells[("batter", b)][hs][cat] += 1
            if spot:
                for key in ((team, spot), ("MLB", spot)):
                    spot_counts[key][cat] += 1
                    spot_players[key][b] += 1
                    cells[("spot",) + key][hs][cat] += 1
            if r["inning"] <= 9:
                code = r["event_code"] + ("s" if r["event"] in ("sac_fly", "sac_fly_double_play") else "")
                advance["%s,%d,%d" % ((cat,) + r["state1"])][code] += 1

    print(f"{skipped} half-innings skipped (did not reconcile with the feed)")

    def cells_of(who):
        """A cells table as stored: cell -> counts in CATS order, empty cells left out."""
        return {k: [cnt[c] for c in CATS] for k, cnt in sorted(cells[who].items()) if sum(cnt.values())}
    teams_sorted = sorted(t for t in team_line_9 if t != "MLB")
    assert len(teams_sorted) == 30, teams_sorted

    # --- checks against FanGraphs ---------------------------------------------------
    fg_cols = fg["team_bat_cols"]
    worst = collections.Counter()
    for row in fg["team_bat"]:
        t = dict(zip(fg_cols, row))
        mine = team_line_all[FG_ABBR.get(t["team"], t["team"])].c
        for k_fg, k_me in (("PA", "PA"), ("AB", "AB"), ("R", "R"), ("H", "H"), ("HR", "HR"), ("SO", "K"),
                           ("HBP", "HBP"), ("SF", "SF"), ("IBB", "IBB")):
            worst[k_fg] = max(worst[k_fg], abs(mine[k_me] - t[k_fg]))
        worst["BB"] = max(worst["BB"], abs(mine["BB"] + mine["IBB"] - t["BB"]))
    print("largest team-total gap vs FanGraphs:", dict(worst))

    # --- players ---------------------------------------------------------------------
    players = []
    for b, cnt in player_counts.items():
        n = sum(cnt.values())
        if n == 0:
            continue
        # counts feed the rates; the official PA (with IBB, bunts, interference) is for display
        players.append([b, name_of.get(b, str(b)), player_last[b][1], [cnt[c] for c in CATS], player_line[b].c["PA"],
                        cells_of(("batter", b)), bats_of.get(b, "")])
    players.sort(key=lambda p: -sum(p[3]))

    # --- pitchers ----------------------------------------------------------------------
    # counts feed the matchups; batters faced (official, with IBB and bunts) is for display
    pitchers = [[pid, name_of.get(pid, str(pid)), pitcher_last[pid][1], pitcher_throws[pid], [cnt[c] for c in CATS],
                 pitcher_bf[pid], starts[pid], start_outs[pid], cells_of(("pitcher", pid))]
                for pid, cnt in pitcher_counts.items() if sum(cnt.values())]
    pitchers.sort(key=lambda p: -sum(p[4]))
    league = collections.Counter()
    for cnt in pitcher_counts.values():
        league.update(cnt)
    assert league == sum(player_counts.values(), collections.Counter())
    pitching = {"league": [league[c] for c in CATS], "relief": [relief[c] for c in CATS],
                "cells": cells_of("league"), "relief_cells": cells_of("relief")}
    # every split adds back up to its whole
    total = lambda table: [sum(v[i] for v in table.values()) for i in range(len(CATS))]  # noqa: E731
    assert total(pitching["cells"]) == pitching["league"] and total(pitching["relief_cells"]) == pitching["relief"]
    for row in players:
        assert total(row[5]) == row[3], row[:2]
    # a switch hitter bats left against right-handers and right against left-handers
    sw = [row for row in players if row[6] == "S"]
    odd = sum(v for row in sw for k, c in row[5].items() if k in ("RR", "LL") for v in [sum(c)])
    print(f"{len(sw)} switch hitters; {odd} of their {sum(sum(row[3]) for row in sw)} PA from the same side as the pitcher")
    for row in pitchers:
        assert total(row[8]) == row[4], row[:2]
    relief_pa = {k: sum(v) for k, v in pitching["relief_cells"].items()}
    print("platoon cells (PA):", {k: sum(v) for k, v in pitching["cells"].items()},
          f"; relievers' LHP share {(relief_pa.get('LL', 0) + relief_pa.get('LR', 0)) / sum(relief_pa.values()):.1%}")
    n_league, n_relief = sum(league.values()), sum(relief.values())
    print(f"{len(pitchers)} pitchers; relievers faced {n_relief / n_league:.1%} of plate appearances, "
          f"K {relief['K'] / n_relief:.1%} vs {league['K'] / n_league:.1%} overall; "
          f"{sum(starts.values())} starts, {sum(start_outs.values()) / sum(starts.values()) / 3:.2f} innings on average")

    # --- most-used orders (FanGraphs) and a check against the box scores ---------------
    fg_to_mlbam = {k: int(v) for k, v in fg["fg_to_mlbam"].items()}
    most_used = {}
    agree = 0
    for teamid, fg_abb, games, distinct, orders in fg["teams"]:
        t = FG_ABBR.get(fg_abb, fg_abb)
        # game and order counts from the box scores; FanGraphs' tracker also lists a few
        # games that were never completed (fg_games)
        most_used[t] = {"games": sum(starting[t].values()), "distinct": len(starting[t]), "fg_games": games,
                        "orders": [{"uses": n, "vsR": R, "vsL": L, "last": last,
                                    "ids": [fg_to_mlbam[i] for i in ids.split()]} for n, R, L, last, ids in orders]}
        box_top = starting[t].most_common(1)[0]
        fg_top = tuple(most_used[t]["orders"][0]["ids"])
        top_n = box_top[1]
        tied = {o for o, n in starting[t].items() if n == top_n}
        agree += fg_top in tied and most_used[t]["orders"][0]["uses"] == top_n
    print(f"FanGraphs' most-used order is also a most-used order in the box scores for {agree}/30 teams")

    # --- teams -------------------------------------------------------------------------
    def spots(team):
        out = []
        for s in range(1, 10):
            cnt = spot_counts[(team, s)]
            top = spot_players[(team, s)].most_common(4)
            out.append({"counts": [cnt[c] for c in CATS], "top": [[pid, n] for pid, n in top],
                        "cells": cells_of(("spot", team, s))})
            assert total(out[-1]["cells"]) == out[-1]["counts"], (team, s)
        return out

    teams = []
    for t in teams_sorted:
        meta = team_by_abbr[t]
        teams.append({"abbr": t, "name": meta["name"], "short": meta["teamName"], "id": meta["id"],
                      "league": meta["league"]["name"].split()[0], "spots": spots(t),
                      "most_used": most_used[t], "actual": team_line_9[t].summary(w)})
    mlb = {"spots": spots("MLB"), "actual": team_line_9["MLB"].summary(w)}

    def table(counter):
        return {k: sorted(v.items(), key=lambda kv: -kv[1]) for k, v in sorted(counter.items())}

    thin = sorted((sum(v.values()), k) for k, v in advance.items() if sum(v.values()) < 30)
    print(f"advance cells: {len(advance)}; under 30 plate appearances: {len(thin)}", thin[:12])

    # the tradeoff is applied to the MLB-average spots (some team spots have no triples at
    # all, so a straight-line shift can't move them without going below zero)
    profiles = [np.array(s["counts"], float) / sum(s["counts"]) for s in mlb["spots"]]
    tradeoff = tradeoff_axis(players, w, profiles)
    # sacrifice flies per fly-ball out, to estimate at-bats (and so AVG and SLG) from a profile
    fb_outs = sum(c["FB"] for c in player_counts.values())
    tradeoff["sf_per_fb"] = round(sum(line.c["SF"] for line in team_line_all.values()) / fb_outs, 5)
    print("contact-power axis, per SD:", dict(zip(CATS, (round(x * 100, 2) for x in tradeoff["per_sd"]))),
          f"share {tradeoff['share']}, range ±{tradeoff['range']}, ends", tradeoff["ends"])

    out = {
        "season": season, "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "range": [fg["start"], fg["end"]], "fangraphs_extracted": fg["extracted"],
        "weights": {**w, "wOBA": guts["wOBA"], "wOBAScale": guts["wOBAScale"]},
        "cats": CATS, "players": players, "pitchers": pitchers, "pitching": pitching, "teams": teams, "mlb": mlb,
        "running": table(running), "advance": table(advance), "tradeoff": tradeoff,
    }
    dest = REPO / "lineup-sims" / "data" / f"{season}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size:,} bytes): {len(players)} players")
    print("MLB actual, innings 1-9:", mlb["actual"])


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2026)
