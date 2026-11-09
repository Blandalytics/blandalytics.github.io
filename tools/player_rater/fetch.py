"""Fetch MLB Stats API daily lines for one or more regular seasons (player-rater pipeline, step 1).

Per season: the season's dates, the teams, season fielding (for eligibility) and, for every day of the
regular season, byDateRange hitting and pitching lines for every player. Raw responses are cached under
cache/<season>/ so a rebuild never refetches a finished day.

Usage: python -I fetch.py 2015 2016 ... [--refresh-days N]
"""
import concurrent.futures as cf
import datetime as dt
import gzip
import json
import pathlib
import sys
import time
import urllib.request

API = "https://statsapi.mlb.com/api/v1"
UA = {"User-Agent": "blandalytics-player-rater/1.0"}
CACHE = pathlib.Path(__file__).resolve().parent / "cache"  # raw API responses (not committed)


def get(url, tries=5):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.load(r)
        except Exception as e:  # network hiccups: back off and retry
            if k == tries - 1:
                raise
            print(f"  retry {k + 1} {url}: {e}", file=sys.stderr)
            time.sleep(2 * (k + 1))


def cached(path, url, refresh=False):
    if path.exists() and not refresh:
        with gzip.open(path, "rt", encoding="utf8") as f:
            return json.load(f)
    d = get(url)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf8") as f:
        json.dump(d, f)
    tmp.replace(path)
    return d


def fetch_season(season, refresh_days=0):
    root = CACHE / str(season)
    root.mkdir(parents=True, exist_ok=True)
    info = cached(root / "season.json.gz", f"{API}/seasons/{season}?sportId=1", refresh=True)["seasons"][0]
    cached(root / "teams.json.gz", f"{API}/teams?sportId=1&season={season}", refresh=True)
    start = dt.date.fromisoformat(info["regularSeasonStartDate"])
    end = min(dt.date.fromisoformat(info["regularSeasonEndDate"]), dt.date.today() - dt.timedelta(days=1))
    days = [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]
    recent = set(days[-refresh_days:]) if refresh_days else set()
    jobs = []
    for d in days:
        for g in ("hitting", "pitching"):
            url = (f"{API}/stats?stats=byDateRange&group={g}&startDate={d}&endDate={d}&playerPool=ALL"
                   f"&sportId=1&gameType=R&season={season}&limit=5000")
            jobs.append((root / f"{g}-{d}.json.gz", url, d in recent))
    todo = [j for j in jobs if not j[0].exists() or j[2]]
    print(f"{season}: {start}..{end}, {len(days)} days, {len(todo)} of {len(jobs)} day files to fetch", flush=True)
    with cf.ThreadPoolExecutor(6) as ex:
        list(ex.map(lambda j: cached(*j), todo))
    cached(root / "fielding.json.gz",
           f"{API}/stats?stats=season&group=fielding&playerPool=ALL&sportId=1&gameType=R&season={season}&limit=10000",
           refresh=bool(todo) or not (root / "fielding.json.gz").exists())
    print(f"{season}: done", flush=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    refresh = 0
    if "--refresh-days" in args:
        i = args.index("--refresh-days")
        refresh = int(args[i + 1])
        del args[i:i + 2]
    for s in args:
        fetch_season(int(s), refresh)
