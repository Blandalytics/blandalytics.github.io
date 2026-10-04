"""Evaluate dml_swing_path.py output: out-of-time fit, hitter reliability, leakage, year over
year, and the hitter leaderboards.

    python evaluate.py --scored swing_path.parquet --season 2026 --out-board board.csv
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
from scipy.special import logit
from sklearn.metrics import roc_auc_score

STAGE_COLS = {"whiff": ("q_whiff", None), "foul": ("q_foul", "contact")}


def _ll(y, p) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.sum(y * np.log(p) + (1 - y) * np.log(1 - p)))


def out_of_time(oot: pd.DataFrame) -> pd.DataFrame:
    """Per stage and in total (the 3-class log loss splits exactly into the two stages):
    PLV alone, PLV + g(W), and + bat path; all swings and committed swings."""
    rows = []
    for sample, m in (("all swings", oot.index == oot.index), ("committed", ~oot["fooled"])):
        o = oot[m]
        n_swings = (o["stage"] == "whiff").sum()
        tot = {"PLV": 0.0, "PLV + g": 0.0, "+ path": 0.0}
        for stage, g in o.groupby("stage"):
            for name, col in (("PLV", "q"), ("PLV + g", "p_plvg"), ("+ path", "p_full")):
                ll = _ll(g["y"].to_numpy(), g[col].to_numpy())
                tot[name] += ll
                auc = roc_auc_score(g["y"], g[col])
                rows.append({"sample": sample, "stage": stage, "model": name, "n": len(g),
                             "log_loss": ll / len(g), "auc": auc})  # fmt: skip
        for name, ll in tot.items():
            rows.append({"sample": sample, "stage": "3-class", "model": name, "n": n_swings,
                         "log_loss": ll / n_swings, "auc": np.nan})  # fmt: skip
    return pd.DataFrame(rows)


def hitter_seasons(s: pd.DataFrame) -> pd.DataFrame:
    """Per batter-season: path scores (mean log-odds effect over committed swings, signed so +
    is good for the hitter), observed vs PLV in log-odds, fooled share, mean location."""
    c = s[~s["fooled"]]
    k = ["batter", "season"]
    out = s.groupby(k).agg(name=("player_name", "first"), swings=("whiff", "size"),
                           whiff=("whiff", "mean"), q_whiff=("q_whiff", "mean"),
                           fooled=("fooled", "mean"), x_in=("x_in", "mean"),
                           z_n=("z_n", "mean"),
                           plv_logit=("q_whiff", lambda q: logit(q).mean()))  # fmt: skip
    out["contact_added"] = -c.groupby(k)["lo_whiff"].mean()
    out["committed"] = c.groupby(k).size()
    con = s[s["contact"]]
    out["foul_rate"] = con.groupby(k)["foul"].mean()
    out["q_foul"] = con.groupby(k)["q_foul"].mean()
    out["inplay_added"] = -c[c["contact"]].groupby(k)["lo_foul"].mean()
    out["contact_vs_plv"] = -(logit(out["whiff"]) - logit(out["q_whiff"]))
    out["inplay_vs_plv"] = -(logit(out["foul_rate"]) - logit(out["q_foul"]))
    return out.reset_index()


def split_half(s: pd.DataFrame, col: str, sign: int, sub=None, min_n: int = 50) -> float:
    """Spearman-Brown split-half reliability over hitter-seasons, halves by game parity."""
    d = s[~s["fooled"]]
    if sub:
        d = d[d[sub]]
    h = d.assign(half=d["game_pk"] % 2).groupby(["batter", "season", "half"])[col]
    g = h.agg(["mean", "size"]).unstack()
    g = g[(g["size"] >= min_n).all(axis=1)]
    r = (sign * g["mean"][0]).corr(sign * g["mean"][1])
    return 2 * r / (1 + r)


def _wcorr(x, y, w) -> float:
    mx, my = np.average(x, weights=w), np.average(y, weights=w)
    cov = np.average((x - mx) * (y - my), weights=w)
    return cov / np.sqrt(
        np.average((x - mx) ** 2, weights=w) * np.average((y - my) ** 2, weights=w)
    )


def year_over_year(h: pd.DataFrame, target: str, predictors: list[str]) -> pd.DataFrame:
    """Season Y predictors against season Y+1 `target`, by the smaller season's swings,
    weighted by the harmonic mean of swings."""
    nxt = h.assign(season=h["season"] - 1).set_index(["batter", "season"])
    pairs = h.set_index(["batter", "season"]).join(nxt[[target, "swings"]], rsuffix="_next",
                                                   how="inner")  # fmt: skip
    n = np.minimum(pairs["swings"], pairs["swings_next"])
    w = 2 / (1 / pairs["swings"] + 1 / pairs["swings_next"])
    rows = []
    for lo, hi in ((100, 250), (250, 500), (500, 5000), (100, 5000)):
        m = (n >= lo) & (n < hi)
        row = {"swings": f"{lo}-{hi if hi < 5000 else ''}", "pairs": int(m.sum())}
        for p in predictors:
            row[p] = _wcorr(pairs.loc[m, p], pairs.loc[m, f"{target}_next"], w[m])
        rows.append(row)
    return pd.DataFrame(rows)


def _table(title: str, df: pd.DataFrame) -> None:
    print(title)
    print(df.round(3).to_string(index=False))


def report_fit(scored: str) -> None:
    """Out-of-time pitch-level fit and the per-count slopes."""
    _table(
        "2026 out of time", out_of_time(pd.read_parquet(scored.replace(".parquet", "_oot.parquet")))
    )
    with open(scored.replace(".parquet", "_theta.json")) as f:
        for k, v in json.load(f).items():
            th, se = np.round(v["theta"], 2), np.round(v["se"], 3)
            print(f"{k}: theta {th} se {se} lambda {v['lambda']:.3g}")


def report_hitters(s: pd.DataFrame, h: pd.DataFrame, q: pd.DataFrame) -> None:
    """Spread, reliability, leakage and same-season agreement of the hitter scores."""
    cols = ["contact_added", "inplay_added"]
    print(f"hitter-seasons {len(q)}; SD {q[cols].std().round(3).to_dict()}")
    flag = s.assign(fooled=False, f=s["fooled"].astype(float))
    rel = {"contact": split_half(s, "lo_whiff", -1),
           "in play": split_half(s, "lo_foul", -1, "contact"),
           "fooled": split_half(flag, "f", 1)}  # fmt: skip
    print("split-half reliability", {k: round(v, 3) for k, v in rel.items()})
    for w in ("x_in", "z_n", "plv_logit"):
        print(f"leakage r with {w}: {q[cols].corrwith(q[w]).round(2).to_dict()}")
    same = {
        c: round(q[c].corr(q[v]), 2)
        for c, v in zip(cols, ["contact_vs_plv", "inplay_vs_plv"], strict=True)
    }
    print(f"same-season r with observed vs PLV: {same}")


def report_yoy(h: pd.DataFrame) -> None:
    preds = {"contact_vs_plv": ["contact_added", "contact_vs_plv", "whiff"],
             "inplay_vs_plv": ["inplay_added", "inplay_vs_plv", "foul_rate"],
             "contact_added": ["contact_added"], "inplay_added": ["inplay_added"],
             "fooled": ["fooled"]}  # fmt: skip
    for target, p in preds.items():
        _table(f"year over year, target next {target}", year_over_year(h, target, p))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scored", required=True)
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--min-swings", type=int, default=200)
    ap.add_argument("--out-board", required=True)
    a = ap.parse_args()
    pd.set_option("display.width", 200)
    s = pd.read_parquet(a.scored)
    report_fit(a.scored)
    h = hitter_seasons(s)
    q = h[h["swings"] >= a.min_swings]
    report_hitters(s, h, q)
    report_yoy(h)
    q[q["season"] == a.season].sort_values("contact_added", ascending=False).to_csv(
        a.out_board, index=False
    )


if __name__ == "__main__":
    main()
