"""Everything that comes off the network besides the game's own pitches: the statsapi
live feed (box score, bio, teams), Baseball Savant's arm-angle leaderboard, and the
pitches behind the comparison shapes (and behind any settled date's cards), read from
the data files in the bucket and topped up through statfast for the days those files
do not reach yet."""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import sys

import pandas as pd
import pyarrow.parquet as pq
import requests
import statfast

FEED = "https://statsapi.mlb.com/api/v1.1/game/{pk}/feed/live"
# the completed-games Parquet that tools/data/backfill.py writes: one file per settled
# day, closed month or closed season, listed in data/manifest.json
DATA_URL = "https://data.blandalytics.com"
ARM_ANGLES = (
    "https://baseballsavant.mlb.com/leaderboard/pitcher-arm-angles?batSide=&dateStart={start}"
    "&dateEnd={end}&gameType={gt}&groupBy=api_pitch_type_group03&min=1&minGroupPitches=1"
    "&perspective=back&pitchHand=&pitchType=&season={season}&size=small&sort=ascending"
    "&team=&csv=true"
)
FIRST_SEASON = 2023  # the earliest season the card offers as a comparison
# the columns the comparison needs; keeping a season in memory is cheap at this width
SEASON_COLUMNS = (
    "game_pk", "game_date", "at_bat_index", "pitch_number", "pitcher", "p_throws", "stand",
    "pitch_type", "det_code", "balls", "strikes", "zone", "sz_top", "sz_bot", "release_speed",
    "release_extension", "plate_time", "hb", "ivb", "release_spin_rate", "spin_axis", "plate_x",
    "plate_z", "release_pos_x", "release_pos_z", "vy0", "vz0", "ay", "az",
)  # fmt: skip
# ...the few more a game's own card reads, and the rest of what the pitch-modeling scorer
# needs (its release physics, the call and event behind each outcome, the names it keys
# on); a data file is narrowed to these on the way into the cache, which is what keeps a
# season well under its full size there
CARD_COLUMNS = (
    *SEASON_COLUMNS, "inning", "launch_speed", "launch_angle", "play_id", "post_bat_score",
    "post_field_score", "game_type", "release_pos_y", "vx0", "ax", "call_code", "events",
    "pitcher_name", "batter", "home_team", "event_desc",
)  # fmt: skip
SCRAPER_COLUMNS = tuple(c for c in CARD_COLUMNS if c != "game_type")  # what statfast has


def session() -> requests.Session:
    return statfast._session()


def feed(s: requests.Session, game_pk: int) -> dict:
    r = s.get(FEED.format(pk=game_pk), timeout=90)
    r.raise_for_status()
    return r.json()


# ---- arm angles ---------------------------------------------------------------------
def _arm_queries(game_date: dt.date, today: dt.date, game_type: str) -> list[dict[str, str]]:
    """The leaderboards to try for a game, best first.

    Savant's per-day arm angles land a few days after the game, so a recent game reads
    the season to date; a game before the season opens reads the previous season. The
    season is always named: without it a date window in a past season comes back empty.
    A postseason date holds no regular-season games, so the round's own code has to be
    asked for -- and a round Savant has not published yet falls back to the pitcher's
    regular season, which is the sample the comparisons use anyway."""
    opener = dt.date(game_date.year, 3, 25)
    year = str(game_date.year - 1 if game_date <= opener else game_date.year)
    day = game_date.isoformat()
    out = []
    if (today - game_date).days >= 3 and game_date > opener:
        out.append({"start": day, "end": day, "season": year, "gt": game_type})
    out.append({"start": "", "end": "", "season": year, "gt": game_type})
    if game_type != "R":
        out.append({"start": "", "end": "", "season": year, "gt": "R"})
    return out


_arm_cache: dict[str, dict[int, dict[str, float]]] = {}


def arm_angles(
    s: requests.Session,
    game_date: dt.date,
    today: dt.date | None = None,
    game_type: str = "R",
) -> dict[int, dict[str, float]]:
    """pitcher id -> {raw pitch-type code: arm angle in degrees} for a game date."""
    for q in _arm_queries(game_date, today or dt.date.today(), game_type):
        url = ARM_ANGLES.format(**q)
        if url not in _arm_cache:
            try:
                _arm_cache[url] = _read_arm_angles(s, url)
            except (requests.RequestException, ValueError, KeyError) as exc:
                print(f"arm angles unavailable for {game_date}: {exc}", file=sys.stderr)
                _arm_cache[url] = {}
        if _arm_cache[url]:
            return _arm_cache[url]
    return {}


def _read_arm_angles(s: requests.Session, url: str) -> dict[int, dict[str, float]]:
    r = s.get(url, timeout=120)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.content.decode("utf-8")))
    angles = df.groupby(["pitcher", "api_pitch_type_group03"])["ball_angle"].mean()
    out: dict[int, dict[str, float]] = {}
    for (pid, code), angle in angles.items():
        out.setdefault(int(pid), {})[str(code)] = float(angle)
    return out


# ---- the data files -------------------------------------------------------------------
def _date(v) -> dt.date:
    return v if isinstance(v, dt.date) else dt.date.fromisoformat(str(v)[:10])


class DataStore:
    """Pitches by date, from the data files in the bucket plus a statfast top-up.

    A finished season, a closed month or a settled day is one immutable file in the
    bucket; each is downloaded once, narrowed to CARD_COLUMNS and cached on disk. Days
    the files do not reach yet (the manifest's ``last_finalized`` is two days back) are
    pulled through statfast and cached as a small tail that is re-pulled whenever the
    files catch up. With no manifest at all everything comes through statfast, as the
    card always did."""

    def __init__(
        self, cache_dir: str, s: requests.Session, first_season: int = FIRST_SEASON,
        sport: str = "mlb", data_url: str = DATA_URL,
    ):  # fmt: skip
        self.dir = cache_dir
        self.s = s
        self.first_season = first_season
        self.sport = sport
        self.data_url = data_url
        self._manifest: dict | None = None
        self._frames: dict[str, pd.DataFrame] = {}
        self._seasons: dict[int, tuple[dt.date, pd.DataFrame]] = {}
        self._tails: dict[int, tuple[pd.DataFrame, dt.date, dt.date]] = {}
        os.makedirs(os.path.join(cache_dir, "units"), exist_ok=True)

    # -- the manifest --
    @property
    def manifest(self) -> dict:
        if self._manifest is None:
            try:
                r = self.s.get(f"{self.data_url}/data/manifest.json", timeout=30)
                r.raise_for_status()
                self._manifest = r.json()
            except (requests.RequestException, ValueError) as exc:
                print(f"data files unavailable, scraping instead: {exc}", file=sys.stderr)
                self._manifest = {"units": {}, "last_finalized": {}}
            self._forget_superseded()
        return self._manifest

    @property
    def last_finalized(self) -> dt.date | None:
        v = self.manifest.get("last_finalized", {}).get(self.sport)
        return dt.date.fromisoformat(v) if v else None

    def _units(self, start: dt.date, end: dt.date) -> list[tuple[str, dict]]:
        """The files whose span touches [start, end], for this sport."""
        return [
            (path, u) for path, u in self.manifest["units"].items()
            if u["sport"] == self.sport
            and _date(u["start"]) <= end and start <= _date(u["end"])
        ]  # fmt: skip

    # -- one file --
    def _cache_path(self, unit_path: str, ext: str) -> str:
        return os.path.join(self.dir, "units", unit_path.replace("/", "__") + "." + ext)

    def _forget_superseded(self) -> None:
        """Drop cached files the manifest no longer lists (a month replaced its days)."""
        want = {self._cache_path(p, "parquet") for p in self._manifest["units"]}
        folder = os.path.join(self.dir, "units")
        for name in os.listdir(folder):
            full = os.path.join(folder, name)
            if name.endswith(".parquet") and full not in want:
                os.remove(full)
                if os.path.exists(full[:-8] + ".json"):
                    os.remove(full[:-8] + ".json")

    def _fresh(self, unit_path: str, unit: dict) -> bool:
        meta_path = self._cache_path(unit_path, "json")
        have = os.path.exists(self._cache_path(unit_path, "parquet")) and os.path.exists(meta_path)
        if not have:
            return False
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.load(fh)
        # the columns too: a cache narrowed before one was added has to be pulled again
        return meta.get("built") == unit.get("built") and meta.get("columns") == list(CARD_COLUMNS)

    def _download(self, unit_path: str, unit: dict) -> None:
        r = self.s.get(f"{self.data_url}/{unit_path}", timeout=600)
        r.raise_for_status()
        df = pq.read_table(io.BytesIO(r.content), columns=list(CARD_COLUMNS)).to_pandas()
        df.to_parquet(self._cache_path(unit_path, "parquet"), index=False)
        with open(self._cache_path(unit_path, "json"), "w", encoding="utf-8") as fh:
            meta = {"built": unit.get("built"), "pitches": len(df), "columns": list(CARD_COLUMNS)}
            json.dump(meta, fh)
        print(f"  data file {unit_path}: {len(df):,} pitches", file=sys.stderr)

    def _frame(self, unit_path: str, unit: dict) -> pd.DataFrame:
        if unit_path not in self._frames:
            if not self._fresh(unit_path, unit):
                self._download(unit_path, unit)
            self._frames[unit_path] = pd.read_parquet(self._cache_path(unit_path, "parquet"))
        return self._frames[unit_path]

    # -- spans --
    def stored(self, start: dt.date, end: dt.date) -> pd.DataFrame | None:
        """Every pitch in the files from ``start`` to ``end`` inclusive, or None when
        the files do not reach ``end`` yet."""
        last = self.last_finalized
        if last is None or end > last:
            return None
        frames = [self._frame(p, u) for p, u in self._units(start, end)]
        if not frames:
            return _empty()
        df = _concat(*frames)
        lo, hi = pd.Timestamp(start), pd.Timestamp(end)
        return df[(df["game_date"] >= lo) & (df["game_date"] <= hi)].reset_index(drop=True)

    def day(self, date) -> pd.DataFrame | None:
        """A settled date's pitches, every game and game type; None if not settled."""
        date = _date(date)
        return self.stored(date, date)

    def _tail_path(self, year: int, ext: str) -> str:
        return os.path.join(self.dir, f"tail_{year}.{ext}")

    def _load_tail(self, year: int):
        if year not in self._tails and os.path.exists(self._tail_path(year, "json")):
            with open(self._tail_path(year, "json"), encoding="utf-8") as fh:
                meta = json.load(fh)
            self._tails[year] = (
                pd.read_parquet(self._tail_path(year, "parquet")),
                dt.date.fromisoformat(meta["from"]), dt.date.fromisoformat(meta["through"]),
            )  # fmt: skip
        return self._tails.get(year)

    def _tail(self, year: int, start: dt.date, end: dt.date) -> pd.DataFrame:
        """statfast for [start, end]: the days past the files. Cached per season and
        re-pulled when the wanted span moves, which is once a day at most."""
        have = self._load_tail(year)
        if have is not None and have[1] == start and have[2] >= end:
            return have[0][have[0]["game_date"] <= pd.Timestamp(end)]
        df = statfast.mlb_season(
            start=start, end=end, columns=list(SCRAPER_COLUMNS), session=self.s
        )
        df["game_type"] = pd.Series("R", index=df.index, dtype="string").astype("category")
        self._tails[year] = (df, start, end)
        df.to_parquet(self._tail_path(year, "parquet"), index=False)
        with open(self._tail_path(year, "json"), "w", encoding="utf-8") as fh:
            json.dump({"from": start.isoformat(), "through": end.isoformat()}, fh)
        return df

    def through(self, year: int, date: dt.date) -> pd.DataFrame:
        """The season's regular-season pitches through ``date`` (inclusive), in the narrow
        set: a comparison reads none of the scorer's columns, and every card slices this
        frame by pitcher, so carrying them costs a copy each time."""
        end = min(_date(date), dt.date(year, 12, 31))
        first = dt.date(year, 1, 1)
        last = self.last_finalized
        parts = []
        stored_end = min(end, last) if last else None
        if stored_end is not None and stored_end >= first:
            df = self.stored(first, stored_end)
            parts.append(df[df["game_type"] == "R"])
        tail_start = stored_end + dt.timedelta(days=1) if stored_end else first
        if tail_start <= end:
            parts.append(self._tail(year, tail_start, end))
        out = _concat(*parts) if parts else _empty()
        return out[list(SEASON_COLUMNS)]

    def season(self, year: int, date: dt.date) -> pd.DataFrame:
        """``through``, kept between calls. Every card built for a date asks for the same
        four seasons, and stitching a season's files back together is not cheap."""
        end = min(_date(date), dt.date(year, 12, 31))
        have = self._seasons.get(year)
        if have is None or have[0] != end:
            self._seasons[year] = (end, self.through(year, end))  # one per year at a time
        return self._seasons[year][1]

    def before(self, year: int, date: dt.date) -> pd.DataFrame:
        """The season's regular-season pitches from games strictly before ``date``."""
        date = _date(date)
        df = self.season(year, date - dt.timedelta(days=1))
        return df[df["game_date"] < pd.Timestamp(date)]


SeasonStore = DataStore  # the name build_site and card used before the data files


def _empty() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="object") for c in CARD_COLUMNS})


def _concat(*frames: pd.DataFrame) -> pd.DataFrame:
    """Append, keeping the string columns categorical across differing category sets.

    Frames with no rows are dropped first. They add nothing, and a typeless empty one
    would turn every numeric column object: past the last regular-season day the tail
    pull covers a span with no games, which is every day of the postseason."""
    frames = tuple(f for f in frames if not f.empty) or frames[:1]
    if len(frames) == 1:
        return frames[0]
    cats = [c for c in frames[0].columns if isinstance(frames[0][c].dtype, pd.CategoricalDtype)]
    out = pd.concat(frames, ignore_index=True)
    for c in cats:
        out[c] = out[c].astype("category")
    return out
