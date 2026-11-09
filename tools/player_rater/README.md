# Player Rater data

The per-season files behind `/player-rater/`: every player's daily hitting and pitching lines for a
regular season, from the MLB Stats API, in R2 at `player-rater/<season>.json` with
`player-rater/index.json` listing the seasons. The page values them in the browser (`player-rater/engine.js`).

```
python -I fetch.py 2026            # cache/2026/: season dates, teams, fielding, one file per day and group
python -I build_data.py 2026       # out/2026.json and out/index.json (the index lists every built season)
```

`fetch.py` keeps finished days; `--refresh-days N` refetches the last N. To publish, upload the season
files first and the index last (the page asks for each season at the index's `built` date, so a new
upload is never served from an old cache):

```
npx wrangler r2 object put blandalytics-live/player-rater/2026.json --file=out/2026.json --content-type=application/json --remote
npx wrangler r2 object put blandalytics-live/player-rater/index.json --file=out/index.json --content-type=application/json --remote
```

Rules (as the 2026 rater had them): hitting lines from primary-position pitchers and pitching lines
from position players are dropped, while two-way players keep both. A quality start is counted per
game. Hitters are eligible at a position with 10 games or 5 starts there that season, SP with 3 starts
and RP with 5 relief appearances.
