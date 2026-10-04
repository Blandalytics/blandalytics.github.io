"""DML swing-path model: how much the bat path moves whiff / foul / in play / damage beyond PLV.

The model in ../swing_path_model_proposal.md. For each pitch group (Fastball / Breaking /
Offspeed, PLV's cutter roles; with --split-hand, also by same / opposite hand) and each stage:

    whiff   logit P(whiff | swing)       = logit q + g(W) + theta_c (D(S) - r(W))
    foul    logit P(foul | contact)      = logit q + g(W) + theta_c (D(S) - r(W))
    damage  E[x_wobacon | ball in play]  =       q + g(W) + theta_c (D(S) - r(W))

    q       PLV's location-aware prediction from score_pitches.py --probs: P(swinging strike) /
            P(swing), P(foul) / P(contact), and its batted-ball probabilities as wOBAcon
    x_wobacon  the ball in play's KNN expected wOBAcon (batted_ball.py)
    g(W)    LightGBM boosted from q on W: location, count, platoon, the pitch's approach angles,
            the hitter's season swing-location mix (features.add_swing_mix) and season
    D(S)    LightGBM boosted from q + g on the bat path only (features.PATH, aa_match, ad_match)
    r(W)    the projection of D on W and q (weighted by p(1 - p) for the logit stages)
    theta_c one slope per pre-pitch count, pooled toward adjacent counts (penalty chosen by CV)

g, D, r and theta are fitted on committed swings (features.add_fooled) in each stage's sample
(all swings, contact, balls in play); every swing is scored for every stage, so the foul and
damage effects exist for whiffs too (what that path would have done on contact). Nuisances are
cross-fitted in batter-grouped folds that keep each batter's seasons together. `--test-season`
also fits on the earlier seasons and scores the test season out of time, for evaluation.

Per swing and stage: l_<stage> (q + g, on the stage's scale), D_<stage>, r_<stage>, and
lo_<stage> = theta_c (D - r), the path's effect against the average path at the same pitch,
location and count. Contact added is -lo_whiff, in-play added -lo_foul, damage added
lo_damage (wOBAcon per ball in play).

    python dml_swing_path.py --savant 's2[456]/*.parquet' --plv 'plv/scored_*.parquet' \
        --bip bip.parquet --test-season 2026 --out swing_path.parquet [--split-hand]
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
WOBA = {"single": 0.9, "double": 1.25, "triple": 1.6, "home_run": 2.0}
W_COLS = ["x_in", "z_n", "balls", "strikes", "platoon", "vaa", "haa_b", "bat_x_mean",
          "bat_z_mean", "bat_chase", "season"]  # fmt: skip
S_COLS = [*F.PATH, "aa_match", "ad_match"]
STAGES = {
    "whiff": {"y": "whiff", "q": "q_whiff", "sample": None, "link": "logit"},
    "foul": {"y": "foul", "q": "q_foul", "sample": "contact", "link": "logit"},
    "damage": {"y": "x_wobacon", "q": "q_wobacon", "sample": "bip", "link": "linear"},
}
GROUPS = ("Fastball", "Breaking", "Offspeed")
COUNTS = [(b, s) for b in range(4) for s in range(3)]
LAMBDAS = (0.0, 0.003, 0.03, 0.3, 3.0)  # multiples of the mean per-count information
BASE = {"learning_rate": 0.05, "num_leaves": 31, "min_data_in_leaf": 200, "verbose": -1,
        "num_threads": 4}  # fmt: skip
ROUNDS = {"g": 100, "D": 250, "r": 200}
NUMERIC = ["balls", "strikes", "game_year", "release_speed", "pfx_x", "pfx_z", "plate_x",
           "plate_z", "hc_x", "hc_y", "vx0", "vy0", "vz0", "ax", "ay", "az", "sz_top", "sz_bot",
           "launch_speed", *F.PATH]  # fmt: skip
KEYS = ["game_pk", "at_bat_number", "pitch_number"]


def load_savant(pattern: str) -> pd.DataFrame:
    """Regular-season Savant pitches (empty days can carry text dtypes, so coerce)."""
    p = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob(pattern))], ignore_index=True)
    p = p[p["game_type"] == "R"].sort_values(KEYS)
    p[NUMERIC] = p[NUMERIC].apply(pd.to_numeric, errors="coerce")
    return p.reset_index(drop=True)


def load_plv(pattern: str) -> pd.DataFrame:
    """PLV's stage predictions from score_pitches.py --probs output."""
    cols = ["game_pk", "at_bat_index", "pitch_number", "group", "observed"]
    probs = [f"p_{o}_pitching" for o in OUTCOMES]
    v = pd.concat([pd.read_parquet(f, columns=cols + probs) for f in sorted(glob.glob(pattern))])
    swing = v[probs].sum(axis=1)
    whiff, foul = v["p_swinging_strike_pitching"], v["p_foul_pitching"]
    v["q_whiff"] = whiff / swing
    v["q_foul"] = foul / (swing - whiff)
    v["q_wobacon"] = sum(w * v[f"p_{o}_pitching"] for o, w in WOBA.items()) / (swing - whiff - foul)
    v["at_bat_number"] = v["at_bat_index"] + 1
    return v.drop(columns=[*probs, "at_bat_index"])


def consistent(cls: pd.Series, observed: pd.Series) -> pd.Series:
    """Savant's class agrees with PLV's observed outcome (drops ~0.05% mislabeled rows)."""
    plv = observed.map({"swinging_strike": "whiff", "foul": "foul"}).fillna("in_play")
    plv = plv.where(~observed.isin(["ball", "called_strike"]), "take")
    return cls == plv


def build(savant: str, plv: str, bip: str) -> pd.DataFrame:
    """Tracked swings with bat-path features, fooled flags, PLV predictions and targets."""
    s = F.build(load_savant(savant)).merge(load_plv(plv), on=KEYS, how="inner")
    s = s[consistent(s["cls"], s["observed"])]
    b = pd.read_parquet(bip, columns=["game_pk", "at_bat_index", "pitch_number", "x_wobacon"])
    b["at_bat_number"] = b["at_bat_index"] + 1
    s = s.merge(b.drop(columns="at_bat_index"), on=KEYS, how="left").reset_index(drop=True)
    s["season"] = s["game_year"].astype(int)
    s["whiff"] = (s["cls"] == "whiff").astype(int)
    s["foul"] = (s["cls"] == "foul").astype(int)
    s["contact"] = s["whiff"] == 0
    s["bip"] = (s["cls"] == "in_play") & s["x_wobacon"].notna()
    s["count_idx"] = (s["balls"].astype(int) * 3 + s["strikes"].astype(int)).clip(0, 11)
    for q in ("q_whiff", "q_foul"):
        s[q] = s[q].clip(1e-4, 1 - 1e-4)
    return s


def cells(s: pd.DataFrame, split_hand: bool):
    """(name, row mask) per model: pitch group, or pitch group x same / opposite hand."""
    for grp in GROUPS:
        if not split_hand:
            yield grp, (s["group"] == grp).to_numpy()
            continue
        for plat, side in ((1, "same"), (0, "opp")):
            yield f"{grp} vs {side}", ((s["group"] == grp) & (s["platoon"] == plat)).to_numpy()


def _boost(x, y, init, rounds, objective, weight=None):
    params = {**BASE, "objective": objective}
    return lgb.train(params, lgb.Dataset(x, y, init_score=init, weight=weight), rounds)


def _offset(d: pd.DataFrame, st: dict) -> np.ndarray:
    q = d[st["q"]].to_numpy()
    return logit(q) if st["link"] == "logit" else q


def nuisance(tr: pd.DataFrame, te: pd.DataFrame, st: dict, w_cols: list[str]) -> dict:
    """Fit g, D and r on `tr`; return l = offset + g, D and r for `te`."""
    obj = "binary" if st["link"] == "logit" else "regression"
    off_tr, off_te = _offset(tr, st), _offset(te, st)
    g = _boost(tr[w_cols], tr[st["y"]], off_tr, ROUNDS["g"], obj)
    l_tr = off_tr + g.predict(tr[w_cols], raw_score=True)
    d = _boost(tr[S_COLS], tr[st["y"]], l_tr, ROUNDS["D"], obj)
    weight = expit(l_tr) * (1 - expit(l_tr)) if st["link"] == "logit" else None
    r = _boost(tr[w_cols].assign(off=off_tr), d.predict(tr[S_COLS], raw_score=True), None,
               ROUNDS["r"], "regression", weight)  # fmt: skip
    return {"l": off_te + g.predict(te[w_cols], raw_score=True),
            "D": d.predict(te[S_COLS], raw_score=True),
            "r": r.predict(te[w_cols].assign(off=off_te))}  # fmt: skip


def penalty_matrix() -> np.ndarray:
    """Sum over adjacent counts (one ball or one strike apart) of (theta_c - theta_c')^2."""
    pen = np.zeros((12, 12))
    for i, (b, s) in enumerate(COUNTS):
        for j, (b2, s2) in enumerate(COUNTS):
            if abs(b - b2) + abs(s - s2) == 1:
                pen[i, i] += 1
                pen[i, j] -= 1
    return pen


def _mean(base, theta, count, x, link):
    eta = base + theta[count] * x
    return expit(eta) if link == "logit" else eta


def _info(p, x, count, link):
    w = p * (1 - p) if link == "logit" else np.ones_like(x)
    return np.bincount(count, w * x * x, minlength=12)


def fit_theta(y, base, x, count, lam, link) -> np.ndarray:
    """Penalized Newton (exact least squares for the linear link) for y ~ base + theta_c x."""
    theta, pen = np.ones(12), penalty_matrix()
    onehot = np.eye(12)[count]
    for _ in range(25):
        p = _mean(base, theta, count, x, link)
        grad = onehot.T @ ((y - p) * x) - lam * pen @ theta
        step = np.linalg.solve(np.diag(_info(p, x, count, link) + 1e-9) + lam * pen, grad)
        theta += step
        if np.abs(step).max() < 1e-7:
            break
    return theta


def _loss(y, p, link) -> float:
    if link == "linear":
        return float(np.sum((y - p) ** 2))
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return float(-np.sum(y * np.log(p) + (1 - y) * np.log(1 - p)))


def choose_lambda(y, base, x, count, fold, link) -> float:
    """The pooling penalty with the best batter-grouped CV loss."""
    scale = _info(_mean(base, np.zeros(12), count, x, link), x, count, link).mean()
    losses = {}
    for lam in LAMBDAS:
        losses[lam] = 0.0
        for k in np.unique(fold):
            tr, te = fold != k, fold == k
            th = fit_theta(y[tr], base[tr], x[tr], count[tr], lam * scale, link)
            losses[lam] += _loss(y[te], _mean(base[te], th, count[te], x[te], link), link)
    return min(losses, key=losses.get) * scale


def cluster_se(y, base, x, count, theta, batter, link) -> np.ndarray:
    """Batter-clustered sandwich SEs per count (ignores the pooling penalty's bias)."""
    p = _mean(base, theta, count, x, link)
    score = np.eye(12)[count] * ((y - p) * x)[:, None]
    meat = pd.DataFrame(score).groupby(batter).sum().to_numpy()
    inv = np.linalg.inv(np.diag(_info(p, x, count, link) + 1e-9))
    return np.sqrt(np.diag(inv @ meat.T @ meat @ inv))


def fit_parts(d: pd.DataFrame, st: dict, fold: np.ndarray, w_cols: list[str]) -> pd.DataFrame:
    """Cross-fitted l, D, r for every row of `d`, from other folds' committed swings in the
    stage's sample."""
    sample = ~d["fooled"] & (d[st["sample"]] if st["sample"] else True)
    out = pd.DataFrame(index=d.index, columns=["l", "D", "r"], dtype=float)
    for k in range(F.FOLDS):
        te = d[fold == k]
        out.loc[te.index] = pd.DataFrame(nuisance(d[(fold != k) & sample], te, st, w_cols),
                                         index=te.index)  # fmt: skip
    return out


def _theta_inputs(d: pd.DataFrame, parts: pd.DataFrame, st: dict):
    fit = (~d["fooled"] & (d[st["sample"]] if st["sample"] else True)).to_numpy()
    return (fit, d[st["y"]].to_numpy()[fit], (parts["l"] + parts["r"]).to_numpy()[fit],
            (parts["D"] - parts["r"]).to_numpy()[fit], d["count_idx"].to_numpy()[fit])  # fmt: skip


def fit_stage(d, st, fold, w_cols) -> tuple[pd.DataFrame, dict]:
    """Cross-fitted parts on every row, then theta on the committed swings in the sample."""
    parts = fit_parts(d, st, fold, w_cols)
    fit, y, base, x, cnt = _theta_inputs(d, parts, st)
    lam = choose_lambda(y, base, x, cnt, fold[fit], st["link"])
    theta = fit_theta(y, base, x, cnt, lam, st["link"])
    se = cluster_se(y, base, x, cnt, theta, d["batter"].to_numpy()[fit], st["link"])
    return parts, {"theta": theta.tolist(), "se": se.tolist(), "lambda": lam, "n": int(fit.sum())}


def score(d: pd.DataFrame, parts: pd.DataFrame, theta, link: str) -> pd.DataFrame:
    """Per-row path effect lo = theta_c (D - r), the full prediction, and PLV + g alone."""
    lo = np.asarray(theta)[d["count_idx"].to_numpy()] * (parts["D"] - parts["r"]).to_numpy()
    eta, loc = (parts["l"] + parts["r"]).to_numpy() + lo, parts["l"].to_numpy()
    full, plvg = (expit(eta), expit(loc)) if link == "logit" else (eta, loc)
    return pd.DataFrame({"l": loc, "D": parts["D"], "r": parts["r"], "lo": lo, "full": full,
                         "plvg": plvg}, index=d.index)  # fmt: skip


def run_crossfit(s: pd.DataFrame, split_hand: bool) -> tuple[pd.DataFrame, dict]:
    """Every model and stage, cross-fitted over all seasons; every swing scored."""
    fold, info = F._folds(s["batter"]), {}
    w_cols = [c for c in W_COLS if not (split_hand and c == "platoon")]
    for name, m in cells(s, split_hand):
        d = s[m]
        for stage, st in STAGES.items():
            parts, info[f"{name}/{stage}"] = fit_stage(d, st, fold[m], w_cols)
            sc = score(d, parts, info[f"{name}/{stage}"]["theta"], st["link"])
            s.loc[d.index, [f"{c}_{stage}" for c in sc.columns]] = sc.to_numpy()
            print(name, stage, "theta", np.round(info[f"{name}/{stage}"]["theta"], 2), flush=True)
    return s, info


def run_out_of_time(s: pd.DataFrame, test: int, info: dict, split_hand: bool) -> pd.DataFrame:
    """Fit on seasons before `test`, score `test` (evaluation only). Theta comes from
    cross-fitted parts within the training seasons, with the cross-fit run's penalty; the
    nuisances are then refit on all training rows to score the test season."""
    rows, w_cols = [], [c for c in W_COLS if not (split_hand and c == "platoon")]
    for name, m in cells(s, split_hand):
        d_tr, te = s[m & (s["season"] < test)], s[m & (s["season"] == test)]
        for stage, st in STAGES.items():
            parts = fit_parts(d_tr, st, F._folds(d_tr["batter"]), w_cols)
            fit, y, base, x, cnt = _theta_inputs(d_tr, parts, st)
            theta = fit_theta(y, base, x, cnt, info[f"{name}/{stage}"]["lambda"], st["link"])
            sample = te[st["sample"]] if st["sample"] else te.index == te.index
            ev = te[sample]
            full = pd.DataFrame(nuisance(d_tr[fit], ev, st, w_cols), index=ev.index)
            sc = score(ev, full, theta, st["link"])
            rows.append(sc.assign(model=name, stage=stage, y=ev[st["y"]], q=ev[st["q"]],
                                  fooled=ev["fooled"], batter=ev["batter"]))  # fmt: skip
            print("oot", name, stage, flush=True)
    return pd.concat(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--savant", required=True, help="glob of Savant pitch files (.parquet)")
    ap.add_argument("--plv", required=True, help="glob of score_pitches.py --probs outputs")
    ap.add_argument("--bip", required=True, help="batted_ball.py output")
    ap.add_argument("--test-season", type=int, help="also fit on earlier seasons, score this")
    ap.add_argument("--split-hand", action="store_true", help="six models: group x platoon")
    ap.add_argument("--out", required=True, help="per-swing output (.parquet)")
    a = ap.parse_args()
    s = build(a.savant, a.plv, a.bip)
    print(f"{len(s):,} swings; fooled {s['fooled'].mean():.3f}; {s['bip'].sum():,} BIP", flush=True)
    s, info = run_crossfit(s, a.split_hand)
    s.to_parquet(a.out)
    with open(a.out.replace(".parquet", "_theta.json"), "w") as f:
        json.dump(info, f, indent=1)
    if a.test_season:
        oot = run_out_of_time(s, a.test_season, info, a.split_hand)
        oot.to_parquet(a.out.replace(".parquet", "_oot.parquet"))


if __name__ == "__main__":
    main()
