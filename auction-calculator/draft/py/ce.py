"""The certainty equivalent of risk.js (the specification's section 6.4), joined to the engine's M, S, H.

risk.js prices each player's season draws before the draft: EffValue (eff) and Var_eff (var_eff) in SGP
above replacement, and CE for an average team (M, S, H from the calculator's team-total model).  In a
draft the objective belongs to the user's team and moves with every pick (the plan's R8 step 2): the
engine's baseline at each stop (the pass, or the skip) gives M and S of the user's team and H of the
payout.  This module recomputes CE with them, with the same formulas and the same switch to the exact
probability gain as risk.js, and prices it in dollars as risk.js does (dollarsOf, the calculator's own
prices).  Pure Python (math only), so it runs in Pyodide.

    ce(eff, var_eff, M, S, H)                  -> CE in SGP (the payout's units)
    dollars_of(x, drafted, pricing, gamma, min_bid, cap=False)   -> $ (risk.js dollarsOf)
"""

import math

SQRT2 = math.sqrt(2.0)
SQRT2PI = math.sqrt(2.0 * math.pi)
EXACT_ABOVE = 0.4  # risk.js: the exact gain when sqrt(Var_eff) > 0.4 S (spec 6.4)


def phi(x):
    return math.exp(-0.5 * x * x) / SQRT2PI


def Phi(x):
    """The standard normal CDF (math.erfc keeps the tails accurate)."""
    if x != x:
        return math.nan
    return 0.5 * math.erfc(-x / SQRT2)


def Phi_inv(p):
    """Acklam's rational approximation, then one Halley step on Phi (as risk.js PhiInv)."""
    if not p > 0:
        return -math.inf
    if not p < 1:
        return math.inf
    a = (-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239)
    b = (-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572)
    c = (-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783)
    d = (0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416)

    def tail(q):
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)

    if p < 0.02425:
        x = tail(math.sqrt(-2 * math.log(p)))
    elif p > 1 - 0.02425:
        x = -tail(math.sqrt(-2 * math.log(1 - p)))
    else:
        q = p - 0.5
        r = q * q
        x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (
            ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1
        )
    u = (Phi(x) - p) * SQRT2PI * math.exp(x * x / 2)
    return x - u / (1 + x * u / 2)


def certainty_equivalent(value, var_eff, M, S, H):
    """value - (z / 2S) Var_eff, z = (M - H) / S (spec 6.4)."""
    z = (M - H) / S
    return value - (z / (2 * S)) * var_eff


def exact_certainty(mu, v, M, S, H):
    """The certain value with the exact probability gain of a player of mean mu and variance v."""
    z = (M - H) / S
    gain = Phi((M + mu - H) / math.sqrt(S * S + v)) - Phi(z)
    p = min(1 - 1e-15, max(1e-300, Phi(z) + gain))
    return S * (Phi_inv(p) - z)


def ce(eff, var_eff, M, S, H):
    """CE of a player of effective value eff and effective variance var_eff for a team of mean M and
    SD S against the target H; the exact gain when his SD is more than 0.4 S (as risk.js applyRisk)."""
    if not (math.isfinite(eff) and math.isfinite(var_eff) and math.isfinite(M) and math.isfinite(H)) or not S > 0:
        return math.nan
    if math.sqrt(max(0.0, var_eff)) > EXACT_ABOVE * S:
        return exact_certainty(eff, var_eff, M, S, H)
    return certainty_equivalent(eff, var_eff, M, S, H)


def dollars_of(x, drafted, pricing, gamma, min_bid, cap=False):
    """risk.js dollarsOf: the calculator's dollars for SGP above replacement x on a side, from its
    pricing {base, k, perSGP, flat} along the dollar curve gamma."""
    if not math.isfinite(x):
        return math.nan
    u = x - pricing["base"]
    rate = pricing["k"] * u ** (gamma - 1) if u > 0 else pricing["perSGP"]
    d = min_bid + u * rate
    if drafted:
        return d + pricing["flat"]
    return min(d, min_bid - 0.01) if cap else d
