"""The draft page's contract: drive py/web_api.Session through short drafts with the JSON the page sends.

For each scenario a calculator form (what the calculator saves in localStorage) and the page's draft
choices go through export_players.mjs (Node), which builds the table and the Session cfg with the page's
own code (setup.js: settingsFrom, draftRisk, buildTable, sessionConfig).  Then the Session runs as the
worker runs it (table text, the risk files' bytes), and every stop, result, action and final answer is
checked for the keys app.js reads.  Mock snake and auction, live snake and auction, roto and
head-to-head, both payouts.

    python page_check.py [--sims 10]
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "py"))

from dry_run import HIT_DIR, PIT_DIR, RISK_FILES  # noqa: E402
from web_api import Session  # noqa: E402

# the keys app.js reads
STOP = {"done", "mode", "kind", "mock", "sims", "payout", "objective", "objective_label", "format", "playoff_teams", "teams", "user_team",
        "made", "total", "open_spots", "budget", "max_bid", "money", "gone", "roster", "between", "options"}  # fmt: skip
STOP_SNAKE = {"round", "overall", "team", "mine"}
STOP_AUCTION = {"inflation", "nominator", "mine"}
STOP_LOT = {"lot", "expected_price", "own_price"}
PLAYER = {"i", "name", "pos", "mlb", "value", "risk"}
ROSTER = PLAYER | {"slot", "price"}
LOG = PLAYER | {"n", "team", "you", "price"}
RESULT = {"sims", "of", "objective", "objective_label", "kind", "options", "cats", "standings", "target", "baseline", "best_row"}
TARGET = {"M", "S", "H", "z", "unit", "place"}
ROW = {"kind", "why", "roto", "finish", "win", "p10", "p90", "best", "gap", "objective", "playoff", "champ", "cats"}
PICK_ROW = ROW | PLAYER | {"ce", "ce_usd", "ce0"}
BID_ROW = ROW | {"amount", "got", "paid"}
LOT = PLAYER | {"ce", "ce_bid", "ce_usd", "expected_price", "own_price"}
FINAL = {"roster", "standings", "sims", "cats", "objective", "objective_label", "format", "payout"}
FINAL_ROW = {"team", "you", "roto", "finish", "win", "playoff", "champ", "team_value", "spent", "cats"}

YAHOO = {"style": "Categories", "cats": {"h": ["R", "HR", "RBI", "SB", "AVG"], "p": ["W", "SV", "K", "ERA", "WHIP"]}, "split": "65",
         "bench": "5", "teams": "12", "min_bid": "1", "budget": "260", "span": "3", "curve": "1.05", "weeks": "23", "phi": "1", "pt_cv": "0.15",
         "slot_C": "1", "slot_1B": "1", "slot_2B": "1", "slot_3B": "1", "slot_SS": "1", "slot_CI": "0", "slot_MI": "0", "slot_OF": "3", "slot_UT": "2",
         "pslot_SP": "2", "pslot_RP": "2", "pslot_P": "4", "pool": "All", "format": "roto", "lock": "daily", "twoway": "split",
         "min_bench": True, "include_fa": True, "fill_pt": True, "specialists": True, "split_auto": False,
         "risk": {"on": True, "risk_payout": "winner", "risk_playoffs": "4", "risk_txn": "daily", "risk_il": "2"}}  # fmt: skip
ESPN_OBP = {**YAHOO, "teams": "10", "slot_CI": "1", "slot_MI": "1", "slot_OF": "5", "slot_UT": "1", "pslot_SP": "0", "pslot_RP": "0", "pslot_P": "9",
            "cats": {"h": ["R", "HR", "RBI", "SB", "OBP"], "p": ["W", "SV", "K", "ERA", "WHIP"]}}  # fmt: skip
H2H = {**YAHOO, "format": "h2h", "risk": {**YAHOO["risk"], "risk_payout": "playoffs", "risk_playoffs": "6"}}

SCENARIOS = [  # (name, form, the page's choices, priced stops before the draft is played out)
    ("mock snake, ESPN-like OBP roto, winner take all", ESPN_OBP, dict(mode="snake", slot=4, mock=True, payout="winner", playoffTeams=4, objective="payout", autoBelow=3), 3),
    ("mock auction, Yahoo head-to-head, playoffs", H2H, dict(mode="auction", slot=2, mock=True, payout="playoffs", playoffTeams=6, objective="payout", autoBelow=12), 4),
    ("mock auction, Yahoo roto, mean roto points", YAHOO, dict(mode="auction", slot=7, mock=True, payout="winner", playoffTeams=4, objective="points", autoBelow=15), 3),
    ("live snake, Yahoo roto, playoffs (top 4 paid)", YAHOO, dict(mode="snake", slot=3, mock=False, payout="playoffs", playoffTeams=4, objective="payout"), 0),
    ("live auction, Yahoo roto, winner take all", YAHOO, dict(mode="auction", slot=1, mock=False, payout="winner", playoffTeams=4, objective="payout"), 0),
]  # fmt: skip


def has(obj, keys, what):
    missing = set(keys) - set(obj)
    assert not missing, "%s lacks %s" % (what, sorted(missing))


def check_stop(info):
    has(info, STOP, "stop")
    if not info["done"]:
        has(info, STOP_SNAKE if info["mode"] == "snake" else STOP_AUCTION, "stop")
        if info["kind"] == "bid":
            has(info, STOP_LOT, "stop (lot)")
            has(info["lot"], PLAYER, "stop lot")
    for r in info["roster"]:
        has(r, ROSTER, "roster row")
    for r in info["between"]:
        has(r, LOG, "log row")
    for o in info["options"]:
        has(o, {"kind", "why"} | (PLAYER if o["kind"] == "pick" else set()), "option")
    return info


def check_result(res, info, progress):
    assert progress, "no progress before the result"
    for p in progress:
        has(p, RESULT, "progress")
    has(res, RESULT, "result")
    has(res["target"], TARGET, "target")
    assert res["sims"] == res["of"] and res["kind"] == info["kind"]
    for o in res["options"]:
        has(o, PICK_ROW if o["kind"] == "pick" else BID_ROW if o["kind"] in ("bid", "buy") else ROW, "result row")
        assert len(o["cats"]) == len(res["cats"])
    for t in res["standings"]:
        has(t, {"team", "you", "cats", "total"}, "standings row")
    if info["kind"] == "pick":
        has(res, {"ce_order"}, "pick result")
        assert any(o.get("ce_usd") is not None for o in res["options"]), "no CE now"
    if info["kind"] == "nominate":
        has(res["nomination"], {"rule", "engine", "rule_name", "engine_name", "gain", "se", "chosen"}, "nomination")
    if info["kind"] == "bid":
        be = res["break_even"]
        has(be, {res["objective"], "points"}, "break_even")
        has(be[res["objective"]], {"max_bid", "p_star", "slope"}, "break_even")
        has(res["lot"], LOT, "lot")
        assert res["best_row"]["amount"] == be[res["objective"]]["max_bid"]
    return res


def ok(r, what):
    r = json.loads(r)
    assert r["ok"], "%s: %s" % (what, r.get("message"))
    return r


def run(name, form, choices, priced, sims, tmp, rh, rp, out=print):
    t0 = time.time()
    form_path, table_path, cfg_path = (os.path.join(tmp, f) for f in ("form.json", "table.json", "cfg.json"))
    with open(form_path, "w", encoding="utf-8") as f:
        json.dump(form, f)
    cmd = ["node", os.path.join(HERE, "export_players.mjs"), os.path.join(HIT_DIR, "hitters_auction_ev.csv"), os.path.join(PIT_DIR, "pitchers_auction_ev.csv"),
           table_path, "--risk", *RISK_FILES, "--form", form_path, "--cfg", json.dumps({**choices, "sims": sims, "seed": 7}), cfg_path]  # fmt: skip
    subprocess.run(cmd, check=True, capture_output=True)
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    with open(table_path, encoding="utf-8") as f:
        table = f.read()
    assert json.loads(table)["risk"]["objective"]["payout"] == choices["payout"]
    s = Session(cfg, table, rh, rp)  # as worker.js builds it
    has(json.loads(s.pool_json())[0], PLAYER, "pool row")
    assert s.payout == choices["payout"] and (s.objective == "points") == (choices["objective"] == "points")
    stops = []
    info = check_stop(json.loads(s.begin_stop()))
    if choices["mock"]:
        for _ in range(priced):
            if info["done"]:
                break
            progress = []
            res = check_result(json.loads(s.simulate(progress=lambda j: progress.append(json.loads(j)))), info, progress)
            stops.append((info["kind"], res))
            if info["kind"] == "bid":
                ok(s.bid(res["best_row"]["amount"]), "bid")
            else:
                ok(s.auto(), "auto")
            info = check_stop(json.loads(s.begin_stop()))
        n = 0
        while not info["done"]:  # play out the rest unpriced (the first option, or a pass)
            ok(s.auto(), "auto")
            info = check_stop(json.loads(s.begin_stop()))
            n += 1
    elif info["mode"] == "snake":  # live: a rival's pick entered by name, then the user's priced pick
        assert info["kind"] == "pick" and not info["mine"] and info["team"] == 1
        first = json.loads(s.board(n=1))[0]
        ok(s.take(text="p " + first["name"]), "enter a rival's pick")
        info = check_stop(json.loads(s.begin_stop()))
        assert not info["mine"] and info["team"] == 2 and first["i"] in info["gone"]
        ok(s.take(index=json.loads(s.board(n=1))[0]["i"]), "enter a rival's pick")
        info = check_stop(json.loads(s.begin_stop()))
        assert info["mine"] and info["overall"] == 3
        progress = []
        res = check_result(json.loads(s.simulate(progress=lambda j: progress.append(json.loads(j)))), info, progress)
        stops.append(("pick", res))
        ok(s.take(index=res["best_row"]["i"]), "take")
        info = check_stop(json.loads(s.begin_stop()))
        assert not info["mine"] and [r["i"] for r in info["roster"]] == [res["best_row"]["i"]]
    else:  # live auction: the user's nomination, its sale entered; a rival's nomination entered, its sale entered
        assert info["kind"] == "nominate" and info["mine"]
        progress = []
        res = check_result(json.loads(s.simulate(progress=lambda j: progress.append(json.loads(j)))), info, progress)
        stops.append(("nominate", res))
        ok(s.nominate(index=res["best_row"]["i"]), "nominate")
        info = check_stop(json.loads(s.begin_stop()))
        assert info["kind"] == "bid" and info["nominator"] == 1
        progress = []
        res = check_result(json.loads(s.simulate(progress=lambda j: progress.append(json.loads(j)))), info, progress)
        stops.append(("bid", res))
        ok(s.record(team=5, price=max(1, int(res["lot"]["expected_price"]))), "record a sale")
        info = check_stop(json.loads(s.begin_stop()))
        assert info["kind"] == "enter" and info["nominator"] == 2 and info["money"][4] < 260
        ok(s.block(index=json.loads(s.board(n=1))[0]["i"], team=2), "enter a nomination")
        info = check_stop(json.loads(s.begin_stop()))
        progress = []
        res = check_result(json.loads(s.simulate(progress=lambda j: progress.append(json.loads(j)))), info, progress)
        stops.append(("bid", res))
        r = ok(s.record(team=1, price=res["break_even"][res["objective"]]["max_bid"] or 1), "record your purchase")
        assert r["mine"]
        info = check_stop(json.loads(s.begin_stop()))
        assert len(info["roster"]) == 1 and info["budget"] < 260
    for t in json.loads(s.rosters()):
        has(t, {"team", "you", "budget", "players"}, "rosters")
    if info["done"]:
        fin = json.loads(s.final(n_sims=20))
        has(fin, FINAL, "final")
        for r in fin["standings"]:
            has(r, FINAL_ROW, "final row")
        assert sum(r["you"] for r in fin["standings"]) == 1
    out("ok  %-52s %d priced stops%s, %.1f s" % (name, len(stops), ", played to the end" if info["done"] else "", time.time() - t0))
    return stops


def main(argv=None, out=print):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sims", type=int, default=10)
    a = ap.parse_args(argv)
    with open(RISK_FILES[0], "rb") as f:
        rh = f.read()
    with open(RISK_FILES[1], "rb") as f:
        rp = f.read()
    with tempfile.TemporaryDirectory() as tmp:
        for name, form, choices, priced in SCENARIOS:
            run(name, form, choices, priced, a.sims, tmp, rh, rp, out)
    out("%d page scenarios passed" % len(SCENARIOS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
