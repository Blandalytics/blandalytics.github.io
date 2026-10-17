"""The hook model behind the Lineup Sim's "Modeled hook" option: when a starter comes out.

    python -I tools/lineup_sims/hook_model.py 2026 --projections DIR     # writes lineup-sims/data/2026-hook.json

Inputs (read only), from the projections project's data directory:
    raw/statfast/pitches/mlb_<season>.parquet   every MLB pitch: inning, outs, score, runners, pitcher, the PA's result
    raw/statfast/games/mlb_<season>.parquet     scheduled innings (7-inning doubleheaders are left out)
    interim/transactions.parquet                MLB injured-list activations
and cache/pbp/<season>/ (fetch_pbp.py) for each PA's outcome as the simulator codes it.

A boundary is the end of a starter's plate appearance: does he face his team's next batter, or is he gone?
(No PA in this data has two pitchers, so every change is at a boundary; each team's last one is censored and
left out.) Its features, all of which the simulation can keep track of or take as given before the game:
    in the game     pitches, batters faced, outs, hits, walks + HBP, homers, strikeouts and runs so far; the
                    next batter's time through the order; inning and outs; whether the inning just ended;
                    runners on; his team's lead; this inning's pitches, runs and baserunners; the most pitches
                    in an inning so far and in the inning before; baserunners in his last three PAs
    before the game days since his last outing, his pitches over the last five days decayed (fatigue), outings
                    and pitches in the last three days, the most pitches in his last 3 and 5 starts and their
                    mean, starts so far this season, days and outings since an injured-list activation, his
                    team's starters' average outs and its bullpen's load over the last three days, the season
A LightGBM model (TREES trees of LEAVES leaves) is fit on every season from FIRST on. Tested on 2026 after
fitting on the seasons before it, it scored a log loss of .0871 per boundary, against .086 for a 600-tree model
and .109 for pitches, outs and inning alone.

The file holds the trees (flattened: split feature, threshold, missing-value rule, children; a child below
zero is leaf ~child), each feature's name, the 2026 pitches per PA by outcome (the simulation draws each PA's
pitch count from these), each 2026 starter's before-the-game values for a typical start of his (medians over
his starts; his 2026 average pitches and outs per start and his starts, to compare), each team's starters' average outs, the defaults the page uses (normal rest, no recent
outings, not back from the injured list) and a few rows with the model's answer, for test_sim.mjs.
"""
import argparse
import collections
import datetime as dt
import json
import math
import pathlib
import sys

import lightgbm as lgb
import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # `python -I` leaves it off
import pbp  # noqa: E402

TOOL = pathlib.Path(__file__).resolve().parent
CACHE = TOOL / "cache"
REPO = TOOL.parent.parent
FIRST, TREES, LEAVES = 2022, 120, 31
HIT = {"single", "double", "triple", "home_run"}
WALK = {"walk", "intent_walk", "hit_by_pitch"}
K = {"strikeout", "strikeout_double_play"}
NOT_BF = {"caught_stealing_2b", "caught_stealing_3b", "caught_stealing_home", "pickoff_1b", "pickoff_2b", "pickoff_3b",
          "pickoff_caught_stealing_2b", "pickoff_caught_stealing_3b", "pickoff_caught_stealing_home", "other_out",
          "wild_pitch", "passed_ball", "stolen_base_2b", "stolen_base_3b"}
TAU = 1.5  # days: the fatigue decay
FEATURES = ["pc", "bf_so_far", "outs_so_far", "h_so_far", "hr_so_far", "bb_so_far", "k_so_far", "r_so_far", "tto_next",
            "inning", "outs_in_inn", "inning_end", "runners_after", "margin", "inn_pitches", "inn_runs", "inn_reached",
            "max_inn_pitches", "prev_inn_pitches", "last3_reached", "days_rest", "fatigue", "pitches_3d", "apps_3d",
            "days_since_il", "apps_since_il", "team_start_outs", "pen_load_3d", "season", "max3", "max5", "mean3", "starts_season"]
MAX_PITCHES = 20  # a PA's pitch count, the last bucket that and more


def pas_of(proj, season):
    cols = ["game_pk", "game_date", "field_team", "at_bat_index", "inning", "is_top_inning", "pitcher", "pitch_number",
            "events", "outs", "bat_score", "post_bat_score", "field_score", "on_1b", "on_2b", "on_3b", "pitch_start_time"]
    d = pd.read_parquet(proj / "raw" / "statfast" / "pitches" / f"mlb_{season}.parquet", columns=cols)
    d = d.sort_values(["game_pk", "at_bat_index", "pitch_number"])
    g = d.groupby(["game_pk", "at_bat_index"], sort=False)
    pa = g.agg(date=("game_date", "first"), field_team=("field_team", "first"), inning=("inning", "first"),
               top=("is_top_inning", "first"), pitcher=("pitcher", "last"), pitches=("pitch_number", "size"),
               events=("events", "last"), outs0=("outs", "first"), score0=("bat_score", "first"),
               score1=("post_bat_score", "last"), field0=("field_score", "first"), t0=("pitch_start_time", "first"),
               on1=("on_1b", "first"), on2=("on_2b", "first"), on3=("on_3b", "first")).reset_index()
    pa["season"] = season
    pa["field_team"] = pa.field_team.astype(str)
    pa["events"] = pa.events.astype(str)
    return pa


def boundaries(proj, seasons):
    pa = pd.concat([pas_of(proj, s) for s in seasons], ignore_index=True)
    games = pd.concat([pd.read_parquet(proj / "raw" / "statfast" / "games" / f"mlb_{s}.parquet", columns=["game_pk", "scheduled_innings"])
                       for s in seasons])
    pa = pa.merge(games, on="game_pk", how="left")
    pa = pa[pa.scheduled_innings.fillna(9) == 9]
    pa = pa.sort_values(["game_pk", "field_team", "at_bat_index"]).reset_index(drop=True)

    half = ["game_pk", "inning", "top"]
    nxt = pa.groupby(half).shift(-1)
    last_in_half = nxt.outs0.isna()
    pa["inning_end"] = last_in_half.astype(int)
    pa["outs_rec"] = np.where(last_in_half, 3 - pa.outs0, nxt.outs0 - pa.outs0).clip(0, 3)
    pa["runners_after"] = np.where(last_in_half, 0, nxt.on1.notna().astype(int) + nxt.on2.notna() + nxt.on3.notna())
    pa["runs"] = (pa.score1 - pa.score0).clip(lower=0)
    ev = pa.events
    pa["hit"], pa["hr"] = ev.isin(HIT).astype(int), (ev == "home_run").astype(int)
    pa["walk"], pa["k"] = ev.isin(WALK).astype(int), ev.isin(K).astype(int)
    pa["bf"] = (~ev.isin(NOT_BF)).astype(int)

    side = ["game_pk", "field_team"]
    pa["next_pitcher"] = pa.groupby(side).pitcher.shift(-1)
    pa["censored"] = pa.next_pitcher.isna()
    pa["removed"] = (~pa.censored & (pa.next_pitcher != pa.pitcher)).astype(int)
    pa["app"] = (pa.pitcher != pa.groupby(side).pitcher.shift(1)).cumsum()
    pa["starter"] = (pa.pitcher == pa.groupby(side).pitcher.transform("first")).astype(int)

    a = pa.groupby("app")
    for col, name in (("pitches", "pc"), ("bf", "bf_so_far"), ("outs_rec", "outs_so_far"), ("hit", "h_so_far"),
                      ("hr", "hr_so_far"), ("walk", "bb_so_far"), ("k", "k_so_far"), ("runs", "r_so_far")):
        pa[name] = a[col].cumsum()
    pa["tto_next"] = pa.bf_so_far // 9 + 1
    ai = pa.groupby(["app", "inning"])
    pa["inn_pitches"] = ai.pitches.cumsum()
    pa["inn_runs"] = ai.runs.cumsum()
    pa["inn_reached"] = ai.hit.cumsum() + ai.walk.cumsum()
    pa["max_inn_pitches"] = pa.groupby("app").inn_pitches.cummax()
    per_inn = pa.groupby(["app", "inning"]).pitches.sum().rename("tot").reset_index()
    per_inn["prev_inn_pitches"] = per_inn.groupby("app").tot.shift(1)
    pa = pa.merge(per_inn[["app", "inning", "prev_inn_pitches"]], on=["app", "inning"], how="left")
    pa["prev_inn_pitches"] = pa.prev_inn_pitches.fillna(0)
    pa["outs_in_inn"] = np.where(pa.inning_end == 1, 0, (pa.outs0 + pa.outs_rec).clip(0, 2))
    pa["margin"] = pa.field0 - pa.score1
    reached = pa.hit + pa.walk
    pa["last3_reached"] = reached.groupby(pa.app).transform(lambda s: s.rolling(3, min_periods=1).sum())

    # ---- before the game ----
    apps = pa.groupby("app").agg(pitcher=("pitcher", "first"), date=("date", "first"), t0=("t0", "first"), season=("season", "first"),
                                 game_pk=("game_pk", "first"), field_team=("field_team", "first"), starter=("starter", "first"),
                                 pitches=("pitches", "sum"), outs=("outs_rec", "sum")).reset_index()
    apps = apps.sort_values(["pitcher", "t0"]).reset_index(drop=True)
    apps["day"] = (apps.date - pd.Timestamp("2000-01-01")).dt.days
    apps["days_rest"] = (apps.day - apps.groupby("pitcher").day.shift(1)).fillna(30).clip(upper=30)
    fat, p3, n3 = np.zeros(len(apps)), np.zeros(len(apps)), np.zeros(len(apps))
    for _, idx in apps.groupby("pitcher").indices.items():
        days, pitches = apps.day.to_numpy()[idx], apps.pitches.to_numpy()[idx]
        for j in range(len(idx)):
            k = j - 1
            while k >= 0 and days[j] - days[k] <= 5:
                dd = days[j] - days[k]
                fat[idx[j]] += pitches[k] * math.exp(-dd / TAU) if dd > 0 else pitches[k]
                if dd <= 3:
                    p3[idx[j]] += pitches[k]
                    n3[idx[j]] += 1
                k -= 1
    apps["fatigue"], apps["pitches_3d"], apps["apps_3d"] = fat, p3, n3
    st = apps[apps.starter == 1].copy()
    gs = st.groupby("pitcher").pitches
    st["max3"] = gs.transform(lambda s: s.shift(1).rolling(3, min_periods=1).max())
    st["max5"] = gs.transform(lambda s: s.shift(1).rolling(5, min_periods=1).max())
    st["mean3"] = gs.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean())
    st["starts_season"] = st.groupby(["pitcher", "season"]).cumcount()
    apps = apps.merge(st[["app", "max3", "max5", "mean3", "starts_season"]], on="app", how="left")
    tx = pd.read_parquet(proj / "interim" / "transactions.parquet", columns=["mlbam", "sport_id", "kind", "eff"])
    act = tx[(tx.kind == "il_activate") & (tx.sport_id == 1)].dropna(subset=["eff"])
    act = act.assign(day=(pd.to_datetime(act.eff) - pd.Timestamp("2000-01-01")).dt.days, mlbam=act.mlbam.astype("int64"))[["mlbam", "day"]]
    apps = apps.assign(pitcher=apps.pitcher.astype("int64")).sort_values("day")
    apps = pd.merge_asof(apps, act.sort_values("day").rename(columns={"mlbam": "pitcher", "day": "il_day"}), left_on="day",
                         right_on="il_day", by="pitcher", direction="backward")
    apps["days_since_il"] = (apps.day - apps.il_day).fillna(999).clip(upper=999)
    apps = apps.sort_values(["pitcher", "t0"]).reset_index(drop=True)
    apps["apps_since_il"] = np.where(apps.days_since_il < 999, apps.groupby(["pitcher", apps.il_day.fillna(-1)]).cumcount(), 99)
    tm = apps.sort_values("t0")
    s_only = tm[tm.starter == 1]
    s_only = s_only.assign(team_start_outs=s_only.groupby(["field_team", "season"]).outs.transform(lambda s: s.shift(1).expanding().mean()))
    apps = apps.merge(s_only[["game_pk", "field_team", "team_start_outs"]].drop_duplicates(["game_pk", "field_team"]),
                      on=["game_pk", "field_team"], how="left")
    pen = tm[tm.starter == 0].groupby(["field_team", "day"]).pitches.sum().reset_index()
    load = []
    for team, grp in pen.groupby("field_team"):
        s = grp.set_index("day").pitches
        for day in apps.loc[apps.field_team == team, "day"].unique():
            load.append((team, day, s[(s.index < day) & (s.index >= day - 3)].sum()))
    apps = apps.merge(pd.DataFrame(load, columns=["field_team", "day", "pen_load_3d"]), on=["field_team", "day"], how="left")
    keep = ["app", "days_rest", "fatigue", "pitches_3d", "apps_3d", "max3", "max5", "mean3", "starts_season",
            "days_since_il", "apps_since_il", "team_start_outs", "pen_load_3d"]
    pa = pa.drop(columns=["pitcher"]).merge(apps[keep + ["pitcher"]], on="app", how="left")
    return pa, apps


def flatten(booster):
    """The trees as flat arrays: a node's split feature, threshold, default-left, missing type (0 none, 1 zero,
    2 NaN) and children (a child below zero is leaf ~child); each tree's root."""
    feat, thr, dl, miss, left, right, leaf, roots = [], [], [], [], [], [], [], []
    miss_code = {"None": 0, "Zero": 1, "NaN": 2}

    def walk(node):
        if "leaf_value" in node:
            leaf.append(node["leaf_value"])
            return ~(len(leaf) - 1)
        i = len(feat)
        assert node["decision_type"] == "<=", node["decision_type"]
        feat.append(node["split_feature"])
        thr.append(node["threshold"])
        dl.append(int(node["default_left"]))
        miss.append(miss_code[node["missing_type"]])
        left.append(0)
        right.append(0)
        left[i] = walk(node["left_child"])
        right[i] = walk(node["right_child"])
        return i
    for t in booster.dump_model()["tree_info"]:
        roots.append(walk(t["tree_structure"]))
    return {"feat": feat, "thr": thr, "dl": dl, "miss": miss, "left": left, "right": right, "leaf": leaf, "roots": roots}


def main(season, proj):
    seasons = range(FIRST, season + 1)
    pa, apps = boundaries(proj, seasons)
    d = pa[~pa.censored & (pa.starter == 1)]
    model = lgb.LGBMClassifier(n_estimators=TREES, learning_rate=0.1, num_leaves=LEAVES, min_child_samples=200, subsample=0.8,
                               subsample_freq=1, colsample_bytree=0.8, verbose=-1, random_state=season)
    model.fit(d[FEATURES].astype(float), d.removed)
    trees = flatten(model.booster_)

    # pitches per PA by outcome, from this season's play-by-play categories
    cat_of = {}
    for g in pbp.load_games(season, CACHE):
        cols = {c: i for i, c in enumerate(g["play_cols"])}
        for p in g["plays"]:
            c = pbp.category(p[cols["event"]], p[cols["traj"]])
            if c:
                cat_of[(g["pk"], p[cols["ab"]])] = c
    cur = pd.read_parquet(proj / "raw" / "statfast" / "pitches" / f"mlb_{season}.parquet", columns=["game_pk", "at_bat_index"])
    n = cur.groupby(["game_pk", "at_bat_index"]).size()
    hist = {c: [0] * MAX_PITCHES for c in pbp.CATS}
    for (pk, ab), k in n.items():
        c = cat_of.get((pk, ab))
        if c:
            hist[c][min(k, MAX_PITCHES) - 1] += 1

    # before-the-game values for a typical start of his: the median, over his starts this season, of
    # what each went in with (the most pitches in his previous 3 and 5 starts, their mean, starts so far),
    # so a September cut-back or an early-season ramp-up doesn't stand for the whole year; his team
    s = apps[(apps.season == season) & (apps.starter == 1)].sort_values("t0")
    cur_starts = d[d.season == season]
    first_bound = cur_starts.groupby("app").first()
    med = first_bound.groupby("pitcher")[["max3", "max5", "mean3", "starts_season"]].median()
    lg = med[s.groupby("pitcher").size().reindex(med.index).fillna(0) >= 10].median()
    pitchers = {}
    for pid, grp in s.groupby("pitcher"):
        pc = grp.pitches.to_numpy()
        m = med.loc[pid] if pid in med.index else lg
        val = lambda k: round(float(m[k] if not pd.isna(m[k]) else lg[k]), 1)  # noqa: E731
        pitchers[str(pid)] = [val("max3"), val("max5"), val("mean3"), val("starts_season"),
                              grp.field_team.iloc[-1], round(float(pc.mean()), 1), round(float(grp.outs.mean()), 2), int(len(pc))]
    teams = {t: round(float(v), 3) for t, v in s.groupby("field_team").outs.mean().items()}
    league = {k: round(float(lg[k]), 1) for k in ("max3", "max5", "mean3", "starts_season")}
    league["team_start_outs"] = round(float(s.outs.mean()), 3)
    defaults = {"days_rest": 5, "fatigue": 0, "pitches_3d": 0, "apps_3d": 0, "days_since_il": 999, "apps_since_il": 99,
                "pen_load_3d": float(first_bound.pen_load_3d.median()), "season": season}
    rows = cur_starts.sample(40, random_state=1)
    checks = [{"x": [None if pd.isna(v) else float(v) for v in r], "p": float(p)}
              for r, p in zip(rows[FEATURES].itertuples(index=False), model.predict_proba(rows[FEATURES].astype(float))[:, 1])]
    # league runs per inning, for his team's side of the score (the simulation only plays one side)
    full = pas_of(proj, season)
    runs9 = float((full.score1 - full.score0).clip(lower=0)[full.inning <= 9].sum() / full[full.inning <= 9].groupby(["game_pk", "inning", "top"]).ngroups)

    out = {"season": season, "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "seasons": [FIRST, season], "boundaries": int(len(d)), "features": FEATURES, "trees": trees,
           "pitches": hist, "pitchers": pitchers, "teams": teams, "league": league, "defaults": defaults,
           "runs_per_inning": round(runs9, 4), "checks": checks}
    dest = REPO / "lineup-sims" / "data" / f"{season}-hook.json"
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    ppa = {c: round(sum((i + 1) * x for i, x in enumerate(h)) / max(sum(h), 1), 2) for c, h in hist.items()}
    print(f"{len(d):,} starter boundaries ({FIRST}-{season}), {d.removed.sum():,} hooks; {len(trees['leaf'])} leaves; "
          f"{len(pitchers)} {season} starters; runs per half-inning {runs9:.3f}")
    print("pitches per PA by outcome:", ppa)
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("season", type=int)
    ap.add_argument("--projections", type=pathlib.Path, required=True,
                    help="the projections project's data directory (read only)")
    args = ap.parse_args()
    main(args.season, args.projections)
