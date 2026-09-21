"""Season-wide swing metrics, for the Swing Profiles page's distributions.

For every hitter and bat side on a season's bat-tracking leaderboard who has a
swing-path card, the three numbers the page reports for one hitter -- bat speed
at contact, imputed swing duration and peak acceleration -- so the page can draw
where that hitter sits among everyone else. One small JSON per season, written
to swing-profiles/data/<season>.json.

It runs the same pipeline the page runs, through Blandalytics/swing_profiles
cloned alongside (see the workflow), so the numbers are the page's numbers: the
card is digitized, the duration imputed from the leaderboard, the derivatives
taken with the same filter. A season is ~500 cards; at 8 workers about a minute.

    python tools/swing_profiles/build_data.py                      # the current season
    python tools/swing_profiles/build_data.py --seasons 2024 2025  # a backfill
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

# NumPy 2 renamed trapz; swing_profiles still calls it.
if not hasattr(np, "trapz"):
    np.trapz = np.trapezoid

ROOT = Path(__file__).resolve().parents[2]
COLUMNS = ["id", "hand", "name", "impact_mph", "duration_ms", "peak_accel_g", "swings"]

# The page's peak is the plotted one: the first four and last five samples are
# trimmed, where the filter's edge fit is least trustworthy (swing_plot.py).
PEAK_TRIM = (4, 5)


def season_rows(year: int, min_swings: int, workers: int, verbose: bool) -> list[list]:
    from savant_lookup import fetch_bat_tracking
    from swing_profile import get_season_frames

    lb = fetch_bat_tracking(year)
    if lb.empty:
        return []
    swings = {(int(r.id), str(r.bat_side).upper()): int(r.swings_competitive) for r in lb.itertuples()}
    frame = get_season_frames(year, min_swings=min_swings, max_workers=workers, leaderboard=lb, verbose=verbose)
    rows = []
    for (pid, hand), g in frame.groupby(["MLBAMID", "Hand"], sort=False):
        g = g.sort_values("standardized_time")
        accel = g["acceleration"].to_numpy()
        lo, hi = PEAK_TRIM
        rows.append([
            int(pid),
            str(hand),
            g["Name"].iloc[0],
            round(float(g["swing_speed"].iloc[-1]), 3),
            round(float(g["swing_time"].iloc[-1]), 2),
            round(float(accel[lo:len(accel) - hi].max()), 3),
            swings.get((int(pid), str(hand)), None),
        ])
    return rows


def latest_season_with_data() -> int:
    from savant_lookup import fetch_bat_tracking

    year = dt.date.today().year
    while year >= 2024:
        if not fetch_bat_tracking(year).empty:
            return year
        year -= 1
    raise SystemExit("no season with bat tracking found")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="*", help="seasons to build; default: the latest with data")
    ap.add_argument("--out", type=Path, default=ROOT / "swing-profiles" / "data")
    ap.add_argument("--repo", type=Path, default=ROOT / "swing_profiles", help="a checkout of Blandalytics/swing_profiles")
    ap.add_argument("--min-swings", type=int, default=100, help="leaderboard rows below this rarely have a card")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not (args.repo / "swing_profile.py").exists():
        raise SystemExit(f"{args.repo} is not a swing_profiles checkout; clone it first")
    sys.path.insert(0, str(args.repo))

    seasons = args.seasons or [latest_season_with_data()]
    args.out.mkdir(parents=True, exist_ok=True)
    for year in seasons:
        rows = season_rows(year, args.min_swings, args.workers, verbose=not args.quiet)
        if not rows:
            print(f"{year}: no bat tracking; skipped")
            continue
        rows.sort(key=lambda r: (r[0], r[1]))
        payload = {
            "season": year,
            "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "min_swings": args.min_swings,
            "columns": COLUMNS,
            "rows": rows,
        }
        path = args.out / f"{year}.json"
        path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{year}: {len(rows)} player-sides -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
