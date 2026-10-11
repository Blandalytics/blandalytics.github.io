"""Tree models and other arrays packed into one binary file for the live Worker.

The Worker in tools/live scores pitches with the same LightGBM and XGBoost models as the
Python pipeline but can run neither library, so this flattens each model into a few typed
arrays and packs any number of them, beside any other arrays, into one file the Worker
fetches from R2 and reads without parsing or copying (tools/live/src/cards/pack.js). The
evaluators are tools/live/src/cards/trees.js; check_trees.py holds them to the libraries.

File layout, little-endian throughout::

    b"PCK1" | uint32 header length | header: UTF-8 JSON, space-padded | array data

    header = {"arrays": {name: {"dtype", "shape", "offset", "length"}}, "meta": {...}}

``offset`` counts bytes from the start of the array data (byte 8 + header length, a multiple
of 8) and is itself a multiple of 8, so every array is a zero-copy typed-array view;
``length`` counts elements. dtypes: float32, float64, int8, uint8, int16, uint16, int32,
uint32.

A model goes in under a name prefix (``add_model``): its arrays as ``<prefix>/<name>``, its
meta as ``meta["models"][<prefix>]``. Both libraries share one node layout:

    tree_root      int32    per tree: its root node, or ~leaf for a single-leaf tree
    tree_class     uint8    per tree: the output (class) its leaf adds to
    split_feature  uint16   per split node: the feature (int32 past 65535 features)
    threshold      float64 (LightGBM) / float32 (XGBoost), per split node; a categorical
                   LightGBM node holds its index into cat_boundaries instead
    left_child     int32    per split node: the next split node, or ~leaf for a leaf
    right_child    int32
    leaf_value     float64 (LightGBM) / float32 (XGBoost), per leaf

Node and leaf indices run across all of a model's trees, so a walk never adds offsets.
LightGBM adds ``decision_type`` (uint8, its own bits: 1 categorical, 2 default left, 4 * the
missing type, 0 none / 1 zero / 2 NaN), ``cat_boundaries`` (int32, one more than the model's
categorical splits: split i's bitset is ``cat_threshold[b[i]:b[i + 1]]``) and
``cat_threshold`` (uint32 bitset words); XGBoost adds ``default_left`` (uint8).
"""

from __future__ import annotations

import copy
import json
import re
import struct

import numpy as np

MAGIC = b"PCK1"
ALIGN = 8
DTYPES = ("float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32")

Model = tuple[dict[str, np.ndarray], dict]  # a model's arrays and its meta


# ---- the pack ---------------------------------------------------------------------------
def pack(arrays: dict[str, np.ndarray], meta: dict | None = None) -> bytes:
    """Named arrays and a JSON-able ``meta`` as one pack."""
    entries, chunks, pos = {}, [], 0
    for name, arr in arrays.items():
        a = _little(arr, name)
        entries[name] = {"dtype": a.dtype.name, "shape": list(a.shape), "offset": pos,
                         "length": a.size}  # fmt: skip
        data = a.tobytes()
        chunks.append(data + bytes(-len(data) % ALIGN))
        pos += len(chunks[-1])
    header = {"arrays": entries, "meta": meta or {}}
    head = json.dumps(header, separators=(",", ":"), allow_nan=False).encode()
    head += b" " * (-len(head) % ALIGN)  # so the data after the 8-byte preamble is aligned
    return b"".join([MAGIC, struct.pack("<I", len(head)), head, *chunks])


def unpack(data: bytes) -> Model:
    """A pack's arrays (read-only views into ``data``) and its meta."""
    buf = memoryview(data)
    if bytes(buf[:4]) != MAGIC:
        raise ValueError("not a PCK1 pack")
    (size,) = struct.unpack_from("<I", buf, 4)
    header = json.loads(bytes(buf[8 : 8 + size]))
    base = 8 + size
    arrays = {name: _view(buf, base, e) for name, e in header["arrays"].items()}
    return arrays, header["meta"]


def add_model(arrays: dict[str, np.ndarray], meta: dict, prefix: str, model: Model) -> None:
    """Put one model's arrays in under ``<prefix>/`` and its meta at
    ``meta["models"][prefix]``, for ``pack``."""
    model_arrays, model_meta = model
    for name, arr in model_arrays.items():
        arrays[f"{prefix}/{name}"] = arr
    meta.setdefault("models", {})[prefix] = model_meta


def _little(arr: np.ndarray, name: str) -> np.ndarray:
    a = np.ascontiguousarray(arr)
    if a.dtype.name not in DTYPES:
        raise TypeError(f"{name}: unsupported dtype {a.dtype}")
    return a.astype(a.dtype.newbyteorder("<"), copy=False)


def _view(buf: memoryview, base: int, entry: dict) -> np.ndarray:
    dtype = np.dtype(entry["dtype"]).newbyteorder("<")
    if not entry["length"]:
        return np.empty(entry["shape"], dtype)
    flat = np.frombuffer(buf, dtype, entry["length"], base + entry["offset"])
    return flat.reshape(entry["shape"])


# ---- both libraries ---------------------------------------------------------------------
def _join_trees(trees: list[dict[str, np.ndarray]], fields: tuple[str, ...]) -> dict:
    """Per-tree arrays (child indices local: a node, or ~leaf) as model-wide ones."""
    if not trees:
        raise ValueError("a model needs at least one tree")
    nodes = [len(t["left_child"]) for t in trees]
    leaves = [len(t["leaf_value"]) for t in trees]
    node0 = np.cumsum([0, *nodes[:-1]])
    leaf0 = np.cumsum([0, *leaves[:-1]])
    out = {f: np.concatenate([t[f] for t in trees]) for f in (*fields, "leaf_value")}
    for side in ("left_child", "right_child"):
        parts = [_globalize(t[side], a, b) for t, a, b in zip(trees, node0, leaf0, strict=True)]
        out[side] = np.concatenate(parts).astype(np.int32)
    roots = [a if n else ~b for n, a, b in zip(nodes, node0, leaf0, strict=True)]
    out["tree_root"] = np.array(roots, np.int32)
    out["split_feature"] = out["split_feature"].astype(_index_dtype(out["split_feature"]))
    return out


def _globalize(child: np.ndarray, node0: int, leaf0: int) -> np.ndarray:
    """A split node moves up by node0; a leaf ~l becomes ~(l + leaf0), which is l - leaf0."""
    return np.where(child >= 0, child + node0, child - leaf0)


def _index_dtype(values: np.ndarray) -> type:
    return np.uint16 if not len(values) or values.max() < 2**16 else np.int32


def _class_dtype(n: int) -> type:
    return np.uint8 if n <= 256 else np.int32


def _ints(text: str, dtype: type) -> np.ndarray:
    return np.array(text.split(), np.int64).astype(dtype)


# ---- LightGBM ---------------------------------------------------------------------------
# what LightGBM's ConvertOutput does to the raw score, by the objective's name
LGB_TRANSFORMS = {
    "binary": "sigmoid",
    "cross_entropy": "sigmoid",
    "multiclassova": "sigmoid",
    "multiclass": "softmax",
    **dict.fromkeys(("poisson", "gamma", "tweedie"), "exp"),
    **dict.fromkeys(
        ("regression", "regression_l1", "huber", "fair", "quantile", "mape"), "identity"
    ),
}
LGB_FLOATS = ("threshold", "leaf_value")
LGB_INTS = {
    "split_feature": np.int32,
    "decision_type": np.uint8,
    "left_child": np.int32,
    "right_child": np.int32,
    "cat_boundaries": np.int32,
    "cat_threshold": np.uint32,
}


def lightgbm_arrays(model_str: str) -> Model:
    """One LightGBM text model (``Booster.model_to_string()``) as flat arrays and meta.

    meta: kind="lightgbm", objective (as written in the model), transform (identity /
    sigmoid / softmax / exp / square, what ``predict`` applies to the raw score), sigmoid
    (the sigmoid's scale), num_class, num_outputs (trees per iteration: tree t adds to
    output t % num_outputs), num_trees, num_iterations, num_features, average_output (a
    random forest: ``predict``, not the raw score, divides by num_iterations),
    feature_names, feature_infos."""
    head, blocks = _lgb_blocks(model_str)
    trees = [_lgb_tree(b) for b in blocks]
    arrays = _join_trees(trees, ("split_feature", "threshold", "decision_type"))
    arrays.update(_lgb_categories(trees, arrays["decision_type"], arrays["threshold"]))
    outputs = int(head["num_tree_per_iteration"])
    arrays["tree_class"] = (np.arange(len(trees)) % outputs).astype(_class_dtype(outputs))
    meta = {
        "kind": "lightgbm",
        **_lgb_objective(head["objective"]),
        "num_class": int(head["num_class"]),
        "num_outputs": outputs,
        "num_trees": len(trees),
        "num_iterations": len(trees) // outputs,
        "num_features": int(head["max_feature_idx"]) + 1,
        "average_output": "average_output" in head,
        "feature_names": head.get("feature_names", "").split(),
        "feature_infos": head.get("feature_infos", "").split(),
    }
    return arrays, meta


def _lgb_blocks(model_str: str) -> tuple[dict[str, str], list[dict[str, str]]]:
    """The header's and each tree's ``key=value`` lines (a bare line maps to "")."""
    text = model_str.split("\nend of trees", 1)[0]
    head, *trees = re.split(r"^Tree=\d+\n", text, flags=re.M)
    return _key_values(head), [_key_values(t) for t in trees]


def _key_values(block: str) -> dict[str, str]:
    pairs = (line.partition("=") for line in block.splitlines())
    return {key: value for key, _, value in pairs if key}


def _lgb_tree(kv: dict[str, str]) -> dict[str, np.ndarray]:
    """One tree's arrays, as written: children local, a leaf as ~leaf. A single-leaf tree has
    no split nodes, only its leaf_value."""
    if kv.get("is_linear", "0") != "0":
        raise ValueError("linear trees are not supported")
    tree = {key: _ints(kv.get(key, ""), dtype) for key, dtype in LGB_INTS.items()}
    # Python's float() is correctly rounded, so the %.17g text comes back exact
    tree.update({key: np.array([float(v) for v in kv.get(key, "").split()]) for key in LGB_FLOATS})
    return tree


def _lgb_categories(trees: list[dict], decision: np.ndarray, threshold: np.ndarray) -> dict:
    """Every tree's categorical bitsets joined, and each categorical split's threshold (its
    tree's bitset index) moved to the joined index."""
    counts = [max(len(t["cat_boundaries"]) - 1, 0) for t in trees]
    words = np.cumsum([0, *(len(t["cat_threshold"]) for t in trees)])
    bounds = [t["cat_boundaries"][:-1] + w for t, w in zip(trees, words[:-1], strict=True)]
    cat0 = np.repeat(np.cumsum([0, *counts[:-1]]), [len(t["decision_type"]) for t in trees])
    categorical = (decision & 1).astype(bool)
    return {
        "threshold": np.where(categorical, threshold + cat0, threshold),
        "cat_boundaries": np.concatenate([*bounds, words[-1:]]).astype(np.int32),
        "cat_threshold": np.concatenate([t["cat_threshold"] for t in trees]).astype(np.uint32),
    }


def _lgb_objective(objective: str) -> dict:
    name, *params = objective.split()
    if name not in LGB_TRANSFORMS:
        raise ValueError(f"unsupported LightGBM objective {objective!r}")
    opts = dict(p.split(":", 1) for p in params if ":" in p)
    # reg_sqrt: the model learned sqrt(label), so predict squares it back (keeping the sign)
    transform = "square" if "sqrt" in params else LGB_TRANSFORMS[name]
    return {"objective": objective, "transform": transform,
            "sigmoid": float(opts.get("sigmoid", 1))}  # fmt: skip


# ---- XGBoost ----------------------------------------------------------------------------
XGB_TRANSFORMS = {
    "multi:softprob": "softmax",
    "binary:logistic": "sigmoid",
    "reg:logistic": "sigmoid",
    "binary:logitraw": "identity",
    "reg:squarederror": "identity",
}


def xgboost_arrays(model: str | bytes | bytearray | dict) -> Model:
    """One XGBoost JSON model (``save_model("x.json")``) as flat arrays and meta.

    meta: kind="xgboost", objective, transform (softmax / sigmoid / identity), num_class,
    num_outputs, num_trees, num_features, base_margin (the margin every row starts from,
    one float32 per output), feature_names.

    Only numerical splits and one target; needs xgboost itself for base_margin."""
    m = model if isinstance(model, dict) else json.loads(model)
    learner = m["learner"]
    objective = learner["objective"]["name"]
    params = learner["learner_model_param"]
    if objective not in XGB_TRANSFORMS or int(params.get("num_target", 1)) != 1:
        raise ValueError(f"unsupported XGBoost model: {objective}, {params}")
    booster = learner["gradient_booster"]["model"]
    trees = [_xgb_tree(t) for t in booster["trees"]]
    arrays = _join_trees(trees, ("split_feature", "threshold", "default_left"))
    outputs = max(int(params["num_class"]), 1)
    arrays["tree_class"] = np.array(booster["tree_info"], _class_dtype(outputs))
    meta = {
        "kind": "xgboost",
        "objective": objective,
        "transform": XGB_TRANSFORMS[objective],
        "num_class": int(params["num_class"]),
        "num_outputs": outputs,
        "num_trees": len(trees),
        "num_features": int(params["num_feature"]),
        "base_margin": _xgb_base_margin(m, int(params["num_feature"])),
        "feature_names": learner.get("feature_names", []),
    }
    return arrays, meta


def _xgb_tree(t: dict) -> dict[str, np.ndarray]:
    """One tree in the shared layout: XGBoost numbers leaves among the nodes, and keeps a
    leaf's value in split_conditions (base_weights is the value before the learning rate)."""
    if any(t["split_type"]) or int(t["tree_param"].get("size_leaf_vector", 1)) > 1:
        raise ValueError("categorical splits and vector leaves are not supported")
    left, right = np.array(t["left_children"]), np.array(t["right_children"])
    leaf = left == -1
    split = ~leaf
    renumber = np.empty(len(left), np.int64)
    renumber[split] = np.arange(split.sum())
    renumber[leaf] = ~np.arange(leaf.sum())
    value = np.array(t["split_conditions"], np.float64).astype(np.float32)
    return {
        "split_feature": np.array(t["split_indices"], np.int64)[split],
        "threshold": value[split],
        "default_left": np.array(t["default_left"], np.uint8)[split],
        "left_child": renumber[left[split]],
        "right_child": renumber[right[split]],
        "leaf_value": value[leaf],
    }


def _xgb_base_margin(m: dict, num_features: int) -> list[float]:
    """The margin before any tree, as xgboost itself derives it from base_score -- the rule
    has moved between versions (a 2.x softprob model's 0.5 is used as is; 3.x writes a
    per-class vector) -- by predicting with every leaf zeroed."""
    import xgboost as xgb

    zeroed = copy.deepcopy(m)
    for t in zeroed["learner"]["gradient_booster"]["model"]["trees"]:
        leaves = zip(t["left_children"], t["split_conditions"], strict=True)
        t["split_conditions"] = [0.0 if lc == -1 else c for lc, c in leaves]
    booster = xgb.Booster(model_file=bytearray(json.dumps(zeroed).encode()))
    rows = xgb.DMatrix(np.full((1, num_features), np.nan, np.float32))
    margin = booster.predict(rows, output_margin=True, validate_features=False)
    return [float(v) for v in np.ravel(margin)]
