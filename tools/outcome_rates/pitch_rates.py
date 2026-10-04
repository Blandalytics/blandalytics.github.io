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

Prints, for each season, the top and bottom --top pitch types on each rate among those
with at least --min-pitches scored pitches. "Top" is the pitcher's best end: the
highest K%, the lowest BB% and Hit%.

    python tools/outcome_rates/pitch_rates.py --seasons 2026            # top/bottom 10
    python tools/outcome_rates/pitch_rates.py --seasons 2026 --model plv
    python tools/outcome_rates/pitch_rates.py --csv stuff_rates.csv     # 2023-2026, all rows
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
# --model -> (the tables' model name, how the output names it)
MODELS = {"stuff": ("stuff", "Stuff"), "plv": ("pitching", "PLV")}
MIN_PITCHES = 500


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
    out = [f"{'':>4} {'pitcher':<24}{'pitch':<6}{'pitches':>8}{label:>8}"
           f"{'Ball':>7}{'SwStr':>7}{'CStr':>7}{'BIP':>7}{'Hit':>7}{label + '+':>8}"]
    hits = rows[["1b", "2b", "3b", "hr"]].sum(axis=1)
    rows = rows.assign(hits=hits, bip=rows["out"] + hits, value=rows[col])
    for r in rows.itertuples():
        out.append(f"{r.rank:>4} {r.pitcher_name:<24}{r.pt:<6}{r.n:>8,}{r.value:>8.1%}"
                   f"{r.ball:>7.1%}{r.swstr:>7.1%}{r.called:>7.1%}{r.bip:>7.1%}{r.hits:>7.1%}"
                   f"{r.plus:>8.0f}")
    return out


def report(units: pd.DataFrame, min_pitches: int, top: int, label: str) -> str:
    lines = []
    for season, u in units.groupby("season", sort=True):
        board = u[u["n"] >= min_pitches]
        lines += ["", f"==== {season}: {len(board)} pitch types with {min_pitches}+ pitches ===="]
        for target, higher in RATES.items():
            league = (u[target] * u["n"]).sum() / u["n"].sum()
            ranked = board.sort_values(target, ascending=not higher, ignore_index=True)
            ranked["rank"] = range(1, len(ranked) + 1)
            name = f"{label} {fit.TARGETS[target]}"
            lines += ["", f"{name}, league {league:.1%} -- top {top}",
                      *table(ranked.head(top), target, label),
                      "", f"{name} -- bottom {top}", *table(ranked.tail(top), target, label)]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="+", default=[2023, 2024, 2025, 2026])
    ap.add_argument("--model", choices=sorted(MODELS), default="stuff")
    ap.add_argument("--min-pitches", type=int, default=MIN_PITCHES)
    ap.add_argument("--top", type=int, default=10, help="rows at each end to print")
    ap.add_argument("--models", type=Path, default=Path(__file__).with_name("models.json"))
    ap.add_argument("--csv", type=Path, help="write every pitch type over the minimum here")
    args = ap.parse_args()

    seasons = json.loads(args.models.read_text())["seasons"]
    s = requests.Session()
    units = pd.concat([season_units(s, yr, args.model) for yr in args.seasons],
                      ignore_index=True)
    units = apply_models(units, seasons)
    print(report(units, args.min_pitches, args.top, MODELS[args.model][1]))
    if args.csv:
        board = units[units["n"] >= args.min_pitches]
        board.sort_values(["season", "k_pct"], ascending=[True, False]).to_csv(
            args.csv, index=False, float_format="%.4f")


if __name__ == "__main__":
    main()
