"""Add League, Team, Org and Games to the park model's season-by-season history.

The model's park_factors_history.csv has one row per level, season and venue (all batters)
with every index column, the season's PAs and the MLB StatsAPI venue id. This looks each
row up in that season's StatsAPI schedule: Games counts the venue's completed regular-season
games at that level, and Team is the club that was home in most of them, with its league and
parent org. Writes tools/park_factors/park_factors_history.csv, which build_leaderboard.py
reads, so the page builds offline.

Abbreviations follow the 2027 leaderboard (FanGraphs-style MLB codes such as KCR and SDP), and
2021's interim league names map to the names used since 2022 (Triple-A East -> IL, and so on).
Usage: python tools/park_factors/build_history.py path/to/park_factors_history.csv
"""
import csv
import hashlib
import json
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "park_factors_history.csv"
BOARD = HERE / "park_factors_2027.csv"
CACHE = HERE / "cache"  # StatsAPI responses (not committed)
API = "https://statsapi.mlb.com/api/v1"

SPORT = {"MLB": 1, "AAA": 11, "AA": 12, "A+": 13, "A": 14}
MLB_ABBR = {"KC": "KCR", "SD": "SDP", "SF": "SFG", "TB": "TBR", "WSH": "WSN", "CWS": "CHW", "AZ": "ARI", "OAK": "ATH"}
LEAGUE = {
    "Major League Baseball": "MLB", "American League": "MLB", "National League": "MLB",
    "International League": "IL", "Pacific Coast League": "PCL", "Triple-A East": "IL", "Triple-A West": "PCL",
    "Eastern League": "EL", "Southern League": "SL", "Texas League": "TL",
    "Double-A Northeast": "EL", "Double-A South": "SL", "Double-A Central": "TL",
    "Midwest League": "MWL", "Northwest League": "NWL", "South Atlantic League": "SAL",
    "High-A Central": "MWL", "High-A West": "NWL", "High-A East": "SAL",
    "California League": "CAL", "Carolina League": "CAR", "Florida State League": "FSL",
    "Low-A West": "CAL", "Low-A East": "CAR", "Low-A Southeast": "FSL",
}
FINAL = {"F", "O"}
STATS = ["Park Factor", "R", "OBP", "H", "1B", "2B", "3B", "HR", "BB", "SO", "HBP", "BACON", "wOBACon", "HR p10", "HR p90"]


def get(path):
    CACHE.mkdir(exist_ok=True)
    f = CACHE / (hashlib.sha1(path.encode()).hexdigest()[:16] + ".json")  # short names: Windows path limit
    if not f.exists():
        with urllib.request.urlopen(f"{API}/{path}", timeout=60) as r:
            f.write_bytes(r.read())
    return json.loads(f.read_text(encoding="utf-8"))


def teams(season):
    """StatsAPI team id -> {abbr, league, org id} for every level that season."""
    out = {}
    for sport in SPORT.values():
        for t in get(f"teams?sportId={sport}&season={season}&fields=teams,id,abbreviation,parentOrgId,league,name")["teams"]:
            out[t["id"]] = {"abbr": t["abbreviation"], "league": LEAGUE.get(t.get("league", {}).get("name"), ""),
                            "org": t.get("parentOrgId", t["id"])}
    return out


def venue_games(level, season):
    """venue id -> (Counter of home team ids, Counter of venue names) over completed regular-season
    games. A game carries the venue's name as of that season (Miller Park, U.S. Cellular Field, …)."""
    s = get(f"schedule?sportId={SPORT[level]}&season={season}&gameType=R"
            "&fields=dates,games,status,codedGameState,venue,id,name,teams,home,team,id")
    out = defaultdict(lambda: (Counter(), Counter()))
    for d in s.get("dates", []):
        for g in d["games"]:
            if g["status"]["codedGameState"] in FINAL:
                homes, names = out[g["venue"]["id"]]
                homes[g["teams"]["home"]["team"]["id"]] += 1
                names[g["venue"]["name"]] += 1
    return out


def top(counter):
    """The most common key, ties to the smallest."""
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


def main(src):
    with open(src, newline="", encoding="utf-8-sig") as f:
        hist = list(csv.DictReader(f))
    with open(BOARD, newline="", encoding="utf-8") as f:
        board = [r for r in csv.DictReader(f) if r["Side"] == "All"]

    mlb_abbr = lambda a: MLB_ABBR.get(a, a)
    rows, missing, renamed = [], [], defaultdict(set)
    for season in sorted({int(r["Season"]) for r in hist}):
        tm = teams(season)
        org_abbr = {i: mlb_abbr(t["abbr"]) for i, t in tm.items() if t["league"] == "MLB"}
        games = {lv: venue_games(lv, season) for lv in SPORT if any(r["Level"] == lv and int(r["Season"]) == season for r in hist)}
        for r in (r for r in hist if int(r["Season"]) == season):
            homes, names = games[r["Level"]].get(int(r["venue_id"]), (Counter(), Counter()))
            team = league = org = ""
            venue = top(names) if names else r["Venue"]
            if homes:
                t = tm.get(top(homes))
                if t:
                    team = mlb_abbr(t["abbr"]) if r["Level"] == "MLB" else t["abbr"]
                    league, org = t["league"], org_abbr.get(t["org"], "")
            else:
                missing.append((r["Level"], season, r["Venue"]))
            if venue != r["Venue"]:
                renamed[(r["Level"], r["Venue"])].add((season, venue))
            rows.append({"Level": r["Level"], "Year": season, "League": league, "Team": team, "Org": org,
                         "Venue": venue, "Games": sum(homes.values()),
                         **{k: r[k] for k in STATS}, "PA": r["PA"]})

    # check: 2026 minor-league rows should name the same club as the 2027 board (which uses 2026 parks)
    on_board = {(b["Level"], b["Venue"]): (b["League"], b["Team"], b["Org"]) for b in board}
    diffs = [(r["Level"], r["Venue"], (r["League"], r["Team"], r["Org"]), on_board[(r["Level"], r["Venue"])])
             for r in rows if r["Year"] == 2026 and r["Level"] != "MLB" and (r["Level"], r["Venue"]) in on_board
             and (r["League"], r["Team"], r["Org"]) != on_board[(r["Level"], r["Venue"])]]
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} rows -> {OUT}")
    print(f"no completed games found for {len(missing)} rows: {missing}")
    print(f"2026 MiLB rows that differ from the board: {len(diffs)}")
    for d in diffs:
        print("  ", d)
    print(f"venues shown under their season's name: {len(renamed)}")
    for (lv, v), seen in sorted(renamed.items()):
        by_name = defaultdict(list)
        for season, name in sorted(seen):
            by_name[name].append(season)
        print(f"   {lv:4} {v}: " + "; ".join(f"{n} ({min(s)}–{max(s)})" for n, s in by_name.items()))


if __name__ == "__main__":
    main(sys.argv[1])
