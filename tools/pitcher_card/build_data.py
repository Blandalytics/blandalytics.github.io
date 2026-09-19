"""Assemble one card: the pitcher's game from the live feed and the scraper, scored by
the models and compared to earlier seasons, as a JSON-serialisable dict for render.py."""

from __future__ import annotations

import datetime as dt
import math

import numpy as np
import pandas as pd

import prep
import shapes
from grades import (
    GAME_TYPE_LABEL,
    PITCH_NAMES,
    TEAM_ABBR,
    VELO_DIFF,
    WHITE,
    bin_index,
    game_grade,
    letter_grade,
    run_diff_bucket,
    stat_color,
)
from models import GRADE_COLUMNS, Models

MIN_GAMES = 3  # a season needs this many appearances to be offered as a comparison
FASTBALL_PANEL = ("Velo", "Ext", "IVB", "HB", "HAVAA")
TABLE_STATS = ("Velo", "IVB", "HB", "Str%", "SwStr%", "CSW%", "xSLGcon", "plvStuff+", "PLV+")
SUFFIX = {"Ext": "'", "IVB": '"', "HB": '"', "HAVAA": "°", "Str%": "%", "SwStr%": "%", "CSW%": "%"}
COLOURED = {"Velo", "SwStr%", "CSW%", "xSLGcon", "PLV+", "plvStuff+"}
_VELO_DIFF_CUTS = (-2, -1, -0.5, 0.5, 1, 2)


def _num(v) -> float | None:
    """A float for the card dict, None for NaN so it survives JSON."""
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)


DEFAULT_HEIGHT = 6.25  # feet, as the original assumed when a height was unavailable


def parse_height(text: str | None) -> float:
    """A statsapi height such as 6' 1" in feet (6.083); the default when unusable."""
    try:
        feet, inches = str(text).replace('"', "").split("'")
        return int(feet) + int(inches) / 12
    except ValueError:
        return DEFAULT_HEIGHT


# ---- the feed -----------------------------------------------------------------------
def game_info(feed: dict, pitcher_id: int) -> dict:
    """Who, where and the box-score line, from the live feed."""
    gd, box = feed["gameData"], feed["liveData"]["boxscore"]
    side = next(s for s in ("home", "away") if pitcher_id in box["teams"][s]["pitchers"])
    opp = "away" if side == "home" else "home"
    player = gd["players"][f"ID{pitcher_id}"]
    abbr = {s: gd["teams"][s]["abbreviation"] for s in (side, opp)}
    game_type = gd["game"]["type"]
    return {
        "name": player["fullName"],
        "hand": player["pitchHand"]["code"],
        "age": player["currentAge"],
        "height": parse_height(player.get("height")),
        "team": TEAM_ABBR.get(abbr[side], abbr[side]),
        "opp": TEAM_ABBR.get(abbr[opp], abbr[opp]),
        "home": side == "home",
        "date": gd["datetime"]["officialDate"],
        "game_type": game_type,
        "label": GAME_TYPE_LABEL.get(game_type, "Box Score"),
        "starter": box["teams"][side]["pitchers"][0] == pitcher_id,
        "box": box["teams"][side]["players"][f"ID{pitcher_id}"]["stats"]["pitching"],
    }


def _count(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def game_line(box: dict, p: pd.DataFrame) -> str:
    """'6.0 IP, 1 ER, 4 Hits (1 HR), 1 BB, 9 Ks - 17 Whiffs, 34.1% CSW, 96 Pitches'"""
    hr = f" ({box['homeRuns']} HR)" if box["homeRuns"] else ""
    return (
        f"{box['inningsPitched']} IP, {box['earnedRuns']} ER, "
        f"{_count(box['hits'], 'Hit', 'Hits')}{hr}, "
        f"{_count(box['baseOnBalls'], 'BB', 'BBs')}, "
        f"{_count(box['strikeOuts'], 'K', 'Ks')} - "
        f"{_count(int(p['sw_str'].sum()), 'Whiff', 'Whiffs')}, "
        f"{p['csw'].mean() * 100:.1f}% CSW, {box['numberOfPitches']} Pitches"
    )


def outing_grade(box: dict, p: pd.DataFrame) -> str:
    """Game grade; a relief outing is scored by the situation the pitcher entered in."""
    first = p.iloc[0]
    bucket = run_diff_bucket(int(first["post_field_score"]), int(first["post_bat_score"]))
    return game_grade(box, int(first["inning"]), bucket)


# ---- scoring ------------------------------------------------------------------------
def scored_pitches(df: pd.DataFrame, info: dict, arm: dict[str, float], models: Models):
    """The prepared pitch frame with model grades, blanked where the tracking data the
    models need is missing."""
    p = prep.pitches(df, info["height"], arm)
    p[list(GRADE_COLUMNS)] = models.score(p)
    p["xSLGcon"] = models.xslg_con(p)
    missing = p[list(prep.TRACKING)].isna().any(axis=1)
    p.loc[missing, ["plvStuff+", "PLV+", "stuffGrade_game", "plvGrade_game"]] = np.nan
    p.loc[p[list(prep.LOCATION)].isna().any(axis=1), "locGrade_game"] = np.nan
    return p


def grade_summary(p: pd.DataFrame) -> dict[str, str]:
    left, right = p["stand"] == "L", p["stand"] == "R"
    return {
        "stuff": letter_grade(p["stuffGrade_game"].mean()),
        "loc": letter_grade(p["locGrade_game"].mean()),
        "plv": letter_grade(p["plvGrade_game"].mean()),
        "loc_vl": letter_grade(p.loc[left, "locGrade_game"].mean()),
        "loc_vr": letter_grade(p.loc[right, "locGrade_game"].mean()),
    }


# ---- the tables ---------------------------------------------------------------------
def _cell(code: str, stat: str, value: float) -> dict:
    """Display text and colour for one stat of one pitch type."""
    if value != value:
        return {"text": "-", "color": WHITE}
    colour = stat_color(code, stat, value) if stat in COLOURED else WHITE
    if stat == "xSLGcon":
        return {"text": f"{value:.3f}".lstrip("0"), "color": colour}
    if stat in ("Str%", "SwStr%", "CSW%", "PLV+", "plvStuff+"):
        return {"text": f"{round(value):d}{SUFFIX.get(stat, '')}", "color": colour}
    return {"text": f"{value:.1f}{SUFFIX.get(stat, '')}", "color": colour}


def type_rows(table: pd.DataFrame) -> list[dict]:
    """One entry per pitch type for the usage panel and the metrics table."""
    rows = []
    for r in table.to_dict("records"):
        code = r["pitchType"]
        rows.append(
            {
                "code": code,
                "name": PITCH_NAMES.get(code, code),
                "n": int(r["n"]),
                "usage": _num(r["Usage%"]),
                "vsR": _num(r["vsR"]),
                "vsL": _num(r["vsL"]),
                "cells": {s: _cell(code, s, r[s]) for s in TABLE_STATS},
            }
        )
    return rows


def fastball_panel(table: pd.DataFrame) -> dict | None:
    """The primary fastball's shape, coloured against its pitch type's benchmarks."""
    fb = table[table["pitchType"].isin(["FF", "SI", "FC"])]
    if fb.empty:
        return None
    r = fb.iloc[0]
    code = r["pitchType"]
    stats = []
    for stat in FASTBALL_PANEL:
        key = f"{stat}_acc" if stat in ("IVB", "HB") else stat
        colour = stat_color(code, stat, r[key], key=key)
        text = "-" if r[stat] != r[stat] else f"{r[stat]:.1f}{SUFFIX.get(stat, '')}"
        stats.append({"label": stat, "text": text, "color": colour})
    return {"code": code, "name": PITCH_NAMES[code], "stats": stats}


# ---- comparison seasons -------------------------------------------------------------
def _velo_diff(diff: float) -> dict:
    colour = VELO_DIFF[2 * bin_index(diff, _VELO_DIFF_CUTS)]
    return {"text": f" ({diff:+.1f})", "color": colour}


def comparison(p: pd.DataFrame, table: pd.DataFrame, season_df: pd.DataFrame, year: int):
    """Usage arrows, velocity changes and movement regions against one season."""
    plate_times = p.groupby("pitchType")["plate_time"].mean().to_dict()
    s = prep.season(season_df, plate_times)
    sign = 1 if p["hand"].iloc[0] == "R" else -1
    s = s[s["pitchType"].isin(p["pitchType"].unique())].dropna(subset=["HB", "IVB"])
    points = {t: np.c_[g["HB"] * sign, g["IVB"]] for t, g in s.groupby("pitchType")}
    cmp = prep.compare(table, prep.season_table(s))
    return {
        "year": year,
        "shapes": shapes.shapes(points),
        "types": {
            r.pitchType: {
                "vsR_arrow": r.vsR_arrow,
                "vsL_arrow": r.vsL_arrow,
                "velo": _velo_diff(r.Velo_diff),
            }
            for r in cmp.itertuples(index=False)
        },
    }


def comparisons(p: pd.DataFrame, table: pd.DataFrame, seasons: dict[int, pd.DataFrame]):
    """Every season with enough appearances, most recent first."""
    out = []
    for year in sorted(seasons, reverse=True):
        if seasons[year]["game_pk"].nunique() >= MIN_GAMES:
            out.append(comparison(p, table, seasons[year], year))
    return out


# ---- the plots ----------------------------------------------------------------------
def plot_points(p: pd.DataFrame) -> list[dict]:
    """Each pitch's movement (in its true direction) and its location on the standard
    zone, from the batter's side of the plate."""
    sign = np.where(p["hand"] == "R", 1, -1)
    return [
        {"t": t, "hb": _num(hb), "ivb": _num(ivb), "x": _num(x), "z": _num(z), "stand": stand}
        for t, hb, ivb, x, z, stand in zip(
            *(
                p["pitchType"],
                p["HB"] * sign,
                p["IVB"],
                (-p["pX"]).clip(-2, 2),
                p["sz_plot_z"].clip(-0.25, 5.25),
                p["stand"],
            ),
            strict=True,
        )
    ]


def chart_limit(p: pd.DataFrame) -> int:
    """Half-width of the movement plot in inches: at least 29, grown to fit the biggest break."""
    biggest = p[["HB", "IVB"]].abs().max().max()
    if biggest != biggest:
        return 29
    return max(29, int(biggest / 6 + 2) * 6 - 1)


# ---- the card -----------------------------------------------------------------------
def build(
    game_pk: int,
    pitcher_id: int,
    feed: dict,
    df: pd.DataFrame,
    seasons: dict[int, pd.DataFrame],
    arm_angles: dict[str, float],
    models: Models,
) -> dict:
    """The card dict for one pitcher's game. ``df`` is that pitcher's pitches from
    statfast; ``seasons`` maps year -> the same pitcher's regular-season pitches from
    before this game."""
    info = game_info(feed, pitcher_id)
    p = scored_pitches(df, info, arm_angles, models)
    table = prep.game_table(p)
    date = dt.date.fromisoformat(info["date"])
    grades = {"game": outing_grade(info["box"], p), **grade_summary(p)}
    at = "vs" if info["home"] else "@"
    return {
        "game_pk": game_pk,
        "pitcher_id": pitcher_id,
        **{k: info[k] for k in ("name", "hand", "age", "team", "opp", "home", "date", "label")},
        "starter": info["starter"],
        "title": f"Pitcher Performance: {date.month}/{date.day}/{date.year} {at} {info['opp']}",
        "bio": f"{info['hand']}HP | {info['team']} | Age: {info['age']}",
        "line": game_line(info["box"], p),
        "grades": grades,
        "n_vl": int(p["vLHH"].sum()),
        "n_vr": int(p["vRHH"].sum()),
        "arm_angle": _num(p["armAngle"].mean()),
        "chart_lim": chart_limit(p),
        "fastball": fastball_panel(table),
        "types": type_rows(table),
        "pitches": plot_points(p),
        "missing_data": bool(p[list(prep.TRACKING)].isna().any(axis=1).any()),
        "comparisons": comparisons(p, table, seasons),
    }
