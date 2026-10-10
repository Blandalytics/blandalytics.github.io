"""Fits the three-dimensional xwOBA model and writes it to tools/xwoba/model.json.

Every regular-season ball in play with bat tracking (savant.py) is counted into the
model's grid and smoothed (model.py). With --tune the kernel widths, the prior's
weight and width and the ridge are first chosen by five-fold cross-validation over
games, a parameter at a time, scored on the squared error of the predicted wOBA
value; the chosen values are what model.Params defaults to, so a plain rebuild
reuses them. --cv scores the defaults the same way without tuning, so model.json
records how well they do out of fold.

    python tools/xwoba/build.py --cv                     # every season with bat tracking
    python tools/xwoba/build.py --tune                   # cross-validate the parameters first
    python tools/xwoba/build.py --seasons 2024 2025 --out /tmp/model.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import savant  # noqa: E402
from model import AXES, WEIGHTS, Grid, Params, fit, histogram, smooth  # noqa: E402

OUT = HERE / "model.json"
# The saved grid keeps every other node: 2 degrees of spray and launch angle, 2 mph of
# bat speed. The kernels are wider than that, so reading between nodes loses nothing
# measurable (evaluate.py compares the two).
STRIDE = 2
FOLDS = 5

# What --tune tries for each parameter, one parameter at a time from the defaults.
CANDIDATES = {
    "spray": (1.5, 2.0, 3.0, 4.0, 6.0),
    "launch_angle": (1.0, 1.5, 2.0, 3.0, 4.0),
    "bat_speed": (1.0, 2.0, 3.0, 4.0, 6.0),
    "prior": (2.0, 5.0, 10.0, 25.0, 50.0),
    "widen": (2.0, 3.0, 5.0),
    "ridge": (0.01, 0.1, 0.5),
}


def current_season() -> int:
    return dt.date.today().year


def load(seasons: list[int], verbose: bool = True) -> pd.DataFrame:
    return savant.batted_balls(savant.load_seasons(seasons, verbose=verbose))


# ---- cross-validation ----------------------------------------------------------------------
def scores(grid: Grid, df: pd.DataFrame) -> tuple[float, float]:
    """Summed squared error of the wOBA value and summed log loss of the outcome."""
    p = grid.predict_frame(df)
    err = p @ WEIGHTS - df["woba_value"].to_numpy()
    hit = p[np.arange(len(df)), df["outcome"].to_numpy()]
    return float(err @ err), float(-np.log(np.clip(hit, 1e-12, None)).sum())


class Folds:
    """K folds by game, each held as its histogram, so a parameter set is scored by
    subtraction from the full histogram rather than recounting."""

    def __init__(self, df: pd.DataFrame, k: int = FOLDS, axes=AXES):
        self.axes, self.n = axes, len(df)
        self.total = histogram(df, axes)
        fold = df["game_pk"].to_numpy() % k
        self.parts = [(histogram(df[fold == f], axes), df[fold == f]) for f in range(k)]
        self.seen: dict[Params, tuple[float, float]] = {}

    def score(self, params: Params) -> tuple[float, float]:
        """(mean squared error, mean log loss) out of fold."""
        if params not in self.seen:
            tot = np.zeros(2)
            for hist, test in self.parts:
                tot += scores(Grid(self.axes, smooth(self.total - hist, self.axes, params)), test)
            self.seen[params] = tuple(tot / self.n)
        return self.seen[params]


def tune(folds: Folds, start: Params, rounds: int = 3, verbose: bool = True) -> Params:
    """Coordinate descent over CANDIDATES on the out-of-fold squared error."""
    best = start
    for r in range(rounds):
        before = best
        for name, values in CANDIDATES.items():
            best = min(
                (replace(best, **{name: v}) for v in values), key=lambda p: folds.score(p)[0]
            )
            if verbose:
                mse, ll = folds.score(best)
                print(
                    f"  round {r + 1}, {name}: {getattr(best, name)} (rmse {mse**0.5:.5f}, "
                    f"log loss {ll:.5f})",
                    file=sys.stderr,
                )
        if best == before:
            break
    return best


def choose(df: pd.DataFrame, tuning: bool, scoring: bool, verbose: bool):
    """The parameters to fit with, and their out-of-fold (mse, log loss) if asked for."""
    if not (tuning or scoring):
        return Params(), None
    folds = Folds(df)
    params = tune(folds, Params(), verbose=verbose) if tuning else Params()
    if verbose:
        print(f"parameters: {asdict(params)}", file=sys.stderr)
    return params, folds.score(params)


# ---- the build -------------------------------------------------------------------------------
def build(df: pd.DataFrame, params: Params, cv: tuple[float, float] | None) -> dict:
    grid = fit(df, params).coarsen(STRIDE)
    meta = {
        "model": "xwOBA from spray angle, launch angle and bat speed",
        "built": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "seasons": sorted(int(y) for y in df["game_year"].unique()),
        "from": str(df["game_date"].min().date()),
        "through": str(df["game_date"].max().date()),
        "n": int(len(df)),
        "woba": round(float(df["woba_value"].mean()), 4),
        "cv": {"rmse": round(cv[0] ** 0.5, 5), "log_loss": round(cv[1], 5)} if cv else None,
    }
    return grid.to_json(meta)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--seasons",
        type=int,
        nargs="*",
        help=f"seasons to fit on; default {savant.FIRST_SEASON} to the current one",
    )
    ap.add_argument("--tune", action="store_true", help="cross-validate the parameters first")
    ap.add_argument("--cv", action="store_true", help="score the default parameters out of fold")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    verbose = not a.quiet

    seasons = a.seasons or list(range(savant.FIRST_SEASON, current_season() + 1))
    df = load(seasons, verbose)
    if verbose:
        print(
            f"{len(df)} batted balls, {df['game_date'].min().date()} to "
            f"{df['game_date'].max().date()}",
            file=sys.stderr,
        )
    params, cv = choose(df, a.tune, a.cv, verbose)
    out = build(df, params, cv)
    Path(a.out).write_text(json.dumps(out, separators=(",", ":")))
    if verbose:
        print(f"wrote {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
