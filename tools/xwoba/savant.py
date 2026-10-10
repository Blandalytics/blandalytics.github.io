"""Batted balls with bat speed, from Baseball Savant's Statcast search.

The completed-games Parquet in the bucket (tools/data) is built from the Stats API,
which carries no bat tracking, so the model's training data comes from Savant's
statcast_search CSV instead: every regular-season ball in play, a week per request
(Savant truncates a CSV at 25,000 rows; a week of balls in play is ~6,000). Each
week is cached as Parquet under tools/xwoba/cache/ once it is more than a few days
old, so a rebuild only asks Savant for the weeks it has not seen.

Bat tracking starts partway through 2023, so 2023 contributes its second half.

    from tools.xwoba.savant import load_seasons, batted_balls
    df = batted_balls(load_seasons([2024, 2025]))
"""

from __future__ import annotations

import datetime as dt
import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import requests

# this folder goes on the path so the sibling module imports whether run from here or
# from the repo root
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from model import WEIGHTS  # noqa: E402

SEARCH = "https://baseballsavant.mlb.com/statcast_search/csv"
CACHE = HERE / "cache" / "savant"
FIRST_SEASON = 2023  # the first season with bat tracking
SETTLE_DAYS = 3  # a week newer than this is refetched, not cached
ROW_LIMIT = 25_000  # Savant cuts a CSV off here

# Savant's columns the model and its evaluation read, out of ~120.
COLUMNS = [
    "game_date",
    "game_year",
    "game_pk",
    "at_bat_number",
    "pitch_number",
    "batter",
    "player_name",
    "stand",
    "events",
    "des",
    "bb_type",
    "hc_x",
    "hc_y",
    "launch_speed",
    "launch_angle",
    "bat_speed",
    "swing_length",
    "woba_value",
    "woba_denom",
    "estimated_woba_using_speedangle",
]

# The scraper's home plate on the hit-coordinate diagram (statfast._HOME), so spray
# here is the Batted Ball Charts page's spray.
HOME = (125.42, 198.27)
BUNT = r"\bbunt(?:s|ed)?\b"


# ---- the pull ------------------------------------------------------------------------------
def weeks(season: int, today: dt.date) -> list[tuple[dt.date, dt.date]]:
    """Seven-day windows over the regular season (March to early October), up to today."""
    start, end = dt.date(season, 3, 1), min(dt.date(season, 10, 10), today)
    out = []
    while start <= end:
        out.append((start, min(start + dt.timedelta(days=6), end)))
        start += dt.timedelta(days=7)
    return out


def _query(season: int, start: dt.date, end: dt.date) -> dict:
    return {
        "all": "true",
        "type": "details",
        "player_type": "batter",
        "hfPR": "hit\\.\\.into\\.\\.play|",
        "hfGT": "R|",
        "hfSea": f"{season}|",
        "game_date_gt": start.isoformat(),
        "game_date_lt": end.isoformat(),
        "min_pitches": 0,
        "min_results": 0,
        "min_pas": 0,
    }


def _get(s: requests.Session, params: dict) -> requests.Response:
    """A GET that retries twice, five and then ten seconds apart."""
    for attempt in range(3):
        try:
            r = s.get(SEARCH, params=params, timeout=300)
            r.raise_for_status()
            return r
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    raise AssertionError("unreachable")


def fetch_week(s: requests.Session, season: int, start: dt.date, end: dt.date) -> pd.DataFrame:
    """One window's balls in play, narrowed to COLUMNS."""
    text = _get(s, _query(season, start, end)).content.decode("utf-8-sig")
    if not text.strip() or text.lstrip().startswith("<"):
        return pd.DataFrame(columns=COLUMNS)
    df = pd.read_csv(io.StringIO(text), usecols=lambda c: c in COLUMNS, low_memory=False)
    if len(df) >= ROW_LIMIT:
        raise RuntimeError(f"{start}..{end}: {len(df)} rows, at Savant's limit; narrow the window")
    return df.reindex(columns=COLUMNS)


def _cached_week(s, season, start, end, today, verbose) -> pd.DataFrame:
    path = CACHE / str(season) / f"{start}_{end}.parquet"
    if path.exists():
        return pd.read_parquet(path)
    df = fetch_week(s, season, start, end)
    if verbose:
        print(f"  {start}..{end}: {len(df)} balls in play", file=sys.stderr)
    if (today - end).days > SETTLE_DAYS:
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(path, index=False)
    return df


def load_seasons(seasons: list[int], workers: int = 3, verbose: bool = True) -> pd.DataFrame:
    """Every regular-season ball in play in these seasons, from the cache or Savant."""
    today = dt.date.today()
    jobs = [(y, a, b) for y in seasons for a, b in weeks(y, today)]
    s = requests.Session()
    with ThreadPoolExecutor(workers) as pool:
        parts = list(pool.map(lambda j: _cached_week(s, *j, today, verbose), jobs))
    parts = [p for p in parts if len(p)]
    df = pd.concat(parts, ignore_index=True)
    return df.drop_duplicates(["game_pk", "at_bat_number", "pitch_number"], ignore_index=True)


# ---- the model's frame -----------------------------------------------------------------------
def spray_angle(df: pd.DataFrame) -> pd.Series:
    """The Batted Ball Charts page's spray: 0 at the pull-side foul line, 45 dead centre,
    90 at the opposite line, for either hand (statfast's angle plus 45). A ball caught in
    foul territory falls outside 0-90."""
    x = df["hc_x"].astype(float) - HOME[0]
    y = HOME[1] - df["hc_y"].astype(float)
    raw = np.degrees(np.arctan2(x, y))
    return raw.where(df["stand"] != "L", -raw) + 45.0


def outcome_class(woba_value: pd.Series) -> pd.Series:
    """The index into model.CLASSES of the wOBA value Savant gave the ball."""
    cls = pd.Series(
        np.abs(woba_value.to_numpy()[:, None] - WEIGHTS).argmin(axis=1), index=woba_value.index
    )
    off = (WEIGHTS[cls.to_numpy()] - woba_value).abs() > 1e-6
    if off.any():
        raise ValueError(f"unexpected wOBA values: {sorted(woba_value[off].unique())}")
    return cls


def batted_balls(raw: pd.DataFrame) -> pd.DataFrame:
    """Swung-at balls in play the model can use: in wOBA's denominator (no sac bunts),
    not bunted, not catcher's interference, with a bat speed, a launch angle and a
    landing spot."""
    keep = raw["woba_denom"].eq(1) & raw["events"].ne("catcher_interf")
    keep &= ~raw["des"].fillna("").str.contains(BUNT, case=False, regex=True)
    keep &= raw[["bat_speed", "launch_angle", "hc_x", "hc_y", "woba_value"]].notna().all(axis=1)
    df = raw.loc[keep].copy()
    df["game_date"] = pd.to_datetime(df["game_date"])
    df["spray"] = spray_angle(df)
    df["launch_angle"] = df["launch_angle"].astype(float)
    df["bat_speed"] = df["bat_speed"].astype(float)
    df["outcome"] = outcome_class(df["woba_value"].astype(float))
    return df.sort_values(["game_date", "game_pk", "at_bat_number"], ignore_index=True)
