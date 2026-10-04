"""Stuff K%, BB% and Hit%: fit.py's models applied to the Stuff model's outcome predictions.

The Stuff model (Blandalytics/pitch-modeling) gives every pitch nine count-neutral
outcome probabilities -- ball, called strike, swinging strike, foul, field out, single,
double, triple, home run -- over the league's location and count mix. Those are the
nine outcome shares fit.py's models take, so the coefficients in models.json turn them
into a K%, BB% and Hit%: the rates of a pitcher whose every pitch had that pitch's
stuff. The models are linear, so a pitch type's rates come straight from its mean
probabilities.

Those means are already in the bucket, in the tables the Model Drilldown reads
(``shap-values/``, from stuff_model's shap_values.py): ``units_stuff_<season>`` holds
each pitcher-season-pitch type's ``p_<outcome>`` (in percent) and Stuff+ (``plus``),
``unit_features_<season>`` its name and pitch count.

Prints, for each season, the top and bottom --top pitch types on each rate among those
with at least --min-pitches scored pitches. "Top" is the pitcher's best end: the
highest K%, the lowest BB% and Hit%.

    python tools/outcome_rates/stuff_rates.py --seasons 2026            # top/bottom 10
    python tools/outcome_rates/stuff_rates.py --csv stuff_rates.csv     # 2023-2026, all rows
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
# fit.py's target -> this table's column, and whether higher is better for the pitcher
RATES = {"k_pct": ("stuff_k_pct", True), "bb_pct": ("stuff_bb_pct", False),
         "hit_pct": ("stuff_hit_pct", False)}
MIN_PITCHES = 500


def read(s: requests.Session, name: str, columns: list[str]) -> pd.DataFrame:
    r = s.get(SHAP_URL + name, timeout=300)
    r.raise_for_status()
    return pq.read_table(io.BytesIO(r.content), columns=columns).to_pandas()


def season_units(s: requests.Session, season: int) -> pd.DataFrame:
    """Per pitcher-pitch type: name, pitches, Stuff+ and the nine probabilities (0-1)."""
    keys = ["season", "pitcher", "pt"]
    units = read(s, f"units_stuff_{season}.parquet", [*keys, "target", "exact"])
    units = units[units["target"].isin([*TARGETS.values(), "plus"])]
    wide = units.pivot_table(index=keys, columns="target", values="exact")
    out = wide[list(TARGETS.values())].div(100).set_axis(list(TARGETS), axis=1)
    out["stuff_plus"] = wide["plus"]
    info = read(s, f"unit_features_{season}.parquet", [*keys, "pitcher_name", "n"])
    return info.set_index(keys).join(out, how="inner").reset_index()


def apply_models(units: pd.DataFrame, models: dict) -> pd.DataFrame:
    """Each rate as the probability-weighted sum of its model's coefficients."""
    for target, (col, _) in RATES.items():
        coef = models[target]["coef"]
        units[col] = sum(coef[o] * units[o] for o in fit.OUTCOMES)
    return units


def table(rows: pd.DataFrame, col: str) -> list[str]:
    out = [f"{'':>4} {'pitcher':<24}{'pitch':<6}{'pitches':>8}{'Stuff':>8}"
           f"{'Ball':>7}{'SwStr':>7}{'CStr':>7}{'BIP':>7}{'Hit':>7}{'Stuff+':>8}"]
    hits = rows[["1b", "2b", "3b", "hr"]].sum(axis=1)
    rows = rows.assign(hits=hits, bip=rows["out"] + hits, value=rows[col])
    for r in rows.itertuples():
        out.append(f"{r.rank:>4} {r.pitcher_name:<24}{r.pt:<6}{r.n:>8,}{r.value:>8.1%}"
                   f"{r.ball:>7.1%}{r.swstr:>7.1%}{r.called:>7.1%}{r.bip:>7.1%}{r.hits:>7.1%}"
                   f"{r.stuff_plus:>8.0f}")
    return out


def report(units: pd.DataFrame, min_pitches: int, top: int) -> str:
    lines = []
    for season, u in units.groupby("season", sort=True):
        board = u[u["n"] >= min_pitches]
        lines += ["", f"==== {season}: {len(board)} pitch types with {min_pitches}+ pitches ===="]
        for target, (col, higher) in RATES.items():
            league = (u[col] * u["n"]).sum() / u["n"].sum()
            ranked = board.sort_values(col, ascending=not higher, ignore_index=True)
            ranked["rank"] = range(1, len(ranked) + 1)
            name = f"Stuff {fit.TARGETS[target]}"
            lines += ["", f"{name}, league {league:.1%} -- top {top}",
                      *table(ranked.head(top), col),
                      "", f"{name} -- bottom {top}", *table(ranked.tail(top), col)]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="+", default=[2023, 2024, 2025, 2026])
    ap.add_argument("--min-pitches", type=int, default=MIN_PITCHES)
    ap.add_argument("--top", type=int, default=10, help="rows at each end to print")
    ap.add_argument("--models", type=Path, default=Path(__file__).with_name("models.json"))
    ap.add_argument("--csv", type=Path, help="write every pitch type over the minimum here")
    args = ap.parse_args()

    models = json.loads(args.models.read_text())["models"]
    s = requests.Session()
    units = pd.concat([season_units(s, yr) for yr in args.seasons], ignore_index=True)
    units = apply_models(units, models)
    print(report(units, args.min_pitches, args.top))
    if args.csv:
        board = units[units["n"] >= args.min_pitches]
        board.sort_values(["season", "stuff_k_pct"], ascending=[True, False]).to_csv(
            args.csv, index=False, float_format="%.4f")


if __name__ == "__main__":
    main()
