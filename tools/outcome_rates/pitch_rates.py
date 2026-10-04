"""K%, BB% and Hit% from the Stuff or PLV model's outcome predictions, per pitch type.

The pitch models (Blandalytics/pitch-modeling) give every pitch nine outcome
probabilities -- ball, called strike, swinging strike, foul, field out, single, double,
triple, home run:

    stuff   Stuff, count-neutral: over the league's location and count mix
    plv     PLV (the "pitching" model): at the pitch's actual location and count

Those are the nine outcome shares fit.py's models take, so the coefficients in
models.json turn them into a K%, BB% and Hit%: the rates of a pitcher whose every pitch
had that pitch's predicted outcomes. Each season uses its own season's models, centered
the way they were fit: the season's actual rate plus the coefficients times the pitch
type's probabilities less the pitch model's own league average for the season (over
every pitch it scored). The pitch model's average pitch therefore lands on the season's
actual rate, whatever the pitch model's own bias. The models are linear, so a pitch
type's rates come straight from its mean probabilities.

Those means are already in the bucket, in the tables the Model Drilldown reads
(``shap-values/``, from stuff_model's shap_values.py): ``units_<stuff|pitching>_<season>``
holds each pitcher-season-pitch type's ``p_<outcome>`` (in percent) and plus score
(``plus``: Stuff+ or PLV+), ``unit_features_<season>`` its name and pitch count.

Two levels: each pitch type, and each pitcher's whole season (every pitch type the
tables cover, its probabilities averaged over all his pitches, its plus score rebuilt
on the pitcher-season scale). Prints, for each season, the top and bottom --top on
each rate: pitch types with at least --min-pitches scored pitches, pitchers with at
least --min-pitcher-pitches. "Top" is the pitcher's best end: the highest K%, the lowest
BB% and Hit%. --actual takes fit.py's --csv (the pitcher-season table) to show each
pitcher's real rates beside the predicted ones.

    python tools/outcome_rates/pitch_rates.py --seasons 2026            # top/bottom 10
    python tools/outcome_rates/pitch_rates.py --seasons 2026 --model plv
    python tools/outcome_rates/pitch_rates.py --csv stuff_rates.csv     # 2023-2026, all rows
    python tools/outcome_rates/pitch_rates.py --seasons 2026 --actual pitcher_seasons.csv
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import requests

import fit

SHAP_URL = fit.DATA_URL + "shap-values/"
# the tables' target for each of fit.OUTCOMES
TARGETS = dict(zip(fit.OUTCOMES, ("p_ball", "p_called_strike", "p_swinging_strike", "p_foul",
                                  "p_field_out", "p_single", "p_double", "p_triple",
                                  "p_home_run"), strict=True))
# fit.py's target -> whether higher is better for the pitcher
RATES = {"k_pct": True, "bb_pct": False, "hit_pct": False}
# --model -> (the tables' model name, how the output names it, its run value)
MODELS = {"stuff": ("stuff", "Stuff", "stuff_rv"), "plv": ("pitching", "PLV", "pitching_rv")}
MIN_PITCHES = 500
MIN_PITCHER_PITCHES = 1500
SCALE_URL = fit.DATA_URL + "pitch-modeling/constants/plus_scale_constants.json"


def read(s: requests.Session, name: str, columns: list[str]) -> pd.DataFrame:
    r = s.get(SHAP_URL + name, timeout=300)
    r.raise_for_status()
    return pq.read_table(io.BytesIO(r.content), columns=columns).to_pandas()


def season_units(s: requests.Session, season: int, model: str) -> pd.DataFrame:
    """Per pitcher-pitch type: name, pitches, the plus score and the nine probabilities
    (0-1)."""
    keys = ["season", "pitcher", "pt"]
    units = read(s, f"units_{MODELS[model][0]}_{season}.parquet", [*keys, "target", "exact"])
    units = units[units["target"].isin([*TARGETS.values(), "plus"])]
    wide = units.pivot_table(index=keys, columns="target", values="exact")
    out = wide[list(TARGETS.values())].div(100).set_axis(list(TARGETS), axis=1)
    out["plus"] = wide["plus"]
    info = read(s, f"unit_features_{season}.parquet", [*keys, "pitcher_name", "n"])
    return info.set_index(keys).join(out, how="inner").reset_index()


def pitchers(units: pd.DataFrame, scale: dict, rv: str) -> pd.DataFrame:
    """Each pitcher-season over all his pitch types: the probabilities averaged over his
    pitches, and his plus score. The tables' plus is on the pitcher-season-pitch-type
    scale; turned back into runs per 100 pitches, averaged over his pitches and put on
    the pitcher-season scale, it is the score a whole season grades out at."""
    plus = scale["plus"]
    unit = scale["aggregations"]["pitcher_season_pitch_type"]["columns"][rv]
    whole = scale["aggregations"]["pitcher_season"]["columns"][rv]
    u = units.assign(rv100=unit["mean"] + unit["sd"] * (units["plus"] - plus["mean"]) / plus["sd"])
    weighted = u[[*fit.OUTCOMES, "rv100"]].mul(u["n"], axis=0)
    weighted[["season", "pitcher"]] = u[["season", "pitcher"]]
    g = weighted.groupby(["season", "pitcher"])
    n = u.groupby(["season", "pitcher"])["n"].sum()
    out = g[[*fit.OUTCOMES, "rv100"]].sum().div(n, axis=0)
    out["n"] = n
    out["pitcher_name"] = u.groupby(["season", "pitcher"])["pitcher_name"].last()
    out["pt"] = "all"
    out["plus"] = plus["mean"] + plus["sd"] * (out["rv100"] - whole["mean"]) / whole["sd"]
    return out.drop(columns="rv100").reset_index()


def apply_models(units: pd.DataFrame, seasons: dict) -> pd.DataFrame:
    """Each rate as its season's actual rate plus the season's coefficients times the
    pitch type's deviation from the pitch model's average probabilities that season."""
    parts = []
    for season, u in units.groupby("season", sort=True):
        fitted = seasons.get(str(season))
        if fitted is None:
            raise SystemExit(f"no {season} models in models.json")
        u = u.copy()
        avg = {o: (u[o] * u["n"]).sum() / u["n"].sum() for o in fit.OUTCOMES}
        for target in RATES:
            coef = fitted["models"][target]["coef"]
            league = fitted["league"]["stats"][target]
            u[target] = league + sum(coef[o] * (u[o] - avg[o]) for o in fit.OUTCOMES)
        parts.append(u)
    return pd.concat(parts, ignore_index=True)


def table(rows: pd.DataFrame, col: str, label: str) -> list[str]:
    actual = f"actual_{col}" in rows
    out = [f"{'':>4} {'pitcher':<24}{'pitch':<6}{'pitches':>8}{label:>8}"
           + (f"{'Actual':>8}" if actual else "")
           + f"{'Ball':>7}{'SwStr':>7}{'CStr':>7}{'BIP':>7}{'Hit':>7}{label + '+':>8}"]
    hits = rows[["1b", "2b", "3b", "hr"]].sum(axis=1)
    rows = rows.assign(hits=hits, bip=rows["out"] + hits, value=rows[col],
                       real=rows[f"actual_{col}"] if actual else float("nan"))
    for r in rows.itertuples():
        out.append(f"{r.rank:>4} {r.pitcher_name:<24}{r.pt:<6}{r.n:>8,}{r.value:>8.1%}"
                   + (f"{r.real:>8.1%}" if actual else "")
                   + f"{r.ball:>7.1%}{r.swstr:>7.1%}{r.called:>7.1%}{r.bip:>7.1%}{r.hits:>7.1%}"
                   f"{r.plus:>8.0f}")
    return out


def ranked(board: pd.DataFrame, target: str) -> pd.DataFrame:
    """Best end first, with ranks."""
    out = board.sort_values(target, ascending=not RATES[target], ignore_index=True)
    out["rank"] = range(1, len(out) + 1)
    return out


def report(levels: list[tuple[str, pd.DataFrame, int]], top: int, label: str) -> str:
    """levels: (what a row is, every row, the minimum pitches to rank)."""
    lines = []
    for season in sorted(levels[0][1]["season"].unique()):
        for what, rows, floor in levels:
            u = rows[rows["season"] == season]
            board = u[u["n"] >= floor]
            lines += ["", f"==== {season}: {len(board)} {what} with {floor}+ pitches ===="]
            for target in RATES:
                league = (u[target] * u["n"]).sum() / u["n"].sum()
                r = ranked(board, target)
                name = f"{label} {fit.TARGETS[target]}"
                lines += ["", f"{name}, league {league:.1%} -- top {top}",
                          *table(r.head(top), target, label),
                          "", f"{name} -- bottom {top}", *table(r.tail(top), target, label)]
    return "\n".join(lines)


def with_actual(rows: pd.DataFrame, path: Path) -> pd.DataFrame:
    """fit.py's pitcher-season rates beside the predicted ones."""
    real = pd.read_csv(path, usecols=["season", "pitcher", *RATES])
    real = real.rename(columns={t: f"actual_{t}" for t in RATES})
    return rows.merge(real, on=["season", "pitcher"], how="left")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="+", default=[2023, 2024, 2025, 2026])
    ap.add_argument("--model", choices=sorted(MODELS), default="stuff")
    ap.add_argument("--min-pitches", type=int, default=MIN_PITCHES,
                    help=f"pitch types to rank (default {MIN_PITCHES})")
    ap.add_argument("--min-pitcher-pitches", type=int, default=MIN_PITCHER_PITCHES,
                    help=f"whole pitcher-seasons to rank (default {MIN_PITCHER_PITCHES})")
    ap.add_argument("--actual", type=Path,
                    help="fit.py's --csv pitcher-season table, for the pitchers' real rates")
    ap.add_argument("--top", type=int, default=10, help="rows at each end to print")
    ap.add_argument("--models", type=Path, default=Path(__file__).with_name("models.json"))
    ap.add_argument("--csv", type=Path, help="write every pitch type over the minimum here")
    ap.add_argument("--pitcher-csv", type=Path, help="write every pitcher over the minimum here")
    args = ap.parse_args()

    seasons = json.loads(args.models.read_text())["seasons"]
    s = requests.Session()
    units = pd.concat([season_units(s, yr, args.model) for yr in args.seasons],
                      ignore_index=True)
    scale = s.get(SCALE_URL, timeout=60).json()
    whole = apply_models(pitchers(units, scale, MODELS[args.model][2]), seasons)
    units = apply_models(units, seasons)
    if args.actual:
        whole = with_actual(whole, args.actual)
    levels = [("pitch types", units, args.min_pitches),
              ("pitchers", whole, args.min_pitcher_pitches)]
    print(report(levels, args.top, MODELS[args.model][1]))
    for path, rows, floor in ((args.csv, units, args.min_pitches),
                              (args.pitcher_csv, whole, args.min_pitcher_pitches)):
        if path:
            board = rows[rows["n"] >= floor]
            board.sort_values(["season", "k_pct"], ascending=[True, False]).to_csv(
                path, index=False, float_format="%.4f")


if __name__ == "__main__":
    main()
