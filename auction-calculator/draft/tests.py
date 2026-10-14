"""Plain-assert tests of the MLB draft engine (no pytest): python tests.py [--quick]

Inputs: the calculator's table (export_players.mjs, Node) and the R1 risk files of the 2027 test
simulation (PROJ_2027, default the projections repository's data/projections/2027).  Prints the run
time of each decision type at the first stop.
"""

import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "py"))

import ce  # noqa: E402
import numpy as np  # noqa: E402
from dry_run import load_inputs  # noqa: E402
from draft import DRAIN_MARGIN, Draft  # noqa: E402
from engine import GOT, PAID, PTS, SKIP, Engine  # noqa: E402
from league import CATEGORIES, H2H, League, Scorer, norm_cdf, round_robin  # noqa: E402
from pool import Pool, decode  # noqa: E402
from web_api import Session  # noqa: E402

QUICK = "--quick" in sys.argv
TABLE, RH, RP = load_inputs(None if len(sys.argv) < 2 or sys.argv[1].startswith("--") else sys.argv[1])
T = json.loads(TABLE)
LG = League.from_settings(T["settings"])
POOL = Pool(T, LG, {"h": RH, "p": RP})
ENG = Engine(POOL, LG, h2h=True)
PASSED = []


def test(fn):
    t0 = time.time()
    fn()
    PASSED.append(fn.__name__)
    print("ok  %-34s %6.2f s" % (fn.__name__, time.time() - t0))
    return fn


# ---- inputs -------------------------------------------------------------------------------------


@test
def decode_matches_projections_decoder():
    for buf, side, n in ((RH, "h", 1106), (RP, "p", 1272)):
        head, mlbam, x = decode(buf)
        assert head["side"] == side and head["draws"] == 50 and head["players"] == n == len(mlbam)
        assert all(v.shape == (n, 50) for v in x.values())
        try:  # the reference decoder of the projections repository, if it can be imported
            sys.path.insert(0, os.environ.get("PROJ_REPO", r"C:\Users\krbla\claude_sessions\projections"))
            from src.valuation.risk_draws import decode as ref
        except Exception:
            continue
        h2, m2, x2 = ref(buf)
        assert h2 == head and (m2 == mlbam).all() and all(np.array_equal(x[k], x2[k]) for k in x)


@test
def pool_fill_and_draws():
    assert POOL.has_draws.all(), "every kept player has outcome draws"
    assert POOL.n_draws == 50
    head, mlbam, x = decode(RH)
    j = {int(m): k for k, m in enumerate(mlbam)}
    c_r, c_ab = POOL.comps.index("R"), POOL.comps.index("AB")
    checked = 0
    for i in range(POOL.n):
        if POOL.side[i] != "h":
            continue
        k = j[int(POOL.mlbam[i])]
        for d in range(50):
            gap = max(0.0, POOL.fill_target[i] - x["PA"][k, d])
            assert abs(POOL.draws[i, d, c_r] - (x["R"][k, d] + gap * POOL.fill_rate[i, c_r])) < 1e-9
            assert abs(POOL.draws[i, d, c_ab] - (x["AB"][k, d] + gap * POOL.fill_rate[i, c_ab])) < 1e-9
        checked += 1
        if checked > 40:
            break
    # a hitter has no pitching components and a pitcher no hitting ones
    hit = [POOL.comps.index(c) for c in ("R", "HR", "RBI", "SB", "H", "AB")]
    pit = [POOL.comps.index(c) for c in ("W", "SV", "K", "ER", "IP", "BBH")]
    assert (POOL.draws[POOL.side == "h"][:, :, pit] == 0).all() and (POOL.draws[POOL.side == "p"][:, :, hit] == 0).all()
    # the fill targets are calc.js's
    assert abs(POOL.fill_target[POOL.side == "h"].max() - T["fillTargets"]["h"]["H"]) < 1e-9


# ---- scoring ------------------------------------------------------------------------------------


@test
def roto_points_ties_and_inverted_categories():
    lg = League(teams=3)
    sc = Scorer(lg)
    comps = lg.components
    tot = np.zeros((3, len(comps)))
    put = lambda t, **kw: [tot.__setitem__((t, comps.index(k)), v) for k, v in kw.items()]  # noqa: E731
    put(0, R=900, HR=250, RBI=850, SB=100, H=1400, AB=5500, W=80, SV=60, K=1300, ER=550, IP=1300, BBH=1600)
    put(1, R=900, HR=200, RBI=800, SB=150, H=1450, AB=5500, W=90, SV=40, K=1200, ER=500, IP=1300, BBH=1500)
    put(2, R=800, HR=220, RBI=900, SB=120, H=1300, AB=5500, W=70, SV=80, K=1250, ER=600, IP=1300, BBH=1700)
    pts = sc.roto_points(tot)
    cat = {c: k for k, c in enumerate(lg.cats)}
    assert list(pts[:, cat["R"]]) == [2.5, 2.5, 1.0]  # a tie shares the points
    assert list(pts[:, cat["AVG"]]) == [2.0, 3.0, 1.0]
    assert list(pts[:, cat["ERA"]]) == [2.0, 3.0, 1.0]  # lower ERA is better
    assert list(pts[:, cat["WHIP"]]) == [2.0, 3.0, 1.0]
    assert pts.sum() == 3 * len(lg.cats) * 2  # every category hands out 1 + 2 + 3
    batched = sc.roto_points(np.stack([tot, tot[::-1]]))
    assert np.array_equal(batched[0], pts) and np.array_equal(batched[1], pts[::-1])
    assert set(lg.cats) <= set(CATEGORIES)


@test
def normal_cdf_and_schedule():
    z = np.linspace(-6, 6, 2001)
    exact = np.array([0.5 * (1 + math.erf(v / math.sqrt(2))) for v in z])
    assert np.abs(norm_cdf(z) - exact).max() < 2e-7
    sched = round_robin(12, 11)
    for wk in sched:
        assert sorted(wk.ravel().tolist()) == list(range(12))  # everyone plays once a week
    pairs = {tuple(sorted(p)) for wk in sched for p in wk.tolist()}
    assert len(pairs) == 66  # every pair meets once in 11 weeks


@test
def h2h_odds_sane():
    lg = League(format="h2h")
    sc, h2h = Scorer(lg), H2H(lg, reps=64)
    rng = np.random.default_rng(5)
    base = np.array([[900, 240, 880, 120, 1400, 5500, 85, 70, 1350, 560, 1350, 1650]], float)
    comps = lg.components
    assert comps == ["R", "HR", "RBI", "SB", "H", "AB", "W", "SV", "K", "ER", "IP", "BBH"]
    tot = np.repeat(base, 12, axis=0) * (1 + 0.01 * rng.standard_normal((12, len(comps))))
    p = sc.h2h_p(tot)
    assert np.allclose(p + p.transpose(1, 0, 2), 1.0)
    u = h2h.uniforms(rng)
    made = [h2h.odds(p, u, t)[0] for t in range(12)]
    assert abs(sum(made) - 6.0) < 1e-9  # exactly six teams make the playoffs in every season
    strong = tot.copy()
    strong[0, :4] *= 1.25
    strong[0, 6:9] *= 1.25
    strong[0, 4] *= 1.04
    strong[0, 9] *= 0.85
    strong[0, 11] *= 0.9
    playoff, champ, wins = h2h.odds(sc.h2h_p(strong), u, 0)
    assert playoff > 0.95 and champ > 0.4 and wins > 0.6 * h2h.reg_weeks * len(lg.cats), (playoff, champ, wins)


# ---- legality -----------------------------------------------------------------------------------


def _brute_best_lineup_value(eng, roster):
    """An exchange check: no bench player can replace a starter of lower $ and keep the lineup legal."""
    lu = eng.lineup(roster)
    best = sum(POOL.value[i] for i in lu)
    for b in set(roster) - set(lu):
        for s in lu:
            if POOL.value[b] > POOL.value[s]:
                cand = [i for i in lu if i != s] + [b]
                if _fits(eng, cand):
                    best = max(best, sum(POOL.value[i] for i in cand))
    return best


def _fits(eng, players):
    """Hall's condition checked directly on a set of players (each side on its own subsets)."""
    counts = [0] * eng.n_types
    for i in players:
        counts[eng.pc[i]] += 1
    for side, (hall, cap) in enumerate(eng.side_hall):
        part = counts[: eng.n_htypes] if side == 0 else counts[eng.n_htypes :]
        if len(part) and ((hall @ np.array(part, float)) > cap).any():
            return False
    return True


@test
def legality_hall_and_lineup():
    eng = ENG
    code = {t: k for k, t in enumerate(eng.etypes)}
    c_only, ut_only = code[("C", "UT")], code.get(("UT",))
    key = 0
    seats = []
    for _ in range(4):  # one C slot and two UT slots: three catchers start, the fourth does not
        rt = eng.route(key)
        seats.append(rt[c_only])
        if rt[c_only]:
            key += eng.P[c_only]
    assert seats == [True, True, True, False]
    if ut_only is not None:
        assert not eng.route(key)[ut_only]  # the UT slots are full of catchers
    mi = code[("2B", "SS", "UT")]
    assert eng.route(key)[mi]  # 2B and SS are open
    # bench rule: a full lineup can still add bench players, up to the bench
    full = sum(eng.P[t] * c for t, c in enumerate(eng.counts(key)))
    assert eng.legal_k(full, 0)[c_only]  # a bench spot is open
    assert not eng.legal_k(full, LG.bench)[c_only]  # the bench is full
    # the lineup of a roster is its best legal lineup by $ value
    d = Draft(eng, 0, np.random.default_rng(1), "snake")
    while not d.done():
        d.auto()
    for t in range(LG.teams):
        lu = eng.lineup(d.rosters[t])
        assert len(lu) == LG.starters, (t, len(lu))
        assert _brute_best_lineup_value(eng, d.rosters[t]) <= sum(POOL.value[i] for i in lu) + 1e-9


# ---- play-outs ----------------------------------------------------------------------------------


@test
def snake_playout_completes():
    d = Draft(ENG, 4, np.random.default_rng(2), "snake")
    snap = d.snap()
    w = ENG.draw_world(np.random.default_rng(3))
    ENG.user_board(w, 4)
    gone, keys, bench, rosters = bytearray(snap.gone), list(snap.keys), list(snap.bench), [list(r) for r in snap.rosters]
    ENG.finish_snake(w, gone, keys, bench, rosters, snap.order, 0, ("pick", 0))
    allp = [i for r in rosters for i in r]
    assert len(allp) == len(set(allp)) == LG.teams * LG.roster_size
    assert 0 in rosters[4]
    assert all(len(ENG.lineup(r)) == LG.starters for r in rosters)
    assert all(b <= LG.bench for b in bench)


@test
def auction_playout_budgets():
    d = Draft(ENG, 4, np.random.default_rng(2), "auction")
    d.auto_nominate()
    snap = d.snap()
    for seed in range(5):
        w = ENG.draw_world(np.random.default_rng(seed))
        ENG.user_board(w, 4)
        gone, keys, bench, rosters = bytearray(snap.gone), list(snap.keys), list(snap.bench), [list(r) for r in snap.rosters]
        budget, spots = list(snap.budget), list(snap.spots)
        got, paid = ENG.finish_auction(w, gone, keys, bench, rosters, budget, spots, snap.lot, snap.nom, 4, ("bid", 0))
        assert got == 0.0 and math.isnan(paid)
        assert min(budget) >= 0 and sum(spots) == 0
        assert all(len(r) == LG.roster_size for r in rosters)
        assert all(len(ENG.lineup(r)) == LG.starters for r in rosters)
        spent = LG.teams * LG.budget - sum(budget)
        assert spent >= 0.97 * LG.teams * LG.budget, spent  # the inflation spends the money


@test
def live_auction_prices_legal():
    d = Draft(ENG, 4, np.random.default_rng(9), "auction")
    while not d.done():
        if d.lot is None:
            d.auto_nominate()
        d.resolve(None)
    prices = [p for _, _, _, p in d.log]
    assert len(d.log) == LG.teams * LG.roster_size and min(prices) >= LG.min_bid
    for t in range(LG.teams):
        assert sum(d.paid[t]) == LG.budget - d.budget[t] <= LG.budget


@test
def common_random_numbers():
    d = Draft(ENG, 4, np.random.default_rng(2), "snake")
    snap = d.snap()
    cands = [("pick", 0), ("pick", 0), SKIP]
    a, la = ENG.chunk(snap, cands, 6, np.random.default_rng(11), base=2)
    b, lb = ENG.chunk(snap, cands, 6, np.random.default_rng(11), base=2)
    assert np.array_equal(a, b, equal_nan=True) and np.array_equal(la, lb)
    assert np.array_equal(a[:, 0], a[:, 1], equal_nan=True)  # the same candidate twice: the same futures


@test
def better_player_scores_better():
    d = Draft(ENG, 4, np.random.default_rng(2), "snake")
    snap = d.snap()
    out, _ = ENG.chunk(snap, [("pick", 0), ("pick", 250)], 30, np.random.default_rng(12))
    diff = out[PTS, 0] - out[PTS, 1]
    assert diff.mean() > 2 * diff.std(ddof=1) / math.sqrt(len(diff)), diff.mean()


@test
def auction_bids_monotone():
    d = Draft(ENG, 4, np.random.default_rng(2), "auction")
    d.auto_nominate()
    j = d.lot[0]
    v = POOL.value[j]
    bids = [0, int(v * 0.8), int(v * 1.1), int(v * 1.4)]
    out, _ = ENG.chunk(d.snap(), [("bid", b) for b in bids] + [("buy", int(v * 0.6)), ("buy", int(v * 1.4))], 40, np.random.default_rng(13))
    got = out[GOT, :4].mean(axis=1)
    assert all(got[k] <= got[k + 1] for k in range(3)) and got[0] == 0.0, got
    for k, b in enumerate(bids):
        paid = out[PAID, k][np.isfinite(out[PAID, k])]
        assert (paid <= max(b, LG.min_bid)).all()
    cheap, dear = out[PTS, 4], out[PTS, 5]
    assert cheap.mean() >= dear.mean(), (cheap.mean(), dear.mean())  # the same player for less money


# ---- the session (the page's API) ---------------------------------------------------------------


@test
def session_snake_flow_and_undo():
    s = Session(dict(mode="snake", slot=3, sims=12, chunk=6), TABLE, RH, RP)
    info = json.loads(s.begin_stop())
    assert info["kind"] == "pick" and info["overall"] == 3 and len(info["between"]) == 2
    res = json.loads(s.simulate())
    assert res["sims"] == 12 and res["options"][-1]["kind"] == "skip"
    assert {"M", "S", "H", "z", "unit", "place"} <= set(res["target"]) and res["target"]["H"] >= res["target"]["M"]
    assert res["target"]["unit"] == "roto points" and res["target"]["place"] == 1  # roto, winner-take-all
    first = json.loads(s.auto())
    assert first["ok"] and first["pick"]["you"]
    info2 = json.loads(s.begin_stop())
    assert info2["overall"] == 22  # the snake comes back at pick 22 for seat 3
    assert json.loads(s.undo())["ok"]
    info3 = json.loads(s.begin_stop())
    assert info3["overall"] == 3 and not info3["roster"]
    assert not json.loads(s.take(text="p zzzz nobody"))["ok"]


@test
def session_auction_flow():
    s = Session(dict(mode="auction", slot=1, sims=10, chunk=5, auto_below=1e9), TABLE, RH, RP)
    info = json.loads(s.begin_stop())
    assert info["kind"] == "nominate" and info["budget"] == LG.budget
    res = json.loads(s.simulate())
    assert res["kind"] == "nominate" and len(res["options"]) >= 2
    assert json.loads(s.auto())["ok"]
    s.cfg["auto_below"] = 0.0
    info = json.loads(s.begin_stop())
    assert info["kind"] == "bid" and info["lot"]
    res = json.loads(s.simulate())
    be = res["break_even"][s.objective]
    assert res["best_row"]["amount"] == res["bid"]["amount"] == min(be["max_bid"], res["bid"]["value_bid"]) and len(be["prices"]) >= 3
    r = json.loads(s.bid(res["best_row"]["amount"]))
    assert r["ok"] and r["result"]["price"] >= LG.min_bid
    # a real draft's entry
    s2 = Session(dict(mode="auction", slot=1, sims=10, mock=False), TABLE, RH, RP)
    assert json.loads(s2.begin_stop())["kind"] == "nominate"
    i = s2.draft.my_board()[3]
    assert json.loads(s2.nominate(index=i))["ok"]
    assert json.loads(s2.record(i, 7, 33))["ok"]
    assert s2.draft.budget[6] == LG.budget - 33 and i in s2.draft.rosters[6]


@test
def session_final_odds():
    s = Session(dict(mode="snake", slot=1, sims=10, format="h2h"), TABLE, RH, RP)
    d = s.draft
    while not d.done():
        d.auto()
    fin = json.loads(s.final(n_sims=40))
    st = fin["standings"]
    assert len(st) == LG.teams and 0.9 <= sum(r["win"] for r in st) <= 1.0 + 1e-6  # a tie for first is no win
    assert abs(sum(r["playoff"] for r in st) - LG.playoff_teams) < 0.01  # (rounded to 3 decimals)
    assert abs(sum(r["champ"] for r in st) - 1.0) < 0.01


# ---- part 2: the payout, the CE join, the nomination rule, the live draft -----------------------


@test
def ce_port_matches_risk_js():
    """py/ce.py gives risk.js's CE and its $ (x.ce, x.bid) with risk.js's own M, S, H before the draft."""
    # the specification's section 7: the CE probability gains (exact .0409 / .0526 / .0714)
    for sigma, want in ((1, 0.0409), (3, 0.0526), (5, 0.0714)):
        c = ce.exact_certainty(1.0, sigma**2, 60, 8, 66)
        assert abs(ce.Phi((60 + c - 66) / 8) - ce.Phi(-6 / 8) - want) < 5e-5
    for p in (1e-9, 0.01, 0.3, 0.5, 0.9, 1 - 1e-9):
        assert abs(ce.Phi(ce.Phi_inv(p)) - p) < 1e-12 * max(1.0, 1 / p)
    meta = POOL.risk_meta
    assert meta and meta["objective"]["unit"] == "standings points"
    o, pr = meta["objective"], meta["pricing"]
    n = bad_ce = bad_bid = 0
    for i in range(POOL.n):
        if not math.isfinite(POOL.risk_eff[i]):
            continue
        n += 1
        c = ce.ce(POOL.risk_eff[i], POOL.risk_var[i], o["M"], o["S"], o["H"])
        bad_ce += abs(c - POOL.risk_ce[i]) > 1e-9 * max(1.0, abs(c))
        usd = ce.dollars_of(POOL.risk_ce[i], bool(POOL.drafted[i]), pr[POOL.side[i]], pr["gamma"], LG.min_bid)
        bad_bid += abs(usd - POOL.risk_bid[i]) > 1e-6
    assert n > 0.95 * POOL.n and bad_ce == 0 and bad_bid == 0, (n, bad_ce, bad_bid)
    assert np.isfinite(POOL.own).all() and (POOL.own == np.where(np.isfinite(POOL.risk_value), POOL.risk_value, POOL.value)).all()


@test
def objective_defaults_and_payout():
    """The default objective (the user, 2026-10-13, after part 3): roto -> mean roto points, head-to-head -> the
    payout's measure; "payout" gives the payout's measure in roto too."""

    def make(**kw):
        return Session(dict(sims=8, chunk=8, **kw), TABLE, RH, RP)

    cases = [({}, "winner", "points", "roto pts"), (dict(payout="playoffs", playoff_teams=4), "playoffs", "points", "roto pts"),
             (dict(objective="payout"), "winner", "win", "win%"),
             (dict(objective="payout", payout="playoffs", playoff_teams=4), "playoffs", "playoff", "top-4%"),
             (dict(format="h2h"), "playoffs", "playoff", "playoff%"), (dict(format="h2h", payout="winner"), "winner", "champ", "title%"),
             (dict(format="h2h", objective="points"), "playoffs", "points", "roto pts")]  # fmt: skip
    for kw, payout, objective, label in cases:
        s = make(**kw)
        assert (s.payout, s.objective, s.objective_label()) == (payout, objective, label), (kw, s.payout, s.objective)
        assert (s.eng.h2h is not None) == (s.lg.format == "h2h")
    # roto with a playoffs payout: the top-4 share of the roto standings, not the head-to-head model
    s = make(payout="playoffs", playoff_teams=4, slot=4, objective="payout")
    json.loads(s.begin_stop())
    res = json.loads(s.simulate())
    assert res["objective"] == "playoff" and res["target"]["place"] == 4 and res["target"]["unit"] == "roto points"
    for r in res["options"]:
        assert 0 <= r["win"] <= r["playoff"] <= 1 and r["objective"] == r["playoff"] and r["champ"] == r["win"] and r["h2h_wins"] is None
    while not s.draft.done():
        s.draft.auto()
    fin = json.loads(s.final(n_sims=30))
    assert 3.7 <= sum(r["playoff"] for r in fin["standings"]) <= 4 + 1e-6  # four places paid (a tie across 4th-5th pays neither)


@test
def h2h_target_and_ce_now():
    s = Session(dict(mode="snake", slot=6, sims=12, chunk=6, format="h2h"), TABLE, RH, RP)
    json.loads(s.begin_stop())
    res = json.loads(s.simulate())
    t, tr = res["target"], res["target_roto"]
    K, W = len(s.lg.cats), s.lg.weeks
    assert t["unit"] == "category wins" and tr["unit"] == "roto points" and t["place"] == s.lg.playoff_teams
    assert 0.25 * W * K < t["M"] < 0.75 * W * K and t["H"] > t["M"] and t["S"] > 0, t  # the seat filled from waivers is below the cut
    picks = [r for r in res["options"] if r["kind"] == "pick"]
    for r in picks:  # CE now: risk.js's EffValue and Var_eff against the engine's M, S, H
        i = r["i"]
        want = ce.ce(POOL.risk_eff[i], POOL.risk_var[i], t["M"], t["S"], t["H"])
        assert r["ce"] == round(want, 2) and r["risk"] == round(POOL.risk_value[i], 1), (r["name"], r["ce"], want)
    assert sorted(r["ce_rank"] for r in picks) == list(range(1, len(picks) + 1))
    assert res["ce_order"]["engine_top"] == picks[0]["name"]


@test
def nomination_rule():
    d = Draft(ENG, 4, np.random.default_rng(3), "auction")
    while d.nominator() != 4:  # rivals' lots until the user's turn
        d.auto_nominate()
        d.resolve(None)
    noms = d.nominees(5, 2)
    rows = [(d.expected_price(i), d.own_price(i), i) for i in d.my_board() if d.legal_for(4, i)]
    drains = [r for r in rows if r[1] <= r[0] - DRAIN_MARGIN]
    first = noms[0][0][1]
    if drains:
        assert d.expected_price(first) == max(r[0] for r in drains) and d.own_price(first) <= d.expected_price(first) - DRAIN_MARGIN
        assert all(w.startswith("drain") for _, w in noms[: min(5, len(drains))])
    else:
        assert d.expected_price(first) == max(r[0] for r in rows if d.fills_a_slot(4, r[2]))
    assert len({c[1] for c, _ in noms}) == len(noms) and any(w.startswith("target") for _, w in noms)
    # a player who would not start for the user is worth only the bench share to him: a drain
    full = Draft(ENG, 4, np.random.default_rng(3), "auction")
    for i in [i for i in range(ENG.n) if POOL.signature[i] == ("C", "UT")][:3]:  # C and both UT spots
        full.nominate(i, 4)
        full.record(i, 4, 1)
    c = next(i for i in full.my_board() if POOL.signature[i] == ("C", "UT") and POOL.value[i] > 5)
    assert not full.fills_a_slot(4, c) and full.own_price(c) <= full.expected_price(c) - DRAIN_MARGIN
    # the session: the rule's choice is the recommendation unless the engine beats it by 2 SE
    s = Session(dict(mode="auction", slot=1, sims=10, chunk=5), TABLE, RH, RP)
    info = json.loads(s.begin_stop())
    assert info["kind"] == "nominate" and info["options"][0]["why"].split(":")[0] in ("drain", "target")
    assert [c for c, _, _ in s.candidates()] == [("bid", s.draft.own_price(o[1])) for o, _ in s.opts]
    res = json.loads(s.simulate())
    nm = res["nomination"]
    assert nm["rule"] == s.opts[0][0][1] and nm["chosen"] in ("rule", "engine")
    assert res["best_row"]["i"] == (nm["rule"] if nm["chosen"] == "rule" else nm["engine"])
    assert sum(1 for r in res["options"] if r.get("rule")) == 1
    r = json.loads(s.auto())
    assert r["ok"] and r["lot"]["i"] == res["best_row"]["i"]


@test
def live_auction_entries():
    s = Session(dict(mode="auction", slot=1, sims=6, chunk=6, mock=False), TABLE, RH, RP)
    info = json.loads(s.begin_stop())
    assert info["kind"] == "nominate" and info["mine"]
    i, j = s.draft.my_board()[0], s.draft.my_board()[1]
    r = json.loads(s.block(index=i, team=3))  # a rival's nomination, entered out of turn
    assert r["ok"] and r["nominator"] == 3
    assert not json.loads(s.block(index=j))["ok"]  # one lot at a time
    info = json.loads(s.begin_stop())
    assert info["kind"] == "bid" and info["lot"]["i"] == i and info["nominator"] == 3
    res = json.loads(s.simulate())
    assert res["lot"]["i"] == i and res["lot"]["ce_bid"] is not None and res["break_even"][s.objective]["max_bid"] >= 0
    assert not json.loads(s.record(team=3, price=500))["ok"]  # more than team 3 can pay
    assert not json.loads(s.record(index=j, team=3, price=40))["ok"]  # not the player on the block
    r = json.loads(s.record(team=3, price=40))
    assert r["ok"] and not r["mine"] and s.draft.budget[2] == LG.budget - 40 and i in s.draft.rosters[2]
    info = json.loads(s.begin_stop())
    assert info["kind"] == "enter" and info["nominator"] == 4 and not info["mine"] and i in info["gone"]
    assert json.loads(s.block(text="p " + POOL.name[j]))["ok"]
    json.loads(s.begin_stop())
    r = json.loads(s.record(team=1, price=30))
    assert r["ok"] and r["mine"] and s.draft.budget[0] == LG.budget - 30
    assert json.loads(s.begin_stop())["roster"][0]["i"] == j
    assert json.loads(s.undo())["ok"]
    info = json.loads(s.begin_stop())
    assert info["kind"] == "bid" and s.draft.budget[0] == LG.budget  # back to the lot on the block


@test
def bid_cap_at_value_bid():
    """The recommended maximum bid is the break-even capped at the value bid (bid_cap "value", the default since
    part 3), or the break-even alone (bid_cap "none"); the cap leaves the break-even as it is (the same worlds)."""
    got = {}
    for cap in ("value", "none"):
        s = Session(dict(mode="auction", slot=5, sims=12, chunk=12, seed=77, auto_below=0.0, bid_cap=cap), TABLE, RH, RP)
        assert json.loads(s.begin_stop())["kind"] == "bid"
        res = json.loads(s.simulate())
        be, b = res["break_even"][s.objective]["max_bid"], res["bid"]
        vb = s.draft.user_value_bid(s.draft.lot[0])
        want = min(be, vb) if cap == "value" else be
        assert (b["break_even"], b["value_bid"], b["amount"], res["best_row"]["amount"], b["capped"]) == (be, vb, want, want, want < be), (cap, b)
        assert json.loads(s.auto())["ok"]
        got[cap] = be
    assert got["value"] == got["none"]


@test
def live_snake_entries():
    s = Session(dict(mode="snake", slot=2, sims=6, chunk=6, mock=False), TABLE, RH, RP)
    info = json.loads(s.begin_stop())
    assert info["kind"] == "pick" and not info["mine"] and info["team"] == 1 and info["options"]
    i = s.draft.my_board()[0]
    r = json.loads(s.take(text="p " + POOL.name[i]))
    assert r["ok"] and r["pick"]["team"] == 1
    info = json.loads(s.begin_stop())
    assert info["mine"] and info["overall"] == 2 and i in info["gone"] and info["between"][-1]["i"] == i
    assert all(o["i"] != i for o in info["options"] if o["kind"] == "pick")


@test
def page_contract():
    """page_check.py: the page's own JSON (setup.js under Node) through Session, mock and live, both modes."""
    import page_check

    page_check.main(["--sims", "6"], out=lambda *a: None)


# ---- timings and repeatability ------------------------------------------------------------------


@test
def timings_per_decision():
    n = 50 if QUICK else 200
    for mode, fmt in (("snake", None), ("auction", None), ("snake", "h2h"), ("auction", "h2h")):
        s = Session(dict(mode=mode, slot=5, sims=n, chunk=n, format=fmt), TABLE, RH, RP)
        info = json.loads(s.begin_stop())
        t0 = time.time()
        res = json.loads(s.simulate())
        dt = time.time() - t0
        print("     %-7s %-4s first %-8s %2d options x %d sims: %5.2f s (%.2f ms per play-out)"
              % (mode, s.lg.format, info["kind"], len(res["options"]), n, dt, 1000 * dt / (n * len(res["options"]))))


@test
def break_even_repeatability():
    n, seeds = (40, 3) if QUICK else (200, 4)
    rows = []
    for seed in range(seeds):
        s = Session(dict(mode="auction", slot=5, sims=n, chunk=n, seed=77, auto_below=0.0, objective="payout"), TABLE, RH, RP)
        info = json.loads(s.begin_stop())
        s.rng = np.random.default_rng(1000 + seed)  # the same lot, other worlds
        res = json.loads(s.simulate())
        be = res["break_even"]
        rows.append((be[s.objective]["p_star"], be["points"]["p_star"]))
    lot = info["lot"]
    w, p = np.array([r[0] for r in rows], float), np.array([r[1] for r in rows], float)
    print("     lot %s ($%.1f): break-even on %s $%s (sd %.1f), on roto points $%s (sd %.1f), %d sims x %d seeds"
          % (lot["name"], lot["value"], s.objective, np.round(w, 0).tolist(), w.std(ddof=1), np.round(p, 0).tolist(), p.std(ddof=1), n, seeds))
    assert np.isfinite(p).all()


print("%d tests passed" % len(PASSED))
