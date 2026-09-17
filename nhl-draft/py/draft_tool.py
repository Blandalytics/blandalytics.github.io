"""Draft one team's roster off the combined VORP / ADP board, with the clock simulated.

Port of draft_sims/draftsim/draft_tool.py to the roto league.  You sit in one seat; the other
eleven teams draft themselves, and every time the pick comes back around the tool stops and
shows what each of your options is worth -- not as a rank, but as the team you would take into
the season if you took that player and let the rest of the draft happen.

    python draft_tool.py --slot 5

On the clock you are shown up to 15 candidates, each priced by --sims simulated finishes of
the draft (pick_engine.py):

    the best --per-pos (2) available at each of C, LW, RW, D and G, by assigned position
    the next --board (5) players on the combined VORP/ADP board

listed best first by what your team is worth at the end of the draft: its roto points against
the eleven simulated rivals, off the static projections.  The roster's total VORP is shown
too and takes over the ordering only when nothing on offer can reach a starting slot (a bench
pick never moves the roto points).  A star marks the column that ordered the table; spread,
gap and best% are read off it.

Two randomisations are at work.  The live draft is one world: at the first pick every rival
draws a VOR weight w ~ Uniform(--w-lo, --w-hi) and keeps it for the whole draft, and one set
of ranks is drawn for the draft as a whole, so the room has a settled character.  The
simulations are many worlds: every one redraws the ranks and deals all twelve teams fresh
weights, your own included, because on the clock you do not know how the room reads the
board.  Options are compared on shared draws, so the spread between two of them is a real
difference; best% is how often an option came out ahead on the same simulated future.

Your own board is the unsampled one -- static VORP rank and ADP rank blended at --my-weight --
so it does not reshuffle under you from one pick to the next.

By default this is a mock draft and the tool only stops on your pick.  --no-mock-draft follows
a real one: it stops at every pick for you to enter and accepts any available player at a
rival's whether or not the roster rules allow it.  Your options are re-priced at every stop,
as if you were on the clock now, so the picture is fresh after each pick you enter.

Commands on the clock:

    1..n        take that option, or that player off the board
    p <name>    take any available player instead (name fragment, or #rank on your board)
    b [POS] [n] show the board -- best available, or best eligible at a position
    r [team]    rosters, by slot
    s           re-run the simulations on fresh draws (your pick only)
    u           undo one stop
    q           quit
"""
import argparse
import sys

import numpy as np

from draft_sim import calibrate, parse_args as base_args
from league import CATS, League, STATS, Roster, load_players
from pick_engine import CAT0, FIN, N_SIMS, PTS, SKIP, VOR, WIN, Engine, Parallel, best_available

MY_WEIGHT = 0.6                 # the VORP/ADP blend your own board is shown in
SEED = 960122                   # fixed, so the same flags give the same draft
N_PER_POS = 2                   # best available at each position offered as options
N_BOARD = 5                     # then the next players on your board
TOP_POS = ("C", "LW", "RW", "D", "G")
ORDINAL = {1: "top", 2: "2nd", 3: "3rd"}
SLOT_ORDER = ("C", "LW", "RW", "D", "UTIL", "G", "BN")


class Draft:
    """One live draft: who is gone, who has what, and whose turn it is.

    The rivals' boards are built once; their weights and the draft's two rank vectors are drawn
    at the first pick and never redrawn.  `snapshot`/`restore` copy the whole state, which is
    what makes undo exact.
    """

    def __init__(self, engine, user_team, rng, my_weight=MY_WEIGHT, per_pos=N_PER_POS, n_board=N_BOARD):
        self.eng = engine
        self.lg = engine.lg
        self.user_team = user_team
        self.per_pos, self.n_board = per_pos, n_board
        self.n_options = per_pos * len(TOP_POS) + n_board
        self.n = engine.n
        self.order = engine.order
        self.ptr = 0
        self.gone = bytearray(self.n)
        self.counts = [[0] * engine.n_types for _ in range(self.lg.n_teams)]
        self.bench = [0] * self.lg.n_teams
        self.rosters = [[] for _ in range(self.lg.n_teams)]      # every pick, draft order
        self.starters = [[] for _ in range(self.lg.n_teams)]     # the seated ones
        self.benches = [[] for _ in range(self.lg.n_teams)]
        self.log = []

        # the one world the draft actually happens in
        self.vr, self.sr, self.weights = engine.draw(rng)
        live = engine.live_by_type(self.gone)
        self.boards, self.scores = engine.sim_boards(self.vr, self.sr, self.weights, live, user_team)
        self.heads = [[0] * engine.n_types for _ in range(self.lg.n_teams)]

        # your own lens on the board: static ranks, blended, never resampled
        self.my_weight = my_weight
        self.my_score = (my_weight * engine.rank_vor + (1 - my_weight) * engine.rank_adp).tolist()

    # ---- state -------------------------------------------------------------

    def done(self):
        return self.ptr >= len(self.order)

    def on_clock(self):
        """(round, team, overall pick), 1-based round and pick."""
        return self.ptr // self.lg.n_teams + 1, self.order[self.ptr], self.ptr + 1

    def remaining(self):
        return self.order[self.ptr:]

    def snapshot(self):
        return (self.ptr, bytes(self.gone), [list(c) for c in self.counts], list(self.bench),
                [list(r) for r in self.rosters], [list(r) for r in self.starters],
                [list(r) for r in self.benches], [list(h) for h in self.heads], len(self.log))

    def restore(self, snap):
        (self.ptr, gone, counts, bench, rosters, starters, benches, heads, nlog) = snap
        self.gone = bytearray(gone)
        self.counts = [list(c) for c in counts]
        self.bench = list(bench)
        self.rosters = [list(r) for r in rosters]
        self.starters = [list(r) for r in starters]
        self.benches = [list(r) for r in benches]
        self.heads = [list(h) for h in heads]
        del self.log[nlog:]

    # ---- picking -----------------------------------------------------------

    def take(self, i):
        """Record the player at pool index `i` as this pick."""
        rd, team, overall = self.on_clock()
        self.gone[i] = 1
        if self.eng.place(team, self.counts, self.bench, i):
            self.starters[team].append(i)
        else:
            self.benches[team].append(i)
        self.rosters[team].append(i)
        self.log.append((overall, rd, team, i))
        self.ptr += 1
        return rd, team, overall

    def auto(self):
        """The team on the clock takes the best player its own board allows."""
        _, team, _ = self.on_clock()
        ok, _ = self.eng.legal(self.counts[team], self.bench[team])
        i = best_available(self.boards[team], self.heads[team], self.scores[team], self.gone, ok)
        if i < 0:
            raise RuntimeError(f"no legal player at pick {self.ptr + 1}")
        return self.take(i)

    def legal_for(self, team, i):
        if self.gone[i]:
            return False
        return self.eng.legal(self.counts[team], self.bench[team])[0][self.eng.pc[i]]

    def fills_a_slot(self, team, i):
        return self.eng.legal(self.counts[team], self.bench[team])[1][self.eng.pc[i]]

    # ---- boards ------------------------------------------------------------

    def my_board(self, pos=None, include_dnd=False):
        """Undrafted players, best first, in your own blend of the ranks; `pos` filters on eligibility.

        Do-not-draft players are left off unless asked for: they never appear as options or on
        the board, but `p <name>` can still take one, and rivals' picks of them are recorded.
        """
        slots, dnd = self.eng.players["slots"], self.eng.dnd
        idx = [i for i in range(self.n) if not self.gone[i] and (include_dnd or not dnd[i])
               and (pos is None or pos in slots.iat[i])]
        idx.sort(key=lambda i: (self.my_score[i], i))
        return idx

    def candidates(self):
        """The options to price: the best --per-pos players at each position, then --board more
        down your board.

        "2nd C" is the second-best centre on the board whether or not the best one is legal for
        you; a player your roster cannot legally add is dropped rather than shown.  The board
        fill takes the best legal players not already named.
        """
        board = self.my_board()
        out, count = [], dict.fromkeys(TOP_POS, 0)
        for i in board:
            pos = self.eng.pos[i]
            if count[pos] >= self.per_pos:
                continue
            count[pos] += 1
            if self.legal_for(self.user_team, i):
                out.append((i, "%s %s" % (ORDINAL.get(count[pos], "%dth" % count[pos]), pos)))
            if all(c >= self.per_pos for c in count.values()):
                break
        seen, filled = {i for i, _ in out}, 0
        for i in board:
            if filled >= self.n_board:
                break
            if i not in seen and self.legal_for(self.user_team, i):
                out.append((i, "board"))
                seen.add(i)
                filled += 1
        return out, board


# ---- display ---------------------------------------------------------------

def fmt_player(eng, i, width=22):
    p = eng.players
    return "%-*s %-7s %-4s" % (width, p["Player"].iat[i][:width], p["Pos_Y"].iat[i], str(p["Team"].iat[i])[:4])


def roster_slots(draft, team):
    """Each rostered player's slot, re-routing multi-eligible players as league.Roster does."""
    R = Roster(draft.lg.slots)
    out = {}
    for i in draft.rosters[team]:
        slot = R.add(i, draft.eng.players["slots"].iat[i]) if i in draft.starters[team] else None
        out[i] = R.slot_of.get(i, "BN") if slot is not None else "BN"
    return out


def show_roster(draft, team, label=None):
    """A roster on one line by slot; who starts where is only settled by the last pick."""
    p = draft.eng.players
    slots = roster_slots(draft, team)
    head = label or ("team %d" % (team + 1))
    if not slots:
        print("  %-9s (empty)" % head)
        return
    parts = []
    for s in SLOT_ORDER:
        names = [p["Player"].iat[i] for i in draft.rosters[team] if slots[i] == s]
        if names:
            parts.append("%s: %s" % (s, ", ".join(names)))
    print("  %-9s %s" % (head, " | ".join(parts)))


def show_board(draft, pos=None, n=15):
    eng = draft.eng
    idx = draft.my_board(pos)[:n]
    print("\n  best available%s (your blend w_vor=%.2f)" % ("" if pos is None else " " + pos, draft.my_weight))
    print("  %4s  %-35s %7s %7s %6s %7s %7s" % ("#", "player", "vor_rk", "adp_rk", "adp", "vorp", "value"))
    for k, i in enumerate(idx, start=1):
        a = eng.adp[i]
        print("  %4d  %-35s %7.0f %7.0f %6s %7.2f %7.2f"
              % (k, fmt_player(eng, i), eng.rank_vor[i], eng.rank_adp[i], "-" if a != a else "%.1f" % a,
                 eng.vorp[i], eng.value[i]))


def rank_options(draft, opts, res):
    """Options and their simulations, best first, plus the skip baseline.  Returns the measure used.

    Ranking is on the team's simulated roto points.  When none of the options can reach a
    starting slot every option finishes the same lineup, so the ranking pivots to the roster's
    total VORP, which still tells bench picks apart.  Stable, so level options keep their
    proposed order (position leaders ahead of board).
    """
    base, res = res[:, -1], res[:, :-1]              # the last column simulated SKIP
    startable = any(draft.fills_a_slot(draft.user_team, i) for i, _ in opts)
    measure = PTS if startable else VOR
    order = np.argsort(-res[measure].mean(axis=1), kind="stable")
    return [opts[k] for k in order], res[:, order], base, measure


def show_options(draft, opts, res, measure=PTS):
    """The options table: what each pick is worth, and how often it wins.

    A star marks the measure that ordered the table; the gap to the best option and best% are
    read off it.  Options level in a simulation share the credit for it.
    """
    eng = draft.eng
    ranked = res[measure]
    mean = ranked.mean(axis=1)
    p10, p90 = np.percentile(ranked, [10, 90], axis=1)
    best = mean.max()
    top = ranked == ranked.max(axis=0)
    wins = (top / top.sum(axis=0)).sum(axis=1) / ranked.shape[1]
    rank = {i: k for k, i in enumerate(draft.my_board(), start=1)}
    head = ["roto pts", "team vorp"]
    head[measure] += "*"
    print("\n  %3s %-7s %-34s %4s %5s %9s %9s %6s %5s %5s %5s %7s %5s"
          % ("#", "option", "player", "rank", "adp", head[0], head[1], "finish", "win%", "p10", "p90", "vs best", "best%"))
    for k, (i, why) in enumerate(opts, start=1):
        gap = mean[k - 1] - best
        a = eng.adp[i]
        print("  %3d %-7s %-34s %4d %5s %9.1f %9.1f %6.2f %4.0f%% %5.1f %5.1f %7s %4.0f%%"
              % (k, why, fmt_player(eng, i, 21), rank[i], "-" if a != a else "%.1f" % a,
                 res[PTS, k - 1].mean(), res[VOR, k - 1].mean(), res[FIN, k - 1].mean(), 100 * res[WIN, k - 1].mean(),
                 p10[k - 1], p90[k - 1], "best" if gap == 0 else "%+.1f" % gap, 100 * wins[k - 1]))
    if measure == VOR:
        print("\n  * ranked on the roster's total VORP: none of these can reach a starting slot, so"
              "\n    roto pts is the same team whichever you take")


def show_categories(draft, opts, res, base):
    """Expected category points: your team with this seat filled from waivers, then what each
    option adds over that.

    The baseline row is the team's standing in every category at the end of the draft if this
    pick is skipped and the seat is filled by the best leftover player -- its strengths and
    weaknesses against the eleven simulated rivals.  Each option's row is its category points
    less that baseline: the points the pick adds over replacement, later picks included, with
    diminishing returns built in because a category already led cannot gain.  The total column
    is the roto-point lift the first table ranks on.
    """
    eng = draft.eng
    now = base[CAT0:].mean(axis=1)
    lift = res[CAT0:].mean(axis=2) - now[:, None]
    print("\n  expected category points (of %d): your team with this seat filled from waivers, then what each option adds"
          % draft.lg.n_teams)
    print("  %3s %-7s %-29s " % ("#", "option", "player") + " ".join("%5s" % c for c in CATS) + " %6s" % "total")
    print("  %3s %-7s %-29s " % ("", "", "waiver fill") + " ".join("%5.1f" % v for v in now) + " %6.1f" % now.sum())
    for k, (i, why) in enumerate(opts, start=1):
        print("  %3d %-7s %-29s " % (k, why, fmt_player(eng, i, 16))
              + " ".join("%+5.1f" % v for v in lift[:, k - 1]) + " %+6.1f" % lift[:, k - 1].sum())


def show_league(draft, league, mock=True):
    """Every team's average simulated category points, best expected total first.

    Read off the skip world -- no candidate forced, your seat filled from waivers at the end --
    so it is the league's current trajectory: who is strong where, and which categories are
    still open.  Your row is the baseline the lift table adds to.
    """
    mean = np.nanmean(league, axis=2)                    # teams x cats
    total = mean.sum(axis=1)
    me = draft.user_team
    print("\n  average simulated standings points per team, by category (this pick skipped, your seat filled from waivers)")
    print("  %-8s %5s " % ("team", "w" if mock else "") + " ".join("%5s" % c for c in CATS) + " %6s" % "total")
    for t in np.argsort(-total, kind="stable"):
        w = "" if not mock else ("-" if t == me else "%.2f" % draft.weights[t])
        print("  %-8s %5s " % ("you" if t == me else "team %d" % (t + 1), w)
              + " ".join("%5.1f" % v for v in mean[t]) + " %6.1f" % total[t])


def show_header(draft, team=None):
    rd, on_clock, overall = draft.on_clock()
    slot = (overall - 1) % draft.lg.n_teams + 1
    mine = team is None
    print("\n" + ("=" if mine else "-") * 110)
    print(" round %d, pick %d (overall %d) -- %s"
          % (rd, slot, overall, "YOUR PICK" if mine else "team %d on the clock" % (on_clock + 1)))
    print(("=" if mine else "-") * 110)
    if mine:
        show_roster(draft, draft.user_team, "you have")


def show_between(draft, picks, mock=True):
    if not picks:
        return
    print("\n  picks since your last:")
    for overall, rd, team, i in picks:
        print("    %3d.%02d  team %-2d  %-35s%s"
              % (rd, (overall - 1) % draft.lg.n_teams + 1, team + 1, fmt_player(draft.eng, i),
                 "  (w %.2f)" % draft.weights[team] if mock else ""))


def show_final(draft, mock=True):
    import pandas as pd
    from league import CATS, roto_points, team_totals
    eng, me = draft.eng, draft.user_team
    print("\n" + "=" * 110)
    print(" draft complete")
    print("=" * 110)
    slots = roster_slots(draft, me)
    print("\n  your roster")
    for i in sorted(draft.rosters[me], key=lambda i: (SLOT_ORDER.index(slots[i]), -eng.value[i])):
        print("    %-5s %-35s vorp %6.2f  value %6.2f" % (slots[i], fmt_player(eng, i), eng.vorp[i], eng.value[i]))
    pts = roto_points(pd.DataFrame([team_totals(eng.stats, r) for r in draft.starters]))
    place = int((pts["Total"] > pts["Total"].iat[me]).sum()) + 1
    print("\n  roto points %.1f of %d; team vorp %.1f; finish %d of %d"
          % (pts["Total"].iat[me], draft.lg.n_teams * len(CATS), eng.team_vorp(draft.starters[me], draft.benches[me]),
             place, draft.lg.n_teams))
    tab = pd.DataFrame({"team": ["you" if t == me else "team %d" % (t + 1) for t in range(draft.lg.n_teams)]})
    if mock:
        tab["w"] = ["-" if t == me else "%.2f" % draft.weights[t] for t in range(draft.lg.n_teams)]
    tab["vorp"] = [round(eng.team_vorp(draft.starters[t], draft.benches[t]), 1) for t in range(draft.lg.n_teams)]
    tab = pd.concat([tab, pts.round(1)], axis=1).sort_values("Total", ascending=False)
    print("\n  every team, by roto points (category points, best = %d)" % draft.lg.n_teams)
    print("  " + tab.to_string(index=False).replace("\n", "\n  "))


# ---- the loop --------------------------------------------------------------

def resolve(draft, text):
    """A player index from a name fragment or a `#rank` off your board."""
    text = text.strip()
    board = draft.my_board(include_dnd=not text.startswith("#"))   # a name may pick a do-not-draft player
    names = draft.eng.players["Player"]
    if text.startswith("#"):
        try:
            k = int(text[1:])
        except ValueError:
            return None, "not a board rank: %s" % text
        if not 1 <= k <= len(board):
            return None, "board rank out of range: %s" % text
        return board[k - 1], None
    hits = [i for i in board if text.lower() in names.iat[i].lower()]
    if not hits:
        return None, "nobody available matches %r" % text
    if len(hits) > 1:
        exact = [i for i in hits if names.iat[i].lower() == text.lower()]
        if len(exact) == 1:
            return exact[0], None
        return None, "%d players match %r: %s" % (len(hits), text, ", ".join(names.iat[i] for i in hits[:6]))
    return hits[0], None


class Console:
    """The clock: what is shown at a stop, and what a typed command does.

    Mock drafting (the default) means the rivals draft themselves and the only stop is your own
    pick; with --no-mock-draft the tool stops at every pick and records what the room did.  The
    simulations run on your pick either way.  One snapshot is pushed per stop, so `u` rewinds
    one stop.
    """

    HELP = "  ? 1-%d to pick, p <name>, b [POS] [n], r [team], s, u, q"

    def __init__(self, draft, n_sims, rng, auto=False, mock=True, pool=None):
        self.draft = draft
        self.n_sims = n_sims
        self.rng = rng
        self.auto = auto
        self.mock = mock
        self.pool = pool
        self.snaps = []
        self.between = []
        self.opts = []
        self.res = None
        self.basis = PTS

    def run(self):
        d = self.draft
        while not d.done():
            _, team, _ = d.on_clock()
            mine = team == d.user_team
            if self.mock and not mine:
                d.auto()
                self.between.append(d.log[-1])
                continue
            prompt = self._present(mine, team)
            self.snaps.append(d.snapshot())
            if not self._on_clock(prompt, mine, team):
                return False
        return True

    def _present(self, mine, team):
        d = self.draft
        show_header(d, None if mine else team)
        if not mine:
            show_between(d, self.between, self.mock)
            self.between = []
            show_board(d, None, d.n_options)
            if d.user_team not in d.remaining():
                self.opts, self.res = [(i, "board") for i in d.my_board()[: d.n_options]], None
            else:
                self.opts, _ = d.candidates()
                print("")
                print("  your options as if you were on the clock now; simulating %d finishes for each of %d..."
                      % (self.n_sims, len(self.opts)), end=" ", flush=True)
                self._simulate()
            return "\n  team %d pick> " % (team + 1)
        show_between(d, self.between, self.mock)
        self.between = []
        self.opts, _ = d.candidates()
        print("\n  simulating %d finishes for each of %d options..." % (self.n_sims, len(self.opts)), end=" ", flush=True)
        self._simulate()
        return "\n  pick> "

    def _on_clock(self, prompt, mine, team):
        while True:
            choice = self._read(prompt)
            if choice is None:
                return False
            if not choice:
                continue
            cmd, _, arg = choice.partition(" ")
            if cmd.lower() == "q":
                return False
            if self._act(cmd.lower(), arg.strip(), mine, team):
                return True

    def _read(self, prompt):
        if self.auto:
            print("%s1 (auto)" % prompt)
            return "1"
        try:
            return input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print("\n  quit")
            return None

    def _act(self, cmd, arg, mine, team):
        if cmd == "b":
            return self._show_board(arg)
        if cmd == "r":
            return self._show_rosters(arg)
        if cmd == "s":
            return self._resimulate()
        if cmd == "u":
            return self._undo()
        return self._take(cmd, arg, mine, team)

    def _show_board(self, arg):
        words = arg.split()
        pos = [w.upper() for w in words if not w.isdigit()]
        num = [int(w) for w in words if w.isdigit()]
        if pos and pos[0] not in TOP_POS:
            print("  no such position: %s" % pos[0])
        else:
            show_board(self.draft, pos[0] if pos else None, num[0] if num else (25 if pos else 15))
        return False

    def _show_rosters(self, arg):
        d = self.draft
        if not arg.isdigit():
            print()
            for t in range(d.lg.n_teams):
                show_roster(d, t, "you" if t == d.user_team else "team %d" % (t + 1))
        elif 1 <= int(arg) <= d.lg.n_teams:
            show_roster(d, int(arg) - 1)
        else:
            print("  no such team: %s" % arg)
        return False

    def _simulate(self):
        d = self.draft
        res, league = d.eng.evaluate(d, [i for i, _ in self.opts] + [SKIP], self.n_sims, self.rng, self.pool)
        print("done")
        self.opts, self.res, self.base, self.basis = rank_options(d, self.opts, res)
        show_options(d, self.opts, self.res, self.basis)
        show_categories(d, self.opts, self.res, self.base)
        show_league(d, league, self.mock)

    def _resimulate(self):
        if self.res is None:
            print("  nothing to re-simulate -- you have no pick left")
            return False
        print("  re-simulating...", end=" ", flush=True)
        self._simulate()
        return False

    def _undo(self):
        if len(self.snaps) < 2:
            print("  nothing to undo")
            return False
        self.snaps.pop()
        self.draft.restore(self.snaps.pop())
        self.between = []
        return True

    def _take(self, cmd, arg, mine, team):
        d = self.draft
        i = self._chosen(cmd, arg)
        if i is None:
            return False
        if mine and not d.legal_for(team, i):
            print("  %s is not a legal pick for your roster" % d.eng.players["Player"].iat[i])
            return False
        d.take(i)
        if mine:
            print("  you take %s" % fmt_player(d.eng, i))
        else:
            self.between.append(d.log[-1])
            print("  team %d takes %s" % (team + 1, fmt_player(d.eng, i)))
        return True

    def _chosen(self, cmd, arg):
        if cmd == "p":
            i, err = resolve(self.draft, arg)
            if err:
                print("  " + err)
            return i
        if cmd.isdigit() and 1 <= int(cmd) <= len(self.opts):
            return self.opts[int(cmd) - 1][0]
        print(self.HELP % len(self.opts))
        return None


def resolve_names(players, text):
    """Pool indices for a comma-separated list of names (case-insensitive, unique substring)."""
    names = players["Player"].str.lower()
    found, unknown = [], []
    for frag in [t.strip().lower() for t in text.split(",") if t.strip()]:
        hits = [i for i, nm in enumerate(names) if frag in nm]
        exact = [i for i in hits if names.iat[i] == frag]
        if len(exact) == 1 or len(hits) == 1:
            found.append((exact or hits)[0])
        else:
            unknown.append(frag)
    return found, unknown


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slot", type=int, default=1, help="your draft slot, 1..teams")
    ap.add_argument("--sims", type=int, default=N_SIMS, help="simulated finishes per option")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--my-weight", type=float, default=MY_WEIGHT,
                    help="the VORP weight your own board is shown in; it orders the options, it does not draft for you")
    ap.add_argument("--mock-draft", action=argparse.BooleanOptionalAction, default=True,
                    help="let the rivals draft themselves; --no-mock-draft stops at every pick for a real draft")
    ap.add_argument("--w-lo", type=float, default=0.25, help="low end of each team's VOR weight draw")
    ap.add_argument("--w-hi", type=float, default=0.75, help="high end of each team's VOR weight draw")
    ap.add_argument("--per-pos", type=int, default=N_PER_POS, help="best players at each position offered as options")
    ap.add_argument("--board", type=int, default=N_BOARD, help="further options taken down your board")
    ap.add_argument("--workers", type=int, default=0, help="worker processes; 0 = one per core, 1 = inline")
    ap.add_argument("--auto", action="store_true", help="take the top option every time, no prompt")
    ap.add_argument("--sheet", default="sheet_live.csv")
    ap.add_argument("--teams", type=int, default=12)
    ap.add_argument("--slots", default="C:2,LW:2,RW:2,D:4,UTIL:2,G:2")
    ap.add_argument("--bench", type=int, default=0)
    ap.add_argument("--do-not-draft", default="", metavar="NAMES",
                    help="comma-separated players kept off your options and board (rivals may still take "
                         "them, and `p <name>` can still pick one)")
    a = ap.parse_args(argv)

    league = League(n_teams=a.teams, bench=a.bench,
                    slots={k: int(v) for k, v in (kv.split(":") for kv in a.slots.split(","))})
    if not 1 <= a.slot <= league.n_teams:
        raise SystemExit("--slot must be 1..%d" % league.n_teams)
    if a.per_pos < 0 or a.board < 0 or a.per_pos + a.board < 1:
        raise SystemExit("need at least one option: --per-pos and --board")

    print("loading the board...", end=" ", flush=True)
    base = base_args(["--sheet", a.sheet, "--teams", str(a.teams), "--slots", a.slots, "--bench", str(a.bench)])
    players = load_players(a.sheet)
    cal = calibrate(players, players[STATS].to_numpy(float), league, base, np.random.default_rng(base.seed),
                    log=lambda *x: None)
    dnd, unknown = resolve_names(players, a.do_not_draft)
    eng = Engine(players, cal["coef"], cal["repl"], cal["assigned"], league, a.w_lo, a.w_hi, dnd)
    print("%d players" % eng.n)
    if dnd:
        print("do not draft: %s" % ", ".join(players["Player"].iat[i] for i in dnd))
    for u in unknown:
        print("  do-not-draft name not matched: %s" % u)

    rng = np.random.default_rng(a.seed)
    draft = Draft(eng, a.slot - 1, rng, a.my_weight, a.per_pos, a.board)
    print("%d teams x %d rounds, you are team %d (seed %d)" % (league.n_teams, league.roster_size, a.slot, a.seed))
    if a.mock_draft:
        print("rival vor weights: %s" % "  ".join("T%d %.2f" % (t + 1, w) for t, w in enumerate(draft.weights)
                                                  if t != draft.user_team))
    else:
        print("entering every pick by hand; simulations run on yours only")

    pool = None
    if a.workers != 1:
        pool = Parallel(eng.spec(), a.workers)
        print("simulating on %d worker processes" % pool.workers)
    try:
        if Console(draft, a.sims, rng, a.auto, a.mock_draft, pool).run():
            show_final(draft, a.mock_draft)
    finally:
        if pool is not None:
            pool.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
