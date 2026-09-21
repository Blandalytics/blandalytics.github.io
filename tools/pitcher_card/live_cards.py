"""Cards for the MLB games in progress, published to the bucket rather than the repo.

    python live_cards.py                 # every live game, from live/today.json
    python live_cards.py --game 822844   # one game, whatever its state (for testing)
    python live_cards.py --out ./live    # write to a folder instead of the bucket

Reads which games are live from the poller's ``live/today.json``, pulls each game's
pitches so far, and builds a card for every pitcher who has thrown one — rebuilding a
card only when that pitcher's pitch count has moved. The pages go to
``live/cards/<gamePk>-<pitcherId>.html`` with ``live/cards/index.json`` beside them, in
the same shape as a day's manifest in pitcher-cards/days/, so the picker can show them.
A game gets one last build after it goes final; the nightly build then writes the
permanent card into the repo, and the bucket's copies expire with the rest of live/."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from zoneinfo import ZoneInfo

from card import DEFAULT_CACHE, ROOT, cards_for_game, game_pitches  # first: sys.path

import fetch  # noqa: E402
from build_site import entry, game_entry  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from backfill import LocalStore, R2Store  # noqa: E402

ET = ZoneInfo("America/New_York")
INDEX = "live/cards/index.json"
CARD_CACHE = "public, max-age=60"
INDEX_CACHE = "public, max-age=30"
# the pages live in the bucket, so the mark cannot be a relative path
LOGO = "https://blandalytics.com/pitcher-cards/PitcherList_Stats_watermark_with_logo.webp"


def today_games(s) -> list[dict]:
    r = s.get(f"{fetch.DATA_URL}/live/today.json", timeout=30)
    r.raise_for_status()
    return r.json()["games"]


def wanted(games: list[dict], index: dict) -> list[dict]:
    """Live MLB games, plus any game the index is following that has since gone final
    (it gets one last build)."""
    out = []
    for g in games:
        if g["sport"]["id"] != 1:
            continue
        live = g["status"]["abstract"] == "Live"
        followed = str(g["gamePk"]) in index["games"]
        final_pending = g["status"]["abstract"] == "Final" and followed \
            and not index["games"][str(g["gamePk"])].get("final")  # fmt: skip
        if live or final_pending:
            out.append(g)
    return out


def one_game(games: list[dict], pk: int) -> dict:
    """The schedule entry for ``pk``, or a stand-in when it isn't in today's window."""
    found = [g for g in games if g["gamePk"] == pk]
    return found[0] if found else {"gamePk": pk, "sport": {"id": 1}, "status": {"abstract": "Live"}}


def load_index(store) -> dict:
    raw = store.get(INDEX)
    idx = json.loads(raw) if raw else {}
    idx.setdefault("games", {})
    return idx


def build_game(g: dict, s, data, store, index: dict) -> int:
    """Build the cards a game needs right now; returns how many were written."""
    pk = g["gamePk"]
    feed = fetch.feed(s, pk)
    df = game_pitches(pk, s)
    if df.empty:
        return 0
    counts = df.groupby("pitcher", observed=True).size().to_dict()
    game = index["games"].get(str(pk)) or {}
    have = {p["id"]: p.get("pitches", -1) for p in game.get("pitchers", [])}
    final = feed["gameData"]["status"]["codedGameState"] == "F"

    def skip(_pk, pid):  # unchanged since the last build, unless this is the final pass
        return not final and have.get(pid) == counts.get(pid)

    n = 0
    cards = cards_for_game(pk, feed, df, s, data, strict=False, skip=skip, logo=LOGO)
    for pid, html, card in cards:
        key = f"live/cards/{pk}-{pid}.html"
        store.put(key, html.encode("utf-8"), "text/html; charset=utf-8", CARD_CACHE)
        game = index["games"].setdefault(str(pk), game_entry(card))
        e = entry(pk, pid, card)
        e["file"] = f"{fetch.DATA_URL}/{key}"
        e["pitches"] = int(counts[pid])
        game["pitchers"] = [p for p in game["pitchers"] if p["id"] != pid] + [e]
        n += 1
        print(f"  {card['team']} {'vs' if card['home'] else '@'} {card['opp']}  {card['name']}  "
              f"{counts[pid]} pitches  {card['grades']['game']}")  # fmt: skip
    if str(pk) in index["games"]:
        index["games"][str(pk)]["status"] = feed["gameData"]["status"]["detailedState"]
        index["games"][str(pk)]["final"] = final
    return n


def run(store, data_cache: str, only: int | None = None) -> int:
    s = fetch.session()
    data = fetch.DataStore(data_cache, s)
    index = load_index(store)
    games = today_games(s)
    todo = wanted(games, index) if only is None else [one_game(games, only)]
    # games that have dropped off the schedule window leave the index; their pages
    # expire with the rest of live/
    keep = {str(g["gamePk"]) for g in games}
    for pk in [k for k in index["games"] if k not in keep]:
        del index["games"][pk]

    t0 = time.perf_counter()
    built = 0
    for g in todo:
        try:
            built += build_game(g, s, data, store, index)
        except Exception as exc:  # noqa: BLE001 - one game must not sink the rest
            print(f"  game {g['gamePk']} FAILED: {exc}", file=sys.stderr)
    index["updated"] = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    index["date"] = dt.datetime.now(ET).date().isoformat()
    store.put(INDEX, json.dumps(index, ensure_ascii=False, indent=1, sort_keys=True).encode(),
              "application/json", INDEX_CACHE)  # fmt: skip
    print(f"{len(todo)} games, {built} cards built, "
          f"{sum(len(g['pitchers']) for g in index['games'].values())} in the index, "
          f"{time.perf_counter() - t0:.0f}s")  # fmt: skip
    return built


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--game", type=int, help="one gamePk, whatever its state")
    ap.add_argument("--out", help="write to this folder instead of the bucket")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the comparison-season cache")
    a = ap.parse_args(argv)
    store = LocalStore(a.out) if a.out else R2Store()
    run(store, a.cache, a.game)
    return 0


if __name__ == "__main__":
    sys.exit(main())
