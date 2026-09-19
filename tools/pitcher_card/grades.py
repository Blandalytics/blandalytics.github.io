"""Constants shared by the card pipeline: the palette, pitch-type names and colours,
per-pitch-type benchmark bins, the letter-grade scale and the two game-score formulas.

Everything here is a pure function of its inputs; nothing touches the network."""

from __future__ import annotations

import bisect

# ---- palette ------------------------------------------------------------------------
BACKGROUND = "#292C42"
WHITE = "#FFFFFF"
TEXT = "#00D4FF"
LINE = "#8D96B3"
HIGHLIGHT = "#F1C647"
LINE_TEXT = "#bae2ff"  # the box-score line under the title
NAME_GRADIENT = ("#00D4FF", "#0099CC")

MARKER_COLORS = {
    "FF": "#FF6683",
    "SI": "#F2B24B",
    "FS": "#83D6FF",
    "FC": "#C59C9C",
    "SL": "#CE66FF",
    "ST": "#FFAAF7",
    "CU": "#339cff",
    "CH": "#6DE95D",
    "KN": "#c7c7c7",
    "UN": "#c7c7c7",
}


def _rgb(h: str) -> tuple[int, int, int]:
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))


def _mix(a: str, b: str, t: float) -> str:
    return "#" + "".join(
        f"{round(x + (y - x) * t):02x}" for x, y in zip(_rgb(a), _rgb(b), strict=True)
    )


def blend(stops: tuple[str, ...], n: int) -> list[str]:
    """seaborn.blend_palette: ``n`` colours linearly interpolated through ``stops``."""
    steps = len(stops) - 1
    out = []
    for i in range(n):
        pos = i / (n - 1) * steps
        k = min(int(pos), steps - 1)
        out.append(_mix(stops[k], stops[k + 1], pos - k))
    return out


_DIVERGE_STOPS = ("#4BBFDF", "#FFFFFF", "#ff5757")
DIVERGE = blend(_DIVERGE_STOPS, 5)  # stat colours, worst -> best
VELO_DIFF = blend(_DIVERGE_STOPS, 13)  # velo change vs the comparison season
_GRADE_PALETTE = blend(_DIVERGE_STOPS, 9)

LETTERS = ("F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+")
# a letter's colour is its family's (D-, D and D+ share one), A+ gets the highlight
GRADE_COLORS = {"-": WHITE, "A+": HIGHLIGHT}
GRADE_COLORS.update({g: _GRADE_PALETTE[2 * i] for i, g in enumerate(("F", "D", "C", "B", "A"))})
GRADE_COLORS.update({g: GRADE_COLORS[g[0]] for g in LETTERS if g not in GRADE_COLORS})

# ---- pitch types --------------------------------------------------------------------
PITCH_TYPE_MAP = {
    "FF": "FF", "FA": "FF", "SI": "SI", "FT": "SI", "FC": "FC", "SL": "SL", "ST": "ST",
    "CH": "CH", "SC": "CH", "CU": "CU", "KC": "CU", "CS": "CU", "SV": "CU", "FS": "FS",
    "FO": "FS", "KN": "KN", "UN": "UN", "EP": "UN",
}  # fmt: skip
PITCH_NAMES = {
    "FF": "Four-Seam", "SI": "Sinker", "FC": "Cutter", "SL": "Slider", "ST": "Sweeper",
    "CU": "Curveball", "CH": "Changeup", "FS": "Splitter", "KN": "Knuckleball", "UN": "Unknown",
}  # fmt: skip
FASTBALLS = ("FF", "SI", "FT", "FC")

# statsapi pitch result codes -> the outcome families the models are trained on
DESC_MAP = {
    **dict.fromkeys(("S", "W", "T", "M", "O"), "swinging_strike"),
    "C": "called_strike",
    **dict.fromkeys(("F", "L"), "foul_strike"),
    **dict.fromkeys(("D", "E", "X"), "in_play"),
    **dict.fromkeys(("B", "*B", "P"), "ball"),
    **dict.fromkeys(("1", "2", "3"), "pickoff"),
    "H": "hit_by_pitch",
    "PSO": "step_off",
}

# ---- benchmark bins -----------------------------------------------------------------
# Inner cut points of five bins per stat, by pitch type: the coloured stats on the card
# take the colour of the bin they fall in. Omitted stats stay white.
TYPE_BINS: dict[str, dict[str, tuple[float, ...]]] = {
    "FF": {
        "Velo": (90.2, 93.2, 95.6, 98.2), "IVB": (10, 14.3, 16.9, 19.2),
        "IVB_acc": (66.9, 91.7, 107.5, 121.6), "HB": (1.6, 5.9, 9.6, 13.7),
        "HB_acc": (9.7, 36, 59, 84.7), "HAVAA": (0.13, 0.72, 1.2, 1.74),
        "SwStr%": (1, 5.9, 13, 22.8), "CSW%": (0, 20, 100 / 3, 50),
        "xSLGcon": (0.125, 0.390, 0.725, 1.385), "plvStuff+": (80, 88, 105, 114),
        "PLV+": (79, 94, 106, 117),
    },
    "SI": {
        "Velo": (89.1, 92.4, 95.1, 97.7), "IVB": (0.5, 6.3, 10.5, 15.1),
        "IVB_acc": (7.3, 37, 61.3, 88), "HB": (9.5, 13.9, 16.4, 18.5),
        "HB_acc": (62.5, 86, 100.6, 116), "HAVAA": (-0.27, 0.33, 0.83, 1.42),
        "SwStr%": (1, 2.8, 7.8, 16.6), "CSW%": (0, 100 / 6, 100 / 3, 50),
        "xSLGcon": (0.15, 0.340, 0.585, 1.095), "plvStuff+": (69, 74, 83, 95),
        "PLV+": (76, 91, 104, 116),
    },
    "FC": {
        "Velo": (85, 88, 90.7, 93.8), "IVB": (1.95, 6.2, 9.3, 13.2),
        "IVB_acc": (15.7, 36.5, 54.5, 77.8), "HB": (-6.1, -3.6, -0.8, 2.7),
        "HB_acc": (-35.8, -20.8, -7.3, 9.9), "HAVAA": (-0.9, -0.216, 0.41, 1.12),
        "SwStr%": (1, 6.3, 15, 25), "CSW%": (0, 100 / 6, 100 / 3, 50),
        "xSLGcon": (0.115, 0.320, 0.62, 1.29), "plvStuff+": (90, 107, 115, 125),
        "PLV+": (85, 99, 111, 122),
    },
    "SL": {
        "Velo": (80.9, 84.6, 87.3, 90), "IVB": (-4.2, -0.2, 3.6, 7.6),
        "HB": (-11.9, -5.9, -2.8, 0), "SwStr%": (5, 11.1, 20, 32),
        "CSW%": (0, 20, 100 / 3, 50), "xSLGcon": (0.105, 0.315, 0.6, 1.265),
        "plvStuff+": (95, 100, 110, 125), "PLV+": (85, 98, 109, 119),
    },
    "ST": {
        "Velo": (77.3, 80.8, 83.4, 86.2), "IVB": (-5.4, -0.9, 3, 7.3),
        "HB": (-19.1, -15.5, -12.2, -8.4), "SwStr%": (5, 10, 18.9, 31),
        "CSW%": (0, 20, 100 / 3, 50), "xSLGcon": (0.08, 0.275, 0.575, 1.275),
        "plvStuff+": (105, 111, 120, 130), "PLV+": (85, 100, 110, 122),
    },
    "CU": {
        "Velo": (73.8, 78.2, 81.7, 85.8), "IVB": (-16.6, -12.6, -7.4, -1.5),
        "HB": (-16.3, -11.1, -6.2, -1.3), "SwStr%": (4, 9.1, 18.7, 31.2),
        "CSW%": (0, 100 / 6, 40, 200 / 3), "xSLGcon": (0.105, 0.290, 0.585, 1.25),
        "plvStuff+": (91, 100, 113, 125), "PLV+": (82, 95, 107, 118),
    },
    "CH": {
        "Velo": (80.3, 84.8, 88.1, 91), "IVB": (-1.5, 3.1, 7.4, 12.1),
        "HB": (8.8, 13.2, 15.9, 18.3), "SwStr%": (5, 11.5, 21, 33.3),
        "CSW%": (0, 10, 30, 50), "xSLGcon": (0.115, 0.285, 0.53, 1.085),
        "plvStuff+": (100, 107, 115, 125), "PLV+": (80, 95, 107, 119),
    },
    "FS": {
        "Velo": (82, 84.9, 88.1, 92.3), "IVB": (-2, 1.5, 5.4, 10.3),
        "HB": (4.3, 8.8, 12.7, 15.9), "SwStr%": (6, 11.6, 22.2, 35.2),
        "CSW%": (0, 10, 100 / 3, 50), "xSLGcon": (0.12, 0.290, 0.56, 1.15),
        "plvStuff+": (100, 107, 115, 125), "PLV+": (80, 94, 105, 116),
    },
}  # fmt: skip
for _bins in TYPE_BINS.values():
    _bins["Ext"] = (5.75, 6.25, 6.66, 7.13)
# lower is better for expected slugging, so its colour scale runs the other way
_INVERTED = {"xSLGcon"}


def bin_index(value: float, cuts: tuple[float, ...]) -> int:
    """Which right-closed bin ``value`` falls in: 0 for <= cuts[0] ... len(cuts) for > cuts[-1]."""
    return bisect.bisect_left(cuts, value)


def stat_color(pitch_type: str, stat: str, value: float | None, key: str | None = None) -> str:
    """Colour for a stat value on the benchmark scale of its pitch type, white if unknown.
    ``key`` picks a different set of cut points than the stat's own (the fastball panel
    colours movement by its acceleration bins)."""
    cuts = TYPE_BINS.get(pitch_type, {}).get(key or stat)
    if cuts is None or value is None or value != value:
        return WHITE
    idx = bin_index(value, cuts)
    return DIVERGE[4 - idx if stat in _INVERTED else idx]


# ---- grades -------------------------------------------------------------------------
_LETTER_CUTS = (60, 63, 67, 70, 73, 77, 80, 83, 87, 90, 93, 97)


def letter_grade(value: float | None) -> str:
    """Letter for a model grade on the 75 +/- 10 scale; '-' when there is no value."""
    if value is None or value != value:
        return "-"
    return LETTERS[bin_index(value, _LETTER_CUTS)]


_SP_CUTS = (12, 22.3, 30, 36.6, 41, 47.6, 53.6, 60.6, 67, 74, 82.3, 95)
_RP_CUTS = (27, 37, 42, 46, 48, 50, 51, 52, 53, 56, 61, 67)

# Reliever game-score weights by (inning, run differential bucket). The inning is clipped
# to 4-9 and the bucket is 0-3: a lead of one run is 0, two is 1, three is 2, four or more
# is 3; a tie is 0 and a deficit of n runs is min(n, 3).
_RP_WEIGHTS = {
    "out": {
        (4, 0): 3, (4, 1): 3, (4, 2): 2, (4, 3): 1, (5, 0): 4, (5, 1): 3, (5, 2): 2, (5, 3): 1,
        (6, 0): 4, (6, 1): 3, (6, 2): 2, (6, 3): 1, (7, 0): 4, (7, 1): 3, (7, 2): 2, (7, 3): 1,
        (8, 0): 5, (8, 1): 3, (8, 2): 2, (8, 3): 1, (9, 0): 6, (9, 1): 4, (9, 2): 2, (9, 3): 1,
    },
    "strikeout": {
        (4, 0): 3, (4, 1): 2, (4, 2): 2, (4, 3): 1, (5, 0): 4, (5, 1): 3, (5, 2): 2, (5, 3): 1,
        (6, 0): 4, (6, 1): 3, (6, 2): 2, (6, 3): 1, (7, 0): 5, (7, 1): 4, (7, 2): 2, (7, 3): 1,
        (8, 0): 6, (8, 1): 4, (8, 2): 2, (8, 3): 1, (9, 0): 9, (9, 1): 7, (9, 2): 6, (9, 3): 1,
    },
    "walk": {
        (4, 0): -3, (4, 1): -2, (4, 2): -2, (4, 3): -1, (5, 0): -3, (5, 1): -2, (5, 2): -2,
        (5, 3): -1, (6, 0): -3, (6, 1): -3, (6, 2): -2, (6, 3): -1, (7, 0): -4, (7, 1): -3,
        (7, 2): -2, (7, 3): -1, (8, 0): -4, (8, 1): -3, (8, 2): -2, (8, 3): -1, (9, 0): -5,
        (9, 1): -4, (9, 2): -2, (9, 3): -1,
    },
    "hit": {
        (4, 0): -8, (4, 1): -7, (4, 2): -6, (4, 3): -2, (5, 0): -10, (5, 1): -9, (5, 2): -6,
        (5, 3): -2, (6, 0): -11, (6, 1): -8, (6, 2): -6, (6, 3): -2, (7, 0): -12, (7, 1): -8,
        (7, 2): -5, (7, 3): -2, (8, 0): -15, (8, 1): -8, (8, 2): -5, (8, 3): -1, (9, 0): -21,
        (9, 1): -9, (9, 2): -4, (9, 3): -1,
    },
    "home_run": {
        (4, 0): -17, (4, 1): -14, (4, 2): -11, (4, 3): -4, (5, 0): -21, (5, 1): -18, (5, 2): -14,
        (5, 3): -4, (6, 0): -23, (6, 1): -17, (6, 2): -12, (6, 3): -3, (7, 0): -26, (7, 1): -17,
        (7, 2): -11, (7, 3): -3, (8, 0): -33, (8, 1): -18, (8, 2): -9, (8, 3): -2, (9, 0): -43,
        (9, 1): -18, (9, 2): -8, (9, 3): -1,
    },
}  # fmt: skip


def is_relief_outing(box: dict) -> bool:
    """Short outings are graded on the leverage-aware reliever scale."""
    short = box["gamesStarted"] == 0 and box["outs"] < 11
    return short or box["battersFaced"] <= 6


def run_diff_bucket(field_score: int, bat_score: int) -> int:
    diff = max(-3, min(4, field_score - bat_score))
    return diff - 1 if diff > 0 else abs(diff)


def starter_game_score(box: dict) -> float:
    """Bill James' game score, from the box-score pitching line."""
    return (
        30
        + 8 / 3 * box["outs"]
        + 2 * box["strikeOuts"]
        - 2 * box["baseOnBalls"]
        - box["hits"]
        - 7 * box["earnedRuns"]
        - box["homeRuns"]
    )


def reliever_game_score(box: dict, inning: int, run_bucket: int) -> float:
    """Leverage-weighted score for a relief outing, keyed by when the pitcher entered."""
    key = (max(4, min(9, inning)), run_bucket)
    w = {k: v[key] for k, v in _RP_WEIGHTS.items()}
    return (
        50
        + (box["outs"] - box["strikeOuts"]) * w["out"]
        + box["strikeOuts"] * w["strikeout"]
        + box["baseOnBalls"] * w["walk"]
        + box["hits"] * w["hit"]
        + box["homeRuns"] * w["home_run"]
    )


def game_grade(box: dict, inning: int, run_bucket: int) -> str:
    """Letter grade for the outing: game score on the starter or reliever scale."""
    if is_relief_outing(box):
        return LETTERS[bin_index(reliever_game_score(box, inning, run_bucket), _RP_CUTS)]
    return LETTERS[bin_index(starter_game_score(box), _SP_CUTS)]


GAME_TYPE_LABEL = {
    "R": "Box Score", "S": "Spring\nTraining", "E": "Exhibition", "A": "All-Star\nGame",
    "F": "Playoffs", "D": "Playoffs", "L": "Playoffs", "W": "World\nSeries",
}  # fmt: skip
TEAM_ABBR = {"AZ": "ARI", "KC": "KCR", "SD": "SDP", "SF": "SFG", "TB": "TBR"}
