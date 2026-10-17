"""The pitcher-quality axis behind the Lineup Sim's hypothetical pitcher (Scrub - Average - Ace).

    python -I tools/lineup_sims/quality_axis.py 2026     # writes lineup-sims/data/2026-quality.json

Inputs, already built: lineup-sims/data/<season>.json (build.py) and lineup-sims/data/<season>-pitch.json
(pitch_model.py). Each model gets its own axis; both are stepped in standard deviations of 2026
pitchers' talent (wOBA allowed), so a setting is as good a pitcher in either model and differs only
in how he gets there.

Per-PA: the eleven outcome rates of every pitcher with MIN_BF+ batters faced. Their covariance
across pitchers (weighted by batters faced) less what sampling alone would give (one PA's
multinomial covariance at the league's rates, over each pitcher's batters faced) is the talent
covariance T. The axis, per SD toward the ace end, is -T wv / sqrt(wv' T wv) (wv the wOBA weights):
the change in each rate that comes with a pitcher one talent SD better, given only his wOBA
allowed. It sums to zero, so a moved profile still adds up to 1. The page moves an MLB-average
RHP's or LHP's rates (and each platoon cell's) by theta times it.

Per-Pitch: the per-pitch model's pitchers (their shrunk ratios: 13 log numbers each, platoon splits
off) regressed on the model's own wOBA allowed against an MLB-average hitter (the count chain),
weighted by batters faced. A setting theta is the ratios exp(s * slope), s found so that the chain's
wOBA allowed is the average's less theta talent SDs (one s per tenth of the slider's range).

The reach: as far as 2026 regulars (ANCHOR_BF+) go toward the nearer end, each at his wOBA allowed
shrunk toward the mean by its reliability, to the tenth; capped at CAP and where an MLB-average
RHP's or LHP's rate in some cell would go below zero.
"""
import argparse
import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # `python -I` leaves it off
import pitch_model as pm  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
MIN_BF, ANCHOR_BF, CAP = 100, 300, 3.0


def per_pa(data, wv):
    rows = [r for r in data["pitchers"] if r[5] >= MIN_BF]
    X = np.array([r[4] for r in rows], float)
    n = X.sum(1)
    R = X / n[:, None]
    wt = n / n.sum()
    mean = wt @ R
    D = R - mean
    S = (D * wt[:, None]).T @ D
    lg = np.array(data["pitching"]["league"], float)
    lg /= lg.sum()
    one = np.diag(lg) - np.outer(lg, lg)        # one PA's covariance
    T = S - one * (len(rows) / n.sum())         # less sampling: sum over pitchers of wt * one / n
    var = float(wv @ T @ wv)
    sd = np.sqrt(var)
    per_sd = -(T @ wv) / sd
    assert abs(per_sd.sum()) < 1e-12 and abs(per_sd @ wv + sd) < 1e-12
    # regulars' places on it: wOBA allowed shrunk by its reliability, in talent SDs (ace +)
    woba = R @ wv
    score = -(woba - mean @ wv) * (var / (var + (wv @ one @ wv) / n)) / sd
    regulars = sorted((float(score[i]), rows[i][0], rows[i][1], int(n[i]), float(woba[i])) for i in range(len(rows)) if n[i] >= ANCHOR_BF)
    reach = min(CAP, round(min(-regulars[0][0], regulars[-1][0]), 1))
    for hand in "RL":
        for side in "LR":
            c = np.array(data["pitching"]["cells"][hand + side], float)
            p = c / c.sum()
            for i, x in enumerate(per_sd):
                if x:
                    reach = min(reach, p[i] / abs(x))
    rng = float(np.floor(reach * 10) / 10)
    return {"per_sd": [float(x) for x in per_sd], "sd": sd, "woba": float(mean @ wv), "observed_sd": float(np.sqrt(wv @ S @ wv)),
            "pitchers": len(rows)}, rng, regulars


def per_pitch(P, bf, wv, sd, rng):
    tabs = {name: np.array(t, float).reshape(ctx, K) for (name, K, ctx), t in zip(pm.STEPS, P["tables"]["all"])}
    one = pm.expand(None)
    w_avg = float(pm.chances(tabs, one, one) @ wv)
    ids = [k for k in P["pitchers"] if bf.get(int(k), 0) >= MIN_BF]
    LR = np.log(np.array([P["pitchers"][k]["a"] for k in ids], float))
    w = np.array([pm.chances(tabs, one, pm.expand(np.array(P["pitchers"][k]["a"], float))) @ wv for k in ids])
    m = np.array([bf[int(k)] for k in ids], float)
    m /= m.sum()
    A = np.column_stack([np.ones(len(ids)), w])
    beta = np.linalg.solve(A.T @ (A * m[:, None]), A.T @ (LR * m[:, None]))
    slope = -beta[1]                              # log ratios per unit of wOBA allowed, toward the ace end

    def woba_at(s):
        return float(pm.chances(tabs, one, pm.expand(np.exp(s * slope))) @ wv)

    def step(theta):
        target, lo, hi = w_avg - theta * sd, -1.0, 1.0
        assert woba_at(lo) > target > woba_at(hi)
        for _ in range(80):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if woba_at(mid) > target else (lo, mid)
        return (lo + hi) / 2

    k = round(rng * 10)
    steps = [step(i / 10) for i in range(-k, k + 1)]
    # one SD toward the ace end, in outcomes against an MLB-average hitter (for the page's words)
    per_sd = pm.chances(tabs, one, pm.expand(np.exp(steps[k + 10] * slope))) - pm.chances(tabs, one, one)
    return {"slope": [float(x) for x in slope], "steps": steps, "woba": w_avg, "per_sd": [float(x) for x in per_sd],
            "model_sd": float(np.sqrt(m @ (w - m @ w) ** 2)), "pitchers": len(ids)}


def main(season):
    data = json.loads((REPO / "lineup-sims" / "data" / f"{season}.json").read_text(encoding="utf-8"))
    P = json.loads((REPO / "lineup-sims" / "data" / f"{season}-pitch.json").read_text(encoding="utf-8"))
    w = data["weights"]
    wv = np.array([0, w["wBB"], w["wHBP"], w["w1B"], w["w2B"], w["w3B"], w["wHR"], 0, 0, 0, 0])
    pa, rng, regulars = per_pa(data, wv)
    pitch = per_pitch(P, {r[0]: r[5] for r in data["pitchers"]}, wv, pa["sd"], rng)
    end = lambda rs: [[pid, name, round(s, 2), bf, round(wo, 3)] for s, pid, name, bf, wo in rs]  # noqa: E731
    out = {"season": int(season), "min_bf": MIN_BF, "anchor_bf": ANCHOR_BF, "range": rng, "pa": pa, "pitch": pitch,
           "ends": {"scrub": end(regulars[:4]), "ace": end(regulars[-4:][::-1])}}
    dest = REPO / "lineup-sims" / "data" / f"{season}-quality.json"
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    cats = data["cats"]
    print(f"talent SD of wOBA allowed {pa['sd']:.4f} (observed {pa['observed_sd']:.4f}, {pa['pitchers']} pitchers); range +/-{rng}")
    print("per-PA, per SD toward ace (pts):", {c: round(100 * x, 2) for c, x in zip(cats, pa["per_sd"])})
    print("ends:", [e[1] for e in out["ends"]["ace"]], [e[1] for e in out["ends"]["scrub"]])
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("season")
    main(ap.parse_args().season)
