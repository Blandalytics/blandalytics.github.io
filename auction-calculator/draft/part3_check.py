"""Part 3 of R8: the draft engine against simpler drafters, in many rooms (DESIGN.md section 11).

A room is one mock draft: 12 teams, the calculator's default Yahoo league, the 2027 test files (the tables of
export_players.mjs with the page's forms, as page_check.py builds them).  The room's seed fixes the 11 rivals
(their valuations, drawn once: Draft's live world) and the seasons that score the room.  The user's seat is
played in turn by each drafter in the same room (common random numbers: the same rivals' draws and the same
season draws; the rivals react to what the user does):

    E:<obj>:<sims>[:<nom>[:cap]]
                            the engine through web_api.Session, as the page drives it: each stop's options
                            priced over <sims> worlds, the recommendation taken (the break-even maximum bid at a
                            lot); obj "payout" (win% in roto winner-take-all, playoff% in head-to-head playoffs)
                            or "points" (mean roto points); auction nominations: nom "rule" (section 12.4, the
                            page's: the rule, the engine's choice if it gains 2 paired SE), "best" (the best
                            legal player on the $ board) or "random" (a random legal player of the calculator's
                            drafted pool); cap: the maximum bid capped at the value bid (web_api bid_cap
                            "value", the page's default since part 4), else the break-even alone (part 3's engine)
    V                       the median-value drafter: the calculator's $ board, a bid of the $ at its own
                            inflation (Draft.user_value_bid), nominates the best legal player on its board: the
                            rivals' rule without the noise
    R                       V with risk.js's risk-aware $ (before the draft) in place of the $
    C                       V with CE now: risk.js's EffValue and Var_eff against the engine's M, S, H of the
                            user's team at each decision (ce.py; CE_SIMS baseline play-outs), in $ by risk.js's
                            dollarsOf

Rivals: "base" (the engine's own model: market log-SD 0.15, team log-SD 0.10), "m30" (market log-SD 0.30),
"dollar" (the calculator's $ only, no noise).  The engine always plans with its own model.

Each finished room is scored on the same SEASONS seasons of outcome draws (the room's seed; Engine.season's
method, all teams at once): the user's win%, top-P% (roto), playoff% and title% (head-to-head), mean roto
points, mean finish, the roster's $, and in an auction the money left.

    python part3_check.py tables                         export the two tables with Node (once)
    python part3_check.py selftest                       the session builder and the scorer against web_api / Engine.season
    python part3_check.py run --plan pilot [--workers 3] [--hours 5]   append the plan's missing jobs to part3/rooms.jsonl
    python part3_check.py report                         part3/report.md (its tables) and part3/rooms.csv
    python part3_check.py replay --keys "roto|auction|0|base|E:payout:100" ...   run stored jobs again, compare

Workers run at BELOW_NORMAL priority with one BLAS thread each (other sessions share the machine).
"""

import os

for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_k, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "py"))

import numpy as np  # noqa: E402
from draft import Draft  # noqa: E402
from dry_run import HIT_DIR, PIT_DIR, RISK_FILES  # noqa: E402
from engine import SKIP  # noqa: E402
from web_api import Session, objective_of  # noqa: E402

OUT = os.path.join(HERE, "part3")
STORE = os.path.join(OUT, "rooms.jsonl")
TABLES = os.path.join(tempfile.gettempdir(), "part3_tables")
SEASONS = 500  # seasons of outcome draws that score each finished room
CE_SIMS = 30  # baseline play-outs for the C drafter's M, S, H
AUTO_BELOW = 3.0  # the page's default: auction lots worth less go by value bids without a stop
BASE_SEED = 20270401

# the page's forms (page_check.py): the calculator's default Yahoo 5x5 league; roto with the winner-take-all payout,
# head-to-head with the playoffs payout (6 teams)
YAHOO = {"style": "Categories", "cats": {"h": ["R", "HR", "RBI", "SB", "AVG"], "p": ["W", "SV", "K", "ERA", "WHIP"]}, "split": "65",
         "bench": "5", "teams": "12", "min_bid": "1", "budget": "260", "span": "3", "curve": "1.05", "weeks": "23", "phi": "1", "pt_cv": "0.15",
         "slot_C": "1", "slot_1B": "1", "slot_2B": "1", "slot_3B": "1", "slot_SS": "1", "slot_CI": "0", "slot_MI": "0", "slot_OF": "3", "slot_UT": "2",
         "pslot_SP": "2", "pslot_RP": "2", "pslot_P": "4", "pool": "All", "format": "roto", "lock": "daily", "twoway": "split",
         "min_bench": True, "include_fa": True, "fill_pt": True, "specialists": True, "split_auto": False,
         "risk": {"on": True, "risk_payout": "winner", "risk_playoffs": "4", "risk_txn": "daily", "risk_il": "2"}}  # fmt: skip
FMTS = {
    "roto": dict(form=YAHOO, format="roto", payout="winner", playoff_teams=4),
    "h2h": dict(form={**YAHOO, "format": "h2h", "risk": {**YAHOO["risk"], "risk_payout": "playoffs", "risk_playoffs": "6"}},
                format="h2h", payout="playoffs", playoff_teams=6),
}  # fmt: skip
RIVALS = {"base": None, "m30": (0.30, 0.10), "dollar": (0.0, 0.0)}


# ---- inputs ---------------------------------------------------------------------------------------


def table_path(fmt):
    return os.path.join(TABLES, fmt + ".json")


def export_tables():
    """The page's table for each format (export_players.mjs with the page's form and payout), into TABLES."""
    os.makedirs(TABLES, exist_ok=True)
    for fmt, f in FMTS.items():
        form = os.path.join(TABLES, fmt + "_form.json")
        with open(form, "w", encoding="utf-8") as fh:
            json.dump(f["form"], fh)
        cmd = ["node", os.path.join(HERE, "export_players.mjs"), os.path.join(HIT_DIR, "hitters_auction_ev.csv"),
               os.path.join(PIT_DIR, "pitchers_auction_ev.csv"), table_path(fmt), "--risk", *RISK_FILES, "--form", form, "--payout", f["payout"]]  # fmt: skip
        r = subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(fmt, r.stdout.strip())


_BASE = {}


def base(fmt):
    """One Session per format and process (the table, the pool and the engine are built once)."""
    if fmt not in _BASE:
        with open(table_path(fmt), encoding="utf-8") as fh:
            table = fh.read()
        with open(RISK_FILES[0], "rb") as fh:
            rh = fh.read()
        with open(RISK_FILES[1], "rb") as fh:
            rp = fh.read()
        f = FMTS[fmt]
        _BASE[fmt] = Session(dict(mode="snake", slot=1, sims=10, format=f["format"], payout=f["payout"], playoff_teams=f["playoff_teams"]), table, rh, rp)
        assert _BASE[fmt].pool.risk_meta, "the table has no risk-aware $"
    return _BASE[fmt]


def session(fmt, mode, seat, seed, sims=100, objective="payout", cap=False):
    """A Session as web_api builds it from the page's cfg (mock, auto_below = the page's 3), on the cached pool
    and engine.  objective: web_api's cfg value ("payout": the payout's measure); cap: bid_cap "value", else
    None (part 3's engine)."""
    b = base(fmt)
    s = object.__new__(Session)
    s.__dict__.update(b.__dict__)
    s.cfg = {**b.cfg, "mode": mode, "slot": seat, "sims": sims, "seed": seed, "chunk": sims, "objective": objective, "auto_below": AUTO_BELOW,
             "bid_cap": "value" if cap else None}  # fmt: skip
    s.objective = objective_of(objective, s.payout, s.lg.format)
    s.rng = np.random.default_rng(int(seed))
    s.draft = Draft(s.eng, seat - 1, s.rng, mode, int(s.cfg["per_pos"]), int(s.cfg["board"]))
    s.mock, s.sims, s.chunk = True, int(sims), int(sims)
    s.snaps, s.between, s.opts, s.result, s.kind = [], [], [], None, None
    return s


def room_seat(room):
    return 1 + (7 * room + 4) % 12  # room 0 is seat 5 (part 2's); 7 is prime to 12, so 12 rooms take every seat


def room_seed(room):
    return BASE_SEED + 7919 * room


def set_rivals(s, rivals, room):
    """Rivals other than the engine's own model: redraw the live world with their noise (the engine keeps its own)."""
    if RIVALS[rivals] is None:
        return
    eng = s.eng
    keep = eng.sigma_market, eng.sigma_team
    eng.sigma_market, eng.sigma_team = RIVALS[rivals]
    try:
        s.draft.world = eng.draw_world(np.random.default_rng([room, 11]), outcome=False)
    finally:
        eng.sigma_market, eng.sigma_team = keep


# ---- scoring -------------------------------------------------------------------------------------


def h2h_all(h, p, u):
    """H2H.odds for every team at once: (playoff share [T], title share [T], mean category wins [T])."""
    reg, po, tie = u
    a, b = h.sched[:, :, 0], h.sched[:, :, 1]
    win_a = reg < p[a, b][None]
    cats_a = win_a.sum(axis=3).reshape(h.reps, -1).astype(float)
    wins = cats_a @ h.onehot_a + (h.n_cats - cats_a) @ h.onehot_b
    key = wins + 1e-3 * tie
    T = h.lg.teams
    P = min(h.lg.playoff_teams, T)
    made, champ = np.zeros(T), np.zeros(T)
    for r in range(h.reps):
        seeds = list(np.argsort(-key[r], kind="stable")[:P])
        made[seeds] += 1
        champ[h._bracket(seeds, p, po[r])] += 1
    return made / h.reps, champ / h.reps, wins.mean(axis=0)


def score(eng, rosters, room, n=SEASONS):
    """Every team's measures over n seasons of outcome draws, the same for every drafter of the room (Engine.season's
    draws in its order).  Returns {measure: [teams]} of means."""
    rng = np.random.default_rng([room, 2027])
    N = eng.n
    d = np.empty((n, N), np.int64)
    us = []
    for s in range(n):
        d[s] = rng.integers(0, eng.pool.n_draws, (1, N))[0]
        if eng.h2h is not None:
            us.append(eng.h2h.uniforms(rng))
    X = eng.pool.draws[np.arange(N)[None, :], d]  # [n, players, comps]
    tot = eng.totals(X, rosters)  # [n, T, C]
    total = eng.scorer.roto_points(tot).sum(axis=2)  # [n, T]
    gt = (total[:, None, :] > total[:, :, None]).sum(axis=2)
    ge = (total[:, None, :] >= total[:, :, None]).sum(axis=2)
    place = (gt + ge + 1) / 2.0
    out = {"roto": total.mean(0), "finish": place.mean(0), "win": (place == 1.0).mean(0), "top": (place <= eng.lg.playoff_teams).mean(0)}
    if eng.h2h is not None:
        res = [h2h_all(eng.h2h, eng.scorer.h2h_p(tot[s]), us[s]) for s in range(n)]
        out["playoff"] = np.mean([r[0] for r in res], axis=0)
        out["champ"] = np.mean([r[1] for r in res], axis=0)
        out["h2h_wins"] = np.mean([r[2] for r in res], axis=0)
    return out


# ---- the drafters --------------------------------------------------------------------------------


def first_legal(d, board):
    for i in board:
        if d.legal_for(d.user, i):
            return i
    return next(i for i in range(d.eng.n) if not d.gone[i])


def static_board(s, key):
    p, dnd = s.pool, s.eng.dnd
    order = range(s.eng.n) if key == "value" else np.argsort(-p.own, kind="stable").tolist()
    return [i for i in order if not dnd[i]]


def play_static(s, kind, diag):
    """V (kind "value") or R ("own"): a fixed board, bids of its own $ at its own inflation, nominations of the best
    legal player on its board.  The rivals act as in the page's mock draft."""
    d = s.draft
    board = static_board(s, kind)
    bid = d.user_value_bid if kind == "value" else d.own_price
    play_rule(s, lambda: first_legal(d, board), bid, diag)


def play_rule(s, pick, bid, diag, before=None):
    """A drafter without a simulation of the draft: pick() gives its pick (snake) or nomination (auction), bid(j) its
    maximum bid on the lot j; before(j or None), if given, runs at each of the user's decisions first."""
    d, user = s.draft, s.draft.user
    if d.mode == "snake":
        while not d.done():
            if d.on_clock()[1] != user:
                d.auto()
                continue
            if before:
                before(None)
            d.take(pick())
            diag["stops"] += 1
        return
    while not d.done():
        if d.lot is None:
            if d.nominator() == user:
                if before:
                    before(None)
                d.nominate(pick())
                diag["stops"] += 1
            else:
                d.auto_nominate()
        j = d.lot[0]
        mine = d.legal_for(user, j) and d.max_bid(user) >= s.lg.min_bid
        if mine and before and s.pool.value[j] >= AUTO_BELOW:
            before(j)
            diag["stops"] += 1
        d.resolve(bid(j) if mine else 0)


def play_ce(s, diag, room):
    """C: V with CE now.  At each decision the baseline (the skip, or the pass) over CE_SIMS worlds gives M, S, H of
    the user's team (Session.target); each player's CE (ce.py) is priced in $ (risk.js dollarsOf).  Lots under the
    page's $3 use the last M, S, H."""
    d, eng, user = s.draft, s.eng, s.draft.user
    state = {"tgt": None, "usd": {}}

    def refresh(_):
        snap = d.snap()
        cand = SKIP if d.mode == "snake" else ("bid", 0)
        rng = np.random.default_rng([room, len(d.log), 3])
        _, league, hw = eng.chunk(snap, [cand], CE_SIMS, rng, 0, with_wins=True)
        state["tgt"], _ = s.target(league, hw)
        state["usd"] = {}

    def usd(i):
        if state["tgt"] is None:
            return float(s.pool.value[i])
        if i not in state["usd"]:
            c = s.ce_cols(i, state["tgt"])["ce_usd"]
            state["usd"][i] = float(s.pool.value[i]) if c is None else float(c)
        return state["usd"][i]

    def pick():
        legal = [i for i in range(eng.n) if not d.gone[i] and not eng.dnd[i] and d.legal_for(user, i)]
        if not legal:
            return first_legal(d, range(eng.n))
        return max(legal, key=lambda i: (usd(i), -i))

    play_rule(s, pick, lambda j: d.user_value_bid(j, usd(j)), diag, before=refresh)


def play_engine(s, diag, nomination="rule", room=0):
    """E: the page's flow (Session.begin_stop, simulate, auto).  An auction nomination other than the rule's is made
    without a simulation.  With the session's bid_cap "value", the maximum bid at a lot is at most the value bid
    (the $ at the user's inflation, Draft.user_value_bid): part 3's guard against the winner's curse of noisy
    break-evens, the page's default since part 4."""
    d = s.draft
    rnd = np.random.default_rng([room, 5])
    vboard = static_board(s, "value")
    bes = []
    while True:
        info = json.loads(s.begin_stop())
        if info["done"]:
            break
        if info["kind"] == "nominate" and nomination != "rule":
            if nomination == "best":
                i = first_legal(d, vboard)
            else:
                legal = [i for i in range(s.eng.n) if not d.gone[i] and d.legal_for(d.user, i)]
                pool = [i for i in legal if s.pool.drafted[i]] or legal
                i = int(pool[rnd.integers(len(pool))])
            _ok(s.nominate(index=i))
            diag["stops"] += 1
            continue
        t0 = time.perf_counter()
        res = json.loads(s.simulate())
        diag["sim_s"] += time.perf_counter() - t0
        diag["stops"] += 1
        if info["kind"] == "bid" and s.cfg["bid_cap"]:
            diag["capped"] = diag.get("capped", 0) + bool(res["bid"]["capped"])
        r = _ok(s.auto())
        if info["kind"] == "nominate":
            diag["nom_engine"] += res["nomination"]["chosen"] == "engine"
        elif info["kind"] == "bid":
            be = res["break_even"]
            lot = res["lot"]
            bes.append((lot["value"], be[s.objective]["max_bid"], be["points"]["max_bid"], lot["expected_price"], bool(r["mine"]), info["made"]))
    if bes:
        v = np.array([b[0] for b in bes])
        mo, mp = np.array([b[1] for b in bes], float), np.array([b[2] for b in bes], float)
        big = v >= 10
        third = np.array([b[5] for b in bes]) * 3 // (s.lg.teams * s.lg.roster_size)  # the lot's third of the draft (0, 1, 2)
        for k in range(3):
            m = big & (third == k)
            diag["be_obj_ratio_%d" % (k + 1)] = float(np.mean(mo[m] / v[m])) if m.any() else math.nan
        diag.update(lots_priced=len(bes), lots_won=int(sum(b[4] for b in bes)),
                    be_obj_ratio=float(np.mean(mo[big] / v[big])) if big.any() else math.nan,
                    be_pts_ratio=float(np.mean(mp[big] / v[big])) if big.any() else math.nan,
                    be_obj_gt_pts=float(np.mean(mo > mp)), be_obj_lt_pts=float(np.mean(mo < mp)),
                    be_abs_gap=float(np.mean(np.abs(mo - mp))))  # fmt: skip


def _ok(r):
    r = json.loads(r)
    if not r.get("ok"):
        raise RuntimeError(r)
    return r


# ---- one job: one drafter in one room --------------------------------------------------------------


def job_key(j):
    return "|".join(str(j[k]) for k in ("fmt", "mode", "room", "rivals", "drafter"))


def run_job(j):
    """Play one room with one drafter and score it.  Returns one row (the user's measures and diagnostics)."""
    t0, c0 = time.perf_counter(), time.process_time()
    fmt, mode, room, rivals, drafter = j["fmt"], j["mode"], int(j["room"]), j["rivals"], j["drafter"]
    seat, seed = room_seat(room), room_seed(room)
    parts = drafter.split(":")
    diag = {"stops": 0, "sim_s": 0.0, "nom_engine": 0}
    if parts[0] == "E":
        s = session(fmt, mode, seat, seed, int(parts[2]), parts[1], cap=len(parts) > 4 and parts[4] == "cap")
        set_rivals(s, rivals, room)
        play_engine(s, diag, parts[3] if len(parts) > 3 else "rule", room)
    else:
        s = session(fmt, mode, seat, seed)
        set_rivals(s, rivals, room)
        if parts[0] == "V":
            play_static(s, "value", diag)
        elif parts[0] == "R":
            play_static(s, "own", diag)
        elif parts[0] == "C":
            play_ce(s, diag, room)
        else:
            raise ValueError(drafter)
    d, eng, p = s.draft, s.eng, s.pool
    assert d.done()
    me = d.user
    sc = score(eng, d.rosters, room)
    roster = d.rosters[me]
    lineup = eng.lineup(roster)
    total = sc["roto"]
    row = {"key": job_key(j), "fmt": fmt, "mode": mode, "room": room, "seat": seat, "rivals": rivals, "drafter": drafter,
           "win": sc["win"][me], "top": sc["top"][me], "playoff": sc.get("playoff", sc["top"])[me], "champ": sc.get("champ", sc["win"])[me],
           "roto": total[me], "finish": sc["finish"][me], "h2h_wins": sc["h2h_wins"][me] if "h2h_wins" in sc else math.nan,
           "rank": int(1 + (total > total[me]).sum()), "team_value": float(p.value[roster].sum()), "lineup_value": float(p.value[lineup].sum()),
           "risk_value": float(np.nansum(p.own[roster])), "n_sp": sum(p.role[i] == "SP" for i in roster), "n_rp": sum(p.role[i] == "RP" for i in roster),
           "n_bench": len(roster) - len(lineup)}  # fmt: skip
    if mode == "auction":
        paid = d.paid[me]
        row.update(spent=s.lg.budget - d.budget[me], money_left=d.budget[me],
                   overpay=float(sum(pr - p.value[i] for i, pr in zip(roster, paid))),
                   rivals_left=float(np.mean([d.budget[t] for t in range(s.lg.teams) if t != me])))  # fmt: skip
        # the user's purchases (lot number: $ value: price) and the money left after each third of the draft
        n_all = s.lg.teams * s.lg.roster_size
        buys = [(n, i, pr) for n, t, i, pr in d.log if t == me]
        row["buys"] = ";".join("%d:%.0f:%d" % (n, p.value[i], pr) for n, i, pr in buys)
        for k in (1, 2):
            row["left_%d" % k] = s.lg.budget - sum(pr for n, _, pr in buys if n <= k * n_all // 3)
        late = [(i, pr) for n, i, pr in buys if n > 2 * n_all // 3]
        row["late_spent"] = sum(pr for _, pr in late)
        row["late_overpay"] = float(sum(pr - p.value[i] for i, pr in late))
    row.update(diag)
    row.update(time_s=time.perf_counter() - t0, cpu_s=time.process_time() - c0, pid=os.getpid(), at=time.strftime("%Y-%m-%d %H:%M:%S"))
    return {k: (round(v, 6) if isinstance(v, float) else int(v) if isinstance(v, (bool, np.bool_, np.integer)) else v) for k, v in row.items()}


# ---- plans ---------------------------------------------------------------------------------------

MAIN = ["V", "R", "C", "E:payout:100", "E:points:100"]
# the page's engine since part 4 (the user, 2026-10-13): roto on mean roto points, head-to-head on the payout; the
# auction's maximum bid capped at the value bid
DEFAULT_E = {"roto": "E:points:100:rule:cap", "h2h": "E:payout:100:rule:cap"}


def plan(name):
    """The jobs of a plan, in the order they run (room by room, so a stopped run leaves whole rooms)."""
    jobs = []

    def add(fmts, modes, rooms, drafters, rivals="base"):
        for room in rooms:
            for mode in modes:
                for fmt in fmts:
                    for dr in drafters:
                        jobs.append({"fmt": fmt, "mode": mode, "room": room, "rivals": rivals, "drafter": dr})

    # sizes for about 4.5 h of 3 workers: an engine room at 100 sims per option takes about 26 s (snake, roto), 50 s
    # (snake, head-to-head), 340 s (auction, roto) and 470 s (auction, head-to-head); V and R under 1 s, C 1-30 s
    both = ("roto", "h2h")
    if name == "pilot":
        add(both, ("auction", "snake"), [0], MAIN)
    elif name == "main_snake":
        add(both, ("snake",), range(48), MAIN)
    elif name == "main_auction":
        add(both, ("auction",), range(14), MAIN)
    elif name == "sims_snake":
        add(both, ("snake",), range(16), ["E:payout:200"])
        add(("roto",), ("snake",), range(12), ["E:payout:400"])
    elif name == "sims_auction":
        add(("roto",), ("auction",), range(4), ["E:payout:200"])
    elif name == "nominate":
        add(("roto",), ("auction",), range(4), ["E:payout:100:best", "E:payout:100:random"])
    elif name == "rivals_snake":
        for rv in ("m30", "dollar"):
            add(both, ("snake",), range(16), ["V", "R", "C", "E:payout:100"], rv)
    elif name == "rivals_auction":
        for rv in ("m30", "dollar"):
            add(("roto",), ("auction",), range(3), ["V", "R", "C", "E:payout:100"], rv)
    elif name == "cap_auction":
        add(("roto",), ("auction",), range(8), ["E:payout:100:rule:cap"])
        add(("h2h",), ("auction",), range(4), ["E:payout:100:rule:cap"])
    elif name == "part4_auction":  # the page's defaults since part 4 (DEFAULT_E) in every main auction room
        for room in range(14):
            for fmt in ("roto", "h2h"):
                jobs.append({"fmt": fmt, "mode": "auction", "room": room, "rivals": "base", "drafter": DEFAULT_E[fmt]})
    elif name == "part4_rivals":  # the defaults against the other rival models, in the auction
        for rv in ("m30", "dollar"):
            for room in range(6):
                for fmt in ("roto", "h2h"):
                    for dr in ("V", "R", DEFAULT_E[fmt]):
                        jobs.append({"fmt": fmt, "mode": "auction", "room": room, "rivals": rv, "drafter": dr})
    else:
        raise ValueError("no plan %r" % name)
    return jobs


def load_rows():
    rows = {}
    if os.path.exists(STORE):
        with open(STORE, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    r = json.loads(line)
                    if "error" not in r:
                        rows[r["key"]] = r
    return rows


def _init_worker():
    try:
        import psutil

        psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    except Exception:
        pass


def _safe_job(j):
    try:
        return run_job(j)
    except Exception:
        return {"key": job_key(j), "error": traceback.format_exc()}


def run(plans, workers=3, hours=None):
    from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait

    _init_worker()  # the parent too
    os.makedirs(OUT, exist_ok=True)
    have = load_rows()
    jobs = [j for name in plans for j in plan(name)]
    seen, todo = set(), []
    for j in jobs:
        k = job_key(j)
        if k not in have and k not in seen:
            seen.add(k)
            todo.append(j)
    print("%d jobs in %s, %d to run, %d workers" % (len(jobs), "+".join(plans), len(todo), workers), flush=True)
    stop_at = time.time() + 3600 * hours if hours else math.inf
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker) as ex, open(STORE, "a", encoding="utf-8") as fh:
        it, pending, n = iter(todo), {}, 0
        while True:
            while len(pending) < workers and time.time() < stop_at:
                j = next(it, None)
                if j is None:
                    break
                pending[ex.submit(_safe_job, j)] = j
            if not pending:
                break
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for f in done:
                j = pending.pop(f)
                r = f.result()
                fh.write(json.dumps(r) + "\n")
                fh.flush()
                n += 1
                if "error" in r:
                    print("ERROR %s\n%s" % (r["key"], r["error"]), flush=True)
                else:
                    print("%4d/%d %6.0f s  %-40s %6.1f s  win %.3f roto %.1f%s" % (n, len(todo), time.time() - t0, r["key"], r["time_s"], r["win"], r["roto"],
                          "" if r["mode"] == "snake" else "  left $%d" % r["money_left"]), flush=True)  # fmt: skip
    print("done: %d jobs in %.0f s" % (n, time.time() - t0), flush=True)


# ---- the self-test -------------------------------------------------------------------------------


def selftest():
    """The cached session builder against web_api.Session; the all-teams scorer against Engine.season."""
    with open(RISK_FILES[0], "rb") as fh:
        rh = fh.read()
    with open(RISK_FILES[1], "rb") as fh:
        rp = fh.read()
    # the page's defaults (objective None, bid_cap "value") and part 3's engine (the payout's measure, no cap)
    for fmt, mode, objective, cap in (("h2h", "snake", None, True), ("roto", "auction", None, True), ("roto", "auction", "payout", False)):
        f = FMTS[fmt]
        with open(table_path(fmt), encoding="utf-8") as fh:
            table = fh.read()
        ref = Session(dict(mode=mode, slot=5, sims=12, chunk=12, seed=99, format=f["format"], payout=f["payout"], playoff_teams=f["playoff_teams"],
                           auto_below=AUTO_BELOW, objective=objective, bid_cap="value" if cap else "none"), table, rh, rp)  # fmt: skip
        mine = session(fmt, mode, 5, 99, 12, objective, cap)
        for _ in range(3):
            a, b = json.loads(ref.begin_stop()), json.loads(mine.begin_stop())
            assert a == b, "stop differs"
            ra, rb = json.loads(ref.simulate()), json.loads(mine.simulate())
            assert ra == rb, "result differs"
            assert json.loads(ref.auto()) == json.loads(mine.auto())
        print("ok  session builder = web_api.Session (%s %s, objective %s, cap %s: 3 priced stops)" % (fmt, mode, mine.objective, cap))
    s = session("h2h", "snake", 5, 99, 12)
    while not s.draft.done():
        s.draft.auto()
    eng = s.eng
    n = 12
    ref = eng.season(s.draft.rosters, n, np.random.default_rng([3, 2027]))
    sc = score(eng, s.draft.rosters, 3, n)
    from engine import CHAMP, FIN, PLAYOFF, PTS, WIN

    for m, k in (("roto", PTS), ("finish", FIN), ("win", WIN), ("playoff", PLAYOFF), ("champ", CHAMP)):
        assert np.allclose(sc[m], ref[:, k, :].mean(axis=1)), m
    print("ok  score() = Engine.season (h2h, %d seasons, every team)" % n)
    t0 = time.time()
    score(eng, s.draft.rosters, 3, SEASONS)
    print("    score(): %d seasons in %.1f s (h2h)" % (SEASONS, time.time() - t0))


def replay(keys, workers=3):
    """Run stored jobs again and compare their measures with rooms.jsonl (the jobs are deterministic): a check that a
    change of the engine or of this script leaves the earlier drafters' results as they were."""
    from concurrent.futures import ProcessPoolExecutor

    have = load_rows()
    missing = [k for k in keys if k not in have]
    assert not missing, "not in rooms.jsonl: %s" % missing
    jobs = [dict(zip(("fmt", "mode", "room", "rivals", "drafter"), k.split("|"))) for k in keys]
    for j in jobs:
        j["room"] = int(j["room"])
    with ProcessPoolExecutor(max_workers=min(workers, len(jobs)), initializer=_init_worker) as ex:
        new = list(ex.map(run_job, jobs))
    bad = 0
    for r in new:
        old = have[r["key"]]
        fields = [m for m in ("win", "top", "playoff", "champ", "roto", "team_value", "money_left", "buys", "capped") if m in old]  # early rows: no buys
        diff = [m for m in fields if old[m] != r.get(m)]
        bad += bool(diff)
        print("%s  %s  (%s)%s" % ("ok  " if not diff else "DIFF", r["key"], " ".join(fields), "" if not diff else "  differ: " + ", ".join(diff)), flush=True)
    return 1 if bad else 0


# ---- the report ----------------------------------------------------------------------------------

MEAS = {"roto": [("win", "win%", 100), ("top", "top-4%", 100), ("roto", "roto pts", 1), ("finish", "finish", 1)],
        "h2h": [("playoff", "playoff%", 100), ("champ", "title%", 100), ("h2h_wins", "cat. wins", 1), ("roto", "roto pts", 1)]}  # fmt: skip
NAMES = {"V": "median value (V)", "R": "risk-aware $ (R)", "C": "CE now (C)", "E:payout:100": "engine, payout (E-pay)", "E:points:100": "engine, roto pts (E-pts)",
         "E:payout:200": "E-pay, 200 sims", "E:payout:400": "E-pay, 400 sims", "E:payout:100:best": "E-pay, nominate the best",
         "E:payout:100:random": "E-pay, nominate at random", "E:payout:100:rule:cap": "E-pay, max bid capped at the value bid",
         "E:points:100:rule:cap": "E-pts, max bid capped at the value bid"}  # fmt: skip
FMT_NAME = {"roto": "roto, winner take all (payout: win%)", "h2h": "head-to-head, playoffs 6 of 12 (payout: playoff%)"}
RIVAL_NAME = {"base": "the engine's own rival model (market log-SD 0.15, team 0.10)", "m30": "market log-SD 0.30 (team 0.10)",
              "dollar": "the calculator's $ only (no noise)"}  # fmt: skip
ORDER = ["V", "R", "C", "E:payout:100", "E:points:100", "E:payout:200", "E:payout:400", "E:payout:100:best", "E:payout:100:random",
         "E:payout:100:rule:cap", "E:points:100:rule:cap"]


def paired(rows, a, b, m, scale=1.0):
    """(mean of a - b, SE over rooms, rooms) for measure m over the rooms that have both."""
    A = {r["room"]: r for r in rows if r["drafter"] == a}
    B = {r["room"]: r for r in rows if r["drafter"] == b}
    x = np.array([A[k][m] - B[k][m] for k in sorted(set(A) & set(B)) if A[k].get(m) is not None and B[k].get(m) is not None], float) * scale
    x = x[np.isfinite(x)]
    if len(x) < 2:
        return math.nan, math.nan, len(x)
    return float(x.mean()), float(x.std(ddof=1) / math.sqrt(len(x))), len(x)


def cell(m, se, nd=1):
    """A paired difference with its SE; ** if beyond 2 SE, * if beyond 1.5 SE."""
    if not math.isfinite(m):
        return "–"
    z = abs(m) / se if se > 0 else math.inf
    return "%+.*f (%.*f)%s" % (nd, m, nd, se, "**" if z >= 2 else "*" if z >= 1.5 else "")


def measures(fmt, mode, extra=True):
    out = list(MEAS[fmt])
    if mode == "auction":
        out.append(("money_left", "money left $", 1))
    if extra:
        out.append(("team_value", "roster $", 1))
    return out


def table_vs(sub, fmt, mode, drafters, ref, ref_name):
    meas = measures(fmt, mode)
    out = ["| drafter | rooms | " + " | ".join(lbl for _, lbl, _ in meas) + " |", "|---|---|" + "---|" * len(meas)]
    rr = [r for r in sub if r["drafter"] == ref]
    if rr:
        cells = ["%.*f" % (2 if m == "finish" else 1, np.mean([r[m] for r in rr]) * sc) for m, _, sc in meas]
        out.append("| %s: mean | %d | %s |" % (NAMES.get(ref, ref), len(rr), " | ".join(cells)))
    for dr in drafters:
        if dr == ref or not any(r["drafter"] == dr for r in sub):
            continue
        cells, n = [], 0
        for m, _, sc in meas:
            mu, se, k = paired(sub, dr, ref, m, sc)
            n = max(n, k)
            cells.append(cell(mu, se, 2 if m == "finish" else 1))
        out.append("| %s − %s | %d | %s |" % (NAMES.get(dr, dr), ref_name, n, " | ".join(cells)))
    return out


def _mean(rr, k, nd=1, scale=1.0):
    v = [r[k] for r in rr if isinstance(r.get(k), (int, float)) and math.isfinite(r[k])]
    return "%.*f" % (nd, scale * np.mean(v)) if v else "–"


METHOD = """\
# R8 part 3: the draft engine against simpler drafters

Generated by `python part3_check.py report` on {today} from `rooms.jsonl` ({n_rows} drafted rooms; the per-room
results are in `rooms.csv`).  The script is `../part3_check.py`.  DESIGN.md section 11 lists what part 3 checks.

## 1. The question

The draft mode's default objective is the payout's (the user's decision of 2026-10-13): win% in a roto league
with the winner-take-all payout, playoff% in a head-to-head league with the playoffs payout, also for the
auction's break-even bid.  Mean roto points is the option.  Part 2 drafted one room on each objective: win%
finished 6th, roto points 1st.  Part 3 drafts many rooms with each drafter in the same seat and compares the
results with the median-value drafter.

**Part 4 (2026-10-13).** After part 3 the user changed the page's defaults: in roto the objective is mean roto
points (head-to-head keeps the payout's playoff%), and the auction's maximum bid is the break-even capped at the
value bid.  Section 4.6 checks these defaults in every main auction room and against the other rival models.
The rows of part 3 are unchanged: `part3_check.py replay` runs stored jobs again with the changed engine.

## 2. The method

1. **The league.** 12 teams, the calculator's default Yahoo 5x5 league (C, 1B, 2B, 3B, SS, 3 OF, 2 UT, 2 SP,
   2 RP, 4 P, 5 bench; $260, min bid $1).  Two payouts: roto with the winner-take-all payout, and head-to-head
   each category with the playoffs payout (6 of 12 teams).  The player table is the page's own
   (`export_players.mjs` with the page's form for each format, as `page_check.py` builds it: calc.js, then
   risk.js with that format and payout).  The outcome draws are the 2027 test files (`B1_b4_sim_risk`,
   `B2s_env_sim_risk`: the auction CSVs and the R1 risk files).
2. **A room.** Room r has the seed 20270401 + 7919 r and the user's seat 1 + (7 r + 4) mod 12 (room 0 is seat
   5; each block of 12 rooms takes every seat once).  The seed fixes the 11 rivals: their valuations are drawn
   once, as in the page's mock draft (`Draft`'s live world).  The user's seat is drafted by each drafter in
   turn, in the same room (common random numbers).  The rivals react to what the user takes.
3. **The rivals.** The page's mock rivals (DESIGN.md section 4): in a snake draft, the best legal player on
   the rival's own board; in an auction, the rival nominates the best legal player on its board and bids its
   own valuation at its inflation (bench share 0.25 for a bench player); the lot goes at the second bid + $1.
   Three rival models: {rivals}.  The engine always plans with its own model (0.15, 0.10).
4. **The drafters.**
   * E-pay: the engine on the payout's objective, as the page drives it (`web_api.Session`: `begin_stop`,
     `simulate`, `auto`): each stop's options priced over 100 worlds (the page's default), the recommendation
     taken.  At a lot it bids the break-even on the objective; at the user's nomination it nominates by the rule
     of section 12.4 (the engine's choice replaces the rule's only if it gains 2 paired SE).  Lots worth less
     than $3 go by value bids without a stop (the page's default).  The engine's other settings are the
     page's: 8 outcome seasons per world, 16 head-to-head seasons, 1 candidate per position and 6 more from the
     board in a snake draft, the pass and 5 forced buys at a lot, 5 drains and 2 targets at a nomination.
   * E-pts: the same on mean roto points.
   * E-pay with the cap (an addition of part 3, a test of a guard): E-pay, but at each priced lot the maximum
     bid is at most V's bid (the $ at the user's inflation).  E-pts with the cap: the same on mean roto points.
     Since part 4 these are the page's defaults: E-pts with the cap in roto, E-pay with the cap in head-to-head.
   * V, the median-value drafter: the calculator's $ board.  Snake: the best legal player by $.  Auction: it
     nominates the best legal player by $ and bids the $ at its own inflation (`Draft.user_value_bid`: the bench
     share for a bench player).  This is the rivals' rule without noise.
   * R: V with risk.js's risk-aware $ (before the draft) in place of the $ (`Draft.own_price` for the bids).
   * C: V with CE now: at each decision 30 play-outs of the baseline (the skip, or the pass) give M, S and H of
     the user's team (`Session.target`), and each player's CE (`ce.py`, risk.js's EffValue and Var_eff) is priced
     in $ with risk.js's `dollarsOf`.  It takes (or nominates) the legal player with the highest CE $, and bids
     the CE $ at its inflation.  A lot under $3 uses the last M, S, H.
5. **The internal decisions.** The rivals do not simulate (their picks and bids follow the rules of item 3), and
   in a play-out the user's later picks and bids follow the static $ board and value bids (DESIGN.md section 5).
   Thus the only simulations are the engine's 100 worlds per option (and C's 30 baseline play-outs); nothing
   smaller could be used for the play-outs' internal decisions.
6. **The score.** Each finished room is scored on the same {seasons} seasons of the outcome draws (one of the 50
   draws of each player per season, the room's own seasons; in head-to-head 16 head-to-head seasons on each:
   `Engine.season`'s method for all teams at once, checked against it by `part3_check.py selftest`).  The
   measures are the user's win% (first in the roto standings), top-4% (roto), playoff% and title% (head-to-head),
   regular-season category wins, mean roto points, mean finish (1 = first), the calculator's $ of the roster,
   and the money left in an auction.
7. **The statistics.** For each room, the drafter's measure minus the reference drafter's measure in the same
   room.  The tables give the mean over the rooms and its standard error (SD / √rooms).  ** marks a mean
   beyond 2 SE, * beyond 1.5 SE.  The rooms are independent; the seasons within a room are shared, so the
   season noise mostly cancels in the differences.
8. **Compute.** CPU only, at most 3 worker processes at BELOW_NORMAL priority with one BLAS thread each:
   {worker_hours:.1f} worker-hours in {jobs} jobs.  Other sessions loaded the machine for part of the run, so
   some auction run times (section 5) are longer than the engine needs.

## 3. Assumptions and limits

1. **The model checks itself.** The rooms are played on the same outcome draws (R1) and with the same
   head-to-head approximation (DESIGN.md section 6) that the engine plans with.  A gain here is a gain inside
   the model.  The draws are independent across players (P8 = 0).  R10 checks the method on real seasons.
2. **The base rivals are the engine's own model.** The engine knows their noise and their bid rule.  The rival
   models m30 and dollar test how much of the gain depends on that.  The rival parameters have no validation
   (DESIGN.md section 10).
3. **V is a strong reference.** V takes the best $ projection every time and bids its exact value, while the
   rivals have noise.  Thus V's mean win% is above 1/12.
4. **Few rooms in the expensive parts.** An auction room with the engine takes 4–8 minutes of CPU per drafter.
   The auction tables have {auction_rooms} rooms in the main comparison; the nomination, sim-count, cap and rival
   checks of the auction have 2–8 rooms.  Their SEs are large: read them as indications.
5. **Seats** rotate with the room, so each comparison mixes the seats.
6. **No in-season moves.** The bench does not count; the lineup is set by the projections; the playing-time
   fill stands in for replacements (DESIGN.md section 10).
7. **The objective's measures.** In roto, win% and the roto points come from the same standings.  In
   head-to-head, playoff% and title% come from the head-to-head model; the roto points of a head-to-head room
   are a measure of the roster only.
"""


def report():
    rows = list(load_rows().values())
    os.makedirs(OUT, exist_ok=True)
    keys = ["fmt", "mode", "room", "seat", "rivals", "drafter", "win", "top", "playoff", "champ", "roto", "finish", "rank", "h2h_wins", "team_value",
            "lineup_value", "risk_value", "spent", "money_left", "overpay", "rivals_left", "n_sp", "n_rp", "n_bench", "stops", "lots_priced", "lots_won",
            "be_obj_ratio", "be_pts_ratio", "be_obj_gt_pts", "be_obj_lt_pts", "be_abs_gap", "be_obj_ratio_1", "be_obj_ratio_2", "be_obj_ratio_3", "capped",
            "left_1", "left_2", "late_spent", "late_overpay", "nom_engine", "sim_s", "time_s", "cpu_s", "buys"]  # fmt: skip
    rows.sort(key=lambda r: (r["rivals"], r["mode"], r["fmt"], r["room"], ORDER.index(r["drafter"]) if r["drafter"] in ORDER else 99))
    with open(os.path.join(OUT, "rooms.csv"), "w", encoding="utf-8-sig", newline="") as fh:  # UTF-8 with a BOM, for Excel
        w = csv.DictWriter(fh, keys, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in keys})

    def sel(mode, fmt, rivals="base"):
        return [r for r in rows if r["mode"] == mode and r["fmt"] == fmt and r["rivals"] == rivals]

    def drafters(sub):
        return sorted({r["drafter"] for r in sub}, key=lambda d: ORDER.index(d) if d in ORDER else 99)

    auction_rooms = len({r["room"] for r in sel("auction", "roto") if r["drafter"] == "E:payout:100"})
    text = METHOD.format(today=time.strftime("%Y-%m-%d"), n_rows=len(rows), seasons=SEASONS, auction_rooms=auction_rooms,
                         rivals="; ".join("%s, %s" % (k, v) for k, v in RIVAL_NAME.items()),
                         worker_hours=sum(r["time_s"] for r in rows) / 3600, jobs=len(rows))  # fmt: skip
    out = [text, "## 4. Results", "", "### 4.1 Each drafter against the median-value drafter (V), rivals of the engine's own model", "",
           "The first row is V's mean; the other rows are the paired differences (drafter − V), with the SE in brackets.  Percentages are points of "
           "percent; finish: lower is better.", ""]  # fmt: skip
    for mode in ("snake", "auction"):
        for fmt in ("roto", "h2h"):
            sub = sel(mode, fmt)
            if sub:
                out += ["#### %s, %s" % (mode, FMT_NAME[fmt]), ""] + table_vs(sub, fmt, mode, [d for d in drafters(sub) if d in MAIN], "V", "V") + [""]
    out += ["### 4.2 The engine's options against its default (E-pay at 100 sims), rivals of the engine's own model", "",
            "E-pts: the objective mean roto points; 200 and 400 sims per option; the nomination by the best player on the $ board, or at random "
            "(a random legal player of the calculator's drafted pool), in place of the rule; the maximum bid capped at the value bid (the $ at "
            "the user's inflation).", ""]  # fmt: skip
    for mode in ("snake", "auction"):
        for fmt in ("roto", "h2h"):
            sub = sel(mode, fmt)
            others = [d for d in drafters(sub) if d.startswith("E:") and d != "E:payout:100"]
            if others:
                out += ["#### %s, %s" % (mode, FMT_NAME[fmt]), ""] + table_vs(sub, fmt, mode, others, "E:payout:100", "E-pay") + [""]
    sub = sel("auction", "roto") + sel("auction", "h2h")
    if any(r["drafter"] == "E:payout:100:rule:cap" for r in sub):
        out += ["#### The auction: E-pay with the cap against V (the rooms that have it)", ""]
        for fmt in ("roto", "h2h"):
            sf = sel("auction", fmt)
            if any(r["drafter"] == "E:payout:100:rule:cap" for r in sf):
                rooms = {r["room"] for r in sf if r["drafter"] == "E:payout:100:rule:cap"}
                sf = [r for r in sf if r["room"] in rooms]
                out += ["%s:" % FMT_NAME[fmt], ""] + table_vs(sf, fmt, "auction", ["E:payout:100", "E:points:100", "E:payout:100:rule:cap"], "V", "V") + [""]
    out += ["### 4.3 Rivals that are not the engine's own model", ""]
    for rivals in ("m30", "dollar"):
        for mode in ("snake", "auction"):
            for fmt in ("roto", "h2h"):
                sub = sel(mode, fmt, rivals)
                if sub:
                    out += ["#### %s, %s; rivals: %s" % (mode, FMT_NAME[fmt], RIVAL_NAME[rivals]), ""]
                    out += table_vs(sub, fmt, mode, drafters(sub), "V", "V") + [""]
    out += ["### 4.4 The auction: what each drafter paid", "",
            "Means over the rooms (rivals of the engine's own model).  Overpay: the price minus the calculator's $ over the user's players.  "
            "The break-evens are the engine's maximum bids at its priced lots of $10 or more, as a share of the calculator's $, on the objective "
            "and on roto points (both from the same worlds at each lot); obj > pts: the share of the priced lots where the objective's maximum bid "
            "is the higher.", "",
            "| format | drafter | rooms | spent $ | money left $ | overpay $ | roster $ | lineup $ | priced lots | lots won | break-even / $ (objective) | "
            "break-even / $ (roto pts) | obj > pts | obj < pts | mean abs gap $ | engine's nominations |", "|---" * 16 + "|"]  # fmt: skip
    for fmt in ("roto", "h2h"):
        sub = sel("auction", fmt)
        for dr in drafters(sub):
            rr = [r for r in sub if r["drafter"] == dr]
            out.append("| %s | %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                fmt, NAMES.get(dr, dr), len(rr), _mean(rr, "spent"), _mean(rr, "money_left"), _mean(rr, "overpay"), _mean(rr, "team_value"),
                _mean(rr, "lineup_value"), _mean(rr, "lots_priced"), _mean(rr, "lots_won"), _mean(rr, "be_obj_ratio", 3), _mean(rr, "be_pts_ratio", 3),
                _mean(rr, "be_obj_gt_pts", 2), _mean(rr, "be_obj_lt_pts", 2), _mean(rr, "be_abs_gap"), _mean(rr, "nom_engine")))  # fmt: skip
    out += ["", "Where the money goes (the rows with the purchase log): the money left after the first and the second third of the lots, the "
            "money spent in the last third and its overpay, and the engine's maximum bid on the objective as a share of the $ in each third "
            "(lots of $10 or more).", "",
            "| format | drafter | rooms | left after 1/3 $ | left after 2/3 $ | spent in the last third $ | overpay in the last third $ | "
            "break-even / $, 1st third | 2nd third | 3rd third |", "|---" * 10 + "|"]  # fmt: skip
    for fmt in ("roto", "h2h"):
        sub = [r for r in sel("auction", fmt) if "left_1" in r]
        for dr in drafters(sub):
            rr = [r for r in sub if r["drafter"] == dr]
            out.append("| %s | %s | %d | %s | %s | %s | %s | %s | %s | %s |" % (
                fmt, NAMES.get(dr, dr), len(rr), _mean(rr, "left_1"), _mean(rr, "left_2"), _mean(rr, "late_spent"), _mean(rr, "late_overpay"),
                _mean(rr, "be_obj_ratio_1", 3), _mean(rr, "be_obj_ratio_2", 3), _mean(rr, "be_obj_ratio_3", 3)))  # fmt: skip
    out += ["", "What the user paid for the players of $10 or more (from the purchase logs): the purchases per room, and the mean price as a "
            "share of the calculator's $, in the first third of the lots and later.", "",
            "| format | drafter | rooms | purchases per room | price / $ | 1st third: purchases | 1st third: price / $ | later: purchases | "
            "later: price / $ | $ bought per room |", "|---" * 10 + "|"]  # fmt: skip
    for fmt in ("roto", "h2h"):
        sub = [r for r in sel("auction", fmt) if r.get("buys")]
        for dr in drafters(sub):
            rr = [r for r in sub if r["drafter"] == dr]
            b = np.array([[float(v) for v in x.split(":")] for r in rr for x in r["buys"].split(";")])
            b = b[b[:, 1] >= 10]
            if not len(b):
                continue
            third = 92  # a third of the default league's 276 lots
            e, m = b[b[:, 0] <= third], b[b[:, 0] > third]
            f = lambda x: "%.2f" % np.mean(x[:, 2] / x[:, 1]) if len(x) else "–"  # noqa: E731
            out.append("| %s | %s | %d | %.1f | %s | %.1f | %s | %.1f | %s | %.0f |" % (
                fmt, NAMES.get(dr, dr), len(rr), len(b) / len(rr), f(b), len(e) / len(rr), f(e), len(m) / len(rr), f(m), b[:, 1].sum() / len(rr)))  # fmt: skip
    out += ["", "### 4.5 The roster", "", "Means over the rooms (rivals of the engine's own model): SP and RP by role, bench players.", "",
            "| mode | format | drafter | rooms | SP | RP | bench | roster $ | risk-aware $ of the roster |", "|---" * 9 + "|"]  # fmt: skip
    for mode in ("snake", "auction"):
        for fmt in ("roto", "h2h"):
            sub = sel(mode, fmt)
            for dr in drafters(sub):
                rr = [r for r in sub if r["drafter"] == dr]
                out.append("| %s | %s | %s | %d | %s | %s | %s | %s | %s |" % (mode, fmt, NAMES.get(dr, dr), len(rr), _mean(rr, "n_sp"), _mean(rr, "n_rp"),
                                                                             _mean(rr, "n_bench"), _mean(rr, "team_value"), _mean(rr, "risk_value")))  # fmt: skip
    out += ["", "### 4.6 Part 4: the page's defaults in the auction", "",
            "The page's engine since part 4: E-pts with the cap in roto, E-pay with the cap in head-to-head.  The paired differences "
            "against V over the rooms that have the default, and against the same objective without the cap.", ""]  # fmt: skip
    for rivals in ("base", "m30", "dollar"):
        for fmt in ("roto", "h2h"):
            sf = sel("auction", fmt, rivals)
            rooms = {r["room"] for r in sf if r["drafter"] == DEFAULT_E[fmt]}
            if not rooms:
                continue
            sf = [r for r in sf if r["room"] in rooms]
            out += ["#### %s; rivals: %s" % (FMT_NAME[fmt], RIVAL_NAME[rivals]), ""] + table_vs(sf, fmt, "auction", drafters(sf), "V", "V") + [""]
            uncapped = DEFAULT_E[fmt].replace(":rule:cap", "")
            if any(r["drafter"] == uncapped for r in sf):
                out += table_vs(sf, fmt, "auction", [DEFAULT_E[fmt]], uncapped, "no cap") + [""]
    out += ["", "## 5. Run times", "", "Wall seconds per room and drafter (one worker; 3 workers ran at once), mean over the rooms.", "",
            "| mode | format | drafter | rooms | s per room | of which simulate() |", "|---" * 6 + "|"]  # fmt: skip
    for mode in ("snake", "auction"):
        for fmt in ("roto", "h2h"):
            sub = [r for r in rows if r["mode"] == mode and r["fmt"] == fmt]
            for dr in drafters(sub):
                rr = [r for r in sub if r["drafter"] == dr]
                out.append("| %s | %s | %s | %d | %s | %s |" % (mode, fmt, NAMES.get(dr, dr), len(rr), _mean(rr, "time_s", 1), _mean(rr, "sim_s", 1)))
    out += ["", "## 6. To run it again", "",
            "    python part3_check.py tables      # the page's tables (Node)",
            "    python part3_check.py selftest    # the session builder and the scorer",
            "    python part3_check.py run --plan pilot main_snake main_auction sims_snake rivals_snake nominate sims_auction rivals_auction cap_auction --workers 3",
            "    python part3_check.py run --plan part4_auction part4_rivals --workers 3   # part 4: the page's defaults",
            "    python part3_check.py report", "",
            "`run` appends the plan's missing jobs to `rooms.jsonl` (it can stop and continue).",
            "The jobs are deterministic: a job run again gives the same measures.", ""]  # fmt: skip
    path = os.path.join(OUT, "report.md")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out))
    print("%d rows -> %s, %s" % (len(rows), os.path.join(OUT, "rooms.csv"), path))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["tables", "selftest", "run", "report", "job", "replay"])
    ap.add_argument("--plan", nargs="*", default=["pilot"])
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--hours", type=float, default=None, help="no new jobs after this many hours")
    ap.add_argument("--job", default=None, help="job: one job key (fmt|mode|room|rivals|drafter), run inline")
    ap.add_argument("--keys", nargs="*", default=[], help="replay: stored job keys to run again and compare")
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if a.cmd == "tables":
        export_tables()
    elif a.cmd == "selftest":
        selftest()
    elif a.cmd == "run":
        run(a.plan, min(3, a.workers), a.hours)
    elif a.cmd == "report":
        report()
    elif a.cmd == "job":
        _init_worker()
        fmt, mode, room, rivals, drafter = a.job.split("|")
        print(json.dumps(run_job(dict(fmt=fmt, mode=mode, room=int(room), rivals=rivals, drafter=drafter))))
    elif a.cmd == "replay":
        _init_worker()
        return replay(a.keys, min(3, a.workers))
    return 0


if __name__ == "__main__":
    sys.exit(main())
