"""Build created-runs/data.json, the Created Runs Leaders page's data, from the off_val leaderboard.

    python -I tools/created_runs/build_data.py <off_val_leaders_<season>.csv>

The CSV is the Total Offensive Value project's (claude_sessions/website/created-runs, offval_scraper.py): one row per
hitter, every column runs above an RE24 baseline. The page shows hitters with MIN_PA or more, as
the page's columns:

    CR      off_val           CR/600  off_val per 600 PA
    bCR     batting           State Change  contact      Hit Luck  hit_luck
    BB      walk              HBP     hit_by_pitch       K         strikeout
    rCR     running           Home-to-First  home_to_first          BsR  baserunning
    SB      stolen_base       CS+PO   caught_stealing + pickoff

with each column's lowest and highest value among them (the heat cells' ends). After a rebuild,
bump data.json?v= in created-runs/app.js and app.js?v= in created-runs/index.html.
"""
import csv
import json
import sys
from pathlib import Path

MIN_PA = 400
OUT = Path(__file__).resolve().parents[2] / "created-runs" / "data.json"
KEYS = ["name", "pa", "cr", "cr600", "bcr", "state", "luck", "bb", "hbp", "k",
        "rcr", "h2f", "bsr", "sb", "cspo"]


def row_of(r):
    pa = int(r["PA"])
    f = lambda k: float(r[k])
    return [r["player_name"], pa, f("off_val"), round(f("off_val") * 600 / pa, 2), f("batting"),
            f("contact"), f("hit_luck"), f("walk"), f("hit_by_pitch"), f("strikeout"), f("running"),
            f("home_to_first"), f("baserunning"), f("stolen_base"),
            round(f("caught_stealing") + f("pickoff"), 2)]


def main(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:   # the CSV starts with a BOM
        src = list(csv.DictReader(fh))
    seasons = {r["season"] for r in src}
    if len(seasons) != 1:
        sys.exit(f"expected one season in {path}, found {sorted(seasons)}")
    rows = sorted((row_of(r) for r in src if int(r["PA"]) >= MIN_PA), key=lambda x: (-x[2], x[0]))
    scale = {k: {"min": min(x[i] for x in rows), "max": max(x[i] for x in rows)}
             for i, k in enumerate(KEYS) if k not in ("name", "pa")}
    data = {"season": int(seasons.pop()), "minPa": MIN_PA, "players": len(rows),
            "keys": KEYS, "rows": rows, "scale": scale}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {len(rows)} hitters with {MIN_PA}+ PA, {data['season']}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
