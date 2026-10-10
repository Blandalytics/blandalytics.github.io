"""Inputs and expected outputs for the live Worker's parity check: real games, scored and
carded by this pipeline, for tools/live/test/card_parity.mjs to repeat in JavaScript.

    python parity.py OUT_DIR                  # the MLB games of yesterday (Eastern)
    python parity.py OUT_DIR --game 822761    # particular games (repeatable)

Writes to OUT_DIR: scorer.pack (export_scorer.bundle), and per game a folder with the feed,
the per-pitch run values, the card dicts, the arm angles and each pitcher's pack as of
the game's date. The Worker's port of the pitch models and of build_data is checked
against these; the nightly workflow runs it so that a change on either side shows up the
day it lands rather than in a card."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import sys
from zoneinfo import ZoneInfo

from card import DEFAULT_CACHE, cards_for_game, game_pitches, pitch_values  # first: sys.path

import export_scorer  # noqa: E402
import fetch  # noqa: E402
import packs  # noqa: E402
import pitch_model  # noqa: E402

ET = ZoneInfo("America/New_York")


def _write(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)


def games_on(s, date: dt.date) -> list[int]:
    """The finished MLB games of a date."""
    params = {"sportId": 1, "date": date.isoformat(), "gameType": "R,F,D,L,W"}
    r = s.get("https://statsapi.mlb.com/api/v1/schedule", params=params, timeout=30)
    r.raise_for_status()
    return [g["gamePk"] for d in r.json().get("dates", []) for g in d["games"]
            if g["status"]["codedGameState"] == "F"]  # fmt: skip


def values_json(pm, df) -> dict:
    """Per pitch ("abi:pitch_number"): the run values and the card's plus columns."""
    raw = pm.score(df)
    cols = pm.columns(raw)
    out = {}
    for key in raw.index:
        _, abi, pn = key
        out[f"{abi}:{pn}"] = {**raw.loc[key].astype(float).to_dict(), **cols.loc[key].to_dict()}
    return out


def dump_game(out: str, pk: int, s, store, seasons_for) -> int:
    feed = fetch.feed(s, pk)
    date = dt.date.fromisoformat(feed["gameData"]["datetime"]["officialDate"])
    df = game_pitches(pk, s)
    d = os.path.join(out, str(pk))
    os.makedirs(d, exist_ok=True)
    with gzip.open(os.path.join(d, "feed.json.gz"), "wt", encoding="utf-8") as fh:
        json.dump(feed, fh)
    _write(os.path.join(d, "values.json"), values_json(pitch_values(s, store), df))
    cards = {str(pid): card for pid, _, card in cards_for_game(pk, feed, df, s, store)}
    _write(os.path.join(d, "cards.json"), cards)
    arms = fetch.arm_angles(s, date, game_type=feed["gameData"]["game"]["type"])
    _write(os.path.join(d, "arms.json"), {p: arms.get(int(p), {}) for p in cards})
    seasons = seasons_for(date)
    through = date - dt.timedelta(days=1)
    _write(os.path.join(d, "packs.json"),
           {p: packs.build_pack(int(p), seasons, through) for p in cards})  # fmt: skip
    return len(cards)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", help="the folder to write")
    ap.add_argument("--game", type=int, action="append", help="a gamePk (default: yesterday's)")
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the data-file / model cache")
    a = ap.parse_args(argv)
    s = fetch.session()
    store = fetch.DataStore(a.cache, s)
    pm = pitch_model.PitchModel(a.cache, s)
    pm.ensure()
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "scorer.pack"), "wb") as fh:
        fh.write(export_scorer.bundle(pm.dir))
    loaded: dict = {}

    def seasons_for(date):  # the season frames, loaded once per date
        if date not in loaded:
            loaded[date] = packs.load_seasons(store, date)
        return loaded[date]

    yesterday = dt.datetime.now(ET).date() - dt.timedelta(days=1)
    for pk in a.game or games_on(s, yesterday):
        print(f"{pk}: {dump_game(a.out, pk, s, store, seasons_for)} cards")
    return 0


if __name__ == "__main__":
    sys.exit(main())
