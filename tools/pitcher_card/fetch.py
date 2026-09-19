"""Everything that comes off the network besides the game's own pitches: the statsapi
live feed (box score, bio, teams), Baseball Savant's arm-angle leaderboard, and the
regular-season pitches behind the comparison shapes, pulled through statfast and cached
as one parquet file per season."""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import sys

import pandas as pd
import requests
import statfast

FEED = "https://statsapi.mlb.com/api/v1.1/game/{pk}/feed/live"
ARM_ANGLES = (
    "https://baseballsavant.mlb.com/leaderboard/pitcher-arm-angles?batSide=&dateStart={start}"
    "&dateEnd={end}&gameType=R&groupBy=api_pitch_type_group03&min=1&minGroupPitches=1"
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


def session() -> requests.Session:
    return statfast._session()


def feed(s: requests.Session, game_pk: int) -> dict:
    r = s.get(FEED.format(pk=game_pk), timeout=90)
    r.raise_for_status()
    return r.json()


# ---- arm angles ---------------------------------------------------------------------
def _arm_query(game_date: dt.date, today: dt.date) -> dict[str, str]:
    """Which leaderboard to read. Savant's per-day arm angles land a few days after the
    game, so a recent game reads the season to date; a game before the season opens
    reads the previous season."""
    opener = dt.date(game_date.year, 3, 25)
    if (today - game_date).days >= 3 and game_date > opener:
        return {"start": game_date.isoformat(), "end": game_date.isoformat(), "season": ""}
    year = game_date.year - 1 if game_date <= opener else game_date.year
    return {"start": "", "end": "", "season": str(year)}


_arm_cache: dict[str, dict[int, dict[str, float]]] = {}


def arm_angles(
    s: requests.Session, game_date: dt.date, today: dt.date | None = None
) -> dict[int, dict[str, float]]:
    """pitcher id -> {raw pitch-type code: arm angle in degrees} for a game date."""
    url = ARM_ANGLES.format(**_arm_query(game_date, today or dt.date.today()))
    if url not in _arm_cache:
        try:
            _arm_cache[url] = _read_arm_angles(s, url)
        except (requests.RequestException, ValueError, KeyError) as exc:
            print(f"arm angles unavailable for {game_date}: {exc}", file=sys.stderr)
            _arm_cache[url] = {}
    return _arm_cache[url]


def _read_arm_angles(s: requests.Session, url: str) -> dict[int, dict[str, float]]:
    r = s.get(url, timeout=120)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.content.decode("utf-8")))
    angles = df.groupby(["pitcher", "api_pitch_type_group03"])["ball_angle"].mean()
    out: dict[int, dict[str, float]] = {}
    for (pid, code), angle in angles.items():
        out.setdefault(int(pid), {})[str(code)] = float(angle)
    return out


# ---- comparison seasons -------------------------------------------------------------
class SeasonStore:
    """Regular-season pitches by year, cached as parquet and topped up on demand.

    A finished season is pulled once; the current season is extended to the day before
    each card, so the nightly build only ever fetches the newest day of games."""

    def __init__(self, cache_dir: str, s: requests.Session, first_season: int = FIRST_SEASON):
        self.dir = cache_dir
        self.s = s
        self.first_season = first_season
        self.columns = list(SEASON_COLUMNS)
        self._frames: dict[int, tuple[pd.DataFrame | None, dt.date | None]] = {}
        os.makedirs(cache_dir, exist_ok=True)

    def _path(self, year: int, ext: str) -> str:
        return os.path.join(self.dir, f"season_{year}.{ext}")

    def _load(self, year: int) -> tuple[pd.DataFrame | None, dt.date | None]:
        if year not in self._frames:
            self._frames[year] = (None, None)
            if os.path.exists(self._path(year, "json")):
                with open(self._path(year, "json"), encoding="utf-8") as fh:
                    through = dt.date.fromisoformat(json.load(fh)["through"])
                self._frames[year] = (pd.read_parquet(self._path(year, "parquet")), through)
        return self._frames[year]

    def _save(self, year: int, df: pd.DataFrame, through: dt.date) -> None:
        self._frames[year] = (df, through)
        df.to_parquet(self._path(year, "parquet"), index=False)
        with open(self._path(year, "json"), "w", encoding="utf-8") as fh:
            json.dump({"through": through.isoformat(), "pitches": len(df)}, fh)

    def _pull(self, start: dt.date, end: dt.date) -> pd.DataFrame:
        return statfast.mlb_season(start=start, end=end, columns=self.columns, session=self.s)

    def through(self, year: int, date: dt.date) -> pd.DataFrame:
        """The season's pitches with coverage guaranteed through ``date`` (inclusive)."""
        df, have = self._load(year)
        end = min(date, dt.date(year, 12, 31))
        if have is not None and have >= end:
            return df
        start = have + dt.timedelta(days=1) if have else dt.date(year, 1, 1)
        new = self._pull(start, end)
        df = new if df is None else _concat(df, new)
        self._save(year, df, end)
        return df

    def before(self, year: int, date: dt.date) -> pd.DataFrame:
        """The season's pitches from games strictly before ``date``."""
        df = self.through(year, date - dt.timedelta(days=1))
        return df[df["game_date"] < pd.Timestamp(date)]


def _concat(a: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
    """Append, keeping the string columns categorical across differing category sets."""
    cats = [c for c in a.columns if isinstance(a[c].dtype, pd.CategoricalDtype)]
    out = pd.concat([a, b], ignore_index=True)
    for c in cats:
        out[c] = out[c].astype("category")
    return out
