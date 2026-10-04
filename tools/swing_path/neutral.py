"""Location-neutral swing-path probabilities: what each swing's bat path earns against the
league's swung-at pitches, not the pitch it actually saw.

For each swing i, 300 swings j are drawn from the league's swings in the same season, count,
pitch group and platoon cell. At each draw the stage log-odds are the draw's own location and
PLV terms plus swing i's path against the average path there:

    eta_s(i, j) = l_s(j) + r_s(j) + theta_s,c (D_s(i) - r_s(j)) + shift_s

The two stages are chained per draw (whiff p1; foul (1 - p1) p2; in play (1 - p1)(1 - p2)) and
averaged over the draws, so the three probabilities sum to 1. One log-odds shift per stage and
season makes the league means equal the observed whiff and foul shares. The damage stage is
linear, so its draw average is exact: mean_j(l3 + r3 - theta r3) + theta D3(i), shifted so
its mean over balls in play equals the mean KNN expected wOBAcon.

    x<class>_plus = 100 * p_<class>_path / its season x count x group x platoon cell mean

    python neutral.py --scored pooled.parquet --out neutral.parquet
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
from scipy.special import expit

DRAWS = 300
CELL = ["season", "count_idx", "group", "platoon"]
STAGE_COLS = [f"{c}_{s}" for s in ("whiff", "foul", "damage") for c in ("l", "r", "D")]


def theta_lookup(info: dict, s: pd.DataFrame, stage: str) -> np.ndarray:
    """Each swing's theta for `stage`, from the model (group, or group x hand) it belongs to."""
    out = np.zeros(len(s))
    for key, v in info.items():
        model, st = key.rsplit("/", 1)
        if st != stage:
            continue
        grp, _, side = model.partition(" vs ")
        m = (s["group"] == grp).to_numpy()
        if side:
            m &= (s["platoon"] == (1 if side == "same" else 0)).to_numpy()
        out[m] = np.asarray(v["theta"])[s.loc[m, "count_idx"].to_numpy()]
    return out


def _draw_terms(c: pd.DataFrame, th: dict, idx: np.ndarray, stage: str) -> np.ndarray:
    """eta for every (swing, draw) pair in one cell, without the shift."""
    base = (c[f"l_{stage}"] + c[f"r_{stage}"]).to_numpy()[idx]
    r = c[f"r_{stage}"].to_numpy()[idx]
    t = th[stage][:, None]
    return (base - t * r + t * c[f"D_{stage}"].to_numpy()[:, None]).astype(np.float32)


def cell_draws(s: pd.DataFrame, th: dict, rng) -> list[tuple[np.ndarray, dict]]:
    """Per cell: row positions and the two logit stages' eta matrices (rows x draws)."""
    out = []
    for _, pos in s.groupby(CELL).indices.items():
        c = s.iloc[pos]
        idx = rng.integers(0, len(c), size=(len(c), DRAWS))
        cth = {k: v[pos] for k, v in th.items()}
        out.append((pos, {st: _draw_terms(c, cth, idx, st) for st in ("whiff", "foul")}))
    return out


def chained(draws, n: int, shift: dict) -> np.ndarray:
    """Draw-averaged (whiff, foul, in play) per swing at the given log-odds shifts."""
    out = np.zeros((n, 3))
    for pos, eta in draws:
        p1, p2 = expit(eta["whiff"] + shift["whiff"]), expit(eta["foul"] + shift["foul"])
        out[pos] = np.column_stack([p1.mean(1), ((1 - p1) * p2).mean(1),
                                    ((1 - p1) * (1 - p2)).mean(1)])  # fmt: skip
    return out


def calibrate(draws, n: int, target: tuple[float, float]) -> dict:
    """Log-odds shifts so the mean whiff and foul shares equal the observed ones (secant)."""
    shift = {"whiff": 0.0, "foul": 0.0}
    for _ in range(6):
        p = chained(draws, n, shift).mean(axis=0)
        shift["whiff"] += np.log(target[0] / (1 - target[0])) - np.log(p[0] / (1 - p[0]))
        share = p[1] / (p[1] + p[2])
        shift["foul"] += np.log(target[1] / (1 - target[1])) - np.log(share / (1 - share))
    return shift


def neutral_damage(s: pd.DataFrame, th: np.ndarray) -> np.ndarray:
    """Exact draw average of the linear damage stage: the cell mean of l + (1 - theta) r,
    plus theta D."""
    part = s["l_damage"] + (1 - th) * s["r_damage"]
    return part.groupby([s[c] for c in CELL]).transform("mean").to_numpy() + th * s["D_damage"]


def season_probs(s: pd.DataFrame, info: dict, seed: int) -> pd.DataFrame:
    """Neutral class probabilities and wOBAcon for one season's swings."""
    th = {st: theta_lookup(info, s, st) for st in ("whiff", "foul", "damage")}
    draws = cell_draws(s, th, np.random.default_rng(seed))
    contact = s[s["contact"]]
    shift = calibrate(draws, len(s), (s["whiff"].mean(), contact["foul"].mean()))
    p = chained(draws, len(s), shift)
    out = pd.DataFrame(p, columns=["p_whiff_path", "p_foul_path", "p_in_play_path"], index=s.index)
    damage = pd.Series(neutral_damage(s, th["damage"]), index=s.index)
    shift["damage"] = s.loc[s["bip"], "x_wobacon"].mean() - damage[s["bip"]].mean()
    out["wobacon_path"] = damage + shift["damage"]
    print(f"season {int(s['season'].iloc[0])}: shifts {shift}", flush=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scored", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    keep = ["batter", "player_name", "game_pk", "season", "count_idx", "group", "platoon",
            "whiff", "foul", "contact", "bip", "fooled", "x_wobacon", *STAGE_COLS]  # fmt: skip
    s = pd.read_parquet(a.scored, columns=keep)
    with open(a.scored.replace(".parquet", "_theta.json")) as f:
        info = json.load(f)
    p = pd.concat([season_probs(g, info, int(y)) for y, g in s.groupby("season")])
    s = s.join(p)
    for c in ("whiff", "foul", "in_play"):
        cell_mean = s.groupby(CELL)[f"p_{c}_path"].transform("mean")
        s[f"x{c}_plus"] = 100 * s[f"p_{c}_path"] / cell_mean
    s.drop(columns=STAGE_COLS).to_parquet(a.out)
    print(s[["p_whiff_path", "p_foul_path", "p_in_play_path", "wobacon_path"]].describe().round(3))


if __name__ == "__main__":
    main()
