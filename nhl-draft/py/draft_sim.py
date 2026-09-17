"""Snake-draft simulation and SGP coefficient calibration.

Pipeline
  calibrate : simulate leagues -> team totals -> SGP slopes -> coefficients -> values -> replacement
              (with --drafters model the loop is iterated to a fixed point)
  evaluate  : our team drafts by the model against 11 market drafters; report roto points
  outputs   : coefficients.csv, sgp_slopes.csv, player_values.csv, sample_draft.csv, summary.txt

Draft strategies
  adp      : best available on the market board (ADP with log-normal noise) that fits the roster
  blend    : same, on a board of w * VORP rank + (1 - w) * ADP rank (per-team w)
  board    : same, on a ranked order handed in (finish_sim.py builds these from per-draft draws)
  model    : max  value - repl[slot consumed]  using the static league-level coefficients
  dynamic  : same, but each category is re-weighted by the density of opponent totals at the
             team's projected total, so saturated (or hopeless) categories stop attracting picks

    python draft_sim.py                          # Fantrax-ADP opponents, 12-team default roster
    python draft_sim.py --adp yahoo --slot 5     # Yahoo-rank opponents, we pick 5th
    python draft_sim.py --drafters model         # self-consistent league of model drafters
"""
import argparse
import sys
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd

from league import CATS, League, Roster, STATS, load_players, roto_points, team_totals
from valuation import category_values, coefficients, position_values, replacement_levels, sgp_slopes

I_SV, I_GA, I_GS = STATS.index("SV"), STATS.index("GA"), STATS.index("GS")
I_GAA = CATS.index("GAA")


@dataclass
class Model:
    """Everything a model drafter needs, built once per calibration."""
    value: np.ndarray       # static value per player (standings places)
    cost: dict              # slot -> replacement value
    cv: np.ndarray          # [n, len(CATS)] category contributions per player
    stats: np.ndarray       # [n, len(STATS)] raw projections
    starter: np.ndarray     # league-wide starter mask (used to project unfilled slots)
    repl_pid: dict          # slot -> replacement player
    elig: dict              # slot -> eligibility mask
    mu: np.ndarray          # opponent team-total mean per category
    sd: np.ndarray          # opponent team-total sd per category
    assigned: pd.Series     # each player's assigned (scarcest eligible) position


def snake_order(n_teams, rounds):
    return [t for r in range(rounds) for t in (range(n_teams) if r % 2 == 0 else range(n_teams - 1, -1, -1))]


def raw_to_cats(raw):
    """Raw stat totals [len(STATS)] -> category totals [len(CATS)] (SV% and GAA derived)."""
    sa, gs = raw[I_SV] + raw[I_GA], raw[I_GS]
    return np.append(raw[:I_GA], [raw[I_SV] / sa if sa else 0.0, raw[I_GA] / gs if gs else 0.0])


def dynamic_weights(R, available, m):
    """Per-category weights phi(z)/phi(0) at the team's projected finish in each category.

    Projected total = current starters + each open slot filled by the average still-available
    league-wide starter eligible for it.  A category the team already dominates (or has no hope
    in) gets a small weight: extra units there pass nobody in the standings.
    """
    proj = m.stats[list(R.slot_of)].sum(axis=0) if R.slot_of else np.zeros(len(STATS))
    for s, cap in R.cap.items():
        k = cap - R.count[s]
        if k:
            pool = available & m.starter & m.elig[s]
            proj += k * (m.stats[pool].mean(axis=0) if pool.any() else m.stats[m.repl_pid[s]])
    z = (raw_to_cats(proj) - m.mu) / m.sd
    z[I_GAA] *= -1
    return np.exp(-0.5 * z * z)


def run_draft(players, league, drafters, rng, model=None, adp_col="adp_fantrax", ranks=None):
    """Snake draft. drafters: one entry per team - ("adp", noise), ("blend", noise, w_vorp),
    ("board", order), ("model", noise) or ("dynamic", noise); model teams need `model`, blend
    teams need `ranks` = {"vorp": array, "adp": array} (1 = best), board teams bring their own
    ranked order of player rows.

    Market teams take the best available on their board (ADP, or w*VORP rank + (1-w)*ADP rank,
    times log-normal noise) that fits.  Model teams take the player maximising
    value - cost[slot consumed], the slot consumed being the cheapest free slot reachable by
    re-routing, so positional need is priced in as the roster fills.
    Returns (picks DataFrame, rosters).
    """
    n = league.n_teams
    slots = players["slots"].to_numpy()
    adp = players[adp_col].to_numpy(float)
    boards = []
    for d in drafters:
        kind, noise = d[0], d[1]
        if kind == "board":                     # a precomputed board order (see boards.team_boards)
            boards.append(("adp", np.asarray(d[1]), None))
        elif kind in ("adp", "blend"):
            base = adp if kind == "adp" else d[2] * ranks["vorp"] + (1.0 - d[2]) * ranks["adp"]
            key = base * np.exp(rng.normal(0.0, noise, len(adp))) if noise else base
            boards.append(("adp", np.argsort(key, kind="stable"), None))
        else:
            key = model.value + (rng.normal(0.0, noise, len(adp)) if noise else 0.0)
            boards.append((kind, np.argsort(-key, kind="stable"), key))
    ptr = [0] * n                                   # skip the already-drafted top of each board
    available = np.ones(len(players), bool)
    rosters = [Roster(league.slots) for _ in range(n)]
    picks = []
    for pick_no, team in enumerate(snake_order(n, league.roster_size), 1):
        R, (kind, order, key) = rosters[team], boards[team]
        while not available[order[ptr[team]]]:
            ptr[team] += 1
        chosen = None
        if R.full():                                # bench: best available on the board
            chosen = order[ptr[team]]
            R.bench.append(chosen)
        elif kind == "adp":
            for pid in order[ptr[team]:]:
                if available[pid] and R.add(pid, slots[pid]) is not None:
                    chosen = pid
                    break
        else:
            cost, start = model.cost, ptr[team]
            if kind == "dynamic":
                w = dynamic_weights(R, available, model)
                key = model.cv @ w + (key - model.value)      # re-weighted value, same noise draw
                order, start = np.argsort(-key, kind="stable"), 0
                cost = {s: float(model.cv[pid] @ w) for s, pid in model.repl_pid.items()}
            min_cost, best = min(cost.values()), -np.inf
            for pid in order[start:]:
                if not available[pid]:
                    continue
                if key[pid] - min_cost <= best:     # nothing further down the board can win
                    break
                s, _ = R.find_slot(slots[pid], cost)
                if s is not None and key[pid] - cost[s] > best:
                    best, chosen = key[pid] - cost[s], pid
            if chosen is None:
                raise RuntimeError(f"team {team} could not fill its roster")
            R.add(chosen, slots[chosen], cost)
        available[chosen] = False
        picks.append((pick_no, (pick_no - 1) // n + 1, team, chosen, R.slot_of.get(chosen, "BN")))
    return pd.DataFrame(picks, columns=["Pick", "Round", "Team", "pid", "Slot"]), rosters


def league_totals(rosters, stats):
    return pd.DataFrame([team_totals(stats, R.slot_of.keys()) for R in rosters])


def simulate_leagues(players, stats, league, drafters, sims, rng, model=None, adp_col="adp_fantrax"):
    return [league_totals(run_draft(players, league, drafters, rng, model, adp_col)[1], stats)
            for _ in range(sims)]


def build_model(players, stats, league, coef, parts, totals):
    value = players[STATS] @ coef
    repl, starter, repl_pid, assigned = replacement_levels(players, value, league)
    allt = pd.concat(totals, ignore_index=True)[CATS]
    elig = {s: players["slots"].map(lambda t: s in t).to_numpy() for s in league.slots}
    return Model(value.to_numpy(float), repl, category_values(players, parts).to_numpy(float), stats,
                 starter.to_numpy(), repl_pid, elig, allt.mean().to_numpy(), allt.std().to_numpy(), assigned)


def calibrate(players, stats, league, args, rng, log=print):
    """SGP slopes -> coefficients -> values -> replacement levels; iterated when model drafters are used."""
    n = league.n_teams
    market = [("adp", args.adp_noise)] * n
    t0 = time.time()
    totals = simulate_leagues(players, stats, league, market, args.calib_sims, rng, adp_col=args.adp_col)
    d, d_sd, params = sgp_slopes(totals)
    coef, parts = coefficients(d, params)
    model = build_model(players, stats, league, coef, parts, totals)
    log(f"calibration: {args.calib_sims} market leagues in {time.time() - t0:.1f}s")

    if args.drafters != "adp":
        ours = [(args.strategy, args.model_noise)] * n
        drafters = ours if args.drafters == "model" else [ours[0] if i % 2 else market[0] for i in range(n)]
        for it in range(1, args.max_iters + 1):
            totals = simulate_leagues(players, stats, league, drafters, args.calib_sims, rng, model, args.adp_col)
            d, d_sd, params = sgp_slopes(totals)
            new_coef, parts = coefficients(d, params)
            change = float((new_coef / coef - 1).abs().max())
            coef = args.damping * new_coef + (1 - args.damping) * coef
            model = build_model(players, stats, league, coef, parts, totals)
            log(f"  iteration {it}: max coefficient change {change:.1%}")
            if change < args.tol:
                break
        coef, parts = coefficients(d, params)      # report the un-damped fixed point
        model = build_model(players, stats, league, coef, parts, totals)
    return dict(d=d, d_sd=d_sd, params=params, coef=coef, parts=parts, model=model,
                value=pd.Series(model.value, index=players.index), repl=model.cost,
                starter=pd.Series(model.starter, index=players.index), assigned=model.assigned)


def evaluate(players, stats, league, cal, args, rng):
    """Our team (no noise) vs market drafters, rotating through draft slots unless --slot is set."""
    n = league.n_teams
    rows = []
    for i in range(args.eval_sims):
        slot = (args.slot - 1) if args.slot else i % n
        for strategy in ("dynamic", "model", "adp"):    # 'adp' = we draft straight off the market board
            drafters = [("adp", args.adp_noise)] * n
            drafters[slot] = (strategy, 0.0)
            _, rosters = run_draft(players, league, drafters, rng, cal["model"], args.adp_col)
            pts = roto_points(league_totals(rosters, stats))
            finish = pts["Total"].rank(ascending=False, method="min")
            rows.append({"sim": i, "slot": slot + 1, "strategy": strategy, "finish": finish[slot],
                         "win": float(finish[slot] == 1), **pts.loc[slot].to_dict()})
    return pd.DataFrame(rows)


def write_outputs(players, cal, ev, sample, league, args, out_dir="."):
    d, d_sd, coef, parts, repl = cal["d"], cal["d_sd"], cal["coef"], cal["parts"], cal["repl"]
    lines = []
    say = lines.append

    say(f"League: {league.n_teams} teams, slots {league.slots}, bench {league.bench}")
    say(f"Calibration: {args.calib_sims} leagues of {args.drafters} drafters; market board = {args.adp_col}")
    say(f"Ratio-stat linearisation: team shots against {cal['params']['team_SA']:.0f}, team starts "
        f"{cal['params']['team_GS']:.0f}, league SV% {cal['params']['lg_SVpct']:.4f}, GAA {cal['params']['lg_GAA']:.3f}")

    say("\n== SGP slopes: stat units per standings place (mean +/- sd across simulated leagues) ==")
    slopes = pd.DataFrame({"per_place": d, "sd": d_sd, "places_per_unit": 1 / d,
                           "team_mean": cal["model"].mu, "team_sd": cal["model"].sd})
    say(slopes.round(4).to_string())
    slopes.to_csv(f"{out_dir}/sgp_slopes.csv")

    say("\n== Coefficients: standings places per unit of each raw stat ==")
    ctab = pd.DataFrame(parts).T.reindex(STATS).fillna(0.0)
    ctab["coef"] = coef
    say(ctab.round(5).to_string())
    ctab.to_csv(f"{out_dir}/coefficients.csv")
    say("\nvalue = " + " ".join(f"{coef[s]:+.4f}*{s}" for s in STATS))

    say("\n== Per-position replacement level and Position Value (vs. the deepest skater position) ==")
    starters = cal["assigned"][cal["starter"]].value_counts()
    rtab = pd.DataFrame({"slots": pd.Series(league.league_slots()), "starters": starters,
                         "Repl": pd.Series(repl), "PosValue": repl["UTIL"] - pd.Series(repl),
                         "ReplPlayer": pd.Series({s: players.at[p, "Player"] for s, p in cal["model"].repl_pid.items()})})
    say(rtab.round(3).to_string())

    pv = position_values(players, cal["value"], repl, cal["assigned"])
    cv = category_values(players, parts)
    out = pd.concat([players[["Player", "Team", "Pos_Y", "ADP", "FantraxRk", "adp_yahoo"] + STATS],
                     cv.add_prefix("v_"), pv], axis=1)
    out["RawValue"] = cal["value"]
    out["Starter"] = cal["starter"]
    out = out.sort_values("VORP", ascending=False)
    out["Rank"] = np.arange(1, len(out) + 1)
    out["ADP_Rank"] = out["ADP"].rank(method="min")
    out["Rank_vs_ADP"] = out["ADP_Rank"] - out["Rank"]
    out["ADP_sd"] = players["ADP_sd"]
    cols = ["Rank", "Player", "Team", "Pos_Y", "BestSlot", "ADP", "ADP_sd", "ADP_Rank", "Rank_vs_ADP", "VORP", "RawValue",
            "Repl", "PosValue", "Starter"] + [f"v_{c}" for c in CATS] + STATS + ["FantraxRk", "adp_yahoo"]
    out[cols].round(3).to_csv(f"{out_dir}/player_values.csv", index=False)

    say("\n== Top 40 by VORP ==")
    say(out[["Rank", "Player", "Pos_Y", "BestSlot", "ADP", "Rank_vs_ADP", "VORP", "RawValue", "PosValue"]]
        .head(40).round(2).to_string(index=False))
    top = out.head(league.n_teams * league.starters)
    say(f"\nAssigned-position mix of the top {len(top)} by VORP: "
        + ", ".join(f"{k} {v}" for k, v in top["BestSlot"].value_counts().items()))

    say("\n== Biggest values vs ADP (top-200 ADP, VORP rank at least 25 better) ==")
    vals = out[(out["ADP"] <= 200) & (out["Rank_vs_ADP"] >= 25)]
    say(vals[["Rank", "Player", "Pos_Y", "ADP", "ADP_Rank", "Rank_vs_ADP", "VORP"]].head(25).round(2).to_string(index=False))
    say("\n== Biggest reaches vs ADP (top-100 ADP, VORP rank at least 25 worse) ==")
    reach = out[(out["ADP"] <= 100) & (out["Rank_vs_ADP"] <= -25)]
    say(reach[["Rank", "Player", "Pos_Y", "ADP", "ADP_Rank", "Rank_vs_ADP", "VORP"]].head(25).round(2).to_string(index=False))

    slot_txt = args.slot if args.slot else "rotating"
    say(f"\n== Evaluation: {args.eval_sims} drafts, us vs {league.n_teams - 1} market drafters (slot {slot_txt}) ==")
    g = ev.groupby("strategy")
    summ = pd.DataFrame({"avg_points": g["Total"].mean(), "avg_finish": g["finish"].mean(),
                         "win_rate": g["win"].mean(), "top3_rate": g["finish"].apply(lambda f: (f <= 3).mean())})
    say(summ.round(3).to_string())
    say(f"\nAverage category points (max {league.n_teams}):")
    say(g[CATS].mean().round(2).to_string())
    if not args.slot:
        say(f"\n{args.strategy} strategy: average points / finish by draft slot:")
        m = ev[ev.strategy == args.strategy].groupby("slot").agg(points=("Total", "mean"), finish=("finish", "mean"))
        say(m.round(2).T.to_string())

    picks, rosters = sample
    sd = picks.merge(out[["Player", "Pos_Y", "ADP", "VORP", "Rank"]], left_on="pid", right_index=True)
    sd["Team"] = sd["Team"] + 1
    sd.drop(columns="pid").sort_values("Pick").round(2).to_csv(f"{out_dir}/sample_draft.csv", index=False)
    us = sd[sd["Team"] == (args.slot or 1)].sort_values("Pick")
    say(f"\n== Sample draft ({args.strategy}): our picks from slot {args.slot or 1} ==")
    say(us[["Pick", "Round", "Player", "Pos_Y", "Slot", "ADP", "VORP", "Rank"]].round(2).to_string(index=False))
    pts = roto_points(league_totals(rosters, players[STATS].to_numpy(float)))
    pts.index = pts.index + 1
    say("\nSample draft standings (points by category):")
    say(pts.round(1).sort_values("Total", ascending=False).to_string())

    text = "\n".join(lines)
    with open(f"{out_dir}/summary.txt", "w", encoding="utf-8") as f:
        f.write(text)
    return text


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sheet", default="sheet_live.csv")
    p.add_argument("--refresh", action="store_true", help="re-download the Google Sheet to --sheet")
    p.add_argument("--teams", type=int, default=12)
    p.add_argument("--slots", default="C:2,LW:2,RW:2,D:4,UTIL:2,G:2")
    p.add_argument("--bench", type=int, default=0, help="bench spots (drafted, not counted in totals)")
    p.add_argument("--adp", choices=["fantrax", "yahoo", "blend"], default="fantrax", help="market board for opponents")
    p.add_argument("--adp-noise", type=float, default=0.25, help="log-normal sd applied to opponents' ADP")
    p.add_argument("--drafters", choices=["adp", "model", "mixed"], default="adp",
                   help="who populates the calibration leagues")
    p.add_argument("--strategy", choices=["model", "dynamic"], default="dynamic", help="how our team drafts")
    p.add_argument("--model-noise", type=float, default=1.0, help="sd (standings places) on model drafters' values")
    p.add_argument("--calib-sims", type=int, default=200)
    p.add_argument("--eval-sims", type=int, default=120)
    p.add_argument("--slot", type=int, default=0, help="our draft slot (1-based); 0 rotates through all slots")
    p.add_argument("--max-iters", type=int, default=8)
    p.add_argument("--damping", type=float, default=0.5)
    p.add_argument("--tol", type=float, default=0.01)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--out", default=".")
    a = p.parse_args(argv)
    a.adp_col = f"adp_{a.adp}"
    return a


def main(argv=None):
    args = parse_args(argv)
    league = League(n_teams=args.teams, bench=args.bench,
                    slots={k: int(v) for k, v in (kv.split(":") for kv in args.slots.split(","))})
    players = load_players(args.sheet, refresh=args.refresh)
    stats = players[STATS].to_numpy(float)
    rng = np.random.default_rng(args.seed)

    cal = calibrate(players, stats, league, args, rng)
    ev = evaluate(players, stats, league, cal, args, rng)
    drafters = [("adp", args.adp_noise)] * league.n_teams
    drafters[(args.slot or 1) - 1] = (args.strategy, 0.0)
    sample = run_draft(players, league, drafters, np.random.default_rng(args.seed + 1), cal["model"], args.adp_col)
    print(write_outputs(players, cal, ev, sample, league, args, args.out))


if __name__ == "__main__":
    sys.exit(main())
