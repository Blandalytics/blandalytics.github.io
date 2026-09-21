"""One pitcher's game in, one card page out.

    from card import pitcher_card
    html = pitcher_card(822845, 641302)                  # the page as a string
    pitcher_card(822845, 641302, path="alexander.html")  # ...and written to disk

The game's pitches come from Blandalytics/statcast_scraper (one game at a time, so a
game in progress works too), the box score and bio from the MLB Stats API live feed, arm
angles from Baseball Savant's leaderboard, and the comparison seasons from the data files
in the bucket, topped up through the scraper. Every pitch is scored with the PLV models
from Blandalytics/player_cards, and the card is rendered as a standalone page."""

from __future__ import annotations

import datetime as dt
import os
import sys
import traceback
from collections.abc import Iterator

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
DEFAULT_CACHE = os.path.join(HERE, "cache")


def _locate(name: str) -> str:
    """A checkout of one of the sibling repos: beside this file, at the repo root, beside
    the repo, or in the working directory."""
    for base in (HERE, ROOT, os.path.dirname(ROOT), os.getcwd()):
        candidate = os.path.join(base, name)
        if os.path.isdir(candidate):
            return candidate
    raise FileNotFoundError(f"clone https://github.com/Blandalytics/{name} beside the repo")


# the scraper and the model files are cloned rather than installed; this folder goes on
# the path too so the sibling modules import whether run from here or from the repo root
SCRAPER = _locate("statcast_scraper")
for _path in (SCRAPER, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)
MODELS_DIR = os.environ.get("PLAYER_CARDS_DIR") or _locate("player_cards")

import pandas as pd  # noqa: E402
import statfast  # noqa: E402

import build_data  # noqa: E402
import fetch  # noqa: E402
import render  # noqa: E402
from models import Models  # noqa: E402

GAME_TYPES = "R,P"  # regular season and postseason
SCHEDULE = "https://statsapi.mlb.com/api/v1/schedule"
_models: Models | None = None


class GameNotFound(LookupError):
    """No tracked pitches for that pitcher in that game."""


def models() -> Models:
    global _models
    if _models is None:
        _models = Models(MODELS_DIR)
    return _models


def day_pitches(date: dt.date, session, store=None, game_type: str = GAME_TYPES) -> pd.DataFrame:
    """Every tracked pitch on a date: from the data files once the date has settled,
    otherwise scraped in one pull."""
    stored = store.day(date) if store is not None else None
    if stored is not None:
        return stored
    return statfast.mlb_day(date, game_type=game_type, session=session)


def game_pitches(game_pk: int, session) -> pd.DataFrame:
    """One game's tracked pitches so far, whatever state the game is in."""
    r = session.get(SCHEDULE, params={"gamePk": int(game_pk), "sportId": 1}, timeout=30)
    r.raise_for_status()
    days = r.json().get("dates", [])
    found = [g for d in days for g in d["games"] if g["gamePk"] == int(game_pk)]
    if not found:
        raise GameNotFound(f"no game with gamePk {game_pk}")
    g = found[0]
    teams = g["teams"]["home"]["team"]["id"], g["teams"]["away"]["team"]["id"]
    game = statfast._Game(g["officialDate"], *teams)
    return statfast._collect(session, {int(game_pk): game}, None, 4)


def seasons_for(pitcher_id: int, date: dt.date, store: fetch.SeasonStore) -> dict:
    """year -> the pitcher's regular-season pitches before ``date``, most recent season
    first, for every season back to the first the card supports."""
    out = {}
    for year in range(date.year, store.first_season - 1, -1):
        season = store.before(year, date)
        out[year] = season[season["pitcher"] == pitcher_id]
    return out


def pitcher_order(feed: dict) -> list[int]:
    """The game's pitchers as the original app listed them: both starters, then the
    home bullpen, then the away bullpen."""
    teams = feed["liveData"]["boxscore"]["teams"]
    home, away = teams["home"]["pitchers"], teams["away"]["pitchers"]
    return [*home[:1], *away[:1], *home[1:], *away[1:]]


def build_card(game_pk, pitcher_id, feed, df, session, store, logo=render.LOGO):
    """(html, card dict) for one pitcher whose feed and pitches are in hand. ``logo`` is
    the Pitcher List mark's URL as the page will see it."""
    date = dt.date.fromisoformat(feed["gameData"]["datetime"]["officialDate"])
    arm = fetch.arm_angles(session, date).get(pitcher_id, {})
    seasons = seasons_for(pitcher_id, date, store)
    card = build_data.build(game_pk, pitcher_id, feed, df, seasons, arm, models())
    return render.render_html(card, logo), card


def _try_card(game_pk, pid, feed, pitches, session, store, strict, logo=render.LOGO):
    """build_card, or None with the failure logged when ``strict`` is off."""
    try:
        return build_card(game_pk, pid, feed, pitches, session, store, logo)
    except Exception:  # noqa: BLE001 - a site build carries on past one bad card
        if strict:
            raise
        print(f"  card {game_pk}-{pid} FAILED", file=sys.stderr)
        traceback.print_exc()
        return None


def cards_for_game(
    game_pk, feed, df, session, store, strict=True, skip=None, logo=render.LOGO
) -> Iterator:
    """Yields (pitcher id, html, card) for every pitcher with tracked pitches in a game.
    With ``strict`` off a pitcher whose card fails is logged and skipped; ``skip(game_pk,
    pitcher_id)`` can decline a card before it is built."""
    for pid in pitcher_order(feed):
        pitches = df[df["pitcher"] == pid]
        if pitches.empty or (skip is not None and skip(game_pk, pid)):
            continue
        built = _try_card(game_pk, pid, feed, pitches, session, store, strict, logo)
        if built is not None:
            yield pid, *built


def cards_for_date(date, session=None, store=None, strict=True, skip=None) -> Iterator:
    """Every completed game on a date, scraped once: yields (game_pk, pitcher id, html,
    card). Games with no tracked pitches are skipped; see cards_for_game for ``skip``."""
    date = dt.date.fromisoformat(str(date))
    s = session or fetch.session()
    store = store or fetch.DataStore(DEFAULT_CACHE, s)
    df_all = day_pitches(date, s, store)
    for pk in sorted(int(x) for x in df_all["game_pk"].unique()):
        feed = fetch.feed(s, pk)
        game = df_all[df_all["game_pk"] == pk]
        for pid, html, card in cards_for_game(pk, feed, game, s, store, strict, skip):
            yield pk, pid, html, card


def pitcher_card(game_pk: int, pitcher_id: int, path=None, session=None, cache_dir=None) -> str:
    """Build the card page for one pitcher's game and return it as an HTML string.

    game_pk    : MLBAM gamePk of a game, finished or in progress.
    pitcher_id : the pitcher's MLBAM id.
    path       : optional file to write the page to as well.
    session    : optional requests.Session to reuse across calls.
    cache_dir  : where the comparison seasons are cached (default: ./cache here).
    """
    s = session or fetch.session()
    feed = fetch.feed(s, int(game_pk))
    df = game_pitches(int(game_pk), s)
    df = df[df["pitcher"] == int(pitcher_id)]
    if df.empty:
        raise GameNotFound(f"no tracked pitches for pitcher {pitcher_id} in game {game_pk}")
    store = fetch.DataStore(cache_dir or DEFAULT_CACHE, s)
    html, _ = build_card(int(game_pk), int(pitcher_id), feed, df, s, store)
    if path:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(html)
    return html


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    game_pk, pitcher_id = int(argv[0]), int(argv[1])
    out = argv[2] if len(argv) > 2 else f"card_{game_pk}_{pitcher_id}.html"
    html = pitcher_card(game_pk, pitcher_id, path=out)
    print(f"wrote {out}  {len(html.encode('utf-8')) / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
