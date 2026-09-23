"""League settings, player pool, roster slot assignment and rotisserie scoring.

The pool is a Table of named numpy columns rather than a pandas DataFrame: in the browser
(Pyodide) pandas costs ~115 MB of memory, ~1.8 s of start-up and a 5 MB download, and the
tool only ever needed columns.  The command-line reports still use pandas, imported where
they are built.
"""
import csv
from collections import deque
from dataclasses import dataclass, field

import numpy as np

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


class Table:
    """Named numpy columns of equal length: the player pool.

    table[name] is a column (float or int for numbers; object for text, which keeps NaN where a
    cell was missing, as pandas does); table.matrix(names) stacks numeric columns as [n, k] floats.
    """

    def __init__(self, columns):
        self._cols = dict(columns)

    def __getitem__(self, name):
        return self._cols[name]

    def __setitem__(self, name, values):
        self._cols[name] = values

    def __contains__(self, name):
        return name in self._cols

    def __len__(self):
        return len(next(iter(self._cols.values())))

    @property
    def columns(self):
        return list(self._cols)

    def matrix(self, names):
        # column-major, as pandas lays a block out: products and sums then round exactly as the
        # DataFrame versions did (a row-major copy gives a different last bit on ~half the players)
        return np.array([np.asarray(self._cols[c], float) for c in names]).T


# the cells pandas.read_csv reads as missing by default
MISSING = {"", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND", "1.#QNAN",
           "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null"}


def _number(cell):
    if cell in MISSING:
        return np.nan
    try:
        return float(cell)
    except ValueError:
        return None


def read_csv(path):
    """A CSV as {column: array}, typed as pandas.read_csv types it: a column whose cells are all
    whole numbers is int64, one that is all numbers or missing is float64 (NaN for missing),
    anything else is text (object, NaN for missing)."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    head, body = rows[0], rows[1:]
    out = {}
    for j, name in enumerate(head):
        cells = [r[j] if j < len(r) else "" for r in body]
        nums = [_number(c) for c in cells]
        if all(v is not None for v in nums):
            ints = all(c not in MISSING and c.lstrip("+-").isdigit() for c in cells)
            out[name] = np.array([int(c) for c in cells], np.int64) if ints else np.array(nums, float)
        else:
            out[name] = np.array([np.nan if c in MISSING else c for c in cells], dtype=object)
    return out


def to_numeric(col):
    """pd.to_numeric(col, errors="coerce"): numbers kept, anything else NaN."""
    col = np.asarray(col)
    if col.dtype != object:
        return col
    vals = [_number(c) if isinstance(c, str) else c for c in col]
    return np.array([np.nan if v is None else v for v in vals], float)


def fillna(col, fill):
    """col with its NaNs replaced by `fill` (a number, or an array of the same length)."""
    col = np.asarray(col)
    if col.dtype.kind in "iub":
        return col
    return np.where(np.isnan(col), fill, col)


def load_players(path="sheet_live.csv", yahoo_ranks="merged_players.csv", refresh=False):
    """Projections from the Google Sheet export, with two market boards (Fantrax ADP, Yahoo rank)."""
    if refresh:
        import pandas as pd      # command line only; round-trips the sheet as it always has
        pd.read_csv(SHEET_URL).to_csv(path, index=False)
    df = read_csv(path)
    df["FantraxRk"] = df.pop("Fantrax Rank")
    n = len(df["Player"])
    for c in STATS:
        df[c] = fillna(to_numeric(df[c]), 0.0)
    df["slots"] = np.empty(n, dtype=object)       # one tuple per player (a 1-d array of tuples)
    for i, v in enumerate(df["Pos_Y"]):
        df["slots"][i] = slot_types(v)
    df["is_g"] = np.array([v == "G" for v in df["Pos"]])
    # market board: Fantrax ADP, then Fantrax rank for the undrafted tail, then sheet order
    df["ADP"] = np.asarray(to_numeric(df["ADP"]), float)
    rk = np.asarray(to_numeric(df["FantraxRk"]), float)
    tail = 1000 + fillna(rk, np.nanmax(rk) + np.arange(n))
    df["adp_fantrax"] = fillna(df["ADP"], tail)
    # ADP board inputs: players without an ADP sit one pick past the last listed one, and every
    # player's slot sd follows the fitted curve (cv falls from ~0.40 at the top to ~0.10 by pick 300)
    df["ADP_fill"] = fillna(df["ADP"], np.nanmax(df["ADP"]) + 1)
    df["ADP_sd"] = np.maximum((0.4217 - 0.056 * np.log(df["ADP_fill"])) * df["ADP_fill"], 0.1)
    try:
        y = read_csv(yahoo_ranks)
        first = {}                                  # drop_duplicates("Player"): the first row wins
        for name, rank in zip(y["Player"], np.asarray(to_numeric(y["adp_rank"]), float)):
            first.setdefault(name, rank)
        df["adp_rank"] = np.array([first.get(name, np.nan) for name in df["Player"]], float)
        df["adp_yahoo"] = fillna(df["adp_rank"], 1000 + df["adp_fantrax"])
    except FileNotFoundError:
        df["adp_yahoo"] = df["adp_fantrax"]
    df["adp_blend"] = np.sqrt(df["adp_fantrax"] * df["adp_yahoo"])
    return Table(df)


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


def rank_min(a):
    """Ranks with ties at their lowest rank (1 = smallest), as pandas' rank(method="min")."""
    a = np.asarray(a, float)
    return np.searchsorted(np.sort(a), a, side="left") + 1.0


def team_totals(stats, idx):
    """Category totals for starters `idx` (row positions into `stats`, an [n, len(STATS)] array)."""
    t = dict(zip(STATS, stats[list(idx)].sum(axis=0)))
    sa = t["SV"] + t["GA"]
    out = {c: t[c] for c in SKATER_CATS + ["W", "SV"]}
    out["SV%"] = t["SV"] / sa if sa else 0.0
    out["GAA"] = t["GA"] / t["GS"] if t["GS"] else 0.0
    out["_GA"], out["_GS"] = t["GA"], t["GS"]      # kept for the ratio-stat linearisation
    return out


def columns_of(rows):
    """One dict per team (team_totals) -> {key: array over teams}."""
    return {k: np.array([r[k] for r in rows], float) for k in rows[0]}


def roto_points(totals):
    """Rank points per team and category: best = n_teams ... worst = 1; ties share the points.

    `totals`: one team_totals dict per team, or {cat: array over teams}.  Returns
    {cat: points array, ..., "Total": array}.
    """
    cols = columns_of(totals) if isinstance(totals, (list, tuple)) else totals
    pts = {c: rank_average(-cols[c] if c in LOWER_IS_BETTER else cols[c]) for c in CATS}
    pts["Total"] = np.column_stack([pts[c] for c in CATS]).sum(axis=1)   # half-points: exact in any order
    return pts
