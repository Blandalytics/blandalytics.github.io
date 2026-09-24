"""Standings-gain-point (SGP) valuation.

  1. sgp_slopes        - from simulated leagues: stat units per standings place, by category
  2. coefficients      - standings places per unit of each raw stat (SV% / GAA split into SV, GA, GS)
  3. category_values   - each player's standings-place contribution by category
  4. replacement_levels / position_values - per-position replacement levels and VORP
"""
import numpy as np

from league import CATS, LOWER_IS_BETTER, SKATER_CATS, STATS


def order_desc(values):
    """Row order, largest first, with ties in the order pandas' sort_values(ascending=False)
    gives them (its nargsort: argsort the reversed array, then reverse)."""
    values = np.asarray(values)
    idx = np.arange(len(values))[::-1]
    return idx[values[::-1].argsort(kind="quicksort")][::-1]


def sgp_slopes(totals_list):
    """Stat units per standings place in each category.

    For every simulated league the team totals are sorted worst -> best and regressed on
    place 1..n; the slope is averaged over simulations.  Also returns the league-average
    team goalie workload and ratios used to linearise SV% and GAA.

    totals_list: one {cat: array over teams} per league.  Returns ({cat: mean slope},
    {cat: sd of the slope}, params).
    """
    n = len(totals_list[0]["SV"])
    place = np.arange(1, n + 1)
    slopes = {c: [] for c in CATS}
    for tot in totals_list:
        for c in CATS:
            v = np.sort(tot[c])
            if c in LOWER_IS_BETTER:          # place 1 = worst, so the fitted slope is negative
                v = v[::-1]
            slope = np.polyfit(place, v, 1)[0]
            slopes[c].append(-slope if c in LOWER_IS_BETTER else slope)   # improvement per place > 0
    allt = {k: np.concatenate([t[k] for t in totals_list]) for k in ("SV", "_GA", "_GS")}
    params = {
        "team_SA": float((allt["SV"] + allt["_GA"]).mean()),          # shots against per team
        "team_GS": float(allt["_GS"].mean()),                          # starts per team
        "lg_SVpct": float(allt["SV"].sum() / (allt["SV"] + allt["_GA"]).sum()),
        "lg_GAA": float(allt["_GA"].sum() / allt["_GS"].sum()),
    }
    mean = {c: float(np.mean(slopes[c])) for c in CATS}
    sd = {c: float(np.std(slopes[c], ddof=1)) for c in CATS}
    return mean, sd, params


def coefficients(d, p):
    """Standings places per unit of each raw stat.

    Counting categories: 1 / slope.  The ratio categories are linearised around the
    league-average team (SA shots against, GS starts):
        team SV% - lg SV%  ~  sum_g [ SV_g - lgSV% * (SV_g + GA_g) ] / SA
        team GAA - lg GAA  ~  sum_g [ GA_g - lgGAA * GS_g ]          / GS
    so SV, GA and GS each carry a share of the SV% and GAA slopes; GA's coefficient is the
    sum of its SV% and GAA effects.  Returns (coef: array in STATS order, parts: stat -> {cat: coef}).
    """
    k_svp = 1.0 / (p["team_SA"] * d["SV%"])
    k_gaa = 1.0 / (p["team_GS"] * d["GAA"])
    parts = {c: {c: 1.0 / d[c]} for c in SKATER_CATS + ["W"]}
    parts["SV"] = {"SV": 1.0 / d["SV"], "SV%": (1.0 - p["lg_SVpct"]) * k_svp}
    parts["GA"] = {"SV%": -p["lg_SVpct"] * k_svp, "GAA": -k_gaa}
    parts["GS"] = {"GAA": p["lg_GAA"] * k_gaa}
    coef = np.array([sum(parts[s].values()) for s in STATS])
    return coef, parts


def category_values(players, parts):
    """Standings places each player contributes in each scoring category: [n, len(CATS)]."""
    out = np.zeros((len(players), len(CATS)))
    for stat, share in parts.items():
        for cat, k in share.items():
            out[:, CATS.index(cat)] += k * players[stat]
    return out


def replacement_levels(players, value, league, tol=0.05, max_pass=30):
    """Per-position replacement levels.

    Every player is assigned to exactly one position - the scarcest (lowest replacement value)
    of those they are eligible for - and each position's pool is ranked by value.  The
    position's slots are filled from its pool, then the UTIL slots go one at a time to the
    skater position whose next player is most valuable.  The replacement level is the first
    player in the pool left outside those slots.

    Multi-eligible players are moved one at a time (levels recomputed after every move, and a
    move needs an improvement of more than `tol`) until no player can improve; moving them all
    at once would flip which position is scarcer and oscillate.

    Returns (repl: slot -> value, with UTIL = the best replacement among skater positions;
             starter: bool array; repl_pid: slot -> replacement player; assigned: position per player).
    """
    slots = league.league_slots()
    positions = [s for s in slots if s != "UTIL"]
    n_util = slots.get("UTIL", 0)
    pidx = {p: i for i, p in enumerate(positions)}
    value = np.asarray(value, float)
    order = order_desc(value)
    v = value[order]                                                      # values, best first
    elig = [tuple(pidx[s] for s in players["slots"][pid] if s != "UTIL") for pid in order]
    asg = np.array([e[0] for e in elig])                                  # start at the primary position
    cap = np.array([slots[p] for p in positions])
    skater = np.array([p != "G" for p in positions])

    def levels():
        pools = [np.flatnonzero(asg == i) for i in range(len(positions))]
        filled = np.minimum(cap, [len(q) for q in pools])
        for _ in range(n_util):
            nxt = [v[q[f]] if skater[i] and f < len(q) else -np.inf for i, (q, f) in enumerate(zip(pools, filled))]
            i = int(np.argmax(nxt))
            if nxt[i] == -np.inf:
                break
            filled[i] += 1
        repl = np.array([v[q[f]] if f < len(q) else v[-1] for q, f in zip(pools, filled)])
        return pools, filled, repl

    pools, filled, repl = levels()
    for _ in range(max_pass):
        moved = 0
        for k, e in enumerate(elig):
            if len(e) > 1:
                best = min(e, key=lambda i: (repl[i], e.index(i)))
                if repl[best] < repl[asg[k]] - tol:
                    asg[k] = best
                    moved += 1
                    pools, filled, repl = levels()
        if not moved:
            break
    starter = np.zeros(len(players), bool)
    repl_out, repl_pid = {}, {}
    for i, p in enumerate(positions):
        q, f = pools[i], filled[i]
        starter[order[q[:f]]] = True
        repl_out[p] = float(repl[i])
        repl_pid[p] = order[q[f]] if f < len(q) else order[q[-1]]
    util_pos = max((p for p in positions if p != "G"), key=repl_out.__getitem__)
    repl_out["UTIL"], repl_pid["UTIL"] = repl_out[util_pos], repl_pid[util_pos]
    assigned = np.empty(len(players), dtype=object)
    assigned[order] = [positions[i] for i in asg]
    return repl_out, starter, repl_pid, assigned


def position_values(players, value, repl, assigned):
    """Replacement level at each player's assigned (scarcest eligible) position, Position Value
    and VORP.

    Position Value = repl[UTIL] - repl[position]: the extra standings value an identical stat
    line earns at a scarcer position than the deepest skater position (which sets the UTIL
    replacement).  For goalies it compares the goalie pool with the skater pool on the same
    footing, so VORP = value - repl[UTIL] + Position Value holds for every player.
    """
    r = np.array([repl[a] for a in assigned], float)
    return {"BestSlot": assigned, "Repl": r, "PosValue": repl["UTIL"] - r, "VORP": np.asarray(value, float) - r}
