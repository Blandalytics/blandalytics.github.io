"""Each team's most recent starting nine against a right-handed and a left-handed starter, for the Game Sim.

    python -I tools/lineup_sims/recent_lineups.py 2026      # writes lineup-sims/data/2026-lineups.json

From the cached play-by-play (fetch_pbp.py: every final regular-season game): for each team and
each hand of the starter it faced (the first pitcher to face it, his hand as he threw), the latest such
game's starting nine in batting order (battingOrder 100, 200, ... 900). Latest is by date, then gamePk (a
doubleheader's two games share a date). The Game Sim's default lineup is the one against the hand of the
other team's starter.

Out: { season, through: last game date, teams: { ABBR: { R: {date, pk, opp, sp, ids}, L: {...} } } };
opp is the other team, sp the starter faced (MLBAM id), ids the nine (MLBAM ids). A team that never
faced one hand has no entry for it.
"""
import json
import pathlib
import sys

TOOL = pathlib.Path(__file__).resolve().parent
REPO = TOOL.parent.parent


def main(season):
    data = json.loads((REPO / "lineup-sims" / "data" / f"{season}.json").read_text(encoding="utf-8"))
    abbr = {t["id"]: t["abbr"] for t in data["teams"]}
    hitters = {row[0] for row in data["players"]}
    best = {}  # (team, hand) -> (date, pk, entry)
    through = ""
    for f in sorted((TOOL / "cache" / "pbp" / str(season)).glob("*.json")):
        if not f.stem.isdigit():
            continue
        g = json.loads(f.read_text(encoding="utf-8"))
        if g.get("type") != "R":
            continue
        cols = g["play_cols"]
        it, ip, ith = cols.index("top"), cols.index("pitcher"), cols.index("throws")
        through = max(through, g["date"])
        for side, top in (("away", 1), ("home", 0)):
            team, opp = abbr[g["teams"][side]["id"]], abbr[g["teams"]["home" if side == "away" else "away"]["id"]]
            first = next((p for p in g["plays"] if p[it] == top), None)
            if first is None:
                continue
            nine = sorted(((int(o), int(pid)) for pid, o in g["order"][side].items() if int(o) % 100 == 0))
            if len(nine) != 9:
                continue
            key, at = (team, first[ith]), (g["date"], g["pk"])
            if key not in best or at > best[key][:2]:
                best[key] = (*at, {"date": g["date"], "pk": g["pk"], "opp": opp, "sp": first[ip], "ids": [pid for _, pid in nine]})
    teams = {}
    for (team, hand), (_, _, e) in sorted(best.items()):
        missing = [pid for pid in e["ids"] if pid not in hitters]
        assert not missing, (team, hand, missing)
        teams.setdefault(team, {})[hand] = e
    assert len(teams) == 30 and all(set(v) == {"R", "L"} for v in teams.values()), {t: sorted(v) for t, v in teams.items()}
    out = {"season": int(season), "through": through, "teams": teams}
    dest = REPO / "lineup-sims" / "data" / f"{season}-lineups.json"
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{dest.name}: 30 teams, vs RHP and vs LHP, through {through}; "
          f"latest vs LHP from {min(v['L']['date'] for v in teams.values())} to {max(v['L']['date'] for v in teams.values())}")


if __name__ == "__main__":
    main(sys.argv[1])
