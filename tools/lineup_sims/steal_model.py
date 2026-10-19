"""Stolen bases for the Game Sim: who runs, and who gets thrown out, by runner, pitcher and catcher.

    python -I pipeline/steal_model.py 2026 <running-game parquet>

The parquet is the stolen_bases project's pull (mlb_running_game.scrape_running_game, regular
season): one row per steal opportunity, a runner on a base with the next one open, with the
runner, the pitcher and the catcher. Only opportunities that were there when the plate
appearance began count (the sim decides steals as each plate appearance starts), innings 1-9.

Two logistic models, each with the runner, the pitcher and the catcher as ridge-shrunk effects
(one-hot columns scaled so each group gets its own shrinkage, picked on games after July 1 with
the models fit on the games before):

  * attempt: does the runner try for the next base (SB, CS, or picked off while breaking)?
    Context: the bases and target (1st with 3rd open or taken, ...) by outs, the score from the
    running team's side (-4 to +4, capped), the pitcher's hand.
  * success: given an attempt, a stolen base? Context: target and outs, the pitcher's hand.

The sim's league running game (data/<season>.json "running") is split, from the same cached
play-by-play the main data file is built from, into
  * "other": the running phase of plate appearances without one of those attempts (wild
    pitches, passed balls, balks, pickoffs, ...), by base-out state, and
  * "after": the whole running phase of plate appearances with one, by bases, target and
    result (so double steals, runners trailing along and throwing errors come with it).
A pooled lineup spot (or bullpen, or MLB-average starter, or MLB-average catcher) gets the one
shift that gives its 2026 opportunities as many attempts, and those attempts as many steals, as
its players' own effects do (so a few fast runners don't count for more than they ran). Writes
site/data/<season>-steal.json.
"""
import collections
import json
import math
import pathlib
import sys

import numpy as np
import pandas as pd
import scipy.sparse as sp
from sklearn.linear_model import LogisticRegression

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import pbp  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPLIT = "-07-01"           # validation: fit before, score after
TARGET = {1: "2B", 2: "3B", 3: "H"}
ATTEMPT_EVENTS = ("stolen_base_", "caught_stealing_", "pickoff_caught_stealing_")
DIFF = 4                   # run differential capped at +-4
CTX_SCALE = 3.0            # context columns: next to no shrinkage (thousands of rows each)


def opp_cell(mask, base, outs):
    return f"{mask},{TARGET[base]},{outs}"


def plays_and_states(season):
    """From the cached play-by-play: each plate appearance's base-out state and the running
    phase's code, whether a runner who had an opportunity when it began tried to steal (and
    which base, and whether he made it), each game's two starters, and its batting orders."""
    rows, starters, orders = [], set(), {}
    for g in pbp.load_games(season, ROOT):
        orders[g["pk"]] = g["order"]
        raw = {p[0]: p for p in g["plays"]}
        first = {}
        for p in g["plays"]:
            first.setdefault(p[2], p[6])
        starters.update((g["pk"], pid) for pid in first.values())
        for r in pbp.replay(g):
            if "skip" in r or r["inning"] > 9:
                continue
            mask, outs = r["state0"]
            p = raw[r["ab"]]
            runners = [m for m in p[14] if not (m[6] == "r_runner_placed" or (m[1] is None and m[0] != p[5]))]
            last = p[10]
            pre = runners if not r["is_pa"] else ([] if last is None else [m for m in runners if m[4] is not None and m[4] < last])
            att = None
            for m in sorted(pre, key=lambda m: m[4] if m[4] is not None else -1):
                if m[5] and m[5].startswith(ATTEMPT_EVENTS) and m[1] in pbp.BASE:
                    b = pbp.BASE[m[1]]
                    # an opportunity when the plate appearance began: on base, the next one open
                    if mask >> (b - 1) & 1 and (b == 3 or not mask >> b & 1):
                        att = (b, m[5].startswith("stolen_base_") and not m[3])
                    break
            rows.append({"game_pk": g["pk"], "ab": r["ab"], "mask": mask, "outs": outs, "code": r["run_code"], "att": att, "is_pa": r["is_pa"]})
    return pd.DataFrame(rows), starters, orders


def design(df, groups, scales, ctx_cols):
    """Sparse one-hot design: context columns, then each group's ids (scaled)."""
    blocks, names = [], []
    for col in ctx_cols:
        cats = sorted(df[col].unique())
        idx = {c: i for i, c in enumerate(cats)}
        m = sp.csr_matrix((np.full(len(df), CTX_SCALE), (np.arange(len(df)), df[col].map(idx).to_numpy())), shape=(len(df), len(cats)))
        blocks.append(m)
        names += [(col, c, CTX_SCALE) for c in cats]
    for g, ids in groups.items():
        idx = {c: i for i, c in enumerate(ids)}
        j = df[g].map(idx)
        ok = j.notna().to_numpy()
        m = sp.csr_matrix((np.full(ok.sum(), scales[g]), (np.arange(len(df))[ok], j[ok].astype(int).to_numpy())), shape=(len(df), len(ids)))
        blocks.append(m)
        names += [(g, c, scales[g]) for c in ids]
    return sp.hstack(blocks).tocsr(), names


def fit(df, y, groups, scales, ctx_cols):
    X, names = design(df, groups, scales, ctx_cols)
    m = LogisticRegression(C=1.0, max_iter=10000, tol=1e-6)
    m.fit(X, y)
    return m, names


def logloss(m, X, y):
    p = np.clip(m.predict_proba(X)[:, 1], 1e-9, 1 - 1e-9)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def tune(df, ycol, ctx_cols, label):
    """Each group's scale on held-out games (coordinate search), then a fit on every game."""
    groups = {g: sorted(df[g].dropna().unique()) for g in ("runner", "pitcher", "catcher")}
    train, test = df[df.game_date < df.season_str + SPLIT], df[df.game_date >= df.season_str + SPLIT]
    y_tr, y_te = train[ycol].to_numpy().astype(int), test[ycol].to_numpy().astype(int)

    def score(sc):
        m, _ = fit(train, y_tr, groups, sc, ctx_cols)
        X, _ = design(test, groups, sc, ctx_cols)
        return logloss(m, X, y_te)

    base = score({g: 1e-6 for g in groups})
    sc = {g: 0.5 for g in groups}
    best = score(sc)
    grid = [0.0, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0]
    for _ in range(2):
        for g in groups:
            for v in grid:
                trial = dict(sc, **{g: max(v, 1e-6)})
                s = score(trial)
                if s < best - 1e-7:
                    best, sc = s, trial
    print(f"{label}: held-out log loss {best:.5f} vs context only {base:.5f} "
          f"({1000 * (base - best):+.2f} milli-nats per row, {len(test):,} rows); scales {sc}")
    m, names = fit(df, df[ycol].to_numpy().astype(int), groups, sc, ctx_cols)
    coef = m.coef_[0]
    eff = {}
    for (g, c, s), w in zip(names, coef):
        eff.setdefault(g, {})[c] = float(w * s)
    return float(m.intercept_[0]), eff, {"scales": sc, "logloss": best, "context_only": base, "test_rows": len(test)}


def main(season, parquet):
    season = int(season)
    data = json.loads((ROOT / "site" / "data" / f"{season}.json").read_text(encoding="utf-8"))
    abbr_of = {t["name"]: t["abbr"] for t in data["teams"]}
    # the Stats API's full names; the data file's are short in places (Athletics)
    for t in data["teams"]:
        abbr_of.setdefault(t["short"], t["abbr"])

    plays, starters, orders = plays_and_states(season)
    state_of = {(r.game_pk, r.ab): (r.mask, r.outs, r.is_pa) for r in plays.itertuples()}

    raw = pd.read_parquet(parquet)
    raw = raw[(raw.game_type == "R") & raw.opportunity_row & raw.opportunity_at_pa_start & (raw.inning <= 9)].copy()
    raw["ab"] = raw.at_bat_number - 1
    st = [state_of.get(k) for k in zip(raw.game_pk, raw.ab)]
    raw["mask"] = [s[0] if s else None for s in st]
    raw["is_pa"] = [bool(s[2]) if s else True for s in st]
    raw = raw[raw["mask"].notna()].copy()
    raw["mask"] = raw["mask"].astype(int)
    raw["base"] = raw.from_base.map({"1B": 1, "2B": 2, "3B": 3})
    # the replay's state must give this runner his opportunity
    ok = np.array([bool(m >> (b - 1) & 1) and (b == 3 or not m >> b & 1) for m, b in zip(raw["mask"], raw["base"])])
    dropped = len(raw) - sum(ok)
    raw = raw[ok].copy()
    raw["cell"] = [opp_cell(m, b, o) for m, b, o in zip(raw["mask"], raw["base"], raw.outs_at_pa_start)]
    raw["diff"] = raw.run_diff.clip(-DIFF, DIFF).astype(int)
    raw["hand"] = raw.p_throws.fillna("R")
    raw["tcell"] = [f"{TARGET[b]},{o}" for b, o in zip(raw["base"], raw.outs_at_pa_start)]
    raw["runner"], raw["pitcher"], raw["catcher"] = raw.runner_id, raw.pitcher_id, raw.catcher_id
    # a steal on the pitch that ended the plate appearance (a strikeout and a runner thrown out, say) is
    # in the main data's batter-outcome table already, so it isn't one of these attempts; one that ended
    # the inning before the batter finished is
    final = raw.event_on_pitch.fillna(False).astype(bool) & (raw.pitch_number == raw.pa_pitch_count) & raw.is_pa
    raw["y_att"] = raw.advance_attempted.fillna(False).astype(bool) & ~final
    raw["y_sb"] = raw.official_sb.fillna(False).astype(bool) & raw.y_att
    raw["season_str"] = str(season)
    raw["relief"] = [(g, p) not in starters for g, p in zip(raw.game_pk, raw.pitcher_id)]
    raw["team"] = raw.run_team.map(abbr_of)
    raw["dteam"] = raw.def_team.map(abbr_of)
    # the catcher's spot in his team's batting order (0: not in it, as when he came in for a pinch hitter's spot late)
    raw["cspot"] = [int(orders[g]["home" if d == h else "away"].get(str(c), "0")) // 100
                    for g, d, h, c in zip(raw.game_pk, raw.def_team, raw.home_team, raw.catcher_id)]
    print(f"{len(raw):,} opportunities at the start of a plate appearance, innings 1-9 ({dropped} off the replay's state); "
          f"{int(raw.y_att.sum()):,} attempts, {int(raw.y_sb.sum()):,} SB")
    if raw.team.isna().any() or raw.dteam.isna().any():
        raise SystemExit(f"unmatched teams: {set(raw.run_team[raw.team.isna()]) | set(raw.def_team[raw.dteam.isna()])}")

    a0, att, att_fit = tune(raw, "y_att", ["cell", "diff", "hand"], "attempt")
    tries = raw[raw.y_att].copy()
    s0, suc, suc_fit = tune(tries, "y_sb", ["tcell", "hand"], "success")

    def g(eff, grp, k):
        return eff.get(grp, {}).get(k, 0.0)

    # context as logits: intercept + cell (+ diff) ; hand goes with the pitcher
    ctx_att = {c: a0 + g(att, "cell", c) for c in sorted(raw.cell.unique())}
    diff_att = [g(att, "diff", d) for d in range(-DIFF, DIFF + 1)]
    ctx_suc = {c: s0 + g(suc, "tcell", c) for c in sorted(tries.tcell.unique())}
    hand = {h: [g(att, "hand", h), g(suc, "hand", h)] for h in ("R", "L")}
    r4 = lambda x: round(x, 4)  # noqa: E731

    # every opportunity's attempt and success logits, by part
    eff = lambda e, grp, col: np.array([g(e, grp, k) for k in raw[col]])  # noqa: E731
    part = {
        "runner": (eff(att, "runner", "runner"), eff(suc, "runner", "runner")),
        "pitcher": (eff(att, "pitcher", "pitcher") + raw.hand.map(lambda h: hand[h][0]).to_numpy(),
                    eff(suc, "pitcher", "pitcher") + raw.hand.map(lambda h: hand[h][1]).to_numpy()),
        "catcher": (eff(att, "catcher", "catcher"), eff(suc, "catcher", "catcher")),
    }
    la = raw.cell.map(ctx_att).to_numpy() + raw["diff"].map(lambda d: diff_att[d + DIFF]).to_numpy() + sum(v[0] for v in part.values())
    ls = raw.tcell.map(lambda c: ctx_suc.get(c, s0)).to_numpy() + sum(v[1] for v in part.values())
    sig = lambda x: 1 / (1 + np.exp(-x))  # noqa: E731

    def solve(rest, target, w):
        lo, hi = -10.0, 10.0
        for _ in range(60):
            mid = (lo + hi) / 2
            if (w * sig(rest + mid)).sum() < target:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    def mix(rows, grp):
        """The one [attempt, success] shift for these opportunities in place of each one's own `grp`
        effect: as many attempts, and those as many steals, as the players' own effects give."""
        i = np.flatnonzero(rows)
        pa, ps = part[grp][0][i], part[grp][1][i]
        a, sv = la[i], ls[i]
        da = solve(a - pa, sig(a).sum(), np.ones(len(i)))
        w = sig(a)
        ds = solve(sv - ps, (w * sig(sv)).sum(), w)
        return [r4(da), r4(ds)]

    runners = {int(k): [r4(g(att, "runner", k)), r4(g(suc, "runner", k))] for k in raw.runner.unique()}
    runners = {k: v for k, v in runners.items() if v != [0.0, 0.0]}
    spots = {}
    for team, spot in raw.groupby(["team", "runner_lineup_spot"]).size().index:
        spots[f"{team}-{int(spot)}"] = mix((raw.team == team) & (raw.runner_lineup_spot == spot), "runner")
    for spot in sorted(raw.runner_lineup_spot.unique()):
        spots[f"MLB-{int(spot)}"] = mix(raw.runner_lineup_spot == spot, "runner")
    # a pitcher's effects with his hand's in them (a pitcher not here: his hand's alone)
    pitchers = {int(k): [r4(g(att, "pitcher", k) + hand[h][0]), r4(g(suc, "pitcher", k) + hand[h][1])]
                for k, h in raw.groupby("pitcher").hand.first().items()}
    pens = {team: mix(raw.relief & (raw.dteam == team), "pitcher") for team in sorted(raw.dteam.unique())}
    pens["MLB"] = mix(raw.relief, "pitcher")
    # an MLB-average RHP or LHP starting, and an MLB-average catcher
    starter_avg = {h: mix(~raw.relief & (raw.hand == h), "pitcher") for h in ("R", "L")}
    catcher_avg = mix(np.ones(len(raw), dtype=bool), "catcher")
    # a lineup spot catching: the catchers who batted there, pooled, with the share of the team's
    # opportunities caught from that spot (MLB: every team's)
    cspots = {}
    for team in [*sorted(raw.dteam.unique()), "MLB"]:
        mine = raw.cspot > 0 if team == "MLB" else (raw.dteam == team) & (raw.cspot > 0)
        n = int(mine.sum())
        for spot in sorted(raw.cspot[mine].unique()):
            rows = mine & (raw.cspot == spot)
            cspots[f"{team}-{int(spot)}"] = [*mix(rows, "catcher"), round(int(rows.sum()) / n, 4)]
    catchers = {}
    for k, df in raw.groupby("catcher"):
        teams = df.dteam.value_counts()
        catchers[int(k)] = [r4(g(att, "catcher", k)), r4(g(suc, "catcher", k)), df.catcher_name.iloc[0], teams.index[0], int(len(df))]

    # the running phase, split by attempts
    other = collections.defaultdict(collections.Counter)
    after = collections.defaultdict(collections.Counter)
    for r in plays.itertuples():
        if not r.mask:
            continue
        if r.att is None:
            other[f"{r.mask},{r.outs}"][r.code] += 1
        else:
            after[f"{r.mask},{TARGET[r.att[0]]},{int(r.att[1])}"][r.code] += 1
    n_att = sum(sum(c.values()) for c in after.values())
    n_sb = sum(sum(c.values()) for k, c in after.items() if k.endswith(",1"))
    print(f"play-by-play: {n_att:,} attempts at the start of a plate appearance ({n_sb:,} safe) against the parquet's "
          f"{int(raw.y_att.sum()):,} ({int(raw.y_sb.sum()):,})")

    out = {
        "season": season,
        "rows": int(len(raw)),
        "fit": {"attempt": att_fit, "success": suc_fit},
        "att": {"cells": {k: r4(v) for k, v in ctx_att.items()}, "diff": [r4(x) for x in diff_att]},
        "suc": {"cells": {k: r4(v) for k, v in ctx_suc.items()}},
        "hand": {k: [r4(x) for x in v] for k, v in hand.items()},
        "starter_avg": starter_avg, "catcher_avg": catcher_avg, "cspots": cspots,
        "runners": runners, "spots": spots, "pitchers": pitchers, "pens": pens, "catchers": catchers,
        "other": {k: sorted(c.items(), key=lambda kv: -kv[1]) for k, c in sorted(other.items())},
        "after": {k: sorted(c.items(), key=lambda kv: -kv[1]) for k, c in sorted(after.items())},
        "actual": {"SB": int((raw.y_sb).sum()), "CS": int((raw.y_att & ~raw.y_sb).sum()),
                   "team_games": int(2 * raw.game_pk.nunique())},
    }
    dest = ROOT / "site" / "data" / f"{season}-steal.json"
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size / 1024:.0f} KB): {len(runners)} runners, {len(pitchers)} pitchers, {len(catchers)} catchers")

    # who stands out
    names = dict(zip(raw.runner_id, raw.runner_name)) | dict(zip(raw.pitcher_id, raw.pitcher_name))
    for grp, lab in (("runner", "runners"), ("pitcher", "pitchers"), ("catcher", "catchers")):
        top = sorted(att.get(grp, {}).items(), key=lambda kv: -kv[1])
        cn = dict(zip(raw.catcher_id, raw.catcher_name))
        nm = lambda k: (cn if grp == "catcher" else names).get(k, k)  # noqa: E731
        print(f"attempt odds, {lab}: most " + ", ".join(f"{nm(k)} {math.exp(v):.2f}x" for k, v in top[:4])
              + "; least " + ", ".join(f"{nm(k)} {math.exp(v):.2f}x" for k, v in top[-3:]))
        top = sorted(suc.get(grp, {}).items(), key=lambda kv: -kv[1])
        print(f"success odds, {lab}: most " + ", ".join(f"{nm(k)} {math.exp(v):.2f}x" for k, v in top[:4])
              + "; least " + ", ".join(f"{nm(k)} {math.exp(v):.2f}x" for k, v in top[-3:]))


if __name__ == "__main__":
    main(*sys.argv[1:3])
