"""The Worker's tree evaluators against LightGBM and XGBoost themselves, on the real models.

    python check_trees.py --models ../pitch-modeling/models \\
        --xslg ../player_cards/2026_pl_xSLG_model.json --out /tmp/trees [--bench "Fastball vs Same"]

Packs every LightGBM model in the four pitch-modeling pickles -- each group's boosters,
loc_models and r_models -- and the xSLG model into <out>/models.pack, as the Worker would get
them (model_pack.py); scores awkward rows with the libraries into <out>/cases.pack; and runs
tools/live/test/parity.mjs on the two, which prints the largest error per model kind and fails
past the tolerances. Also prints the pack's size and the trees one pitch goes through.

The rows: uniform over each feature's training range (LightGBM's feature_infos; for XGBoost
the range of its splits) and a little past it; split thresholds exactly, an ulp either side
and rounded to float32; NaN, zeros, -0, values under LightGBM's kZeroThreshold, infinities;
for a categorical feature unseen, negative, fractional and huge categories. Each model is
scored on float64 rows and on the same rows in float32, which is what score_pitches.py passes.

A dev check -- the models are big and live in other repos. tools/live/test/trees.mjs is the
small permanent one, on the models make_tree_fixture.py trains.
"""

from __future__ import annotations

import argparse
import collections
import gzip
import os
import pickle
import subprocess
from collections.abc import Iterator

import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb

import model_pack

HERE = os.path.dirname(os.path.abspath(__file__))
PARITY = os.path.join(HERE, "..", "live", "test", "parity.mjs")
CHAIN = ("swing_take", "take_outcome", "swing_outcome", "in_play")
KINDS = ("boosters", "loc_models", "r_models")
# categories LightGBM never saw, or cannot read as one: negative, fractional, past a bitset
# word, past 2^31 (2^32 + 1 would wrap to 1 in a careless int conversion), infinite, missing
ODD_CATEGORIES = np.array([-1, -2, -0.5, 0.5, 1.5, 7, 31, 32, 33, 64, 1000, 2.0**31, 3e9,
                           2.0**32, 2.0**32 + 1, -3e9, np.inf, -np.inf, np.nan])  # fmt: skip
# LightGBM reads |x| <= kZeroThreshold (1e-35f) as 0, and splits near zero at +/- it
K_ZERO = float(np.float32(1e-35))
LGB_SPECIALS = np.array([np.nan, np.nan, 0.0, -0.0, 1e-36, -1e-36, 1e-40, K_ZERO, -K_ZERO,
                         np.inf, -np.inf])  # fmt: skip
XGB_SPECIALS = np.array([np.nan, np.nan, 0.0, -0.0])
EXACT = {"abs": 0.0, "rel": 0.0}  # LightGBM raw scores, XGBoost margins: bit for bit
PROBABILITY = {"abs": 0.0, "rel": 1e-14}  # LightGBM predict: its exp() against V8's
FLOAT32_PROBABILITY = {"abs": 1e-6, "rel": 0.0}  # XGBoost: expf against Math.exp, in float32


# ---- rows -------------------------------------------------------------------------------
def lightgbm_rows(model: model_pack.Model, rng: np.random.Generator, n: int) -> np.ndarray:
    arrays, meta = model
    cols = [_lgb_column(info, _splits(arrays, j), rng, n)
            for j, info in enumerate(meta["feature_infos"])]  # fmt: skip
    return _sprinkle(np.column_stack(cols), rng, LGB_SPECIALS)


def xgboost_rows(model: model_pack.Model, rng: np.random.Generator, n: int) -> np.ndarray:
    arrays, meta = model
    cols = [_split_column(_splits(arrays, j), rng, n) for j in range(meta["num_features"])]
    return _sprinkle(np.column_stack(cols), rng, XGB_SPECIALS)


def _splits(arrays: dict[str, np.ndarray], j: int) -> np.ndarray:
    """Numerical thresholds on feature j."""
    on = arrays["split_feature"] == j
    if "decision_type" in arrays:
        on &= (arrays["decision_type"] & 1) == 0
    return arrays["threshold"][on].astype(np.float64)


def _lgb_column(info: str, splits: np.ndarray, rng: np.random.Generator, n: int) -> np.ndarray:
    """feature_infos: "[lo:hi]" numerical, "none" unused, else the categories seen."""
    if info.startswith("["):
        lo, hi = (float(v) for v in info[1:-1].split(":"))
        return _near_splits(_uniform(lo, hi, rng, n), splits, rng)
    if info == "none":
        return rng.normal(0, 3, n)
    seen = rng.choice(np.array(info.split(":"), float), n)
    return np.where(rng.random(n) < 0.3, rng.choice(ODD_CATEGORIES, n), seen)


def _split_column(splits: np.ndarray, rng: np.random.Generator, n: int) -> np.ndarray:
    lo, hi = (splits.min(), splits.max()) if len(splits) else (-1.0, 1.0)
    return _near_splits(_uniform(lo, hi, rng, n), splits, rng)


def _uniform(lo: float, hi: float, rng: np.random.Generator, n: int) -> np.ndarray:
    pad = 0.1 * (hi - lo) or 1.0
    return rng.uniform(lo - pad, hi + pad, n)


def _near_splits(col: np.ndarray, splits: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """About a third of the values moved onto a threshold: exactly, an ulp either side, or
    rounded to float32 and a float32 ulp either side of that."""
    if not len(splits):
        return col
    t = rng.choice(splits, len(col))
    t32 = t.astype(np.float32)
    up, down = np.float32(np.inf), np.float32(-np.inf)
    options = np.stack([t, np.nextafter(t, -np.inf), np.nextafter(t, np.inf), t32,
                        np.nextafter(t32, down), np.nextafter(t32, up)])  # fmt: skip
    near = options[rng.integers(0, len(options), len(col)), np.arange(len(col))]
    return np.where(rng.random(len(col)) < 0.35, near, col)


def _sprinkle(X: np.ndarray, rng: np.random.Generator, specials: np.ndarray) -> np.ndarray:
    """Special values over 8% of the cells; row 0 all missing, row 1 all zero."""
    hit = rng.random(X.shape) < 0.08
    X[hit] = rng.choice(specials, X.shape)[hit]
    X[0], X[1] = np.nan, 0.0
    return X


# ---- cases ------------------------------------------------------------------------------
Cases = tuple[dict[str, np.ndarray], list[dict]]  # arrays, and meta["tests"] entries


def lightgbm_cases(prefix: str, kind: str, model_str: str, model: model_pack.Model,
                   rng: np.random.Generator, n: int) -> Cases:  # fmt: skip
    """Raw scores of float64 and float32 rows, and predict() of the float32 ones."""
    booster = lgb.Booster(model_str=model_str)
    x64 = lightgbm_rows(model, rng, n)
    x32 = x64.astype(np.float32)
    arrays = {
        "x64": x64,
        "x32": x32,
        "raw64": booster.predict(x64, raw_score=True),
        "raw32": booster.predict(x32, raw_score=True),
        "predict32": booster.predict(x32),
    }
    tests = [("raw", "x64", "raw64", EXACT), ("raw", "x32", "raw32", EXACT),
             ("predict", "x32", "predict32", PROBABILITY)]  # fmt: skip
    return _cases(prefix, kind, arrays, tests)


def xgboost_cases(prefix: str, kind: str, clf: xgb.XGBClassifier, model: model_pack.Model,
                  rng: np.random.Generator, n: int) -> Cases:  # fmt: skip
    """The margin and predict_proba of float64 rows (XGBoost reads them as float32), and
    predict_proba of the same rows in float32."""
    x64 = xgboost_rows(model, rng, n)
    x32 = x64.astype(np.float32)
    frame = pd.DataFrame(x64, columns=model[1]["feature_names"] or None)
    proba = clf.predict_proba(frame)
    arrays = {
        "x64": x64,
        "x32": x32,
        "margin": clf.get_booster().predict(xgb.DMatrix(frame), output_margin=True),
        "proba": proba,
    }
    tests = [("margin", "x64", "margin", EXACT), ("proba", "x64", "proba", FLOAT32_PROBABILITY),
             ("proba", "x32", "proba", FLOAT32_PROBABILITY)]  # fmt: skip
    return _cases(prefix, kind, arrays, tests)


def _cases(prefix: str, kind: str, arrays: dict, tests: list) -> Cases:
    """Arrays under cases/<prefix>/ (outputs as rows x outputs), and the tests over them."""
    n = len(arrays["x64"])
    named = {f"cases/{prefix}/{k}": v if k.startswith("x") else np.reshape(v, (n, -1))
             for k, v in arrays.items()}  # fmt: skip
    at = f"cases/{prefix}/"
    entries = [{"model": prefix, "kind": kind, "fn": fn, "x": at + x, "expect": at + e, "tol": tol}
               for fn, x, e, tol in tests]  # fmt: skip
    return named, entries


def add_cases(arrays: dict, meta: dict, cases: Cases) -> None:
    arrays.update(cases[0])
    meta.setdefault("tests", []).extend(cases[1])


def run_parity(*args: str) -> int:
    """tools/live/test/parity.mjs on the given packs (and flags); its exit code."""
    return subprocess.run(["node", "--expose-gc", PARITY, *args], check=False).returncode


# ---- the real models --------------------------------------------------------------------
def pitch_models(models_dir: str) -> Iterator[tuple[str, str, str, int, str]]:
    """(chain model, group, kind, index, LightGBM model text) for every model in the pickles."""
    for chain in CHAIN:
        with open(os.path.join(models_dir, f"{chain}_logit_2325.pkl"), "rb") as fh:
            blob = pickle.load(fh)
        for group, gm in blob["groups"].items():
            for kind in KINDS:
                for i, model_str in enumerate(gm[kind]):
                    yield chain, group, kind, i, model_str


def build(args: argparse.Namespace) -> tuple[bytes, bytes, dict]:
    """(models pack, cases pack, trees per (group, kind) a pitch goes through)."""
    rng = np.random.default_rng(args.seed)
    models, models_meta, cases, cases_meta = {}, {}, {}, {}
    trees = collections.Counter()
    for chain, group, kind, i, model_str in pitch_models(args.models):
        prefix = f"{chain}/{group}/{kind}/{i}"
        model = model_pack.lightgbm_arrays(model_str)
        model_pack.add_model(models, models_meta, prefix, model)
        add_cases(cases, cases_meta, lightgbm_cases(prefix, kind[:-1], model_str, model, rng,
                                                    args.rows))  # fmt: skip
        trees[group, kind] += model[1]["num_trees"]
    with open(args.xslg, "rb") as fh:
        raw = fh.read()
    clf = xgb.XGBClassifier()
    clf.load_model(bytearray(raw))
    model = model_pack.xgboost_arrays(raw)
    model_pack.add_model(models, models_meta, "xslg", model)
    add_cases(cases, cases_meta, xgboost_cases("xslg", "xslg", clf, model, rng, args.rows))
    return model_pack.pack(models, models_meta), model_pack.pack(cases, cases_meta), trees


def report_trees(trees: dict) -> None:
    print("trees per pitch (every chain model's boosters, loc_models and r_models of its group):")
    for group in dict.fromkeys(g for g, _ in trees):
        counts = {kind: trees[group, kind] for kind in KINDS}
        print(f"  {group:28s} {sum(counts.values()):5d}  " + "  ".join(
            f"{k} {v}" for k, v in counts.items()))  # fmt: skip


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--models", required=True, help="pitch-modeling's models/ folder")
    ap.add_argument("--xslg", required=True, help="player_cards' *_pl_xSLG_model.json")
    ap.add_argument("--out", required=True, help="folder for models.pack and cases.pack")
    ap.add_argument("--rows", type=int, default=1000, help="test rows per model")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--bench", help="also time the models whose prefix contains this")
    args = ap.parse_args()

    models, cases, trees = build(args)
    os.makedirs(args.out, exist_ok=True)
    paths = [os.path.join(args.out, n) for n in ("models.pack", "cases.pack")]
    for path, data in zip(paths, (models, cases), strict=True):
        with open(path, "wb") as fh:
            fh.write(data)
    print(f"models.pack {len(models) / 1e6:.2f} MB ({len(gzip.compress(models)) / 1e6:.2f} MB "
          f"gzipped), cases.pack {len(cases) / 1e6:.1f} MB")  # fmt: skip
    report_trees(trees)
    raise SystemExit(run_parity(*paths, *(["--bench", args.bench] if args.bench else [])))


if __name__ == "__main__":
    main()
