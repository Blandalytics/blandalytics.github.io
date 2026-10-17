"""The per-pitch model behind the Lineup Sim's "Per-Pitch (modeled)" option.

    python -I tools/lineup_sims/pitch_model.py 2026 --pitches PATH     # writes lineup-sims/data/2026-pitch.json

Inputs:
    cache/pbp/<season>/*.json   fetch_pbp.py (each PA's result, batting spot, pitcher role)
    a file of every pitch       the projections project's data/interim/pitch_scores/mlb_<season>.parquet
                                (game_pk, at_bat_index, pitch_number, balls, strikes, the outcome
                                class and the location against the zone), joined to the PAs by
                                game and at-bat index

Every pitch, in each of the 12 counts, goes through a chain of steps, each one the league's chances
(by count, and by zone where it matters, in each platoon cell: pitcher hand + batter side, "RL" a
lefty batter against a right-hander) times the hitter's and the pitcher's ratios to the league:
    zone     in the zone or not                                     (by count)
    swing    swing or take                                          (by count and zone)
    take     ball / called strike / HBP, given a take               (by count and zone)
    contact  contact or whiff, given a swing                        (by count and zone)
    fair     in play or foul, given contact                         (by count and zone)
    hr       a home run or not, given in play                       (by count)
    inplay   1B 2B 3B GB LD FB PU, given in play and not a home run  (by count)
The page walks the count chain (sim.js pitchChances()) to the 11 PA outcomes the simulation takes.

A player's ratio for a step is his observed classes over what the league would have done on the
same pitches, with a prior of k pitches at the league's mix (PRIORS, tuned on 2026: fit on games
before June 26, best at predicting every later PA). Three per player:
    a   against the league over every cell (platoon splits off, and MLB-average pitching)
    g   against the league in the cells he played in (league-average platoon gaps)
    c   in each cell he played in, shrunk toward g by a split prior (each player's own splits); a
        step with no split prior keeps g
A lineup spot pools every hitter who batted there (as build.py does); a bullpen pools a team's
relievers (pitchers who didn't start the game), "MLB" all relievers, "bulk" relief outings of 3+
innings. Ratios are stored per step as the ratios of classes 1.. to class 0 (all that log5 uses),
13 numbers in step order. "checks" holds a few matchups worked out here, for test_sim.mjs to match.
"""
import argparse
import collections
import datetime as dt
import json
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # `python -I` leaves it off
import pbp  # noqa: E402

TOOL = pathlib.Path(__file__).resolve().parent
CACHE = TOOL / "cache"
REPO = TOOL.parent.parent
CATS = pbp.CATS
INPLAY = ["1B", "2B", "3B", "HR", "GB", "LD", "FB", "PU"]
REST = [c for c in INPLAY if c != "HR"]            # the inplay step's classes
CELLS = ["RR", "RL", "LR", "LL"]
B, CS, SS, F, X, HBP = range(6)                    # pitch classes
BULK = 9                                           # outs: a relief outing of 3+ innings
# the steps: name, classes, contexts (count, or count * 2 + zone)
STEPS = [("zone", 2, 12), ("swing", 2, 24), ("take", 3, 24), ("contact", 2, 24), ("fair", 2, 24), ("hr", 2, 12), ("inplay", 7, 12)]
# pitches of league average added: (overall, split); a split of None keeps the league's gap
PRIORS = {
    "hitter": {"zone": (1000, 3000), "swing": (30, 300), "take": (1000, 3000), "contact": (30, 1000),
               "fair": (300, 1000), "hr": (100, None), "inplay": (300, None)},
    "pitcher": {"zone": (300, 3000), "swing": (300, 3000), "take": (1000, 1000), "contact": (100, 1000),
                "fair": (300, 1000), "hr": (1000, 1000), "inplay": (300, None)},
}


def plays(season):
    """Every PA-level record pbp.replay() gives (skipped half-innings left out, as build.py does),
    with what the pitch model keys on."""
    rows, outs = [], collections.Counter()
    for g in pbp.load_games(season, CACHE):
        abbr = {side: g["teams"][side]["abbr"] for side in ("away", "home")}
        fielding = {"away": abbr["home"], "home": abbr["away"]}
        spot_of = {side: {int(pid): int(code) // 100 for pid, code in g["order"][side].items()} for side in ("away", "home")}
        starter = {}
        for p in g["plays"]:
            starter.setdefault("away" if p[2] else "home", p[6])
        for r in pbp.replay(g):
            if "skip" in r:
                continue
            outs[(g["pk"], r["side"], r["pitcher"])] += r["run_outs"] + r["event_outs"]
            cat = pbp.category(r["event"], r["traj"]) if r["is_pa"] else None
            rows.append((g["pk"], r["ab"], r["batter"], r["pitcher"], r["throws"] + r["stand"], abbr[r["side"]],
                         fielding[r["side"]], spot_of[r["side"]].get(r["batter"], 0), r["pitcher"] == starter[r["side"]],
                         r["side"], CATS.index(cat) if cat else -1))
    pas = pd.DataFrame(rows, columns=["game_pk", "ab", "batter", "pitcher", "cell", "team", "fielding", "spot",
                                      "start", "side", "cat"])
    pas["bulk"] = [not s and outs[(pk, side, pid)] >= BULK
                   for pk, side, pid, s in zip(pas.game_pk, pas.side, pas.pitcher, pas.start)]
    return pas.drop_duplicates(["game_pk", "ab"])


def pitches(path, pas):
    d = pd.read_parquet(path, columns=["game_pk", "at_bat_index", "pitch_number", "balls", "strikes", "observed",
                                       "plate_x", "plate_z", "sz_top", "sz_bot"]).rename(columns={"at_bat_index": "ab"})
    d = d.merge(pas, on=["game_pk", "ab"], how="inner")
    d = d[(d.balls <= 3) & (d.strikes <= 2)].copy()
    last = (d.groupby(["game_pk", "ab"]).pitch_number.transform("max") == d.pitch_number).to_numpy()
    base = d.observed.map({"ball": B, "called_strike": CS, "swinging_strike": SS, "foul": F}).fillna(X).astype(int).to_numpy()
    cls, cat = base.copy(), d.cat.to_numpy()
    # a PA's last pitch takes its class from the PA's result (the pitch file has no HBP or foul tip)
    t = last & (cat >= 0)
    k = t & (cat == CATS.index("K"))
    cls[k] = np.where(base[k] == CS, CS, SS)
    cls[t & (cat == CATS.index("BB"))] = B
    cls[t & (cat == CATS.index("HBP"))] = HBP
    cls[t & (cat >= CATS.index("1B"))] = X
    d["cls"] = cls
    d["count"] = d.balls * 3 + d.strikes
    r = 0.1208  # the ball's radius, ft: any part of it over any part of the zone
    d["zone"] = ((d.plate_x.abs() <= 0.7083 + r) & (d.plate_z >= d.sz_bot - r) & (d.plate_z <= d.sz_top + r)).astype(int)
    d["bb"] = np.where((d.cls == X) & last & (d.cat >= CATS.index("1B")), d.cat - CATS.index("1B"), -1)
    d["cell_i"] = d.cell.map({c: i for i, c in enumerate(CELLS)})
    return d


def step_rows(d, name):
    """A step's pitches, contexts and classes."""
    c, z, cls, bb = d["count"].to_numpy(), d.zone.to_numpy(), d.cls.to_numpy(), d.bb.to_numpy()
    hr = INPLAY.index("HR")
    if name == "zone":
        return np.ones(len(d), bool), c, z
    if name == "swing":
        return np.ones(len(d), bool), c * 2 + z, np.isin(cls, [SS, F, X]).astype(int)
    if name == "take":
        m = np.isin(cls, [B, CS, HBP])
        return m, c * 2 + z, np.select([cls == CS, cls == HBP], [1, 2], 0)
    if name == "contact":
        return np.isin(cls, [SS, F, X]), c * 2 + z, (cls != SS).astype(int)
    if name == "fair":
        return np.isin(cls, [F, X]), c * 2 + z, (cls == X).astype(int)
    if name == "hr":
        return bb >= 0, c, (bb == hr).astype(int)
    rest = {INPLAY.index(x): i for i, x in enumerate(REST)}
    return (bb >= 0) & (bb != hr), c, np.vectorize(lambda v: rest.get(v, 0))(bb)


def fit(d):
    """The league's tables (pooled and by cell) and, per step, every pitch's league chances."""
    tables, per_pitch = {}, {}
    for name, K, nctx in STEPS:
        m, ctx, cls = step_rows(d, name)
        cell = d.cell_i.to_numpy()[m]
        ctx, cls = ctx[m], cls[m]
        counts = np.zeros((4, nctx, K))
        np.add.at(counts, (cell, ctx, cls), 1)
        pooled = counts.sum(0)
        t_all = (pooled + 0.5) / (pooled + 0.5).sum(-1, keepdims=True)
        t_cell = (counts + 0.5) / (counts + 0.5).sum(-1, keepdims=True)
        tables[name] = {"all": t_all, "cells": t_cell, "pbar": pooled.sum(0) / pooled.sum(),
                        "pbar_cell": counts.sum(1) / np.maximum(counts.sum((1, 2))[:, None], 1)}
        per_pitch[name] = {"m": m, "cls": cls, "cell": cell, "q_all": t_all[ctx], "q_cell": t_cell[cell, ctx]}
    return tables, per_pitch


def ratios(d, tables, per_pitch, key, priors, keep=None):
    """{actor: {"a": [13], "g": [13], "c": {cell: [13]}}} for the actors in column `key` of d,
    from the pitches in `keep` (a mask over d; every pitch by default)."""
    out = collections.defaultdict(lambda: {"a": [], "g": [], "c": collections.defaultdict(list)})
    for name, K, _ in STEPS:
        pp, tb = per_pitch[name], tables[name]
        if keep is not None:
            pp = sub_mask(pp, keep)
        who = d[key].to_numpy()[pp["m"]]
        ids, inv = np.unique(who, return_inverse=True)
        n = len(ids)
        O, Ea, Eg = np.zeros((n, K)), np.zeros((n, K)), np.zeros((n, K))
        Oc, Ec = np.zeros((n, 4, K)), np.zeros((n, 4, K))
        np.add.at(O, (inv, pp["cls"]), 1)
        np.add.at(Ea, inv, pp["q_all"])
        np.add.at(Eg, inv, pp["q_cell"])
        np.add.at(Oc, (inv, pp["cell"], pp["cls"]), 1)
        np.add.at(Ec, (inv, pp["cell"]), pp["q_cell"])
        k, k2 = priors[name]
        pbar = tb["pbar"]
        a = (O + k * pbar) / (Ea + k * pbar)
        g = (O + k * pbar) / (Eg + k * pbar)
        if k2 is not None:
            c = (Oc + k2 * g[:, None] * tb["pbar_cell"][None]) / (Ec + k2 * tb["pbar_cell"][None])
        seen = Oc.sum(-1) > 0
        for i, actor in enumerate(ids):
            o = out[actor]
            o["a"] += list(a[i, 1:] / a[i, 0])
            o["g"] += list(g[i, 1:] / g[i, 0])
            for j, cn in enumerate(CELLS):
                if seen[i, j]:
                    # a cell a step has no split prior for keeps g (the page falls back to it)
                    o["c"][cn] += list((c[i, j, 1:] / c[i, j, 0]) if k2 is not None else (g[i, 1:] / g[i, 0]))
    res = {}
    for actor, o in out.items():
        cells = {cn: v for cn, v in o["c"].items() if len(v) == 13}  # cells with pitches in every step
        res[actor] = {"a": [round(x, 3) for x in o["a"]], "g": [round(x, 3) for x in o["g"]],
                      **({"c": {cn: [round(x, 3) for x in v] for cn, v in cells.items()}} if cells else {})}
    return res


# ---------- the count chain, as sim.js pitchChances() works it (for the checks) ----------
SIZES = [K - 1 for _, K, _ in STEPS]


def expand(v):
    """13 stored numbers -> each step's class ratios (class 0 is 1)."""
    out, i = {}, 0
    for (name, K, _), s in zip(STEPS, SIZES):
        out[name] = np.concatenate([[1.0], v[i:i + s]]) if v is not None else np.ones(K)
        i += s
    return out


def chances(tab, h, p):
    """PA outcome chances (11) for hitter ratios h against pitcher ratios p (expand()ed) with
    the league tables tab (each step's [ctx][K])."""
    def at(name, ctx):
        q = tab[name][ctx] * h[name] * p[name]
        return q / q.sum()
    pB, pCS, pSS, pF, pX, pH = (np.zeros(12) for _ in range(6))
    pbb = np.zeros((12, 8))
    for c in range(12):
        pz = at("zone", c)[1]
        for z, wz in ((0, 1 - pz), (1, pz)):
            ctx = c * 2 + z
            sw, tk = at("swing", ctx)[1], at("take", ctx)
            con, fair = at("contact", ctx)[1], at("fair", ctx)[1]
            pB[c] += wz * (1 - sw) * tk[0]
            pCS[c] += wz * (1 - sw) * tk[1]
            pH[c] += wz * (1 - sw) * tk[2]
            pSS[c] += wz * sw * (1 - con)
            pF[c] += wz * sw * con * (1 - fair)
            pX[c] += wz * sw * con * fair
        hr, rest = at("hr", c)[1], at("inplay", c) * (1 - at("hr", c)[1])
        pbb[c] = np.insert(rest, INPLAY.index("HR"), hr)
    arrive, out = np.zeros(12), np.zeros(11)
    arrive[0] = 1
    for c in sorted(range(12), key=lambda c: (c // 3 + c % 3, c)):
        b, s = divmod(c, 3)
        v = arrive[c] / (1 - min(pF[c], 0.999)) if s == 2 else arrive[c]
        if b == 3:
            out[CATS.index("BB")] += v * pB[c]
        else:
            arrive[c + 3] += v * pB[c]
        strike = pCS[c] + pSS[c] + (pF[c] if s < 2 else 0)
        if s == 2:
            out[CATS.index("K")] += v * strike
        else:
            arrive[c + 1] += v * strike
        out[CATS.index("HBP")] += v * pH[c]
        out[CATS.index("1B"):] += v * pX[c] * pbb[c]
    return out


def main(season, path):
    pas = plays(season)
    d = pitches(path, pas)
    tables, per_pitch = fit(d)
    actors = {
        "hitters": ratios(d, tables, per_pitch, "batter", PRIORS["hitter"]),
        "pitchers": ratios(d, tables, per_pitch, "pitcher", PRIORS["pitcher"]),
    }
    # lineup spots: every hitter who batted there, a team's and MLB's
    batted = d.spot.to_numpy() > 0
    d["spot_key"] = d.team + "-" + d.spot.astype(str)
    d["mlb_spot"] = "MLB-" + d.spot.astype(str)
    sp = ratios(d, tables, per_pitch, "spot_key", PRIORS["hitter"], batted)
    sp.update(ratios(d, tables, per_pitch, "mlb_spot", PRIORS["hitter"], batted))
    actors["spots"] = sp
    # bullpens: a team's relievers, every reliever ("MLB") and relief outings of 3+ innings ("bulk")
    relief = ~d.start.to_numpy()
    d["all_relief"], d["bulk_key"] = "MLB", "bulk"
    pens = ratios(d, tables, per_pitch, "fielding", PRIORS["pitcher"], relief)
    pens.update(ratios(d, tables, per_pitch, "all_relief", PRIORS["pitcher"], relief))
    pens.update(ratios(d, tables, per_pitch, "bulk_key", PRIORS["pitcher"], d.bulk.to_numpy()))
    actors["pens"] = pens

    rnd = lambda t: [round(float(x), 5) for x in t.ravel()]  # noqa: E731
    out = {"season": season, "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "source": str(path.name), "pitches": int(len(d)), "pas": int(d.groupby(["game_pk", "ab"]).ngroups),
           "steps": [[n, K, nctx] for n, K, nctx in STEPS], "rest": REST, "priors": PRIORS,
           "tables": {"all": [rnd(tables[n]["all"]) for n, _, _ in STEPS],
                      **{cn: [rnd(tables[n]["cells"][j]) for n, _, _ in STEPS] for j, cn in enumerate(CELLS)}},
           **{k: {str(a): v for a, v in vals.items()} for k, vals in actors.items()}}

    # checks for test_sim.mjs, from the stored (rounded) numbers: the league, then a few matchups
    tab = lambda key: {n: np.array(t).reshape(-1, K) for (n, K, _), t in zip(STEPS, out["tables"][key])}  # noqa: E731
    checks = [{"hitter": None, "pitcher": None, "cell": "all", "out": list(chances(tab("all"), expand(None), expand(None)))}]
    top_h = d.batter.value_counts().index[:3]
    top_p = d.pitcher.value_counts().index[:3]
    for hid, pid in zip(top_h, top_p):
        H, P = out["hitters"][str(hid)], out["pitchers"][str(pid)]
        checks.append({"hitter": int(hid), "pitcher": int(pid), "cell": "all", "use": "a",
                       "out": list(chances(tab("all"), expand(np.array(H["a"])), expand(np.array(P["a"]))))})
        for cn in sorted(set(H.get("c", {})) & set(P.get("c", {}))):
            checks.append({"hitter": int(hid), "pitcher": int(pid), "cell": cn, "use": "c",
                           "out": list(chances(tab(cn), expand(np.array(H["c"][cn])), expand(np.array(P["c"][cn]))))})
    out["checks"] = [{**c, "out": [round(x, 10) for x in c["out"]]} for c in checks]

    league_pa = chances(tab("all"), expand(None), expand(None))
    actual = np.bincount(d.loc[d.cat >= 0].drop_duplicates(["game_pk", "ab"]).cat, minlength=11)
    print(f"{len(d):,} pitches in {out['pas']:,} PAs; {len(actors['hitters'])} hitters, {len(actors['pitchers'])} pitchers, "
          f"{len(sp)} spots, {len(pens)} bullpens")
    print("league chain vs actual PA rates:",
          {c: (round(float(a), 4), round(float(b), 4)) for c, a, b in zip(CATS, league_pa, actual / actual.sum())})
    dest = REPO / "lineup-sims" / "data" / f"{season}-pitch.json"
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.0f} KB)")


def sub_mask(v, keep):
    """A step's per-pitch arrays cut to the pitches in `keep` (a mask over every pitch): "m" over
    every pitch, the rest over the step's pitches."""
    k = keep[v["m"]]
    return {"m": v["m"] & keep, "cls": v["cls"][k], "cell": v["cell"][k], "q_all": v["q_all"][k], "q_cell": v["q_cell"][k]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("season", type=int)
    ap.add_argument("--pitches", type=pathlib.Path, required=True,
                    help="the pitch file: the projections project's data/interim/pitch_scores/mlb_<season>.parquet")
    args = ap.parse_args()
    main(args.season, args.pitches)
