"""League settings, player pool, roster slot assignment and rotisserie scoring."""
from collections import deque
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

SHEET_URL = ("https://docs.google.com/spreadsheets/d/1EJYAfenIJsRG8sZ9qiTMO8ov3itHZxrx5uQTuPqwuRk"
             "/export?format=csv&gid=0")

SKATER_CATS = ["G", "A", "SOG", "BLK", "HIT", "+/-", "PPP"]
GOALIE_CATS = ["W", "SV", "SV%", "GAA"]
CATS = SKATER_CATS + GOALIE_CATS
LOWER_IS_BETTER = {"GAA"}
# raw stats that enter the linear valuation; SV% and GAA are built from SV, GA and GS
STATS = SKATER_CATS + ["W", "SV", "GA", "GS"]


@dataclass
class League:
    n_teams: int = 12
    slots: dict = field(default_factory=lambda: {"C": 2, "LW": 2, "RW": 2, "D": 4, "UTIL": 2, "G": 2})
    bench: int = 0

    @property
    def starters(self):
        return sum(self.slots.values())

    @property
    def roster_size(self):
        return self.starters + self.bench

    def league_slots(self):
        return {s: n * self.n_teams for s, n in self.slots.items()}


def slot_types(elig):
    """Slot types a player with Yahoo eligibility `elig` (e.g. 'C,LW') can fill."""
    pos = tuple(str(elig).split(","))
    return ("G",) if pos == ("G",) else pos + ("UTIL",)


def load_players(path="sheet_live.csv", yahoo_ranks="merged_players.csv", refresh=False):
    """Projections from the Google Sheet export, with two market boards (Fantrax ADP, Yahoo rank)."""
    if refresh:
        pd.read_csv(SHEET_URL).to_csv(path, index=False)
    df = pd.read_csv(path).rename(columns={"Fantrax Rank": "FantraxRk"})
    for c in STATS:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    df["slots"] = df["Pos_Y"].map(slot_types)
    df["is_g"] = df["Pos"].eq("G")
    # market board: Fantrax ADP, then Fantrax rank for the undrafted tail, then sheet order
    df["ADP"] = pd.to_numeric(df["ADP"], errors="coerce")
    tail = 1000 + df["FantraxRk"].fillna(df["FantraxRk"].max() + df.index.to_series())
    df["adp_fantrax"] = df["ADP"].fillna(tail)
    # ADP board inputs: players without an ADP sit one pick past the last listed one, and every
    # player's slot sd follows the fitted curve (cv falls from ~0.40 at the top to ~0.10 by pick 300)
    df["ADP_fill"] = df["ADP"].fillna(df["ADP"].max() + 1)
    df["ADP_sd"] = np.maximum((0.4217 - 0.056 * np.log(df["ADP_fill"])) * df["ADP_fill"], 0.1)
    try:
        y = pd.read_csv(yahoo_ranks)[["Player", "adp_rank"]].drop_duplicates("Player")
        df = df.merge(y, on="Player", how="left")
        df["adp_yahoo"] = df["adp_rank"].fillna(1000 + df["adp_fantrax"])
    except FileNotFoundError:
        df["adp_yahoo"] = df["adp_fantrax"]
    df["adp_blend"] = np.sqrt(df["adp_fantrax"] * df["adp_yahoo"])
    return df.reset_index(drop=True)


class Roster:
    """Players assigned to slot types; multi-eligible players are re-routed as needed.

    Feasibility is a bipartite matching (players -> slot types with capacities), so a new
    player fits iff there is an augmenting path from one of their slot types to a free slot.
    """

    def __init__(self, slots):
        self.cap = dict(slots)
        self.count = {s: 0 for s in slots}
        self.members = {s: [] for s in slots}   # slot type -> [(pid, slot_types)]
        self.slot_of = {}                       # pid -> slot type (starters only)
        self.bench = []

    def full(self):
        return all(self.count[s] >= self.cap[s] for s in self.cap)

    def find_slot(self, types, cost=None):
        """Free slot type reachable from `types` (cheapest by `cost`), plus the BFS tree to get there."""
        parent = {t: None for t in types if t in self.cap}
        queue = deque(parent)
        free = []
        while queue:
            s = queue.popleft()
            if self.count[s] < self.cap[s]:
                free.append(s)
            for pid, ptypes in self.members[s]:
                for t in ptypes:
                    if t in self.cap and t not in parent:
                        parent[t] = (s, pid, ptypes)
                        queue.append(t)
        if not free:
            return None, None
        return (min(free, key=cost.__getitem__) if cost else free[0]), parent

    def add(self, pid, types, cost=None):
        """Add a player, re-routing others along the augmenting path. Returns the slot type consumed."""
        slot, parent = self.find_slot(types, cost)
        if slot is None:
            return None
        t = slot
        while parent[t] is not None:
            s, q, qtypes = parent[t]
            self.members[s].remove((q, qtypes))
            self.members[t].append((q, qtypes))
            self.count[s] -= 1
            self.count[t] += 1
            self.slot_of[q] = t
            t = s
        self.members[t].append((pid, types))
        self.count[t] += 1
        self.slot_of[pid] = t
        return slot


def rank_average(a, axis=0):
    """Ranks with ties averaged (1 = smallest), like scipy.stats.rankdata(method="average")."""
    a = np.asarray(a, float)

    def one(v):
        _, inv, cnt = np.unique(v, return_inverse=True, return_counts=True)
        return (np.cumsum(cnt) - (cnt - 1) / 2.0)[inv]

    return one(a) if a.ndim == 1 else np.apply_along_axis(one, axis, a)


def team_totals(stats, idx):
    """Category totals for starters `idx` (row positions into `stats`, an [n, len(STATS)] array)."""
    t = dict(zip(STATS, stats[list(idx)].sum(axis=0)))
    sa = t["SV"] + t["GA"]
    out = {c: t[c] for c in SKATER_CATS + ["W", "SV"]}
    out["SV%"] = t["SV"] / sa if sa else 0.0
    out["GAA"] = t["GA"] / t["GS"] if t["GS"] else 0.0
    out["_GA"], out["_GS"] = t["GA"], t["GS"]      # kept for the ratio-stat linearisation
    return out


def roto_points(totals):
    """Rank points per team and category: best = n_teams ... worst = 1; ties share the points."""
    pts = pd.DataFrame(index=totals.index)
    for c in CATS:
        pts[c] = totals[c].rank(method="average", ascending=c not in LOWER_IS_BETTER)
    pts["Total"] = pts[CATS].sum(axis=1)
    return pts
