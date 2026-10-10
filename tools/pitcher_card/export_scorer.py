"""The live Worker's scorer bundle: pitch-modeling's chained models, location draws and
constants, the Level 1 pitch classifier and the xSLG model, as one pack in the bucket.

    python export_scorer.py              # build it, and publish it if it changed
    python export_scorer.py --out DIR    # a folder instead of the bucket

Writes ``cards/models/scorer.pack`` (model_pack.py's format), which
tools/live/src/cards/bundle.js turns back into what scorer.js runs on.

The Worker's scorer is a hand port of pitch-modeling's score_pitches.py, pitch_groups.py,
pitch_l1.py and abs_2026.py, so a retrained model goes straight through -- it is data --
but changed code does not: PORTED pins the sources the port follows, and while the
published ones differ nothing is written and this exits non-zero. Port the change, check
it with ``node tools/live/test/card_parity.mjs`` (see parity.py), then update PORTED."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
import sys

import numpy as np
import pandas as pd

from card import DEFAULT_CACHE, MODELS_DIR, ROOT  # first: it puts the scraper on sys.path

import fetch  # noqa: E402
import model_pack  # noqa: E402
import pitch_model  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from backfill import LocalStore, R2Store  # noqa: E402

KEY = "cards/models/scorer.pack"
CACHE = "no-cache"  # the Worker reads it through the binding; nobody else should cache it
STAGES = ("swing_take", "take_outcome", "swing_outcome", "in_play")
OUTCOMES = ("ball", "called_strike", "swinging_strike", "foul", "field_out", "single",
            "double", "triple", "home_run")  # fmt: skip
# sha256 of the pitch-modeling sources tools/live/src/cards/ is a port of
PORTED = {
    "score_pitches.py": "b0d60687607c9f9b59b9de1765bce273e211658ced2c74186da1de15aa25b7f3",
    "pitch_groups.py": "95920fa0fd153ba1aa3308c4aff64631da1c63a5e35d4a3b3095a525840a661a",
    "pitch_l1.py": "5237b6e9a954c700e889767edd4c230e66a2b0de6f25ca3fde81313687a07099",
    "abs_2026.py": "07551cda50e16778d15039f3f3ab943a95b9bd7bd7eb005a5fa20755390a115c",
}


def _read(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def sha256(path: str) -> str:
    return hashlib.sha256(_read(path)).hexdigest()


def drifted(root: str) -> list[str]:
    """The ported sources whose published copy is not the one the port follows."""
    return [name for name, want in PORTED.items() if sha256(os.path.join(root, name)) != want]


def _stage(arrays: dict, meta: dict, root: str, name: str) -> dict:
    """One chained model: per group its thetas, its location draws (concatenated, with an
    index of (offset, rows) per cell) and its boosters, location and residual models."""
    blob = pickle.loads(_read(os.path.join(root, "models", f"{name}_logit_2325.pkl")))
    groups = {}
    for group, gm in blob["groups"].items():
        prefix = f"{name}/{group}"
        nstages = len(gm["boosters"])
        arrays[f"{prefix}/thetas"] = np.asarray(gm["thetas"], np.float64)
        index, chunks, pos = {}, [], 0
        for (season, balls, strikes, hand, stand), draw in gm["draws"].items():
            d = np.asarray(draw, np.float64)
            index[f"{season}:{balls}:{strikes}:{hand}:{stand}"] = [pos, len(d)]
            chunks.append(d.ravel())
            pos += d.size
        arrays[f"{prefix}/draws"] = np.concatenate(chunks)
        for kind in ("boosters", "loc_models", "r_models"):
            for s, model_str in enumerate(gm[kind]):
                model = model_pack.lightgbm_arrays(model_str)
                model_pack.add_model(arrays, meta, f"{prefix}/{kind}/{s}", model)
        groups[group] = {"seasons": [int(x) for x in gm["seasons"]], "nstages": nstages,
                         "draws": index}  # fmt: skip
    return {"name": name, "classes": list(blob["classes"]),
            "shift": np.asarray(blob["shift"], float).tolist(), "groups": groups}  # fmt: skip


def _constants(root: str) -> dict:
    """The league count mix, the run-value tables, the plus scale and the ABS env."""
    c = os.path.join(root, "constants")
    mix = json.loads(_read(os.path.join(c, "count_mix.json")))
    values = pd.read_csv(os.path.join(c, "run_values.csv"), index_col="outcome")["run value"]
    by_count = pd.read_csv(os.path.join(c, "run_values_by_count.csv"), index_col="outcome")
    counts = [f"{k // 3}-{k % 3}" for k in range(12)]
    return {
        "mix": [mix[k] for k in counts],
        "values": values.reindex(list(OUTCOMES)).tolist(),
        "by_count": by_count.reindex(list(OUTCOMES))[counts].to_numpy().ravel().tolist(),
        "scale": json.loads(_read(os.path.join(c, pitch_model.SCALE))),
        "env": json.loads(_read(os.path.join(c, pitch_model.ABS))),
    }


def _level1(arrays: dict, root: str) -> dict:
    """pitch_l1's arm-angle estimator, offsets, heights and its arm-adjusted field (A);
    pitch_groups switches the raw-movement field off, so B is left out."""
    z = np.load(os.path.join(root, "models", "pitch_l1_v1.npz"), allow_pickle=False)
    prm = json.loads(str(z["params"]))
    arrays["l1/field"] = np.ascontiguousarray(z["A_p"], np.float32).ravel()
    for name, dtype in (("off_ps_pitcher", np.int32), ("off_ps_season", np.int32),
                        ("off_ps_val", np.float64), ("off_p_pitcher", np.int32),
                        ("off_p_val", np.float64), ("height_pitcher", np.int32),
                        ("height_val", np.float64)):  # fmt: skip
        arrays[f"l1/{name}"] = z[name].astype(dtype)
    return {
        "coef": z["aa_coef"].tolist(), "intercept": float(z["aa_intercept"]),
        "aa_mean": float(z["aa_mean"]), "dspeed_q": prm["dspeed_q"], "T": prm["T"],
        "s": prm["s"], "lo": z["A_lo"].tolist(), "bins": z["A_bins"].tolist(),
        "width": ((z["A_hi"] - z["A_lo"]) / z["A_bins"]).tolist(),
    }  # fmt: skip


def bundle(root: str) -> bytes:
    """The whole bundle, from a pitch-modeling artifact folder and the xSLG model."""
    arrays, meta = {}, {"version": 1}
    meta["sources"] = {name: sha256(os.path.join(root, name)) for name in PORTED}
    meta["stages"] = [_stage(arrays, meta, root, name) for name in STAGES]
    meta.update(_constants(root))
    meta["l1"] = _level1(arrays, root)
    xslg = max(f for f in os.listdir(MODELS_DIR) if f.endswith("_pl_xSLG_model.json"))
    with open(os.path.join(MODELS_DIR, xslg), encoding="utf-8") as fh:
        model_pack.add_model(arrays, meta, "xslg", model_pack.xgboost_arrays(fh.read()))
    return model_pack.pack(arrays, meta)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="write to this folder instead of the bucket")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the pitch-modeling artifact cache")
    a = ap.parse_args(argv)
    pm = pitch_model.PitchModel(a.cache, fetch.session())
    pm.ensure()
    if bad := drifted(pm.dir):
        print(f"pitch-modeling changed {', '.join(bad)} since the Worker's port: port the "
              "change, check it with tools/live/test/card_parity.mjs and update PORTED",
              file=sys.stderr)  # fmt: skip
        return 1
    data = bundle(pm.dir)
    store = LocalStore(a.out) if a.out else R2Store()
    if store.get(KEY) == data:
        print(f"{KEY} unchanged ({len(data) / 1e6:.1f} MB)")
        return 0
    store.put(KEY, data, "application/octet-stream", CACHE)
    print(f"{KEY} written ({len(data) / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
