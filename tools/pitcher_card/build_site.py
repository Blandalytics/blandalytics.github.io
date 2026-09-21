"""Build the cards: one page per pitcher per game, plus the manifests, into the bucket.

    python build_site.py                              # yesterday and today
    python build_site.py --start 2026-08-01 --end 2026-08-31
    python build_site.py --start 2026-08-28 --force   # re-render existing cards
    python build_site.py --reindex                    # only rebuild the index
    python build_site.py --out ./pitcher-cards ...    # a folder instead of the bucket

Writes, under the bucket's ``cards/`` prefix (served from https://data.blandalytics.com):

    cards/<gamePk>-<pitcherId>.html   one standalone page per pitcher per game
    cards/days/<date>.json            that day's games and pitchers: what the picker shows
    cards/index.json                  the dates built, and which date each game is on

The picker page in pitcher-cards/ reads them from there, so nothing is committed to the
repo and a whole season fits. A day's pitches come from the data files in the same bucket
once the day has settled, else from the scraper. Cards already in a day's manifest are
skipped unless --force is given, so the nightly run only pays for new games, and an
interrupted backfill resumes where it stopped. The index is rebuilt from the day
manifests at the end of every run, which is what lets parallel runs share the bucket."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import traceback

from card import DEFAULT_CACHE, ROOT, cards_for_date  # first: it puts the scraper on sys.path

import fetch  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from backfill import LocalStore, R2Store  # noqa: E402

PREFIX = "cards"
# the pages live in the bucket, so the mark cannot be a relative path
LOGO = "https://blandalytics.com/pitcher-cards/PitcherList_Stats_watermark_with_logo.webp"
# a card is only rewritten by --force; the manifests move every night
CARD_CACHE = "public, max-age=3600"
INDEX_CACHE = "public, max-age=120"


def entry(pk: int, pid: int, card: dict) -> dict:
    """What the picker needs to know about a card, straight from its dict. ``file`` is
    relative to the index, so the manifests work wherever they are served from."""
    return {
        "id": pid,
        "name": card["name"],
        "hand": card["hand"],
        "side": "home" if card["home"] else "away",
        "start": card["starter"],
        "grade": card["grades"]["game"],
        "line": card["line"],
        "years": [c["year"] for c in card["comparisons"]],
        "file": f"{pk}-{pid}.html",
    }


def game_entry(card: dict) -> dict:
    home, away = (card["team"], card["opp"]) if card["home"] else (card["opp"], card["team"])
    return {"date": card["date"], "home": home, "away": away, "pitchers": []}


def date_range(start: str, end: str):
    d, stop = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    while d <= stop:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def _dump(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True).encode("utf-8")


class Site:
    """The cards and their manifests in a store: the bucket, or a folder."""

    def __init__(self, store):
        self.store = store

    def day_key(self, date: str) -> str:
        return f"{PREFIX}/days/{date}.json"

    def day(self, date: str) -> dict:
        raw = self.store.get(self.day_key(date))
        return json.loads(raw) if raw else {}

    def has(self, day: dict, pk: int, pid: int) -> bool:
        return any(p["id"] == pid for p in day.get(str(pk), {}).get("pitchers", []))

    def add(self, day: dict, pk: int, pid: int, html: str, card: dict) -> None:
        key = f"{PREFIX}/{pk}-{pid}.html"
        self.store.put(key, html.encode("utf-8"), "text/html; charset=utf-8", CARD_CACHE)
        game = day.setdefault(str(pk), game_entry(card))
        game["pitchers"] = [p for p in game["pitchers"] if p["id"] != pid]
        game["pitchers"].append(entry(pk, pid, card))

    def checkpoint(self, date: str, day: dict) -> None:
        """Write the day's manifest, so a rerun (or another run) skips what is built."""
        if day:
            self.store.put(self.day_key(date), _dump(day), "application/json", INDEX_CACHE)

    def reindex(self) -> dict:
        """Rebuild the index from every day manifest in the store."""
        index = {"days": {}, "games": {}}
        for key in self.store.keys(f"{PREFIX}/days/"):
            date = os.path.basename(key)[: -len(".json")]
            day = json.loads(self.store.get(key) or b"{}")
            index["days"][date] = sum(len(g["pitchers"]) for g in day.values())
            index["games"].update(dict.fromkeys(day, date))
        index["built"] = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.store.put(f"{PREFIX}/index.json", _dump(index), "application/json", INDEX_CACHE)
        return index


def build_day(site: Site, date: str, session, data, force: bool) -> tuple[int, int]:
    """Build one date's cards; returns (built, skipped)."""
    day, built, skipped = site.day(date), 0, []

    def skip(pk: int, pid: int) -> bool:  # cards already built are not rebuilt unless forced
        seen = site.has(day, pk, pid) and not force
        skipped.append(seen)
        return seen

    cards = cards_for_date(date, session, data, strict=False, skip=skip, logo=LOGO)
    for pk, pid, html, card in cards:
        site.add(day, pk, pid, html, card)
        built += 1
        print(f"  {date}  {card['team']} {'vs' if card['home'] else '@'} {card['opp']}  "
              f"{card['name']}  {card['grades']['game']}")  # fmt: skip
    site.checkpoint(date, day)
    return built, sum(skipped)


def build(site: Site, start: str, end: str, force=False, cache=DEFAULT_CACHE, first_season=None):
    """Every date from ``start`` to ``end``, then the index."""
    session = fetch.session()
    data = fetch.DataStore(cache, session, first_season or fetch.FIRST_SEASON)
    built = skipped = failed = 0
    t0 = time.perf_counter()
    for date in date_range(start, end):
        try:
            b, s = build_day(site, date, session, data, force)
            built, skipped = built + b, skipped + s
        except Exception:  # noqa: BLE001 - one bad day must not sink the rest of the range
            failed += 1
            print(f"  {date}  FAILED", file=sys.stderr)
            traceback.print_exc()
    index = site.reindex()
    print(f"built {built}, skipped {skipped}, {failed} days failed, "
          f"{sum(index['days'].values())} cards across {len(index['days'])} dates in the index, "
          f"{time.perf_counter() - t0:.0f}s")  # fmt: skip
    return built


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    today = dt.date.today()
    ap.add_argument("--start", default=(today - dt.timedelta(days=1)).isoformat(),
                    help="first date, YYYY-MM-DD (default: yesterday)")  # fmt: skip
    ap.add_argument("--end", default=today.isoformat(), help="last date (default: today)")
    ap.add_argument("--force", action="store_true", help="re-render cards already in the manifest")
    ap.add_argument("--reindex", action="store_true", help="only rebuild the index")
    ap.add_argument("--out", help="write to this folder instead of the bucket")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the data-file / comparison cache")
    ap.add_argument("--first-season", type=int, default=fetch.FIRST_SEASON,
                    help="earliest comparison season (default: %(default)s)")  # fmt: skip
    a = ap.parse_args(argv)
    site = Site(LocalStore(a.out) if a.out else R2Store())
    if a.reindex:
        index = site.reindex()
        print(f"{sum(index['days'].values())} cards across {len(index['days'])} dates")
        return 0
    build(site, a.start, a.end, a.force, a.cache, a.first_season)
    return 0


if __name__ == "__main__":
    sys.exit(main())
