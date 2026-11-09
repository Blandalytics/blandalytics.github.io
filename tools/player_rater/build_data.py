"""Build the compact per-season rater data (player-rater pipeline, step 2).

Reads cache/<season>/ (from fetch.py) and writes out/<season>.json plus out/index.json:
  {season, start, end, ndays, half1End, half2Start, built, hk, pk, players: [{i, n, t, he?, h?, pe?, p?}]}
h / p are flat daily lines: [d, ...hk[1:]] / [d, ...pk[1:]] with d = days since start.

Rules (as in the 2026 rater):
  - hitting rows from primary-position pitchers are dropped, pitching rows from position players too;
    two-way players (TWP, e.g. Ohtani) keep both and are valued as two players.
  - QS per game: GS = 1, 18+ outs, 3 or fewer ER.
  - hitter eligibility: 10 games or 5 starts at a position that season (LF/CF/RF pool as OF), else the
    most-played fielding position (games, starts, innings); DH-only = [] (Util).
  - pitcher eligibility: SP = 3+ GS, RP = 5+ relief appearances, else the more frequent role (ties: SP).
"""
import collections
import datetime as dt
import gzip
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent  # cache/ (from fetch.py) and out/ (the files for R2), neither committed
CACHE, OUT = ROOT / "cache", ROOT / "out"
HK = ["d", "plateAppearances", "atBats", "hits", "doubles", "triples", "homeRuns", "runs", "rbi",
      "stolenBases", "caughtStealing", "baseOnBalls", "hitByPitch", "sacFlies", "strikeOuts"]
PK = ["d", "G", "GS", "outs", "W", "L", "SV", "HLD", "SO", "ER", "H", "BB", "HBP", "QS", "BS"]
PSRC = {"G": "gamesPitched", "GS": "gamesStarted", "outs": "outs", "W": "wins", "L": "losses", "SV": "saves",
        "HLD": "holds", "SO": "strikeOuts", "ER": "earnedRuns", "H": "hits", "BB": "baseOnBalls",
        "HBP": "hitBatsmen", "BS": "blownSaves"}
HPOS = ["C", "1B", "2B", "3B", "SS", "OF"]
FPOS = {"C": "C", "1B": "1B", "2B": "2B", "3B": "3B", "SS": "SS", "LF": "OF", "CF": "OF", "RF": "OF", "DH": "DH"}


def load(path):
    with gzip.open(path, "rt", encoding="utf8") as f:
        return json.load(f)


def splits(path):
    return load(path)["stats"][0]["splits"]


def build(season):
    src = CACHE / str(season)
    info = load(src / "season.json.gz")["seasons"][0]
    abbr = {t["id"]: t["abbreviation"] for t in load(src / "teams.json.gz")["teams"]}
    start = dt.date.fromisoformat(info["regularSeasonStartDate"])
    files = sorted(src.glob("hitting-*.json.gz"))
    last = max(dt.date.fromisoformat(f.name[8:18]) for f in files)
    ndays = (last - start).days + 1
    players = {}  # id -> record, in order of first appearance
    tot_p = collections.defaultdict(lambda: [0, 0])  # id -> [G, GS]

    def rec(s):
        pid = s["player"]["id"]
        r = players.setdefault(pid, {"i": pid, "n": s["player"]["fullName"], "t": None, "td": -1})
        return r

    for i in range(ndays):
        day = start + dt.timedelta(days=i)
        for g in ("hitting", "pitching"):
            path = src / f"{g}-{day}.json.gz"
            if not path.exists():
                continue
            for s in splits(path):
                pos = s.get("position", {}).get("abbreviation")
                st = s["stat"]
                if g == "hitting":
                    if pos == "P":
                        continue
                    r = rec(s)
                    r.setdefault("h", []).extend([i] + [int(st.get(k, 0)) for k in HK[1:]])
                else:
                    if pos not in ("P", "TWP"):
                        continue
                    r = rec(s)
                    row = {k: int(st.get(v, 0)) for k, v in PSRC.items()}
                    row["QS"] = int(row["GS"] == 1 and row["outs"] >= 18 and row["ER"] <= 3)
                    r.setdefault("p", []).extend([i] + [row[k] for k in PK[1:]])
                    tot_p[r["i"]][0] += row["G"]
                    tot_p[r["i"]][1] += row["GS"]
                team = s.get("team", {}).get("id")
                if team in abbr and i >= r["td"]:
                    r["t"], r["td"] = abbr[team], i

    # hitter eligibility from season fielding
    fg = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0.0]))
    for s in splits(src / "fielding.json.gz"):
        p = FPOS.get(s["position"]["abbreviation"])
        if p:
            a = fg[s["player"]["id"]][p]
            a[0] += int(s["stat"].get("games", s["stat"].get("gamesPlayed", 0)) or 0)
            a[1] += int(s["stat"].get("gamesStarted", 0) or 0)
            ip = str(s["stat"].get("innings", "0") or "0").split(".")
            a[2] += int(ip[0]) + (int(ip[1]) / 3 if len(ip) > 1 and ip[1] else 0)

    out = []
    for r in players.values():
        o = {"i": r["i"], "n": r["n"], "t": r["t"] or ""}
        if "h" in r:
            pos = fg.get(r["i"], {})
            el = [p for p in HPOS if p in pos and (pos[p][0] >= 10 or pos[p][1] >= 5)]
            field = [p for p in HPOS if p in pos]
            if not el and field:  # most-played fielding position (games, then starts, then innings)
                el = [max(field, key=lambda p: (*pos[p], HPOS.index(p)))]
            o["he"], o["h"] = el, r["h"]
        if "p" in r:
            g, gs = tot_p[r["i"]]
            el = (["SP"] if gs >= 3 else []) + (["RP"] if g - gs >= 5 else [])
            o["pe"], o["p"] = el or (["SP"] if gs >= g - gs else ["RP"]), r["p"]
        out.append(o)

    end = start + dt.timedelta(days=ndays - 1)
    data = {
        "season": season, "start": str(start), "end": str(end), "ndays": ndays,
        "half1End": info.get("lastDate1stHalf"), "half2Start": info.get("firstDate2ndHalf"),
        # the build time is the page's ?v= for this file, so a rebuild is never served from an old cache
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hk": HK, "pk": PK, "players": out,
    }
    OUT.mkdir(exist_ok=True)
    path = OUT / f"{season}.json"
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf8")
    nh = sum("h" in o for o in out)
    np_ = sum("p" in o for o in out)
    print(f"{season}: {start}..{end} ({ndays} days), {nh} hitters, {np_} pitchers, {path.stat().st_size / 1e6:.2f} MB")
    return {"season": season, "start": str(start), "end": str(end), "bytes": path.stat().st_size}


def write_index():
    seasons = []
    for p in sorted(OUT.glob("[0-9][0-9][0-9][0-9].json")):
        d = json.loads(p.read_text(encoding="utf8"))
        seasons.append({"season": d["season"], "start": d["start"], "end": d["end"], "built": d["built"],
                        "players": len(d["players"])})
    idx = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "seasons": seasons}
    (OUT / "index.json").write_text(json.dumps(idx, indent=1), encoding="utf8")
    print("index:", [s["season"] for s in seasons])


if __name__ == "__main__":
    for a in sys.argv[1:]:
        build(int(a))
    write_index()
