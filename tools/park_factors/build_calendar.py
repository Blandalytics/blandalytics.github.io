"""Build the data of blandalytics.com/league-calendar/: each level's run environment week by week.

Two sources, both from the park model of the projections repository (src/model/parks.py):

* The model: the "<level> average" rows of the Seasonal view's files,
  park-factors/seasonal/<level>_<year>.json (run build_seasonal.py first). Each is the level's
  calendar curve (cold April air, summer heat), estimated with the same batters and pitchers all
  season, plus the parks in use that week, against the level's season average.
* What happened: park_factors_calendar_observed.csv (parks.calendar_observed, written with
  --seasonal-table). Each week's own plate appearances against the level-season's, with the
  week's games and PAs. These keep that year's weather and who played.

Both use the same weeks (seven days from each level-season's first game day). This writes
league-calendar/data.json:
  {"cols": [page column names], "levels": [...], "years": {level: [years, newest first]},
   "series": {level: {year: {"weeks": [[first "MM-DD", last, label], ...],
                             "model": [[10 x index per column] per week],
                             "obs": [[10 x index per column] or null per week] or null (2027),
                             "games": [...] or null, "pa": [...] or null}}},
   "generated": "YYYY-MM-DD"}
Usage:
  python tools/park_factors/build_calendar.py [path/to/park_factors_calendar_observed.csv]
(the default is the copy next to this script; a path given is copied there first)
"""
import csv
import json
import shutil
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from build_leaderboard import LATEST, ROOT

HERE = Path(__file__).parent
OBSERVED = HERE / "park_factors_calendar_observed.csv"
SEASONAL = ROOT / "park-factors" / "seasonal"
OUT = ROOT / "league-calendar" / "data.json"
LEVELS = ["MLB", "AAA", "AA", "A+", "A"]
DROP = {"HR p10", "HR p90"}  # the park page's HR interval: not on the league curve
SHOW = {"Park Factor": "wOBA"}  # the park page's overall index is wOBA per PA
MODEL_NAME = {"AVG": "H", "K": "SO"}  # page column -> observed CSV column


def main(observed=None):
    if observed and Path(observed).resolve() != OBSERVED.resolve():
        shutil.copyfile(observed, OBSERVED)
    with open(OBSERVED, newline="", encoding="utf-8-sig") as f:
        obs = defaultdict(dict)
        for r in csv.DictReader(f):
            first = datetime.strptime(f"{r['Window']} {r['Season']}", "%b %d %Y").strftime("%m-%d")
            obs[(r["Level"], int(r["Season"]))][first] = r
    series, years, cols = defaultdict(dict), defaultdict(list), None
    for path in sorted(SEASONAL.glob("*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        level, year = d["level"], d["year"]
        keep = [i for i, c in enumerate(d["cols"]) if c not in DROP]
        names = [d["cols"][i] for i in keep]
        if cols is None:
            cols = names
        assert names == cols, (path.name, names)
        model = [[w[i] for i in keep] for w in d["sides"]["All"]["league"]]
        entry = {"weeks": d["weeks"], "model": model, "obs": None, "games": None, "pa": None}
        if (level, year) in obs:
            o = obs.pop((level, year))
            firsts = [w[0] for w in d["weeks"]]
            if sorted(o) != sorted(firsts):
                raise ValueError(f"{level} {year}: the observed weeks are not the model's: {sorted(set(o) ^ set(firsts))}")
            rows = [o[f] for f in firsts]
            entry["obs"] = [[round(10 * float(r[MODEL_NAME.get(c, c)])) for c in cols] if r["wOBACon"] else None
                            for r in rows]
            entry["games"] = [int(r["Games"]) for r in rows]
            entry["pa"] = [int(r["PA"]) for r in rows]
        elif year != LATEST["MLB"] or level != "MLB":
            raise ValueError(f"{level} {year}: no observed weeks")
        series[level][year] = entry
        years[level].append(year)
    if obs:
        raise ValueError(f"observed weeks without a model file: {sorted(obs)}")
    data = {"cols": [SHOW.get(c, c) for c in cols], "levels": [lv for lv in LEVELS if lv in series],
            "years": {lv: sorted(years[lv], reverse=True) for lv in LEVELS if lv in series},
            "series": series, "generated": date.today().isoformat()}  # fmt: skip
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{sum(map(len, years.values()))} level-years, {OUT.stat().st_size / 1e3:.0f} kB -> {OUT}")
    for lv in data["levels"]:
        print(f"  {lv}: {min(years[lv])}-{max(years[lv])}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
