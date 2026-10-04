"""Evaluate dml_swing_path.py output: out-of-time fit, hitter reliability, leakage, year over
year, and the hitter leaderboard.

    python evaluate.py --scored pooled.parquet [--neutral neutral.parquet] --out-board board.csv
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
from scipy.special import logit
from sklearn.metrics import roc_auc_score

PREDS = (("PLV", "q"), ("PLV + g", "plvg"), ("+ path", "full"))
SCORES = {  # hitter score: (per-swing column, sign so + is good for the hitter, sample)
    "contact_added": ("lo_whiff", -1, None),
    "inplay_added": ("lo_foul", -1, "contact"),
    "damage_added": ("lo_damage", 1, "bip"),
}
KEYS = ["batter", "season", "stand"]  # a switch hitter is two units per season, one per side
VS_PLV = {"contact_added": "contact_vs_plv", "inplay_added": "inplay_vs_plv",
          "damage_added": "xwobacon_vs_plv"}  # fmt: skip


def _ll(y, p) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.sum(y * np.log(p) + (1 - y) * np.log(1 - p)))


def _logit_rows(o: pd.DataFrame, sample: str) -> tuple[list[dict], dict]:
    rows, tot = [], dict.fromkeys(dict(PREDS), 0.0)
    for stage in ("whiff", "foul"):
        g = o[o["stage"] == stage]
        for name, col in PREDS:
            ll = _ll(g["y"].to_numpy(), g[col].to_numpy())
            tot[name] += ll
            auc = roc_auc_score(g["y"], g[col])
            rows.append({"sample": sample, "stage": stage, "model": name, "n": len(g),
                         "loss": ll / len(g), "auc_or_r2": auc})  # fmt: skip
    return rows, tot


def _damage_rows(o: pd.DataFrame, sample: str) -> list[dict]:
    g = o[o["stage"] == "damage"]
    rows = []
    for name, col in PREDS:
        mse = ((g["y"] - g[col]) ** 2).mean()
        rows.append({"sample": sample, "stage": "damage (MSE, R2)", "model": name, "n": len(g),
                     "loss": mse, "auc_or_r2": 1 - mse / g["y"].var(ddof=0)})  # fmt: skip
    return rows


def out_of_time(oot: pd.DataFrame) -> pd.DataFrame:
    """Per stage, PLV alone, PLV + g(W) and + bat path, on all and on committed swings. The
    3-class log loss splits exactly into the two logit stages."""
    rows = []
    for sample, m in (("all", oot.index == oot.index), ("committed", ~oot["fooled"])):
        o = oot[m]
        r, tot = _logit_rows(o, sample)
        n = (o["stage"] == "whiff").sum()
        rows += r + [{"sample": sample, "stage": "3-class", "model": k, "n": n, "loss": v / n,
                      "auc_or_r2": np.nan} for k, v in tot.items()]  # fmt: skip
        rows += _damage_rows(o, sample)
    return pd.DataFrame(rows)


def hitter_seasons(s: pd.DataFrame) -> pd.DataFrame:
    """Per batter-season-hand: the path scores (mean effect over committed swings in each stage's
    sample, + = good for the hitter), observed vs PLV, fooled share and mean location."""
    k = KEYS
    out = s.groupby(k).agg(name=("player_name", "first"), swings=("whiff", "size"),
                           whiff=("whiff", "mean"), q_whiff=("q_whiff", "mean"),
                           fooled=("fooled", "mean"), x_in=("x_in", "mean"),
                           z_n=("z_n", "mean"),
                           plv_logit=("q_whiff", lambda q: logit(q).mean()))  # fmt: skip
    c = s[~s["fooled"]]
    for name, (col, sign, sub) in SCORES.items():
        d = c[c[sub]] if sub else c
        out[name] = sign * d.groupby(k)[col].mean()
    con, bip = s[s["contact"]], s[s["bip"]]
    out["contact_vs_plv"] = -(logit(out["whiff"]) - logit(out["q_whiff"]))
    foul, q_foul = con.groupby(k)["foul"].mean(), con.groupby(k)["q_foul"].mean()
    out["inplay_vs_plv"] = -(logit(foul) - logit(q_foul))
    out["bip"] = bip.groupby(k).size()
    out["xwobacon_vs_plv"] = bip.groupby(k)["x_wobacon"].mean() - bip.groupby(k)["q_wobacon"].mean()
    return out.reset_index()


def add_neutral(h: pd.DataFrame, neutral: pd.DataFrame) -> pd.DataFrame:
    """Hitter means of the location-neutral probabilities, over committed swings."""
    n = neutral[~neutral["fooled"]].groupby(KEYS)
    cols = ["p_whiff_path", "p_foul_path", "p_in_play_path", "wobacon_path", "xwhiff_plus"]
    return h.join(n[cols].mean(), on=KEYS)


def split_half(s: pd.DataFrame, col: str, sign: int, sub=None, min_n: int = 50) -> float:
    """Spearman-Brown split-half reliability over hitter-seasons, halves by game parity."""
    d = s[~s["fooled"]]
    d = d[d[sub]] if sub else d
    g = d.assign(half=d["game_pk"] % 2).groupby([*KEYS, "half"])[col]
    g = g.agg(["mean", "size"]).unstack()
    g = g[(g["size"] >= min_n).all(axis=1)]
    r = (sign * g["mean"][0]).corr(sign * g["mean"][1])
    return 2 * r / (1 + r)


def _wcorr(x, y, w) -> float:
    mx, my = np.average(x, weights=w), np.average(y, weights=w)
    cov = np.average((x - mx) * (y - my), weights=w)
    return cov / np.sqrt(
        np.average((x - mx) ** 2, weights=w) * np.average((y - my) ** 2, weights=w)
    )


def year_over_year(h: pd.DataFrame, target: str, predictors: list[str], n: str = "swings"):
    """Season Y predictors against season Y+1 `target`, by the smaller season's sample,
    weighted by the harmonic mean of the two samples."""
    nxt = h.assign(season=h["season"] - 1).set_index(KEYS)
    pairs = h.set_index(KEYS).join(nxt[[target, n]], rsuffix="_next", how="inner")
    pairs = pairs.dropna(subset=[*predictors, f"{target}_next"])
    small = np.minimum(pairs[n], pairs[f"{n}_next"])
    w = 2 / (1 / pairs[n] + 1 / pairs[f"{n}_next"])
    rows = []
    for lo, hi in ((100, 250), (250, 500), (500, 5000), (100, 5000)):
        m = (small >= lo) & (small < hi)
        row = {n: f"{lo}-{hi if hi < 5000 else ''}", "pairs": int(m.sum())}
        for p in predictors:
            row[p] = _wcorr(pairs.loc[m, p], pairs.loc[m, f"{target}_next"], w[m])
        rows.append(row)
    return pd.DataFrame(rows)


def _table(title: str, df: pd.DataFrame) -> None:
    print(title)
    print(df.round(4).to_string(index=False))


def report_fit(scored: str) -> None:
    """Out-of-time fit and the per-count slopes."""
    oot = pd.read_parquet(scored.replace(".parquet", "_oot.parquet"))
    _table("2026 out of time", out_of_time(oot))
    with open(scored.replace(".parquet", "_theta.json")) as f:
        for k, v in json.load(f).items():
            th, se = np.round(v["theta"], 2), np.round(v["se"], 3)
            print(f"{k}: theta {th} se {se} lambda {v['lambda']:.3g}")


def report_hitters(s: pd.DataFrame, q: pd.DataFrame) -> None:
    """Spread, reliability, leakage and same-season agreement of the hitter scores."""
    cols = [c for c in [*SCORES, "p_whiff_path", "xwhiff_plus"] if c in q]
    print(f"hitter-seasons {len(q)}; SD {q[cols].std().round(4).to_dict()}")
    rel = {name: split_half(s, col, sign, sub) for name, (col, sign, sub) in SCORES.items()}
    rel["fooled"] = split_half(s.assign(fooled=False, f=s["fooled"].astype(float)), "f", 1)
    print("split-half reliability", {k: round(v, 3) for k, v in rel.items()})
    for w in ("x_in", "z_n", "plv_logit"):
        print(f"leakage r with {w}: {q[cols].corrwith(q[w]).round(2).to_dict()}")
    same = {c: round(q[c].corr(q[v]), 2) for c, v in VS_PLV.items()}
    print(f"same-season r with observed vs PLV: {same}")
    if "p_whiff_path" in q:
        print(f"r(contact_added, -p_whiff_path) {q['contact_added'].corr(-q['p_whiff_path']):.3f}")


def report_yoy(h: pd.DataFrame) -> None:
    for name, target in VS_PLV.items():
        n = "bip" if name == "damage_added" else "swings"
        preds = [name, target] + (["p_whiff_path"] if "p_whiff_path" in h and n == "swings" else [])
        _table(f"year over year, target next {target}", year_over_year(h, target, preds, n))
        _table(f"year over year, {name} with itself", year_over_year(h, name, [name], n))
    _table("year over year, fooled", year_over_year(h, "fooled", ["fooled"]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scored", required=True)
    ap.add_argument("--neutral", help="neutral.py output")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--min-swings", type=int, default=200)
    ap.add_argument("--out-board", required=True)
    a = ap.parse_args()
    pd.set_option("display.width", 200)
    s = pd.read_parquet(a.scored)
    report_fit(a.scored)
    h = hitter_seasons(s)
    if a.neutral:
        h = add_neutral(h, pd.read_parquet(a.neutral))
    q = h[h["swings"] >= a.min_swings]
    report_hitters(s, q)
    report_yoy(h)
    board = q[q["season"] == a.season].sort_values("contact_added", ascending=False)
    board.to_csv(a.out_board, index=False)


if __name__ == "__main__":
    main()
