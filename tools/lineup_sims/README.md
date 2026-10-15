# Lineup Sim data

Builds `lineup-sims/data/<season>.json`, the one data file behind the Lineup Sim page
(`lineup-sims/`). The page and these scripts share one simulation engine,
`lineup-sims/sim.js`.

Everything runs by hand from the repo root. There is no workflow, because the FanGraphs
step is a **manual browser extract**: FanGraphs answers scripted requests with a
Cloudflare challenge, so that part runs in a fangraphs.com tab.

Python needs `requirements.txt`; the `.mjs` scripts need Node 22 or later.

## Refresh a season

```bash
# 1. FanGraphs, by hand: open any fangraphs.com page (signed in or not), paste
#    tools/lineup_sims/fangraphs_extract.js into the DevTools console, and move the
#    fangraphs_<season>.json it downloads to tools/lineup_sims/cache/fangraphs/<season>.json.
#    For another season, change fangraphsExtract()'s season, start and end defaults first
#    (regular-season dates: Stats API /api/v1/seasons/<season>?sportId=1).
# 2. Stats API play-by-play for every final regular-season game, cached per game
#    (about a minute; reruns fetch only games not cached yet)
python -I tools/lineup_sims/fetch_pbp.py 2026
# 3. outcome counts, lineup spots, baserunning tables, team actuals, contact-power axis
python -I tools/lineup_sims/build.py 2026
# 4. every team's lineups and the contact-power curve, simulated into the data file (~1 min)
node tools/lineup_sims/precompute.mjs 2026 100000
# 5. engine checks against the new file
node tools/lineup_sims/test_sim.mjs 2026
```

Then bump `data/2026.json?v=` in `lineup-sims/app.js` and `app.js?v=` in
`lineup-sims/index.html`; browsers and the edge hold both for hours.

`cache/` (git-ignored) holds the FanGraphs extract, the reduced per-game play-by-play and
the Stats API player and team lists.

## What each step checks

`build.py` stops or reports when the data doesn't add up:

* every half-inning's runner movements must reconcile with the feed's outs, runners and
  score (skipped half-innings are counted; 2026 had none);
* team totals rebuilt from the play-by-play against FanGraphs' team batting (2026: R, H,
  HR, BB, IBB, SO, HBP, SF identical; PA and AB within 1);
* FanGraphs' most-used batting order against the box scores' starting lineups (2026:
  30/30 agree).

`precompute.mjs` prints the calibration: MLB's pooled lineup spots simulated against the
league's actual innings 1-9 per 27 outs (2026: 4.43 R/9 against 4.47; AVG/OBP/SLG within
.001).

## The model, briefly

* **Hitters**: eleven plate-appearance outcomes (K, BB, HBP, 1B, 2B, 3B, HR, and balls in
  play that weren't hits, split GB/LD/FB/PU). Intentional walks, sacrifice bunts and
  catcher's interference are left out.
* **Baserunning**, league average, from every runner's movement in 2026: a running-game
  table before each plate appearance (steals, caught stealing, pickoffs, wild pitches,
  passed balls, balks) and an advancement table for each outcome, both by base-out
  state. Outcomes are coded one digit per runner, lead runner first, then the batter:
  `0` out, `1`-`3` base, `4` scored, trailing `s` for a sacrifice fly.
* **Contact vs power**: the first principal component of the hitters' outcome rates
  after removing what wOBA explains (200+ PA). Moving a profile along it keeps its wOBA
  exactly. The page applies it to the MLB-average lineup spots.
* **Lineup optimizer** (`lineup-sims/markov.js`, run in the page's worker): exact
  expected runs from a Markov chain over (batter due up, outs, bases) built from the same
  two tables, so it equals the simulation's average without the noise (2026: MLB's
  lineup spots 4.432 exact, 4.434 over 100,000 simulated games). It searches batting
  orders (pair swaps) and contact-power settings (moves between spots that keep the total,
  or each spot free) and runs twice, from the lineup as given and from its settings made
  even. `test_sim.mjs` checks it against brute force on smaller problems.

## Files

| | |
|---|---|
| `fangraphs_extract.js` | browser-console extract: wOBA weights, most-used batting orders, team batting |
| `fetch_pbp.py` | Stats API play-by-play, reduced and cached per game |
| `pbp.py` | replays plays into base-out states and coded runner outcomes |
| `build.py` | builds the data file and runs the cross-checks |
| `precompute.mjs` | team simulations, the contact-power curve, the calibration report |
| `test_sim.mjs` | engine and optimizer checks |
