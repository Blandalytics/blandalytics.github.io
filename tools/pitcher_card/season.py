"""Season cards: each pitcher's regular season, pooled from the bucket's per-game card data
into a card dict that card.js draws with its season layout, for the Season Cards page
(pitcher-cards/season.html).

    python season.py --publish                    # this season's cards, into the bucket
    python season.py --year 2023 --publish        # a past season's, from the archive
    python season.py --out ../../pitcher-cards    # into a folder instead (cards/mlb/seasons/)
    python season.py --out DIR 694819 808967      # only these pitchers
    python season.py --archive DIR                # build_site.py --out DIR's game cards, into
                                                  # the archive a past season is pooled from
    python season.py --cuts                       # the season cuts

A season is its regular-season games (MLB's schedule, gameType R). This season's game cards
are the Game Cards page's (cards/mlb/data/<date>.json); a past season's, built the same way
but without comparison seasons, are kept apart in cards/mlb/archive/<date>.json so the Game
Cards page doesn't list them. Each day is fetched once into --cache. A pitcher's games are
pooled into:

- the summary line, in segments: IP, ERA, WHIP, strikeouts, K% and BB% from MLB's season
  line, and CSW% from the pitches;
- the bio's age, his age on June 30 of the season (as FanGraphs and Baseball-Reference give
  it: a game card's is his age today);
- the Stuff, Location and PLV means, each game's mean weighted by the pitches it graded;
  card.js letters them on its SEASON_GRADE_CUTS, which --cuts fits as grade_cuts.py fits
  the game cuts (every pitcher's season, weighted by his pitches, to grade_cuts.TARGET);
- the usage and the pitch type table, from the pitches as prep.game_table makes a game's;
  the primary fastball's extension and HAVAA, which the pitches don't carry, are its
  games' values weighted by its pitches in them;
- Movement as three KDE tiers per pitch type, each type on its own Scott kernel (as
  scipy's gaussian_kde sets it) widened MOVEMENT_BW times, as shapes.py widens its (seaborn's
  bw_adjust), so the tails a 95% edge runs through come out smooth; the grid is cut 3
  bandwidths past the data. The outermost tier is around the type's densest 95% of pitches
  (ranked by the KDE at each pitch), the inner ones two thirds and a third as many (63%,
  32%). A type with fewer than KDE_MIN pitches is drawn as its pitches.
- the locations as each side-and-type's KDE regions at seaborn's kdeplot(levels=4,
  thresh=0.64, fill=True), its levels [0.64, 0.76, 0.88, 1]: the densest 36%, 24% and 12%
  of its KDE mass, on its own Scott kernel (seaborn's bw_adjust=1). 0.64 is the threshold
  whose regions best match a 1-SD ellipse of the same pitches. A type with fewer than
  LOCATION_MIN pitches to a side is drawn as its pitches in that plot, which then says so
  ("<20 pitches shown as scatter").

A pitcher who pitched for more than one team also gets a card for each team's part of his
season (keyed <pitcherId>-<team>), its line MLB's for that team. There are no comparison
seasons on a season card. Writes, under the bucket's cards/mlb/seasons/:

    <year>/<key>.json   a season card; <key> is the pitcher's id, or <id>-<team> for a stint
    <year>/index.json   the season's cards (name, team, pitches, grades, Stuff+ by type), its
                        last day and the games each team had played by then (the page
                        prorates its pitch threshold by them)
    index.json          the seasons built"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import gzip
import json
import os
import sys
import time
from collections import Counter, defaultdict
from typing import NamedTuple

import numpy as np
import requests

from grades import DESC_MAP
from shapes import _paths

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUCKET = "https://data.blandalytics.com/cards"
STATSAPI = "https://statsapi.mlb.com/api/v1"
SEASONS = "cards/mlb/seasons"  # the season cards' keys in the bucket
ARCHIVE = "cards/mlb/archive"  # past seasons' game cards, which only the season cards read
CARD_CACHE = "public, max-age=300"
INDEX_CACHE = "public, max-age=120"
FULL_SEASON = 162  # a team's games in a full regular season
FASTBALLS = ("FF", "SI", "FC")
TYPE_STATS = ("Velo", "IVB", "HB", "Str%", "SwStr%", "CSW%", "xSLGcon", "plvStuff+", "PLV+")
MOVEMENT_SHARE = 0.95  # Movement's outer tier: the type's densest 95% of pitches
TIER_SHARES = (1, 2 / 3, 1 / 3)  # each tier's pitches against the outer tier's
MOVEMENT_BW = 2  # Movement's kernels: each type's Scott kernel, twice as wide
LOCATION_LEVELS = (0.64, 0.76, 0.88)  # the location plots' iso-proportions (kdeplot levels)
LOCATION_MIN = 20  # the pitches to a side a type needs for location regions
GRIDSIZE = 150
CUT = 3
KDE_MIN = 10
RUN = str(int(time.time()))  # past the CDN's copy of a day, which may be from before it was built
DEFAULT_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "season")
# what a season card reads of a game card and its pitches (the rest is dropped on loading)
GAME_KEYS = ("pitcher_id", "name", "hand", "team", "home", "game_pk", "date", "bio", "starter",
             "skills", "fastball", "arm_angle", "level")  # fmt: skip
PITCH_KEYS = ("t", "hb", "ivb", "x", "z", "stand", "velo", "d", "plvStuff+", "PLV+", "xSLGcon")


# ---- the season's games and their cards ---------------------------------------------
class Game(NamedTuple):
    date: str
    home: int
    away: int
    final: bool


def schedule(s: requests.Session, year: int) -> dict[int, Game]:
    """The regular season's games by gamePk. A game listed on two dates (postponed, or
    suspended and resumed) is kept on the one it was finished on."""
    fields = "dates,date,games,gamePk,status,codedGameState,teams,home,away,team,id"
    q = {"sportId": 1, "season": year, "gameType": "R", "fields": fields}
    r = s.get(f"{STATSAPI}/schedule", params=q, timeout=60)
    r.raise_for_status()
    games: dict[int, Game] = {}
    for day in r.json().get("dates", []):
        for g in day["games"]:
            final = g["status"]["codedGameState"] in ("F", "O")
            if g["gamePk"] not in games or final:
                home, away = (g["teams"][side]["team"]["id"] for side in ("home", "away"))
                games[g["gamePk"]] = Game(day["date"], home, away, final)
    return games


def team_games(games: dict[int, Game], through: str) -> float:
    """The games each team had played by ``through``, on average: what the page prorates
    its pitch threshold by (a full season's FULL_SEASON)."""
    teams = {t for g in games.values() for t in (g.home, g.away)}
    played = sum(g.final and g.date <= through for g in games.values())
    return round(2 * played / len(teams), 2) if teams else 0.0


def current_season(s: requests.Session) -> int:
    """This year's season once its regular season has begun, else last year's."""
    today = dt.date.today()
    se = s.get(f"{STATSAPI}/seasons/{today.year}", params={"sportId": 1}, timeout=30).json()
    start = (se.get("seasons") or [{}])[0].get("regularSeasonStartDate")
    return today.year if start and start <= today.isoformat() else today.year - 1


def sources(s: requests.Session, games: dict[int, Game]) -> list[tuple[str, str, str]]:
    """(date, url, cache name) of each day of the season's game cards: the Game Cards
    page's for the days it has (named by their card count, so a day that gains cards is
    fetched again), else the archive's."""
    days = s.get(f"{BUCKET}/index.json", params={"v": dt.datetime.now().timestamp()}, timeout=60)
    carded = days.json().get("levels", {}).get("mlb", {}).get("days", {})
    dates = sorted({g.date for g in games.values() if g.final})
    if any(d in carded for d in dates):
        lo, hi = dates[0], dates[-1]
        return [(d, f"{BUCKET}/mlb/data/{d}.json", f"{d}-{n}") for d, n in sorted(carded.items())
                if lo <= d <= hi]  # fmt: skip
    return [(d, f"{BUCKET}/mlb/archive/{d}.json", d) for d in dates]


def day_files(s: requests.Session, games: dict[int, Game], cache: str) -> list[str]:
    """The cached path of each day's game cards in the regular season, fetched as needed;
    a day the archive is missing is reported and skipped."""
    os.makedirs(cache, exist_ok=True)

    def get(src: tuple[str, str, str]) -> str | None:
        date, url, name = src
        path = os.path.join(cache, f"{name}.json.gz")
        if not os.path.exists(path):
            r = s.get(url, params={"v": RUN}, timeout=120)
            if r.status_code == 404:
                print(f"  {date}: no game cards at {url}", file=sys.stderr)
                return None
            r.raise_for_status()
            with gzip.open(path + ".part", "wb") as fh:
                fh.write(r.content)
            os.replace(path + ".part", path)
        return path

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        return [p for p in pool.map(get, sources(s, games)) if p]


def _slim(card: dict) -> dict:
    out = {k: card.get(k) for k in GAME_KEYS}
    out["types"] = [{"code": t["code"], "n": t["n"]} for t in card["types"]]
    out["pitches"] = [{k: p.get(k) for k in PITCH_KEYS} for p in card["pitches"]]
    return out


def cards(paths: list[str], games: dict[int, Game] | None = None):
    """Every card in the day files, oldest day first, with only what a season card reads;
    only the regular season's, given its ``games``."""
    for path in paths:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            for card in json.load(fh).values():
                if games is None or card["game_pk"] in games:
                    yield _slim(card)


def by_pitcher(paths: list[str], games: dict[int, Game]) -> dict[int, list[dict]]:
    by = defaultdict(list)
    for c in cards(paths, games):
        by[c["pitcher_id"]].append(c)
    return by


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
    """A smoothing kernel (a covariance) for the pitch types given: Scott's rule (factor
    n^-1/6 in two dimensions) on all their pitches, their spread measured within their own
    types (the pooled covariance). Given one type, as Movement gives it, it is that type's
    own Scott kernel, as scipy's gaussian_kde sets it. None if it is degenerate."""
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
    densities at TIER_SHARES of the way."""
    bw = np.sqrt(np.diag(cov))
    lo, hi = xy.min(axis=0) - bw * CUT, xy.max(axis=0) + bw * CUT
    gx, gy = np.linspace(lo[0], hi[0], GRIDSIZE), np.linspace(lo[1], hi[1], GRIDSIZE)
    xx, yy = np.meshgrid(gx, gy)
    z = density(xy, np.column_stack([xx.ravel(), yy.ravel()]), cov).reshape(xx.shape)
    at = np.sort(density(xy, xy, cov))[::-1]  # the density at each pitch, densest first
    return [_paths(gx, gy, z, float(at[max(1, round(inside * f)) - 1])) for f in TIER_SHARES]


def _by_type(pitches: list[dict], xkey: str, ykey: str, order: list[str]) -> dict[str, np.ndarray]:
    """Each type's points in one plot, in ``order``; a pitch missing either is left out."""
    by = {}
    for code in order:
        pts = [
            (p[xkey], p[ykey])
            for p in pitches
            if p["t"] == code and None not in (p.get(xkey), p.get(ykey))
        ]
        if pts:
            by[code] = np.array(pts, dtype=float)
    return by


def movement_layers(pitches: list[dict], order: list[str]) -> list[dict]:
    """Each pitch type's movement tiers (inches), most thrown first, each on its own Scott
    kernel (``kernel`` of the type alone); its points instead when it has too few for a KDE
    or they make a degenerate one."""
    out = []
    for code, xy in _by_type(pitches, "hb", "ivb", order).items():
        cov = kernel([xy]) if len(xy) >= KDE_MIN else None
        cov = None if cov is None else cov * MOVEMENT_BW**2
        if cov is not None:
            out.append({"code": code, "tiers": tiers(xy, round(MOVEMENT_SHARE * len(xy)), cov)})
        else:
            out.append({"code": code, "points": np.round(xy, 2).tolist()})
    return out


def _level(z: np.ndarray, isoprop: float) -> float:
    """seaborn's _quantile_to_level: the density above which 1 - isoprop of the mass lies."""
    values = np.sort(z.ravel())[::-1]
    cumulative = np.cumsum(values) / values.sum()
    return float(values[min(np.searchsorted(cumulative, 1 - isoprop), len(values) - 1)])


def mass_tiers(xy: np.ndarray, cov: np.ndarray, isoprops: tuple[float, ...]) -> list[list[str]]:
    """One type's KDE regions as seaborn's kdeplot draws them at ``isoprops`` (its levels),
    outermost first, as path data in tenths (shapes._paths)."""
    bw = np.sqrt(np.diag(cov))
    lo, hi = xy.min(axis=0) - bw * CUT, xy.max(axis=0) + bw * CUT
    gx, gy = np.linspace(lo[0], hi[0], GRIDSIZE), np.linspace(lo[1], hi[1], GRIDSIZE)
    xx, yy = np.meshgrid(gx, gy)
    z = density(xy, np.column_stack([xx.ravel(), yy.ravel()]), cov).reshape(xx.shape)
    return [_paths(gx, gy, z, _level(z, q)) for q in isoprops]


def location_plots(pitches: list[dict], order: list[str]) -> dict:
    """Both location plots, each type in the order it's drawn: least thrown to that side
    first, so the most thrown lies on top (ties as ``order``). Every side-and-type's KDE
    regions at LOCATION_LEVELS, on its own Scott kernel, in inches (so the paths keep their
    tenths). A type thrown to a side fewer than LOCATION_MIN times (or too evenly for a
    kernel) is its pitches instead, and is listed in ``scattered`` for that side, which
    says so."""
    out = {"min": LOCATION_MIN, "scattered": {}}
    for side in "LR":
        out[side], out["scattered"][side] = [], []
        faced = [p for p in pitches if p["stand"] == side]
        usage = Counter(p["t"] for p in faced)
        for code, xy in _by_type(faced, "x", "z", sorted(order, key=usage.__getitem__)).items():
            cov = kernel([xy * 12]) if len(xy) >= LOCATION_MIN else None
            if cov is None:
                out["scattered"][side].append(code)
                out[side].append({"code": code, "points": np.round(xy * 12, 1).tolist()})
            else:
                out[side].append({"code": code, "tiers": mass_tiers(xy * 12, cov, LOCATION_LEVELS)})
    return out


# ---- the season card ----------------------------------------------------------------
class Person(NamedTuple):
    birth: str | None
    lines: dict  # MLB's regular-season pitching line: by team id, and the season's at None


def person(s: requests.Session, pid: int, year: int) -> Person:
    """A pitcher's birth date and MLB's regular-season pitching lines: one per team he
    pitched for, and the season's (for a traded pitcher MLB's total, else his one line)."""
    q = {"hydrate": f"stats(group=[pitching],type=[season],season={year},gameType=[R],sportId=1)"}
    r = s.get(f"{STATSAPI}/people/{pid}", params=q, timeout=30)
    r.raise_for_status()
    p = r.json()["people"][0]
    splits = [x for st in p.get("stats", []) for x in st.get("splits", [])]
    lines = {(x.get("team") or {}).get("id"): x["stat"] for x in splits}
    if None not in lines and len(lines) == 1:
        lines[None] = next(iter(lines.values()))
    return Person(p.get("birthDate"), lines)


def people(s: requests.Session, pids: list[int], year: int) -> dict[int, Person]:
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        return dict(zip(pids, pool.map(lambda pid: person(s, pid, year), pids), strict=True))


def season_age(birth: str | None, year: int) -> int | None:
    """His age on June 30 of the season."""
    if not birth:
        return None
    b = dt.date.fromisoformat(birth)
    return year - b.year - ((b.month, b.day) > (6, 30))


def _share(part, whole) -> float | None:
    return 100 * part / whole if part is not None and whole else None


def _segment(value, unit: str, spec: str = "") -> str:
    return f"{'-' if value is None else format(value, spec)}{unit}"


def summary(stat: dict | None, pitches: list[dict]) -> tuple[list[str], dict]:
    """The summary line's segments, ['174.2 IP', '1.80 ERA', '0.80 WHIP', '252 Ks',
    '37.9% K', '6.6% BB', '35.4% CSW'], and their numbers; MLB's are dashes without a line."""
    stat = stat or {}
    bf = stat.get("battersFaced")
    called = sum(_desc(p) in ("called_strike", "swinging_strike") for p in pitches)
    csw = 100 * called / len(pitches)
    nums = {
        "IP": stat.get("inningsPitched"), "ERA": stat.get("era"), "WHIP": stat.get("whip"),
        "K": stat.get("strikeOuts"), "K%": _share(stat.get("strikeOuts"), bf),
        "BB%": _share(stat.get("baseOnBalls"), bf), "CSW%": csw,
    }  # fmt: skip
    segments = [
        _segment(nums["IP"], " IP"), _segment(nums["ERA"], " ERA"), _segment(nums["WHIP"], " WHIP"),
        _segment(nums["K"], " Ks"), _segment(nums["K%"], "% K", ".1f"),
        _segment(nums["BB%"], "% BB", ".1f"), _segment(csw, "% CSW", ".1f"),
    ]  # fmt: skip
    return segments, {k: _num(v, 3) if isinstance(v, float) else v for k, v in nums.items()}


def chart_limit(pitches: list[dict]) -> int:
    """build_data.chart_limit over the season's pitches."""
    breaks = [abs(p[k]) for p in pitches for k in ("hb", "ivb") if p.get(k) is not None]
    biggest = max(breaks, default=None)
    return 29 if biggest is None else max(29, int(biggest / 6 + 2) * 6 - 1)


def build(games: list[dict], year: int, line: dict | None, age: int | None, teams: list[str],
          stint: bool = False) -> dict:  # fmt: skip
    """The season card dict for some of a pitcher's regular-season game cards: all of them,
    with ``teams`` every team he pitched for, or one team's (a ``stint``)."""
    last = games[-1]
    pitches = [p for g in games for p in g["pitches"]]
    rows = type_rows(pitches, last["hand"])
    order = [r["code"] for r in rows]
    segments, nums = summary(line, pitches)
    arm = _weighted([(g.get("arm_angle"), len(g["pitches"])) for g in games])
    team = "/".join(teams)
    return {
        "version": 4,
        "season": year,
        "pitcher_id": last["pitcher_id"],
        "name": last["name"],
        "hand": last["hand"],
        "team": team,
        "teams": teams,
        "stint": stint,
        "title": f"Pitcher Performance: {year} Regular Season",
        "bio": f"{last['hand']}HP | {team}" + ("" if age is None else f" | Age: {age}"),
        "line": ", ".join(segments),
        "summary": segments,
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
        "plots": {
            "movement": movement_layers(pitches, order),
            **location_plots(pitches, order),
        },
        "missing_data": any(p.get("plvStuff+") is None for p in pitches),
        "comparisons": [],
        "level": last.get("level"),
        "graded_vs": "mlb",
        "provisional": [],
    }


def stints(games: list[dict], sched: dict[int, Game]) -> list[tuple[int, str, list[dict]]]:
    """(team id, team, games) for each team a pitcher pitched for, in the order he did."""
    by: dict[int, list[dict]] = {}
    for g in games:
        game = sched[g["game_pk"]]
        by.setdefault(game.home if g["home"] else game.away, []).append(g)
    return [(tid, gs[-1]["team"], gs) for tid, gs in by.items()]


Job = tuple[int, list[dict], Person, dict[int, Game], int]  # a pitcher's: see pitcher_cards


def pitcher_cards(job: Job) -> list[tuple[str, dict]]:
    """(key, card) for a pitcher's season and, if he pitched for more than one team, for
    each team's part of it."""
    pid, games, info, sched, year = job
    parts = stints(games, sched)
    age = season_age(info.birth, year)
    out = [(str(pid), build(games, year, info.lines.get(None), age, [t for _, t, _ in parts]))]
    if len(parts) > 1:
        out += [(f"{pid}-{team}", build(gs, year, info.lines.get(tid), age, [team], stint=True))
                for tid, team, gs in parts]  # fmt: skip
    return out


def build_all(s: requests.Session, by: dict[int, list[dict]], sched: dict[int, Game], year: int):
    """Every pitcher's cards, built across the machine's cores."""
    info = people(s, list(by), year)
    jobs = [(pid, games, info[pid], {g["game_pk"]: sched[g["game_pk"]] for g in games}, year)
            for pid, games in by.items()]  # fmt: skip
    with concurrent.futures.ProcessPoolExecutor() as pool:
        return [c for cs in pool.map(pitcher_cards, jobs, chunksize=4) for c in cs]


def entry(key: str, card: dict) -> dict:
    """A card's line in the season index: who, how much, and his grades and Stuff+ by type,
    as the page's table and Pitcher list show them. A team's part of a traded pitcher's
    season is a ``stint``; his whole season is ``traded``."""
    e = {
        "key": key, "id": card["pitcher_id"], "name": card["name"], "team": card["team"],
        "hand": card["hand"], "n": sum(r["n"] for r in card["types"]), "g": card["games"],
        "gs": card["starts"], "ip": card["stats"]["IP"],
        "skills": {k: _num(card["skills"][k], 2) for k in ("stuff", "loc", "plv")},
        "stuff": {r["code"]: r["values"]["plvStuff+"] for r in card["types"]
                  if r["values"]["plvStuff+"] is not None},
    }  # fmt: skip
    if card["stint"]:
        e["stint"] = True
    elif len(card["teams"]) > 1:
        e["traded"] = True
    return e


# ---- writing ------------------------------------------------------------------------
def _json(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def store(out: str | None):
    """A folder (--out), else the bucket (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and
    R2_SECRET_ACCESS_KEY in the environment)."""
    sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
    from backfill import LocalStore, R2Store  # the scraper comes with it: only writing needs it

    return LocalStore(out) if out else R2Store()


def _index(st, key: str) -> dict:
    raw = st.get(key)
    return json.loads(raw) if raw else {}


def write(st, year: int, built: list[tuple[str, dict]], meta: dict, merge: bool) -> None:
    """The cards, the season's index (merged into the one there when only some pitchers
    were built) and the seasons index."""
    with concurrent.futures.ThreadPoolExecutor(16) as pool:
        list(pool.map(lambda kc: st.put(f"{SEASONS}/{year}/{kc[0]}.json", _json(kc[1]),
                                        "application/json", CARD_CACHE), built))  # fmt: skip
    entries = {e["key"]: e for e in (_index(st, f"{SEASONS}/{year}/index.json") if merge else {})
               .get("pitchers", [])}  # fmt: skip
    entries.update((k, entry(k, c)) for k, c in built)
    index = {**meta, "pitchers": sorted(entries.values(), key=lambda e: e["key"])}
    st.put(f"{SEASONS}/{year}/index.json", _json(index), "application/json", INDEX_CACHE)
    seasons = _index(st, f"{SEASONS}/index.json")
    seasons.setdefault("seasons", {})[str(year)] = {**meta, "cards": len(index["pitchers"])}
    seasons["built"] = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    st.put(f"{SEASONS}/index.json", _json(seasons), "application/json", INDEX_CACHE)


def publish(st, s: requests.Session, year: int, sched: dict[int, Game], paths: list[str],
            wanted: list[int], force: bool) -> None:  # fmt: skip
    """Builds and writes the season's cards (``wanted``'s alone, if any); every pitcher's
    only when the game cards have moved since the last build, or ``force``."""
    by = by_pitcher(paths, sched)
    through = max(g["date"] for games in by.values() for g in games)
    meta = {"season": year, "through": through, "days": len(paths),
            "games": sum(map(len, by.values())), "team_games": team_games(sched, through),
            "full_games": FULL_SEASON}  # fmt: skip
    old = _index(st, f"{SEASONS}/{year}/index.json")
    if not (wanted or force) and all(old.get(k) == meta[k] for k in ("through", "days", "games")):
        print(f"{year}: up to date (through {through})", file=sys.stderr)
        return
    if wanted:
        by = {pid: by[pid] for pid in wanted if pid in by}
    built = build_all(s, by, sched, year)
    write(st, year, built, meta, merge=bool(wanted))
    print(f"{year}: {len(built)} cards for {len(by)} pitchers through {through}", file=sys.stderr)


def archive(st, folder: str) -> None:
    """A past season's game cards, built by build_site.py --out ``folder``, into the
    archive the season cards are pooled from."""
    src = os.path.join(folder, "cards", "mlb", "data")
    names = sorted(n for n in os.listdir(src) if n.endswith(".json"))
    for name in names:
        with open(os.path.join(src, name), "rb") as fh:
            st.put(f"{ARCHIVE}/{name}", fh.read(), "application/json", CARD_CACHE)
    print(f"{len(names)} days of game cards archived", file=sys.stderr)


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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pitchers", nargs="*", type=int, help="MLBAM ids (default: every pitcher)")
    ap.add_argument("--year", type=int, help="the season (default: this one, or last until then)")
    ap.add_argument("--publish", action="store_true", help="write the cards to the bucket")
    ap.add_argument("--out", help="write the cards to this folder instead")
    ap.add_argument("--force", action="store_true", help="rebuild even if nothing has moved")
    ap.add_argument("--archive", metavar="DIR", help="archive build_site.py --out DIR's game cards")
    ap.add_argument("--cuts", action="store_true", help="print the season grade cuts")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the day files' cache")
    a = ap.parse_args(argv)
    s = requests.Session()
    if a.archive:
        archive(store(None), a.archive)
        return 0
    if not (a.cuts or a.out or a.publish):
        ap.error("give --publish, --out DIR, --cuts or --archive DIR")
    year = a.year or current_season(s)
    sched = schedule(s, year)
    paths = day_files(s, sched, os.path.join(a.cache, str(year)))
    print(f"{len(paths)} days of {year} regular-season game cards", file=sys.stderr)
    if a.cuts:
        fit_cuts(paths)
    else:
        publish(store(a.out), s, year, sched, paths, a.pitchers, a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
