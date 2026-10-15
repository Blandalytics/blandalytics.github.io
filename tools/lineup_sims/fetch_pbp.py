"""Download a regular season's play-by-play from the MLB Stats API.

Each game's live feed is reduced to what the lineup simulator needs and cached as
tools/lineup_sims/cache/pbp/<season>/<game_pk>.json, so reruns only fetch games not yet
cached:

    python -I tools/lineup_sims/fetch_pbp.py 2026

Per game: the date, both teams, every player's batting-order code ("300" starts in
the 3rd spot, "301" is the first sub into it) and, per play, the inning, the event,
the batter, the batted-ball trajectory, the base runners after the play, and every
runner movement with the play event it happened on (so steals and wild pitches
during a plate appearance can be told apart from what happened on the final pitch).
"""
import concurrent.futures as cf
import json
import pathlib
import sys
import time

import requests

CACHE = pathlib.Path(__file__).resolve().parent / "cache"
API = "https://statsapi.mlb.com/api"
UA = {"User-Agent": "blandalytics-lineup-sim/0.1"}

# play fields, in order, as stored in the cache
PLAY_COLS = ["ab", "inning", "top", "event", "outs", "batter", "pitcher", "stand", "throws",
             "traj", "last_pitch", "post", "away_score", "home_score", "runners"]
RUNNER_COLS = ["id", "start", "end", "out", "idx", "event", "reason"]


def season_dates(s, season):
    d = s.get(f"{API}/v1/seasons/{season}", params={"sportId": 1}, timeout=30).json()["seasons"][0]
    return d["regularSeasonStartDate"], d["regularSeasonEndDate"]


def final_games(s, season):
    start, end = season_dates(s, season)
    sched = s.get(f"{API}/v1/schedule", params={"sportId": 1, "gameType": "R", "startDate": start,
                                                 "endDate": end}, timeout=60).json()
    pks = set()
    for day in sched["dates"]:
        for g in day["games"]:
            if g["status"]["codedGameState"] == "F":
                pks.add(g["gamePk"])
    return sorted(pks), start, end


def reduce_feed(d):
    gd, ld = d["gameData"], d["liveData"]
    teams = {side: {"id": gd["teams"][side]["id"], "abbr": gd["teams"][side]["abbreviation"]}
             for side in ("away", "home")}
    order = {}
    for side in ("away", "home"):
        order[side] = {str(p["person"]["id"]): p["battingOrder"]
                       for p in ld["boxscore"]["teams"][side]["players"].values() if p.get("battingOrder")}
    plays = []
    for p in ld["plays"]["allPlays"]:
        res, about, m = p["result"], p["about"], p["matchup"]
        pitches = [e for e in p["playEvents"] if e.get("isPitch")]
        last = pitches[-1] if pitches else None
        traj = (last or {}).get("hitData", {}).get("trajectory") if last and last["details"].get("isInPlay") else None
        post = [(m.get(k) or {}).get("id") for k in ("postOnFirst", "postOnSecond", "postOnThird")]
        runners = [[r["details"]["runner"]["id"], r["movement"]["start"], r["movement"]["end"],
                    bool(r["movement"]["isOut"]), r["details"].get("playIndex"), r["details"].get("eventType"),
                    r["details"].get("movementReason")] for r in p["runners"]]
        plays.append([about["atBatIndex"], about["inning"], int(about["isTopInning"]), res.get("eventType"),
                      p["count"]["outs"], m["batter"]["id"], m["pitcher"]["id"], m["batSide"]["code"],
                      m["pitchHand"]["code"], traj, last["index"] if last else None, post,
                      res.get("awayScore"), res.get("homeScore"), runners])
    return {"pk": gd["game"]["pk"], "date": gd["datetime"]["officialDate"], "type": gd["game"]["type"],
            "teams": teams, "order": order, "play_cols": PLAY_COLS, "runner_cols": RUNNER_COLS, "plays": plays}


def fetch(s, pk, out):
    path = out / f"{pk}.json"
    if path.exists():
        return pk, "cached"
    for attempt in range(4):
        try:
            r = s.get(f"{API}/v1.1/game/{pk}/feed/live", timeout=60)
            r.raise_for_status()
            path.write_text(json.dumps(reduce_feed(r.json()), separators=(",", ":")), encoding="utf-8")
            return pk, "fetched"
        except (requests.RequestException, ValueError, KeyError) as e:
            err = e
            time.sleep(2 ** attempt)
    return pk, f"failed: {err!r}"


def main(season):
    s = requests.Session()
    s.headers.update(UA)
    pks, start, end = final_games(s, season)
    out = CACHE / "pbp" / str(season)
    out.mkdir(parents=True, exist_ok=True)
    print(f"{season}: {len(pks)} final regular-season games {start}..{end}", flush=True)
    done = 0
    failed = []
    with cf.ThreadPoolExecutor(max_workers=12) as pool:
        for pk, status in pool.map(lambda pk: fetch(s, pk, out), pks):
            done += 1
            if status.startswith("failed"):
                failed.append((pk, status))
            if done % 200 == 0:
                print(f"  {done}/{len(pks)}", flush=True)
    (out / "_games.json").write_text(json.dumps({"season": season, "start": start, "end": end, "games": pks}),
                                     encoding="utf-8")
    print(f"done; {len(failed)} failed", failed[:10], flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2026)
