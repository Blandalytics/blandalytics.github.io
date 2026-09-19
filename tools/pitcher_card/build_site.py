"""Build the GitHub Pages site: one card per pitcher per game, plus the manifests.

    python build_site.py                          # yesterday and today
    python build_site.py --start 2026-08-01 --end 2026-08-31
    python build_site.py --start 2026-08-28 --force   # re-render existing cards

Writes <out>/cards/<gamePk>-<pitcherId>.html, <out>/days/<date>.json (that day's games and
their pitchers: what the picker page shows) and <out>/index.json (the dates built and which
date each game is on). Nothing needs a server: GitHub Pages serves the folder as-is. Cards
already in a day's manifest are skipped unless --force is given, so the nightly run only
pays for new games."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import traceback

from card import DEFAULT_CACHE, cards_for_date  # first: it puts the scraper on sys.path

import fetch  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
# tools/pitcher_card/build_site.py -> <repo>/pitcher-cards, the folder Pages serves
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "..", "pitcher-cards"))


def load_json(path: str, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return default


def save_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1, sort_keys=True)


def entry(pk: int, pid: int, card: dict) -> dict:
    """What the picker needs to know about a card, straight from its dict."""
    return {
        "id": pid,
        "name": card["name"],
        "hand": card["hand"],
        "side": "home" if card["home"] else "away",
        "start": card["starter"],
        "grade": card["grades"]["game"],
        "line": card["line"],
        "years": [c["year"] for c in card["comparisons"]],
        "file": f"cards/{pk}-{pid}.html",
    }


def game_entry(card: dict) -> dict:
    home, away = (card["team"], card["opp"]) if card["home"] else (card["opp"], card["team"])
    return {"date": card["date"], "home": home, "away": away, "pitchers": []}


def date_range(start: str, end: str):
    d, stop = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    while d <= stop:
        yield d.isoformat()
        d += dt.timedelta(days=1)


class Site:
    """The output folder and its manifests."""

    def __init__(self, out: str):
        self.out = out
        self.index_path = os.path.join(out, "index.json")
        self.index = load_json(self.index_path, {"built": None, "days": {}, "games": {}})
        os.makedirs(os.path.join(out, "cards"), exist_ok=True)

    def day_path(self, date: str) -> str:
        return os.path.join(self.out, "days", f"{date}.json")

    def day(self, date: str) -> dict:
        return load_json(self.day_path(date), {})

    def has(self, day: dict, pk: int, pid: int) -> bool:
        return any(p["id"] == pid for p in day.get(str(pk), {}).get("pitchers", []))

    def add(self, day: dict, pk: int, pid: int, html: str, card: dict) -> None:
        with open(os.path.join(self.out, f"cards/{pk}-{pid}.html"), "w", encoding="utf-8") as fh:
            fh.write(html)
        game = day.setdefault(str(pk), game_entry(card))
        game["pitchers"] = [p for p in game["pitchers"] if p["id"] != pid]
        game["pitchers"].append(entry(pk, pid, card))

    def checkpoint(self, date: str, day: dict) -> None:
        """Write the day's manifest and fold it into the index."""
        if not day:
            return
        save_json(self.day_path(date), day)
        self.index["days"][date] = sum(len(g["pitchers"]) for g in day.values())
        self.index["games"].update({pk: date for pk in day})
        self.index["built"] = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        save_json(self.index_path, self.index)


def build_day(site: Site, date: str, session, store, force: bool) -> tuple[int, int]:
    """Build one date's cards; returns (built, skipped)."""
    day, built, skipped = site.day(date), 0, []

    def skip(pk: int, pid: int) -> bool:  # cards already built are not rebuilt unless forced
        seen = site.has(day, pk, pid) and not force
        skipped.append(seen)
        return seen

    for pk, pid, html, card in cards_for_date(date, session, store, strict=False, skip=skip):
        site.add(day, pk, pid, html, card)
        built += 1
        print(f"  {date}  {card['team']} {'vs' if card['home'] else '@'} {card['opp']}  "
              f"{card['name']}  {card['grades']['game']}")  # fmt: skip
    site.checkpoint(date, day)
    return built, sum(skipped)


def build(start, end, force=False, out=DEFAULT_OUT, cache=DEFAULT_CACHE, first_season=None):
    site = Site(out)
    session = fetch.session()
    store = fetch.SeasonStore(cache, session, first_season or fetch.FIRST_SEASON)
    built = skipped = failed = 0
    t0 = time.perf_counter()
    for date in date_range(start, end):
        try:
            b, s = build_day(site, date, session, store, force)
            built, skipped = built + b, skipped + s
        except Exception:  # noqa: BLE001 - one bad day must not sink the rest of the range
            failed += 1
            print(f"  {date}  FAILED", file=sys.stderr)
            traceback.print_exc()
    print(f"built {built}, skipped {skipped}, {failed} days failed, "
          f"{sum(site.index['days'].values())} cards in manifest, "
          f"{time.perf_counter() - t0:.0f}s")  # fmt: skip
    return built


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    today = dt.date.today()
    ap.add_argument("--start", default=(today - dt.timedelta(days=1)).isoformat(),
                    help="first date, YYYY-MM-DD (default: yesterday)")  # fmt: skip
    ap.add_argument(
        "--end", default=today.isoformat(), help="last date, YYYY-MM-DD (default: today)"
    )
    ap.add_argument("--force", action="store_true", help="re-render cards already in the manifest")
    ap.add_argument(
        "--out", default=DEFAULT_OUT, help="site folder to write into (default: %(default)s)"
    )
    ap.add_argument(
        "--cache",
        default=DEFAULT_CACHE,
        help="folder for the cached comparison seasons (default: %(default)s)",
    )
    ap.add_argument(
        "--first-season",
        type=int,
        default=fetch.FIRST_SEASON,
        help="earliest season offered as a comparison (default: %(default)s)",
    )
    a = ap.parse_args(argv)
    build(a.start, a.end, a.force, a.out, a.cache, a.first_season)
    return 0


if __name__ == "__main__":
    sys.exit(main())
