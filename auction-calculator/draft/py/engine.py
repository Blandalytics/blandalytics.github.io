"""Finish a draft in progress many times from one seat; price each candidate by the team's finish.

Port of nhl_draft pick_engine.py to the MLB league (Yahoo slots, the calculator's $ values), with two
additions: an auction (rivals nominate and bid; DESIGN.md section 4) and real outcome draws (the
season is not the projection; section 5).

One evaluation is a draft state and a list of candidates.  A simulation draws one *world*:

    the outcomes    `outcomes` (8) seasons: in each, one of the 50 draws of each player's season,
                    independent across players; a play-out is scored on all of them
    the rivals      each team's valuation of each player: $ value x market noise x team noise
    the tie order   a random priority among the teams (auction ties)
    the weeks       the uniforms of the head-to-head season (league.H2H)

and every candidate is played out in that same world (common random numbers), so the gap between
two candidates is a real difference and not sampling noise.

Candidates:
    snake    ("pick", i)   the user's team takes player i now; ("skip",) takes nobody and fills the
                           seat at the end with the best undrafted player (a waiver-level baseline)
    auction  ("bid", B)    the user's maximum bid on the player on the block; the lot resolves against
                           the world's rival bids (B = 0: no bid, the baseline)
             ("buy", p)    the user's team is forced to buy the player on the block at price p

After the play-out, each team's lineup is its best legal lineup by $ value (the bench does not
count), and the league is scored on the world's outcome draws.

Measures per candidate and simulation (rows of a result): roto points, finish (1 = first, ties
averaged), win (finish 1), team $ (the roster's summed $ value), head-to-head playoff share, title
share and regular-season category wins, and for an auction whether the user got the lot and at what
price; then the user's roto points in each category.
"""

import math
from collections import namedtuple
from functools import lru_cache

import numpy as np

from league import H2H, Scorer, snake_order

N_CHUNKS = 12
PTS, FIN, WIN, VAL, PLAYOFF, CHAMP, HWINS, GOT, PAID = range(9)
MEASURES = ("roto pts", "finish", "win", "team $", "playoff", "champ", "h2h wins", "got", "paid")
CAT0 = len(MEASURES)
SKIP = ("skip",)

# everything a play-out needs from the draft in progress (keys: each team's seated players as a
# mixed-radix count of each eligibility type, see Engine.key)
Snap = namedtuple("Snap", "mode gone keys bench rosters budget spots order user user_pick lot nom")


class World:
    """One simulation's draws (see the module docstring)."""

    __slots__ = ("X", "V", "rows", "boards", "prio", "u")


class Engine:
    """One league, one pool, and the machinery to finish drafts on it.

    sigma_market, sigma_team: the log-SD of the market's and each team's noise on a player's $ value
    bench_share: the share of its value (above the min bid) a team bids for a player who would sit on its bench
    outcomes: the seasons each play-out is scored on (the outcome draws of a world)
    """

    def __init__(self, pool, league, sigma_market=0.15, sigma_team=0.10, bench_share=0.25, h2h=True, h2h_reps=16, dnd=(), outcomes=8):
        self.pool, self.lg = pool, league
        self.n, self.T = pool.n, league.teams
        self.roster_size, self.n_start, self.n_bench = league.roster_size, league.starters, league.bench
        self.sigma_market, self.sigma_team, self.bench_share = sigma_market, sigma_team, bench_share
        self.outcomes = int(outcomes)
        self.value = pool.value
        self.value_list = pool.value.tolist()
        self.above = (np.maximum(0.0, pool.value - league.min_bid) * pool.drafted).tolist()  # inflation's denominator
        self.scorer = Scorer(league)
        self.h2h = H2H(league, h2h_reps) if h2h else None
        self.order = snake_order(self.T, self.roster_size)
        self.dnd = np.zeros(self.n, bool)
        self.dnd[list(dnd)] = True

        # eligibility types: legality works per type (the tuple of slot types a player fits), hitter
        # types first, then pitcher types
        is_p = lambda t: any(x in league.pslots for x in t)  # noqa: E731
        self.etypes = sorted(set(pool.signature), key=lambda t: (is_p(t), len(t), t))
        self.n_types = len(self.etypes)
        self.n_htypes = sum(not is_p(t) for t in self.etypes)
        code = {t: k for k, t in enumerate(self.etypes)}
        self.pc = [code[s] for s in pool.signature]
        self.all_legal = (True,) * self.n_types
        # Hall's condition: a set of seated players fits iff, for every set S of slot types, the
        # players eligible only within S number at most S's capacity.  Hitter and pitcher slots never
        # mix, so each side is checked on its own subsets and its own part of the roster state.
        caps = league.slot_caps
        self.side_hall = []
        for side, types in ((league.slots, self.etypes[: self.n_htypes]), (league.pslots, self.etypes[self.n_htypes :])):
            names = list(side)
            masks = [sum(1 << names.index(x) for x in t) for t in types]
            subsets = range(1, 1 << len(names))
            hall = np.array([[1.0 if masks[t] & ~S == 0 else 0.0 for t in range(len(types))] for S in subsets])
            cap = np.array([float(sum(caps[x] for k, x in enumerate(names) if S >> k & 1)) for S in subsets])
            self.side_hall.append((hall.reshape(len(subsets), len(types)), cap))
        self.radix = self.n_start + 1
        self.P = [self.radix**t for t in range(self.n_types)]
        self.R_h = self.radix**self.n_htypes
        self._side_route = [lru_cache(maxsize=None)(lambda k, s=s: self._route_side(s, k)) for s in (0, 1)]
        self.route = lru_cache(maxsize=1 << 18)(self._route)
        self.legal_k = lru_cache(maxsize=1 << 18)(self._legal_k)

    # ---- legality ------------------------------------------------------------------------------

    def key(self, counts):
        """The roster state of seated players as one integer (counts per eligibility type)."""
        return sum(c * p for c, p in zip(counts, self.P))

    def counts(self, key):
        out = []
        for _ in range(self.n_types):
            key, c = divmod(key, self.radix)
            out.append(c)
        return out

    def _route_side(self, side, subkey):
        """(routable per type of one side, seated count of that side) for its part of a roster state."""
        hall, cap = self.side_hall[side]
        n = hall.shape[1]
        counts = []
        for _ in range(n):
            subkey, c = divmod(subkey, self.radix)
            counts.append(c)
        if n == 0:
            return (), 0
        load = hall @ np.array(counts, float)
        return tuple(bool(v) for v in ((load[:, None] + hall) <= cap[:, None]).all(axis=0)), sum(counts)

    def _route(self, key):
        """Routable per eligibility type: the type can still take a starting slot (Hall's condition)."""
        return self._side_route[0](key % self.R_h)[0] + self._side_route[1](key // self.R_h)[0]

    def _legal_k(self, key, bench):
        """Legal per eligibility type: routable, or a bench spot is open and enough spots remain to fill
        every starting slot afterwards.  Both only ever turn False as a roster grows, so a board pointer
        can skip a player who is not legal for good."""
        seated = self._side_route[0](key % self.R_h)[1] + self._side_route[1](key // self.R_h)[1]
        left = self.roster_size - seated - bench
        bench_open = bench < self.n_bench and left > self.n_start - seated
        return tuple(r or bench_open for r in self.route(key))

    def legal(self, key, bench):
        """(legal, routable) per eligibility type for a roster state."""
        return self.legal_k(key, bench), self.route(key)

    def lineup(self, roster):
        """The starters of a roster: the best legal lineup by $ value (greedy on a matroid is optimal)."""
        key, out, pc, P, route = 0, [], self.pc, self.P, self.route
        for i in sorted(roster):  # pool order is $ value, best first
            t = pc[i]
            if route(key)[t]:
                key += P[t]
                out.append(i)
                if len(out) == self.n_start:
                    break
        return out

    # ---- a simulation's world ------------------------------------------------------------------

    def draw_world(self, rng, outcome=True):
        """One world: outcome draws, every team's valuations and boards, the tie order, the weeks."""
        w = World()
        n, T = self.n, self.T
        if outcome:  # [outcomes, players, components]
            d = rng.integers(0, self.pool.n_draws, (self.outcomes, n))
            w.X = self.pool.draws[np.arange(n)[None, :], d]
        else:
            w.X = self.pool.proj_filled[None]
        sm, st = self.sigma_market, self.sigma_team
        f = np.exp(sm * rng.standard_normal(n) - sm * sm / 2)[None, :] * np.exp(st * rng.standard_normal((T, n)) - st * st / 2)
        w.V = self.value[None, :] + np.abs(self.value)[None, :] * (f - 1.0)
        w.rows = w.V.tolist()
        w.boards = np.argsort(-w.V, axis=1, kind="stable").tolist()
        w.prio = rng.permutation(T).tolist()
        w.u = self.h2h.uniforms(rng) if (self.h2h is not None and outcome) else None
        return w

    def user_board(self, w, user):
        """The user's own future in a play-out follows the user's policy, not a rival's: the static $
        board (pool order) and, in an auction, bids at the static $ value with the user's inflation
        (Draft.user_value_bid).  Do-not-draft players are left off (rivals may still take them)."""
        w.rows[user] = self.value_list
        w.boards[user] = [i for i in range(self.n) if not self.dnd[i]]

    # ---- picking and buying --------------------------------------------------------------------

    def best(self, board, heads, team, gone, key, bench):
        """The best player on `team`'s board that it may legally add, or -1 (the pointer skips gone
        and illegal players for good, see _legal_k)."""
        ok = self.legal_k(key, bench)
        pc, h, n = self.pc, heads[team], len(board)
        while h < n:
            i = board[h]
            if not gone[i] and ok[pc[i]]:
                heads[team] = h
                return i
            h += 1
        heads[team] = h
        for i in range(self.n):  # a roster the rules can no longer complete takes the best player left
            if not gone[i]:
                return i
        return -1

    def add(self, team, i, gone, keys, bench, rosters):
        """Seat player i on team: a starter if routable, else the bench.  Mutates in place."""
        t = self.pc[i]
        if self.route(keys[team])[t]:
            keys[team] += self.P[t]
        else:
            bench[team] += 1
        rosters[team].append(i)
        gone[i] = 1

    def team_inflation(self, budget, spots, vps):
        """A team's inflation: its money above the min bids over its share of the $ above the min bid
        still available (vps: that $ per open roster spot of the league), within [0.2, 3].  1 for every
        team at the start; a team that has spent ahead of its share bids less, one behind bids more."""
        if spots == 0:
            return 1.0
        if vps <= 0:
            return 3.0
        return min(3.0, max(0.2, (budget - self.lg.min_bid * spots) / (vps * spots)))

    def bid(self, team, j, w_row, vps, routable, budget, spots):
        """A team's maximum bid on player j (whole dollars): its valuation, scaled by its inflation and,
        for a bench spot, by bench_share; at most what its budget allows; -1 if under the min bid."""
        mb = self.lg.min_bid
        b = mb + (w_row[j] - mb) * self.team_inflation(budget, spots, vps)
        if not routable:
            b = mb + (b - mb) * self.bench_share
        b = min(math.floor(b), budget - mb * (spots - 1))
        return b if b >= mb else -1

    def resolve(self, j, nominator, w, vps, legal, budget, spots, user=-1, user_bid=None):
        """(winner, price) of a lot: every team with room bids its maximum (the user `user_bid`); the
        highest bid wins at the second-highest + 1 (at least the min bid).  Ties go to the nominator,
        then by the world's priority.  With no bid at the min bid the nominator buys at the min bid.
        (The bid arithmetic is `bid` and `team_inflation`, inlined.)"""
        mb, bs = self.lg.min_bid, self.bench_share
        pc = self.pc[j]
        rows = w.rows
        b1 = b2 = -1
        win = -1
        for t in (nominator, *w.prio):
            if (t == nominator and win >= 0) or spots[t] == 0:
                continue
            lg_t = legal[t]
            if not lg_t[0][pc]:
                continue
            sp = spots[t]
            cap = budget[t] - mb * (sp - 1)
            if t == user and user_bid is not None:
                b = int(user_bid)
            else:
                infl = (budget[t] - mb * sp) / (vps * sp) if vps > 0 else 3.0
                infl = 3.0 if infl > 3.0 else 0.2 if infl < 0.2 else infl
                b = mb + (rows[t][j] - mb) * infl
                if not lg_t[1][pc]:
                    b = mb + (b - mb) * bs
                b = math.floor(b)
            if b > cap:
                b = cap
            if b < mb:
                if t != nominator:
                    continue
                b = mb
            if b > b1:
                b1, b2, win = b, b1, t
            elif b > b2:
                b2 = b
        if win < 0:
            return nominator, mb
        return win, max(mb, min(b1, b2 + 1))

    def inflation(self, budget, spots, gone):
        """The league's money above the min bids over the $ above the min bid of the calculator's
        drafted players still available (1 at the start: the values add up to the budgets)."""
        money = sum(budget) - self.lg.min_bid * sum(spots)
        left = sum(a for a, g in zip(self.above, gone) if not g)
        return money, left

    # ---- finishing a draft ---------------------------------------------------------------------

    def finish_snake(self, w, gone, keys, bench, rosters, order, user_pick, cand):
        """Play `order` out: every team takes the best player its own board allows; at
        order[user_pick] the user's team takes the candidate (or, for SKIP, nobody)."""
        heads = [0] * self.T
        for k, team in enumerate(order):
            if k == user_pick:
                if cand[0] == "pick":
                    self.add(team, cand[1], gone, keys, bench, rosters)
                continue
            i = self.best(w.boards[team], heads, team, gone, keys[team], bench[team])
            if i < 0:
                break
            self.add(team, i, gone, keys, bench, rosters)

    def finish_auction(self, w, gone, keys, bench, rosters, budget, spots, lot, nom, user, cand):
        """Run the auction to the end.  The lot on the block (if any) resolves first with the
        candidate's bid; then teams nominate in turn (skipping full rosters), each its best legal
        player, and every lot resolves by `resolve`.  Returns (got the lot, price paid)."""
        T, mb = self.T, self.lg.min_bid
        legal = [self.legal(keys[t], bench[t]) for t in range(T)]
        money, left = self.inflation(budget, spots, gone)
        heads = [0] * T
        open_spots = sum(spots)
        got, paid = 0.0, math.nan
        first = lot is not None
        while open_spots > 0:
            if lot is None:
                k = 0
                while spots[nom] == 0 and k < T:
                    nom, k = (nom + 1) % T, k + 1
                nominator, nom = nom, (nom + 1) % T
                j = self.best(w.boards[nominator], heads, nominator, gone, keys[nominator], bench[nominator])
                if j < 0:
                    break
            else:
                (j, nominator), lot = lot, None
            vps = left / open_spots
            if first and cand[0] == "buy":
                win, price = user, int(cand[1])
            else:
                win, price = self.resolve(j, nominator, w, vps, legal, budget, spots, user, cand[1] if first else None)
            if first:
                got, paid = float(win == user), (float(price) if win == user else math.nan)
                first = False
            self.add(win, j, gone, keys, bench, rosters)
            budget[win] -= price
            spots[win] -= 1
            open_spots -= 1
            money -= price - mb
            left -= self.above[j]
            legal[win] = self.legal(keys[win], bench[win])
        return got, paid

    def waiver_fill(self, key, gone):
        """The best undrafted player who still fits a starting slot of a roster in this state."""
        rt = self.route(key)
        for i in range(self.n):
            if not gone[i] and not self.dnd[i] and rt[self.pc[i]]:
                return i
        return -1

    # ---- scoring ------------------------------------------------------------------------------

    def totals(self, X, rosters):
        """[outcomes, teams, components]: each team's lineup summed on the outcomes X [outcomes, players, components]."""
        idx, tid = [], []
        for t, r in enumerate(rosters):
            s = self.lineup(r)
            idx += s
            tid += [t] * len(s)
        onehot = np.zeros((self.T, len(idx)))
        onehot[tid, np.arange(len(idx))] = 1.0
        return onehot @ X[:, idx, :]

    def score(self, w, rosters, user):
        """(measures of the user's team, averaged over the world's outcomes; every team's roto points by
        category in the first outcome, [teams, cats])."""
        tot = self.totals(w.X, rosters)  # [R, T, C]
        cp = self.scorer.roto_points(tot)  # [R, T, K]
        total = cp.sum(axis=2)  # [R, T]
        mine = total[:, user]
        place = ((total > mine[:, None]).sum(axis=1) + (total >= mine[:, None]).sum(axis=1) + 1) / 2.0
        m = [float(mine.mean()), float(place.mean()), float((place == 1.0).mean()), sum(self.value_list[i] for i in rosters[user]),
             math.nan, math.nan, math.nan]  # fmt: skip
        if self.h2h is not None and w.u is not None:
            m[PLAYOFF], m[CHAMP], m[HWINS] = self.h2h.odds(self.scorer.h2h_p(tot), w.u, user)
        return m, cp[0]

    # ---- evaluating candidates -----------------------------------------------------------------

    def chunk(self, snap, candidates, n_sims, rng, base=0):
        """Every measure for every candidate over n_sims shared worlds, [CAT0 + cats, candidates, sims],
        and every team's roto points by category for candidate `base` (the baseline), [teams, cats, sims]."""
        K = len(self.lg.cats)
        out = np.full((CAT0 + K, len(candidates), n_sims), np.nan)
        league = np.full((self.T, K, n_sims), np.nan)
        me = snap.user
        for s in range(n_sims):
            w = self.draw_world(rng)
            self.user_board(w, me)
            for k, cand in enumerate(candidates):
                gone = bytearray(snap.gone)
                keys = list(snap.keys)
                bench = list(snap.bench)
                rosters = [list(r) for r in snap.rosters]
                got = paid = math.nan
                if snap.mode == "snake":
                    if cand[0] == "pick":
                        gone[cand[1]] = 1  # reserved for the user's pick
                    self.finish_snake(w, gone, keys, bench, rosters, snap.order, snap.user_pick, cand)
                    if cand[0] == "skip":
                        fill = self.waiver_fill(keys[me], gone)
                        if fill >= 0:
                            rosters[me].append(fill)
                else:
                    got, paid = self.finish_auction(w, gone, keys, bench, rosters, list(snap.budget), list(snap.spots),
                                                    snap.lot, snap.nom, me, cand)  # fmt: skip
                m, cp = self.score(w, rosters, me)
                out[:GOT, k, s] = m
                out[GOT, k, s], out[PAID, k, s] = got, paid
                out[CAT0:, k, s] = cp[me]  # (the first outcome's)
                if k == base:
                    league[:, :, s] = cp
        return out, league

    def evaluate(self, snap, candidates, n_sims, rng, base=0):
        """The whole decision, split by simulation into N_CHUNKS pieces (never by candidate, so the
        candidates keep sharing their worlds); each piece has its own spawned generator."""
        sizes = [n_sims // N_CHUNKS + (i < n_sims % N_CHUNKS) for i in range(N_CHUNKS)]
        parts = [self.chunk(snap, candidates, m, r, base) for m, r in zip(sizes, rng.spawn(N_CHUNKS)) if m]
        return np.concatenate([p[0] for p in parts], axis=2), np.concatenate([p[1] for p in parts], axis=2)

    def season(self, rosters, n_sims, rng):
        """A finished draft's odds for every team, [teams, CAT0 + cats, sims]: the league scored on
        n_sims outcome worlds (no draft play-out)."""
        res = np.full((self.T, CAT0 + len(self.lg.cats), n_sims), np.nan)
        values = [sum(self.value_list[i] for i in r) for r in rosters]
        for s in range(n_sims):
            d = rng.integers(0, self.pool.n_draws, (1, self.n))
            tot = self.totals(self.pool.draws[np.arange(self.n)[None, :], d], rosters)[0]
            cp = self.scorer.roto_points(tot)
            total = cp.sum(axis=1)
            place = np.array([((total > v).sum() + (total >= v).sum() + 1) / 2.0 for v in total])
            res[:, PTS, s], res[:, FIN, s], res[:, WIN, s], res[:, VAL, s] = total, place, place == 1.0, values
            res[:, CAT0:, s] = cp
            if self.h2h is not None:
                u, p = self.h2h.uniforms(rng), self.scorer.h2h_p(tot)
                for t in range(self.T):
                    res[t, PLAYOFF, s], res[t, CHAMP, s], res[t, HWINS, s] = self.h2h.odds(p, u, t)
        return res
