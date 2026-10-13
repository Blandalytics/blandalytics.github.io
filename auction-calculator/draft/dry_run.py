"""An automatic mock draft from one seat, snake or auction, through the JSON Session (py/web_api.py).

At each of the user's decisions the options are priced by simulated finishes and the recommendation
is taken (the console's --auto in nhl_draft).  Prints each decision with its time, then the user's
roster and every team's odds over the outcome draws.

    python dry_run.py --mode auction --slot 5 --sims 60
    python dry_run.py --mode snake --slot 5 --sims 200 --format h2h
    python dry_run.py --mode both

The player table comes from the calculator's own model (export_players.mjs, Node) on the auction CSVs
of a simulation; the outcome draws from that simulation's risk files (projections repository, R1).
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

from web_api import Session  # noqa: E402

PROJ = os.environ.get("PROJ_2027", r"C:\Users\krbla\claude_sessions\projections\data\projections\2027")
HIT_DIR, PIT_DIR = os.path.join(PROJ, "B1_b4_sim_risk"), os.path.join(PROJ, "B2s_env_sim_risk")


def load_inputs(players=None):
    """(table JSON text, hitters risk bytes, pitchers risk bytes); the table is exported with Node if no file is given."""
    if players is None:
        players = os.path.join(tempfile.gettempdir(), "draft_players_2027.json")
        subprocess.run(["node", os.path.join(HERE, "export_players.mjs"), os.path.join(HIT_DIR, "hitters_auction_ev.csv"),
                        os.path.join(PIT_DIR, "pitchers_auction_ev.csv"), players], check=True, capture_output=True)  # fmt: skip
    with open(players, encoding="utf-8") as f:
        table = f.read()
    with open(os.path.join(HIT_DIR, "hitters_risk_ev.bin"), "rb") as f:
        rh = f.read()
    with open(os.path.join(PIT_DIR, "pitchers_risk_ev.bin"), "rb") as f:
        rp = f.read()
    return table, rh, rp


def pct(v):
    return "  -  " if v is None else "%4.1f%%" % (100 * v)


def run(mode, table, rh, rp, slot=5, sims=100, seed=20270401, fmt=None, auto_below=3.0, quiet=False, out=print):
    cfg = dict(mode=mode, slot=slot, sims=sims, seed=seed, format=fmt, auto_below=auto_below, chunk=max(10, sims // 4))
    t0 = time.time()
    s = Session(cfg, table, rh, rp)
    out("%s draft, seat %d of %d, %d sims per option, objective %s (%s); set-up %.2f s"
        % (mode, slot, s.lg.teams, sims, s.objective, s.lg.format, time.time() - t0))
    timings = []
    while True:
        info = json.loads(s.begin_stop())
        if info["done"]:
            break
        t1 = time.time()
        res = json.loads(s.simulate())
        dt = time.time() - t1
        n_opt = len(res["options"])
        timings.append((info["kind"], dt, n_opt, res["sims"], len(s.draft.log)))
        best = res["best_row"]
        r = json.loads(s.auto())
        if not r.get("ok"):
            raise RuntimeError(r)
        if quiet:
            continue
        if info["kind"] == "pick":
            out("  R%-2d pick %3d  %-24s %-8s $%5.1f  win %s roto %5.1f  (%d options, %.2f s)"
                % (info["round"], info["overall"], best["name"], best["pos"], best["value"], pct(best["win"]), best["roto"], n_opt, dt))
        elif info["kind"] == "bid":
            lot = info["lot"]
            res_row = r["result"]
            got = "WON at $%d" % res_row["price"] if r["mine"] else "team %d at $%d" % (res_row["team"], res_row["price"])
            be = res.get("break_even") or {}
            pts = (be.get("points") or {}).get("p_star")
            out("  lot %3d  %-24s %-8s $%5.1f  max bid $%-3d (on points $%s) -> %-17s pass: win %s roto %5.1f  (%d options, %.2f s)"
                % (len(s.draft.log), lot["name"], lot["pos"], lot["value"], best["amount"], "-" if pts is None else "%.0f" % pts, got,
                   pct(best["win"]), best["roto"], n_opt, dt))
        else:
            out("  nominate %-24s %-8s $%5.1f  (%d options, %.2f s)" % (best["name"], best["pos"], best["value"], n_opt, dt))
    t2 = time.time()
    fin = json.loads(s.final(n_sims=400))
    out("final odds over %d outcome worlds (%.1f s)" % (fin["sims"], time.time() - t2))
    out("  your roster:")
    for p in fin["roster"]:
        price = "" if p["price"] is None else "$%3d" % p["price"]
        out("    %-3s %-24s %-11s $%5.1f  %s" % (p["slot"], p["name"], p["pos"], p["value"], price))
    out("  %-6s %6s %6s %6s %7s %8s %8s %6s" % ("team", "roto", "finish", "win", "team $", "playoff", "champ", "spent"))
    for row in fin["standings"]:
        out("  %-6s %6.1f %6.2f %6s %7.1f %8s %8s %6s" % ("you" if row["you"] else "T%d" % row["team"], row["roto"], row["finish"],
            pct(row["win"]), row["team_value"], pct(row.get("playoff")), pct(row.get("champ")), "" if row["spent"] is None else row["spent"]))  # fmt: skip
    if timings:
        ts = [t[1] for t in timings]
        per = [t[1] / (t[2] * t[3]) * 1000 for t in timings]
        out("decisions %d; seconds per decision: mean %.2f, max %.2f (first %.2f); ms per play-out: mean %.2f, max %.2f; total %.0f s"
            % (len(ts), sum(ts) / len(ts), max(ts), ts[0], sum(per) / len(per), max(per), sum(ts)))
    return s, fin, timings


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["snake", "auction", "both"], default="both")
    ap.add_argument("--slot", type=int, default=5)
    ap.add_argument("--sims", type=int, default=None, help="simulations per option (default: snake 200, auction 60)")
    ap.add_argument("--seed", type=int, default=20270401)
    ap.add_argument("--format", choices=["roto", "h2h"], default=None)
    ap.add_argument("--auto-below", type=float, default=3.0, help="auction: lots worth less are bid on by value, unpriced")
    ap.add_argument("--players", default=None, help="the table JSON (default: export with Node)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    table, rh, rp = load_inputs(a.players)
    for mode in (["snake", "auction"] if a.mode == "both" else [a.mode]):
        sims = a.sims or (200 if mode == "snake" else 60)
        run(mode, table, rh, rp, a.slot, sims, a.seed, a.format, a.auto_below, a.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
