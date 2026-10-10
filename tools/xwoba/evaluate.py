"""How well the 3D xwOBA model predicts, out of sample: tools/xwoba/evaluation.md.

The model is fit on every season before the test season (by default the latest) and
scored on the test season's batted balls, against

- the league average (no inputs at all),
- the same smoother on fewer inputs (launch angle alone; spray and launch angle;
  launch angle and bat speed), which says what each input adds,
- gradient-boosted trees on the same three inputs (scikit-learn's
  HistGradientBoostingClassifier), a flexible benchmark for the smoother itself, and
- Savant's own xwOBA (estimated_woba_using_speedangle), which reads exit velocity
  rather than bat speed and so knows how squarely the ball was hit -- a ceiling
  rather than a rival.

Then hitters: each hitter's mean xwOBA on contact against their actual wOBA on
contact that season, and from the season before the test season to the test season.

    python tools/xwoba/evaluate.py                 # test on the latest season
    python tools/xwoba/evaluate.py --test 2025
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import savant  # noqa: E402
from build import STRIDE, current_season, load  # noqa: E402
from model import AXES, CLASSES, WEIGHTS, Grid, Params, fit  # noqa: E402

OUT = HERE / "evaluation.md"
MIN_BBE = 100  # batted balls for a hitter-season to count
SAVANT = "estimated_woba_using_speedangle"
AXIS = {a.name: a for a in AXES}
MODEL = "**3D model**"
SAVED = f"3D model, saved grid ({STRIDE}° × {STRIDE}° × {STRIDE} mph)"


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
        MODEL: grid.predict_frame(test),
        SAVED: grid.coarsen(STRIDE).predict_frame(test),
        "Gradient boosting, same 3 inputs": boosted(train, test),
        "Savant xwOBA (exit velo + launch angle)": test[SAVANT].to_numpy(),
    }


def metrics(pred, test) -> dict:
    y = test["woba_value"].to_numpy()
    x = pred @ WEIGHTS if pred.ndim == 2 else pred
    mse = float(np.mean((x - y) ** 2))
    out = {"RMSE": mse**0.5, "R²": 1 - mse / float(np.var(y)), "mean": float(x.mean())}
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
    fmt = {"RMSE": "{:.4f}", "R²": "{:.4f}", "log loss": "{:.4f}", "mean": "{:.3f}"}
    return table(rows, ["model", "RMSE", "R²", "log loss", "mean"], fmt)


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
    seasons = sorted(train["game_year"].unique())
    return "\n".join(
        [
            "# 3D xwOBA model: evaluation",
            "",
            f"Fit on {len(train):,} batted balls ({seasons[0]}–{seasons[-1]}, bat tracking "
            f"only), scored on {len(test):,} from {test_season} that the fit never saw (every "
            f"{test_season} ball in play with bat speed, launch angle, a landing spot and a "
            f"Savant xwOBA). Parameters: `{params}`. Written by `tools/xwoba/evaluate.py`.",
            "",
            "## Batted balls",
            "",
            "RMSE of the predicted against the actual wOBA value of each ball; R² against the "
            "test season's own variance; log loss of the five-outcome probabilities (lower is "
            f"better); the mean prediction, against an actual {test_season} mean of "
            f"{test['woba_value'].mean():.3f} (the league average row is the fit seasons' mean).",
            "",
            ball_section(preds, test),
            "### Calibration, by deciles of the model's xwOBA",
            "",
            calibration(x3, test, deciles, "decile"),
            "### Calibration, by bat speed (mph)",
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
