"""Park factors for the Game Sim, from the site's park-factors project.

    python -I tools/lineup_sims/park_factors.py 2026     # writes lineup-sims/data/2026-parks.json

Reads, never writes, the park-factors project's files in this repo:
  tools/park_factors/park_factors_history.csv   each season's park factors, by venue (all batters)
  park-factors/seasonal/MLB_<season>.json        the same parks week by week, with the league's calendar
Those are per-outcome indexes, 100 at the season's average park, from a fit of every plate
appearance that adjusts for who batted and pitched there (blandalytics.com/park-factors/).

For each venue the season used: its team (the sim's abbreviation; none for a neutral site), games,
Park Factor (wOBA) and R, and the factors the sim applies to a plate appearance's outcomes (K, BB,
HBP, 1B, 2B, 3B, HR), for the season and for each week (the park that week times the league's
calendar that week, so 100 is the season's average park). And each team's environment: half its
games at its home parks (games-weighted) and half on the road (the other teams' home parks), the
mix its players' 2026 rates already carry, which the page divides out before putting them in a park.
"""
import csv
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
CATS = ["K", "BB", "HBP", "1B", "2B", "3B", "HR"]
HIST_COLS = {"K": "SO", "BB": "BB", "HBP": "HBP", "1B": "1B", "2B": "2B", "3B": "3B", "HR": "HR"}
SEASONAL_COLS = {"K": "K", "BB": "BB", "HBP": "HBP", "1B": "1B", "2B": "2B", "3B": "3B", "HR": "HR"}
# the park model's team codes where the sim's differ
TEAM = {"TBR": "TB", "KCR": "KC", "SDP": "SD", "SFG": "SF", "WSN": "WSH", "CHW": "CWS", "ARI": "AZ"}


def main(season, site):
    season, site = int(season), pathlib.Path(site)
    data = json.loads((REPO / "lineup-sims" / "data" / f"{season}.json").read_text(encoding="utf-8"))
    abbrs = {t["abbr"] for t in data["teams"]}
    with open(site / "tools" / "park_factors" / "park_factors_history.csv", newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if r["Level"] == "MLB" and int(r["Year"]) == season]
    if not rows:
        raise SystemExit(f"no MLB {season} rows in the park factors history")
    seasonal = json.loads((site / "park-factors" / "seasonal" / f"MLB_{season}.json").read_text(encoding="utf-8"))
    cols, side = seasonal["cols"], seasonal["sides"]["All"]
    league = side["league"]

    # a home park is one with at least a tenth of a home schedule (the park-factors page's rule); fewer
    # games is a neutral site, no club's home
    parks = []
    for r in sorted(rows, key=lambda r: -int(r["Games"])):
        team = TEAM.get(r["Team"], r["Team"])
        if team not in abbrs:
            raise SystemExit(f"{r['Venue']}: team {r['Team']} isn't one of the data file's")
        games = int(r["Games"])
        home = games >= 81 / 10
        weeks = side["venues"].get(r["Venue"])
        if weeks is None:
            raise SystemExit(f"{r['Venue']}: no seasonal rows")
        # each week: the park that week times the league's calendar that week, both per 1000
        wk = [[round(w[cols.index(SEASONAL_COLS[c])] * league[i][cols.index(SEASONAL_COLS[c])] / 1000) for c in CATS]
              + [round(w[cols.index("R")] * league[i][cols.index("R")] / 1000)] for i, w in enumerate(weeks)]
        parks.append({"name": r["Venue"], "team": team if home else None, "games": games,
                      "pf": int(r["Park Factor"]), "R": int(r["R"]), "f": [int(r[HIST_COLS[c]]) for c in CATS], "weeks": wk})

    # each team's environment: half at home (its home parks, games-weighted), half on the road (the
    # other 29 teams' home environments, evenly)
    home = {}
    for t in sorted(abbrs):
        mine = [p for p in parks if p["team"] == t]
        n = sum(p["games"] for p in mine)
        home[t] = [sum(p["f"][i] * p["games"] for p in mine) / n for i in range(len(CATS))]
    env = {}
    for t in home:
        road = [sum(home[u][i] for u in home if u != t) / (len(home) - 1) for i in range(len(CATS))]
        env[t] = [round((home[t][i] + road[i]) / 2, 2) for i in range(len(CATS))]

    out = {"season": season, "cats": CATS, "weeks": seasonal["weeks"], "parks": parks, "env": env,
           "source": "blandalytics.com/park-factors/ (park_factors_history.csv, seasonal/MLB_%d.json)" % season}
    dest = REPO / "lineup-sims" / "data" / f"{season}-parks.json"
    dest.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.1f} KB): {len(parks)} parks, "
          f"{sum(p['team'] is not None for p in parks)} home parks, {len(seasonal['weeks'])} weeks")
    for t in ("COL", "SEA", "BOS", "CLE"):
        print(f"  {t} environment (half home, half road): " + ", ".join(f"{c} {v:.1f}" for c, v in zip(CATS, env[t])))


if __name__ == "__main__":
    main(sys.argv[1], REPO)
