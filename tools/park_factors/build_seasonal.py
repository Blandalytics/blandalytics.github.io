"""Build the Seasonal view's data for blandalytics.com/park-factors/: one JSON per level and year.

The park model's seasonal fit gives each park's factors week by week: its
park_factors_seasonal_weekly_2027.csv (MLB 2027, on the 2027 schedule, by batter side) and
park_factors_seasonal_history.csv (every level and season it covers, MLB 2015- and the minors
2021-, from the games played; all batters, plus batter sides for each minor level's most recent
season). Each index is against the level's parks in use that week; the "<level> average" rows
are the league that week against its season average.

This writes park-factors/seasonal/<level>_<year>.json (A+ as Aplus), which the page fetches when
the Seasonal view opens on that level and year:
  {"level", "year", "weeks": [[first "MM-DD", last, label], ...], "cols": [page column names],
   "sides": {side: {"venues": {board venue name: [[10 x index per column] per week]},
                    "league": [[10 x index per column] per week]}}}
Venues are keyed by the name the leaderboard shows for that level and year: the board's for each
level's most recent year, the history CSV's (joined on venue_id) for earlier ones. Every board
park must have seasonal data and every seasonal park a board row.
Usage:
  python tools/park_factors/build_seasonal.py path/to/park_factors_seasonal_weekly_2027.csv \\
      path/to/park_factors_seasonal_history.csv
"""
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from build_leaderboard import CSV, HIST, LATEST, NAMES_2027, ROOT, SHOW_AS

OUT = ROOT / "park-factors" / "seasonal"


def read(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def board_names():
    """(level, year) -> {venue_id or venue name: the board's venue name}: each level's most recent
    year by name (the board CSV has no ids; its names are the model's), earlier years by id."""
    out = defaultdict(dict)
    for r in read(CSV):
        if r["Side"] == "All":
            out[(r["Level"], LATEST[r["Level"]])][NAMES_2027.get(r["Venue"], r["Venue"]) if r["Level"] == "MLB" else r["Venue"]] = \
                NAMES_2027.get(r["Venue"], r["Venue"]) if r["Level"] == "MLB" else r["Venue"]
    for r in read(HIST):
        if int(r["Year"]) < LATEST[r["Level"]]:
            out[(r["Level"], int(r["Year"]))][r["venue_id"]] = r["Venue"]
    return out


def main(weekly_2027, history):
    recs = [{**r, "Level": "MLB", "Season": str(LATEST["MLB"])} for r in read(weekly_2027)] + read(history)
    head = list(read(CSV)[0])
    stats = head[head.index("Park Factor"):head.index("PA")]  # model names, page order
    names = board_names()
    groups = defaultdict(list)
    for r in recs:
        groups[(r["Level"], int(r["Season"]))].append(r)
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    manifest, sizes = defaultdict(list), 0
    for (level, year), rows in sorted(groups.items()):
        if (level, year) not in names:
            raise ValueError(f"{level} {year}: not on the leaderboard")
        board = names[(level, year)]
        latest = year == LATEST[level]
        weeks = []
        for r in rows:
            a, b = (x.strip() for x in r["Dates"].split(" - "))
            w = [datetime.strptime(f"{x} {year}", "%b %d %Y").strftime("%m-%d") for x in (a, b)] + [f"{a} – {b}"]
            if w not in weeks:
                weeks.append(w)
        wi = {w[2]: i for i, w in enumerate(weeks)}
        sides = defaultdict(lambda: {"venues": {}, "league": [None] * len(weeks)})
        for r in rows:
            a, b = (x.strip() for x in r["Dates"].split(" - "))
            i = wi[f"{a} – {b}"]
            vals = [round(10 * float(r[c] or r["HR"])) for c in stats]  # league rows: HR p10 / p90 scale as HR
            side = sides[r["Bat Side"]]
            if r["Venue"].endswith(" average") and r.get("venue_id", "0") in ("0", ""):
                side["league"][i] = vals
                continue
            key = (NAMES_2027.get(r["Venue"], r["Venue"]) if level == "MLB" else r["Venue"]) if latest else r["venue_id"]
            if key not in board:
                raise ValueError(f"{level} {year}: seasonal park {r['Venue']} ({r.get('venue_id')}) is not on the leaderboard")
            side["venues"].setdefault(board[key], [None] * len(weeks))[i] = vals
        missing = set(board.values()) - set(sides["All"]["venues"])
        if missing:
            raise ValueError(f"{level} {year}: leaderboard parks without seasonal data: {sorted(missing)}")
        for sd in sides.values():
            assert all(x is not None for x in sd["league"]) and all(x is not None for v in sd["venues"].values() for x in v)
        data = {"level": level, "year": year, "weeks": weeks, "cols": [SHOW_AS.get(c, c) for c in stats], "sides": sides}
        path = OUT / f"{level.replace('+', 'plus')}_{year}.json"
        path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        manifest[level].append(year)
        sizes += path.stat().st_size
    print(f"{sum(map(len, manifest.values()))} files, {sizes / 1e6:.1f} MB -> {OUT}")
    for level, years in manifest.items():
        print(f"  {level}: {min(years)}-{max(years)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
