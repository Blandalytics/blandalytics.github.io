"""DML swing-path model: how much the bat path moves whiff / foul / in play beyond PLV.

The model in ../swing_path_model_proposal.md. For each pitch group (Fastball / Breaking /
Offspeed, PLV's cutter roles) and each stage of the sequential logit (whiff vs contact over all
swings, then foul vs in play over contact):

    logit P(stage) = logit q_PLV + g(W) + theta_c * (D(S) - r(W))

    q_PLV   the PLV model's location-aware probability for the stage, from score_pitches.py
            --probs: q1 = P(swinging strike) / P(swing), q2 = P(foul) / P(contact)
    g(W)    LightGBM boosted from the PLV offset on W (location, count, platoon, VAA, season)
    D(S)    LightGBM boosted from logit q_PLV + g on the bat path only (features.PATH + aa_match)
    r(W)    the projection of D on W and the PLV logit, weighted by p(1 - p)
    theta_c one slope per pre-pitch count, pooled toward adjacent counts (penalty chosen by CV)

D, g, r and theta are fitted on committed swings (features.add_fooled); every swing is scored.
All nuisance fits are cross-fitted in batter-grouped folds that keep each batter's seasons
together, so no batter is scored by a model that saw his swings. `--test-season` also fits
every piece on the earlier seasons and scores the test season out of time, for evaluation.

Per swing, `lo_whiff` and `lo_foul` are the path's effect on each stage's log-odds,
theta_c (D - r): what this swing's path did against the average path at the same pitch,
location and count. Contact added is -lo_whiff; in-play added is -lo_foul.

    python dml_swing_path.py --savant 'savant/*.parquet' --plv 'plv/scored_*.parquet' \
        --test-season 2026 --out swing_path_scored.parquet
"""

from __future__ import annotations

import argparse
import glob
import json

import features as F
import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.special import expit, logit

OUTCOMES = ["swinging_strike", "foul", "field_out", "single", "double", "triple", "home_run"]
W_COLS = ["x_in", "z_n", "balls", "strikes", "platoon", "vaa", "season"]
S_COLS = [*F.PATH, "aa_match"]
STAGES = {"whiff": ("q_whiff", None), "foul": ("q_foul", "contact")}
GROUPS = ("Fastball", "Breaking", "Offspeed")
COUNTS = [(b, s) for b in range(4) for s in range(3)]
LAMBDAS = (0.0, 0.003, 0.03, 0.3, 3.0)  # multiples of the mean per-count Fisher information
BASE = {"learning_rate": 0.05, "num_leaves": 31, "min_data_in_leaf": 200, "verbose": -1,
        "num_threads": 4}  # fmt: skip
ROUNDS = {"g": 100, "D": 250, "r": 200}
NUMERIC = ["balls", "strikes", "game_year", "release_speed", "pfx_x", "pfx_z", "plate_x",
           "plate_z", "hc_x", "hc_y", "vx0", "vy0", "vz0", "ax", "ay", "az", "sz_top", "sz_bot",
           "launch_speed", *F.PATH]  # fmt: skip


def load_savant(pattern: str) -> pd.DataFrame:
    """Regular-season Savant pitches (empty days can carry text dtypes, so coerce)."""
    p = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob(pattern))], ignore_index=True)
    p = p[p["game_type"] == "R"].sort_values(["game_pk", "at_bat_number", "pitch_number"])
    p[NUMERIC] = p[NUMERIC].apply(pd.to_numeric, errors="coerce")
    return p.reset_index(drop=True)


def load_plv(pattern: str) -> pd.DataFrame:
    """PLV's swing-conditional stage probabilities from score_pitches.py --probs output."""
    cols = ["game_pk", "at_bat_index", "pitch_number", "group", "observed"]
    probs = [f"p_{o}_pitching" for o in OUTCOMES]
    v = pd.concat([pd.read_parquet(f, columns=cols + probs) for f in sorted(glob.glob(pattern))])
    swing = v[probs].sum(axis=1)
    v["q_whiff"] = v["p_swinging_strike_pitching"] / swing
    v["q_foul"] = v["p_foul_pitching"] / (swing - v["p_swinging_strike_pitching"])
    v["at_bat_number"] = v["at_bat_index"] + 1
    return v.drop(columns=[*probs, "at_bat_index"])


def consistent(cls: pd.Series, observed: pd.Series) -> pd.Series:
    """Savant's class agrees with PLV's observed outcome (drops ~0.05% mislabeled rows)."""
    plv = observed.map({"swinging_strike": "whiff", "foul": "foul"}).fillna("in_play")
    plv = plv.where(~observed.isin(["ball", "called_strike"]), "take")
    return cls == plv


def build(savant: str, plv: str) -> pd.DataFrame:
    """Tracked swings with bat-path features, fooled flags and PLV stage probabilities."""
    s = F.build(load_savant(savant))
    s = s.merge(load_plv(plv), on=["game_pk", "at_bat_number", "pitch_number"], how="inner")
    s = s[consistent(s["cls"], s["observed"])].reset_index(drop=True)
    s["season"] = s["game_year"].astype(int)
    s["whiff"] = (s["cls"] == "whiff").astype(int)
    s["foul"] = (s["cls"] == "foul").astype(int)
    s["contact"] = s["whiff"] == 0
    s["count_idx"] = (s["balls"].astype(int) * 3 + s["strikes"].astype(int)).clip(0, 11)
    for q in ("q_whiff", "q_foul"):
        s[q] = s[q].clip(1e-4, 1 - 1e-4)
    return s


def _boost(x, y, init, rounds, objective="binary", weight=None):
    params = {**BASE, "objective": objective}
    return lgb.train(params, lgb.Dataset(x, y, init_score=init, weight=weight), rounds)


def nuisance(tr: pd.DataFrame, te: pd.DataFrame, y: str, q: str) -> dict:
    """Fit g, D and r on `tr`, score `te`: the logits l = logit q + g, D and r for `te`."""
    off_tr, off_te = logit(tr[q]).to_numpy(), logit(te[q]).to_numpy()
    g = _boost(tr[W_COLS], tr[y], off_tr, ROUNDS["g"])
    l_tr = off_tr + g.predict(tr[W_COLS], raw_score=True)
    l_te = off_te + g.predict(te[W_COLS], raw_score=True)
    d = _boost(tr[S_COLS], tr[y], l_tr, ROUNDS["D"])
    d_tr = d.predict(tr[S_COLS], raw_score=True)
    p = expit(l_tr)
    wr = tr[W_COLS].assign(off=off_tr)
    r = _boost(wr, d_tr, None, ROUNDS["r"], "regression", p * (1 - p))
    return {"l": l_te, "D": d.predict(te[S_COLS], raw_score=True),
            "r": r.predict(te[W_COLS].assign(off=off_te))}  # fmt: skip


def penalty_matrix() -> np.ndarray:
    """Sum over adjacent counts (one ball or one strike apart) of (theta_c - theta_c')^2."""
    pen = np.zeros((12, 12))
    for i, (b, s) in enumerate(COUNTS):
        for j, (b2, s2) in enumerate(COUNTS):
            if abs(b - b2) + abs(s - s2) == 1:
                pen[i, i] += 1
                pen[i, j] -= 1
    return pen


def fit_theta(y, base, x, count, lam) -> np.ndarray:
    """Penalized Newton for y ~ offset(base) + theta[count] * x."""
    theta, pen = np.ones(12), penalty_matrix()
    onehot = np.eye(12)[count]
    for _ in range(25):
        p = expit(base + theta[count] * x)
        grad = onehot.T @ ((y - p) * x) - lam * pen @ theta
        info = np.bincount(count, p * (1 - p) * x * x, minlength=12)
        step = np.linalg.solve(np.diag(info + 1e-9) + lam * pen, grad)
        theta += step
        if np.abs(step).max() < 1e-7:
            break
    return theta


def choose_lambda(y, base, x, count, fold) -> float:
    """The pooling penalty with the best batter-grouped CV log loss."""
    p0 = expit(base)
    scale = np.bincount(count, p0 * (1 - p0) * x * x, minlength=12).mean()
    losses = {}
    for lam in LAMBDAS:
        ll = 0.0
        for k in np.unique(fold):
            tr, te = fold != k, fold == k
            th = fit_theta(y[tr], base[tr], x[tr], count[tr], lam * scale)
            p = expit(base[te] + th[count[te]] * x[te])
            ll -= np.sum(y[te] * np.log(p) + (1 - y[te]) * np.log(1 - p))
        losses[lam] = ll
    return min(losses, key=losses.get) * scale


def cluster_se(y, base, x, count, theta, batter) -> np.ndarray:
    """Batter-clustered sandwich SEs per count (ignores the pooling penalty's bias)."""
    p = expit(base + theta[count] * x)
    onehot = np.eye(12)[count]
    score = onehot * ((y - p) * x)[:, None]
    meat = pd.DataFrame(score).groupby(batter).sum().to_numpy()
    bread = np.diag(np.bincount(count, p * (1 - p) * x * x, minlength=12) + 1e-9)
    inv = np.linalg.inv(bread)
    return np.sqrt(np.diag(inv @ meat.T @ meat @ inv))


def fit_stage_parts(d: pd.DataFrame, y: str, q: str, fold: np.ndarray) -> pd.DataFrame:
    """Cross-fitted l, D, r: nuisances fitted on other folds' committed swings, every swing
    scored."""
    out = pd.DataFrame(index=d.index, columns=["l", "D", "r"], dtype=float)
    for k in range(F.FOLDS):
        tr = d[(fold != k) & ~d["fooled"]]
        te = d[fold == k]
        out.loc[te.index] = pd.DataFrame(nuisance(tr, te, y, q), index=te.index)
    return out


def fit_stage(d: pd.DataFrame, y: str, q: str, fold: np.ndarray) -> tuple[pd.DataFrame, dict]:
    """Cross-fitted l, D, r on committed swings (scoring every swing), then theta."""
    out = fit_stage_parts(d, y, q, fold)
    fit = (~d["fooled"]).to_numpy()
    yy, cnt = d[y].to_numpy()[fit], d["count_idx"].to_numpy()[fit]
    base = (out["l"] + out["r"]).to_numpy()[fit]
    x = (out["D"] - out["r"]).to_numpy()[fit]
    lam = choose_lambda(yy, base, x, cnt, fold[fit])
    theta = fit_theta(yy, base, x, cnt, lam)
    se = cluster_se(yy, base, x, cnt, theta, d["batter"].to_numpy()[fit])
    return out, {"theta": theta.tolist(), "se": se.tolist(), "lambda": lam}


def score(d: pd.DataFrame, parts: pd.DataFrame, theta) -> pd.DataFrame:
    """Per-swing path effect and full probability for one stage."""
    th = np.asarray(theta)[d["count_idx"].to_numpy()]
    lo = th * (parts["D"] - parts["r"]).to_numpy()
    base = (parts["l"] + parts["r"]).to_numpy()
    return pd.DataFrame({"lo": lo, "p_full": expit(base + lo), "p_plvg": expit(parts["l"])},
                        index=d.index)  # fmt: skip


def run_crossfit(s: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Every group and stage, cross-fitted over all seasons."""
    fold, info = F._folds(s["batter"]), {}
    for grp in GROUPS:
        for stage, (q, subset) in STAGES.items():
            m = (s["group"] == grp) & (s[subset] if subset else True)
            d = s[m]
            parts, info[f"{grp}/{stage}"] = fit_stage(d, stage, q, fold[m.to_numpy()])
            sc = score(d, parts, info[f"{grp}/{stage}"]["theta"])
            s.loc[d.index, [f"lo_{stage}", f"p_{stage}_full", f"p_{stage}_plvg"]] = sc.to_numpy()
            print(grp, stage, "theta", np.round(info[f"{grp}/{stage}"]["theta"], 2), flush=True)
    return s, info


def run_out_of_time(s: pd.DataFrame, test: int, info: dict) -> pd.DataFrame:
    """Fit on seasons before `test`, score `test`: evaluation only. Theta comes from
    cross-fitted parts within the training seasons, with the cross-fit run's pooling penalty;
    the nuisance models are then refit on all training swings to score the test season."""
    rows = []
    for grp in GROUPS:
        for stage, (q, subset) in STAGES.items():
            m = (s["group"] == grp) & (s[subset] if subset else True)
            d_tr = s[m & (s["season"] < test)]
            te = s[m & (s["season"] == test)]
            parts = fit_stage_parts(d_tr, stage, q, F._folds(d_tr["batter"]))
            fit = ~d_tr["fooled"].to_numpy()
            x = (parts["D"] - parts["r"]).to_numpy()[fit]
            base = (parts["l"] + parts["r"]).to_numpy()[fit]
            lam = info[f"{grp}/{stage}"]["lambda"]
            cnt = d_tr["count_idx"].to_numpy()[fit]
            theta = fit_theta(d_tr[stage].to_numpy()[fit], base, x, cnt, lam)
            full = pd.DataFrame(nuisance(d_tr[fit], te, stage, q), index=te.index)
            sc = score(te, full, theta)
            rows.append(sc.assign(group=grp, stage=stage, y=te[stage], q=te[q],
                                  fooled=te["fooled"], batter=te["batter"]))  # fmt: skip
            print("oot", grp, stage, flush=True)
    return pd.concat(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--savant", required=True, help="glob of Savant pitch files (.parquet)")
    ap.add_argument("--plv", required=True, help="glob of score_pitches.py --probs outputs")
    ap.add_argument("--test-season", type=int, help="also fit on earlier seasons, score this")
    ap.add_argument("--out", required=True, help="per-swing output (.parquet)")
    a = ap.parse_args()
    s = build(a.savant, a.plv)
    print(f"{len(s):,} swings; fooled {s['fooled'].mean():.3f}", flush=True)
    s, info = run_crossfit(s)
    s.to_parquet(a.out)
    with open(a.out.replace(".parquet", "_theta.json"), "w") as f:
        json.dump(info, f, indent=1)
    if a.test_season:
        oot = run_out_of_time(s, a.test_season, info)
        oot.to_parquet(a.out.replace(".parquet", "_oot.parquet"))


if __name__ == "__main__":
    main()
