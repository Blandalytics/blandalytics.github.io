"""Release angles per season, for the Release Angles page.

The page draws a pitcher's release-angle ellipses -- one per pitch type, horizontal
against vertical release angle -- and the overlap maps built on them, as
release_angles.py in Blandalytics/baseball_snippets does. It needs every pitch's
HRA and VRA, which come from the trajectory fit in the completed-games Parquet in
the bucket (see tools/data). They are computed here, once a night, and written back
to the same bucket:

    release-angles/index.json          the seasons built, with what each covers
    release-angles/<season>.json       the pitchers: id, name, team, hand, pitch counts
    release-angles/<season>.parquet    every pitch: pitcher, date, game type, pitch type,
                                       HRA, VRA -- sorted by pitcher in small row groups

The page range-requests one pitcher out of the season's Parquet (the row-group
statistics on `pitcher` rule out all but one or two groups), so a chart costs a few
tens of KB rather than the season file's 130 MB.

    python tools/release_angles/build_data.py                  # the current season, into the bucket
    python tools/release_angles/build_data.py --seasons 2021 2022 2023   # a backfill
    python tools/release_angles/build_data.py --out release-angles/data  # a local build
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
import pyarrow as pa
import pyarrow.parquet as pq
import requests

DATA_URL = "https://data.blandalytics.com/"
MANIFEST_URL = DATA_URL + "data/manifest.json"
PREFIX = "release-angles"
SEASON_CACHE = "public, max-age=3600"
INDEX_CACHE = "public, max-age=300"
FIRST_SEASON = 2020
ROW_GROUP = 8192     # a pitcher's season is one or two groups

# the columns the angles need, out of the ~140 in a file
COLUMNS = ["game_date", "game_type", "pitcher", "pitcher_name", "p_throws", "field_team",
           "pitch_type", "vx0", "vy0", "vz0", "ax", "ay", "az", "release_extension"]
POSTSEASON = {"F", "D", "L", "W"}


# ---- storage (as tools/batted_balls/build_data.py) ----------------------------------------
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
    """The MLB files covering a season: its season file, or the months and days so far."""
    return sorted(p for p, u in manifest["units"].items()
                  if u["sport"] == "mlb" and u["start"].startswith(str(season)))


def seasons_available(manifest: dict) -> list[int]:
    return sorted({int(u["start"][:4]) for u in manifest["units"].values() if u["sport"] == "mlb"})


def read_unit(s: requests.Session, path: str) -> pd.DataFrame:
    r = s.get(DATA_URL + path, timeout=300)
    r.raise_for_status()
    return pq.read_table(io.BytesIO(r.content), columns=COLUMNS).to_pandas()


def release_angles(df: pd.DataFrame) -> pd.DataFrame:
    """HRA and VRA, as pitch_angles() in release_angles.py: the velocity at release,
    backed out of the 50 ft trajectory fit, and the angles it makes with the y axis.
    In float64 -- the fit's float32 loses too much once it is squared and rooted."""
    vx0, vy0, vz0, ax, ay, az, ext = (df[c].astype("float64") for c in
                                      ("vx0", "vy0", "vz0", "ax", "ay", "az", "release_extension"))
    vys = -((vy0 ** 2 - 2 * ay * (60.5 - ext - 50)) ** 0.5)
    t = (vys - vy0) / ay
    vxs = vx0 - ax * t
    vzs = vz0 - az * t
    return pd.DataFrame({
        "HRA": -1 * np.arctan(vxs / vys) * (180 / np.pi),
        "VRA": -1 * np.arctan(vzs / vys) * (180 / np.pi),
    }, index=df.index)


def pitches(df: pd.DataFrame) -> pd.DataFrame:
    """Every pitch with a pitch type and both angles, games of every type."""
    df = df.copy()
    df[["HRA", "VRA"]] = release_angles(df)
    df = df.dropna(subset=["HRA", "VRA", "pitch_type"])
    df = df[np.isfinite(df["HRA"]) & np.isfinite(df["VRA"])]
    return df[["game_date", "game_type", "pitcher", "pitcher_name", "p_throws", "field_team",
               "pitch_type", "HRA", "VRA"]]


def load_season(s: requests.Session, manifest: dict, season: int, verbose: bool) -> pd.DataFrame:
    parts = []
    for path in season_units(manifest, season):
        if verbose:
            print(f"  {path}", file=sys.stderr)
        parts.append(pitches(read_unit(s, path)))
    if not parts:
        raise SystemExit(f"no MLB data for {season} in the manifest")
    df = pd.concat(parts, ignore_index=True)
    for c in ("game_type", "pitcher_name", "p_throws", "field_team", "pitch_type"):
        df[c] = df[c].astype(str)
    df["game_date"] = pd.to_datetime(df["game_date"]).dt.normalize()
    return df.sort_values(["pitcher", "game_date"], kind="stable").reset_index(drop=True)


# ---- the season files ---------------------------------------------------------------------
def season_parquet(df: pd.DataFrame) -> bytes:
    table = pa.table({
        "pitcher": pa.array(df["pitcher"].to_numpy("int32")),
        "game_date": pa.array(df["game_date"].dt.date, pa.date32()),
        "game_type": pa.array(df["game_type"]).dictionary_encode(),
        "pitch_type": pa.array(df["pitch_type"]).dictionary_encode(),
        "HRA": pa.array(df["HRA"].to_numpy("float32")),
        "VRA": pa.array(df["VRA"].to_numpy("float32")),
    })
    buf = io.BytesIO()
    pq.write_table(table, buf, row_group_size=ROW_GROUP, compression="zstd",
                   write_statistics=True)
    return buf.getvalue()


def pitcher_rows(df: pd.DataFrame) -> list[dict]:
    rows = []
    for pid, g in df.groupby("pitcher", sort=False):
        last = g.iloc[-1]  # sorted by date within a pitcher: the name and team as of the last game
        post = g["game_type"].isin(POSTSEASON)
        reg = g["game_type"] == "R"
        rows.append({
            "id": int(pid),
            "name": str(last["pitcher_name"]),
            "team": str(last["field_team"]),
            "throws": str(g["p_throws"].mode().iloc[0]),
            "n": int(len(g)),
            "r": int(reg.sum()),
            "p": int(post.sum()),
            "first": str(g["game_date"].min().date()),
            "last": str(g["game_date"].max().date()),
        })
    rows.sort(key=lambda r: (r["name"], r["id"]))
    return rows


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
        through = str(df["game_date"].max().date())
        players = pitcher_rows(df)
        data = {"season": season, "built": built, "through": through, "n": int(len(df)),
                "game_types": sorted(df["game_type"].unique()), "pitchers": players}
        # the Parquet first: a list naming pitchers the file doesn't hold yet would 404 them
        store.put(f"{PREFIX}/{season}.parquet", season_parquet(df),
                  "application/vnd.apache.parquet", SEASON_CACHE)
        store.put(f"{PREFIX}/{season}.json", _dump(data), "application/json", SEASON_CACHE)
        index["seasons"][str(season)] = {"built": built, "through": through, "n": data["n"],
                                         "pitchers": len(players)}
        if verbose:
            print(f"  {data['n']} pitches, {len(players)} pitchers, through {through}",
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
