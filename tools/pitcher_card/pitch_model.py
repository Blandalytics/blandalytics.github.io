"""Stuff, Locations and Pitching (PLV) for a game, from the pitch-modeling run values.

The scorer (``score_pitches.py``, with its pitch groups and 2026 ABS adjustment), its four
chained logit models, the Level 1 pitch classifier, the run-value tables and the plus scale
are the Blandalytics/pitch-modeling repo, published to the bucket under ``pitch-modeling/``;
they are downloaded once and cached beside the data files.
``score_pitches.score`` gives per-pitch run values in runs per pitch from the pitcher's side
(+ = good for the pitcher):

    stuff_rv      count-neutral Stuff: league location mix, averaged over the count mix
    location_rv   what the pitch's actual location added, at its actual count
    pitching_rv   the pitch's actual location and count -- the card's PLV

``plus`` turns a unit's mean into the card's 100 +/- 15 number, against the mean and SD
of every 2020-26 pitcher-game (or pitcher-game-pitch-type) in ``plus_scale_constants``
(weighted by pitches x 0.9 ** (2026 - season)). 2026 games are scored with the scorer's ABS
adjustment (``abs_2026``), as the scale was.
"""

from __future__ import annotations

import json
import os
import sys
import time

import pandas as pd
import requests

import fetch

MODELS_URL = f"{fetch.DATA_URL}/pitch-modeling"
SCORER = "score_pitches.py"  # imported from the cache once it is there
SOURCES = ("pitch_groups.py", "pitch_l1.py", "abs_2026.py")  # the scorer imports these
CHAIN = ("swing_take", "take_outcome", "swing_outcome", "in_play")
TABLES = ("run_values.csv", "run_values_by_count.csv", "count_mix.json")
SCALE = "plus_scale_constants.json"
ABS = "abs_2026.json"  # 2026 reference zones and recalibrated stages
ARTIFACTS = (
    SCORER,
    *SOURCES,
    *(f"models/{n}_logit_2325.pkl" for n in CHAIN),
    "models/pitch_l1_v1.npz",  # the Level 1 pitch classifier behind the pitch groups
    *(f"constants/{t}" for t in (*TABLES, SCALE, ABS)),
)
# the two aggregations the card grades on (the scale also carries pitcher-season ones)
GAME, TYPE = "pitcher_game", "pitcher_game_pitch_type"
# a pitch is keyed by these across the scorer's frame and the card's
KEYS = ("game_pk", "at_bat_index", "pitch_number")
VALUES = ("stuff_rv", "location_rv", "pitching_rv")
# the card's column for each value, at the aggregation its scale comes from: the three
# grades are a whole outing, the two table columns one pitch type of one
GRADES = (
    ("plvStuff+", "stuff_rv", TYPE),
    ("PLV+", "pitching_rv", TYPE),
    ("stuffGrade_game", "stuff_rv", GAME),
    ("locGrade_game", "location_rv", GAME),
    ("plvGrade_game", "pitching_rv", GAME),
)
GRADE_COLUMNS = tuple(name for name, _, _ in GRADES)


def empty() -> pd.DataFrame:
    """No scored pitches, shaped so a reindex of it yields blanks."""
    index = pd.MultiIndex.from_arrays([[]] * len(KEYS), names=list(KEYS))
    return pd.DataFrame({c: pd.Series(dtype="float64") for c in VALUES}, index=index)


class PitchModel:
    """The scorer, its artifacts cached under ``cache_dir/pitch-modeling``."""

    def __init__(self, cache_dir: str, session: requests.Session):
        self.dir = os.path.join(cache_dir, "pitch-modeling")
        self.s = session
        self._ready = False
        self._parts: tuple | None = None

    # -- the artifacts --
    def _fetch(self, name: str) -> None:
        """Download one artifact unless the cached copy is already that size."""
        path = os.path.join(self.dir, name)
        # past the CDN's 4-hour edge cache, so a new publish reaches the card at once
        fresh = {"v": int(time.time() // 60)}
        head = self.s.head(f"{MODELS_URL}/{name}", params=fresh, timeout=60, allow_redirects=True)
        head.raise_for_status()
        size = int(head.headers.get("content-length", -1))
        if os.path.exists(path) and os.path.getsize(path) == size:
            return
        r = self.s.get(f"{MODELS_URL}/{name}", params=fresh, timeout=600)
        r.raise_for_status()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(r.content)
        print(f"  pitch model {name}: {len(r.content) / 1e6:.1f} MB", file=sys.stderr)

    def ensure(self) -> None:
        if self._ready:
            return
        for name in ARTIFACTS:
            self._fetch(name)
        if self.dir not in sys.path:
            sys.path.insert(0, self.dir)
        self._ready = True

    def _load(self):
        """(score_pitches, models, count mix, run values, run values by count, ABS env,
        scale), loaded once."""
        if self._parts is None:
            self.ensure()
            import abs_2026
            import score_pitches as sp

            models = sp.load_models(sp.Path(self.dir, "models"))
            mix, values, by_count = sp.load_constants(sp.Path(self.dir, "constants"))
            env = abs_2026.load(sp.Path(self.dir, "constants", ABS))
            with open(os.path.join(self.dir, "constants", SCALE), encoding="utf-8") as fh:
                scale = json.load(fh)
            self._parts = (sp, models, mix, values, by_count, env, scale)
        return self._parts

    # -- scoring --
    @staticmethod
    def _plain(raw: pd.DataFrame) -> pd.DataFrame:
        """The string columns as plain objects rather than categoricals.

        The scorer compares two of them to each other -- p_throws against stand, for the
        platoon flag -- and pandas refuses that when the two carry different categories.
        The scraper builds each column's categories from the values it actually saw, so
        an outing that has faced only left-handers has ``stand=['L']`` against
        ``p_throws=['R']`` and the comparison raises. It settles once a game has seen
        both, which is why this only ever bit the first innings of a live build."""
        cats = [c for c in raw.columns if isinstance(raw[c].dtype, pd.CategoricalDtype)]
        return raw.astype(dict.fromkeys(cats, "object")) if cats else raw

    def score(self, raw: pd.DataFrame) -> pd.DataFrame:
        """Per-pitch run values for a whole game's statfast pitches, keyed by KEYS.

        Pass whole outings: the scorer reads each pitcher's arsenal off the pitches it is
        given to decide which fastball is primary. Pitches it does not model (pitchouts,
        automatic balls, types outside the modeled groups, anything missing tracking) are
        simply absent from the result. One game is small, so it is scored in-process."""
        sp, models, mix, values, by_count, env, _ = self._load()
        try:
            pitches, _dropped = sp.score(self._plain(raw), models, mix, values, by_count,
                                         env=env, workers=1)  # fmt: skip
        except ValueError:
            # nothing here the models cover -- a position player's eephus, say; the card
            # shows dashes
            return empty()
        if pitches.empty:
            return empty()
        return pitches[[*KEYS, *VALUES]].set_index(list(KEYS))

    # -- the card's numbers --
    def columns(self, values: pd.DataFrame) -> pd.DataFrame:
        """The card's five model columns from the per-pitch run values. The conversion is
        affine, so a pitch type's mean of these is that pitch type's number."""
        out = pd.DataFrame(index=values.index)
        for name, column, level in GRADES:
            out[name] = self.plus_series(values[column], column, level)
        return out

    def plus_series(self, rv: pd.Series, column: str, level: str) -> pd.Series:
        scale = self._load()[-1]
        plus, stat = scale["plus"], scale["aggregations"][level]["columns"][column]
        return plus["mean"] + plus["sd"] * (100 * rv - stat["mean"]) / stat["sd"]

    def plus(self, mean_rv: float | None, column: str, level: str = GAME) -> float | None:
        """A unit's mean per-pitch value as the card's 100 +/- 15 number."""
        if mean_rv is None or mean_rv != mean_rv:
            return None
        scale = self._load()[-1]
        plus, stat = scale["plus"], scale["aggregations"][level]["columns"][column]
        return plus["mean"] + plus["sd"] * (100 * mean_rv - stat["mean"]) / stat["sd"]
