"""How well the 3D xwOBA model predicts, out of sample: tools/xwoba/evaluation.md.

The model is fit on every season before the test season (by default the latest) and
scored on the test season's batted balls, against

- the league average (no inputs at all),
- the same smoother on fewer inputs (launch angle alone; spray and launch angle;
  launch angle and bat speed), which says what each input adds, and in one pass
  (without the twicing), which says what the second pass adds,
- gradient-boosted trees on the same three inputs (scikit-learn's
  HistGradientBoostingClassifier), a flexible benchmark for the smoother itself, and
- Savant's own xwOBA (estimated_woba_using_speedangle), which reads exit velocity
  rather than bat speed and so knows how squarely the ball was hit -- a ceiling
  rather than a rival.

The same comparisons are made out of fold on the fit seasons (five folds by game),
where calibration is not confounded with how the test season differs from the
others, and season by season. Then hitters: each hitter's mean xwOBA on contact
against their actual wOBA on contact that season, and from the season before the
test season to the test season.

    python tools/xwoba/evaluate.py                 # test on the latest season
    python tools/xwoba/evaluate.py --test 2025
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import savant  # noqa: E402
from build import FOLDS, STRIDES, current_season, load  # noqa: E402
from model import AXES, CLASSES, WEIGHTS, Grid, Params, fit  # noqa: E402

OUT = HERE / "evaluation.md"
MIN_BBE = 100  # batted balls for a hitter-season to count
SAVANT = "estimated_woba_using_speedangle"
AXIS = {a.name: a for a in AXES}
MODEL = "**3D model**"
ONE_PASS = "3D model, one pass (no twicing)"
SAVED = "3D model, saved grid ({}° × {}° × {} mph)".format(*STRIDES)
BOOSTED = "Gradient boosting, same 3 inputs"
BINS = 20  # equal-count bins of xwOBA for the calibration error


# ---- the contenders ------------------------------------------------------------------------
def smoother(train, test, names, params):
    return fit(train, params, tuple(AXIS[n] for n in names)).predict_frame(test)


def boosted(train, test):
    from sklearn.ensemble import HistGradientBoostingClassifier

    def inputs(df):
        return df[list(AXIS)].clip([a.lo for a in AXES], [a.hi for a in AXES], axis=1)

    clf = HistGradientBoostingClassifier(
        max_iter=1000,
        learning_rate=0.05,
        max_leaf_nodes=31,
        min_samples_leaf=200,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=20,
        random_state=0,
    )
    clf.fit(inputs(train), train["outcome"])
    p = np.zeros((len(test), len(CLASSES)))
    p[:, clf.classes_] = clf.predict_proba(inputs(test))
    return p


def contenders(train, test, params, grid: Grid) -> dict:
    """name -> (n, classes) probabilities, or (n,) xwOBA for Savant's."""
    mix = np.bincount(train["outcome"], minlength=len(CLASSES)) / len(train)
    return {
        "League average": np.tile(mix, (len(test), 1)),
        "Launch angle": smoother(train, test, ["launch_angle"], params),
        "Spray + launch angle": smoother(train, test, ["spray", "launch_angle"], params),
        "Launch angle + bat speed": smoother(train, test, ["launch_angle", "bat_speed"], params),
        ONE_PASS: smoother(train, test, list(AXIS), replace(params, twice=False)),
        MODEL: grid.predict_frame(test),
        SAVED: grid.coarsen(STRIDES).predict_frame(test),
        BOOSTED: boosted(train, test),
        "Savant xwOBA (exit velo + launch angle)": test[SAVANT].to_numpy(),
    }


def calibration_error(x: np.ndarray, y: np.ndarray) -> float:
    """Mean |mean xwOBA - mean wOBA| over BINS equal-count bins of xwOBA, by ball (binned
    by rank, so tied predictions still fill every bin)."""
    q = np.argsort(np.argsort(x, kind="stable")) * BINS // len(x)
    g = pd.DataFrame({"q": q, "d": x - y}).groupby("q")["d"]
    return float((g.mean().abs() * g.size()).sum() / len(x))


def noise_floor(y: np.ndarray) -> float:
    """The calibration error a perfect model would still show from the sampling noise of
    the bins' means alone: E|N(0, sd / sqrt(n))| = sqrt(2 / pi) sd / sqrt(n)."""
    return float(np.sqrt(2 / np.pi) * y.std() / np.sqrt(len(y) / BINS))


def metrics(pred, test) -> dict:
    y = test["woba_value"].to_numpy()
    x = pred @ WEIGHTS if pred.ndim == 2 else pred
    mse = float(np.mean((x - y) ** 2))
    out = {"RMSE": mse**0.5, "R²": 1 - mse / float(np.var(y)), "mean": float(x.mean())}
    out["calib. error"] = calibration_error(x, y)
    if pred.ndim == 2:
        hit = pred[np.arange(len(y)), test["outcome"].to_numpy()]
        out["log loss"] = float(-np.log(np.clip(hit, 1e-12, None)).mean())
    return out


# ---- the report ----------------------------------------------------------------------------
def table(rows: list[dict], cols: list[str], fmt: dict) -> str:
    """A markdown table, the first column left-aligned and the rest right; – for a gap."""

    def cell(r, c):
        return fmt.get(c, "{}").format(r[c]) if c in r else "–"

    lines = ["| " + " | ".join(cols) + " |", "|---" + "|--:" * (len(cols) - 1) + "|"]
    lines += ["| " + " | ".join(cell(r, c) for c in cols) + " |" for r in rows]
    return "\n".join(lines) + "\n"


def ball_section(preds, test) -> str:
    rows = [{"model": k, **metrics(v, test)} for k, v in preds.items()]
    fmt = {"RMSE": "{:.4f}", "R²": "{:.4f}", "log loss": "{:.4f}", "calib. error": "{:.4f}"}
    fmt["mean"] = "{:.3f}"
    return table(rows, ["model", "RMSE", "R²", "log loss", "calib. error", "mean"], fmt)


def out_of_fold(df: pd.DataFrame, make) -> np.ndarray:
    """Probabilities for every ball from a model fit without its game's fold."""
    fold = df["game_pk"].to_numpy() % FOLDS
    p = np.zeros((len(df), len(CLASSES)))
    for f in range(FOLDS):
        p[fold == f] = make(df[fold != f], df[fold == f])
    return p


def fold_section(train: pd.DataFrame, params: Params) -> tuple[str, np.ndarray]:
    """The 3D model, one pass of it and gradient boosting, out of fold on the fit seasons;
    and the 3D model's out-of-fold xwOBA."""
    preds = {
        MODEL: out_of_fold(train, lambda a, b: fit(a, params).predict_frame(b)),
        ONE_PASS: out_of_fold(
            train, lambda a, b: fit(a, replace(params, twice=False)).predict_frame(b)
        ),
        BOOSTED: out_of_fold(train, boosted),
    }
    rows = [{"model": k, **metrics(v, train)} for k, v in preds.items()]
    fmt = {"RMSE": "{:.5f}", "log loss": "{:.5f}", "calib. error": "{:.4f}"}
    return table(rows, ["model", "RMSE", "log loss", "calib. error"], fmt), preds[MODEL] @ WEIGHTS


def season_section(df: pd.DataFrame) -> str:
    g = df.groupby("game_year").agg(
        balls=("woba_value", "size"),
        wOBA=("woba_value", "mean"),
        xw=("x3", "mean"),
        savant=(SAVANT, "mean"),
        bat_speed=("bat_speed", "mean"),
    )
    rows = [{"season": str(y), **r} for y, r in g.iterrows()]
    cols = {"xw": "3D xwOBA", "savant": "Savant xwOBA", "bat_speed": "bat speed"}
    rows = [{cols.get(k, k): v for k, v in r.items()} for r in rows]
    fmt = {"wOBA": "{:.3f}", "3D xwOBA": "{:.3f}", "Savant xwOBA": "{:.3f}", "bat speed": "{:.2f}"}
    fmt["balls"] = "{:,.0f}"
    return table(rows, ["season", "balls", "wOBA", "3D xwOBA", "Savant xwOBA", "bat speed"], fmt)


def storage_section(grid: Grid, test: pd.DataFrame) -> str:
    """The saved grid against the full one: how far a ball's xwOBA moves, and the worst
    mean shift of any whole degree of launch angle."""
    full = grid.predict_frame(test) @ WEIGHTS
    rows = []
    for strides in ((2, 2, 2), STRIDES):
        d = grid.coarsen(strides).predict_frame(test) @ WEIGHTS - full
        by_degree = pd.Series(d).groupby(test["launch_angle"].to_numpy()).mean()
        rows.append(
            {
                "grid": "{}° × {}° × {} mph".format(*strides),
                "mean |change|": np.abs(d).mean(),
                "99th pct": np.quantile(np.abs(d), 0.99),
                "worst launch-angle degree": by_degree.abs().max(),
            }
        )
    cols = ["grid", "mean |change|", "99th pct", "worst launch-angle degree"]
    return table(rows, cols, {c: "{:.4f}" for c in cols[1:]})


def calibration(x, test, by: pd.Series, label: str) -> str:
    frame = pd.DataFrame({"by": by, "x": x, "y": test["woba_value"].to_numpy()})
    rows = [
        {label: str(k), "balls": len(v), "xwOBA": v["x"].mean(), "wOBA": v["y"].mean()}
        for k, v in frame.groupby("by", observed=True)
    ]
    return table(rows, [label, "balls", "xwOBA", "wOBA"], {"xwOBA": "{:.3f}", "wOBA": "{:.3f}"})


def outcome_mix(p, test) -> str:
    seen = np.bincount(test["outcome"], minlength=len(CLASSES)) / len(test)
    rows = [
        {"outcome": c, "predicted": p[:, i].mean(), "actual": seen[i]}
        for i, c in enumerate(CLASSES)
    ]
    fmt = {"predicted": "{:.4f}", "actual": "{:.4f}"}
    return table(rows, ["outcome", "predicted", "actual"], fmt)


def hitters(df: pd.DataFrame) -> pd.DataFrame:
    """Per hitter-season with MIN_BBE batted balls: wOBA, the model's (x3) and Savant's xwOBA."""
    g = df.groupby(["batter", "game_year"]).agg(
        bbe=("woba_value", "size"),
        woba=("woba_value", "mean"),
        x3=("x3", "mean"),
        savant=(SAVANT, "mean"),
        bat_speed=("bat_speed", "mean"),
    )
    return g[g["bbe"] >= MIN_BBE].reset_index()


def hitter_section(h: pd.DataFrame, test_season: int) -> str:
    cur = h[h["game_year"] == test_season]
    prev = h[h["game_year"] == test_season - 1]
    pair = prev.merge(cur, on="batter", suffixes=("_0", "_1"))
    names = {"woba": "wOBA on contact", "savant": "Savant xwOBA", "x3": "3D xwOBA"}
    rows = []
    for k, label in names.items():
        rows.append(
            {
                "measure": label,
                f"r with {test_season} wOBA": cur[k].corr(cur["woba"]),
                f"{test_season - 1} → {test_season} wOBA": pair[f"{k}_0"].corr(pair["woba_1"]),
                "year-to-year r": pair[f"{k}_0"].corr(pair[f"{k}_1"]),
                "sd": cur[k].std(),
            }
        )
    cols = [
        "measure",
        f"r with {test_season} wOBA",
        f"{test_season - 1} → {test_season} wOBA",
        "year-to-year r",
        "sd",
    ]
    fmt = {c: "{:.3f}" for c in cols[1:]}
    note = (
        f"{len(cur)} hitters with {MIN_BBE}+ batted balls in {test_season}; {len(pair)} with "
        f"{MIN_BBE}+ in both {test_season - 1} and {test_season}.\n\n"
    )
    return note + table(rows, cols, fmt)


def report(train, test, test_season, params) -> str:
    test = test[test[SAVANT].notna()].reset_index(drop=True)
    grid = fit(train, params)
    preds = contenders(train, test, params, grid)
    p3 = preds[MODEL]
    x3 = p3 @ WEIGHTS
    folds, x_oof = fold_section(train, params)
    bands = pd.cut(
        test["bat_speed"],
        [0, 60, 65, 70, 75, 80, 200],
        right=False,
        labels=["< 60", "60–65", "65–70", "70–75", "75–80", "80+"],
    )
    deciles = pd.qcut(x3, 10, labels=[f"{i + 1}" for i in range(10)])
    # the season before is in the fit, but the hitters' next-season wOBA is not
    prev = train[train["game_year"] == test_season - 1]
    both = pd.concat([prev.assign(x3=grid.predict_frame(prev) @ WEIGHTS), test.assign(x3=x3)])
    every = pd.concat([train.assign(x3=x_oof), test.assign(x3=x3)])
    seasons = sorted(train["game_year"].unique())
    span = f"{seasons[0]}–{seasons[-1]}"
    y_test = test["woba_value"].to_numpy()
    return "\n".join(
        [
            "# 3D xwOBA model: evaluation",
            "",
            f"Fit on {len(train):,} batted balls ({span}, bat tracking only), scored on "
            f"{len(test):,} from {test_season} that the fit never saw (every {test_season} ball "
            "in play with bat speed, launch angle, a landing spot and a Savant xwOBA). "
            f"Parameters: `{params}`. Written by `tools/xwoba/evaluate.py`.",
            "",
            f"## Batted balls, {test_season}",
            "",
            "RMSE of the predicted against the actual wOBA value of each ball; R² against the "
            "test season's own variance; log loss of the five-outcome probabilities; the "
            f"calibration error, the mean gap between predicted and actual wOBA over {BINS} "
            "equal-count bins of the prediction (lower is better for all three; with "
            f"{len(test) // BINS:,} balls in a bin, about {noise_floor(y_test):.3f} of it is "
            "noise); and the mean prediction, against an actual "
            f"{test_season} mean of {y_test.mean():.3f}. Each model's calibration error here "
            f"also holds how {test_season} differs from the seasons it was fit on (see *Season "
            "by season*); the out-of-fold comparison after this one is free of that.",
            "",
            ball_section(preds, test),
            "### The saved grid",
            "",
            "How far a ball's xwOBA moves when it is read off a saved grid rather than the "
            "full 1° × 1° × 1 mph one, and the most any whole degree of launch angle moves on "
            "average. Launch angle is recorded in whole degrees, so a 2° step reads every odd "
            "degree off a line between its neighbours.",
            "",
            storage_section(grid, test),
            f"## Batted balls, out of fold on {span}",
            "",
            "Five folds by game on the fit seasons, each fold predicted by a model fit on the "
            "other four. With the seasons pooled there is no drift between fit and test, so "
            f"the calibration error is the model's own (with {len(train) // BINS:,} balls in a "
            f"bin, about {noise_floor(train['woba_value'].to_numpy()):.3f} of it is noise).",
            "",
            folds,
            "## Season by season",
            "",
            f"Mean predicted against actual wOBA on contact: out of fold for {span}, the "
            f"held-out fit's for {test_season}. Each season is fit with the others, so a "
            "season that hit better or worse than its inputs suggest (the ball, the weather, "
            "how squarely bat met ball) shows as a gap; bat speed is the season's mean on "
            "balls in play.",
            "",
            season_section(every),
            f"## Calibration in {test_season}",
            "",
            "### By deciles of the model's xwOBA",
            "",
            calibration(x3, test, deciles, "decile"),
            "### By bat speed (mph)",
            "",
            calibration(x3, test, bands, "bat speed"),
            "### Outcome mix",
            "",
            outcome_mix(p3, test),
            "## Hitters",
            "",
            "Mean per hitter-season of each measure on contact. *r with wOBA* is descriptive; "
            "the next column is predictive (the season before, against the test season's wOBA on "
            "contact); *year-to-year r* is the measure against itself.",
            "",
            hitter_section(hitters(both), test_season),
        ]
    )


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--test", type=int, default=current_season(), help="the season held out")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)

    df = load(list(range(savant.FIRST_SEASON, a.test + 1)))
    train, test = df[df["game_year"] < a.test], df[df["game_year"] == a.test]
    text = report(train.reset_index(drop=True), test.reset_index(drop=True), a.test, Params())
    Path(a.out).write_text(text)
    print(text)


if __name__ == "__main__":
    main()
