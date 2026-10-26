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
# 3. outcome counts (hitters and pitchers, whole and by platoon cell), lineup spots,
#    baserunning tables, team actuals, contact-power axis
python -I tools/lineup_sims/build.py 2026
# 3b. the per-pitch model (the page's "Per-Pitch (modeled)" option), from every tracked pitch:
#     the projections project's pitch file for the season, joined to the cached play-by-play
python -I tools/lineup_sims/pitch_model.py 2026 --pitches <projections>/data/interim/pitch_scores/mlb_2026.parquet
# 3c. the hook model (the page's "Modeled hook" option), from every MLB pitch 2022 on. It reads, and
#     never writes, these files under the projections project's data directory:
#       raw/statfast/pitches/mlb_<year>.parquet   (2022 through the season)
#       raw/statfast/games/mlb_<year>.parquet     (2022 through the season)
#       interim/transactions.parquet
#     and writes only lineup-sims/data/<season>-hook.json
python -I tools/lineup_sims/hook_model.py 2026 --projections <projections>/data
# 3d. the hypothetical pitcher's quality axes (Scrub - Average - Ace), from the data files of steps 3
#     and 3b; run it again whenever either changes
python -I tools/lineup_sims/quality_axis.py 2026
# 3e. the Game Sim's stolen bases (game-sim/index.html), by runner, pitcher and catcher. It reads the
#     stolen_bases project's running-game pull for the season (mlb_running_game.scrape_running_game(<season>,
#     game_types=("R",)) written to parquet; its stored 2026 data stops at 2026-08-20, so pull the season
#     again first), the cached play-by-play and lineup-sims/data/<season>.json, and writes only
#     lineup-sims/data/<season>-steal.json. Nothing under projections/.
python -I tools/lineup_sims/steal_model.py 2026 <running-game parquet>
# 3f. the Game Sim's ballparks, from the park-factors project's files in this repo. It reads, never writes,
#       tools/park_factors/park_factors_history.csv   (each season's factors by venue, all batters)
#       park-factors/seasonal/MLB_<season>.json        (each venue week by week, and the league's calendar)
#     and writes only lineup-sims/data/<season>-parks.json. Park Factors rebuilds those files on its own
#     schedule (the seasonal JSON changes during a season): after a park-factors merge touches either one,
#     run this again, and if the data file changed, bump data/<season>-parks.json?v= in lineup-sims/game.js
#     and game.js?v= in game-sim/index.html.
python -I tools/lineup_sims/park_factors.py 2026
# 3g. the Game Sim's default lineups: each team's starting nine in its latest game against a right-handed
#     and against a left-handed starter, from the cached play-by-play and lineup-sims/data/<season>.json; it
#     writes only lineup-sims/data/<season>-lineups.json. Run it after step 2 brings in new games, and if the
#     file changed, bump data/<season>-lineups.json?v= in lineup-sims/game.js and game.js?v= in game-sim/index.html.
python -I tools/lineup_sims/recent_lineups.py 2026
# 4. every team's lineups and the contact-power curve, simulated into the data file (~1 min)
node tools/lineup_sims/precompute.mjs 2026 100000
# 5. engine checks against the new file, and the Game Sim's
node tools/lineup_sims/test_sim.mjs 2026
node tools/lineup_sims/test_game.mjs 2026
```

`test_game.mjs` also reads `fixtures/game_822778.json`, one game's MLB Stats API schedule and box
score (trimmed to the fields `lineup-sims/game-load.js` reads), saved so the gamePk loader is
checked without going online.

Then bump `data/2026.json?v=` (and `data/2026-pitch.json?v=`, `data/2026-hook.json?v=` or `data/2026-quality.json?v=`, if step 3b, 3c or 3d ran) in
`lineup-sims/app.js` and `app.js?v=` in `lineup-sims/index.html`; browsers and the edge
hold them for hours. The Game Sim (`lineup-sims/game.js`) loads `data/2026.json`, `data/2026-hook.json`,
`data/2026-steal.json`, `data/2026-parks.json` and `data/2026-lineups.json` with their own `?v=`, so bump those there too (and `game.js?v=` in
`game-sim/index.html`, the Game Sim's page; its modules and data stay in `lineup-sims/`). `game.js`, `game-sim.js` and `game-worker.js` import `sim.js` at the page's `?v=`:
when `sim.js?v=` changes in `app.js`, change it in all three. `park.js` (the park adjustment and home field, used by `game.js`
and `test_game.mjs`) imports nothing; bump `park.js?v=` in `game.js` when it changes (and `game-sim.js?v=` in `game.js` and `game-worker.js`, since
`game-sim.js` imports `park.js`).

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
  exactly. The page applies it to the MLB-average lineup spots, as far as 2026 regulars
  (300+ PA) go toward the nearer end (`tradeoff.range`; 2026: ±2.5, from Caissie's +2.47 at
  the power end).
* **Lineup optimizer** (`lineup-sims/markov.js`, run in the page's worker): exact
  expected runs from a Markov chain over (batter due up, outs, bases) built from the same
  two tables, so it equals the simulation's average without the noise (2026: MLB's
  lineup spots 4.432 exact, 4.434 over 100,000 simulated games). It searches batting
  orders (pair swaps) and contact-power settings (moves between spots that keep the total,
  or each spot free) and runs twice, from the lineup as given and from its settings made
  even. `test_sim.mjs` checks it against brute force on smaller problems.
* **Opposing pitcher**: `build.py` also counts every pitcher's batters faced in the same
  eleven outcomes (`pitchers`: id, name, team, hand, counts, batters faced, starts, outs
  recorded in those starts, cells, outings of 3+ innings) and the league's and relievers'
  totals (`pitching.league`, `pitching.relief`), each team's relievers (`pitching.teams`),
  bulk relief (`pitching.bulk`: relief outings of 3+ innings) and how long openers and their
  followers went (`pitching.opener`, `pitching.follower`: an opener is a starter who
  recorded 6 outs or fewer and made under half his appearances as a starter; his follower is
  the next pitcher when he went 3+ innings; the page uses the medians). The page combines
  hitter and pitcher by log5, outcome by outcome (hitter × pitcher / league, scaled to sum to
  1: `log5()` in `sim.js`). He pitches nine innings; his average start, then his team's
  bullpen or MLB's; a bullpen day (opener, then his team's bullpen); or opener, follower
  (picked, or bulk relief), then his team's bullpen. `simulate()` takes the later stages as
  `relief: [{ from, lineup }]`; `markov.js` splits any inning with a change in it by outs.
  Against a pitcher, the page's team comparison, contact-power curve and optimizer are exact
  Markov-chain results against him (`expectedLine()`), worked out in the page's worker.
  `test_sim.mjs` checks log5's identities, exact against simulated with and without a
  bullpen and with an opener and follower, stage edge cases, the opener data, and the
  optimizer against brute force.
* **Platoon splits**: the same counts by cell, the pitcher's hand plus the side the batter
  hit from (`RL`: a lefty against a right-hander; switch hitters by the side they batted
  from), for players (`players[i][5]`, bat side in `[6]`), lineup spots (`cells`), the league
  and relievers (`pitching.cells`, `pitching.relief_cells`), and pitchers by batter side
  (`pitchers[i][8]`). `hitterOf()`, `pitcherOf()` and `bullpenOf()` in `sim.js` turn them
  into parts that `facing()` matches by log5 against the league's rates for the same
  matchup: each player's own splits, league-average platoon gaps on his overall rates, or
  off. `build.py` and `test_sim.mjs` check every split adds up to its whole; the tests also
  check the platoon identities and exact against simulated with splits on.
* **Hypothetical pitcher** (`quality_axis.py`, `data/<season>-quality.json`, the MLB-average RHP or LHP
  with the Pitcher quality slider, Scrub to Ace): steps are standard deviations of 2026 pitchers'
  talent in wOBA allowed. Per-PA: the covariance of pitchers' eleven rates (100+ batters faced,
  weighted by them) less sampling's (one PA's multinomial covariance at the league's rates over each
  pitcher's batters faced) is talent's, T; a step toward Ace moves his rates, and each platoon
  cell's, by -T wv / sqrt(wv' T wv), which sums to 0 and moves wOBA allowed one talent SD. Per-Pitch:
  the per-pitch model's pitchers' 13 log ratios regressed on the chain's wOBA allowed against an
  MLB-average hitter; a setting is exp(s * slope), s found for each tenth so the chain's wOBA allowed
  is that many talent SDs from average. The reach is as far as 2026 regulars (300+ batters faced,
  their wOBA allowed shrunk by its reliability) go toward the nearer end, and no MLB-average cell
  goes below 0. `test_sim.mjs` checks the axis's sums, the steps against the page's chain, and that
  both models' pitchers get better (more strikeouts, fewer runs) toward Ace, within .4 R/9 of each
  other.
* **Modeled hook** (`hook_model.py`, `data/<season>-hook.json`, He pitches → Modeled hook): when
  a starter comes out. A boundary is the end of one of his plate appearances (does he face his
  team's next batter?); a LightGBM model of 120 trees, 31 leaves, fit on every start from 2022
  (9-inning games), looks at what the simulation can track (pitches so far and by inning,
  batters faced, outs, hits, walks, homers, strikeouts, runs, recent baserunners, inning, outs,
  runners, times through the order, the score) and what's set before the game (his previous
  starts' most pitches, starts, his team's starters' outs and bullpen load, rest, recent
  outings, an injured-list activation). Fit on 2022-2025 and tested on 2026 it scored .0871 log
  loss per boundary against .109 for pitches, outs and inning alone. `simulate()` takes it as
  `hook`, with a relief stage whose `from` is "hook": after each of the starter's plate
  appearances it draws the PA's pitch count from 2026's pitches per PA for the outcome, fills
  in the features and draws against `hookChance()` (the trees, flattened). A start goes in as
  a typical one of his (medians over his 2026 starts), at normal rest. Exact numbers average
  over the simulated hook outs (`expectedLinesMix()`, `hookMix()`); the optimizer takes the
  hook at the lineup's average out. Across 2026's 153 starters with 15+ starts it averages
  15.6 outs and 85 pitches a start against an actual 16.0 and 87 (r = .84). `test_sim.mjs`
  checks the trees against the pipeline's predictions, never/always-hook limits, the mix
  against a fixed stage, and a starter's simulated starts against his real ones.
* **Per-pitch model** (`pitch_model.py`, `data/<season>-pitch.json`, the page's toggle): a
  plate appearance built pitch by pitch. In each of the 12 counts a pitch goes through
  seven steps (zone; swing; a take's ball, called strike or HBP; contact; fair; in play, a
  home run or not; the other seven batted balls), each the league's chances in that count
  (and zone), in that platoon cell, times the hitter's and the pitcher's ratios to the
  league, each shrunk by its own prior in pitches (tuned on 2026: fit before June 26, best
  at predicting every later PA). `pitchChances()` in `sim.js` walks the counts to the same
  eleven outcomes, so `facing()` hands the rest of the engine nothing new. Ratios are kept
  for hitters, pitchers, lineup spots and bullpens (`a`: overall; `g`: against the league
  in the cells played; `c`: own splits). `pitch_model.py` writes a few matchups it worked
  out (`checks`), and `test_sim.mjs` checks the page's chain against them, that MLB average
  reproduces the league's PA rates, and exact against simulated. Its input is the
  projections project's per-pitch file (count, location against the zone, outcome class),
  joined here by game and at-bat index; a PA's last pitch takes its class from the PA.

## Files

| | |
|---|---|
| `fangraphs_extract.js` | browser-console extract: wOBA weights, most-used batting orders, team batting |
| `fetch_pbp.py` | Stats API play-by-play, reduced and cached per game |
| `pbp.py` | replays plays into base-out states and coded runner outcomes |
| `build.py` | builds the data file and runs the cross-checks |
| `pitch_model.py` | builds the per-pitch model's data file |
| `hook_model.py` | builds the hook model's data file |
| `quality_axis.py` | builds the hypothetical pitcher's quality axes |
| `precompute.mjs` | team simulations, the contact-power curve, the calibration report |
| `test_sim.mjs` | engine, optimizer and pitcher-matchup checks |
