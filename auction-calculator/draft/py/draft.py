"""One live draft, snake or auction: who is gone, who has what, the budgets, and whose turn it is.

Port of nhl_draft draft_tool.Draft, with the auction added.  The rivals act in one live world (their
valuations are drawn once at the start and kept, so the room has a settled character); the engine's
simulations redraw a world each time.  snapshot / restore copy the whole state, which makes undo exact.

Snake:   on_clock() -> (round, team, overall); take(i); auto() (the team on the clock picks itself)
Auction: nominator(); nominate(j) puts a player on the block; auto_nominate(); resolve(user_bid)
         settles the lot against the live rivals' bids; record(j, team, price) enters a real result
"""

import math

from engine import SKIP, Snap

ORDINAL = {1: "top", 2: "2nd", 3: "3rd"}
POSITIONS = ("C", "1B", "2B", "3B", "SS", "OF", "SP", "RP")
BID_STEPS = (0.6, 0.8, 1.0, 1.2, 1.4)  # forced-buy prices, x the expected price
DRAIN_MARGIN = 2  # $: a drain is worth at least this much less to the user than to the room (whole-dollar rounding is not a drain)


class Draft:
    def __init__(self, engine, user_team, rng, mode="snake", per_pos=1, n_board=6):
        if mode not in ("snake", "auction"):
            raise ValueError("mode is snake or auction")
        self.eng, self.lg, self.pool = engine, engine.lg, engine.pool
        self.mode, self.user = mode, user_team
        self.per_pos, self.n_board = per_pos, n_board
        T, n = self.lg.teams, engine.n
        self.gone = bytearray(n)
        self.keys = [0] * T  # seated players per team (Engine.key)
        self.bench = [0] * T
        self.rosters = [[] for _ in range(T)]
        self.paid = [[] for _ in range(T)]  # the price of each roster player (snake: None)
        self.budget = [self.lg.budget] * T
        self.spots = [self.lg.roster_size] * T
        self.log = []  # (n, team, player, price)
        self.order, self.ptr = engine.order, 0  # snake
        self.nom, self.lot = 0, None  # auction: next nominator; (player, nominator) on the block
        self.world = engine.draw_world(rng, outcome=False)  # the one world the live rivals act in
        self.heads = [0] * T

    # ---- state -----------------------------------------------------------------------------------

    def done(self):
        return self.ptr >= len(self.order) if self.mode == "snake" else sum(self.spots) == 0

    def on_clock(self):
        """Snake: (round, team, overall pick), 1-based."""
        return self.ptr // self.lg.teams + 1, self.order[self.ptr], self.ptr + 1

    def remaining(self):
        return self.order[self.ptr :]

    def snapshot(self):
        return (self.ptr, bytes(self.gone), list(self.keys), list(self.bench), [list(r) for r in self.rosters],
                [list(p) for p in self.paid], list(self.budget), list(self.spots), list(self.heads), self.nom, self.lot, len(self.log))  # fmt: skip

    def restore(self, snap):
        (self.ptr, gone, keys, bench, rosters, paid, budget, spots, heads, self.nom, self.lot, nlog) = snap
        self.gone = bytearray(gone)
        self.keys = list(keys)
        self.bench = list(bench)
        self.rosters = [list(r) for r in rosters]
        self.paid = [list(p) for p in paid]
        self.budget, self.spots, self.heads = list(budget), list(spots), list(heads)
        del self.log[nlog:]

    def legal_for(self, team, i):
        return not self.gone[i] and self.spots[team] > 0 and self.eng.legal(self.keys[team], self.bench[team])[0][self.eng.pc[i]]

    def fills_a_slot(self, team, i):
        return self.eng.legal(self.keys[team], self.bench[team])[1][self.eng.pc[i]]

    def max_bid(self, team):
        return self.budget[team] - self.lg.min_bid * (self.spots[team] - 1)

    def inflation(self, team=None):
        """The league's inflation (money above the min bids over the $ above the min bid still
        available), or one team's (Engine.team_inflation)."""
        money, left = self.eng.inflation(self.budget, self.spots, self.gone)
        open_spots = sum(self.spots)
        if team is not None:
            return self.eng.team_inflation(self.budget[team], self.spots[team], left / open_spots if open_spots else 0.0)
        return min(3.0, max(0.2, money / left)) if left > 0 else 3.0

    # ---- acquiring ---------------------------------------------------------------------------------

    def _acquire(self, team, i, price):
        self.eng.add(team, i, self.gone, self.keys, self.bench, self.rosters)
        self.paid[team].append(price)
        if price is not None:
            self.budget[team] -= price
        self.spots[team] -= 1
        self.log.append((len(self.log) + 1, team, i, price))

    def take(self, i):
        """Snake: the team on the clock takes player i."""
        _, team, _ = self.on_clock()
        self._acquire(team, i, None)
        self.ptr += 1
        return team

    def auto(self):
        """Snake: the team on the clock takes the best player its live board allows."""
        _, team, _ = self.on_clock()
        i = self.eng.best(self.world.boards[team], self.heads, team, self.gone, self.keys[team], self.bench[team])
        if i < 0:
            raise RuntimeError("no player left")
        return self.take(i)

    def nominator(self):
        """Auction: the team whose turn it is to nominate (full rosters are skipped)."""
        for k in range(self.lg.teams):
            t = (self.nom + k) % self.lg.teams
            if self.spots[t] > 0:
                return t
        return None

    def nominate(self, j, team=None):
        """Put player j on the block, nominated by `team` (default: the team whose turn it is; a live
        draft may enter another team, and the turn then passes from that team)."""
        t = self.nominator() if team is None else int(team)
        self.lot = (j, t)
        self.nom = (t + 1) % self.lg.teams
        return t

    def auto_nominate(self):
        """Auction: the nominator puts its best legal player (on its live board) on the block."""
        t = self.nominator()
        j = self.eng.best(self.world.boards[t], self.heads, t, self.gone, self.keys[t], self.bench[t])
        self.nominate(j)
        return j

    def resolve(self, user_bid=None):
        """Auction: settle the lot on the block against the live rivals (the user bids `user_bid`,
        or as a rival would on the static $ value when None).  Returns (winner, price)."""
        j, nominator = self.lot
        legal = [self.eng.legal(self.keys[t], self.bench[t]) for t in range(self.lg.teams)]
        if user_bid is None:
            user_bid = self.user_value_bid(j)
        _, left = self.eng.inflation(self.budget, self.spots, self.gone)
        vps = left / max(1, sum(self.spots))
        win, price = self.eng.resolve(j, nominator, self.world, vps, legal, self.budget, self.spots, self.user, user_bid)
        self._acquire(win, j, price)
        self.lot = None
        return win, price

    def record(self, j, team, price=None):
        """A real draft's result: player j to `team` (at `price` in an auction)."""
        if self.mode == "snake":
            self._acquire(team, j, None)
            self.ptr += 1
        else:
            self._acquire(team, j, int(price))
            self.lot = None

    def user_value_bid(self, j, value=None):
        """The user's bid without a simulation: the static $ value (or `value`) with the user's own
        inflation, at the bench share for a player who would not start; whole dollars."""
        mb = self.lg.min_bid
        v = self.pool.value[j] if value is None else value
        b = mb + (v - mb) * self.inflation(self.user)
        if not self.fills_a_slot(self.user, j):
            b = mb + (b - mb) * self.eng.bench_share
        return max(0, min(math.floor(b), self.max_bid(self.user)))

    def own_price(self, j):
        """What player j is worth to the user (the nomination rule's U): his own $ (the risk-aware $
        from the table, else the calculator's $) priced as user_value_bid prices the static $."""
        return self.user_value_bid(j, float(self.pool.own[j]))

    def expected_price(self, j):
        """The room's expected price of player j (the nomination rule's E): the calculator's $ above
        the min bid at the room's inflation, whole dollars (bid_grid's centre)."""
        mb = self.lg.min_bid
        return math.floor(mb + max(0.0, self.pool.value[j] - mb) * self.inflation())

    def nominees(self, n_drain=5, n_target=2):
        """Auction: the user's nomination candidates by the drain rule, the rule's choice first.

        E = the room's expected price, U = the user's own price (own_price).  A *drain* is a player
        with U <= E - DRAIN_MARGIN: at his market price a rival buys him, and the money leaves the
        rivals' budgets for a player the user does not want at that price.  The rule nominates the dearest drain (largest
        E; ties to the larger E - U).  With no drain it nominates the dearest player (a target: the
        user is a likely buyer at the market price).  The list adds the next drains and the best
        targets (the highest $ who would start for the user) for the engine to price.
        Returns [(("pick", i), why), ...]."""
        rows = []
        for i in self.my_board():
            if not self.legal_for(self.user, i):
                continue
            e, u = self.expected_price(i), self.own_price(i)
            rows.append((e, e - u, i))
        if not rows:
            return []
        drains = sorted((r for r in rows if r[1] >= DRAIN_MARGIN), key=lambda r: (-r[0], -r[1], r[2]))
        out = [(("pick", i), "drain: $%d to you, ~$%d to the room" % (e - g, e)) for e, g, i in drains[:n_drain]]
        seen = {c[1] for c, _ in out}
        targets = [r for r in sorted(rows, key=lambda r: (-r[0], r[2])) if r[2] not in seen and self.fills_a_slot(self.user, r[2])]
        if not out:  # nothing to drain: the dearest player, as a target
            targets = targets or sorted(rows, key=lambda r: (-r[0], r[2]))
        out += [(("pick", i), "target: ~$%d" % e) for e, _, i in targets[: (n_target if out else n_target + 1)]]
        return out

    # ---- the engine's view ------------------------------------------------------------------------

    def snap(self):
        """Everything a play-out needs.  Snake: a rival's stop is priced as if the user were on the
        clock now (the user's next scheduled pick is the one used up), as nhl_draft does."""
        me = self.user
        order, user_pick = [], -1
        if self.mode == "snake":
            order = list(self.remaining())
            if order and order[0] != me:
                order = [me] + order
                nxt = next((k for k in range(1, len(order)) if order[k] == me), None)
                if nxt is not None:
                    del order[nxt]
            user_pick = 0
        return Snap(self.mode, bytes(self.gone), list(self.keys), list(self.bench), [list(r) for r in self.rosters],
                    list(self.budget), list(self.spots), order, me, user_pick, self.lot, self.nom)  # fmt: skip

    def my_board(self, pos=None):
        """Undrafted players by $ value (the user's board does not move), do-not-draft ones left off;
        `pos` filters on eligibility (a slot type, or SP / RP)."""
        out = []
        for i in range(self.eng.n):
            if self.gone[i] or self.eng.dnd[i]:
                continue
            if pos is not None and pos not in self.pool.signature[i] and pos != self.pool.primary[i]:
                continue
            out.append(i)
        return out

    def candidates(self):
        """Snake: the best `per_pos` legal players at each position, then `n_board` more down the
        board that would start (nhl_draft draft_tool.candidates), and the skip baseline last."""
        board = self.my_board()
        out, count = [], dict.fromkeys(POSITIONS, 0)
        for i in board:
            pos = self.pool.primary[i]
            if pos not in count or count[pos] >= self.per_pos:
                continue
            count[pos] += 1
            if self.legal_for(self.user, i):
                out.append((("pick", i), "%s %s" % (ORDINAL.get(count[pos], "%dth" % count[pos]), pos)))
            if all(c >= self.per_pos for c in count.values()):
                break
        seen, filled = {c[0][1] for c in out}, 0
        for i in board:
            if filled >= self.n_board:
                break
            if i not in seen and self.legal_for(self.user, i) and self.fills_a_slot(self.user, i):
                out.append((("pick", i), "board"))
                seen.add(i)
                filled += 1
        if not out:  # nothing starts: the best legal players for the bench
            out = [(("pick", i), "bench") for i in board if self.legal_for(self.user, i)][: self.n_board]
        return out + [(SKIP, "skip")]

    def bid_grid(self):
        """Auction: the candidates for the lot on the block: the pass (the baseline: no bid, or the
        opening min bid for the nominator), then forced buys at multiples of the expected price (the
        $ value at the room's inflation).  The break-even of the buys is the maximum bid (web_api)."""
        j, nominator = self.lot
        mb, cap = self.lg.min_bid, self.max_bid(self.user)
        if not self.legal_for(self.user, j) or cap < mb:
            return [(("bid", 0), "no room")]
        base = mb + max(0.0, self.pool.value[j] - mb) * self.inflation()
        prices = sorted({min(cap, max(mb, int(round(base * f)))) for f in BID_STEPS})
        if len(prices) < 3:
            prices = sorted({min(cap, mb + k) for k in range(3)})
        out = [(("bid", mb), "open at $%d" % mb)] if nominator == self.user else [(("bid", 0), "pass")]
        return out + [(("buy", p), "buy at $%d" % p) for p in prices]
