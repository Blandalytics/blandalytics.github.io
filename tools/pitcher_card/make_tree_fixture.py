"""The small models behind tools/live/test/trees.mjs, trained here and packed with the
libraries' outputs on awkward rows into tools/live/test/fixtures/trees.pack.

    python make_tree_fixture.py

Between them they reach every rule the evaluators implement, including those the real models
(check_trees.py) never use. LightGBM: binary with sigmoid 1.5, two categorical features
(one with a category past bit 31) and NaNs both ways; regression with zero_as_missing; the
same with reg_sqrt; cross_entropy; 3-class multiclass; a random forest (average_output).
XGBoost: 3-class multi:softprob and binary:logistic, trained with NaNs so default_left goes
both ways, and pruned hard enough to leave single-leaf trees. Only rerun it to change the
fixture: retraining on another library version gives a different (equally valid) pack.
"""

from __future__ import annotations

import collections
import os

import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb

import model_pack
from check_trees import add_cases, lightgbm_cases, run_parity, xgboost_cases

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "live", "test", "fixtures", "trees.pack")
ROWS = 150  # test rows per model
CATEGORICAL = [2, 4]
LGB_BASE = {"num_leaves": 8, "min_data_in_leaf": 20, "learning_rate": 0.2, "max_cat_to_onehot": 4,
            "min_data_per_group": 20, "cat_smooth": 1.0, "cat_l2": 1.0, "verbose": -1,
            "deterministic": True, "num_threads": 1, "seed": 1}  # fmt: skip
RF = {"boosting": "rf", "bagging_fraction": 0.7, "bagging_freq": 1, "feature_fraction": 0.8}
LGB_MODELS = {  # name: (extra params, label, rounds)
    "binary": ({"objective": "binary", "sigmoid": 1.5}, "binary", 25),
    "regression_zero": ({"objective": "regression", "zero_as_missing": True}, "value", 25),
    "regression_sqrt": ({"objective": "regression", "reg_sqrt": True}, "value", 10),
    "cross_entropy": ({"objective": "cross_entropy"}, "probability", 15),
    "multiclass": ({"objective": "multiclass", "num_class": 3}, "class", 8),
    "random_forest": ({"objective": "regression", **RF}, "value", 10),
    # no split is worth it: one single-leaf tree holding the starting score
    "constant": ({"objective": "binary", "min_gain_to_split": 1e9}, "binary", 3),
}
XGB_FEATURES = ["f0", "f1", "f3"]  # numerical, f1 with NaNs
XGB_MODELS = {"softprob": "class", "logistic": "binary"}


def training_data(rng: np.random.Generator, n: int = 3000) -> tuple[np.ndarray, dict]:
    """Five features -- f0 normal; f1 with 15% NaN; f2 categorical 0-11 with some NaN; f3
    integers either side of a 30% spike of exact zeros (so splits at -/+ kZeroThreshold); f4
    categorical {0, 1, 40} -- and labels for each objective."""
    f1 = np.where(rng.random(n) < 0.15, np.nan, rng.uniform(-2, 2, n))
    f2 = np.where(rng.random(n) < 0.05, np.nan, rng.integers(0, 12, n))
    f3 = np.where(rng.random(n) < 0.3, 0.0, rng.poisson(3, n) - 2.0)
    X = np.column_stack([rng.normal(size=n), f1, f2, f3, rng.choice([0.0, 1.0, 40.0], n)])
    effect = rng.normal(size=12)[np.nan_to_num(f2).astype(int)]
    z = (X[:, 0] + 0.8 * np.nan_to_num(f1, nan=1.5) + effect + 0.6 * np.abs(f3) - (f3 == 0)
         - 1.5 * (X[:, 4] == 40))  # fmt: skip
    noisy = z + rng.logistic(size=n)
    labels = {
        "binary": (noisy > 0.5).astype(int),
        "value": np.abs(z + rng.normal(size=n)),  # non-negative, for reg_sqrt
        "probability": 1 / (1 + np.exp(-z)),
        "class": np.digitize(noisy, np.quantile(noisy, [0.4, 0.75])),
    }
    return X, labels


def lightgbm_models(X: np.ndarray, labels: dict) -> dict[str, str]:
    out = {}
    for name, (params, label, rounds) in LGB_MODELS.items():
        data = lgb.Dataset(X, labels[label], categorical_feature=CATEGORICAL)
        out[f"lgb/{name}"] = lgb.train({**LGB_BASE, **params}, data, rounds).model_to_string()
    return out


def xgboost_models(X: np.ndarray, labels: dict) -> dict[str, xgb.XGBClassifier]:
    frame = pd.DataFrame(X[:, [0, 1, 3]], columns=XGB_FEATURES)
    out = {}
    for name, label in XGB_MODELS.items():
        clf = xgb.XGBClassifier(n_estimators=12, max_depth=3, learning_rate=0.3, gamma=8.0,
                                n_jobs=1, random_state=0)  # fmt: skip
        out[f"xgb/{name}"] = clf.fit(frame, labels[label])
    return out


def coverage(meta: dict, arrays: dict) -> collections.Counter:
    """What the fixture's models exercise, by rule; each must be there."""
    seen = collections.Counter()
    for prefix, m in meta["models"].items():
        a = {k.rsplit("/", 1)[1]: v for k, v in arrays.items() if k.startswith(prefix + "/")}
        seen[f"single-leaf tree ({m['kind']})"] += int((a["tree_root"] < 0).sum())
        if m["kind"] == "lightgbm":
            seen.update(_lgb_coverage(a))
        else:
            seen["xgb default left"] += int(a["default_left"].sum())
            seen["xgb default right"] += int((a["default_left"] == 0).sum())
    missing = [k for k, v in seen.items() if not v]
    if missing:
        raise SystemExit(f"the fixture no longer covers: {missing}")
    return seen


def _lgb_coverage(a: dict) -> collections.Counter:
    dt, b = a["decision_type"], a["cat_boundaries"]
    numerical = (dt & 1) == 0
    missing = (dt >> 2) & 3
    return collections.Counter({
        "lgb categorical": int((~numerical).sum()),
        "lgb multi-word bitset": int((np.diff(b) > 1).sum()),
        "lgb missing none": int((numerical & (missing == 0)).sum()),
        "lgb missing zero": int((numerical & (missing == 1)).sum()),
        "lgb missing NaN, default left": int((numerical & (missing == 2) & ((dt & 2) > 0)).sum()),
        "lgb missing NaN, default right": int((numerical & (missing == 2) & ((dt & 2) == 0)).sum()),
    })  # fmt: skip


def main() -> None:
    rng = np.random.default_rng(7)
    X, labels = training_data(rng)
    arrays, meta = {}, {}
    for prefix, model_str in lightgbm_models(X, labels).items():
        model = model_pack.lightgbm_arrays(model_str)
        model_pack.add_model(arrays, meta, prefix, model)
        add_cases(arrays, meta, lightgbm_cases(prefix, prefix, model_str, model, rng, ROWS))
    for prefix, clf in xgboost_models(X, labels).items():
        model = model_pack.xgboost_arrays(clf.get_booster().save_raw("json"))
        model_pack.add_model(arrays, meta, prefix, model)
        add_cases(arrays, meta, xgboost_cases(prefix, prefix, clf, model, rng, ROWS))
    for rule, count in sorted(coverage(meta, arrays).items()):
        print(f"  {rule:32s} {count}")

    data = model_pack.pack(arrays, meta)
    back, back_meta = model_pack.unpack(data)
    if back_meta != meta or any(not np.array_equal(back[k], v, equal_nan=True)
                                for k, v in arrays.items()):  # fmt: skip
        raise SystemExit("the pack does not read back as written")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as fh:
        fh.write(data)
    print(f"{os.path.relpath(OUT)}: {len(data) / 1e3:.0f} KB")
    raise SystemExit(run_parity(OUT))


if __name__ == "__main__":
    main()
