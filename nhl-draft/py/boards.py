"""Per-draft VOR and ADP boards, after draft_sims/draftsim/combined_draft.py.

Neither rank is a fixed list with jitter on top; both are redrawn every draft, so a player's
spot moves for three compounding reasons - the market's uncertainty about where he goes, the
projections' uncertainty about what he produces, and which team is on the clock.

ADP rank  (draft_sim.draw_slots): each player with an ADP draws a simulated draft slot from a
    skew normal whose mean is exactly his ADP.  With ADP_Min / ADP_Max / ADP_N columns in the
    sheet the shape, scale and location are fitted from the observed range as draft_sim does
    (sd = (max - min) / (0.61 ln n + 2.235), skew from where ADP sits in the range, draws
    clipped at Min Pick); without them sd = (0.4217 - 0.056 ln ADP) * ADP (league.load_players'
    `ADP_sd`) with a fixed right skew, clipped at pick 1.  A player with no ADP is placed at
    Max(ADP) + 1 and drawn like everyone else.  Slots sorted ascending give the draft's ADP rank.

VOR rank  (vor_draft_sim.draw_points + replacement_levels): every scored stat is sampled and the
    draw is scored with the league coefficients; per-position replacement levels are recomputed
    from that same sample (each player at the position valuation.replacement_levels assigned
    him), VOR = value - replacement, sorted descending.  Skater stats ~ Normal(stat, sd) clipped
    at 0 (+/- unclipped, with a floor on its sd); goalies sample starts, save % and win rate and
    derive SV, GA and W from them, since sampling SV and GA independently spreads team SV% far
    more than projections ever miss by.  `<stat>_sd` columns in the sheet override the defaults.

team_boards: score = w * vor_rank + (1 - w) * adp_rank per team, ascending, ties to pool order.
"""
import math

import numpy as np

from league import STATS

A_LO, A_HI = -60.0, 60.0                       # bisection bracket for the skew parameter
ADP_ALPHA = 4.0                                # slot skew when the sheet has no pick range
STAT_CV = {"G": 0.25, "A": 0.25, "SOG": 0.20, "BLK": 0.25, "HIT": 0.25, "PPP": 0.35}
PM_SD_82 = 9.0                                 # +/- sd for an 82-game player, scaled by sqrt(GP/82)
GS_CV, SVPCT_SD, WRATE_SD = 0.15, 0.008, 0.06  # goalie components: starts, save %, wins per start


def mean_position(a, u_lo, u_hi):
    """Where a standard skew normal's mean falls between two quantiles."""
    from scipy.stats import skewnorm          # only the pick-range fit needs scipy
    lo, hi = skewnorm.ppf(u_lo, a), skewnorm.ppf(u_hi, a)
    return (skewnorm.mean(a) - lo) / (hi - lo)


def solve_shape(p_obs, u_lo, u_hi, tol=1e-6):
    """Bisect for alpha; mean_position decreases in alpha.  Clamps at the bracket ends."""
    lo, hi = A_LO, A_HI
    if p_obs >= mean_position(lo, u_lo, u_hi):
        return lo, True
    if p_obs <= mean_position(hi, u_lo, u_hi):
        return hi, True
    while hi - lo > tol:
        mid = 0.5 * (lo + hi)
        if mean_position(mid, u_lo, u_hi) > p_obs:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi), False


def skew_params(alpha, sd, mu):
    """(omega, xi, delta) so the skew normal has mean `mu`, sd `sd` and shape `alpha`."""
    delta = alpha / math.sqrt(1.0 + alpha * alpha)
    omega = sd / math.sqrt(1.0 - 2.0 * delta * delta / math.pi)
    return omega, mu - omega * delta * math.sqrt(2.0 / math.pi), delta


def fit_skewnorm(mu, lo_p, hi_p, n, sd):
    """(alpha, omega, xi, delta) matching ADP, the SD estimate and the observed skew."""
    alpha, _ = solve_shape((mu - lo_p) / (hi_p - lo_p), 1.0 / (n + 1.0), n / (n + 1.0))
    omega, xi, delta = skew_params(alpha, sd, mu)
    return alpha, omega, xi, delta


class AdpBoard:
    """Per-draft ADP ranks over the whole player pool.

    Every player draws a slot: those without an ADP sit at Max(ADP) + 1 (`ADP_fill`) and their
    sd comes from the same curve (`ADP_sd`), so they shuffle among themselves and occasionally
    ahead of the last listed players rather than being pinned to one slot.
    """

    def __init__(self, players, alpha=ADP_ALPHA):
        self.n = len(players)
        mu = np.asarray(players["ADP_fill"], float)
        sd = np.asarray(players["ADP_sd"], float)
        omega, xi, delta, min_pick, self.fitted = [], [], [], [], 0
        cols = {"ADP_Min", "ADP_Max", "ADP_N"} <= set(players.columns)
        for i in range(self.n):
            lo, hi, n = (players["ADP_Min"][i], players["ADP_Max"][i], players["ADP_N"][i]) if cols else (np.nan, np.nan, np.nan)
            if cols and np.isfinite([lo, hi, n]).all() and hi > lo and n >= 2:
                _, o, x, d = fit_skewnorm(mu[i], lo, hi, n, (hi - lo) / (0.61 * math.log(n) + 2.235))
                self.fitted += 1
            else:
                o, x, d = skew_params(alpha, sd[i], mu[i])
                lo = 1.0
            omega.append(o), xi.append(x), delta.append(d), min_pick.append(lo)
        self.omega, self.xi, self.delta = (np.array(v, float) for v in (omega, xi, delta))
        self.co_delta = np.sqrt(1.0 - self.delta ** 2)
        self.min_pick = np.array(min_pick, float)

    def draw(self, rng):
        """One draft's ADP rank for every player."""
        z = self.delta * np.abs(rng.standard_normal(self.n)) + self.co_delta * rng.standard_normal(self.n)
        slots = np.maximum(self.xi + self.omega * z, self.min_pick)
        rank = np.empty(self.n)
        rank[np.argsort(slots, kind="stable")] = np.arange(1, self.n + 1)
        return rank


class VorBoard:
    """Per-draft VOR ranks from resampled projections, replacement levels recomputed per draw."""

    def __init__(self, players, coef, league, assigned, cv_scale=1.0):
        self.mu = players.matrix(STATS)
        self.coef = np.asarray(coef, float)                        # in STATS order
        self.n = len(players)
        self.goalie = np.array([p == "G" for p in players["Pos_Y"]])
        self.skater = ~self.goalie
        # skater sds: `<stat>_sd` column if the sheet has one, else cv * stat; +/- floor by games
        gp = np.asarray(players["GP"], float) if "GP" in players else np.full(self.n, 82.0)
        self.sd = np.zeros_like(self.mu)
        for j, s in enumerate(STATS):
            if f"{s}_sd" in players:
                self.sd[:, j] = np.asarray(players[f"{s}_sd"], float)
            elif s == "+/-":
                self.sd[:, j] = PM_SD_82 * np.sqrt(np.clip(gp, 1, 82) / 82.0)
            elif s in STAT_CV:
                self.sd[:, j] = STAT_CV[s] * np.abs(self.mu[:, j])
        self.sd *= cv_scale
        self.j = {s: STATS.index(s) for s in STATS}
        # goalie components, derived from the projection
        g, m = self.goalie, self.mu
        gs, sv, ga, w = (m[g, self.j[k]] for k in ("GS", "SV", "GA", "W"))
        with np.errstate(invalid="ignore", divide="ignore"):
            self.g_gs, self.g_sa = gs, np.where(gs > 0, (sv + ga) / gs, 0.0)
            self.g_svp = np.where(sv + ga > 0, sv / (sv + ga), 0.9)
            self.g_wr = np.where(gs > 0, w / gs, 0.0)
        self.g_scale = cv_scale
        # per-position pools at the fixed assignment (valuation.replacement_levels)
        slots = league.league_slots()
        self.positions = [p for p in slots if p != "UTIL"]
        self.n_util = slots.get("UTIL", 0)
        self.cap = {p: slots[p] for p in self.positions}
        asg = np.asarray(assigned)
        self.pools = {p: np.flatnonzero(asg == p) for p in self.positions}
        self.pos_of = np.array([self.positions.index(p) for p in asg])

    def sample(self, rng):
        """One simulated season for every player (raw stats, same layout as STATS)."""
        s = np.clip(rng.normal(self.mu, self.sd), 0.0, None)
        s[:, self.j["+/-"]] = rng.normal(self.mu[:, self.j["+/-"]], self.sd[:, self.j["+/-"]])
        g, k = self.goalie, self.j
        gs = np.clip(rng.normal(self.g_gs, GS_CV * self.g_scale * self.g_gs), 0.0, None)
        svp = np.clip(rng.normal(self.g_svp, SVPCT_SD * self.g_scale), 0.80, 0.96)
        wr = np.clip(rng.normal(self.g_wr, WRATE_SD * self.g_scale), 0.0, 1.0)
        sa = gs * self.g_sa
        s[g, k["GS"]], s[g, k["SV"]], s[g, k["GA"]], s[g, k["W"]] = gs, sa * svp, sa * (1 - svp), gs * wr
        return s

    def replacement(self, value):
        """Per-position replacement values for one draw: slots filled from each pool, then the
        UTIL slots one at a time to the skater position whose next player is most valuable."""
        sorted_pools = {p: np.sort(value[q])[::-1] for p, q in self.pools.items()}
        filled = {p: min(self.cap[p], len(v)) for p, v in sorted_pools.items()}
        for _ in range(self.n_util):
            open_ = [p for p in self.positions if p != "G" and filled[p] < len(sorted_pools[p])]
            if not open_:
                break
            filled[max(open_, key=lambda p: sorted_pools[p][filled[p]])] += 1
        return np.array([sorted_pools[p][filled[p]] if filled[p] < len(sorted_pools[p]) else sorted_pools[p][-1]
                         for p in self.positions])

    def draw(self, rng):
        """One draft's (value, VOR, VOR rank) for every player."""
        value = self.sample(rng) @ self.coef
        vor = value - self.replacement(value)[self.pos_of]
        rank = np.empty(self.n)
        rank[np.argsort(-vor, kind="stable")] = np.arange(1, self.n + 1)
        return value, vor, rank


def team_boards(vr, sr, weights):
    """Each team's blended scores and board order over the shared ranks (ties -> pool order)."""
    w = np.asarray(weights)[:, None]
    scores = w * vr[None, :] + (1.0 - w) * sr[None, :]
    return scores, np.argsort(scores, axis=1, kind="stable")
