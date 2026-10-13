"""The risk-aware valuation's reference code (risk-aware-valuation-parameters.md, section 9) on a grid
of inputs, for risk_checks.mjs to check auction-calculator/risk.js against.

    python -I risk_ref.py [path/to/risk_reference.py] < grid.json > out.json

grid.json: [{"fn": "option_value", "args": [0.5, 3, 0]}, ...]; out.json: the values, in order.
With a path, the functions come from that file (the specification bundle's code/risk_reference.py);
without one, from the copy below (the specification's section 9, unchanged).
"""

import importlib.util
import json
import sys
from math import sqrt

import numpy as np  # noqa: F401  (as in the specification)
from scipy.stats import norm


# ---- the specification's section 9, unchanged ----------------------------------------------------
def option_value(mu, sigma, r):
    """E[max(V, r)] for V ~ N(mu, sigma^2)."""
    if sigma <= 0:
        return max(mu, r)
    d = (mu - r) / sigma
    return mu * norm.cdf(d) + r * norm.cdf(-d) + sigma * norm.pdf(d)


def truncated_variance(mu, sigma, r):
    """Var[max(V, r)] for V ~ N(mu, sigma^2)."""
    d = (mu - r) / sigma  # noqa: F841
    m1 = option_value(mu, sigma, r)
    # E[max(V,r)^2] = E[V^2; V>r] + r^2 P(V<=r)
    a = (r - mu) / sigma
    ev2_above = (mu**2 + sigma**2) * norm.sf(a) + (mu + r) * sigma * norm.pdf(a)
    m2 = ev2_above + r**2 * norm.cdf(a)
    return m2 - m1**2


def effective_value(mu, sigma, r, lam):
    """lam = share of season played before a bust is visible."""
    return lam * mu + (1 - lam) * option_value(mu, sigma, r)


def certainty_equivalent(value, var_eff, team_mean, team_sd, target):
    """value - (z / 2S) * var_eff, z = (M - H) / S."""
    z = (team_mean - target) / team_sd
    return value - (z / (2 * team_sd)) * var_eff


def risk_adjusted_surplus(mu, sigma, r, lam, cost, team_mean, team_sd, target, cov_with_roster=0.0):
    ev = effective_value(mu, sigma, r, lam)
    var_eff = (lam * sigma) ** 2 + ((1 - lam) ** 2) * truncated_variance(mu, sigma, r) + 2 * cov_with_roster
    return certainty_equivalent(ev, var_eff, team_mean, team_sd, target) - cost


def exact_prob_gain(mu, var, team_mean, team_sd, target):
    """Exact change in P(team >= target) from adding one independent player."""
    before = norm.cdf((team_mean - target) / team_sd)
    after = norm.cdf((team_mean + mu - target) / sqrt(team_sd**2 + var))
    return after - before


# ---------------------------------------------------------------------------------------------------


def load(path):
    spec = importlib.util.spec_from_file_location("risk_reference", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


if __name__ == "__main__":
    ref = load(sys.argv[1]) if len(sys.argv) > 1 else sys.modules[__name__]
    grid = json.load(sys.stdin)
    print(json.dumps([float(getattr(ref, g["fn"])(*g["args"])) for g in grid]))
