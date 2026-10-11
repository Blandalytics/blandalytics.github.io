"""The live Worker's inputs that need history: each pitcher's comparison seasons, and the
season's arm angles, written nightly to the bucket.

    python packs.py                       # pitchers who pitched in the last three days,
                                          # and any pitcher without a pack yet
    python packs.py --all                 # every pitcher, every season
    python packs.py --pitcher 453286      # one pitcher
    python packs.py --out ./packs ...     # a folder instead of the bucket

Writes, under the bucket's ``cards/`` prefix:

    cards/pitchers/<pitcherId>.json   his regular seasons since FIRST_SEASON, each with its
                                      appearance count, per pitch type the pitch counts
                                      (overall and by batter side), mean velocity and mean
                                      flight time, and the movement regions
    cards/arms/<season>.json          Baseball Savant's season-to-date arm angles, per game
                                      type: {"R": {pitcherId: {pitch type: degrees}}, ...}

A pack's current season runs through the day before it was built, which is what a card
for a game that day compares against. The Worker builds the comparison from it the way
build_data.comparison does, except that the regions here cover the season's whole
repertoire at its own flight times and are scaled to the game's there -- Python draws
them from the types thrown that day, at that day's flight times. Past seasons never
change, so a nightly run only rebuilds the current season of the pitchers who have
pitched since; --all rebuilds everything (after the data files are re-pulled, say)."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from card import DEFAULT_CACHE, ROOT  # first: it puts the scraper on sys.path

import fetch  # noqa: E402
import prep  # noqa: E402
import shapes  # noqa: E402
from build_data import MIN_GAMES  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from backfill import LocalStore, R2Store  # noqa: E402

ET = ZoneInfo("America/New_York")
PREFIX = "cards/pitchers"
ARMS = "cards/arms"
CACHE = "public, max-age=3600"
RECENT_DAYS = 3  # a day's data settles two days after the games
POSTSEASON = ("F", "D", "L", "W")


def season_entry(df, year: int) -> dict:
    """One season of one pitcher's regular-season pitches, as the card compares against
    it: prep.season's rows (tracking data present), prep.season_table's counts and
    velocity per type, and the regions at the season's own flight times."""
    s = prep.base(df).dropna(subset=[c for c in prep.TRACKING if c != "spin_dir"])
    prep.flags(s)
    prep.movement(s)
    hand = s["hand"].mode().iloc[0] if len(s) else "R"
    by = s.groupby("pitchType")
    agg = by.agg(
        n=("pitchType", "size"), vRHH=("vRHH", "sum"), vLHH=("vLHH", "sum"),
        velo=("velo", "mean"), plate_time=("plate_time", "mean"),
    )  # fmt: skip
    t = s["pitchType"].map(agg["plate_time"])
    sign = 1 if hand == "R" else -1
    hb, ivb = s["HB_acc"] * t**2 * sign, s["IVB_acc"] * t**2
    points = {pt: np.c_[hb[g.index], ivb[g.index]] for pt, g in by}
    return {
        "year": year,
        "games": int(df["game_pk"].nunique()),
        "hand": hand,
        "types": {
            pt: {
                "n": int(r.n),
                "vRHH": int(r.vRHH),
                "vLHH": int(r.vLHH),
                "velo": float(r.velo),
                "plate_time": float(r.plate_time),
            }
            for pt, r in agg.iterrows()
        },
        "shapes": shapes.shapes(points),
    }


def build_pack(pid: int, seasons: dict, through: dt.date, have: dict | None = None) -> dict:
    """A pitcher's pack from {year: that season's frame grouped by pitcher}. ``have`` is
    his existing pack: its past seasons are kept, only the current one is rebuilt."""
    kept = {s["year"]: s for s in (have or {}).get("seasons", []) if s["year"] < through.year}
    out = []
    for year, by_pitcher in sorted(seasons.items(), reverse=True):
        if year in kept:
            out.append(kept[year])
        elif pid in by_pitcher.groups:
            out.append(season_entry(by_pitcher.get_group(pid), year))
    return {"id": pid, "through": through.isoformat(), "seasons": out}


def qualifying(seasons: dict) -> set[int]:
    """Pitchers with a season of enough appearances to compare to: those worth a pack."""
    out = set()
    for g in seasons.values():
        games = g["game_pk"].nunique()
        out |= {int(p) for p in games.index[games >= MIN_GAMES]}
    return out


def load_seasons(store: fetch.DataStore, date: dt.date) -> dict:
    """{year: that season's regular-season pitches before ``date``, grouped by pitcher}."""
    out = {}
    for year in range(date.year, store.first_season - 1, -1):
        out[year] = store.before(year, date).groupby("pitcher", observed=True)
        print(f"  season {year}: {len(out[year])} pitchers", file=sys.stderr)
    return out


def recent_pitchers(seasons: dict, date: dt.date, days: int) -> set[int]:
    """Pitchers with a regular-season pitch in the ``days`` before ``date``."""
    current = seasons.get(date.year)
    if current is None:
        return set()
    frame = current.obj
    since = pd.Timestamp(date - dt.timedelta(days=days))
    return {int(p) for p in frame.loc[frame["game_date"] >= since, "pitcher"].unique()}


def arm_season(date: dt.date) -> int:
    """The season whose arm angles a game on ``date`` reads (fetch._arm_queries)."""
    return date.year - 1 if date <= dt.date(date.year, 3, 25) else date.year


def write_arms(site, s, date: dt.date) -> None:
    """Savant's season-to-date arm angles for each game type it has published."""
    year = arm_season(date)
    out = {}
    for gt in ("R", *POSTSEASON):
        url = fetch.ARM_ANGLES.format(start="", end="", season=year, gt=gt)
        try:
            board = fetch._read_arm_angles(s, url)
        except (fetch.requests.RequestException, ValueError, KeyError) as exc:
            print(f"  arm angles {year} {gt}: {exc}", file=sys.stderr)
            continue
        if board:
            out[gt] = {str(p): angles for p, angles in board.items()}
    if out:
        site.put(f"{ARMS}/{year}.json", _dump(out), "application/json", CACHE)
        print(f"  arm angles {year}: {', '.join(f'{k} {len(v)}' for k, v in out.items())}")


def _dump(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def todo(site, seasons: dict, date: dt.date, args) -> tuple[list[int], set[int]]:
    """(pitchers to write, pitchers whose existing pack can be kept in part)."""
    if args.pitcher:
        return [args.pitcher], set()
    worth = qualifying(seasons)
    if args.all:
        return sorted(worth), set()
    built = {int(os.path.basename(k)[:-5]) for k in site.keys(f"{PREFIX}/")}
    fresh = recent_pitchers(seasons, date, RECENT_DAYS)
    return sorted((fresh | (worth - built)) & worth), built


def run(site, date: dt.date, args) -> int:
    s = fetch.session()
    store = fetch.DataStore(args.cache, s)
    write_arms(site, s, date)
    seasons = load_seasons(store, date)
    pids, built = todo(site, seasons, date, args)
    through = date - dt.timedelta(days=1)
    t0 = time.perf_counter()
    for i, pid in enumerate(pids):
        raw = site.get(f"{PREFIX}/{pid}.json") if pid in built else None
        pack = build_pack(pid, seasons, through, json.loads(raw) if raw else None)
        site.put(f"{PREFIX}/{pid}.json", _dump(pack), "application/json", CACHE)
        if i % 100 == 0:
            print(f"  {i + 1}/{len(pids)} packs, {time.perf_counter() - t0:.0f}s")
    print(f"{len(pids)} packs written through {through}, {time.perf_counter() - t0:.0f}s")
    return len(pids)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--all", action="store_true", help="every pitcher, every season")
    ap.add_argument("--pitcher", type=int, help="one pitcher")
    ap.add_argument("--date", help="the day the packs are for (default: today, Eastern)")
    ap.add_argument("--out", help="write to this folder instead of the bucket")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the data-file cache")
    a = ap.parse_args(argv)
    date = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(ET).date()
    run(LocalStore(a.out) if a.out else R2Store(), date, a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
