"""NBA Shot Charts data: one season's shots and minutes -> JSON in R2 under nba/.

The data behind Blandalytics/nba_shot_chart (nba-scoring-chart.streamlit.app), shaped for
the browser. The app's own pandas steps (load_season, load_league_minutes) run here; the
page only sums and draws.

  nba/manifest.json            the seasons on offer, each with its `updated` stamp (the
                               page's ?v= for that season's files)
  nba/<season>/shots.json      every regular-season FGA: player, game, location (the app's
                               flipped LOC_X), make, 2/3, xPTS from the xFG grid, and the
                               shot-zone index for xFTA; plus each player-game's FTA/FTM
  nba/<season>/minutes.json    every player-game's minutes, for Team Minutes Breakdown
  nba/xfg_grid.json            the app's background hexbin (the xFG grid's mean xPTS per hex,
                               computed by matplotlib with the app's gridsize and extent) and
                               the seaborn `vlag` colormap it is drawn in

stats.nba.com answers from a home connection but not from cloud runners, so this runs on a
local Windows Task Scheduler task rather than in GitHub Actions, uploading with the wrangler login.

    python tools/nba_shot_charts/build_data.py                      # current season, upload
    python tools/nba_shot_charts/build_data.py --season 2025-26     # any season
    python tools/nba_shot_charts/build_data.py --out /tmp/nba       # write files, no upload
"""
import argparse
import json
import shutil
import subprocess
import time
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from nba_api.stats.endpoints import PlayerGameLogs, shotchartdetail

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
BUCKET = "blandalytics-live"
PREFIX = "nba"
PUBLIC = "https://data.blandalytics.com"
UA = "blandalytics-nba (blandalytics.com)"
XFG_URL = "https://raw.githubusercontent.com/Blandalytics/nba_shot_chart/main/nba_xFG_values.csv"
TIMEOUT = 120

# The app's shot zones and its xFTA model (FTA per shot, by zone, plus an intercept)
ZONES = ["Restricted Area", "Paint", "Mid-Range", "Corner 3", "Standard 3"]
ZONE_OF = {
    "Restricted Area": 0, "In The Paint (Non-RA)": 1, "Mid-Range": 2,
    "Left Corner 3": 3, "Right Corner 3": 3, "Above the Break 3": 4, "Backcourt": 4,
}
XFTA = [0.37529371, 0.32000943, 0.29288417, 0.0211961, 0.14330077]
XFTA_BASE = 0.049

# The app's hexbin: gridsize (5*7, 3*7) over extent (-250, 250, -y_adj, y_lim)
HEX_GRID = (35, 21)
HEX_EXTENT = (-250, 250, -52.5, 470)


def current_season(today=None):
    today = today or date.today()
    start = today.year if today.month >= 9 else today.year - 1
    return f"{start}-{(start + 1) % 100:02d}"


def fetch(label, fn, retries=3):
    for attempt in range(1, retries + 1):
        try:
            t0 = time.time()
            df = fn()
            print(f"{label}: {len(df):,} rows in {time.time() - t0:.1f}s")
            return df
        except Exception as e:
            print(f"{label}: attempt {attempt} failed ({type(e).__name__}: {e})")
            if attempt == retries:
                raise
            time.sleep(5 * attempt)


def pull(season, attempts=6):
    """The game logs and the shots, once they agree. stats.nba.com answers from caches that
    can lag each other by a day's games (the same request has come back with 25 games, then
    28), so pull both until every player-game's shot count matches its FGA."""
    for attempt in range(1, attempts + 1):
        logs, shots = pull_once(season)
        if logs.empty:
            return logs, shots
        fga = logs.set_index(["PLAYER_ID", "GAME_ID"])["FGA"]
        counts = shots.groupby(["PLAYER_ID", "GAME_ID"]).size().reindex(fga.index, fill_value=0)
        stray = len(shots) - int(counts.sum())   # shots in games the logs don't have
        off = int((counts != fga).sum())
        if not off and not stray:
            return logs, shots
        print(f"attempt {attempt}: logs and shots disagree ({off} player-games, {stray} shots outside the logs); retrying")
        time.sleep(30)
    raise RuntimeError("stats.nba.com never returned matching game logs and shots; nothing written")


def pull_once(season):
    logs = fetch("PlayerGameLogs", lambda: PlayerGameLogs(
        league_id_nullable="00", season_nullable=season, season_type_nullable="Regular Season",
        timeout=TIMEOUT).get_data_frames()[0])
    if logs.empty:
        return logs, pd.DataFrame()

    # A league-wide ShotChartDetail call silently stops at 102,400 rows (about half a
    # season), so ask for one calendar month at a time.
    game_dates = pd.to_datetime(logs["GAME_DATE"])
    chunks = []
    for month in pd.period_range(game_dates.min(), game_dates.max(), freq="M"):
        time.sleep(1)
        start, end = month.start_time, month.end_time
        chunks.append(fetch(f"ShotChartDetail {month}", lambda: shotchartdetail.ShotChartDetail(
            team_id=0, player_id=0, context_measure_simple="FGA",
            season_nullable=season, season_type_all_star="Regular Season",
            date_from_nullable=f"{start:%m/%d/%Y}", date_to_nullable=f"{end:%m/%d/%Y}",
            timeout=TIMEOUT).get_data_frames()[0]))
    shots = (pd.concat(chunks, ignore_index=True)
             .drop_duplicates(["GAME_ID", "GAME_EVENT_ID", "PLAYER_ID"])
             .sort_values(["GAME_DATE", "GAME_ID", "GAME_EVENT_ID"])
             .reset_index(drop=True))
    return one_row_per_player_game(logs, shots), shots


def one_row_per_player_game(logs, shots):
    """stats.nba.com sometimes logs a player twice in one game, once for the other team: on
    2026-10-26 Devin Booker had his real PHX line and an OKC line of 0:00 and 1-1 free throws
    (most likely an OKC technical free throw filed under his id). Keep the row for the team the
    player's shots came from, else the one with the most minutes, and say what was dropped."""
    key = ["PLAYER_ID", "GAME_ID"]
    dup = logs[logs.duplicated(key, keep=False)].copy()
    if dup.empty:
        return logs
    shot_team = shots.groupby(key)["TEAM_ID"].agg(lambda t: t.mode().iloc[0])
    dup["_shot_team"] = [shot_team.get((p, g)) for p, g in zip(dup["PLAYER_ID"], dup["GAME_ID"])]
    dup["_match"] = dup["TEAM_ID"] == dup["_shot_team"]
    keep = dup.sort_values(["_match", "MIN"], ascending=False).drop_duplicates(key).index
    dropped = dup.index.difference(keep)
    for i in dropped:
        r = logs.loc[i]
        print(f"dropped a duplicate log row: {r['PLAYER_NAME']} {r['GAME_DATE'][:10]} {r['MATCHUP']} "
              f"({r['MIN']:g} min, {r['FGA']} FGA, {r['FTM']}-{r['FTA']} FT, {r['PTS']} pts)")
    return logs.drop(dropped)


def roster(logs, shots):
    """One name per player id: the app filters to nba_api's bundled active-player list, which
    lags the season and spells some names differently from the stats API, and the API itself
    sometimes spells a player two ways across games ("Moussa Cisse" / "Moussa Cissé"). Everyone
    who logged a game keeps their most frequent spelling."""
    names = pd.concat([logs[["PLAYER_ID", "PLAYER_NAME"]], shots[["PLAYER_ID", "PLAYER_NAME"]]])
    names = names.groupby("PLAYER_ID")["PLAYER_NAME"].agg(lambda s: s.value_counts().index[0])
    if names.duplicated().any():
        raise ValueError(f"two players share a name: {names[names.duplicated(keep=False)].tolist()}")
    return names


def xfg_grid():
    CACHE.mkdir(exist_ok=True)
    path = CACHE / "nba_xFG_values.csv"
    if not path.exists():
        req = urllib.request.Request(XFG_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
            shutil.copyfileobj(r, f)
    return pd.read_csv(path)


def shots_json(season, logs, shots, names, grid, updated):
    shots = shots.merge(grid[["LOC_X", "LOC_Y", "xPTS"]], how="left", on=["LOC_X", "LOC_Y"])
    shots = shots[shots["PLAYER_ID"].isin(names.index)].reset_index(drop=True)

    players = sorted(shots["PLAYER_ID"].unique(), key=lambda pid: names[pid])
    p_idx = {pid: i for i, pid in enumerate(players)}
    games = (shots[["GAME_ID", "GAME_DATE"]].drop_duplicates("GAME_ID")
             .sort_values(["GAME_DATE", "GAME_ID"]).reset_index(drop=True))
    g_idx = {gid: i for i, gid in enumerate(games["GAME_ID"])}

    # FTA and FTM ride on the player-games the player took a shot in, as in the app's merge
    pg = shots[["PLAYER_ID", "GAME_ID", "TEAM_ID"]].drop_duplicates(["PLAYER_ID", "GAME_ID"])
    pg = pg.merge(logs[["PLAYER_ID", "GAME_ID", "FTA", "FTM", "MATCHUP"]], how="left", on=["PLAYER_ID", "GAME_ID"])
    pg[["FTA", "FTM"]] = pg[["FTA", "FTM"]].fillna(0).astype(int)
    pg = pg.assign(p=pg["PLAYER_ID"].map(p_idx), g=pg["GAME_ID"].map(g_idx)).sort_values(["p", "g"])

    made = shots["SHOT_MADE_FLAG"].astype(int)
    value = shots["SHOT_TYPE"].map({"3PT Field Goal": 3, "2PT Field Goal": 2}).astype(int)
    zone = shots["SHOT_ZONE_BASIC"].map(ZONE_OF)
    xpts = shots["xPTS"].round(4)
    return {
        "season": season,
        "updated": updated,
        "zones": ZONES,
        "xfta": {"base": XFTA_BASE, "per_zone": XFTA},
        "players": [[int(pid), names[pid]] for pid in players],
        "games": [[gid, d] for gid, d in zip(games["GAME_ID"], pd.to_datetime(games["GAME_DATE"]).dt.strftime("%Y-%m-%d"))],
        "player_games": {
            "p": pg["p"].astype(int).tolist(),
            "g": pg["g"].astype(int).tolist(),
            "team": pg["TEAM_ID"].astype(int).tolist(),
            "matchup": pg["MATCHUP"].fillna("").tolist(),
            "fta": pg["FTA"].tolist(),
            "ftm": pg["FTM"].tolist(),
        },
        # in the app's order (date, game, event), so a season chart's "last 200 shots" match
        "shots": {
            "p": shots["PLAYER_ID"].map(p_idx).astype(int).tolist(),
            "g": shots["GAME_ID"].map(g_idx).astype(int).tolist(),
            "x": (-shots["LOC_X"]).astype(int).tolist(),   # the app flips the axis
            "y": shots["LOC_Y"].astype(int).tolist(),
            "made": made.tolist(),
            "value": value.tolist(),
            "zone": [None if pd.isna(z) else int(z) for z in zone],
            "xpts": [None if pd.isna(v) else float(v) for v in xpts],
        },
    }


def minutes_json(season, logs, names, updated):
    logs = logs.assign(PLAYER_NAME=logs["PLAYER_ID"].map(names))
    people = sorted(logs["PLAYER_NAME"].unique())
    n_idx = {n: i for i, n in enumerate(people)}
    logs = logs.sort_values(["GAME_DATE", "TEAM_ID", "PLAYER_NAME"])
    return {
        "season": season,
        "updated": updated,
        "players": people,
        "rows": {
            "team": logs["TEAM_ID"].astype(int).tolist(),
            "player": logs["PLAYER_NAME"].map(n_idx).astype(int).tolist(),
            "date": pd.to_datetime(logs["GAME_DATE"]).dt.strftime("%Y-%m-%d").tolist(),
            "min": logs["MIN"].astype(float).round(3).tolist(),
        },
    }


def grid_json(grid):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import seaborn as sns

    # The app's background_data: the grid within 35 ft, less the strip behind the backboard
    center_hoop = 12.5
    dist = (grid["LOC_X"].abs() ** 2 + grid["LOC_Y"].abs() ** 2) ** 0.5 / 10
    bg = grid.loc[(dist <= 35) & ((grid["LOC_Y"] >= -center_hoop / 2) | (grid["LOC_X"].abs() >= 80) |
                                  (grid["LOC_X"].abs().sub(30) > grid["LOC_Y"].abs().sub(center_hoop).mul(1.5)))]
    fig, ax = plt.subplots()
    hb = ax.hexbin(x=bg["LOC_X"], y=bg["LOC_Y"], C=bg["xPTS"], gridsize=HEX_GRID, extent=HEX_EXTENT)
    centers, values = hb.get_offsets(), hb.get_array()
    plt.close(fig)
    keep = ~np.ma.getmaskarray(values)
    cmap = sns.color_palette("vlag", as_cmap=True)
    xmin, xmax, ymin, ymax = HEX_EXTENT
    return {
        "gridsize": list(HEX_GRID),
        "extent": list(HEX_EXTENT),
        # matplotlib's hexagon: pointy-top, sx wide and 2*sy/3 from center to tip
        "sx": (xmax - xmin) / HEX_GRID[0],
        "sy": (ymax - ymin) / HEX_GRID[1],
        "x": np.round(centers[keep, 0], 4).tolist(),
        "y": np.round(centers[keep, 1], 4).tolist(),
        "xpts": np.round(np.asarray(values)[keep], 5).tolist(),
        "norm": {"center": 1.09, "halfrange": 0.42},
        "cmap": [matplotlib.colors.to_hex(cmap(i / 255)) for i in range(256)],
    }


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  {path}  {path.stat().st_size / 1e6:.2f} MB")


def upload(local, key, cache_control):
    npx = shutil.which("npx") or "npx"
    cmd = [npx, "--yes", "wrangler@4", "r2", "object", "put", f"{BUCKET}/{key}", "--file", str(local),
           "--content-type", "application/json; charset=utf-8", "--cache-control", cache_control, "--remote"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or "Upload complete" not in r.stdout:
        raise RuntimeError(f"wrangler put {key} failed:\n{r.stdout}\n{r.stderr}")
    print(f"  uploaded {key}")


def read_manifest():
    # origin, not the edge copy: a fresh query string skips the cached bare URL
    req = urllib.request.Request(f"{PUBLIC}/{PREFIX}/manifest.json?v={time.time_ns()}", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except Exception:
        return {"seasons": []}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", default=current_season())
    parser.add_argument("--out", help="write the files here and upload nothing")
    args = parser.parse_args()

    season = args.season
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    logs, shots = pull(season)
    if shots.empty:
        print(f"{season}: no regular-season games yet; nothing to write")
        return
    names = roster(logs, shots)
    grid = xfg_grid()

    shots_obj = shots_json(season, logs, shots, names, grid, updated)
    minutes_obj = minutes_json(season, logs, names, updated)
    n_shots, n_games = len(shots_obj["shots"]["p"]), len(shots_obj["games"])

    manifest = read_manifest() if not args.out else {"seasons": []}
    entry = {"season": season, "updated": updated, "games": n_games, "shots": n_shots,
             "last_date": shots_obj["games"][-1][1]}
    seasons = [s for s in manifest.get("seasons", []) if s.get("season") != season] + [entry]
    manifest = {"updated": updated, "seasons": sorted(seasons, key=lambda s: s["season"], reverse=True)}

    out = Path(args.out) if args.out else CACHE / "out"
    files = [
        (out / season / "shots.json", f"{PREFIX}/{season}/shots.json", shots_obj),
        (out / season / "minutes.json", f"{PREFIX}/{season}/minutes.json", minutes_obj),
        (out / "xfg_grid.json", f"{PREFIX}/xfg_grid.json", grid_json(grid)),
        (out / "manifest.json", f"{PREFIX}/manifest.json", manifest),   # last: it announces the rest
    ]
    print(f"\n{season}: {n_shots:,} shots in {n_games} games through {entry['last_date']}")
    for local, _, obj in files:
        write(local, obj)
    if args.out:
        return
    for local, key, _ in files:
        upload(local, key, "public, max-age=300" if key.endswith("manifest.json") else "public, max-age=86400")


if __name__ == "__main__":
    main()
