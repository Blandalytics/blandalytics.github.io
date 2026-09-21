"""Per-pitch metrics from the scraper's rows: everything the models, the tables and the
plots read. One pitcher's pitches in (a statfast frame), one enriched frame out."""

from __future__ import annotations

import numpy as np
import pandas as pd

from grades import DESC_MAP, FASTBALLS, PITCH_TYPE_MAP

# statfast column -> the name the original card (and the models) use
RENAME = {
    "release_speed": "velo", "release_extension": "extension", "release_spin_rate": "spin_rate",
    "spin_axis": "spin_dir", "plate_x": "pX", "plate_z": "pZ", "release_pos_x": "x0",
    "release_pos_z": "z0", "vy0": "vY0", "vz0": "vZ0", "ay": "aY", "az": "aZ", "ivb": "IVB",
    "p_throws": "hand", "at_bat_index": "abi", "pitch_number": "pitch_no",
}  # fmt: skip
KEEP = (
    "game_pk", "game_date", "inning", "stand", "sz_top", "sz_bot", "plate_time", "launch_speed",
    "launch_angle", "play_id", "post_bat_score", "post_field_score",
)  # fmt: skip
# what the stuff and PLV models need present on a pitch; the location model needs less
TRACKING = (
    "sz_top", "sz_bot", "velo", "extension", "plate_time", "HB", "IVB", "spin_rate",
    "spin_dir", "pX", "pZ", "x0", "z0", "vY0", "vZ0", "aY", "aZ",
)  # fmt: skip
LOCATION = ("sz_top", "sz_bot", "pX", "pZ")
SWINGS = ("swinging_strike", "foul_strike", "in_play")
STRIKES = ("called_strike", *SWINGS)
# the fastball a pitcher without one is measured against
FASTBALL_DEFAULTS = {
    "velo": 93.7335476546171,
    "plate_time": 0.40236545056109085,
    "IVB_acc": 79.74860324535513,
    "HB_acc": 57.48809633155189,
}
DIFF_STATS = ("HB_acc", "IVB_acc", "plate_time", "velo")


def _obj(col: pd.Series) -> pd.Series:
    """A categorical / extension column as plain objects, NaN preserved."""
    return col.astype(object).where(col.notna())


def base(df: pd.DataFrame) -> pd.DataFrame:
    """Rename the scraper's columns and normalise the basics: mapped pitch types, outcome
    families, the count *before* each pitch, and horizontal break as arm-side positive."""
    out = df.rename(columns=RENAME)
    out = out[[c for c in [*KEEP, *RENAME.values()] if c in out.columns]].copy()
    out["raw_type"] = _obj(df["pitch_type"])
    # a pitch the feed never classified is an Unknown, as the app labelled UN, not a hole
    out["pitchType"] = out["raw_type"].map(PITCH_TYPE_MAP).fillna("UN")
    out["desc"] = _obj(df["det_code"]).map(DESC_MAP)
    pre = df.groupby(["game_pk", "at_bat_index"])[["balls", "strikes"]].shift(1).fillna(0)
    out["balls"] = pre["balls"].clip(0, 3).astype(int)
    out["strikes"] = pre["strikes"].clip(0, 2).astype(int)
    out["count"] = out["balls"].astype(str) + "_" + out["strikes"].astype(str)
    zone = df["zone"].astype(float)
    out["zone"] = (zone <= 10).astype(float).where(zone.notna())
    out["hand"] = _obj(out["hand"])
    out["stand"] = _obj(out["stand"])
    out["HB"] = np.where(out["hand"] == "R", df["hb"], -df["hb"]).astype(float)
    return out


def flags(p: pd.DataFrame) -> None:
    """Result flags: strike / swing / whiff / chase, as 0-1 columns (NaN when undefined)."""
    desc = p["desc"]
    p["ca_str"] = (desc == "called_strike").astype(float)
    p["sw_str"] = (desc == "swinging_strike").astype(float)
    p["csw"] = desc.isin(["called_strike", "swinging_strike"]).astype(float)
    p["swing"] = desc.isin(SWINGS).astype(float)
    p["strike"] = desc.isin(STRIKES).astype(float)
    p["chase"] = p["swing"].where(p["zone"] == 0)
    p["whiff"] = p["sw_str"].where(p["swing"] == 1)
    p["vRHH"] = (p["stand"] == "R").astype(float).where(p["stand"] == "R")
    p["vLHH"] = (p["stand"] == "L").astype(float).where(p["stand"] == "L")


def strikezone(p: pd.DataFrame) -> None:
    """Height in 'strike zones' above the zone's midpoint, plus a plotting version that
    maps every batter's zone onto one standard zone (1.5 to 3.5 ft) and keeps pitches
    outside it at their true distance from the edge."""
    mid = (p["sz_top"] + p["sz_bot"]) / 2
    p["sz_z"] = (p["pZ"] - mid) / (p["sz_top"] - p["sz_bot"])
    below = p["pZ"] <= p["sz_bot"] + 0.25
    above = p["pZ"] >= p["sz_top"] - 0.25
    inside = p["sz_z"] * 2 + 2.5
    p["sz_plot_z"] = np.where(
        below, p["pZ"] - p["sz_bot"] + 1.5, np.where(above, p["pZ"] - p["sz_top"] + 3.5, inside)
    )


def approach_angles(p: pd.DataFrame) -> None:
    """Vertical approach angle at the plate, raw and adjusted for the pitch's height."""
    vy_f = -np.sqrt(p["vY0"] ** 2 - 2 * p["aY"] * (50 - 17 / 12))
    t = (vy_f - p["vY0"]) / p["aY"]
    vz_f = p["vZ0"] + p["aZ"] * t
    p["VAA"] = -np.degrees(np.arctan(vz_f / vy_f))
    z = p["pZ"]
    expected = np.where(z < 3.5, z * 1.5635 - 10.092, -0.1996 * z**2 + 2.704 * z - 11.69)
    p["HAVAA"] = p["VAA"] - expected


def movement(p: pd.DataFrame) -> None:
    """Total break, break as acceleration (independent of flight time) and spin direction
    mirrored so both hands share one scale."""
    p["Break"] = np.hypot(p["HB"], p["IVB"])
    p["HB_acc"] = p["HB"] / p["plate_time"] ** 2
    p["IVB_acc"] = p["IVB"] / p["plate_time"] ** 2
    p["adj_spin_dir"] = np.where(p["hand"] == "L", p["spin_dir"], 360 - p["spin_dir"])


def fastball_type(p: pd.DataFrame) -> str:
    """The pitcher's most-thrown fastball this game (alphabetical on a tie), 'NA' if none."""
    counts = p.loc[p["pitchType"].isin(FASTBALLS), "pitchType"].value_counts()
    if counts.empty:
        return "NA"
    return sorted(counts[counts == counts.max()].index)[0]


def buckets(p: pd.DataFrame, fastball: str) -> pd.Series:
    """The model family each pitch is scored by; a cutter is a fastball only when it is
    the pitcher's primary one."""
    t = p["pitchType"]
    out = pd.Series("Other", index=p.index)
    out[(t == fastball) | t.isin(["FF", "FT", "SI"])] = "Fastball"
    out[(t != fastball) & t.isin(["SL", "ST", "CU", "FC"])] = "Breaking Ball"
    out[t.isin(["CH", "FS", "KN", "SC"])] = "Offspeed"
    return out


def fastball_diffs(p: pd.DataFrame, fastball: str) -> None:
    """Each pitch's velocity, flight time and break relative to the primary fastball."""
    fb = p[p["pitchType"] == fastball]
    for stat in DIFF_STATS:
        ref = fb[stat].mean() if len(fb) else FASTBALL_DEFAULTS[stat]
        p[f"{stat}_diff"] = p[stat] - ref
    p["Break_diff"] = np.hypot(p["HB_acc_diff"], p["IVB_acc_diff"])


def pitches(df: pd.DataFrame, height: float, arm_angles: dict[str, float]) -> pd.DataFrame:
    """The full per-pitch frame for one pitcher's game. ``height`` is the pitcher's height
    in feet (the models read release point relative to it); ``arm_angles`` maps the raw
    pitch-type code to the pitcher's arm angle on that pitch."""
    p = base(df)
    p["armAngle"] = p["raw_type"].map(arm_angles).astype(float)
    flags(p)
    strikezone(p)
    approach_angles(p)
    movement(p)
    for stat in ("extension", "x0", "z0"):
        p[f"{stat}_ratio"] = p[stat] / height
    fastball = fastball_type(p)
    p["fastball_type"] = fastball
    p["bucket"] = buckets(p, fastball)
    fastball_diffs(p, fastball)
    p["usage"] = p.groupby("pitchType")["pitchType"].transform("size") / len(p)
    return p


def season(df: pd.DataFrame, game_plate_times: dict[str, float]) -> pd.DataFrame:
    """A comparison season's pitches, with their break rescaled to this game's flight
    times so shapes are compared at today's velocity."""
    p = base(df).dropna(subset=[c for c in TRACKING if c != "spin_dir"])
    flags(p)
    approach_angles(p)
    movement(p)
    t = p["pitchType"].map(game_plate_times)
    p["HB"] = p["HB_acc"] * t**2
    p["IVB"] = p["IVB_acc"] * t**2
    return p


# ---- per-pitch-type tables ----------------------------------------------------------
_GAME_AGG = {
    "n": ("pitchType", "size"), "vRHH": ("vRHH", "sum"), "vLHH": ("vLHH", "sum"),
    "Arm Angle": ("armAngle", "mean"), "Velo": ("velo", "mean"), "Ext": ("extension", "mean"),
    "IVB": ("IVB", "mean"), "HB": ("HB", "mean"), "IVB_acc": ("IVB_acc", "mean"),
    "HB_acc": ("HB_acc", "mean"), "HAVAA": ("HAVAA", "mean"), "Str%": ("strike", "mean"),
    "SwStr%": ("sw_str", "mean"), "CSW%": ("csw", "mean"), "xSLGcon": ("xSLGcon", "mean"),
    "plvStuff+": ("plvStuff+", "mean"), "PLV+": ("PLV+", "mean"),
}  # fmt: skip
_ROUND = {
    "vsL": 1, "Usage%": 1, "vsR": 1, "Velo": 1, "Ext": 1, "IVB": 1, "HB": 1, "HAVAA": 1,
    "Str%": 1, "SwStr%": 1, "CSW%": 1, "xSLGcon": 3, "plvStuff+": 0, "PLV+": 0,
}  # fmt: skip


def _shares(t: pd.DataFrame) -> None:
    """Usage overall and against each side of the plate, in percent."""
    t["Usage%"] = t["n"] / t["n"].sum() * 100
    for col, name in (("vRHH", "vsR"), ("vLHH", "vsL")):
        total = t[col].sum()
        t[name] = t[col] / total * 100 if total else np.nan
    t["pitches_vR"] = t["vRHH"].astype(int)


def game_table(p: pd.DataFrame) -> pd.DataFrame:
    """One row per pitch type, most thrown first: the numbers on the card's tables."""
    t = p.groupby("pitchType").agg(**_GAME_AGG).sort_values("n", ascending=False).reset_index()
    _shares(t)
    for col in ("Str%", "SwStr%", "CSW%"):
        t[col] *= 100
    return t.round(_ROUND)


def season_table(p: pd.DataFrame) -> pd.DataFrame:
    """The comparison season's usage and velocity by pitch type."""
    agg = {"n": ("pitchType", "size"), "vRHH": ("vRHH", "sum"), "vLHH": ("vLHH", "sum")}
    t = p.groupby("pitchType").agg(**agg, Velo=("velo", "mean")).reset_index()
    _shares(t)
    return t.round(_ROUND)


def compare(game: pd.DataFrame, szn: pd.DataFrame) -> pd.DataFrame:
    """Game usage and velocity against the comparison season: differences and arrows."""
    t = game.merge(szn, how="left", on="pitchType", suffixes=("", "_szn"))
    for stat in ("vsL", "vsR", "Velo"):
        diff = t[stat] - t[f"{stat}_szn"].fillna(t[stat])
        t[f"{stat}_diff"] = diff
        t[f"{stat}_arrow"] = np.select([diff > 0, diff < 0], ["↑", "↓"], "")
    return t
