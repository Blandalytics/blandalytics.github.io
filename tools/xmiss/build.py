"""Build the data for blandalytics.com/xmiss/ (xMiss): every pitcher's miss ellipses, for every level and
season in the bucket's pitch data (data/, see tools/data/README.md).

    python tools/xmiss/build.py                       # rebuild what changed, upload (GitHub Actions)
    python tools/xmiss/build.py --out site_out        # write the files to a folder instead
    python tools/xmiss/build.py --wrangler DIR        # upload with wrangler run from DIR (local)
    python tools/xmiss/build.py --only mlb/2026 --force

The model is xMiss (open_command project, xctrl_oc/): a 9-feature XGBoost model of Open Command's
catcher-target miss distance that needs only Statcast fields, and five companion models of the
miss vector's moments, which give each pitcher's 1-SD miss ellipse. They ship as one file,
xmiss.py (numpy, pandas, xgboost), kept in the bucket at MODEL_KEY and checked against
MODEL_SHA256 before it runs. A new model is a new key and a new hash here.

Each level-season is scored with the previous season at the same level as history for the
trailing windows (the previous 50 pitches of a pitch type). MLB keeps regular-season games only,
as the model was trained; other levels keep every game. Below MLB the model runs out of its
training domain (minor-league and college strike zones, parks and catchers), so the page marks
those levels provisional.

Keys (bucket blandalytics-live, https://data.blandalytics.com/):
    xmiss/<built>/<level>/<season>.json   one level-season; a new build folder whenever its
                                          source files or the model change, never overwritten
    xmiss/<built>/<level>/<season>/p/<id>.json
                                          one pitcher's pitches as dots, read by the page only when
                                          its per-pitch-type "Show pitches" toggle is on
    xmiss/index.json                      uploaded last: {built, model, levels, files, default,
                                          pitchers}; files maps "<level>/<season>" to its key, the
                                          prefix of its pitcher files (dots) and the source
                                          fingerprint it was built from
    xmiss/models/<sha8>/xmiss.py          the model (uploaded by hand from open_command)

A level-season file:
    {level, season, built, units, league: {<pitch>: {n, xmiss, major, minor}},
     pitchers: {"<id>": {name, hand, n, xmiss, pct, all: <E>, pitches: {<pitch>: <E + usage>}}}}
    <E> = {n, xmiss, pct, cx, cz, major, minor, angle, sx, sz, rho}
Inches, from the pitcher's view: x (cx, sx) positive toward the pitcher's arm side, z positive
high; (cx, cz) is the mean miss relative to the target. major and minor are the 1-SD semi-axes,
angle the long axis in degrees counter-clockwise from the arm-side horizontal (0-180). pct is
the command percentile (100 = smallest xMiss) among pitchers with 500+ pitches, or among pitch
types thrown 100+ times, at that level-season; null outside those pools. Pitch types under 20
pitches are left out.

A pitcher file: {"pitches": {<pitch>: {"x": [...], "z": [...]}}}, one entry per pitch type in the
season file, x and z in tenths of an inch (integers). Each point is where a pitch landed
relative to the pitcher's trailing count-group spot for that pitch type, batter side and count
group (the reference behind the model's main feature, dist_cc), arm side +x, as the ellipse.
The 1-SD ellipse summarizes the spread of these points: across MLB 2026 pitch types with 300+
pitches, 37% of them fall inside it (39% would for a bivariate normal). Pitches with no history
for the spot have no point.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

BASE = "https://data.blandalytics.com/"
BUCKET = "blandalytics-live"
PREFIX = "xmiss"
MODEL_KEY = "xmiss/models/5bda1298/xmiss.py"
MODEL_SHA256 = "5bda1298ff5049d69b6539c6f2bc3fbe3b7ed3cbd8e9440e2640de3d4e9da86d"
MODEL_NAME = "xMiss 9-feature model + miss-moment models (open_command xctrl_oc, 2026-11-19)"
LEVELS = {"mlb": "MLB", "aaa": "Triple-A", "afx": "Single-A", "rok": "Rookie", "win": "Winter",
          "int": "WBC", "bbc": "College", "hsb": "High school"}
DEFAULT = {"level": "mlb", "season": 2026, "pitcher": 594798}   # Jacob deGrom
MIN_PT, QUAL_P, QUAL_PT = 20, 500, 100
# bump when what this script writes changes, so every level-season rebuilds on the next run
# (2: percentiles null outside their pools; 3: per-pitcher dot files)
FORMAT = 3
EXTRA = ["pitcher_name", "game_type"]
UA = {"User-Agent": "Mozilla/5.0 blandalytics-xmiss-build"}
CACHE = Path(__file__).resolve().parent / "cache"


# ---------------------------------------------------------------------------------- sources
def get(url: str, tries: int = 4) -> bytes:
    for k in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=120)
            if r.status_code == 404:
                raise FileNotFoundError(url)
            r.raise_for_status()
            return r.content
        except FileNotFoundError:
            raise
        except Exception:  # transient network trouble: back off and retry
            if k == tries - 1:
                raise
            time.sleep(5 * (k + 1))
    raise RuntimeError("unreachable")


def manifest() -> dict:
    return json.loads(get(f"{BASE}data/manifest.json?v={int(time.time())}"))["units"]


def groups(units: dict) -> dict[tuple[str, int], list[str]]:
    """(level, season) -> its data keys. Keys: data/<sport>/<YYYY>.parquet or data/<sport>/<YYYY>/..."""
    out: dict[tuple[str, int], list[str]] = {}
    for key in units:
        parts = key.split("/")
        out.setdefault((parts[1], int(parts[2][:4])), []).append(key)
    return {k: sorted(v) for k, v in out.items()}


def fingerprint(keys: list[str], units: dict) -> str:
    """Changes when a level-season's files change (a day settles, a month closes), the model does,
    or FORMAT does (a change to what this script writes)."""
    h = hashlib.sha256(f"{MODEL_SHA256}|format {FORMAT}".encode())
    for k in keys:
        h.update(f"{k}|{units[k].get('built', '')}|{units[k].get('pitches', '')}".encode())
    return h.hexdigest()[:16]


def read_parquet(key: str, columns: list[str], built: str) -> pd.DataFrame:
    """A data file, kept in CACHE by its build stamp so reruns and the next season's history reuse it."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / (key.replace("/", "__") + "." + built.replace(":", "") + ".parquet")
    if not path.exists():
        for old in CACHE.glob(key.replace("/", "__") + ".*"):
            old.unlink()
        path.write_bytes(get(BASE + key))
    import pyarrow.parquet as pq
    have = set(pq.read_schema(path).names)
    return pd.read_parquet(path, columns=[c for c in columns if c in have])


def load(keys: list[str], units: dict, columns: list[str]) -> pd.DataFrame:
    frames = [read_parquet(k, columns, units[k].get("built", "")) for k in keys]
    frames = [f for f in frames if len(f)]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=columns)


# ---------------------------------------------------------------------------------- model
def model():
    path = CACHE / f"xmiss-{MODEL_SHA256[:8]}.py"
    CACHE.mkdir(exist_ok=True)
    if not path.exists():
        path.write_bytes(get(BASE + MODEL_KEY))
    got = hashlib.sha256(path.read_bytes()).hexdigest()
    if got != MODEL_SHA256:
        path.unlink()
        raise SystemExit(f"{MODEL_KEY}: sha256 {got} is not the pinned {MODEL_SHA256}")
    spec = importlib.util.spec_from_file_location("xmiss", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------------- build
def pct(values: pd.Series, qualified: pd.Series) -> pd.Series:
    """Command percentile within the qualified pool: the share of it with a larger xMiss (100 = best).
    Units outside the pool (too few pitches) get NaN, published as null."""
    pool = np.sort(values[qualified].to_numpy())
    out = pd.Series(np.nan, index=values.index)
    if len(pool):
        q = qualified.to_numpy()
        out[q] = 100 * (1 - np.searchsorted(pool, values[q].to_numpy(), side="right") / len(pool))
    return out


def ell(r) -> dict:
    return dict(n=int(r["n"]), xmiss=round(float(r["xmiss"]), 2), cx=round(float(r["center_x"]), 2),
                cz=round(float(r["center_z"]), 2), major=round(float(r["sd_major"]), 2),
                minor=round(float(r["sd_minor"]), 2), angle=round(float(r["angle"]), 1),
                sx=round(float(r["sd_x"]), 2), sz=round(float(r["sd_z"]), 2), rho=round(float(r["rho"]), 3))


def intpct(v) -> int | None:
    return None if v is None or np.isnan(v) else int(round(v))


def season_doc(xm, level: str, season: int, cur: pd.DataFrame, hist: pd.DataFrame | None,
               built: str) -> tuple[dict, dict]:
    """The level-season file, and each pitcher's dots ({pid: {pitch: {"x", "z"}}})."""
    game_types = ("R",) if level == "mlb" else None
    d = xm.add_xmiss(cur, history=hist if hist is not None and len(hist) else None, game_types=game_types,
                     offsets=True)
    d = d[d["xmiss"].notna()].copy()
    d["pitch_type"] = d["pitch_type"].astype(str)
    doc = dict(level=level, season=season, built=built,
               units="inches; pitcher's view; x + toward arm side, z + high; angle deg CCW from arm-side horizontal",
               league={}, pitchers={})
    if d.empty:
        return doc, {}
    whole = xm.miss_ellipses(d, by=["pitcher"])
    whole["pct"] = pct(whole["xmiss"], whole["n"] >= QUAL_P)
    by_pt = xm.miss_ellipses(d, by=["pitcher", "pitch_type"])
    by_pt = by_pt.merge(whole[["pitcher", "n"]].rename(columns={"n": "n_all"}), on="pitcher")
    by_pt["usage"] = by_pt["n"] / by_pt["n_all"]
    by_pt["pct"] = np.nan
    for _, g in by_pt.groupby("pitch_type"):
        by_pt.loc[g.index, "pct"] = pct(g["xmiss"], g["n"] >= QUAL_PT)
    meta = d.groupby("pitcher").agg(name=("pitcher_name", "last"), hand=("p_throws", "last"))
    doc["league"] = {pt: dict(n=int(g["n"].sum()), xmiss=round(float(np.average(g["xmiss"], weights=g["n"])), 2),
                              major=round(float(np.average(g["sd_major"], weights=g["n"])), 2),
                              minor=round(float(np.average(g["sd_minor"], weights=g["n"])), 2))
                     for pt, g in by_pt.groupby("pitch_type") if g["n"].sum() >= 1000}
    keep = by_pt[by_pt["n"] >= MIN_PT].sort_values(["pitcher", "n"], ascending=[True, False])
    pitches = {pid: g for pid, g in keep.groupby("pitcher")}
    for _, r in whole.iterrows():
        pid = int(r["pitcher"])
        rows = {}
        for _, e in pitches.get(pid, pd.DataFrame()).iterrows():
            rows[e["pitch_type"]] = {**ell(e), "usage": round(float(e["usage"]), 3), "pct": intpct(e["pct"])}
        doc["pitchers"][str(pid)] = dict(name=str(meta.at[pid, "name"]), hand=str(meta.at[pid, "hand"]),
                                         n=int(r["n"]), xmiss=round(float(r["xmiss"]), 2), pct=intpct(r["pct"]),
                                         all=ell(r), pitches=rows)
    # dots: every pitch of the pitch types listed, as offsets from the count-group spot in tenths
    pts = d[d["xmiss_dx"].notna() & d["xmiss_dz"].notna()]
    dots: dict[str, dict] = {}
    for (pid, pt), g in pts.groupby(["pitcher", "pitch_type"], sort=False):
        if pt not in doc["pitchers"].get(str(int(pid)), {}).get("pitches", {}):
            continue
        dots.setdefault(str(int(pid)), {})[pt] = {
            "x": np.rint(g["xmiss_dx"].to_numpy() * 10).astype(int).tolist(),
            "z": np.rint(g["xmiss_dz"].to_numpy() * 10).astype(int).tolist()}
    return doc, dots


# ---------------------------------------------------------------------------------- upload
class Sink:
    """Where the files go: R2 by boto3 (GitHub Actions), wrangler (a local login), or a folder."""

    def __init__(self, out: str | None, wrangler: str | None, dry: bool):
        self.out, self.wrangler, self.dry, self.s3 = Path(out) if out else None, wrangler, dry, None
        if not (self.out or self.wrangler or dry):
            import boto3
            acct = os.environ["R2_ACCOUNT_ID"]
            self.s3 = boto3.client("s3", endpoint_url=f"https://{acct}.r2.cloudflarestorage.com", region_name="auto",
                                   aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                                   aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])

    def put(self, key: str, data: bytes) -> None:
        print(("DRY " if self.dry else "") + f"put {key} ({len(data):,} B)", flush=True)
        if self.dry:
            return
        if self.out:
            p = self.out / key
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        elif self.wrangler:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as fh:
                fh.write(data)
            cmd = ["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}", f"--file={fh.name}",
                   "--content-type=application/json", "--remote"]
            r = subprocess.run(cmd, cwd=self.wrangler, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", shell=os.name == "nt")
            os.unlink(fh.name)
            if r.returncode != 0:
                raise SystemExit(f"upload failed for {key}:\n{r.stdout}\n{r.stderr}")
        else:
            self.s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType="application/json")

    def put_many(self, items: list[tuple[str, bytes]]) -> None:
        """Many small files: 16 at a time to R2 by boto3; one by one for a folder or wrangler
        (slow: about a second a file, so a big by-hand upload wants the R2 keys in the environment)."""
        total = sum(len(b) for _, b in items)
        print(("DRY " if self.dry else "") + f"put {len(items):,} files ({total:,} B), e.g. {items[0][0]}"
              if items else "put 0 files", flush=True)
        if self.dry or not items:
            return
        if self.s3 is not None:
            def one(kv):
                self.s3.put_object(Bucket=BUCKET, Key=kv[0], Body=kv[1], ContentType="application/json")
            with ThreadPoolExecutor(16) as pool:
                list(pool.map(one, items))
            return
        for key, data in items:
            if self.out:
                p = self.out / key
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
            else:
                self.put(key, data)


def current_index() -> dict:
    try:
        return json.loads(get(f"{BASE}{PREFIX}/index.json?v={int(time.time())}"))
    except FileNotFoundError:
        return {}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="write the files under this folder instead of uploading")
    ap.add_argument("--wrangler", help="upload with npx wrangler run from this folder (its login)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="rebuild level-seasons whose sources haven't changed")
    ap.add_argument("--only", default="", help="comma-separated level/season to consider, e.g. mlb/2026,aaa/2026")
    a = ap.parse_args()

    units = manifest()
    grp = {k: v for k, v in groups(units).items() if k[0] in LEVELS}
    only = {s.strip() for s in a.only.split(",") if s.strip()}
    old = current_index()
    files = dict(old.get("files", {}))
    built = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    sink = Sink(a.out, a.wrangler, a.dry_run)
    xm = None
    cols = None
    docs: dict[str, dict] = {}
    for (level, season), keys in sorted(grp.items()):
        name = f"{level}/{season}"
        fp = fingerprint(keys, units)
        if only and name not in only:
            continue
        if not a.force and files.get(name, {}).get("source") == fp:
            continue
        if xm is None:
            xm = model()
            cols = list(dict.fromkeys(xm.REQUIRED_COLUMNS + EXTRA))
        t = time.time()
        cur = load(keys, units, cols)
        prev = grp.get((level, season - 1))
        hist = load(prev, units, cols) if prev else None
        doc, dots = season_doc(xm, level, season, cur, hist, built)
        # pitcher files first, then the season file, then (below) the index that points at both
        prefix = f"{PREFIX}/{built}/{level}/{season}/p/"
        items = [(f"{prefix}{pid}.json", json.dumps({"pitches": v}, separators=(",", ":")).encode("utf-8"))
                 for pid, v in dots.items()]
        sink.put_many(items)
        key = f"{PREFIX}/{built}/{level}/{season}.json"
        sink.put(key, json.dumps(doc, separators=(",", ":")).encode("utf-8"))
        files[name] = {"key": key, "dots": prefix, "source": fp, "pitchers": len(doc["pitchers"]),
                       "dot_files": len(items), "dot_bytes": sum(len(b) for _, b in items)}
        docs[name] = doc
        print(f"{name}: {len(doc['pitchers'])} pitchers from {len(cur):,} rows ({time.time() - t:.0f}s)", flush=True)
    files = {k: v for k, v in files.items() if tuple([k.split("/")[0], int(k.split("/")[1])]) in grp and v["pitchers"]}
    if not docs and old:
        print("nothing changed")
        return

    # the pitcher list across every level-season: names and pitch counts, from each file
    pitchers: dict[int, dict] = {}
    for name in sorted(files):
        doc = docs.get(name) or json.loads(get(BASE + files[name]["key"]))
        for pid, p in doc["pitchers"].items():
            e = pitchers.setdefault(int(pid), {"id": int(pid), "name": p["name"], "hand": p["hand"], "n": {}})
            e["name"], e["hand"] = p["name"], p["hand"]       # the latest season's spelling wins
            e["n"][name] = p["n"]
    levels = []
    for code, label in LEVELS.items():
        seasons = sorted({int(k.split("/")[1]) for k in files if k.split("/")[0] == code}, reverse=True)
        if seasons:
            levels.append({"code": code, "name": label, "seasons": seasons, "provisional": code != "mlb"})
    index = dict(built=built, model=MODEL_NAME, levels=levels, files=files, default=DEFAULT,
                 pitchers=sorted(pitchers.values(), key=lambda e: e["name"]))
    sink.put(f"{PREFIX}/index.json", json.dumps(index, separators=(",", ":")).encode("utf-8"))   # last
    print(f"index: {len(levels)} levels, {len(files)} level-seasons, {len(pitchers)} pitchers")


if __name__ == "__main__":
    main()
