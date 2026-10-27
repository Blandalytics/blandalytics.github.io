"""Season-long pitcher cards (a demo): a pitcher's regular season, pooled from the
bucket's per-day card data into a card dict that card.js draws with its season layout.

    python season.py --out ../../pitcher-cards/season-demo 694819 808967   # these pitchers
    python season.py --cuts                                                 # the season cuts

Every MLB day of the regular season (cards/mlb/data/<date>.json: each card with every
pitch's movement, location, call, event and model values) is fetched once into --cache.
A pitcher's cards are pooled into:

- the summary line: IP, ERA, WHIP, K% and BB% from MLB's season line, SLGcon (total bases
  per at-bat ending in a ball in play) and CSW% from the pitches;
- the Stuff, Location and PLV means, each game's mean weighted by the pitches it graded;
  card.js letters them on its SEASON_GRADE_CUTS, which --cuts fits as grade_cuts.py fits
  the game cuts (every pitcher's season, weighted by his pitches, to grade_cuts.TARGET);
- the usage and the pitch type table, from the pitches as prep.game_table makes a game's;
  the primary fastball's extension and HAVAA, which the pitches don't carry, are its
  games' values weighted by its pitches in them;
- the movement and location plots as three KDE tiers per pitch type, every type in a plot
  smoothed alike (one kernel per plot, see `kernel`; the grid cut 3 bandwidths past the
  data). The outermost tier is
  the region around the type's densest pitches (ranked by the KDE at each pitch): 75% of
  them in Movement, its densest 100 in a location plot (75% of a type with fewer than
  134 there, so a few strays can't stretch it). The inner tiers hold two thirds and one
  third as many. A type with fewer than KDE_MIN pitches in a plot is drawn as its pitches.

There are no comparison seasons on a season card."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import gzip
import json
import os
import sys
from collections import defaultdict

import numpy as np
import requests

from grades import DESC_MAP
from shapes import _paths

BUCKET = "https://data.blandalytics.com/cards"
STATSAPI = "https://statsapi.mlb.com/api/v1"
FASTBALLS = ("FF", "SI", "FC")
TYPE_STATS = ("Velo", "IVB", "HB", "Str%", "SwStr%", "CSW%", "xSLGcon", "plvStuff+", "PLV+")
MOVEMENT_SHARE = 0.75  # Movement's outer tier: the type's densest 75% of pitches
LOCATION_PITCHES = 100  # a location plot's: its densest 100 (or 75%, if that's fewer)
TIER_SHARES = (1, 2 / 3, 1 / 3)  # each tier's pitches against the outer tier's
GRIDSIZE = 150
CUT = 3
KDE_MIN = 10
TOTAL_BASES = {"single": 1, "double": 2, "triple": 3, "home_run": 4}
SACRIFICES = {"sac_fly", "sac_bunt", "sac_fly_double_play", "sac_bunt_double_play"}
DEFAULT_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "season")


# ---- the bucket ---------------------------------------------------------------------
def regular_season(s: requests.Session, year: int) -> tuple[str, str]:
    se = s.get(f"{STATSAPI}/seasons/{year}", params={"sportId": 1}, timeout=30).json()["seasons"][0]
    return se["regularSeasonStartDate"], se["regularSeasonEndDate"]


def day_files(s: requests.Session, year: int, cache: str) -> list[str]:
    """The cached path of each MLB day's card data in the regular season, fetched as needed."""
    first, last = regular_season(s, year)
    days = s.get(f"{BUCKET}/index.json", params={"v": dt.datetime.now().timestamp()}, timeout=60)
    dates = sorted(d for d in days.json()["levels"]["mlb"]["days"] if first <= d <= last)
    os.makedirs(cache, exist_ok=True)

    def get(d: str) -> str:
        path = os.path.join(cache, f"{d}.json.gz")
        if not os.path.exists(path):
            r = s.get(f"{BUCKET}/mlb/data/{d}.json", timeout=120)
            r.raise_for_status()
            with gzip.open(path + ".part", "wb") as fh:
                fh.write(r.content)
            os.replace(path + ".part", path)
        return path

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        return list(pool.map(get, dates))


def cards(paths: list[str]):
    """Every card in the day files, oldest day first."""
    for path in paths:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            yield from json.load(fh).values()


# ---- pooling ------------------------------------------------------------------------
def _num(v, n=None):
    if v is None or v != v:
        return None
    return round(float(v), n) if n is not None else float(v)


def graded(card: dict) -> dict[str, int]:
    """How many of a game's pitches each of its skill means averages: Stuff and PLV need the
    tracking a pitch's Stuff+ is blank without, Location its plotted location."""
    ps = card["pitches"]
    located = [p for p in ps if p.get("x") is not None and p.get("z") is not None]
    n = sum(p.get("plvStuff+") is not None for p in ps)
    return {
        "stuff": n, "plv": n, "loc": len(located),
        "loc_vl": sum(p["stand"] == "L" for p in located),
        "loc_vr": sum(p["stand"] == "R" for p in located),
    }  # fmt: skip


def season_skills(games: list[dict]) -> dict[str, float | None]:
    """Each skill's season mean: the games' means weighted by the pitches they graded."""
    keys = ("stuff", "loc", "plv", "loc_vl", "loc_vr")
    return {k: _weighted([(g["skills"].get(k), graded(g)[k]) for g in games]) for k in keys}


def _mean(values) -> float | None:
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def _weighted(pairs: list[tuple[float | None, int]]) -> float | None:
    """The mean of (value, weight) pairs, skipping blank values."""
    pairs = [(v, n) for v, n in pairs if v is not None and n]
    w = sum(n for _, n in pairs)
    return sum(v * n for v, n in pairs) / w if w else None


def _pct(part: int, whole: int, digits: int = 1) -> float | None:
    return _num(100 * part / whole, digits) if whole else None


def _desc(p: dict) -> str | None:
    """A pitch's outcome family (grades.DESC_MAP): called_strike, swinging_strike, ..."""
    return DESC_MAP.get(p.get("d"))


def _event(e: str | None) -> str | None:
    """A pitch's event as the feed codes it: older cards carry the code ("home_run"), newer
    ones the name ("Home Run")."""
    return e.lower().replace(" ", "_") if e else None


def type_rows(pitches: list[dict], hand: str) -> list[dict]:
    """The usage panel's and metrics table's rows, most thrown first (alphabetical on a
    tie), as prep.game_table makes them from a game's pitches."""
    sign = 1 if hand == "R" else -1
    by = defaultdict(list)
    for p in pitches:
        by[p["t"]].append(p)
    sides = {s: sum(p["stand"] == s for p in pitches) for s in "LR"}
    rows = []
    for code, ps in sorted(by.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        desc = [_desc(p) for p in ps]
        swing = ("swinging_strike", "foul_strike", "in_play")
        values = {
            "Velo": _mean(p.get("velo") for p in ps),
            "IVB": _mean(p.get("ivb") for p in ps),
            "HB": _mean(p["hb"] * sign if p.get("hb") is not None else None for p in ps),
            "Str%": 100 * sum(d in ("called_strike", *swing) for d in desc) / len(ps),
            "SwStr%": 100 * sum(d == "swinging_strike" for d in desc) / len(ps),
            "CSW%": 100 * sum(d in ("called_strike", "swinging_strike") for d in desc) / len(ps),
            "xSLGcon": _mean(p.get("xSLGcon") for p in ps),
            "plvStuff+": _mean(p.get("plvStuff+") for p in ps),
            "PLV+": _mean(p.get("PLV+") for p in ps),
        }
        digits = {"xSLGcon": 3, "plvStuff+": 0, "PLV+": 0}
        rows.append(
            {
                "code": code,
                "n": len(ps),
                "usage": _pct(len(ps), len(pitches)),
                "vsR": _pct(sum(p["stand"] == "R" for p in ps), sides["R"]),
                "vsL": _pct(sum(p["stand"] == "L" for p in ps), sides["L"]),
                "values": {k: _num(v, digits.get(k, 1)) for k, v in values.items()},
            }
        )  # fmt: skip
    return rows


def fastball(rows: list[dict], games: list[dict]) -> dict | None:
    """The season's primary fastball: its pitches' Velo, IVB and HB, and the extension,
    HAVAA and break-per-plate-time (what IVB and HB are coloured by) of the games it led,
    weighted by its pitches in them."""
    fb = next((r for r in rows if r["code"] in FASTBALLS), None)
    if fb is None:
        return None
    values = {k: fb["values"][k] for k in ("Velo", "IVB", "HB")}
    led = [(g["fastball"]["values"], next(t["n"] for t in g["types"] if t["code"] == fb["code"]))
           for g in games if (g.get("fastball") or {}).get("code") == fb["code"]]  # fmt: skip
    for k in ("Ext", "HAVAA", "IVB_acc", "HB_acc"):
        values[k] = _num(
            _weighted([(v.get(k), n) for v, n in led]), 1 if k in ("Ext", "HAVAA") else None
        )
    return {"code": fb["code"], "values": values}


# ---- the KDE tiers ------------------------------------------------------------------
def kernel(groups: list[np.ndarray]) -> np.ndarray | None:
    """One plot's smoothing kernel, a covariance shared by all its pitch types: Scott's rule
    (factor n^-1/6 in two dimensions) on all the plot's pitches, their spread measured
    within their own types (the pooled covariance). A type's own Scott kernel widens as its
    sample shrinks, so a pitch thrown 20 times would be smoothed several times wider than
    the fastball beside it; this smooths every type alike. None if it is degenerate."""
    usable = [g for g in groups if len(g) >= 2]
    dof = sum(len(g) - 1 for g in usable)
    if not dof:
        return None
    pooled = sum((len(g) - 1) * np.cov(g.T) for g in usable) / dof
    cov = pooled * sum(len(g) for g in groups) ** (-1 / 3)
    return cov if np.linalg.det(cov) > 0 else None


def density(points: np.ndarray, at: np.ndarray, cov: np.ndarray) -> np.ndarray:
    """The KDE of ``points`` with kernel covariance ``cov``, at each of ``at`` (unnormalised:
    only its levels against itself matter). The points are whitened by ``cov``, so the
    kernel is a unit Gaussian there, and the sums go a block of ``at`` at a time."""
    w = np.linalg.inv(np.linalg.cholesky(cov))
    p, q = points @ w.T, at @ w.T
    pp = (p**2).sum(axis=1)
    out = np.empty(len(q))
    for i in range(0, len(q), 2048):
        b = q[i : i + 2048]
        d2 = (b**2).sum(axis=1)[:, None] + pp[None, :] - 2 * b @ p.T
        out[i : i + 2048] = np.exp(-0.5 * np.maximum(d2, 0)).sum(axis=1)
    return out


def tiers(xy: np.ndarray, inside: int, cov: np.ndarray) -> list[list[str]]:
    """One type's KDE regions, outermost first, as path data in tenths (shapes._paths). The
    outermost holds the ``inside`` pitches the KDE puts densest: its edge is the density at
    the last of them, so exactly they lie within it; the inner tiers' edges are the
    densities at two thirds and a third of the way."""
    bw = np.sqrt(np.diag(cov))
    lo, hi = xy.min(axis=0) - bw * CUT, xy.max(axis=0) + bw * CUT
    gx, gy = np.linspace(lo[0], hi[0], GRIDSIZE), np.linspace(lo[1], hi[1], GRIDSIZE)
    xx, yy = np.meshgrid(gx, gy)
    z = density(xy, np.column_stack([xx.ravel(), yy.ravel()]), cov).reshape(xx.shape)
    at = np.sort(density(xy, xy, cov))[::-1]  # the density at each pitch, densest first
    return [_paths(gx, gy, z, float(at[max(1, round(inside * f)) - 1])) for f in TIER_SHARES]


def movement_floor(n: int) -> int:
    return round(MOVEMENT_SHARE * n)


def location_floor(n: int) -> int:
    return min(LOCATION_PITCHES, round(MOVEMENT_SHARE * n))


def layers(pitches, xkey: str, ykey: str, scale: float, order: list[str], floor) -> list[dict]:
    """Each pitch type's tiers in one plot, most thrown first, all on the plot's one kernel;
    its points (in the plot's own units) instead when it has too few for a KDE. ``floor(n)``
    is how many of a type's n pitches its outer tier holds. The tiers are in plot units x
    ``scale`` (locations go in inches, so the paths keep their tenths)."""
    by = {}
    for code in order:
        pts = [
            (p[xkey], p[ykey])
            for p in pitches
            if p["t"] == code and None not in (p.get(xkey), p.get(ykey))
        ]
        if pts:
            by[code] = np.array(pts, dtype=float)
    cov = kernel([xy * scale for xy in by.values()])
    out = []
    for code, xy in by.items():
        if cov is not None and len(xy) >= KDE_MIN:
            out.append({"code": code, "tiers": tiers(xy * scale, floor(len(xy)), cov)})
        else:
            out.append({"code": code, "points": np.round(xy, 2).tolist()})
    return out


# ---- the season card ----------------------------------------------------------------
def season_line(s: requests.Session, pid: int, year: int) -> dict:
    """MLB's regular-season pitching line; the all-teams total for a traded pitcher."""
    q = {"stats": "season", "group": "pitching", "season": year, "sportId": 1, "gameType": "R"}
    splits = s.get(f"{STATSAPI}/people/{pid}/stats", params=q, timeout=30).json()["stats"][0][
        "splits"
    ]
    total = [x for x in splits if "team" not in x] or splits
    return total[0]["stat"]


def summary(stat: dict, pitches: list[dict]) -> tuple[str, dict]:
    """'174.2 IP, 1.80 ERA, 0.80 WHIP, 37.9% K, 6.6% BB, .419 SLGcon, 35.4% CSW' and its numbers."""
    bf = stat["battersFaced"]
    events = [_event(p.get("e")) for p in pitches if _desc(p) == "in_play"]
    at_bats = [e for e in events if e not in SACRIFICES]  # the balls in play that end an at-bat
    slg = sum(TOTAL_BASES.get(e, 0) for e in at_bats) / len(at_bats) if at_bats else None
    csw = (
        100 * sum(_desc(p) in ("called_strike", "swinging_strike") for p in pitches) / len(pitches)
    )
    nums = {
        "IP": stat["inningsPitched"], "ERA": stat["era"], "WHIP": stat["whip"],
        "K%": 100 * stat["strikeOuts"] / bf, "BB%": 100 * stat["baseOnBalls"] / bf,
        "SLGcon": slg, "CSW%": csw,
    }  # fmt: skip
    slg_text = f"{slg:.3f}".lstrip("0") if slg is not None else "-"
    line = (f"{nums['IP']} IP, {nums['ERA']} ERA, {nums['WHIP']} WHIP, {nums['K%']:.1f}% K, "
            f"{nums['BB%']:.1f}% BB, {slg_text} SLGcon, {csw:.1f}% CSW")  # fmt: skip
    return line, {k: _num(v, 3) if isinstance(v, float) else v for k, v in nums.items()}


def chart_limit(pitches: list[dict]) -> int:
    """build_data.chart_limit over the season's pitches."""
    breaks = [abs(p[k]) for p in pitches for k in ("hb", "ivb") if p.get(k) is not None]
    biggest = max(breaks, default=None)
    return 29 if biggest is None else max(29, int(biggest / 6 + 2) * 6 - 1)


def build(s: requests.Session, games: list[dict], year: int) -> dict:
    """The season card dict for one pitcher's regular-season game cards."""
    last = games[-1]
    pitches = [p for g in games for p in g["pitches"]]
    rows = type_rows(pitches, last["hand"])
    order = [r["code"] for r in rows]
    line, nums = summary(season_line(s, last["pitcher_id"], year), pitches)
    arm = _weighted([(g.get("arm_angle"), len(g["pitches"])) for g in games])
    return {
        "version": 4,
        "season": year,
        "pitcher_id": last["pitcher_id"],
        "name": last["name"],
        "hand": last["hand"],
        "team": last["team"],
        "title": f"Pitcher Performance: {year} Regular Season",
        "bio": last["bio"],
        "line": line,
        "stats": nums,
        "games": len(games),
        "starts": sum(bool(g.get("starter")) for g in games),
        "skills": season_skills(games),
        "n_vl": sum(p["stand"] == "L" for p in pitches),
        "n_vr": sum(p["stand"] == "R" for p in pitches),
        "arm_angle": _num(arm, 2),
        "chart_lim": chart_limit(pitches),
        "fastball": fastball(rows, games),
        "types": rows,
        "kde": {
            "movement": layers(pitches, "hb", "ivb", 1, order, movement_floor),
            **{
                side: layers(
                    [p for p in pitches if p["stand"] == side], "x", "z", 12, order, location_floor
                )
                for side in "LR"
            },
        },
        "missing_data": any(p.get("plvStuff+") is None for p in pitches),
        "comparisons": [],
        "level": last.get("level"),
        "graded_vs": "mlb",
        "provisional": [],
    }


# ---- the season cuts ----------------------------------------------------------------
def fit_cuts(paths: list[str]) -> None:
    """Prints SEASON_GRADE_CUTS for card.js: every pitcher's season means, weighted by the
    pitches they average, fitted to grade_cuts.TARGET as grade_cuts.py fits the game cuts."""
    import grade_cuts  # the scraper's modules come with it: only this needs them

    by = defaultdict(list)
    for c in cards(paths):
        by[c["pitcher_id"]].append(c)
    shares = np.cumsum(grade_cuts.TARGET)[:-1] / 100
    print(f"{len(by)} pitchers")
    for key in ("stuff", "loc", "plv"):
        vals, w = [], []
        for games in by.values():
            v = season_skills(games)[key]
            n = sum(graded(g)[key] for g in games)
            if v is not None and n:
                vals.append(v)
                w.append(n)
        cuts = np.round(grade_cuts.fit(np.array(vals), np.array(w, dtype=float), shares), 1)
        print(f"    {key}: [{', '.join(f'{c:g}' for c in cuts)}],")


def write_cards(s: requests.Session, paths: list[str], pitchers: list[int], year: int, out: str):
    """<id>.json for each pitcher with cards, and index.json listing them, in ``out``."""
    games = defaultdict(list)
    for c in cards(paths):
        if c["pitcher_id"] in pitchers:
            games[c["pitcher_id"]].append(c)
    os.makedirs(out, exist_ok=True)
    index = []
    for pid in (p for p in pitchers if games[p]):
        card = build(s, games[pid], year)
        with open(os.path.join(out, f"{pid}.json"), "w", encoding="utf-8") as fh:
            json.dump(card, fh, separators=(",", ":"))
        index.append({"id": pid, "name": card["name"], "team": card["team"], "line": card["line"]})
        print(f"{card['name']}: {card['games']} games - {card['line']}", file=sys.stderr)
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"season": year, "pitchers": index}, fh, indent=1)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pitchers", nargs="*", type=int, help="MLBAM ids")
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--out", help="where to write <id>.json and index.json")
    ap.add_argument("--cuts", action="store_true", help="print the season grade cuts")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the day files' cache")
    a = ap.parse_args(argv)
    s = requests.Session()
    paths = day_files(s, a.year, os.path.join(a.cache, str(a.year)))
    print(f"{len(paths)} days of {a.year} regular-season cards", file=sys.stderr)
    if a.cuts:
        fit_cuts(paths)
    if a.pitchers:
        write_cards(s, paths, a.pitchers, a.year, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
