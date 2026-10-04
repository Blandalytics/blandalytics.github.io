"""Pitcher K%, BB%, Hit% and PA per inning from per-pitch outcome rates.

Every pitch a pitcher throws ends in one of nine outcomes; the share of his pitches
in each is his outcome profile:

    ball      ball, ball in dirt, pitchout, hit by pitch
    called    called strike
    swstr     swinging strike (blocked or not), missed bunt, foul tip, swinging pitchout
    foul      foul, foul bunt
    out       in play, not a hit (outs, errors, fielder's choices, sacrifices)
    1b 2b 3b hr   in play, a hit of that kind

Each season gets its own fit: one row per pitcher-season (regular season only),
weighted by batters faced (--weight none counts every row the same), on the shares and
the stat as deviations from that season's (weighted) league average:

    stat - season avg = sum_k  coef_k * (share_k - season avg share_k)

A pitcher's prediction is the season's average plus his deviations times the
coefficients, and anything else on the same scale -- a pitch model's outcome
probabilities, say -- is predicted against its own average the same way. Within one
weighted season this is the same fit as the uncentered one with no intercept (the
shares sum to one, so the nine coefficients carry the intercept), and the coefficients
are reported in that form: the stat a pitcher would post if every pitch he threw had
that outcome. Each season is checked against the next with the earlier season's
coefficients and the later season's averages.

    K%      strikeouts / batters faced
    BB%     walks (intentional ones included) / batters faced
    Hit%    hits / batters faced
    PA/IP   batters faced / (outs recorded / 3)

Reads the completed-games Parquet in the bucket (see tools/data). Automatic
intentional walks throw no pitch, so they are not in the pitch data and count
neither as a walk nor as a batter faced.

    python tools/outcome_rates/fit.py                         # 2023-2026, results to stdout
    python tools/outcome_rates/fit.py --weight none           # every pitcher-season the same
    python tools/outcome_rates/fit.py --cache /tmp/mlb --json tools/outcome_rates/models.json
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import requests

DATA_URL = "https://data.blandalytics.com/"
MANIFEST_URL = DATA_URL + "data/manifest.json"

COLUMNS = ["game_pk", "game_type", "at_bat_index", "inning", "is_top_inning", "pitcher",
           "pitcher_name", "events", "call_code", "is_in_play", "outs",
           "post_home_score", "post_away_score"]

OUTCOMES = ["ball", "called", "swstr", "foul", "out", "1b", "2b", "3b", "hr"]
LABELS = {"ball": "Ball/HBP", "called": "Called strike", "swstr": "Swinging strike",
          "foul": "Foul strike", "out": "Field out", "1b": "Single", "2b": "Double",
          "3b": "Triple", "hr": "Home run"}
WEIGHTS = ("bf", "none")   # by batters faced, or every pitcher-season the same
TARGETS = {"k_pct": "K%", "bb_pct": "BB%", "hit_pct": "Hit%", "pa_per_ip": "PA/IP"}

# call codes for pitches not put in play
CALLS = {"B": "ball", "*B": "ball", "P": "ball", "H": "ball",
         "C": "called",
         "S": "swstr", "W": "swstr", "M": "swstr", "T": "swstr", "O": "swstr", "Q": "swstr",
         "F": "foul", "L": "foul"}
HITS = {"single": "1b", "double": "2b", "triple": "3b", "home_run": "hr"}

STRIKEOUTS = {"strikeout", "strikeout_double_play"}
WALKS = {"walk", "intent_walk"}
# an at-bat that ended on the bases with the batter still up is not a plate appearance
NOT_PA = ("caught_stealing", "pickoff", "stolen_base", "wild_pitch", "passed_ball",
          "other_out", "game_advisory", "balk")


# ---- reading --------------------------------------------------------------------------
def season_units(manifest: dict, season: int) -> list[str]:
    """The MLB files covering a season (they never overlap; see tools/data)."""
    return sorted(p for p, u in manifest["units"].items()
                  if u["sport"] == "mlb" and u["start"].startswith(str(season)))


def read_unit(s: requests.Session, path: str, cache: Path | None,
              columns: list[str] = COLUMNS) -> pd.DataFrame:
    local = cache / path if cache else None
    if local and local.exists():
        data = local.read_bytes()
    else:
        r = s.get(DATA_URL + path, timeout=600)
        r.raise_for_status()
        data = r.content
        if local:
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(data)
    return pq.read_table(io.BytesIO(data), columns=columns).to_pandas()


def load(seasons: list[int], cache: Path | None) -> pd.DataFrame:
    s = requests.Session()
    manifest = s.get(MANIFEST_URL, timeout=60).json()
    parts = []
    for season in seasons:
        paths = season_units(manifest, season)
        if not paths:
            raise SystemExit(f"no MLB data for {season} in the manifest")
        for path in paths:
            print(f"  {path}", file=sys.stderr)
            df = read_unit(s, path, cache)
            df = df[df["game_type"] == "R"]
            df["season"] = season
            parts.append(df)
    df = pd.concat(parts, ignore_index=True)
    for c in ("events", "call_code", "game_type", "pitcher_name"):
        df[c] = df[c].astype("string")
    return df


# ---- per pitch and per plate appearance -----------------------------------------------
def pitch_outcomes(df: pd.DataFrame) -> pd.Series:
    """Each pitch's outcome, one of OUTCOMES."""
    out = df["call_code"].map(CALLS)
    in_play = df["is_in_play"].fillna(False).astype(bool)
    out[in_play] = df.loc[in_play, "events"].map(HITS).fillna("out")
    missing = out.isna()
    if missing.any():
        codes = df.loc[missing, "call_code"].value_counts(dropna=False).to_dict()
        raise SystemExit(f"unmapped call codes: {codes}")
    return out


def plate_appearances(df: pd.DataFrame) -> pd.DataFrame:
    """One row per at-bat: its pitcher (the one on the last pitch), result, and the
    outs made from its first pitch to the first pitch of the next at-bat in the
    half-inning -- or to the end of the half-inning, which is three outs unless the
    home team walked off."""
    g = df.groupby(["game_pk", "at_bat_index"], sort=True, observed=True)
    ab = g.agg(season=("season", "first"), inning=("inning", "first"),
               top=("is_top_inning", "first"), pitcher=("pitcher", "last"),
               events=("events", "last"), outs=("outs", "first"),
               home=("post_home_score", "last"), away=("post_away_score", "last")).reset_index()
    ab["top"] = ab["top"].astype(bool)
    half = ["game_pk", "inning", "top"]
    nxt = ab.groupby(half, observed=True)["outs"].shift(-1)

    last_half = (ab["game_pk"] != ab["game_pk"].shift(-1))
    walk_off = last_half & ~ab["top"] & (ab["home"] > ab["away"])
    out_play = "out|double_play|triple_play|sac_|caught|pickoff"
    play_out = ab["events"].fillna("").str.contains(out_play)
    end_outs = np.where(walk_off, ab["outs"] + play_out.astype(int), 3)
    ab["outs_made"] = np.where(nxt.notna(), nxt - ab["outs"], end_outs - ab["outs"]).clip(0, 3)

    ev = ab["events"].fillna("")
    ab["pa"] = ~ev.str.startswith(NOT_PA) & (ev != "")
    ab["k"] = ab["pa"] & ev.isin(STRIKEOUTS)
    ab["bb"] = ab["pa"] & ev.isin(WALKS)
    ab["h"] = ab["pa"] & ev.isin(HITS.keys())
    return ab


def pitcher_seasons(df: pd.DataFrame) -> pd.DataFrame:
    """Per pitcher-season: the nine outcome shares and the four stats."""
    df = df.assign(outcome=pitch_outcomes(df))
    key = ["season", "pitcher"]
    counts = df.groupby(key + ["outcome"], observed=True).size().unstack(fill_value=0)
    counts = counts.reindex(columns=OUTCOMES, fill_value=0)
    shares = counts.div(counts.sum(axis=1), axis=0)
    shares["pitches"] = counts.sum(axis=1)

    ab = plate_appearances(df)
    tot = ab.groupby(key)[["pa", "k", "bb", "h", "outs_made"]].sum()
    out = shares.join(tot, how="inner")
    out = out.join(df.groupby(key)["pitcher_name"].last())
    out = out[(out["pa"] > 0) & (out["outs_made"] > 0)].copy()
    out["k_pct"] = out["k"] / out["pa"]
    out["bb_pct"] = out["bb"] / out["pa"]
    out["hit_pct"] = out["h"] / out["pa"]
    out["pa_per_ip"] = out["pa"] / (out["outs_made"] / 3)
    return out.reset_index()


# ---- the fits -------------------------------------------------------------------------
def wls(X: np.ndarray, y: np.ndarray, w: np.ndarray) -> dict:
    """Weighted least squares, no intercept, with classical standard errors."""
    sw = np.sqrt(w)
    Xw, yw = X * sw[:, None], y * sw
    beta, *_ = np.linalg.lstsq(Xw, yw, rcond=None)
    resid = y - X @ beta
    n, k = X.shape
    sigma2 = (w * resid**2).sum() / (n - k)
    se = np.sqrt(np.diag(sigma2 * np.linalg.inv(Xw.T @ Xw)))
    return {"beta": beta, "se": se}


def centered(X: np.ndarray, y: np.ndarray, w: np.ndarray) -> dict:
    """The fit on deviations from the weighted season averages. The centered shares sum
    to zero, so the coefficients are fixed up to a constant; it is the one that puts the
    average pitcher on the average stat, which makes them the uncentered fit's -- checked
    here rather than assumed, since the standard errors come from that form."""
    xbar, ybar = np.average(X, axis=0, weights=w), np.average(y, weights=w)
    sw = np.sqrt(w)
    beta, *_ = np.linalg.lstsq((X - xbar) * sw[:, None], (y - ybar) * sw, rcond=None)
    beta += ybar - xbar @ beta
    f = wls(X, y, w)
    assert np.allclose(beta, f["beta"], rtol=1e-6, atol=1e-8), "centered fit differs"
    return {"beta": beta, "se": f["se"], "xbar": xbar, "ybar": ybar}


def predict(beta: np.ndarray, X: np.ndarray, xbar: np.ndarray, ybar: float) -> np.ndarray:
    """The season's average plus the deviations from its average shares."""
    return ybar + (X - xbar) @ beta


def score(pred: np.ndarray, y: np.ndarray, w: np.ndarray) -> dict:
    ybar = np.average(y, weights=w)
    ss_res = (w * (y - pred) ** 2).sum()
    ss_tot = (w * (y - ybar) ** 2).sum()
    return {"r2": 1 - ss_res / ss_tot, "rmse": float(np.sqrt(ss_res / w.sum())),
            "mae": float(np.average(np.abs(y - pred), weights=w))}


def base_weight(ps: pd.DataFrame, weight: str) -> np.ndarray:
    return ps["pa"].to_numpy(float) if weight == "bf" else np.ones(len(ps))


def fit_season(ps: pd.DataFrame, weight: str) -> dict:
    """One season's four models, its averages and fit statistics."""
    X, w = ps[OUTCOMES].to_numpy(float), base_weight(ps, weight)
    out = {"league": {"shares": dict(zip(OUTCOMES, np.average(X, axis=0, weights=w).tolist(),
                                         strict=True))},
           "pitcher_seasons": len(ps), "batters_faced": int(ps["pa"].sum()), "models": {}}
    out["league"]["stats"] = {}
    for t in TARGETS:
        y = ps[t].to_numpy(float)
        f = centered(X, y, w)
        out["league"]["stats"][t] = float(f["ybar"])
        pred = predict(f["beta"], X, f["xbar"], f["ybar"])
        m = {"coef": dict(zip(OUTCOMES, f["beta"].tolist(), strict=True)),
             "se": dict(zip(OUTCOMES, f["se"].tolist(), strict=True)),
             "fit": score(pred, y, w)}
        for floor in (100, 400):
            big = ps["pa"].to_numpy() >= floor
            m["fit"][f"r2_bf{floor}"] = score(pred[big], y[big], w[big])["r2"]
        out["models"][t] = m
    return out


def next_season(prev: dict, ps: pd.DataFrame, weight: str) -> dict:
    """R^2 of the previous season's coefficients on this season, centered on this
    season's averages."""
    X, w = ps[OUTCOMES].to_numpy(float), base_weight(ps, weight)
    xbar = np.average(X, axis=0, weights=w)
    out = {}
    for t in TARGETS:
        y = ps[t].to_numpy(float)
        beta = np.array([prev["models"][t]["coef"][o] for o in OUTCOMES])
        out[t] = score(predict(beta, X, xbar, np.average(y, weights=w)), y, w)["r2"]
    return out


def fit_all(ps: pd.DataFrame, weight: str) -> dict:
    seasons, prev = {}, None
    for season, rows in ps.groupby("season", sort=True):
        seasons[int(season)] = fit_season(rows, weight)
        if prev is not None:
            seasons[int(season)]["from_previous"] = next_season(prev, rows, weight)
        prev = seasons[int(season)]
    return seasons


# ---- output ---------------------------------------------------------------------------
def report(ps: pd.DataFrame, seasons: dict, weight: str) -> str:
    base = "batters faced" if weight == "bf" else "unweighted"
    years = list(seasons)
    lines = [f"{len(ps):,} pitcher-seasons, {int(ps['pa'].sum()):,} batters faced, "
             f"{int(ps['pitches'].sum()):,} pitches; one fit per season, {base}, "
             "centered on the season's averages"]
    for t, name in TARGETS.items():
        head = f"{name:<16}" + "".join(f"{y:>18}" for y in years)
        lines += ["", head, "-" * len(head)]
        for o in OUTCOMES:
            cells = ((seasons[y]["models"][t]["coef"][o], seasons[y]["models"][t]["se"][o])
                     for y in years)
            lines.append(f"{LABELS[o]:<16}" + "".join(f"{c:>10.3f} ({se:.3f})" for c, se in cells))
        lines.append(f"{'season avg':<16}" + "".join(
            f"{seasons[y]['league']['stats'][t]:>18.4f}" for y in years))
        for label, key in (("R^2", "r2"), ("R^2 BF>=100", "r2_bf100"), ("R^2 BF>=400", "r2_bf400")):
            lines.append(f"{label:<16}" + "".join(
                f"{seasons[y]['models'][t]['fit'][key]:>18.4f}" for y in years))
        lines.append(f"{'R^2 prev coefs':<16}" + "".join(
            f"{seasons[y]['from_previous'][t]:>18.4f}" if "from_previous" in seasons[y]
            else f"{'':>18}" for y in years))
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="+", default=[2023, 2024, 2025, 2026])
    ap.add_argument("--weight", choices=WEIGHTS, default="bf",
                    help="weight pitcher-seasons by batters faced (bf, the default) or equally")
    ap.add_argument("--cache", type=Path, help="keep the downloaded Parquet here")
    ap.add_argument("--json", type=Path, help="write the coefficients and fit stats here")
    ap.add_argument("--csv", type=Path, help="write the pitcher-season table here")
    args = ap.parse_args()

    ps = pitcher_seasons(load(args.seasons, args.cache))
    seasons = fit_all(ps, args.weight)
    print(report(ps, seasons, args.weight))

    if args.json:
        meta = {"seasons": args.seasons, "weight": args.weight, "centered": "season",
                "outcomes": OUTCOMES, "labels": LABELS, "targets": TARGETS}
        out = {"meta": meta, "seasons": {str(y): v for y, v in seasons.items()}}
        args.json.write_text(json.dumps(out, indent=2) + "\n")
    if args.csv:
        ps.to_csv(args.csv, index=False, float_format="%.5f")


if __name__ == "__main__":
    main()
