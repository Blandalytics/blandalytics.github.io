"""Finish a draft in progress, hundreds of times, from one team's seat.

Port of draft_sims/draftsim/pick_sim.py to the roto league.  finish_sim.py answers "where does
a player go?" over thousands of complete drafts; this answers the question a drafter asks on
the clock: "if I take *him* here, what do I end up with?" -- so it starts from a draft in
progress and only simulates forward.

One evaluation is a candidate and a state.  The user's team is forced to take the candidate at
the current pick; every pick after it, that team's included, is made greedily off a freshly
drawn board.  Each simulation redraws everything finish_sim.py redraws per draft (boards.py):

    the ADP rank      one skew-normal slot per player
    the VOR rank      one sampled season per player, replacement levels recomputed on it
    the weights       w ~ Uniform(w_lo, w_hi) per team, the user's included

Candidates share their draws (common random numbers), so the gap between two options is a
real difference and not sampling noise.

Per simulated finish, all off the static projections -- sampling decides who is *available*,
it does not decide what your roster is worth:
    roto points     the user's team scored against the eleven simulated rivals
    team VORP       every starter's value less his slot's replacement, bench at the UTIL / G line
    finish          finishing place, 1 = first (ties averaged)
    win             1 if the team finished first
    avail           1 if the candidate was still on the board when the user's pick came up in
                    the SKIP world (`finish` supports pricing a candidate at a later pick; the
                    tool prices every stop as if the user were on the clock, so this reads 1)
    category pts    the team's points in each of the eleven categories (rows CAT0..)
A candidate of SKIP forces nothing: the team does not make this pick, and once the draft is
over the seat it left open is filled by the best undrafted player who fits -- a waiver-level
fill, the same idea replacement level rests on.  Every option's category points less that
baseline is what the pick adds over replacement.

Legality depends on a player's eligibility set, never on which player it is: with the nine
eligibility types in the pool (C, LW, RW, D, G, C/LW, C/RW, LW/RW, C/LW/RW) every team keeps
nine board pointers that only walk forward, and whether a type can still be added to a roster
is cached by the count of each type already on it (league.Roster does the slot matching).
"""
import os
from collections import namedtuple
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache

import numpy as np

from boards import AdpBoard, VorBoard
from draft_sim import snake_order
from league import CATS, STATS, rank_min
from valuation import position_values

N_SIMS = 500
N_CHUNKS = 12                                   # pieces a decision splits into, pool or no
BIG = float("inf")
MEASURES = ("roto pts", "team vorp", "finish", "win", "avail")
PTS, VOR, FIN, WIN, AVAIL = range(5)
CAT0 = 5                                        # rows 5.. of a result are the category points
SKIP = -1                                       # the null candidate: this pick is not made at all
I_SV, I_GA, I_GS = STATS.index("SV"), STATS.index("GA"), STATS.index("GS")

# everything a simulation needs from the draft in progress, and nothing that cannot be pickled
PickState = namedtuple("PickState", "gone counts bench rosters order user_team user_pick")

_ENGINE = None                                  # one per worker process


def _init_worker(spec):
    global _ENGINE
    _ENGINE = Engine(**spec)


def _run_chunk(task):
    return _ENGINE.chunk(*task)


class Parallel:
    """A pool of worker processes, each holding its own Engine, reused for every pick."""

    def __init__(self, spec, workers=0):
        self.workers = workers or os.cpu_count() or 1
        self._pool = ProcessPoolExecutor(max_workers=self.workers, initializer=_init_worker, initargs=(spec,))

    def map(self, tasks):
        return self._pool.map(_run_chunk, tasks)

    def close(self):
        self._pool.shutdown(wait=False, cancel_futures=True)


def best_available(bd, hd, sc, gone, ok):
    """The best-scored live player of any legal eligibility type, or -1.

    `bd[t]` is one team's board for type `t`, best first, and `hd[t]` its pointer into it; the
    pointers walk past drafted players and never rewind.
    """
    best_i, best_s = -1, BIG
    for t in range(len(bd)):
        if not ok[t]:
            continue
        lst, h, n = bd[t], hd[t], len(bd[t])
        while h < n and gone[lst[h]]:
            h += 1
        hd[t] = h
        if h == n:
            continue
        i = lst[h]
        s = sc[i]
        if s < best_s or (s == best_s and i < best_i):
            best_i, best_s = i, s
    return best_i


class Engine:
    """One league, one player pool, and the machinery to finish drafts on it.

    Built from the market calibration's outputs (draft_sim.calibrate): the coefficients, the
    per-position replacement levels and each player's assigned position.  Everything fixed for
    the draft is built once; only the two rank vectors and the twelve weights change per
    simulation.
    """

    def __init__(self, players, coef, repl, assigned, league, w_lo=0.25, w_hi=0.75, dnd=()):
        self.players, self.lg, self._coef = players, league, coef
        self.n = len(players)
        self.n_teams = league.n_teams
        self.roster_size, self.n_start, self.n_bench = league.roster_size, league.starters, league.bench
        self.stats = players.matrix(STATS)
        self.value = self.stats @ np.asarray(coef, float)          # coef is in STATS order
        self.repl, self.assigned = repl, assigned
        self.pos = np.asarray(assigned)
        self.vorp = position_values(players, self.value, repl, assigned)["VORP"]
        self.slot_cost = sum(league.slots[s] * repl[s] for s in league.slots)     # a full lineup's replacement value
        self.bench_cost = np.where(self.pos == "G", repl["G"], repl["UTIL"])

        # eligibility types: legality and board pointers work per type, not per player
        types = list(players["slots"])
        self.etypes = sorted(set(types), key=lambda t: (len(t), t))
        self.n_types = len(self.etypes)
        code = {t: k for k, t in enumerate(self.etypes)}
        self.pc = [code[t] for t in types]
        self.all_legal = (True,) * self.n_types
        # Hall's condition on the 2^k subsets of the k starting slot types: a set of seated
        # players fits iff, for every subset S, the players eligible only within S number at
        # most S's capacity.  hall[S, t] = 1 when type t's slots all lie in S.
        slot_names = list(league.slots)
        masks = [sum(1 << slot_names.index(x) for x in t) for t in self.etypes]
        subsets = range(1 << len(slot_names))
        self.hall = np.array([[1 if masks[t] & ~S == 0 else 0 for t in range(self.n_types)] for S in subsets], float)
        self.hall_cap = np.array([sum(league.slots[x] for k, x in enumerate(slot_names) if S >> k & 1) for S in subsets], float)
        self._legal = lru_cache(maxsize=None)(self._legal_uncached)
        self.value_list = self.value.tolist()
        self.bench_cost_list = self.bench_cost.tolist()

        # the unsampled board the drafter reads: one VORP rank, one ADP rank, drawn from nothing
        self.rank_vor = np.empty(self.n)
        self.rank_vor[np.argsort(-self.vorp, kind="stable")] = np.arange(1, self.n + 1)
        self.rank_adp = rank_min(players["ADP_fill"])
        self.adp = np.asarray(players["ADP"], float)
        self.adp_board = AdpBoard(players)
        self.vor_board = VorBoard(players, coef, league, assigned)
        self.w_lo, self.w_hi = w_lo, w_hi
        self.order = snake_order(self.n_teams, self.roster_size)          # team on the clock, per pick
        self.value_order = np.argsort(-self.value, kind="stable")         # for the waiver fill
        self.dnd = np.zeros(self.n, bool)                                 # do-not-draft: off the user's boards
        self.dnd[list(dnd)] = True

    def spec(self):
        """What a worker needs to build its own copy."""
        return dict(players=self.players, coef=self._coef, repl=self.repl, assigned=self.assigned,
                    league=self.lg, w_lo=self.w_lo, w_hi=self.w_hi, dnd=[int(i) for i in np.flatnonzero(self.dnd)])

    # ---- legality ---------------------------------------------------------

    def _legal_uncached(self, state):
        """(legal, routable) per eligibility type for a roster in `state` = (counts..., bench).

        A type is routable if league.Roster can seat it in a starting slot given the types
        already seated; it is legal if routable, or if a bench spot is open and enough picks
        remain to still fill every starting slot afterwards.
        """
        counts, bench = state[:-1], state[-1]
        seated = sum(counts)
        picks_left = self.roster_size - seated - bench
        bench_open = bench < self.n_bench and picks_left > self.n_start - seated
        load = self.hall @ np.array(counts, float)                    # players confined to each subset
        routable = tuple(bool(v) for v in ((load[:, None] + self.hall) <= self.hall_cap[:, None]).all(axis=0))
        return tuple(r or bench_open for r in routable), routable

    def legal(self, counts, bench):
        return self._legal(tuple(counts) + (bench,))

    # ---- what a finished roster is worth (static projections) ---------------

    def league_points(self, rosters):
        """Roto points per team and category, [teams, cats], from the starters' projections."""
        idx = [i for r in rosters for i in r]
        tid = [t for t, r in enumerate(rosters) for _ in r]
        tot = np.zeros((self.n_teams, len(STATS)))
        np.add.at(tot, tid, self.stats[idx])
        sa, gs = tot[:, I_SV] + tot[:, I_GA], tot[:, I_GS]
        with np.errstate(invalid="ignore", divide="ignore"):
            cats = np.column_stack([tot[:, :I_GA], np.where(sa > 0, tot[:, I_SV] / sa, 0.0),
                                    -np.where(gs > 0, tot[:, I_GA] / gs, 0.0)])   # GAA negated: lower is better
        # rank with ties averaged: (below + at-or-below + 1) / 2, best = n_teams
        below = (cats[None, :, :] < cats[:, None, :]).sum(axis=1)
        at_or_below = (cats[None, :, :] <= cats[:, None, :]).sum(axis=1)
        return (below + at_or_below + 1) / 2.0

    def team_vorp(self, starters, bench):
        v, b = self.value_list, self.bench_cost_list
        return sum(v[i] for i in starters) - self.slot_cost + sum(v[i] - b[i] for i in bench)

    # ---- per-simulation board construction ----------------------------------

    def live_by_type(self, gone):
        """The undrafted pool split by eligibility type, ascending index (stable tie order)."""
        out = [[] for _ in range(self.n_types)]
        for i in range(self.n):
            if not gone[i]:
                out[self.pc[i]].append(i)
        return [np.array(v, dtype=np.int64) for v in out]

    def sim_boards(self, vr, sr, weights, live, user_team=None):
        """Every team's board for one simulation, split by type; scores as lists.

        The user's own board leaves out do-not-draft players, so the simulations never hand
        the user a player the user has said no to; rivals still take them.
        """
        w = np.asarray(weights)[:, None]
        scores = w * vr[None, :] + (1.0 - w) * sr[None, :]
        boards = []
        for t in range(self.n_teams):
            pools = live if t != user_team or not self.dnd.any() else [idx[~self.dnd[idx]] for idx in live]
            boards.append([idx[np.argsort(scores[t][idx], kind="stable")].tolist() for idx in pools])
        return boards, scores.tolist()

    def draw(self, rng):
        """One simulation's two rank vectors and its per-team weights."""
        return self.vor_board.draw(rng)[2], self.adp_board.draw(rng), rng.uniform(self.w_lo, self.w_hi, self.n_teams)

    # ---- finishing a draft ---------------------------------------------------

    def finish(self, boards, scores, order, counts, bench, rosters, benches, gone, user_pick=-1, cand=SKIP):
        """Play `order` out greedily; every team takes the best player its own board allows.

        At `order[user_pick]` the user's team takes `cand` (already reserved in `gone`) or, for
        SKIP, nothing at all.  Returns the rosters plus `gone` as it stood at that pick, which is
        what availability is read off.  `counts`, `bench`, `rosters`, `benches` and `gone` are
        consumed, so callers hand over copies.  A roster entered by hand (draft_tool
        --no-mock-draft) can be one the rules can no longer complete; that team then takes the
        best player left rather than stopping the simulation.
        """
        pc = self.pc
        heads = [[0] * self.n_types for _ in range(self.n_teams)]
        gone_at = bytes(gone)
        for j, team in enumerate(order):
            if j == user_pick:
                gone_at = bytes(gone)
                if cand != SKIP:
                    if self.place(team, counts, bench, cand):
                        rosters[team].append(cand)
                    else:
                        benches[team].append(cand)
                continue
            c = counts[team]
            ok, routable = self._legal(tuple(c) + (bench[team],))
            i = best_available(boards[team], heads[team], scores[team], gone, ok)
            if i < 0:
                i = best_available(boards[team], heads[team], scores[team], gone, self.all_legal)
            if i < 0:
                raise RuntimeError(f"no player left for team {team + 1}")
            gone[i] = 1
            if routable[pc[i]]:
                c[pc[i]] += 1
                rosters[team].append(i)
            else:
                bench[team] += 1
                benches[team].append(i)
        return rosters, benches, gone_at

    def waiver_fill(self, counts, bench, gone):
        """The best undrafted player who still fits a starting slot of a roster in this state."""
        _, routable = self._legal(tuple(counts) + (bench,))
        for i in self.value_order:
            if not gone[i] and not self.dnd[i] and routable[self.pc[i]]:
                return int(i)
        return -1

    def place(self, team, counts, bench, i):
        """Seat player `i` on `team`: a starter if routable, else the bench.  Mutates in place."""
        _, routable = self._legal(tuple(counts[team]) + (bench[team],))
        if routable[self.pc[i]]:
            counts[team][self.pc[i]] += 1
            return True
        bench[team] += 1
        return False

    def chunk(self, snap, candidates, n_sims, rng):
        """Every measure for every candidate over `n_sims` shared futures, [CAT0 + cats, options, sims],
        and every team's category points in the SKIP world, [teams, cats, sims] (NaN without a SKIP)."""
        live = self.live_by_type(snap.gone)
        me = snap.user_team
        out = np.empty((CAT0 + len(CATS), len(candidates), n_sims))
        league = np.full((self.n_teams, len(CATS), n_sims), np.nan)
        order = [k for k, c in enumerate(candidates) if c == SKIP] + [k for k, c in enumerate(candidates) if c != SKIP]
        for s in range(n_sims):
            vr, sr, weights = self.draw(rng)
            boards, scores = self.sim_boards(vr, sr, weights, live, me)
            gone_skip = None
            for k in order:
                cand = candidates[k]
                gone = bytearray(snap.gone)
                counts = [list(c) for c in snap.counts]
                bench = list(snap.bench)
                rosters = [list(r) for r in snap.rosters]
                benches = [[] for _ in range(self.n_teams)]
                if cand != SKIP:
                    gone[cand] = 1                            # reserved for the user's pick
                rosters, benches, gone_at = self.finish(boards, scores, snap.order, counts, bench, rosters, benches,
                                                        gone, snap.user_pick, cand)
                if cand == SKIP:
                    gone_skip = gone_at
                    fill = self.waiver_fill(counts[me], bench[me], gone)
                    if fill >= 0:
                        rosters[me].append(fill)
                cp = self.league_points(rosters)
                if cand == SKIP:
                    league[:, :, s] = cp
                tot = cp.sum(axis=1).tolist()
                mine = tot[me]
                place = (sum(1 for v in tot if v > mine) + sum(1 for v in tot if v >= mine) + 1) / 2.0
                out[PTS, k, s] = mine
                out[VOR, k, s] = self.team_vorp(rosters[me], benches[me])
                out[FIN, k, s] = place
                out[WIN, k, s] = float(place == 1.0)
                out[AVAIL, k, s] = 1.0 if cand == SKIP or gone_skip is None else float(not gone_skip[cand])
                out[CAT0:, k, s] = cp[me]
        return out, league

    def make_snap(self, state):
        """Everything a simulation needs from the draft in progress.

        A rival's stop is priced as if the user were on the clock now: the candidate is placed
        first, the rival still picks next, and the user's next scheduled pick is the one used up.
        """
        me, order = state.user_team, list(state.remaining())
        if order and order[0] != me:
            order = [me] + order
            nxt = next((k for k in range(1, len(order)) if order[k] == me), None)
            if nxt is not None:
                del order[nxt]
        return PickState(bytes(state.gone), [list(c) for c in state.counts], list(state.bench),
                         [list(r) for r in state.starters], order, me, 0)

    def evaluate(self, state, candidates, n_sims, rng, pool=None):
        """The whole decision, split by simulation into N_CHUNKS pieces (never by candidate, so
        the options keep sharing their draws); each piece gets its own spawned generator, so
        the answer is the same inline or on any number of workers."""
        snap = self.make_snap(state)
        sizes = [n_sims // N_CHUNKS + (i < n_sims % N_CHUNKS) for i in range(N_CHUNKS)]
        tasks = [(snap, list(candidates), n, r) for n, r in zip(sizes, rng.spawn(N_CHUNKS)) if n]
        parts = [self.chunk(*t) for t in tasks] if pool is None else list(pool.map(tasks))
        return np.concatenate([p[0] for p in parts], axis=2), np.concatenate([p[1] for p in parts], axis=2)
