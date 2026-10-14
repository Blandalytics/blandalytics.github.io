# Draft mode: the engine and the page (R8)

Status (2026-10-13): parts 1 and 2 are built and tested. Part 1 is the engine. Part 2 is the page, the payout's objective, the CE of risk.js joined to the engine, and the rule for the user's nominations (section 12). Part 3 checks the draft mode against drafters by the median values (section 11).

The draft mode finishes a draft in progress many times from the user's seat. It prices each option by the team's simulated finish. The engine is a port of the NHL draft tool (`C:\Users\krbla\claude_sessions\nhl_draft`, `pick_engine.py`, `draft_tool.py`, `web_api.py`) to the MLB league of the Auction Calculator. It adds an auction draft and real outcome draws.

Plan of record: `risk_valuation_plan.md` (projections repository), section 3 (R8), section 5 (the user's decisions) and section 7.3 (stream D).

## 1. Files

| File | What it holds |
|---|---|
| `index.html`, `app.js`, `worker.js` | The page: the draft's settings, the stops and their tables; the engine in a web worker (Pyodide 0.28.3, the `nhl-draft` pattern) |
| `setup.js` | The page's inputs without the DOM: the calculator's settings from its saved form, the table with risk.js's fields, the session's cfg |
| `table.js` | `draftTable(result, H, P, settings)`: the engine's player table from a calc.js result (section 9), with risk.js's fields |
| `export_players.mjs` | The same table (and cfg) under Node, built by `setup.js` as the page builds it (for the tests, the checks and the dry runs) |
| `py/league.py` | League settings, the Yahoo slot eligibility, the categories, roto scoring and the head-to-head model |
| `py/pool.py` | The player pool: the table joined to the risk files (R1), with the playing-time fill on each draw |
| `py/engine.py` | Legality, the per-simulation world, the snake and auction play-outs, the scoring, the candidates |
| `py/draft.py` | The live draft state (snake and auction), the snapshot for the engine, the candidate lists |
| `py/web_api.py` | `Session`: the engine driven by JSON, for a Pyodide web worker (as `nhl-draft/py/web_api.py`) |
| `py/ce.py` | CE (the specification, 6.4) and its $ (risk.js `dollarsOf`) with the engine's M, S, H |
| `dry_run.py` | An automatic mock draft from one seat, snake or auction |
| `tests.py` | Plain-assert tests and the run time of each decision type |
| `page_check.py` | The page's contract: the page's own JSON through `Session`, mock and live, snake and auction (also a test in `tests.py`) |
| `ce_vs_engine.py` | The engine's order of the options against CE's; the maximum bids on each objective; one room on each objective |

The Python is numpy only (no pandas, no scipy), as in `nhl-draft/py/`. The same files run in CPython and in Pyodide.

## 2. Inputs

1. **The player table** (`table.js`). One row for each player of the calculator's run: side, name, MLBAM id, team, Yahoo positions (`Y! Pos`), $ value, SGP above replacement, the calculator's drafted flag, the slot that calc.js values him at, and the projected counts. The table also holds the league settings and calc.js `fillTargets` (the playing-time target of each role).
2. **The risk files** (R1, `src/valuation/risk_draws.py` of the projections repository). 50 stratified real draws of each player's season counts, for each side. `pool.decode` is a numpy port of `risk_draws.decode`. The engine joins the draws to the table on the side and the MLBAM id. A player without draws gets his projection as his only outcome.
3. **The pool.** The engine keeps 2 × the calculator's drafted count on each side, best $ first (435 players with the default league). It adds players if a slot type has fewer than 2 × its league slots. Pool index 0 is the most valuable player.

**Components.** The categories are built from components: counts summed over a team's lineup. A count category is one component. A rate category is a numerator over a denominator: AVG = H / AB, ERA = 9 ER / IP, WHIP = (BB + H) / IP. The default 5x5 needs 12 components. `league.CATEGORIES` also supports OBP, SLG, H, BB, TB, QS, HD, SV+H, L and K/9.

**The playing-time fill.** calc.js fills the playing time that a player does not play, up to his role's target, with the role's replacement production. The pool applies the same fill to each draw: component + max(0, target − PA or IP of the draw) × the role's replacement rate. The target comes from calc.js `fillTargets`. The replacement rate is the PA- or IP-weighted mean of the projections of the players ranked a tier (teams) either side of the role's drafted cutoff, by $ value. (calc.js ranks by its bare SGP; the engine ranks by $.) Thus an injured starter's missing time counts at replacement level, and playing time is not counted two times (the specification, section 10, error 1).

## 3. The draft state

| Item | Snake | Auction |
|---|---|---|
| Teams, seats | `League.teams`; the user's seat | the same |
| Rosters | every player that each team took, in order | the same, with the price of each |
| Legality | eligibility types, Hall's condition (below) | the same, plus the budget |
| Whose turn | the snake order and its pointer | the nomination order (teams in turn; a full roster is skipped) and the lot on the block |
| Money | – | each team's budget and open spots; the maximum bid = budget − min bid × (open spots − 1) |

**Slots and legality.** The slots follow calc.js `SLOT_TYPES` (Yahoo): C, 1B, 2B, 3B, SS, CI, MI, OF, UT; SP, RP, P. A player's eligibility type is the tuple of the league's slot types that he can fill. The default league has 23 types. A set of seated players fits the lineup if Hall's condition holds: for each set S of slot types, the players eligible only within S are at most S's capacity. Hitter and pitcher slots never mix, so each side has its own subsets (127 and 7) and its own cache. A team's seated players are one integer key (a mixed-radix count of each type). A player is legal if he can take a starting slot, or if a bench spot is open and enough spots remain to fill every starting slot after him (`nhl_draft`). Legality only turns false as a roster grows, so a board pointer can skip an illegal player for good.

**The lineup.** At the end of a play-out, each team's lineup is its best legal lineup by $ value: a greedy fill in $ order, which is optimal on this matroid. The bench does not count. The lineup is set by the projections, not by the outcome (no hindsight).

## 4. The rivals

**Valuations.** In each world, team t values player i at v(t, i) = $ value + |$ value| × (m(i) × e(t, i) − 1). m is the market's noise, shared by all teams (log-SD `sigma_market` = 0.15). e is each team's own noise (log-SD `sigma_team` = 0.10). Both have a mean of 1. A rival's board is its valuations in descending order.

**Snake.** A rival takes the best player on its board that it can legally add (`nhl_draft`). The MLB table has no ADP, so the nhl_draft blend of a VOR rank and an ADP rank is not used. Part 2 can add it if an ADP source exists.

**Auction (new).**

1. The teams nominate in turn. A full roster is skipped. The nominator puts the best legal player on its board on the block.
2. Each team with room bids up to: b = min bid + (v(t, i) − min bid) × its inflation. A player who would sit on its bench gets b = min bid + (b − min bid) × `bench_share` (0.25). The bid is in whole dollars and at most the team's maximum bid. A team bids nothing if b is less than the min bid.
3. The highest bid wins at the second-highest bid + $1 (at least the min bid). A tie goes to the nominator, then by a random priority of the world. If nobody bids the min bid, the nominator buys the player at the min bid.
4. A team's inflation = its money above the min bids ÷ (its open spots × the $ above the min bid still available per open spot of the league), within [0.2, 3]. The available $ is the calculator's drafted players that are not gone, above the min bid. At the start the inflation is 1.0 for every team, because the calculator's values add up to the budgets. A team that spends ahead of its share bids less later; a team that spends behind its share bids more.

The parameters have no validation. With the defaults the market prices the first 25 lots at 1.15 × value, lots 26–50 at 1.03, lots 51–100 at 0.92 and lots 101–150 at 0.79 (6 live drafts, lots of $5 or more). The early overpay is the winner's curse of 11 noisy bidders. The rooms spend $3,119 of the league's $3,120 (mean of the 6 drafts).

**The live world.** The live rivals draw their valuations one time at the start of the draft and keep them, so the room has a settled character (`nhl_draft`). Each simulation draws a new world.

## 5. The simulation

**A world** holds:

1. the outcomes: 8 seasons; in each, one of the 50 draws of each player, independent across players (P8 = 0);
2. the rivals' valuations and boards;
3. the random priority of the teams (auction ties);
4. the uniforms of the head-to-head seasons.

**Candidates.** All candidates of a decision are played out in the same worlds (common random numbers, as `pick_engine.py`). Thus the gap between two candidates is a real difference.

| Mode | Candidate | Play-out |
|---|---|---|
| snake | ("pick", i) | the user's team takes i now; then every team picks from its board to the end |
| snake | ("skip",) | the baseline: no pick now; at the end the seat gets the best undrafted player who fits (a waiver-level fill) |
| auction | ("bid", B) | the lot resolves with the user's maximum bid B against the world's rival bids; B = 0 is the pass (the baseline) |
| auction | ("buy", p) | the user's team buys the lot at the price p |
| auction | nominate i | the lot opens with i, and the user bids its value bid on him |

At a rival's snake stop, the stop is priced as if the user were on the clock now (`nhl_draft` `make_snap`).

**The user's future.** In a play-out, the user's later picks and bids follow the user's own policy, not a rival's: the static $ board, and bids at the static $ value with the user's inflation (`Draft.user_value_bid`). A first version used a rival's noisy policy for the user. Against that baseline, overpaying for a star now looked good, and the dry-run team finished last.

**Scores.** Each play-out is scored on the world's 8 outcomes. The measures are means over the outcomes:

* roto points of the user's team, its finish (1 = first, ties averaged), win (finish 1), the roster's summed $ value;
* head-to-head: playoff share, title share, regular-season category wins (section 6);
* auction: whether the user got the lot, and the price paid;
* the user's roto points in each category.

**The decision.**

* Snake: the options are ranked by the objective (section 12.2; ties go to roto points). The skip baseline is shown and is never recommended.
* Auction: the maximum bid is the break-even price. The engine prices forced buys at 0.6, 0.8, 1.0, 1.2 and 1.4 × the expected price, paired with the pass in each world. It fits the mean gain over the pass as a line in the price, weighted by the standard error. The root of the line is the break-even. The argmax of noisy bid candidates is not used: it favors the noisiest (the highest) bids. The break-even is given for the objective and for roto points. Since part 4 the recommended maximum bid is the break-even capped at the value bid (section 13).
* The baseline's play-outs also give O1–O3 of the user's team (section 12.3).

## 6. Head-to-head (the assumption)

A full weekly model can wait for part 2. Part 1 approximates the weeks from the season outcome:

1. A team's weekly total in a category scatters around 1/weeks of its season total (`weeks` = 23, playoffs included).
2. A count: variance = φ × m + (0.10 × m)², with m the weekly mean and φ the calculator's count noise (1). The second term is the week-to-week spread of games played.
3. A rate: the numerator's count noise over the weekly denominator; a proportion (AVG, OBP) is binomial.
4. P(team a beats team b in a category in one week) = Φ((mean a − mean b) / √(var a + var b)). Categories and weeks are independent. Ties are not modeled.
5. The regular season is a round robin (circle method) over weeks − playoff rounds (20 weeks for 6 playoff teams). Each week gives each team its number of category wins. The top 6 by category wins make the playoffs. Standings ties are broken at random.
6. The playoffs are a bracket with byes for the top seeds. Each round the best remaining seed plays the worst. A week is won on more categories; a tie goes to the better seed.
7. Each world plays 16 seasons, one on each outcome in turn. The playoff share and the title share are means over them.

The model ignores the correlation of categories inside a week, the timing of injuries in the season, and in-season moves.

## 7. What is reused from nhl_draft, and what is new

| Part | From nhl_draft | New or changed |
|---|---|---|
| Play-out from one seat, common random numbers | `pick_engine.py` (`finish`, `chunk`, `evaluate`) | the auction play-out |
| Board pointers, legality by eligibility type, Hall's condition | `pick_engine.py` | integer keys, a cache for each side, the monotone pointer skip |
| Draft state, snapshot/undo, candidate list (best per position + board), skip baseline | `draft_tool.py` | budgets, prices, nominations, the lot; the bid grid |
| JSON session for the worker | `web_api.py` | `kind` of stop (pick, nominate, bid, enter), `bid`, `nominate`, `record` |
| Roto scoring (rank points, ties averaged) | `league.py`, `pick_engine.league_points` | MLB components and rate categories; batched over outcomes |
| Rivals | board of w × VOR rank + (1 − w) × ADP rank | $ value × market noise × team noise (no MLB ADP) |
| Season outcome | the projection (truth) | 8 of the R1 draws per world, with the playing-time fill |
| Lineup | starters fixed at the pick | the best legal lineup by $ at the end |
| Head-to-head | – | the weekly approximation, the schedule and the bracket |
| Decision | ranked by roto points | ranked by the objective; the break-even maximum bid |

## 8. Run time

CPython 3.14 on the user's PC, inline (no worker pool), default league, 200 simulations per option, cold caches (`tests.py`, `timings_per_decision`, 2026-10-13). At the first stop:

| Decision | Options | Time | Per play-out |
|---|---|---|---|
| snake pick (roto) | 15 | 3.5 s | 1.2 ms |
| snake pick (h2h) | 15 | 5.3 s | 1.8 ms |
| auction bid (roto) | 6 | 4.7 s | 3.9 ms |
| auction bid (h2h) | 6 | 5.6 s | 4.7 ms |

Later stops are faster (shorter play-outs). The nhl_draft tool takes about 1.6 ms per play-out inline. In Pyodide 0.28.3 (the page, Chromium) the first snake pick of the default league takes 3.2 s for 15 options × 100 simulations (2.2 ms per play-out), about the speed of CPython; the page is ready about 2.5 s after it opens when the Pyodide files are in the cache. The session runs in chunks (`chunk`), so the page shows early results.

## 9. The interface needed from calc.js

The engine needs no change to calc.js or risk.js. The page (`setup.js` `buildTable`) runs `C.auctionValues(H, P, { ...s, debug: true })`, then risk.js's `applyRisk` on it, then `draftTable(result, H, P, s)` (`table.js`), and posts the JSON to the worker with the two risk files (ArrayBuffers). From risk.js the table takes each player's risk-aware $, CE, its $, EffValue and Var_eff, and the pricing of `debug.pricing` (section 12.3). It uses only public fields of the calculator's result: `players` (type, name, mlbamid, team, pos, value, sgpar, drafted, valuedAt, twoWay), `perSGP` and `fillTargets`. It reads the projected counts from the prepared tables H and P by MLBAM id. Two-way players follow the calculator's mode; the default (split) gives two rows.

## 10. Assumptions and limits

1. The rivals' parameters (`sigma_market` 0.15, `sigma_team` 0.10, `bench_share` 0.25, the inflation clip [0.2, 3]) have no validation.
2. The draws are independent across players (P8 = 0, R5 adds shared shocks).
3. The bench does not count; the playing-time fill stands in for in-season replacements. No drops or streaming (the option value is R6).
4. The lineup is set by the projections at the end of the draft.
5. Redraft only (the user's decision). Keepers are board step w41.
6. The head-to-head model is the approximation of section 6.
7. The user's nominations follow the rule of section 12.4. The rule has no validation.
8. The decisions are noisy. The break-even of a $62.1 player (the first lot, 4 seeds of the worlds): SD $4.1 on win and $2.9 on roto points at 200 simulations; SD $10.9 and $9.6 at 40 (`tests.py`, `break_even_repeatability`).

## 11. Part 3

Part 2 is section 12. Part 3 checks the draft mode before any adoption (the plan's R10 rule: no adoption without a gate):

1. Many rooms: at least 50 seeds of the worlds × several seats, in both modes (snake, auction) and both payouts (roto winner-take-all, head-to-head playoffs). In each room the draft mode drafts one seat and the other seats draft by the median values (the calculator's $ board, value bids). The same rooms (common random numbers) are drafted again with a plain value drafter in the seat, and with a CE drafter (the board and the bids by CE now, section 12.3).
2. Score each finished draft on many seasons of the outcome draws (`Session.final`): win%, playoff%, title%, mean roto points, and in an auction the money left. Report the paired differences with their standard errors.
3. Compare the objectives: the payout's (the default) against mean roto points, in particular the auction's break-even bids (section 12.2), and the nomination rule (section 12.4) against "nominate the best on your board" and against the engine's own choice.
4. Rivals that are not the engine's own model: the engine plans against rivals with its own valuation noise and bidding rule (section 4), so a check only against those rivals favors it. Use rivals with other noise and bench shares, and, if a source exists, ADP for the snake rivals.
5. The noise of the decisions: the simulations per option that the page can afford (100 by default) against 200 and 400 (section 10, item 8).
6. The user's own policy in the play-outs: the calculator's $ board (now) against the risk-aware $ board.

## 12. Part 2: the page, the objective, the CE and the nominations

### 12.1 The page

The calculator's header links to the page ("Draft mode (beta)").

1. The page reads the calculator's saved settings (localStorage `auction-calculator:v1`, written by `../app.js`): the teams, slots, bench, budget, min bid, categories, format, and the Risk (beta) payout and playoff teams. Without saved settings it uses the calculator's default league. It refuses a points league. It plays all-play as head-to-head. Uploaded projections do not carry over: the page loads the default projections and their risk files as the calculator does (`?data=`, `?riskdata=`). Without the risk files the engine plays every season at the projections, and the risk columns are empty.
2. The user sets snake or auction, the seat, mock or live, the payout and the playoff teams, the ranking measure (the payout's, or mean roto points), the simulations per option (100), the seed, the do-not-draft names, and in a mock auction the $ under which lots go by value without a stop (3).
3. Start: calc.js prices the league (with `debug`), risk.js applies the risk-aware $ with the draft's payout, and `table.js` builds the table (`setup.js` `buildTable`). The worker gets the table, the cfg (`sessionConfig`) and the two risk files, and runs the engine in Pyodide 0.28.3 from jsDelivr (its files kept in Cache Storage, as `nhl-draft`).
4. The stops:

| Stop | Mock | Live |
|---|---|---|
| snake, the user's pick | priced; "take" | priced; "take" |
| snake, a rival's pick | none (the rivals pick) | the user enters the pick; "Re-simulate" prices the stop |
| auction, the user's nomination | priced (section 12.4); "nominate" | priced; "nominate", or the user enters a rival's nomination |
| auction, a lot on the block | priced; the user's maximum bid (by default the break-even, capped at the value bid) against the mock room | priced; the user enters the winner and the price |
| auction, a rival's nomination | none | the user enters the player and the nominator |

A priced stop shows the options table (the calculator's $, the risk-aware $, CE now in $ and its rank, the objective, mean roto points, p10, p90, finish, the gap to the best, the share of worlds where the option is best); in an auction the lot (the break-even on the objective and on roto points, the CE maximum bid, the calculator's $, the risk-aware $, the room's expected price) and the forced buys; the expected category points (the baseline, then what each option adds, as `nhl_draft`'s second table); and the league's course by category. The header shows the user's roster, the budget and the maximum bid, the room's inflation, and the engine's M, S, H and z. At the end the page shows every team's odds over 200 seasons. Undo goes back one stop.

### 12.2 The objective

Part 2 made the payout's measure the default objective (the user's decision of 2026-10-13). After part 3 the user changed the default (2026-10-13, section 13): mean roto points in roto, the payout's measure in head-to-head. The payout's measure stays an option in roto. The payout's measures:

| Payout | Roto | Head-to-head |
|---|---|---|
| winner take all | win%: first in the roto standings | title%: the winner of the playoffs |
| playoffs | top-P%: in the top P by roto points (risk.js's "playoffs") | playoff% |

The auction's break-even uses the objective; the page also shows the break-even on roto points and the value bid. The recommended maximum bid is the lower of the break-even and the value bid (section 13).

What the default does to the bids (`ce_vs_engine.py`, one mock auction room, seat 5, roto, 200 simulations, the first 20 lots of $5 or more): the break-even on win% is 0.90 × the calculator's $ (the median of the lots), on roto points 0.84 ×. Win% gives the higher maximum bid at 12 of the 20 lots and the lower at 7. Part 1's lot (Rice: $26 on win%, $9 on roto points) is an extreme case. In this room the rivals paid 1.1–1.3 × the value for the first lots (the winner's curse of section 4), so at either objective's bids the user bought only 2 of the 20 lots.

The same room drafted on each objective (seat 5, every lot of $5 or more priced at 60 simulations, the rule's nominations, final odds over 400 seasons): on win% the user's team has 64.9 mean roto points (6th of 12), win% 8.3%, a roster worth $228 for its $260; on roto points 69.1 points (1st), win% 10.0%, a roster worth $258. One room is not evidence: part 3 runs many rooms. A possible cause to check there: at 60 simulations the win% break-even is noisier than the roto-point one (section 10, item 8), and a noisy maximum bid wins mostly the lots that it overestimates.

### 12.3 The CE join (O1–O3 during the draft)

The baseline's play-outs (the skip in a snake, the pass in an auction, the rule's choice at a nomination) give the user's team now (the plan's R8 step 2):

* M and S: the mean and the SD of the team's total; H: the mean total of the team at the payout's place (first, or the P-th); z = (M − H) / S;
* in roto the totals are roto points; in head-to-head they are regular-season category wins, scaled to all `weeks` (the units of calc.js's head-to-head SGP). The roto-point version is also in the result (`target_roto`).

`py/ce.py` recomputes CE (the specification, 6.4; the exact gain when √Var_eff > 0.4·S) from risk.js's EffValue and Var_eff of each player with these M, S, H, and prices it with risk.js's `dollarsOf`. With risk.js's own M, S, H it gives risk.js's CE and $ exactly (`tests.py`, `ce_port_matches_risk_js`). In an auction the CE maximum bid (the specification, 6.5) is CE now in $ at the user's inflation (the bench share if the player would not start), at most the maximum bid.

Where the engine and CE disagree (`ce_vs_engine.py`, seat 5, the user's first 8 picks, 200 simulations):

* Roto, winner take all: the top option agrees at 0 of 8 picks. CE ranks a starting pitcher first at every pick (Skubal, Sale, Gilbert, Ohtani's pitching, Wheeler, Cole); the engine ranks other players first. Each gap is small (0.1 to 1.5 points of win%, 0.2 to 1.9 paired standard errors), but the pattern does not change.
* Head-to-head, playoffs: the top option agrees at 3 of 8 picks. At picks 77 and 92 CE's first option (Glasnow, Messick) is the engine's 12th and 9th, 2.8 and 2.1 points of playoff% behind (3 to 4 standard errors).
* The rank correlation of the two orders is about 0.9 at the first picks and 0.0 to 0.5 at most later picks.

The reasons: CE values a player in an average team's slot, with his own variance only. The engine sees the roster's fit (a late SP can sit on the bench, or take a P slot from a better pitcher), the categories the team already has, and what the rivals take next. The engine is the specification's full method (section 8); CE is its approximation.

### 12.4 The nomination rule

For each undrafted player that the user can roster: E is the room's expected price (the calculator's $ above the min bid at the room's inflation, in whole $). U is the user's own price (the risk-aware $, else the calculator's $, at the user's inflation; the bench share if the player would not start; whole $; at most the maximum bid).

1. A drain is a player with U ≤ E − $2. A rival likely buys him at about his market price, and the money leaves the rivals' budgets for a player that the user does not want at that price. (A gap of $1 can come from the whole-dollar rounding only.)
2. Nominate the dearest drain (the largest E; ties go to the larger E − U).
3. If there is no drain, nominate the dearest player who would start for the user (a target: the user is a likely buyer).
4. The engine prices the 5 dearest drains and the 2 best targets. Each lot opens with the player, and the user bids U. The engine's best option replaces the rule's choice only if it is better on the objective by more than 2 paired standard errors. (The gaps between nominations are small, and the argmax of noisy options is noise.)

With the calculator's $ alone, E = U for every starter at the start, so the rule nominates the dearest player. With the risk-aware $, the drains are the players that risk.js values under the calculator's $ (in the 2027 test files, mostly closers).

### 12.5 Checks

* `tests.py`: 25 tests (part 4 adds the bid cap). Part 2 adds: CE against risk.js, the objective of each payout, the head-to-head target and CE now, the nomination rule, the entries of a live auction and a live snake, the page's contract. `python tests.py --quick` takes about 35 s.
* `page_check.py`: 5 scenarios (a mock snake in an ESPN-like OBP roto league, a mock auction in a Yahoo head-to-head league with the playoffs payout, a mock auction on roto points, a live snake, a live auction). The page's JSON comes from `setup.js` under Node; each stop, result, action and final answer has every key that the page reads; the mock drafts play to the end. About 9 s.
* The page in a browser (the desktop app's Browser pane, a local static server on port 8790 with the 2027 test files): the settings carry over from the calculator (a 10-team head-to-head league with the playoffs payout); a mock snake to the end; a mock auction (bids, a nomination, undo); a live auction (the user's nomination and its sale, a rival's nomination, the user's purchase). No console errors; no requests other than to the local server and Pyodide; no horizontal page scroll at 375 px.

## 13. Parts 3 and 4: many rooms, and the defaults

Part 3 (`part3_check.py`; the method, the assumptions and every table are in `part3/report.md`) drafted 952 rooms: 12 teams, the calculator's default Yahoo 5x5 league, the 2027 test files, each room scored on 500 seasons of the outcome draws. Each drafter played the same room in the same seat. The table gives each drafter minus the median-value drafter V in the same room, in points of the objective (the standard error in brackets):

| Drafter | Snake, roto win% (48 rooms) | Snake, head-to-head playoff% (48) | Auction, roto win% (14) | Auction, head-to-head playoff% (14) |
|---|---|---|---|---|
| V, the calculator's $ board (its mean) | 13.4 | 58.3 | 14.5 | 60.9 |
| The engine on the payout's measure | +5.4 (0.6) | +16.8 (1.5) | −5.8 (1.9) | +9.2 (2.5) |
| The engine on mean roto points | +8.0 (0.8) | +4.4 (1.4) | +1.2 (2.0) | −5.6 (1.9) |
| R, the risk-aware $ board | +1.2 (0.7) | +5.6 (1.2) | +2.8 (1.9) | +6.0 (1.3) |
| C, CE now | +1.4 (0.7) | −8.2 (1.3) | −0.3 (1.8) | −8.0 (1.7) |

1. Head-to-head: playoff% beats mean roto points (snake +12.4 (0.8), auction +14.8 (1.6)).
2. Roto, winner take all: mean roto points beat win%, also on win% (snake +2.6 (0.7), auction +7.1 (1.1)).
3. The auction's break-even on win% overpays. Its average is not higher (0.59 × the calculator's $, against 0.62 × on roto points), but it is noisier, and the engine wins mostly the lots that it overestimates: for players of $10 or more in the first third of the lots it paid 1.07 × the $ (V: 0.83 ×), and its roster was worth $239 (V: $310). 200 simulations helped (+8.2 (3.6), 4 rooms). The cap at the value bid gave +5.8 (1.3) over V in roto (8 rooms), and was neutral in head-to-head (−0.9 (2.7) against the uncapped engine, 4 rooms).
4. The nomination rule: no evidence against it (4 rooms; the best player −2.3 (1.6), a random one −1.1 (1.7)).
5. More simulations in a snake gain less than the change to roto points (roto: 200 +1.7 (1.0), 400 +0.6 (0.7)).
6. Rivals that are not the engine's model (snake, 16 rooms): the engine still gains on V (market log-SD 0.30: roto +8.1 (2.2), head-to-head +8.4 (1.1); the calculator's $ alone: +6.2 (0.8), +20.1 (2.2)).
7. C loses in head-to-head because it prices CE at the calculator's prices and takes fewer closers (1.9 RP against R's 2.3).

Part 4 (the user's decisions of 2026-10-13):

* The default objective in roto is mean roto points; head-to-head keeps the payout's measure (`web_api.objective_of`). The page's selector starts on the default and keeps the payout's measure as an option.
* The recommended maximum bid in an auction is the break-even, capped at the value bid (`Draft.user_value_bid`: the calculator's $ at the user's inflation, the bench share for a bench player). The cfg key `bid_cap` ("value" by default, "none" for the break-even alone) sets it. The result's `bid` gives the amount, the break-even, the value bid and whether the cap applied.
* `part3_check.py run --plan part4_auction part4_rivals` checks the new defaults in all 14 main auction rooms and against the other rival models (6 rooms each); `part3/report.md` section 4.6 has the results. `part3_check.py replay` runs stored jobs again: the change leaves part 3's rows as they were.
