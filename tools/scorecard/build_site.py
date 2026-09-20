"""Build the GitHub Pages site: one scorecard per game plus a manifest.

    python build_site.py                          # yesterday and today
    python build_site.py --start 2026-08-01 --end 2026-08-31
    python build_site.py --start 2026-08-28 --force   # re-render existing games
    python build_site.py --only 824638,823394          # re-render specific games

Writes <out>/games/<gamePk>.html and <out>/games.json. The index page reads the
manifest to drive its date / team / game selectors, so nothing here needs a
server: GitHub Pages serves the folder as-is. Games already in the
manifest are skipped unless --force is given, so the nightly run only pays for
new games.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time

from scorecard import scorecards_for_date, statfast

HERE = os.path.dirname(os.path.abspath(__file__))
# tools/scorecard/build_site.py -> <repo>/scorecards, the folder Pages serves
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "..", "scorecards"))


def load_manifest(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {"built": None, "games": {}}


def save_manifest(path, m):
    m["built"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(m, fh, ensure_ascii=False, indent=1, sort_keys=True)


def entry(pk, data):
    """What the index needs to know about a game, straight from its data dict."""
    tot = data["linescore"]["totals"]
    a, h = data["away"], data["home"]
    win, lose = ((a, tot["away"]["r"]), (h, tot["home"]["r"]))
    if tot["home"]["r"] > tot["away"]["r"]:
        win, lose = lose, win
    return {
        "date": data["date"], "venue": data["venue"],
        "away": a["name"], "away_abbr": a["abbr"], "away_nick": a["nickname"],
        "home": h["name"], "home_abbr": h["abbr"], "home_nick": h["nickname"],
        "away_r": tot["away"]["r"], "home_r": tot["home"]["r"],
        "title": "%s %d, %s %d" % (win[0]["nickname"], win[1], lose[0]["nickname"], lose[1]),
        "file": "games/%d.html" % pk,
    }


def date_range(start, end):
    d = dt.date.fromisoformat(start)
    stop = dt.date.fromisoformat(end)
    while d <= stop:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def game_dates(pks, games, session):
    """date -> the requested game keys on it, from the manifest or the schedule."""
    by_date, unknown = {}, []
    for pk in pks:
        k = str(pk)
        if k in games:
            by_date.setdefault(games[k]["date"], set()).add(k)
        else:
            unknown.append(int(pk))
    for pk in unknown:                       # never built: ask the schedule
        found = statfast._schedule(session, {"gamePk": pk})
        for _, date in found.items():
            by_date.setdefault(date, set()).add(str(pk))
    return by_date


def build(start, end, force=False, out=DEFAULT_OUT, only=None):
    games_dir, manifest_path = os.path.join(out, "games"), os.path.join(out, "games.json")
    os.makedirs(games_dir, exist_ok=True)
    manifest = load_manifest(manifest_path)
    games = manifest["games"]
    session = statfast._session()
    built = skipped = 0
    t0 = time.perf_counter()

    # --only names specific games: always re-rendered, on whatever dates they fall
    targets = game_dates(only, games, session) if only else None
    dates = sorted(targets) if targets else list(date_range(start, end))

    failed = []
    for date in dates:
        try:
            day = scorecards_for_date(date, session=session,
                                      skip=None if (force or targets) else games,
                                      only=targets.get(date) if targets else None)
            for pk, html, data, err in day:
                if err is not None:
                    print("  %s  %d FAILED: %s: %s" % (date, pk, type(err).__name__, err))
                    failed.append((date, pk, "%s: %s" % (type(err).__name__, err)))
                    continue
                if html is None:                       # already built, skipped upstream
                    skipped += 1
                    continue
                with open(os.path.join(games_dir, "%d.html" % pk), "w", encoding="utf-8") as fh:
                    fh.write(html)
                games[str(pk)] = entry(pk, data)
                built += 1
                print("  %s  %s" % (date, games[str(pk)]["title"]))
        except Exception as exc:                       # the whole day, e.g. schedule down
            print("  %s  DAY FAILED: %s: %s" % (date, type(exc).__name__, exc))
            failed.append((date, "*", "%s: %s" % (type(exc).__name__, exc)))
        # checkpoint after every date so a long backfill survives an interruption
        save_manifest(manifest_path, manifest)

    print("built %d, skipped %d, failed %d, %d games in manifest, %.0fs"
          % (built, skipped, len(failed), len(games), time.perf_counter() - t0))
    for f in failed:
        print("  failed:", *f)
    return built


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    today = dt.date.today()
    ap.add_argument("--start", default=(today - dt.timedelta(days=1)).isoformat(),
                    help="first date, YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--end", default=today.isoformat(),
                    help="last date, YYYY-MM-DD (default: today)")
    ap.add_argument("--force", action="store_true",
                    help="re-render games already in the manifest")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="site folder to write into (default: %(default)s)")
    ap.add_argument("--only", help="rebuild just these gamePks: comma-separated, "
                                   "or a path to a JSON list")
    a = ap.parse_args(argv)
    only = None
    if a.only:
        only = (json.load(open(a.only)) if os.path.exists(a.only)
                else [int(x) for x in a.only.split(",") if x.strip()])
    build(a.start, a.end, a.force, a.out, only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
