"""One game in, one scorecard page out.

    from scorecard import scorecard
    html = scorecard(824638)                     # the page as a string
    scorecard(824638, path="reds-cubs.html")     # ...and written to disk

Pulls pitch-level data with Blandalytics/statcast_scraper, joins it to the MLB
Stats API play-by-play, and renders the standalone dark-mode scorecard.
"""
import os
import sys

# the scraper is cloned rather than installed; look beside this file and in
# the working directory (the repo root, when run by the site workflow)
for _cand in (os.path.join(os.path.dirname(os.path.abspath(__file__)), "statcast_scraper"),
              os.path.join(os.getcwd(), "statcast_scraper")):
    if os.path.isdir(_cand) and _cand not in sys.path:
        sys.path.insert(0, _cand)

import pandas as pd                                            # noqa: E402
import requests                                                # noqa: E402
import statfast                                                # noqa: E402

import build_data                                              # noqa: E402
import render                                                  # noqa: E402

API = "https://statsapi.mlb.com/api/v1"
FEED = "https://statsapi.mlb.com/api/v1.1/game/%d/feed/live"


class GameNotFound(LookupError):
    """No completed game with tracked pitches for that gamePk."""


def _schedule(game_pk, session):
    r = session.get("%s/schedule" % API,
                    params={"sportId": 1, "gamePk": game_pk}, timeout=60)
    r.raise_for_status()
    for day in r.json().get("dates", []):
        for g in day["games"]:
            if g["gamePk"] == game_pk:
                return day["date"], g.get("gameType", "R"), g.get("status", {})
    raise GameNotFound("no game with gamePk %d" % game_pk)


def fetch(game_pk, session=None):
    """Return (live feed dict, that game's pitches as a DataFrame)."""
    s = session or statfast._session()
    date, game_type, status = _schedule(game_pk, s)
    if status.get("codedGameState") != "F":
        raise GameNotFound(
            "game %d is not final (%s); there is nothing to score yet"
            % (game_pk, status.get("detailedState", "unknown state")))

    # one day of the schedule is the cheapest path to a single game's pitches,
    # and it carries the game type through so postseason games work too
    df = statfast.mlb_day(date, game_type=game_type, session=s)
    df = df[df.game_pk == game_pk].copy()
    if df.empty:
        raise GameNotFound("no tracked pitches for game %d on %s" % (game_pk, date))

    feed = s.get(FEED % game_pk, timeout=90).json()
    return feed, df


def fetch_feed(game_pk, session):
    return session.get(FEED % game_pk, timeout=90).json()


def render_game(game_pk, feed, df):
    """(html, data dict) for one game whose feed and pitches are in hand."""
    data = build_data.build(int(game_pk), feed, df)
    return render.render_html(data), data


def scorecard(game_pk, path=None, session=None):
    """Build the scorecard page for one game and return it as an HTML string.

    game_pk : MLBAM gamePk of a completed game.
    path    : optional file to write the page to as well.
    session : optional requests.Session to reuse across calls.
    """
    feed, df = fetch(int(game_pk), session)
    html, _ = render_game(game_pk, feed, df)
    if path:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(html)
    return html


def scorecards_for_date(date, session=None, game_type="R,P"):
    """Every completed game on a date, scraped once: yields (game_pk, html, data).

    Regular season and postseason by default. Games with no tracked pitches
    (rare, but they happen) are skipped rather than rendered empty.
    """
    s = session or statfast._session()
    df_all = statfast.mlb_day(date, game_type=game_type, session=s)
    for pk in sorted(int(x) for x in df_all.game_pk.unique()):
        df = df_all[df_all.game_pk == pk].copy()
        if df.empty:
            continue
        html, data = render_game(pk, fetch_feed(pk, s), df)
        yield pk, html, data


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print(__doc__.strip())
        return 2
    game_pk = int(argv[0])
    out = argv[1] if len(argv) > 1 else "scorecard_%d.html" % game_pk
    html = scorecard(game_pk, path=out)
    print("wrote %s  %.1f KB" % (out, len(html.encode("utf-8")) / 1024))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
