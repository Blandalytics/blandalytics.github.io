"""Build the GitHub Pages site: one scorecard per game plus a manifest.

    python build_site.py                          # yesterday and today
    python build_site.py --start 2026-08-01 --end 2026-08-31
    python build_site.py --start 2026-08-28 --force   # re-render existing games

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


def build(start, end, force=False, out=DEFAULT_OUT):
    games_dir, manifest_path = os.path.join(out, "games"), os.path.join(out, "games.json")
    os.makedirs(games_dir, exist_ok=True)
    manifest = load_manifest(manifest_path)
    games = manifest["games"]
    session = statfast._session()
    built = skipped = 0
    t0 = time.perf_counter()

    for date in date_range(start, end):
        for pk, html, data in scorecards_for_date(date, session=session):
            key = str(pk)
            if key in games and not force:
                skipped += 1
                continue
            with open(os.path.join(games_dir, "%d.html" % pk), "w", encoding="utf-8") as fh:
                fh.write(html)
            games[key] = entry(pk, data)
            built += 1
            print("  %s  %s" % (date, games[key]["title"]))
        # checkpoint after every date so a long backfill survives an interruption
        save_manifest(manifest_path, manifest)

    print("built %d, skipped %d, %d games in manifest, %.0fs"
          % (built, skipped, len(games), time.perf_counter() - t0))
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
    a = ap.parse_args(argv)
    build(a.start, a.end, a.force, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
