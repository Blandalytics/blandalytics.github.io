"""Completed games -> pitch-level Parquet in R2, one immutable file per day, month or season.

    data/manifest.json                  every file below, with its span and game counts
    data/mlb/2025.parquet               a closed season, one pull
    data/mlb/2026/2026-08.parquet       a closed month of the current season
    data/mlb/2026/days/2026-09-18.parquet   a day, written once the data has settled (D+2)

Each file is written once and never rewritten (unless --force), so anything cached
at the edge stays valid. When a month closes it is pulled fresh — which folds in the
API's late corrections — and its day files are dropped; a season, likewise, replaces
its months. The client reads the manifest and picks the coarsest file covering what
it wants; anything after the manifest's last finalised date comes from the live feed.

Pulls go through statfast (the scraper cloned alongside this repo); games are found
here rather than by the scraper so any sportId works. A game is kept only if some
pitch in it was measured, so an untracked park contributes nothing and a file holds
exactly the games with Statcast data.

    build --sport mlb --unit day --start 2026-09-18 [--end ...]   one or more units
    roll                                                           what the nightly job runs
"""
from __future__ import annotations

import argparse
import calendar
import datetime as dt
import io
import json
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "statcast_scraper"))
import statfast  # noqa: E402

API = "https://statsapi.mlb.com/api/v1"
ET = ZoneInfo("America/New_York")
# regular season and the four postseason rounds; spring, exhibitions and the
# All-Star game are left out
GAME_TYPES = {"R", "F", "D", "L", "W"}
SETTLE_DAYS = 2                    # the API corrects a game for a day or two after it
FILE_CACHE = "public, max-age=604800"
MANIFEST_CACHE = "public, max-age=300"

# columns beyond statfast's, appended in this order
EXTRA_COLS = ("sport_id", "game_type")
COLUMNS = tuple(statfast.COLUMNS) + EXTRA_COLS


# ---- sports and schedule --------------------------------------------------------------
def sports(s: requests.Session) -> dict[str, int]:
    """code -> sportId for every league the API carries (mlb, aaa, aax, afa, afx, ...)."""
    r = s.get(f"{API}/sports", params={"fields": "sports,id,code"}, timeout=30)
    r.raise_for_status()
    return {x["code"]: x["id"] for x in r.json()["sports"]}


def resolve_sports(s: requests.Session, names: str) -> list[tuple[str, int]]:
    """'mlb,aaa' or '1,11' -> [(code, id), ...]; 'all' is every league the API lists."""
    if names.strip() == "all":
        return sorted(sports(s).items(), key=lambda x: x[1])
    return [resolve_sport(s, n.strip()) for n in names.split(",") if n.strip()]


def resolve_sport(s: requests.Session, name: str) -> tuple[str, int]:
    table = sports(s)
    if name.isdigit():
        code = next((c for c, i in table.items() if i == int(name)), None)
        if code is None:
            raise SystemExit(f"unknown sportId {name}")
        return code, int(name)
    if name not in table:
        raise SystemExit(f"unknown sport {name!r}; one of {', '.join(sorted(table))}")
    return name, table[name]


def schedule(s: requests.Session, sport_id: int, start: str, end: str) -> dict[int, dict]:
    """gamePk -> {date, home, away, game_type} for every game *played* in the span."""
    params = {
        "sportId": sport_id, "startDate": start, "endDate": end,
        "fields": "dates,date,games,gamePk,gameType,status,codedGameState,teams,home,away,team,id",
    }
    r = s.get(f"{API}/schedule", params=params, timeout=60)
    r.raise_for_status()
    out = {}
    for d in r.json().get("dates", []):
        for g in d["games"]:
            if g["status"].get("codedGameState") != "F" or g.get("gameType") not in GAME_TYPES:
                continue
            out[g["gamePk"]] = {
                "date": d["date"], "game_type": g["gameType"],
                "home": g["teams"]["home"]["team"]["id"], "away": g["teams"]["away"]["team"]["id"],
            }
    return out


def team_abbrs(s: requests.Session, sport_id: int, seasons: set[str]) -> dict[str, str]:
    """team id (as str) -> abbreviation. statfast only knows MLB clubs; the other
    leagues come back from the pull as ids and are renamed here."""
    out = {}
    for y in seasons:
        params = {"sportId": sport_id, "season": y, "fields": "teams,id,abbreviation"}
        r = s.get(f"{API}/teams", params=params, timeout=30)
        for t in r.json().get("teams", []):
            out[str(t["id"])] = t.get("abbreviation") or str(t["id"])
    return out


# ---- the pull -------------------------------------------------------------------------
def pull(s: requests.Session, sport_id: int, games: dict[int, dict], workers: int) -> pd.DataFrame:
    """Every tracked pitch in the given games, in statfast's schema plus EXTRA_COLS."""
    if not games:
        return empty()
    sf_games = {pk: statfast._Game(g["date"], g["home"], g["away"]) for pk, g in games.items()}
    df = statfast._collect(s, sf_games, None, workers)
    # an untracked park still reports a pitchData block (just the zone bounds), so
    # the scraper keeps its pitches with no speed; a game counts as tracked only if
    # some pitch was measured — the same rule the live poller applies
    tracked = df.groupby("game_pk", observed=True)["release_speed"].transform(lambda x: x.notna().any())
    df = df[tracked].reset_index(drop=True)
    if df.empty:
        return empty()

    if sport_id != 1:
        abbr = team_abbrs(s, sport_id, {g["date"][:4] for g in games.values()})
        for c in ("home_team", "away_team", "bat_team", "field_team"):
            # mapped value by value rather than renaming categories: two college
            # programs can share an abbreviation, which a rename would reject
            df[c] = df[c].astype("string").map(lambda v: abbr.get(v, v)).astype("category")

    df["sport_id"] = pd.Series(sport_id, index=df.index, dtype="UInt16")
    types = pd.Series(df["game_pk"].map({pk: g["game_type"] for pk, g in games.items()}))
    df["game_type"] = types.astype("string").astype("category")
    df = df[list(COLUMNS)]
    assert tuple(df.columns) == COLUMNS
    return df


def empty() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="object") for c in COLUMNS})


def to_parquet(df: pd.DataFrame) -> bytes:
    buf = io.BytesIO()
    df.to_parquet(buf, engine="pyarrow", compression="zstd", index=False, row_group_size=100_000)
    return buf.getvalue()


# ---- units ----------------------------------------------------------------------------
def unit_span(unit: str, key: str) -> tuple[str, str]:
    """(start, end) dates of a day 'YYYY-MM-DD', month 'YYYY-MM' or season 'YYYY'."""
    if unit == "day":
        dt.date.fromisoformat(key)
        return key, key
    if unit == "month":
        y, m = (int(x) for x in key.split("-"))
        return f"{y}-{m:02d}-01", f"{y}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"
    if unit == "season":
        return f"{key}-01-01", f"{key}-12-31"
    raise ValueError(unit)


def unit_path(sport: str, unit: str, key: str) -> str:
    if unit == "day":
        return f"data/{sport}/{key[:4]}/days/{key}.parquet"
    if unit == "month":
        return f"data/{sport}/{key[:4]}/{key}.parquet"
    return f"data/{sport}/{key}.parquet"


def unit_keys(unit: str, start: str, end: str | None) -> list[str]:
    """Every unit key from start to end inclusive: days, months or seasons."""
    end = end or start
    if unit == "day":
        a, b = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
        return [(a + dt.timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    if unit == "month":
        ya, ma = (int(x) for x in start[:7].split("-"))
        yb, mb = (int(x) for x in end[:7].split("-"))
        keys, y, m = [], ya, ma
        while (y, m) <= (yb, mb):
            keys.append(f"{y}-{m:02d}")
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return keys
    return [str(y) for y in range(int(start[:4]), int(end[:4]) + 1)]


RANK = {"day": 0, "month": 1, "season": 2}


def covered_by(sport: str, unit: str, key: str, manifest: dict) -> str | None:
    """The path of a coarser unit already holding this span, if any."""
    start, end = unit_span(unit, key)
    for p, u in manifest["units"].items():
        if u["sport"] == sport and RANK[u["unit"]] > RANK[unit] and u["start"] <= start and end <= u["end"]:
            return p
    return None


def children(sport: str, unit: str, key: str, manifest: dict) -> list[str]:
    """Paths a coarser unit supersedes: a month's days, a season's months and days."""
    start, end = unit_span(unit, key)
    finer = {"month": ("day",), "season": ("month", "day")}.get(unit, ())
    return [p for p, u in manifest["units"].items()
            if u["sport"] == sport and u["unit"] in finer and start <= u["start"] and u["end"] <= end]


# ---- storage --------------------------------------------------------------------------
class LocalStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def exists(self, key): return (self.root / key).exists()
    def get(self, key): p = self.root / key; return p.read_bytes() if p.exists() else None
    def delete(self, key): (self.root / key).unlink(missing_ok=True)

    def keys(self, prefix):
        base = self.root / prefix
        return sorted(str(p.relative_to(self.root)).replace("\\", "/")
                      for p in base.rglob("*") if p.is_file()) if base.is_dir() else []

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

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except self.s3.exceptions.ClientError:
            return False

    def get(self, key):
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.s3.exceptions.NoSuchKey:
            return None

    def put(self, key, data: bytes, content_type: str, cache_control: str):
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data,
                           ContentType=content_type, CacheControl=cache_control)

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    def keys(self, prefix):
        pages = self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix)
        return sorted(o["Key"] for page in pages for o in page.get("Contents", []))


MANIFEST = "data/manifest.json"


def load_manifest(store) -> dict:
    raw = store.get(MANIFEST)
    m = json.loads(raw) if raw else {}
    m.setdefault("units", {})
    m.setdefault("last_finalized", {})
    return m


def save_manifest(store, m: dict) -> None:
    for sport in {u["sport"] for u in m["units"].values()} | set(m["last_finalized"]):
        ends = [u["end"] for u in m["units"].values() if u["sport"] == sport]
        m["last_finalized"][sport] = max(ends) if ends else None
    m["built"] = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    m["units"] = dict(sorted(m["units"].items()))
    store.put(MANIFEST, json.dumps(m, indent=1).encode(), "application/json", MANIFEST_CACHE)


# ---- building -------------------------------------------------------------------------
def build_unit(s, store, manifest, sport: str, sport_id: int, unit: str, key: str,
               workers: int, force: bool, prune: bool) -> bool:
    """Pull, verify and write one unit. Returns True if a file was written."""
    path = unit_path(sport, unit, key)
    if not force and path in manifest["units"] and store.exists(path):
        print(f"  {path}: exists, skipped")
        return False
    if not force and (outer := covered_by(sport, unit, key, manifest)):
        print(f"  {path}: covered by {outer}, skipped")
        return False
    start, end = unit_span(unit, key)
    games = schedule(s, sport_id, start, end)
    if not games:
        print(f"  {path}: no games played, nothing written")
        return False

    df = pull(s, sport_id, games, workers)
    have = set(int(x) for x in df["game_pk"].unique()) if not df.empty else set()
    missing = sorted(set(games) - have)
    if df.empty:
        print(f"  {path}: {len(games)} games, none tracked, nothing written")
        return False

    data = to_parquet(df)
    store.put(path, data, "application/octet-stream", FILE_CACHE)
    manifest["units"][path] = {
        "sport": sport, "sport_id": sport_id, "unit": unit, "key": key, "start": start, "end": end,
        "games": len(have), "pitches": int(len(df)), "scheduled": len(games),
        "untracked": missing, "bytes": len(data),
        "built": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
    }
    note = f", {len(missing)} untracked" if missing else ""
    print(f"  {path}: {len(have)} games, {len(df):,} pitches, {len(data) / 1e6:.1f} MB{note}")

    if prune:
        for p in children(sport, unit, key, manifest):
            store.delete(p)
            del manifest["units"][p]
            print(f"    dropped {p}")
    save_manifest(store, manifest)   # checkpoint after every unit
    return True


def tidy(store, manifest) -> None:
    """Drop any unit a coarser one has since superseded."""
    for p, u in list(manifest["units"].items()):
        if covered_by(u["sport"], u["unit"], u["key"], manifest):
            store.delete(p)
            del manifest["units"][p]
            print(f"  dropped {p} (superseded)")


def cmd_build(a, s, store):
    manifest = load_manifest(store)
    for sport, sport_id in resolve_sports(s, a.sport):
        print(f"{sport} ({sport_id}) {a.unit}s {a.start}..{a.end or a.start}")
        for key in unit_keys(a.unit, a.start, a.end):
            build_unit(s, store, manifest, sport, sport_id, a.unit, key, a.workers, a.force, a.prune)


def cmd_roll(a, s, store):
    """The nightly step: the day that has just settled, then any month whose last day
    has settled (this month if it just ended, and the one before in case a night was
    missed). Seasons are closed by hand, after the World Series.

    Runs over every league by default: only games with measured pitches are written,
    so the untracked leagues cost a schedule call and a few wasted fetches, and a park
    that gains tracking shows up on its own."""
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(ET).date()
    settled = today - dt.timedelta(days=SETTLE_DAYS)
    manifest = load_manifest(store)
    this_month = settled.replace(day=1)
    prev_month = (this_month - dt.timedelta(days=1)).replace(day=1)
    for sport, sport_id in resolve_sports(s, a.sport):
        print(f"{sport} ({sport_id}): settled through {settled}")
        for m in (prev_month, this_month):
            last = m.replace(day=calendar.monthrange(m.year, m.month)[1])
            if settled >= last:
                build_unit(s, store, manifest, sport, sport_id, "month", m.strftime("%Y-%m"),
                           a.workers, False, True)
        build_unit(s, store, manifest, sport, sport_id, "day", settled.isoformat(),
                   a.workers, False, True)
    tidy(store, manifest)
    save_manifest(store, manifest)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="write to this directory instead of R2")
    ap.add_argument("-w", "--workers", type=int, default=12)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="one or more units of one or more sports")
    b.add_argument("--sport", default="mlb", help="codes or ids, comma-separated (mlb, aaa, 11...), or all")
    b.add_argument("--unit", choices=("day", "month", "season"), required=True)
    b.add_argument("--start", required=True, help="YYYY-MM-DD, YYYY-MM or YYYY to match --unit")
    b.add_argument("--end", help="last unit, inclusive (default: --start)")
    b.add_argument("--force", action="store_true", help="rewrite units that already exist")
    b.add_argument("--prune", action="store_true", help="drop the finer files a unit supersedes")
    b.set_defaults(run=cmd_build)

    r = sub.add_parser("roll", help="the nightly step: settled day + closed month")
    r.add_argument("--sport", default="all", help="codes, ids, or all (default)")
    r.add_argument("--today", help="pretend it is this date (YYYY-MM-DD)")
    r.set_defaults(run=cmd_roll)

    a = ap.parse_args(argv)
    store = LocalStore(a.out) if a.out else R2Store()
    a.run(a, statfast._session(max(a.workers, 4)), store)


if __name__ == "__main__":
    main()
