"""Stuff K%: the K% model applied to the Stuff model's outcome predictions, per pitch type.

The Stuff model (Blandalytics/pitch-modeling, published to the bucket under
``pitch-modeling/``) gives every pitch nine count-neutral outcome probabilities -- ball,
called strike, swinging strike, foul, field out, single, double, triple, home run --
over the league's location and count mix. Those are the nine outcome shares fit.py's
models take, so the K% coefficients in models.json turn them into a K%: the strikeout
rate of a pitcher whose every pitch had that pitch's stuff. The model is linear, so a
pitch type's Stuff K% is the mean over its pitches.

One row per pitcher-season-pitch type thrown at least --min-pitches times (regular
season), ranked by Stuff K%, with plvStuff+ beside it on the card's scale.

    python tools/outcome_rates/stuff_k.py --cache /tmp/mlb               # 2023-2026
    python tools/outcome_rates/stuff_k.py --seasons 2026 --csv stuff_k.csv
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import pandas as pd
import requests

import fit

MODELS_URL = fit.DATA_URL + "pitch-modeling/"
CHAIN = ("swing_take", "take_outcome", "swing_outcome", "in_play")
ARTIFACTS = ("score_pitches.py",
             *(f"models/{n}_logit_2325.pkl" for n in CHAIN),
             *(f"constants/{t}" for t in ("run_values.csv", "run_values_by_count.csv",
                                          "count_mix.json", "plus_scale_constants.json")))
# the scorer's outcome names, in fit.OUTCOMES order
SCORER_OUTCOMES = ("ball", "called_strike", "swinging_strike", "foul", "field_out",
                   "single", "double", "triple", "home_run")
COLUMNS = ["game_pk", "game_date", "game_type", "at_bat_index", "pitch_number", "pitcher",
           "pitcher_name", "pitch_type", "p_throws", "stand", "home_team", "call_code",
           "event_desc", "events", "balls", "strikes", "release_speed", "release_extension",
           "release_pos_x", "release_pos_z", "vx0", "vy0", "vz0", "ax", "ay", "az",
           "release_spin_rate", "spin_axis", "plate_x", "plate_z", "sz_top", "sz_bot"]
MIN_PITCHES = 500
LEVEL = "pitcher_season_pitch_type"   # the plus scale a pitch type's season is graded on


# ---- the scorer -----------------------------------------------------------------------
def scorer(cache: Path, s: requests.Session):
    """score_pitches with its models and constants, downloaded to cache/pitch-modeling."""
    root = cache / "pitch-modeling"
    for name in ARTIFACTS:
        path = root / name
        if not path.exists():
            r = s.get(MODELS_URL + name, timeout=600)
            r.raise_for_status()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            print(f"  pitch model {name}: {len(r.content) / 1e6:.1f} MB", file=sys.stderr)
    sys.path.insert(0, str(root))
    import score_pitches as sp

    models = sp.load_models(root / "models")
    mix, values, by_count = sp.load_constants(root / "constants")
    scale = json.loads((root / "constants" / "plus_scale_constants.json").read_text())
    return sp, (models, mix, values, by_count), scale


def plain(raw: pd.DataFrame) -> pd.DataFrame:
    """Categoricals as objects: the scorer compares p_throws to stand (see pitch_model)."""
    cats = [c for c in raw.columns if isinstance(raw[c].dtype, pd.CategoricalDtype)]
    return raw.astype(dict.fromkeys(cats, "object"))


def score_unit(sp, parts, raw: pd.DataFrame) -> pd.DataFrame:
    """Per pitcher-season-pitch type: pitches thrown, pitches scored, the mean of the nine
    count-neutral outcome probabilities and of stuff_rv. Scored a month at a time, which
    keeps every outing whole."""
    raw = plain(raw[raw["game_type"] == "R"])
    thrown = raw.assign(pt=raw["pitch_type"].astype("string").fillna("UN"))
    thrown = thrown.groupby(["pitcher", "pt"]).size().rename("thrown")
    probs = [f"p_{o}_stuff" for o in SCORER_OUTCOMES]
    out = []
    for _, month in raw.groupby(raw["game_date"].astype(str).str[:7]):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", pd.errors.PerformanceWarning)
            pitches, _ = sp.score(month, *parts)
        out.append(pitches[["pitcher", "pitcher_name", "pt", *probs, "stuff_rv"]])
    pitches = pd.concat(out, ignore_index=True)
    sums = pitches.groupby(["pitcher", "pt"])[[*probs, "stuff_rv"]].sum()
    sums["scored"] = pitches.groupby(["pitcher", "pt"]).size()
    sums["pitcher_name"] = pitches.groupby(["pitcher", "pt"])["pitcher_name"].last()
    return sums.join(thrown).reset_index()


# ---- the leaderboard ------------------------------------------------------------------
def leaderboard(sums: pd.DataFrame, coef: dict, scale: dict, min_pitches: int) -> pd.DataFrame:
    probs = [f"p_{o}_stuff" for o in SCORER_OUTCOMES]
    g = sums.groupby(["season", "pitcher", "pt"])
    t = g[[*probs, "stuff_rv", "scored", "thrown"]].sum()
    t["pitcher_name"] = g["pitcher_name"].last()
    mean = t[[*probs, "stuff_rv"]].div(t["scored"], axis=0)
    out = t[["pitcher_name", "thrown", "scored"]].copy()
    for o, p in zip(fit.OUTCOMES, probs, strict=True):
        out[o] = mean[p]
    out["stuff_k_pct"] = sum(coef[o] * out[o] for o in fit.OUTCOMES)
    plus, stat = scale["plus"], scale["aggregations"][LEVEL]["columns"]["stuff_rv"]
    z = (100 * mean["stuff_rv"] - stat["mean"]) / stat["sd"]
    out["stuff_plus"] = plus["mean"] + plus["sd"] * z
    out = out[out["thrown"] >= min_pitches].reset_index()
    return out.sort_values("stuff_k_pct", ascending=False, ignore_index=True)


def report(board: pd.DataFrame, league: dict, top: int) -> str:
    lines = []
    for season, b in board.groupby("season", sort=True):
        lines += ["", f"{season}: {len(b)} pitch types with {board.attrs['min']}+ pitches; "
                      f"league Stuff K% {league[season]:.1%}", "",
                  f"{'':>4} {'pitcher':<24}{'pitch':<6}{'pitches':>8}{'Stuff K%':>10}"
                  f"{'SwStr':>8}{'CStr':>7}{'Ball':>7}{'plvStuff+':>11}"]
        for i, r in enumerate(b.head(top).itertuples(), 1):
            lines.append(f"{i:>4} {r.pitcher_name:<24}{r.pt:<6}{r.thrown:>8,}"
                         f"{r.stuff_k_pct:>10.1%}{r.swstr:>8.1%}{r.called:>7.1%}"
                         f"{r.ball:>7.1%}{r.stuff_plus:>11.0f}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, nargs="+", default=[2023, 2024, 2025, 2026])
    ap.add_argument("--min-pitches", type=int, default=MIN_PITCHES)
    ap.add_argument("--top", type=int, default=25, help="rows per season to print")
    ap.add_argument("--models", type=Path, default=Path(__file__).with_name("models.json"))
    ap.add_argument("--cache", type=Path, default=Path("cache"),
                    help="keep the Parquet and the pitch model here")
    ap.add_argument("--csv", type=Path, help="write the full leaderboard here")
    args = ap.parse_args()

    coef = json.loads(args.models.read_text())["models"]["k_pct"]["coef"]
    s = requests.Session()
    sp, parts, scale = scorer(args.cache, s)
    manifest = s.get(fit.MANIFEST_URL, timeout=60).json()
    sums = []
    for season in args.seasons:
        for path in fit.season_units(manifest, season):
            print(f"  {path}", file=sys.stderr)
            raw = fit.read_unit(s, path, args.cache, COLUMNS)
            sums.append(score_unit(sp, parts, raw).assign(season=season))
    sums = pd.concat(sums, ignore_index=True)

    all_types = leaderboard(sums, coef, scale, 1)
    league = {yr: (b["stuff_k_pct"] * b["scored"]).sum() / b["scored"].sum()
              for yr, b in all_types.groupby("season")}
    board = leaderboard(sums, coef, scale, args.min_pitches)
    board.attrs["min"] = args.min_pitches
    print(report(board, league, args.top))
    if args.csv:
        board.to_csv(args.csv, index=False, float_format="%.4f")


if __name__ == "__main__":
    main()
