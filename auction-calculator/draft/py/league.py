"""League settings, Yahoo slot eligibility, categories and scoring for the MLB draft engine.

numpy only (no pandas, no scipy), so the same code runs in Pyodide.

Slots follow the calculator (calc.js SLOT_TYPES, PITCHER_SLOT_TYPES): a slot takes anyone eligible at
one of its positions; UT takes any hitter and P any pitcher.  A player's *signature* is the tuple of
the league's slot types he can fill; legality works per signature (engine.py).

Categories are built from *components*: counts summed over a team's starters.  A count category is one
component; a rate category is numerator / denominator x scale (AVG = H / AB, ERA = 9 ER / IP,
WHIP = (BB + H) / IP).  Roto: rank points per category (best = teams, ties averaged).  Head-to-head:
weekly matchups approximated from the season totals (h2h_odds; DESIGN.md section 6).
"""

import math
from dataclasses import dataclass, field

import numpy as np

HITTER_SLOTS = {"C": ("C",), "1B": ("1B",), "2B": ("2B",), "3B": ("3B",), "SS": ("SS",), "CI": ("1B", "3B"),
                "MI": ("2B", "SS"), "OF": ("OF", "LF", "CF", "RF"), "UT": None}  # fmt: skip
PITCHER_SLOTS = {"SP": ("SP",), "RP": ("RP",), "P": None}
SLOT_ORDER = list(HITTER_SLOTS) + list(PITCHER_SLOTS) + ["BN"]

# component name -> (side, function of a stats dict).  Stats are the risk file's names (calc's HD = HLD).
COMPONENTS = {
    "R": ("h", lambda s: s["R"]), "HR": ("h", lambda s: s["HR"]), "RBI": ("h", lambda s: s["RBI"]),
    "SB": ("h", lambda s: s["SB"]), "H": ("h", lambda s: s["H"]), "AB": ("h", lambda s: s["AB"]),
    "BB": ("h", lambda s: s["BB"]), "TB": ("h", lambda s: s["H"] + s["2B"] + 2 * s["3B"] + 3 * s["HR"]),
    "OB": ("h", lambda s: s["H"] + s["BB"] + s["HBP"]), "OBD": ("h", lambda s: s["AB"] + s["BB"] + s["HBP"] + s["SF"]),
    "W": ("p", lambda s: s["W"]), "SV": ("p", lambda s: s["SV"]), "K": ("p", lambda s: s["K"]),
    "QS": ("p", lambda s: s["QS"]), "HLD": ("p", lambda s: s["HLD"]), "SVH": ("p", lambda s: s["SV"] + s["HLD"]),
    "L": ("p", lambda s: s["L"]), "ER": ("p", lambda s: s["ER"]), "IP": ("p", lambda s: s["IP"]),
    "BBH": ("p", lambda s: s["BB"] + s["H"]),
}  # fmt: skip
# category -> (side, components (count: 1, rate: numerator, denominator), scale, sign (+1 more is better), proportion)
CATEGORIES = {
    "R": ("h", ("R",), 1, 1, False), "HR": ("h", ("HR",), 1, 1, False), "RBI": ("h", ("RBI",), 1, 1, False),
    "SB": ("h", ("SB",), 1, 1, False), "H": ("h", ("H",), 1, 1, False), "BB": ("h", ("BB",), 1, 1, False),
    "TB": ("h", ("TB",), 1, 1, False),
    "AVG": ("h", ("H", "AB"), 1, 1, True), "OBP": ("h", ("OB", "OBD"), 1, 1, True), "SLG": ("h", ("TB", "AB"), 1, 1, False),
    "W": ("p", ("W",), 1, 1, False), "SV": ("p", ("SV",), 1, 1, False), "K": ("p", ("K",), 1, 1, False),
    "QS": ("p", ("QS",), 1, 1, False), "HD": ("p", ("HLD",), 1, 1, False), "SV+H": ("p", ("SVH",), 1, 1, False),
    "L": ("p", ("L",), 1, -1, False),
    "ERA": ("p", ("ER", "IP"), 9, -1, False), "WHIP": ("p", ("BBH", "IP"), 1, -1, False), "K/9": ("p", ("K", "IP"), 9, 1, False),
}  # fmt: skip
CV_GAMES = 0.10  # weekly spread of a team's games (lineup days, starts) as a share of its weekly count


@dataclass
class League:
    teams: int = 12
    slots: dict = field(default_factory=lambda: {"C": 1, "1B": 1, "2B": 1, "3B": 1, "SS": 1, "OF": 3, "UT": 2})
    pslots: dict = field(default_factory=lambda: {"SP": 2, "RP": 2, "P": 4})
    bench: int = 5
    budget: int = 260
    min_bid: int = 1
    format: str = "roto"  # "roto" or "h2h" (head-to-head each category)
    weeks: int = 23  # scoring periods, playoffs included
    playoff_teams: int = 6
    hitter_cats: tuple = ("R", "HR", "RBI", "SB", "AVG")
    pitcher_cats: tuple = ("W", "SV", "K", "ERA", "WHIP")
    phi: float = 1.0  # count noise of a week, as calc.js's phi (variance = phi x count)

    @classmethod
    def from_settings(cls, s, **over):
        """From the table's settings (table.js); `over` sets the draft's own options."""
        kw = dict(teams=int(s["teams"]), slots={k: int(v) for k, v in s["slots"].items() if int(v) > 0},
                  pslots={k: int(v) for k, v in s["pitcherSlots"].items() if int(v) > 0}, bench=int(s["bench"]),
                  budget=int(s["budget"]), min_bid=int(s["minBid"]), weeks=int(s.get("weeks", 23)),
                  hitter_cats=tuple(s["hitterCats"]), pitcher_cats=tuple(s["pitcherCats"]), phi=float(s.get("phi", 1.0)))  # fmt: skip
        if s.get("format") == "h2h":
            kw["format"] = "h2h"
        kw.update({k: v for k, v in over.items() if v is not None})
        return cls(**kw)

    def __post_init__(self):
        for c, side in [(c, "h") for c in self.hitter_cats] + [(c, "p") for c in self.pitcher_cats]:
            if c not in CATEGORIES or CATEGORIES[c][0] != side:
                raise ValueError(f"the draft engine does not score the category {c} ({side})")

    @property
    def cats(self):
        return list(self.hitter_cats) + list(self.pitcher_cats)

    @property
    def slot_caps(self):
        """Every starting slot type with its count per team, hitters first."""
        return {**self.slots, **self.pslots}

    @property
    def starters(self):
        return sum(self.slot_caps.values())

    @property
    def roster_size(self):
        return self.starters + self.bench

    @property
    def components(self):
        """The components the categories need, in a fixed order, and each one's side."""
        out = []
        for c in self.cats:
            for k in CATEGORIES[c][1]:
                if k not in out:
                    out.append(k)
        return out

    def signature(self, side, pos):
        """The slot types a player with Yahoo eligibility `pos` (e.g. '2B,SS') can fill."""
        tok = {t.strip().upper() for t in str(pos or "").replace("/", ",").split(",") if t.strip()}
        table = HITTER_SLOTS if side == "h" else PITCHER_SLOTS
        caps = self.slots if side == "h" else self.pslots
        return tuple(t for t in table if t in caps and (table[t] is None or tok & set(table[t])))


def snake_order(n_teams, rounds):
    return [t for r in range(rounds) for t in (range(n_teams) if r % 2 == 0 else range(n_teams - 1, -1, -1))]


# ---- scoring -------------------------------------------------------------------------------------


class Scorer:
    """Team component totals -> category values -> roto points, or head-to-head odds."""

    def __init__(self, league):
        self.lg = league
        comps = league.components
        self.comps = comps
        self.cats = league.cats
        self.count_ix, self.rate_ix = [], []
        for k, c in enumerate(self.cats):
            _, parts, scale, sign, prop = CATEGORIES[c]
            if len(parts) == 1:
                self.count_ix.append((k, comps.index(parts[0]), sign))
            else:
                self.rate_ix.append((k, comps.index(parts[0]), comps.index(parts[1]), scale, sign, prop))

    def values(self, tot):
        """[..., teams, cats] category values, signed so that more is better (tot: [..., teams, components])."""
        v = np.empty(tot.shape[:-1] + (len(self.cats),))
        for k, j, sign in self.count_ix:
            v[..., k] = sign * tot[..., j]
        for k, a, b, scale, sign, _ in self.rate_ix:
            den = tot[..., b]
            v[..., k] = sign * scale * np.where(den > 0, tot[..., a] / np.where(den > 0, den, 1.0), 0.0)
        return v

    def roto_points(self, tot):
        """[..., teams, cats] rank points: best = teams, worst = 1, ties averaged."""
        v = self.values(tot)
        below = (v[..., None, :, :] < v[..., :, None, :]).sum(axis=-2)
        at_or_below = (v[..., None, :, :] <= v[..., :, None, :]).sum(axis=-2)
        return (below + at_or_below + 1) / 2.0

    def weekly(self, tot):
        """Each team's weekly mean and SD per category (signed values), from its season totals.

        The assumption (DESIGN.md section 6): a team's weekly totals scatter around 1/weeks of its
        season line.  A count: variance phi x m + (CV_GAMES x m)^2, m the weekly mean.  A rate: the
        numerator's count noise over the weekly denominator (a proportion: binomial).
        """
        W, phi = self.lg.weeks, self.lg.phi
        shape = tot.shape[:-1] + (len(self.cats),)
        mean, sd = np.empty(shape), np.empty(shape)
        for k, j, sign in self.count_ix:
            m = tot[..., j] / W
            mean[..., k] = sign * m
            sd[..., k] = np.sqrt(phi * np.abs(m) + (CV_GAMES * m) ** 2)
        for k, a, b, scale, sign, prop in self.rate_ix:
            num, den = tot[..., a] / W, np.maximum(tot[..., b] / W, 1e-9)
            r = num / den
            mean[..., k] = sign * scale * r
            var = r * (1 - r) / den if prop else phi * np.maximum(num, 0) / den**2
            sd[..., k] = scale * np.sqrt(np.maximum(var, 1e-12))
        return mean, sd

    def h2h_p(self, tot):
        """[..., teams, teams, cats]: the chance team a beats team b in a category in one week."""
        mean, sd = self.weekly(tot)
        d = mean[..., :, None, :] - mean[..., None, :, :]
        s = np.sqrt(sd[..., :, None, :] ** 2 + sd[..., None, :, :] ** 2)
        return norm_cdf(d / np.maximum(s, 1e-12))


def norm_cdf(z):
    """The standard normal CDF, vectorized (Abramowitz & Stegun 7.1.26, as calc.js normCdf)."""
    z = np.asarray(z, float)
    t = 1.0 / (1.0 + 0.3275911 * np.abs(z) / math.sqrt(2.0))
    erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * np.exp(-z * z / 2)
    return np.where(z >= 0, (1 + erf) / 2, (1 - erf) / 2)


def round_robin(n_teams, weeks):
    """[weeks, pairs, 2] matchups by the circle method, repeated (a bye team if n_teams is odd)."""
    n = n_teams + (n_teams % 2)
    rot = list(range(1, n))
    rounds = []
    for _ in range(n - 1):
        lineup = [0] + rot
        rounds.append([(lineup[i], lineup[n - 1 - i]) for i in range(n // 2)])
        rot = rot[-1:] + rot[:-1]
    sched = [rounds[w % (n - 1)] for w in range(weeks)]
    return np.array([[p for p in wk if max(p) < n_teams] for wk in sched], dtype=np.int64)


class H2H:
    """Head-to-head each category: a regular season on a round-robin schedule, then a bracket.

    `odds(p, u, team)` plays `reps` seasons per call on the uniforms `u` (shared by the candidates of a
    simulation: common random numbers) and returns the team's playoff share, title share and mean
    regular-season category wins.  p is [teams, teams, cats], or [outcomes, teams, teams, cats]: then
    season r is played on outcome r modulo the outcomes.
    """

    def __init__(self, league, reps=16):
        self.lg = league
        self.reps = reps
        self.rounds = max(1, math.ceil(math.log2(max(2, league.playoff_teams))))
        self.reg_weeks = max(1, league.weeks - self.rounds)
        self.sched = round_robin(league.teams, self.reg_weeks)  # [weeks, pairs, 2]
        self.n_cats = len(league.cats)
        # one-hot of each matchup's two teams, [weeks x pairs, teams], so wins add up by a product
        a, b = self.sched[:, :, 0].ravel(), self.sched[:, :, 1].ravel()
        self.onehot_a = np.zeros((a.size, league.teams))
        self.onehot_a[np.arange(a.size), a] = 1.0
        self.onehot_b = np.zeros((b.size, league.teams))
        self.onehot_b[np.arange(b.size), b] = 1.0

    def uniforms(self, rng):
        w, pairs = self.sched.shape[:2]
        return (rng.random((self.reps, w, pairs, self.n_cats)), rng.random((self.reps, self.rounds + 1, 4, self.n_cats)),
                rng.random((self.reps, self.lg.teams)))  # fmt: skip

    def odds(self, p, u, team, all_wins=False):
        """(playoff share, title share, mean category wins) of `team`; with all_wins, also every
        team's regular-season category wins in each season, [reps, teams]."""
        reg, po, tie = u
        a, b = self.sched[:, :, 0], self.sched[:, :, 1]
        p4 = p if p.ndim == 4 else p[None]
        ridx = np.arange(self.reps) % p4.shape[0]
        win_a = reg < p4[:, a, b][ridx]  # [reps, weeks, pairs, cats]
        n = self.lg.teams
        cats_a = win_a.sum(axis=3).reshape(self.reps, -1).astype(float)
        wins = cats_a @ self.onehot_a + (self.n_cats - cats_a) @ self.onehot_b
        key = wins + 1e-3 * tie  # ties in the standings broken at random
        P = min(self.lg.playoff_teams, n)
        made = champ = 0.0
        for r in range(self.reps):
            seeds = list(np.argsort(-key[r], kind="stable")[:P])
            if team not in seeds:
                continue
            made += 1
            champ += self._bracket(seeds, p4[ridx[r]], po[r]) == team
        out = (made / self.reps, champ / self.reps, float(wins[:, team].mean()))
        return out + (wins,) if all_wins else out

    def _bracket(self, seeds, p, u):
        """The champion of a bracket on `seeds` (best first): byes to the top seeds, then each round
        the best remaining seed plays the worst; a week is won on more categories, a tie to the better seed."""
        alive = list(seeds)
        size = 1 << self.rounds
        byes = size - len(alive)
        rnd = 0
        while len(alive) > 1:
            if byes > 0:
                bye, play = alive[:byes], alive[byes:]
                byes = 0
            else:
                bye, play = [], alive
            winners = []
            for m in range(len(play) // 2):
                x, y = play[m], play[len(play) - 1 - m]
                won = int((u[rnd, m % 4] < p[x, y]).sum())
                winners.append(x if won * 2 >= self.n_cats else y)
            alive = sorted(bye + winners, key=seeds.index)
            rnd += 1
        return alive[0]
