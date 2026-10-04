"""Swing-path features for the hitter-side swing-outcome model (../swing_path_model_proposal.md).

Works on Baseball Savant's Statcast Search CSV (`statcast_search/csv?all=true&type=details`),
one row per pitch. It adds:

    x_in, z_n            location: x mirrored to the batter (+ = inside), z scaled to his zone
    hmov                 horizontal movement mirrored to the pitcher (glove side negative)
    pitch_group          Fastball / Breaking / Offspeed / Other, cutters split by role per game
    vaa                  vertical approach angle at the front of the plate (negative = descending)
    aa_match             attack_angle + vaa: the bat's vertical path against the pitch's plane
                         (0 = exactly on plane, + = steeper/uppercut, - = flatter/chopping)
    z_timing, z_speed    how far out front and how fast this swing was, against what this pitch,
                         location and count usually get and against the hitter's own norm
    early, late, decel   fooled-swing components; `fooled` is any of them

Savant already reports `attack_direction` (+ = opposite field) and the intercept x (+ = away from
the body) relative to the batter, so only the pitch location and movement are mirrored.
`check_conventions` fails if that ever stops being true.

    python tools/swing_path/features.py --start 2026-06-01 --end 2026-06-30 --out swings.parquet
    python tools/swing_path/features.py --csv 'data/savant/*.csv' --out swings.parquet
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import io

import lightgbm as lgb
import numpy as np
import pandas as pd
import requests

SAVANT = "https://baseballsavant.mlb.com/statcast_search/csv"
WHIFF = {"swinging_strike", "swinging_strike_blocked", "foul_tip"}
CLASSES = {**dict.fromkeys(WHIFF, "whiff"), "foul": "foul", "hit_into_play": "in_play"}
INTERCEPT_X = "intercept_ball_minus_batter_pos_x_inches"
INTERCEPT_Y = "intercept_ball_minus_batter_pos_y_inches"
PATH = [
    "bat_speed",
    "swing_length",
    "swing_path_tilt",
    "attack_angle",
    "attack_direction",
    INTERCEPT_X,
    INTERCEPT_Y,
]
GROUPS = {
    "FF": "Fastball",
    "SI": "Fastball",
    "SL": "Breaking",
    "ST": "Breaking",
    "SV": "Breaking",
    "CU": "Breaking",
    "KC": "Breaking",
    "CH": "Offspeed",
    "FS": "Offspeed",
    "FO": "Offspeed",
}
# What a swing is expected to look like, from the pitch and the situation only (no outcome).
EXPECT_INPUTS = [
    "x_in",
    "z_n",
    "balls",
    "strikes",
    "platoon",
    "group_code",
    "release_speed",
    "pfx_z",
    "hmov",
    "vaa",
]
FOOLED_Z = 2.0  # robust SDs from the expected swing that make a swing fooled
NORM_SHRINK = 50  # swings of prior weight on a zero batter norm
FOLDS = 5


def fetch(start: dt.date, end: dt.date) -> pd.DataFrame:
    """Every pitch from start to end, one day per request to stay under Savant's 25,000-row cap."""
    frames = []
    for i in range((end - start).days + 1):
        day = start + dt.timedelta(days=i)
        params = {
            "all": "true",
            "type": "details",
            "player_type": "batter",
            "game_date_gt": day,
            "game_date_lt": day,
        }
        r = requests.get(SAVANT, params=params, timeout=300)
        r.raise_for_status()
        frames.append(pd.read_csv(io.StringIO(r.content.decode("utf-8-sig"))))
    return pd.concat(frames, ignore_index=True)


def swings(pitches: pd.DataFrame) -> pd.DataFrame:
    """Tracked, non-bunt swings with their class (whiff / foul / in_play). Bunt attempts and
    pitchouts aren't in CLASSES, bunts in play are dropped by their description, and untracked
    swings (about 3-4%) are dropped."""
    bunt = pitches["des"].fillna("").str.contains("bunt", case=False)
    s = pitches[pitches["description"].isin(CLASSES) & ~bunt].dropna(subset=PATH).copy()
    s["cls"] = s["description"].map(CLASSES)
    return s.reset_index(drop=True)


def add_location(p: pd.DataFrame) -> None:
    """Location mirrored to the batter and movement mirrored to the pitcher, as in
    model_README.md: x_in + = inside for both hands, hmov glove side negative."""
    p["x_in"] = np.where(p["stand"] == "R", -p["plate_x"], p["plate_x"])
    p["z_n"] = (p["plate_z"] - p["sz_bot"]) / (p["sz_top"] - p["sz_bot"])
    p["hmov"] = np.where(p["p_throws"] == "R", -p["pfx_x"], p["pfx_x"])
    p["platoon"] = (p["stand"] == p["p_throws"]).astype(int)


def add_pitch_group(p: pd.DataFrame) -> None:
    """model_README.md's groups. A cutter is a Fastball in a game where it is the pitcher's
    most-used of FF, SI and FC (ties to the harder pitch), otherwise Breaking."""
    fast = p[p["pitch_type"].isin(["FF", "SI", "FC"])]
    use = (
        fast.groupby(["pitcher", "game_pk", "pitch_type"])
        .agg(n=("pitch_type", "size"), velo=("release_speed", "mean"))
        .reset_index()
    )
    top = use.sort_values(["n", "velo"]).groupby(["pitcher", "game_pk"]).tail(1)
    primary = set(
        zip(
            top.loc[top["pitch_type"] == "FC", "pitcher"],
            top.loc[top["pitch_type"] == "FC", "game_pk"],
            strict=True,
        )
    )
    is_fc = p["pitch_type"] == "FC"
    fc_primary = [(a, b) in primary for a, b in zip(p["pitcher"], p["game_pk"], strict=True)]
    group = p["pitch_type"].map(GROUPS).fillna("Other")
    p["pitch_group"] = group.mask(is_fc, np.where(fc_primary, "Fastball", "Breaking"))
    p["group_code"] = p["pitch_group"].map(
        {"Fastball": 0, "Breaking": 1, "Offspeed": 2, "Other": 3}
    )


def add_approach_angle(p: pd.DataFrame) -> None:
    """Vertical approach angle at the front of the plate, the same calculation as
    pitcher_card/prep.py's approach_angles, on Savant's column names."""
    vy_f = -np.sqrt(p["vy0"] ** 2 - 2 * p["ay"] * (50 - 17 / 12))
    t = (vy_f - p["vy0"]) / p["ay"]
    vz_f = p["vz0"] + p["az"] * t
    p["vaa"] = -np.degrees(np.arctan(vz_f / vy_f))


def add_attack_angle_match(p: pd.DataFrame) -> None:
    """The bat's vertical path against the pitch's: attack_angle + vaa. A pitch arriving at -6
    degrees is met exactly on plane by a 6-degree attack angle (aa_match 0). In June 2026,
    contact is most often fair at aa_match 0 to +10 and whiffs are fewest at -5 to +5.
    VAA changes by under 0.1 degree per foot of depth, so the plate-front value stands in for
    the contact point."""
    p["aa_match"] = p["attack_angle"] + p["vaa"]


def add_horizontal_match(p: pd.DataFrame) -> None:
    """The bat's horizontal path against the pitch's. `haa_b` is the direction of the ball's
    path reversed (toward the field) at the front of the plate, in the batter's frame like
    attack_direction (+ = opposite field). `ad_match` = attack_direction - haa_b is 0 when the
    bat travels back along the ball's line. haa_b has an SD of only about 2.3 degrees against
    about 15 for attack_direction, so ad_match is mostly attack_direction."""
    vy_f = -np.sqrt(p["vy0"] ** 2 - 2 * p["ay"] * (50 - 17 / 12))
    vx_f = p["vx0"] + p["ax"] * (vy_f - p["vy0"]) / p["ay"]
    toward_rf = np.degrees(np.arctan2(-vx_f, -vy_f))
    p["haa_b"] = np.where(p["stand"] == "R", toward_rf, -toward_rf)
    p["ad_match"] = p["attack_direction"] - p["haa_b"]


def add_swing_mix(s: pd.DataFrame) -> None:
    """Where each hitter swings, per season: mean x_in and z_n of his swings, and the share
    outside the zone. Location only, never outcome; it lets the location model absorb a
    hitter-level location habit that the per-pitch location cannot."""
    out = (s["x_in"].abs() > 0.83) | (s["z_n"] < 0) | (s["z_n"] > 1)
    by = s.assign(out_zone=out).groupby(["batter", "game_year"])
    s["bat_x_mean"] = by["x_in"].transform("mean")
    s["bat_z_mean"] = by["z_n"].transform("mean")
    s["bat_chase"] = by["out_zone"].transform("mean")


def check_conventions(s: pd.DataFrame) -> None:
    """Fail if attack_direction or the intercept x is not batter-relative for both hands:
    attack_direction must rise toward the opposite field (spray + = right field for a righty,
    left field for a lefty) and the intercept x must fall as the pitch comes inside."""
    bip = s[(s["cls"] == "in_play") & s["hc_x"].notna()]
    spray = np.degrees(np.arctan2(bip["hc_x"] - 125.42, 198.27 - bip["hc_y"]))
    oppo = np.where(bip["stand"] == "R", spray, -spray)
    signs = {}
    for hand in ("R", "L"):
        h = bip["stand"] == hand
        signs[f"attack_direction vs oppo ({hand})"] = np.corrcoef(
            bip.loc[h, "attack_direction"], oppo[h.to_numpy()]
        )[0, 1]
        sh = s[s["stand"] == hand]
        signs[f"-intercept_x vs x_in ({hand})"] = -sh[INTERCEPT_X].corr(sh["x_in"])
    bad = {k: round(v, 3) for k, v in signs.items() if not v > 0.1}
    if bad:
        raise ValueError(f"Savant's batter-relative conventions changed: {bad}")


def _folds(batter: pd.Series) -> np.ndarray:
    """Batter-grouped folds, so no hitter's expected swing is fitted on his own swings."""
    return (
        batter.to_numpy().astype(np.uint64)
        * np.uint64(2654435761)
        % np.uint64(2**32)
        % np.uint64(FOLDS)
    ).astype(int)


def _expected(s: pd.DataFrame, col: str, fold: np.ndarray) -> np.ndarray:
    """Cross-fitted E[col | pitch, location, count, platoon]: Huber LightGBM."""
    out = np.zeros(len(s))
    params = {
        "objective": "huber",
        "alpha": 2.0,
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 100,
        "verbose": -1,
    }
    for k in range(FOLDS):
        tr, te = fold != k, fold == k
        model = lgb.train(params, lgb.Dataset(s.loc[tr, EXPECT_INPUTS], s.loc[tr, col]), 300)
        out[te] = model.predict(s.loc[te, EXPECT_INPUTS])
    return out


def _robust_z(s: pd.DataFrame, col: str, fold: np.ndarray) -> pd.Series:
    """The swing's departure from the expected swing and from the hitter's own norm (his
    shrunk mean residual that season), in robust SDs."""
    resid = s[col] - _expected(s, col, fold)
    by = resid.groupby([s["batter"], s["game_year"]])
    resid = resid - by.transform("sum") / (by.transform("size") + NORM_SHRINK)
    mad = np.median(np.abs(resid - np.median(resid)))
    return resid / (1.4826 * mad)


def add_fooled(s: pd.DataFrame, z: float = FOOLED_Z) -> None:
    """Fooled swings, from the bat path and the pitch only (never the outcome):

    early  met the ball far out front (z_timing >= z): out ahead of a slower pitch
    late   met it far behind (z_timing <= -z): beaten
    decel  bat far slower than usual (z_speed <= -z): checked up, lunged or defended

    Count is an input to the expected swing, so a normal two-strike shortened swing is not
    decel. Fit on whole seasons: the hitter's norm needs his swings."""
    fold = _folds(s["batter"])
    s["z_timing"] = _robust_z(s, INTERCEPT_Y, fold)
    s["z_speed"] = _robust_z(s, "bat_speed", fold)
    s["early"] = s["z_timing"] >= z
    s["late"] = s["z_timing"] <= -z
    s["decel"] = s["z_speed"] <= -z
    s["fooled"] = s["early"] | s["late"] | s["decel"]


def build(pitches: pd.DataFrame) -> pd.DataFrame:
    """Tracked swings with every feature and flag."""
    add_pitch_group(pitches)
    s = swings(pitches)
    add_location(s)
    add_approach_angle(s)
    add_attack_angle_match(s)
    add_horizontal_match(s)
    check_conventions(s)
    add_fooled(s)
    add_swing_mix(s)
    return s


def report(s: pd.DataFrame) -> None:
    """Flag shares by class and pitch group, and the early flag against the velocity change
    from the previous pitch (sequencing never enters the flag, so it is an outside check)."""
    flags = ["early", "late", "decel", "fooled"]
    print(f"{len(s):,} tracked swings")
    print(s.groupby("cls")[flags].mean().round(3))
    print(s.groupby("pitch_group")[flags].mean().round(3))
    if "velo_change" in s:
        bins = pd.cut(s["velo_change"], [-40, -8, -3, 3, 8, 40])
        print(s.groupby(bins, observed=True)[flags].mean().round(3))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--start", type=dt.date.fromisoformat)
    ap.add_argument("--end", type=dt.date.fromisoformat)
    ap.add_argument("--csv", help="glob of Savant CSVs to read instead of fetching")
    ap.add_argument("--out", required=True, help=".parquet or .csv")
    a = ap.parse_args()
    if a.csv:
        pitches = pd.concat([pd.read_csv(f) for f in sorted(glob.glob(a.csv))], ignore_index=True)
    else:
        pitches = fetch(a.start, a.end)
    pitches = pitches.sort_values(["game_pk", "at_bat_number", "pitch_number"]).copy()
    pitches["velo_change"] = (
        pitches["release_speed"]
        - pitches.groupby(["game_pk", "at_bat_number"])["release_speed"].shift()
    )
    s = build(pitches)
    report(s)
    (s.to_parquet if a.out.endswith(".parquet") else s.to_csv)(a.out, index=False)


if __name__ == "__main__":
    main()
