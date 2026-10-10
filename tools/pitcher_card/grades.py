"""Constants shared by the card pipeline: pitch-type codes, the outcome families, the
letter-grade scale, the two game-score formulas and the labels the card dict carries.
The display side (palette, pitch names and colours, benchmark bins) is in
pitcher-cards/card.js, which draws the card.

Everything here is a pure function of its inputs; nothing touches the network."""

from __future__ import annotations

import bisect

# ---- pitch types --------------------------------------------------------------------
PITCH_TYPE_MAP = {
    "FF": "FF", "FA": "FF", "SI": "SI", "FT": "SI", "FC": "FC", "SL": "SL", "ST": "ST",
    "CH": "CH", "SC": "CH", "CU": "CU", "KC": "CU", "CS": "CU", "SV": "CU", "FS": "FS",
    "FO": "FS", "KN": "KN", "UN": "UN", "EP": "UN",
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


# ---- grades -------------------------------------------------------------------------
def bin_index(value: float, cuts: tuple[float, ...]) -> int:
    """Which right-closed bin ``value`` falls in: 0 for <= cuts[0] ... len(cuts) for > cuts[-1]."""
    return bisect.bisect_left(cuts, value)


LETTERS = ("F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+")
_LETTER_CUTS = (77.5, 82, 88, 92.5, 97, 103, 107.5, 112, 118, 122.5, 127, 133)


def letter_grade(value: float | None) -> str:
    """Letter for a model grade on the 100 +/- 15 scale; '-' when there is no value.
    The cut points are the old 75 +/- 10 ones at the same distances from the mean, so a
    grade still means what it did."""
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
