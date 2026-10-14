"""The engine's simulated objective against risk.js's CE now, and what the objective does to the bids.

1. Snake: at each of the user's first stops of a mock draft, the order of the options by the engine's
   objective (the full Monte Carlo method of the specification, section 8) against their order by CE
   now (risk.js's EffValue and Var_eff with the engine's M, S, H of the user's team: section 6.4, the
   approximation).  A disagreement on the top option is reported with its paired standard error.
2. Auction: at each priced lot of a mock auction, the break-even maximum bid on the objective (the
   payout's measure: win% in roto winner-take-all) and on mean roto points, against the CE maximum bid (section 6.5), the calculator's $
   and the risk-aware $.  Then the same room drafted by each objective (one room each: indicative
   only; part 3 runs many rooms).

    python ce_vs_engine.py [--sims 200] [--stops 8] [--lots 20] [--csv out.csv]
"""

import argparse
import csv
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "py"))

import numpy as np  # noqa: E402
from dry_run import load_inputs  # noqa: E402
from web_api import OBJECTIVE, Session  # noqa: E402

_tables = Session.tables


def _keep(self, cands, out, *a):  # keep the raw play-outs for the paired standard errors
    self.raw = (cands, out)
    return _tables(self, cands, out, *a)


Session.tables = _keep


def paired(s, i, j):
    """(mean, SE) of the objective of pick i minus pick j over the shared worlds."""
    cands, out = s.raw
    k = {c[1]: n for n, (c, _, _) in enumerate(cands) if c[0] == "pick"}
    d = out[OBJECTIVE[s.objective], k[i]] - out[OBJECTIVE[s.objective], k[j]]
    return float(d.mean()), float(d.std(ddof=1) / math.sqrt(len(d)))


def spearman(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1]) if len(a) > 2 else math.nan


def snake(inputs, fmt, slot, stops, sims, seed, rows, out):
    s = Session(dict(mode="snake", slot=slot, sims=sims, chunk=sims, seed=seed, format=fmt, objective="payout"), *inputs)
    out("\nsnake, %s, seat %d, objective %s (%s), %d drafts per option" % (s.lg.format, slot, s.objective_label(), s.payout, sims))
    out("  %-5s %-26s %-26s %4s %6s  %s" % ("pick", "engine's top", "CE now's top", "rho", "z", "the CE top against the engine's (objective, pp)"))
    agree = 0
    for _ in range(stops):
        info = json.loads(s.begin_stop())
        if info["done"]:
            break
        res = json.loads(s.simulate())
        picks = [r for r in res["options"] if r["kind"] == "pick" and r.get("ce") is not None]
        eng, by_ce = picks[0], min(picks, key=lambda r: r["ce_rank"])
        rho = spearman([r["objective"] for r in picks], [r["ce"] for r in picks])
        same = eng["i"] == by_ce["i"]
        agree += same
        if same:
            note = "agree"
        else:
            m, se = paired(s, by_ce["i"], eng["i"])
            note = "%+.2f pp (SE %.2f; engine rank %d)" % (100 * m, 100 * se, [r["i"] for r in picks].index(by_ce["i"]) + 1)
        t = res["target"]
        out("  %-5d %-26s %-26s %4.2f %6.2f  %s" % (info["overall"], eng["name"][:26], by_ce["name"][:26], rho, t["z"], note))
        rows.append({"test": "snake " + s.lg.format, "stop": info["overall"], "engine_top": eng["name"], "ce_top": by_ce["name"], "agree": same,
                     "rho": round(rho, 3), "M": t["M"], "S": t["S"], "H": t["H"], "z": t["z"], "note": note})  # fmt: skip
        json.loads(s.auto())
    out("  the top option agrees at %d of %d stops" % (agree, stops))


def auction(inputs, slot, lots, sims, seed, auto_below, rows, out, objective="payout", quiet=False):
    s = Session(dict(mode="auction", slot=slot, sims=sims, chunk=sims, seed=seed, auto_below=auto_below, objective=objective), *inputs)
    if not quiet:
        out("\nauction, seat %d, objective %s (%s), %d drafts per option, lots under $%g unpriced" % (slot, s.objective_label(), s.payout, sims, auto_below))
        out("  %-24s %6s %6s %6s %6s | %8s %8s %6s  %s" % ("lot", "$", "risk$", "room", "CE bid", "max %s" % s.objective_label(), "max pts", "", "result"))
    priced, t0 = 0, time.time()
    while True:
        info = json.loads(s.begin_stop())
        if info["done"]:
            break
        if info["kind"] == "nominate" or priced >= lots:  # the rule's nomination; past `lots`, value bids
            if info["kind"] == "bid":
                json.loads(s.bid(s.draft.user_value_bid(info["lot"]["i"])))
            else:
                json.loads(s.auto())
            continue
        res = json.loads(s.simulate())
        be, lot = res["break_even"], res["lot"]
        mw, mp = be[s.objective]["max_bid"], be["points"]["max_bid"]
        r = json.loads(s.bid(mw))
        got = "WON $%d" % r["result"]["price"] if r["mine"] else "team %d $%d" % (r["result"]["team"], r["result"]["price"])
        priced += 1
        if not quiet:
            out("  %-24s %6.1f %6.1f %6d %6s | %8d %8d %6s  %s" % (lot["name"][:24], lot["value"], lot["risk"] or math.nan, lot["expected_price"],
                lot["ce_bid"], mw, mp, "", got))  # fmt: skip
        rows.append({"test": "auction " + s.objective, "stop": len(s.draft.log), "lot": lot["name"], "value": lot["value"], "risk": lot["risk"],
                     "room": lot["expected_price"], "ce_bid": lot["ce_bid"], "max_obj": mw, "max_pts": mp, "result": got})  # fmt: skip
    fin = json.loads(s.final(n_sims=400))
    me = next(r for r in fin["standings"] if r["you"])
    place = 1 + fin["standings"].index(me)
    out("  objective %-8s: %d priced lots in %.0f s; your team: roto %.1f (%d of 12 by mean), win%% %.1f, team $ %.0f, spent $%d"
        % (s.objective_label(), priced, time.time() - t0, me["roto"], place, 100 * me["win"], me["team_value"], me["spent"]))
    return s


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sims", type=int, default=200)
    ap.add_argument("--stops", type=int, default=8)
    ap.add_argument("--lots", type=int, default=20)
    ap.add_argument("--slot", type=int, default=5)
    ap.add_argument("--seed", type=int, default=20270401)
    ap.add_argument("--auto-below", type=float, default=5.0)
    ap.add_argument("--skip", nargs="*", default=[], choices=["snake", "h2h", "auction", "rooms"])
    ap.add_argument("--csv", default=None)
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    inputs = load_inputs()
    rows = []
    if "snake" not in a.skip:
        snake(inputs, None, a.slot, a.stops, a.sims, a.seed, rows, print)
    if "h2h" not in a.skip:
        snake(inputs, "h2h", a.slot, a.stops, a.sims, a.seed, rows, print)
    if "auction" not in a.skip:
        auction(inputs, a.slot, a.lots, a.sims, a.seed, a.auto_below, rows, print)
        bids = [r for r in rows if r["test"].startswith("auction")]
        if bids:
            v = np.array([r["value"] for r in bids])
            for key, name in (("max_obj", "max bid on the objective"), ("max_pts", "max bid on roto points"), ("ce_bid", "CE max bid"), ("room", "room's price")):
                x = np.array([r[key] if r[key] is not None else np.nan for r in bids], float)
                print("  %-26s mean $%5.1f, %.2f x the calculator's $ (median of the lots)" % (name, np.nanmean(x), np.nanmedian(x / v)))
            w, p = np.array([r["max_obj"] for r in bids]), np.array([r["max_pts"] for r in bids])
            print("  the objective's max bid is above the points' at %d of %d lots, below at %d" % ((w > p).sum(), len(w), (w < p).sum()))
    if "rooms" not in a.skip:  # the same room (seed) drafted by each objective, with the rule's nominations
        print("\nthe same mock auction room, drafted on each objective (all lots priced down to $%g)" % a.auto_below)
        for objective in ("payout", "points"):
            auction(inputs, a.slot, 10**6, 60, a.seed, a.auto_below, [], print, objective=objective, quiet=True)
    if a.csv:
        with open(a.csv, "w", encoding="utf-8-sig", newline="") as f:  # UTF-8 with a BOM, for Excel
            keys = sorted({k for r in rows for k in r})
            w = csv.DictWriter(f, keys)
            w.writeheader()
            w.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
