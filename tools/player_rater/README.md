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

The chart's 95% intervals at the default league settings are precomputed per season with the page's own
engine (`bootstrap_ci.js`, about 10 s a season on 11 threads) and published to `player-rater/ci/<method>/<season>.json`.
Rebuild and re-upload them after rebuilding a season or changing the engine's numbers (then also bump
`CI.method` in `player-rater/app.js` and `METHOD` in the script); the page ignores a file whose `method` or
`built` does not match and computes the intervals in the browser instead. `check_bootstrap.js` checks the fast
bootstrap against the reference one, replicate by replicate.

```
node bootstrap_ci.js --data out          # every season in out/ into out/ci/<method>/, or name them: ... 2026
npx wrangler r2 object put blandalytics-live/player-rater/ci/retro-mode-r-2/2026.json --file=out/ci/retro-mode-r-2/2026.json --content-type=application/json --remote
node check_bootstrap.js out/2026.json 100
```

Rules (as the 2026 rater had them): hitting lines from primary-position pitchers and pitching lines
from position players are dropped, while two-way players keep both. A quality start is counted per
game. Hitters are eligible at a position with 10 games or 5 starts there that season, SP with 3 starts
and RP with 5 relief appearances.
