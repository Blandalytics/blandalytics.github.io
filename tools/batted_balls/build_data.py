"""Batted balls per season, for the Batted Ball Charts page.

The page draws where a hitter's batted balls land (spray angle against launch
angle) compared to the league or to their own prior season, as the Streamlit app
batted-ball-charts.streamlit.app does. It needs, per season, every hitter's batted
balls and the league-wide density they are compared against. Both come from the
completed-games Parquet in the bucket (see tools/data) and are written back to the
same bucket, so the page reads nothing but two small JSON files:

    batted-balls/index.json        the seasons built, with what each covers
    batted-balls/<season>.json     one season: every hitter's batted balls, the league grid

A hitter's own density is cheap (a few hundred points on a 91x91 grid) and is
computed in the page, exactly as scipy's gaussian_kde would; the league's is
~120,000 points and is computed here, once a night, with scipy itself.

    python tools/batted_balls/build_data.py                  # the current season, into the bucket
    python tools/batted_balls/build_data.py --seasons 2021 2022 2023   # a backfill
    python tools/batted_balls/build_data.py --out batted-balls/data    # a local build
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import requests
from scipy import stats

DATA_URL = "https://data.blandalytics.com/"
MANIFEST_URL = DATA_URL + "data/manifest.json"
PREFIX = "batted-balls"
SEASON_CACHE = "public, max-age=3600"
INDEX_CACHE = "public, max-age=300"
FIRST_SEASON = 2020

# the columns a chart needs, out of the ~140 in a file
COLUMNS = ["game_date", "game_type", "batter", "batter_name", "bat_team", "stand",
           "is_in_play", "launch_angle", "spray_angle"]

# The chart's grid: spray angle 0-90 (0 the pull-side line, 45 dead centre for
# either hand) against launch angle -30..60, 91 points each way -- the app's mgrid.
SPRAY = (0.0, 90.0)
LAUNCH = (-30.0, 60.0)
GRID_N = 91


# ---- storage (as tools/data/backfill.py, without the scraper import) ---------------------
class LocalStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def get(self, key):
        p = self.root / key
        return p.read_bytes() if p.exists() else None

    def put(self, key, data: bytes, content_type: str, cache_control: str):
        p = self.root / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


class R2Store:
    """The bucket over its S3 API. Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and
    R2_SECRET_ACCESS_KEY; R2_BUCKET defaults to blandalytics-live."""

    def __init__(self):
        import boto3
        acct = os.environ["R2_ACCOUNT_ID"]
        self.bucket = os.environ.get("R2_BUCKET", "blandalytics-live")
        self.s3 = boto3.client(
            "s3", endpoint_url=f"https://{acct}.r2.cloudflarestorage.com", region_name="auto",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        )

    def get(self, key):
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.s3.exceptions.NoSuchKey:
            return None

    def put(self, key, data: bytes, content_type: str, cache_control: str):
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data,
                           ContentType=content_type, CacheControl=cache_control)


# ---- reading the season ------------------------------------------------------------------
def season_units(manifest: dict, season: int) -> list[str]:
    """The MLB files covering a season: its season file, or the months and days so far.
    The manifest drops a file once a coarser one supersedes it, so these never overlap."""
    return sorted(p for p, u in manifest["units"].items()
                  if u["sport"] == "mlb" and u["start"].startswith(str(season)))


def seasons_available(manifest: dict) -> list[int]:
    return sorted({int(u["start"][:4]) for u in manifest["units"].values() if u["sport"] == "mlb"})


def read_unit(s: requests.Session, path: str) -> pd.DataFrame:
    r = s.get(DATA_URL + path, timeout=300)
    r.raise_for_status()
    return pq.read_table(io.BytesIO(r.content), columns=COLUMNS).to_pandas()


def batted_balls(df: pd.DataFrame) -> pd.DataFrame:
    """Regular-season balls in play with a measured launch angle and a landing spot.
    spray_deg is the app's convention: 0 at the pull-side foul line, 45 at centre,
    90 at the opposite line, for either hand."""
    keep = (df["game_type"] == "R") & df["is_in_play"].fillna(False).astype(bool)
    keep &= df["launch_angle"].notna() & df["spray_angle"].notna()
    out = df.loc[keep, ["game_date", "batter", "batter_name", "bat_team", "stand", "launch_angle"]].copy()
    out["spray_deg"] = df.loc[keep, "spray_angle"].astype(float) + 45.0
    out["launch_angle"] = out["launch_angle"].astype(float)
    return out.sort_values(["game_date", "batter"], kind="stable").reset_index(drop=True)


def load_season(s: requests.Session, manifest: dict, season: int, verbose: bool) -> pd.DataFrame:
    parts = []
    for path in season_units(manifest, season):
        if verbose:
            print(f"  {path}", file=sys.stderr)
        parts.append(batted_balls(read_unit(s, path)))
    if not parts:
        raise SystemExit(f"no MLB data for {season} in the manifest")
    return pd.concat(parts, ignore_index=True)


# ---- the league density -------------------------------------------------------------------
def in_range(df: pd.DataFrame) -> pd.DataFrame:
    return df[df["spray_deg"].between(*SPRAY) & df["launch_angle"].between(*LAUNCH)]


def league_grid(df: pd.DataFrame) -> np.ndarray:
    """scipy's gaussian_kde of every in-range batted ball on the chart's grid, scaled to
    sum to 100 -- the app's f_league. Row-major by spray, then launch angle."""
    pts = in_range(df)
    kernel = stats.gaussian_kde(np.vstack([pts["spray_deg"].to_numpy(), pts["launch_angle"].to_numpy()]))
    X, Y = np.mgrid[SPRAY[0]:SPRAY[1]:complex(GRID_N), LAUNCH[0]:LAUNCH[1]:complex(GRID_N)]
    f = kernel(np.vstack([X.ravel(), Y.ravel()]))
    return f * (100.0 / f.sum())


# ---- the season file ----------------------------------------------------------------------
def player_rows(df: pd.DataFrame) -> list[dict]:
    rows = []
    for pid, g in df.groupby("batter", sort=False):
        last = g.iloc[-1]  # the frame is in date order: the name and team as of the last game
        rows.append({
            "id": int(pid),
            "name": str(last["batter_name"]),
            "team": str(last["bat_team"]),
            "stand": str(g["stand"].mode().iloc[0]),
            "bbe": [[round(float(a), 1), round(float(b), 1)]
                    for a, b in zip(g["spray_deg"], g["launch_angle"])],
        })
    rows.sort(key=lambda r: (r["name"], r["id"]))
    return rows


def season_file(season: int, df: pd.DataFrame, built: str) -> dict:
    return {
        "season": season,
        "built": built,
        "through": str(df["game_date"].max().date()),
        "n": int(len(df)),
        "grid": {"spray": [*SPRAY, GRID_N], "launch": [*LAUNCH, GRID_N]},
        "league": [round(float(v), 7) for v in league_grid(df)],
        "teams": sorted(df["bat_team"].astype(str).unique()),
        "players": player_rows(df),
    }


def _dump(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def build(store, s: requests.Session, manifest: dict, seasons: list[int], verbose: bool) -> None:
    raw = store.get(f"{PREFIX}/index.json")
    index = json.loads(raw) if raw else {"seasons": {}}
    for season in seasons:
        if verbose:
            print(f"{season}:", file=sys.stderr)
        built = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        df = load_season(s, manifest, season, verbose)
        data = season_file(season, df, built)
        store.put(f"{PREFIX}/{season}.json", _dump(data), "application/json", SEASON_CACHE)
        index["seasons"][str(season)] = {
            "built": built, "through": data["through"], "n": data["n"],
            "players": len(data["players"]),
        }
        if verbose:
            print(f"  {data['n']} batted balls, {len(data['players'])} hitters, through {data['through']}",
                  file=sys.stderr)
    index["seasons"] = dict(sorted(index["seasons"].items()))
    index["built"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    store.put(f"{PREFIX}/index.json", _dump(index), "application/json", INDEX_CACHE)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="*", help="seasons to build; default: the current one")
    ap.add_argument("--out", help="write to this directory instead of the bucket")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)

    s = requests.Session()
    manifest = s.get(MANIFEST_URL, timeout=60).json()
    have = seasons_available(manifest)
    seasons = a.seasons or [have[-1]]
    missing = [y for y in seasons if y not in have or y < FIRST_SEASON]
    if missing:
        raise SystemExit(f"no data for {missing}; the bucket has {have[0]}-{have[-1]}")
    store = LocalStore(a.out) if a.out else R2Store()
    build(store, s, manifest, seasons, verbose=not a.quiet)


if __name__ == "__main__":
    main()
