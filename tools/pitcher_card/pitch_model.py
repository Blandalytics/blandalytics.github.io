"""Stuff, Locations and Pitching (PLV) for a game, from the pitch-modeling run values.

The four chained logit models, their run-value tables and the plus scale live in the
bucket under ``pitch-modeling/``; they are downloaded once and cached beside the data
files. Scoring is that project's own: ``combine.score_pitches`` and ``add_run_values``,
selected through ``pitch_values.values``, which give per-pitch run values in runs per
pitch from the pitcher's side (+ = good for the pitcher):

    stuff_rv      count-neutral Stuff: league location mix, averaged over the count mix
    location_rv   what the pitch's actual location added, at its actual count
    pitching_rv   the pitch's actual location and count -- the card's PLV

``plus`` turns a unit's mean into the card's 100 +/- 15 number, against the mean and SD
of every 2023-26 pitcher-game (or pitcher-game-pitch-type) in ``game_scale``.
"""

from __future__ import annotations

import json
import os
import sys

import pandas as pd
import requests

import fetch

MODELS_URL = f"{fetch.DATA_URL}/pitch-modeling"
# the scorer's own modules, imported from the cache once they are there
SOURCES = ("combine.py", "dml_stuff_swing.py", "leaderboard.py", "pitch_values.py")
CHAIN = ("swing_take", "take_outcome", "swing_outcome", "in_play")
TABLES = ("run_values.csv", "run_values_by_count.csv", "count_mix.json")
SCALE = "game_scale_2023_2026.json"
ARTIFACTS = (
    *SOURCES,
    *(f"output/{n}_logit_2325.pkl" for n in CHAIN),
    *(f"output/{t}" for t in TABLES),
    f"output/{SCALE}",
)
# the two aggregations the scale carries, and what each grades on the card
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
        head = self.s.head(f"{MODELS_URL}/{name}", timeout=60, allow_redirects=True)
        head.raise_for_status()
        size = int(head.headers.get("content-length", -1))
        if os.path.exists(path) and os.path.getsize(path) == size:
            return
        r = self.s.get(f"{MODELS_URL}/{name}", timeout=600)
        r.raise_for_status()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(r.content)
        print(f"  pitch model {name}: {len(r.content) / 1e6:.1f} MB", file=sys.stderr)

    def ensure(self) -> None:
        if self._ready:
            return
        os.makedirs(os.path.join(self.dir, "output"), exist_ok=True)
        for name in ARTIFACTS:
            self._fetch(name)
        if self.dir not in sys.path:  # combine.py imports its siblings by bare name
            sys.path.insert(0, self.dir)
        self._ready = True

    def _load(self):
        """(combine, pitch_values, models, count mix, run values, scale), loaded once."""
        if self._parts is None:
            self.ensure()
            import combine as cb
            import dml_stuff_swing as m
            import pitch_values as pv

            here = os.path.join(self.dir, "output")
            models = [m.load_model(os.path.join(here, f"{n}_logit_2325.pkl")) for n in CHAIN]
            mix = cb.league_count_mix(os.path.join(here, "count_mix.json"))
            values = cb.load_run_values(*(os.path.join(here, t) for t in TABLES[:2]))
            with open(os.path.join(here, SCALE), encoding="utf-8") as fh:
                scale = json.load(fh)
            self._parts = (cb, pv, models, mix, values, scale)
        return self._parts

    # -- scoring --
    def score(self, raw: pd.DataFrame) -> pd.DataFrame:
        """Per-pitch run values for a whole game's statfast pitches, keyed by KEYS.

        Pass whole outings: the scorer reads each pitcher's arsenal off the pitches it is
        given to decide which fastball is primary. Pitches it does not model (pitchouts,
        automatic balls, types outside the modeled groups, anything missing tracking) are
        simply absent from the result."""
        cb, pv, models, mix, values, _ = self._load()
        try:
            pitches, _scores = cb.score_pitches(models, raw, mix, 1)
        except ValueError:
            # nothing here the models cover -- a position player's eephus, say. The
            # scorer has no frame to concatenate; the card shows dashes.
            return empty()
        scored = cb.add_run_values(pitches, *values)
        out = pv.values(scored, parts=False, probs=False)
        return out[[*KEYS, *VALUES]].set_index(list(KEYS))

    # -- the card's numbers --
    def columns(self, values: pd.DataFrame) -> pd.DataFrame:
        """The card's five model columns from the per-pitch run values. The conversion is
        affine, so a pitch type's mean of these is that pitch type's number."""
        out = pd.DataFrame(index=values.index)
        for name, column, level in GRADES:
            out[name] = self.plus_series(values[column], column, level)
        return out

    def plus_series(self, rv: pd.Series, column: str, level: str) -> pd.Series:
        scale = self._load()[5]
        plus, stat = scale["plus"], scale["aggregations"][level]["columns"][column]
        return plus["mean"] + plus["sd"] * (100 * rv - stat["mean"]) / stat["sd"]

    def plus(self, mean_rv: float | None, column: str, level: str = GAME) -> float | None:
        """A unit's mean per-pitch value as the card's 100 +/- 15 number."""
        if mean_rv is None or mean_rv != mean_rv:
            return None
        scale = self._load()[5]
        plus, stat = scale["plus"], scale["aggregations"][level]["columns"][column]
        return plus["mean"] + plus["sd"] * (100 * mean_rv - stat["mean"]) / stat["sd"]
