"""Expected batted-ball outcome per ball in play: the swing-path model's third-stage target.

As model_README.md's in-play model: a KNN on (exit velocity, launch angle, spray angle),
matched exactly on batter hand, gives each ball in play its expected P(field_out, single,
double, triple, home_run), smoothed toward the class prior. Errors, fielder's choices,
sacrifices and double plays count as field outs. Neighbours come from other folds (batter-
grouped, as the swing-path model), so no ball in play sees its own outcome or its batter's.

    x_wobacon = 0.9 single + 1.25 double + 1.6 triple + 2 home_run

    python batted_ball.py --pitches 'plv/in_*.parquet' --out bip.parquet
"""

from __future__ import annotations

import argparse
import glob

import features as F
import numpy as np
import pandas as pd
from sklearn.neighbors import NearestNeighbors

HITS = ["single", "double", "triple", "home_run"]
CLASSES = ["field_out", *HITS]
WEIGHTS = {"single": 0.9, "double": 1.25, "triple": 1.6, "home_run": 2.0}
INPUTS = ["launch_speed", "launch_angle", "spray_angle"]
K = 100
PRIOR_WEIGHT = 5.0  # pseudo-neighbours at the class prior
KEYS = ["game_pk", "at_bat_index", "pitch_number"]


def balls_in_play(pattern: str) -> pd.DataFrame:
    """Non-bunt balls in play with all three inputs, from statfast pitch files."""
    cols = [*KEYS, "batter", "stand", "call_code", "events", "trajectory", *INPUTS]
    p = pd.concat([pd.read_parquet(f, columns=cols) for f in sorted(glob.glob(pattern))])
    b = p[p["call_code"].isin(["X", "D", "E"]) & ~p["trajectory"].str.startswith("bunt")]
    b = b[b["events"] != "catcher_interf"].dropna(subset=INPUTS).copy()
    b["spray_angle"] = b["spray_angle"].clip(-90, 90)
    b["label"] = np.where(b["events"].isin(HITS), b["events"], "field_out")
    return b.reset_index(drop=True)


def _neighbour_probs(train: pd.DataFrame, test: pd.DataFrame, scale: np.ndarray) -> np.ndarray:
    nn = NearestNeighbors(n_neighbors=K).fit(train[INPUTS].to_numpy() / scale)
    _, idx = nn.kneighbors(test[INPUTS].to_numpy() / scale)
    onehot = (train["label"].to_numpy()[:, None] == np.array(CLASSES)).astype(float)
    prior = onehot.mean(axis=0)
    return (onehot[idx].sum(axis=1) + PRIOR_WEIGHT * prior) / (K + PRIOR_WEIGHT)


def expected_outcomes(b: pd.DataFrame) -> pd.DataFrame:
    """Out-of-fold KNN class probabilities and x_wobacon for every ball in play."""
    scale = b[INPUTS].std().to_numpy()
    fold = F._folds(b["batter"])
    probs = np.zeros((len(b), len(CLASSES)))
    for hand in ("L", "R"):
        for k in range(F.FOLDS):
            tr = (b["stand"] == hand).to_numpy() & (fold != k)
            te = (b["stand"] == hand).to_numpy() & (fold == k)
            probs[te] = _neighbour_probs(b[tr], b[te], scale)
    out = b[KEYS].copy()
    for j, c in enumerate(CLASSES):
        out[f"x_{c}"] = probs[:, j]
    out["x_wobacon"] = sum(w * out[f"x_{c}"] for c, w in WEIGHTS.items())
    out["wobacon"] = b["label"].map(WEIGHTS).fillna(0.0)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--pitches", required=True, help="glob of statfast pitch files")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    b = balls_in_play(a.pitches)
    out = expected_outcomes(b)
    knn = out[[f"x_{c}" for c in CLASSES]].mean().set_axis(CLASSES)
    shares = pd.DataFrame({"actual": b["label"].value_counts(normalize=True), "KNN": knn})
    print(f"{len(out):,} balls in play\n{shares.round(4)}")
    print(f"wOBAcon actual {out['wobacon'].mean():.3f}, expected {out['x_wobacon'].mean():.3f}")
    out.to_parquet(a.out)


if __name__ == "__main__":
    main()
