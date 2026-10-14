"""Build the cards: every pitcher's card dict for each day, plus the manifests, into the bucket.

    python build_site.py                              # yesterday and today, every level
    python build_site.py --start 2026-08-01 --end 2026-08-31
    python build_site.py --levels mlb,aaa             # only these levels (sport codes)
    python build_site.py --start 2026-08-28 --force   # rebuild cards already built
    python build_site.py --reindex                    # only rebuild the index
    python build_site.py --prune-pages [--apply]      # retire the old per-card pages
    python build_site.py --out ./pitcher-cards ...    # a folder instead of the bucket

A level is a Stats API sport code, as in the data files (data/<code>/): mlb, aaa, afx
(Single-A), win (winter leagues: the Arizona Fall League), rok, bbc, int, hsb. Every level
with tracked games in the data files' manifest is built. Writes, under the bucket's
``cards/`` prefix (served from https://data.blandalytics.com):

    cards/<level>/data/<date>.json    that day's card dicts, keyed "<gamePk>-<pitcherId>"
    cards/<level>/days/<date>.json    that day's games and pitchers: what the picker lists
    cards/index.json                  the dates built at each level, and where each game is

MLB's cards are written to cards/data/ and cards/days/ as well, and cards/index.json keeps
the MLB-only ``days`` and ``games`` beside ``levels`` and ``level_games``, for the picker
and the Worker that read those today; the reindex copies any MLB day built only at the
old keys to cards/mlb/.

The picker page in pitcher-cards/ reads them from there and draws the card itself with
pitcher-cards/card.js, so nothing is committed to the repo, a whole season fits, and a
change to how the card is drawn needs no rebuild (only a change to the data does). A
day's pitches come from the data files in the same bucket once the day has settled, else
from the scraper. Cards already in a day's manifest are skipped unless --force is given,
so the nightly run only pays for new games, and an interrupted backfill resumes where it
stopped. The index is rebuilt from the day manifests at the end of every run, which is
what lets parallel runs share the bucket.

Before the cards were data, each had a page of its own (cards/<gamePk>-<pitcherId>.html,
named by its manifest entry's ``file``), and the live build wrote live/cards/*.html.
--prune-pages retires them once their days are rebuilt: a page whose card is still listed
becomes a small redirect to the card's view, so links to it keep working, and any other
is deleted. It reports what it would do; --apply does it."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from card import DEFAULT_CACHE, ROOT, cards_for_date  # first: it puts the scraper on sys.path

import fetch  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from backfill import LocalStore, R2Store  # noqa: E402
from card import MLB  # noqa: E402

PREFIX = "cards"
# a day's data is rewritten when the day is rebuilt; the manifests move every night
DATA_CACHE = "public, max-age=300"
INDEX_CACHE = "public, max-age=120"
# the old per-card pages, and where a card is viewed now
OLD_PAGE = re.compile(rf"^(?:live/)?{PREFIX}/(\d+-\d+)\.html$")
LEVEL_DAY = re.compile(rf"^{PREFIX}/([a-z0-9]+)/days/(\d{{4}}-\d\d-\d\d)\.json$")
CARD_VIEW = "https://blandalytics.com/pitcher-cards/card.html"
REDIRECT_CACHE = "public, max-age=86400"
SPORTS = "https://statsapi.mlb.com/api/v1/sports"


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
    }


def game_entry(card: dict) -> dict:
    home, away = (card["team"], card["opp"]) if card["home"] else (card["opp"], card["team"])
    level = card.get("level") or {}
    return {
        "date": card["date"], "home": home, "away": away, "pitchers": [],
        "level": level.get("code", MLB[0]), "league": level.get("league"),
    }  # fmt: skip


def date_range(start: str, end: str):
    d, stop = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    while d <= stop:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def _dump(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True).encode("utf-8")


def _compact(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


class Site:
    """One level's cards and their manifests in a store: the bucket, or a folder."""

    def __init__(self, store, level: str = MLB[0]):
        self.store = store
        self.level = level

    def day_key(self, date: str, level: str | None = None) -> str:
        return f"{PREFIX}/{level or self.level}/days/{date}.json"

    def data_key(self, date: str, level: str | None = None) -> str:
        return f"{PREFIX}/{level or self.level}/data/{date}.json"

    @property
    def legacy(self) -> bool:
        """MLB also keeps its cards at the keys from before the levels."""
        return self.level == MLB[0]

    def _load(self, key: str) -> dict:
        raw = self.store.get(key)
        return json.loads(raw) if raw else {}

    def day(self, date: str) -> tuple[dict, dict]:
        """(the day's manifest, its card dicts); MLB's from the old keys while a day is
        only there."""
        day, data = self._load(self.day_key(date)), self._load(self.data_key(date))
        if not day and self.legacy:
            day = self._load(f"{PREFIX}/days/{date}.json")
            data = self._load(f"{PREFIX}/data/{date}.json")
        return day, data

    def has(self, day: dict, pk: int, pid: int) -> bool:
        return any(p["id"] == pid for p in day.get(str(pk), {}).get("pitchers", []))

    def add(self, day: dict, data: dict, pk: int, pid: int, card: dict) -> None:
        data[f"{pk}-{pid}"] = card
        game = day.setdefault(str(pk), game_entry(card))
        game["pitchers"] = [p for p in game["pitchers"] if p["id"] != pid]
        game["pitchers"].append(entry(pk, pid, card))

    def checkpoint(self, date: str, day: dict, data: dict) -> None:
        """Write the day's cards and then its manifest, so a rerun (or another run)
        skips what is built."""
        if not day:
            return
        keys = [(self.data_key(date), self.day_key(date))]
        if self.legacy:
            keys.append((f"{PREFIX}/data/{date}.json", f"{PREFIX}/days/{date}.json"))
        for data_key, day_key in keys:
            self.store.put(data_key, _compact(data), "application/json", DATA_CACHE)
            self.store.put(day_key, _dump(day), "application/json", INDEX_CACHE)

    def migrate_legacy(self) -> int:
        """Copy every MLB day built only at the old keys to cards/mlb/; returns how many."""
        have = {LEVEL_DAY.match(k).group(2) for k in self.store.keys(f"{PREFIX}/{MLB[0]}/days/")}
        copied = 0
        for key in self.store.keys(f"{PREFIX}/days/"):
            date = os.path.basename(key)[: -len(".json")]
            if date in have:
                continue
            data = self.store.get(f"{PREFIX}/data/{date}.json")
            if data is not None:
                self.store.put(self.data_key(date, MLB[0]), data, "application/json", DATA_CACHE)
            self.store.put(
                self.day_key(date, MLB[0]), self.store.get(key), "application/json", INDEX_CACHE
            )
            copied += 1
        return copied

    def reindex(self) -> dict:
        """Rebuild the index from every day manifest in the store: MLB's ``days`` and
        ``games`` (from the old keys), and every level's dates and games."""
        copied = self.migrate_legacy()
        if copied:
            print(f"copied {copied} MLB days to {PREFIX}/{MLB[0]}/")
        index = {"days": {}, "games": {}, "levels": {}, "level_games": {}}
        for key in self.store.keys(f"{PREFIX}/days/"):
            date = os.path.basename(key)[: -len(".json")]
            day = json.loads(self.store.get(key) or b"{}")
            index["days"][date] = sum(len(g["pitchers"]) for g in day.values())
            index["games"].update(dict.fromkeys(day, date))
        for key in self.store.keys(f"{PREFIX}/"):
            m = LEVEL_DAY.match(key)
            if m:
                self._index_level_day(index, *m.groups(), json.loads(self.store.get(key) or b"{}"))
        index["built"] = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.store.put(f"{PREFIX}/index.json", _dump(index), "application/json", INDEX_CACHE)
        return index

    @staticmethod
    def _index_level_day(index: dict, level: str, date: str, day: dict) -> None:
        entry = index["levels"].setdefault(level, {"days": {}, "leagues": []})
        entry["days"][date] = sum(len(g["pitchers"]) for g in day.values())
        for pk, game in day.items():
            index["level_games"][pk] = [level, date]
            if game.get("league") and game["league"] not in entry["leagues"]:
                entry["leagues"].append(game["league"])

    def listed(self) -> tuple[set[str], set[str]]:
        """("<gamePk>-<pitcherId>" of every card the manifests list, the pages any of
        them still names as its ``file``), the live index's entries included."""
        cards, pages = set(), set()
        days = [json.loads(self.store.get(k) or b"{}") for k in self.store.keys(f"{PREFIX}/days/")]
        live = json.loads(self.store.get("live/cards/index.json") or b"{}").get("games", {})
        for games in (*days, live):
            for pk, game in games.items():
                for p in game.get("pitchers", []):
                    cards.add(f"{pk}-{p['id']}")
                    if p.get("file"):
                        pages.add(os.path.basename(p["file"]))
        return cards, pages


def redirect_page(card: str) -> bytes:
    """What an old card page's address serves once the page is retired: the card's view."""
    url = f"{CARD_VIEW}#{card}"
    return (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
        f'<meta name="robots" content="noindex"><link rel="canonical" href="{url}">'
        f'<meta http-equiv="refresh" content="0; url={url}">'
        f"<script>location.replace({json.dumps(url)})</script>"
        "<title>PLV Pitcher Game Card</title></head>"
        f'<body><a href="{url}">This card has moved.</a></body></html>\n'
    ).encode()


def _fate(key: str, cards: set[str], pages: set[str]) -> str:
    if key.startswith("live/"):
        return "delete"  # the live build's: a game's live cards are card dicts now
    if os.path.basename(key) in pages:
        return "keep"
    return "redirect" if OLD_PAGE.match(key).group(1) in cards else "delete"


def prune_plan(site: Site) -> dict[str, list[str]]:
    """Every old page, by what becomes of it: "redirect" (its card is still listed),
    "delete" (it is not, or the page is the live build's) or "keep" (a manifest still
    frames it, its day not yet rebuilt)."""
    cards, pages = site.listed()
    plan = {"redirect": [], "delete": [], "keep": []}
    for key in [*site.store.keys(f"{PREFIX}/"), *site.store.keys(f"live/{PREFIX}/")]:
        if OLD_PAGE.match(key):
            plan[_fate(key, cards, pages)].append(key)
    return plan


def prune_pages(site: Site, apply: bool, workers: int = 16) -> dict[str, list[str]]:
    """Retire the old per-card pages (see prune_plan); a report unless ``apply``."""
    plan = prune_plan(site)
    for action, keys in plan.items():
        print(f"{action:8} {len(keys):6} pages  {' '.join(keys[:3])}")
    if not apply:
        print("(a report: --apply to redirect and delete)")
        return plan

    def redirect(key):
        card = OLD_PAGE.match(key).group(1)
        site.store.put(key, redirect_page(card), "text/html; charset=utf-8", REDIRECT_CACHE)

    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(redirect, plan["redirect"]))
        list(pool.map(site.store.delete, plan["delete"]))
    print(f"redirected {len(plan['redirect'])}, deleted {len(plan['delete'])}")
    return plan


def build_day(site: Site, date: str, session, store, force: bool, level=MLB) -> tuple[int, int]:
    """Build one level's cards for one date from ``store``, that level's DataStore;
    returns (built, skipped)."""
    (day, data), built, skipped = site.day(date), 0, []

    def skip(pk: int, pid: int) -> bool:  # cards already built are not rebuilt unless forced
        seen = site.has(day, pk, pid) and not force
        skipped.append(seen)
        return seen

    cards = cards_for_date(date, session, store, strict=False, skip=skip, level=level)
    for pk, pid, _, card in cards:
        site.add(day, data, pk, pid, card)
        built += 1
        at = "vs" if card["home"] else "@"
        print(f"  {date}  {level[0]:4} {card['team']} {at} {card['opp']}  "
              f"{card['name']}  {card['grades']['game']}")  # fmt: skip
    site.checkpoint(date, day, data)
    return built, sum(skipped)


def levels(session, manifest: dict, wanted: str = "all") -> list[tuple[str, int, str]]:
    """(code, sportId, name) of every level with tracked games in the data files (and MLB
    always), or of the ``wanted`` codes among them."""
    ids = {u["sport"]: u["sport_id"] for u in manifest.get("units", {}).values()}
    codes = {MLB[0], *manifest.get("last_finalized", {})} & {MLB[0], *ids}
    if wanted != "all":
        codes &= {c.strip() for c in wanted.split(",")}
    r = session.get(SPORTS, params={"fields": "sports,id,code,name"}, timeout=30)
    r.raise_for_status()
    names = {s["code"]: s["name"] for s in r.json()["sports"]}
    ids[MLB[0]] = MLB[1]
    return sorted(((c, ids[c], names.get(c, c)) for c in codes), key=lambda lv: lv[1])


def build(site: Site, start: str, end: str, force=False, cache=DEFAULT_CACHE, first_season=None,
          wanted: str = "all"):  # fmt: skip
    """Every level's cards for every date from ``start`` to ``end``, then the index."""
    session = fetch.session()
    first = first_season or fetch.FIRST_SEASON
    mlb_data = fetch.DataStore(cache, session, first)
    built = skipped = failed = 0
    t0 = time.perf_counter()
    for level in levels(session, mlb_data.manifest, wanted):
        data = mlb_data if level == MLB else fetch.DataStore(cache, session, first, sport=level[0])
        level_site = Site(site.store, level[0])
        for date in date_range(start, end):
            try:
                b, s = build_day(level_site, date, session, data, force, level)
                built, skipped = built + b, skipped + s
            except Exception:  # noqa: BLE001 - one bad day must not sink the rest of the range
                failed += 1
                print(f"  {date}  {level[0]}  FAILED", file=sys.stderr)
                traceback.print_exc()
    index = site.reindex()
    print(f"built {built}, skipped {skipped}, {failed} days failed, "
          f"{sum(sum(lv['days'].values()) for lv in index['levels'].values())} cards across "
          f"{len(index['levels'])} levels in the index, "
          f"{time.perf_counter() - t0:.0f}s")  # fmt: skip
    return built


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    today = dt.date.today()
    ap.add_argument("--start", default=(today - dt.timedelta(days=1)).isoformat(),
                    help="first date, YYYY-MM-DD (default: yesterday)")  # fmt: skip
    ap.add_argument("--end", default=today.isoformat(), help="last date (default: today)")
    ap.add_argument("--force", action="store_true", help="rebuild cards already in the manifest")
    ap.add_argument("--levels", default="all",
                    help="sport codes, e.g. mlb,aaa (default: every tracked level)")  # fmt: skip
    ap.add_argument("--reindex", action="store_true", help="only rebuild the index")
    ap.add_argument("--prune-pages", action="store_true",
                    help="report what becomes of the old per-card pages")  # fmt: skip
    ap.add_argument("--apply", action="store_true", help="with --prune-pages: do it")
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
    if a.prune_pages:
        prune_pages(site, a.apply)
        return 0
    build(site, a.start, a.end, a.force, a.cache, a.first_season, a.levels)
    return 0


if __name__ == "__main__":
    sys.exit(main())
