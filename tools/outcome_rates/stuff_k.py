"""Stuff K%: the K% model applied to the Stuff model's outcome predictions, per pitch type.

The Stuff model (Blandalytics/pitch-modeling) gives every pitch nine count-neutral
outcome probabilities -- ball, called strike, swinging strike, foul, field out, single,
double, triple, home run -- over the league's location and count mix. Those are the
nine outcome shares fit.py's models take, so the K% coefficients in models.json turn
them into a K%: the strikeout rate of a pitcher whose every pitch had that pitch's
stuff. The model is linear, so a pitch type's Stuff K% is its mean probabilities'.

Those means are already in the bucket, in the tables the Model Drilldown reads
(``shap-values/``, from stuff_model's shap_values.py): ``units_stuff_<season>`` holds
each pitcher-season-pitch type's ``p_<outcome>`` (in percent) and Stuff+ (``plus``),
``unit_features_<season>`` its name and pitch count.

One row per pitcher-season-pitch type with at least --min-pitches scored pitches,
ranked by Stuff K%.

    python tools/outcome_rates/stuff_k.py                         # 2023-2026
    python tools/outcome_rates/stuff_k.py --seasons 2026 --csv stuff_k.csv
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


def leaderboard(units: pd.DataFrame, coef: dict, min_pitches: int) -> pd.DataFrame:
    units = units.assign(stuff_k_pct=sum(coef[o] * units[o] for o in fit.OUTCOMES))
    board = units[units["n"] >= min_pitches]
    return board.sort_values("stuff_k_pct", ascending=False, ignore_index=True)


def report(units: pd.DataFrame, board: pd.DataFrame, min_pitches: int, top: int) -> str:
    lines = []
    for season, b in board.groupby("season", sort=True):
        u = units[units["season"] == season]
        league = (u["stuff_k_pct"] * u["n"]).sum() / u["n"].sum()
        lines += ["", f"{season}: {len(b)} pitch types with {min_pitches}+ pitches; "
                      f"league Stuff K% {league:.1%}", "",
                  f"{'':>4} {'pitcher':<24}{'pitch':<6}{'pitches':>8}{'Stuff K%':>10}"
                  f"{'SwStr':>8}{'CStr':>7}{'Ball':>7}{'Stuff+':>8}"]
        for i, r in enumerate(b.head(top).itertuples(), 1):
            lines.append(f"{i:>4} {r.pitcher_name:<24}{r.pt:<6}{r.n:>8,}"
                         f"{r.stuff_k_pct:>10.1%}{r.swstr:>8.1%}{r.called:>7.1%}"
                         f"{r.ball:>7.1%}{r.stuff_plus:>8.0f}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="+", default=[2023, 2024, 2025, 2026])
    ap.add_argument("--min-pitches", type=int, default=MIN_PITCHES)
    ap.add_argument("--top", type=int, default=25, help="rows per season to print")
    ap.add_argument("--models", type=Path, default=Path(__file__).with_name("models.json"))
    ap.add_argument("--csv", type=Path, help="write the full leaderboard here")
    args = ap.parse_args()

    coef = json.loads(args.models.read_text())["models"]["k_pct"]["coef"]
    s = requests.Session()
    units = pd.concat([season_units(s, yr) for yr in args.seasons], ignore_index=True)
    units = units.assign(stuff_k_pct=sum(coef[o] * units[o] for o in fit.OUTCOMES))
    board = leaderboard(units, coef, args.min_pitches)
    print(report(units, board, args.min_pitches, args.top))
    if args.csv:
        board.to_csv(args.csv, index=False, float_format="%.4f")


if __name__ == "__main__":
    main()
