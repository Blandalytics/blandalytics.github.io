"""Recompute the SGP workings of one league independently and compare with calc.js.

    node sgp_dump.mjs hitters.csv pitchers.csv '<settings>' > dump.json
    python sgp_check.py hitters.csv pitchers.csv dump.json

From the raw CSVs and calc.js's drafted pool: the pool rates and marginal rate stats (Task 3),
the counting stats; then, with calc.js's draft order and contributions, the tier draft variance
(Task 5), the noise (Task 6: the procedure's placeholder, or the projections' percentiles), the
standings gain per unit (Task 7), SGP (Task 8) and the specialist correction (Task 9); and the
drafted pool against scipy's linear_sum_assignment over player × slot (Task 4). The functions
under "reference code" are the procedure's own.
"""
import json
import sys
from math import pi, sqrt

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment
from scipy.stats import norm

Z90 = 1.2815515655446004


# ---- reference code from generalized-sgp-procedure-ste.md ----
def draft_variance(values, x, n_teams):
    order = np.argsort(-np.asarray(values), kind="stable")
    xs = np.asarray(x, dtype=float)[order]
    full = (len(xs) // n_teams) * n_teams
    tiers = xs[:full].reshape(-1, n_teams)
    return tiers.var(axis=1, ddof=1).sum()


def noise_variance(x, n_teams, phi=1.0, cv_pt=0.15):
    x = np.asarray(x, dtype=float)
    return np.sum(phi * np.abs(x) + cv_pt**2 * x**2) / n_teams


def gain_per_unit(n_teams, var_draft, var_noise, var_strategy=0.0, fmt="roto", weeks=None):
    if fmt == "roto":
        C, P = n_teams - 1, 1
    elif fmt == "h2h":
        C, P = weeks, weeks
    elif fmt == "allplay":
        C, P = weeks * (n_teams - 1), weeks
    return C / (2 * sqrt(pi) * sqrt(var_draft + var_strategy + P * var_noise))


def specialist_sgp(delta, sigma, n_teams):
    return (n_teams - 1) * (norm.cdf(delta / (sqrt(2) * sigma)) - 0.5)


# ---- the league ----
hcsv, pcsv, dump_path = sys.argv[1:4]
dump = json.load(open(dump_path))
S = dump["settings"]
N = S["teams"]
H = pd.read_csv(hcsv, encoding="utf-8-sig")
P = pd.read_csv(pcsv, encoding="utf-8-sig")
if {"K", "BB"}.issubset(P.columns):
    P["K/BB"] = (P["K"] / P["BB"].clip(0.1, 1000)).round(2)
if {"W", "QS"}.issubset(P.columns):
    P["W+QS"] = P["W"] + P["QS"]

# rate stats as (numerator, denominator, lower is better)
RATES = {
    "h": {"AVG": (lambda d: d.H, lambda d: d.AB, False), "OBP": (lambda d: d.H + d.BB + d.HBP, lambda d: d.AB + d.BB + d.HBP + d.SF, False),
          "SLG": (lambda d: d.TB, lambda d: d.AB, False), "K%": (lambda d: d.K, lambda d: d.PA, True), "BB%": (lambda d: d.BB, lambda d: d.PA, False)},
    "p": {"ERA": (lambda d: d.ER, lambda d: d.IP / 9, True), "WHIP": (lambda d: d.BB + d.H, lambda d: d.IP, True),
          "K/9": (lambda d: d.K, lambda d: d.IP / 9, False), "K%": (lambda d: d.K, lambda d: d.TBF, False),
          "K/BB": (lambda d: d.K, lambda d: d.BB, False)},
}
INVERT = {"h": {"K", "CS", "SF"}, "p": {"BB", "H", "ER", "BS", "L", "HBP", "HR"}}
SLOT_TYPES = {"C": {"C"}, "1B": {"1B"}, "2B": {"2B"}, "3B": {"3B"}, "SS": {"SS"}, "CI": {"1B", "3B"}, "MI": {"2B", "SS"},
              "OF": {"OF", "LF", "CF", "RF"}, "UT": None, "SP": {"SP"}, "RP": {"RP"}, "P": None}
PROPORTION = {"AVG", "OBP", "K%", "BB%"}

ok = True


def check(label, mine, theirs, tol=1e-9):
    global ok
    mine, theirs = np.asarray(mine, dtype=float), np.asarray(theirs, dtype=float)
    err = np.nanmax(np.abs(mine - theirs) / np.maximum(1, np.abs(theirs)))
    good = err <= tol
    ok &= bool(good)
    print(f"  {'ok ' if good else 'BAD'} {label}: max rel diff {err:.1e}")


for side, D in (("h", H), ("p", P)):
    d = dump[side]
    pool = np.array(d["pool"])
    vol = D["PA" if side == "h" else "IP"].fillna(0).to_numpy()
    vsd = None
    vcol = "PA" if side == "h" else "IP"
    if f"{vcol}_p10" in D:
        vsd = ((D[f"{vcol}_p90"] - D[f"{vcol}_p10"]) / (2 * Z90)).to_numpy()
    cv = np.where((vsd is not None) & (vol > 0), (vsd if vsd is not None else 0) / np.where(vol > 0, vol, 1), 0.15)
    print(f"{side}: {len(pool)} in the pool")
    var_draft, var_noise = [], []
    for k, cat in enumerate(d["cats"]):
        own_js = np.array(d["own"][k], dtype=float)
        if cat in RATES[side]:
            num_f, den_f, lower = RATES[side][cat]
            num, den = num_f(D).fillna(0).to_numpy(), den_f(D).fillna(0).to_numpy()
            r = num[pool].sum() / den[pool].sum()
            check(f"{cat} pool rate {r:.4f}", r, d["rates"][k])
            own = (r * den - num) if lower else (num - r * den)
        else:
            raw = D[cat].fillna(0).to_numpy()
            own = -raw if cat in INVERT[side] else raw
        check(f"{cat} contributions (Task 3)", own, own_js)
        x = np.array(d["x"][k], dtype=float)
        # Task 5: tiers of N in draft order, catchers apart when they have their own slots
        slots = np.array([t if t is not None else "" for t in d["poolSlot"]])
        values = np.array(d["order"], dtype=float)
        groups = [pool]
        if side == "h" and S["slots"].get("C", 0) > 0:
            groups = [pool[slots[pool] == "C"], pool[slots[pool] != "C"]]
        vd = sum(draft_variance(values[g], x[g], N) for g in groups)
        check(f"{cat} draft variance (Task 5)", vd, d["sigmaDraft"][k])
        # Task 6: the projections' 10th/90th percentiles, else the placeholder
        if f"{cat}_p10" in D:
            sd = ((D[f"{cat}_p90"] - D[f"{cat}_p10"]) / (2 * Z90)).to_numpy()
            if cat in RATES[side]:
                rate = np.where(den > 0, num / np.where(den > 0, den, 1), 0)
                var = (den * sd) ** 2 + ((rate - r) * den * cv) ** 2
            else:
                var = sd**2
            nu = var[pool].sum() / N
        elif cat in RATES[side]:
            count = num * (1 - num / np.where(den > 0, den, 1)) if cat in PROPORTION else np.abs(num)
            nu = (np.maximum(0, count[pool]) + (cv[pool] * own[pool]) ** 2).sum() / N
        else:
            per_player_cv = np.allclose(cv, 0.15)
            nu = noise_variance(raw[pool], N) if per_player_cv else (np.abs(raw[pool]) + (cv[pool] * own[pool]) ** 2).sum() / N
        check(f"{cat} noise (Task 6)", nu, d["nu"][k])
        var_draft.append(vd)
        var_noise.append(nu)
    # Task 7 and 8
    G = [gain_per_unit(N, vd, vn, fmt=S["format"], weeks=S["weeks"]) for vd, vn in zip(var_draft, var_noise)]
    # a pool that settled on a cycle of marginal swaps carries the cycle's mean weights (within 3%)
    check("standings gain per unit G (Task 7)" + (", the mean over a settled cycle" if d["averaged"] else ""),
          G, d["G"], tol=0.03 if d["averaged"] else 1e-9)
    x = np.array(d["x"], dtype=float)
    Gj = np.array(d["G"])
    check("SGP (Task 8)", (Gj[:, None] * x).sum(axis=0), d["score"])
    # Task 4 + 9: over each player's replacement, specialists curved (roto)
    levels = {l["slot"]: l for l in d["levels"]}
    deep = max(d["levels"], key=lambda l: l["level"])
    sigma = np.sqrt(np.array(d["sigmaDraft"]) + np.array(d["nu"]))
    sgpar = []
    for i in range(x.shape[1]):
        lv = levels[d["valuedAt"][i]] if d["valuedAt"][i] else deep
        delta = x[:, i] - np.array(lv["vec"])
        parts = Gj * delta
        if S["format"] == "roto" and S.get("specialists", True) and S["style"] != "Points":
            parts = np.array([specialist_sgp(dl, sg, N) if dl > 0.5 * sg else p for dl, sg, p in zip(delta, sigma, parts)])
        v = parts.sum()
        sgpar.append(min(0, v) if d["valuedAt"][i] is None else v)
    # calc.js's normal CDF is Abramowitz & Stegun's, good to 1.5e-7
    check("SGP above replacement, specialists corrected (Tasks 4, 9)", sgpar, d["sgpar"], tol=1e-6)
    # Task 4: the drafted pool is the most valuable assignment of players to every slot
    score = np.array(d["score"], dtype=float)
    pos = D["Y! Pos"].fillna("UT" if side == "h" else "P").astype(str).str.upper().str.split(r"[,/ ]+") if "Y! Pos" in D \
        else pd.Series([["P"]] * len(D))
    slots = [t for t, n in d["caps"].items() for _ in range(n)]
    cost = np.full((len(D), len(slots)), 1e9)
    for j, t in enumerate(slots):
        ok_t = pos.map(lambda toks: SLOT_TYPES[t] is None or bool(SLOT_TYPES[t] & set(toks))).to_numpy()
        cost[ok_t, j] = -score[ok_t]
    rows, _ = linear_sum_assignment(cost)
    best = score[rows].sum()
    mine = sum(score[i] for i, t in enumerate(d["finalSlot"]) if t is not None)
    check(f"drafted pool value {mine:.4f} against linear_sum_assignment (Task 4)", mine, best)
    same = set(rows) == {i for i, t in enumerate(d["finalSlot"]) if t is not None}
    print(f"  {'ok ' if same else 'tie'} same players as linear_sum_assignment: {same}")
print("OK" if ok else "MISMATCH")
sys.exit(0 if ok else 1)
