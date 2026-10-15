"""Replay cached play-by-play into plate appearances with base-out states.

Every play is split into two phases:

* the running phase - movements on events before the final pitch (steals, caught
  stealing, pickoffs, wild pitches, passed balls, balks), and plays the batter never
  finished (the inning ended on a caught stealing or pickoff);
* the event phase - movements on the final pitch: the batter's result and what every
  runner did on it.

A phase's result is coded one digit per runner, lead runner first (3rd, 2nd, 1st),
then the batter for the event phase: 0 = out, 1-3 = the base reached, 4 = scored.
With bases loaded, "4321" on a single is everyone moving up one base.
"""
import json
import pathlib

BASE = {"1B": 1, "2B": 2, "3B": 3}
PLAY_COLS = ["ab", "inning", "top", "event", "outs", "batter", "pitcher", "stand", "throws",
             "traj", "last_pitch", "post", "away_score", "home_score", "runners"]

# the batter's plate appearance ends in one of these (anything else is a running play
# that ended the inning or the game before the batter finished)
BATTER_EVENTS = {
    "strikeout", "strikeout_double_play", "strikeout_triple_play", "walk", "intent_walk", "hit_by_pitch",
    "single", "double", "triple", "home_run", "field_out", "force_out", "grounded_into_double_play",
    "double_play", "triple_play", "fielders_choice", "fielders_choice_out", "field_error", "sac_fly",
    "sac_fly_double_play", "sac_bunt", "sac_bunt_double_play", "catcher_interf", "batter_interference",
    "fan_interference",
}
IN_PLAY_OUT = {"field_out", "force_out", "grounded_into_double_play", "double_play", "triple_play",
               "fielders_choice", "fielders_choice_out", "field_error", "sac_fly", "sac_fly_double_play"}
TRAJ = {"ground_ball": "GB", "bunt_grounder": "GB", "line_drive": "LD", "bunt_line_drive": "LD",
        "fly_ball": "FB", "popup": "PU", "bunt_popup": "PU"}
# when a ball in play has no trajectory, the event usually says what it was
TRAJ_FALLBACK = {"grounded_into_double_play": "GB", "force_out": "GB", "fielders_choice": "GB",
                 "fielders_choice_out": "GB", "sac_fly": "FB", "sac_fly_double_play": "FB"}

# the simulator's batter outcomes; IBB, sacrifice bunts and interference are left out
CATS = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "GB", "LD", "FB", "PU"]


def category(event, traj):
    if event in ("strikeout", "strikeout_double_play", "strikeout_triple_play"):
        return "K"
    if event == "walk":
        return "BB"
    if event == "hit_by_pitch":
        return "HBP"
    hit = {"single": "1B", "double": "2B", "triple": "3B", "home_run": "HR"}.get(event)
    if hit:
        return hit
    if event in IN_PLAY_OUT:
        return TRAJ.get(traj) or TRAJ_FALLBACK.get(event) or "GB"
    return None  # intent_walk, sac_bunt, catcher_interf, ...


def mask_of(bases):
    return sum(1 << (b - 1) for b in (1, 2, 3) if bases.get(b) is not None)


class Inconsistent(Exception):
    pass


def apply_phase(bases, movements, with_batter, batter, outs_before):
    """Apply one phase's movements to `bases` (base -> runner id), in place.

    Returns (code, runs, outs). Each runner's segments in the phase are chained,
    first start to last end, so a batter who reaches first and takes second on the
    throw ends on 2nd. Once the phase makes the third out the feed stops listing the
    other runners' forced moves, so where they stand no longer has to add up.
    """
    per = {}
    for rid, start, end, out, *_ in movements:
        s = 0 if start is None else BASE[start]
        e = 4 if end == "score" else BASE.get(end, 0)
        if rid not in per:
            per[rid] = [s, e, out]
        else:
            per[rid][1] = e
            per[rid][2] = per[rid][2] or out
    # who started the phase where; a pinch runner can carry a new id on an occupied base
    start_of = {}
    for rid, (s, e, out) in per.items():
        if s == 0:
            if not with_batter or rid != batter:
                raise Inconsistent(f"runner {rid} starts at home outside the event phase")
        else:
            if bases.get(s) is None:
                raise Inconsistent(f"runner {rid} leaves empty base {s}")
        start_of[rid] = s
    end_of = {}
    for rid, (s, e, out) in per.items():
        end_of[s] = 0 if out else e
    lead_first = [b for b in (3, 2, 1) if bases.get(b) is not None]
    digits = [str(end_of.get(b, b)) for b in lead_first]
    if with_batter:
        digits.append(str(end_of.get(0, 0)))
    code = "".join(digits)
    if outs_before + code.count("0") >= 3:
        bases.clear()
        return code, code.count("4"), code.count("0")
    new = {}
    for b in lead_first:
        e = end_of.get(b, b)
        rid = next((r for r, s in start_of.items() if s == b), bases[b])
        if 1 <= e <= 3:
            if e in new:
                raise Inconsistent(f"two runners end on {e}")
            new[e] = rid
    if with_batter and 1 <= end_of.get(0, 0) <= 3:
        e = end_of[0]
        if e in new:
            raise Inconsistent(f"batter and runner both end on {e}")
        new[e] = batter
    bases.clear()
    bases.update(new)
    return code, code.count("4"), code.count("0")


def half_innings(game):
    """Group a game's plays into half-innings, in order."""
    cur, key = [], None
    for p in game["plays"]:
        k = (p[1], p[2])
        if k != key and cur:
            yield key, cur
            cur = []
        key = k
        cur.append(p)
    if cur:
        yield key, cur


def replay(game):
    """Yield one record per play of a game, with states before and after each phase.

    Half-innings whose movements don't reconcile with the feed's outs, runners or
    score are skipped and reported as {"skip": reason}.
    """
    score = {"away": 0, "home": 0}
    for (inning, top), plays in half_innings(game):
        side = "away" if top else "home"
        recs = []
        # extra innings open with a runner on 2nd, which the feed doesn't list as a movement
        bases, outs = ({2: "placed"} if inning >= 10 else {}), 0
        start_score = dict(score)
        try:
            for p in plays:
                ab, _, _, event, outs_after, batter, pitcher, stand, throws, traj, last, post, a, h, runners = p
                # extra innings open with a runner placed on 2nd, shown as a movement from nowhere
                placed = [r for r in runners if r[6] == "r_runner_placed" or (r[1] is None and r[0] != batter)]
                for r in placed:
                    bases[BASE[r[2]]] = r[0]
                runners = [r for r in runners if r not in placed]
                is_pa = event in BATTER_EVENTS
                split = last if (is_pa and last is not None) else None
                if is_pa and split is None:
                    pre, evt = [], runners  # automatic intentional walk: no pitches
                elif is_pa:
                    pre = [r for r in runners if r[4] is not None and r[4] < split]
                    evt = [r for r in runners if r[4] is None or r[4] >= split]
                else:
                    pre, evt = runners, []
                state0 = (mask_of(bases), outs)
                rcode, rruns, routs = apply_phase(bases, pre, False, batter, outs)
                outs1 = outs + routs
                state1 = (mask_of(bases), outs1)
                ecode, eruns, eouts = (None, 0, 0)
                if is_pa:
                    ecode, eruns, eouts = apply_phase(bases, evt, True, batter, outs1)
                outs2 = outs1 + eouts
                if outs2 != outs_after:
                    raise Inconsistent(f"outs {outs2} != feed {outs_after} at ab {ab}")
                runs = rruns + eruns
                new_score = a if side == "away" else h
                if new_score is not None and score[side] + runs != new_score:
                    raise Inconsistent(f"runs {score[side]}+{runs} != feed {new_score} at ab {ab}")
                score[side] += runs
                if outs2 < 3:
                    feed_mask = sum(1 << i for i, pid in enumerate(post) if pid is not None)
                    if feed_mask != mask_of(bases):
                        raise Inconsistent(f"bases {mask_of(bases)} != feed {feed_mask} at ab {ab}")
                    # carry the feed's ids forward (pinch runners between plays)
                    bases = {i + 1: pid for i, pid in enumerate(post) if pid is not None}
                recs.append({
                    "ab": ab, "inning": inning, "side": side, "event": event, "is_pa": is_pa,
                    "batter": batter, "pitcher": pitcher, "stand": stand, "throws": throws, "traj": traj,
                    "state0": state0, "run_code": rcode, "run_runs": rruns, "run_outs": routs,
                    "state1": state1, "event_code": ecode, "event_runs": eruns, "event_outs": eouts,
                    "outs_after": outs2, "runs": runs,
                })
                outs = outs2
            for r in recs:
                yield r
        except Inconsistent as e:
            score = start_score
            # resync the score from the half-inning's last play so later halves still check
            last_play = plays[-1]
            score["away"], score["home"] = last_play[12] or score["away"], last_play[13] or score["home"]
            yield {"skip": str(e), "inning": inning, "side": side, "plays": len(plays)}


def load_games(season, cache):
    folder = pathlib.Path(cache) / "pbp" / str(season)
    for f in sorted(folder.glob("[0-9]*.json")):
        yield json.loads(f.read_text(encoding="utf-8"))
