# Draft mode: the engine (R8, part 1)

Status (2026-10-13): part 1 is built and tested. Part 2 adds the CE, the payout setting of R7 and the page. Part 3 checks the draft mode against drafters by the median values.

The draft mode finishes a draft in progress many times from the user's seat. It prices each option by the team's simulated finish. The engine is a port of the NHL draft tool (`C:\Users\krbla\claude_sessions\nhl_draft`, `pick_engine.py`, `draft_tool.py`, `web_api.py`) to the MLB league of the Auction Calculator. It adds an auction draft and real outcome draws.

Plan of record: `risk_valuation_plan.md` (projections repository), section 3 (R8), section 5 (the user's decisions) and section 7.3 (stream D).

## 1. Files

| File | What it holds |
|---|---|
| `table.js` | `draftTable(result, H, P, settings)`: the engine's player table from a calc.js result (section 9) |
| `export_players.mjs` | The same table under Node, with the calculator's default settings (for the tests and dry runs) |
| `py/league.py` | League settings, the Yahoo slot eligibility, the categories, roto scoring and the head-to-head model |
| `py/pool.py` | The player pool: the table joined to the risk files (R1), with the playing-time fill on each draw |
| `py/engine.py` | Legality, the per-simulation world, the snake and auction play-outs, the scoring, the candidates |
| `py/draft.py` | The live draft state (snake and auction), the snapshot for the engine, the candidate lists |
| `py/web_api.py` | `Session`: the engine driven by JSON, for a Pyodide web worker (as `nhl-draft/py/web_api.py`) |
| `dry_run.py` | An automatic mock draft from one seat, snake or auction |
| `tests.py` | Plain-assert tests and the run time of each decision type |

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

The parameters have no validation. With the defaults the market prices the first 25 lots at 1.15 × value and lots 101–150 at 0.79 × value (6 drafts, lots of $5 or more). The early overpay is the winner's curse of 11 noisy bidders. All the money is spent (98% or more).

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

* Snake: the options are ranked by the objective (win for a roto league, playoff for a head-to-head league; ties go to roto points). The skip baseline is shown and is never recommended.
* Auction: the maximum bid is the break-even price. The engine prices forced buys at 0.6, 0.8, 1.0, 1.2 and 1.4 × the expected price, paired with the pass in each world. It fits the mean gain over the pass as a line in the price, weighted by the standard error. The root of the line is the maximum bid. The argmax of noisy bid candidates is not used: it favors the noisiest (the highest) bids. The break-even is given for the objective and for roto points.
* The baseline world also gives O1–O3 for part 2: M and S (the mean and SD of the user's roto points) and H (the mean total of the league's winner).

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

Later stops are faster (shorter play-outs). The nhl_draft tool takes about 1.6 ms per play-out inline. Pyodide is slower than CPython (about 1.5–2 × for this kind of code, not measured). The session runs in chunks (`chunk`), so the page can show early results.

## 9. The interface needed from calc.js

The engine needs no change to calc.js. The page calls `draftTable(C.auctionValues(H, P, s), H, P, s)` (`table.js`) on the result it already has, and posts the JSON to the worker with the two risk files (ArrayBuffers). It uses only public fields of the result: `players` (type, name, mlbamid, team, pos, value, sgpar, drafted, valuedAt, twoWay), `perSGP` and `fillTargets`. It reads the projected counts from the prepared tables H and P by MLBAM id. Two-way players follow the calculator's mode; the default (split) gives two rows.

## 10. Assumptions and limits

1. The rivals' parameters (`sigma_market` 0.15, `sigma_team` 0.10, `bench_share` 0.25, the inflation clip [0.2, 3]) have no validation.
2. The draws are independent across players (P8 = 0, R5 adds shared shocks).
3. The bench does not count; the playing-time fill stands in for in-season replacements. No drops or streaming (the option value is R6).
4. The lineup is set by the projections at the end of the draft.
5. Redraft only (the user's decision). Keepers are board step w41.
6. The head-to-head model is the approximation of section 6.
7. The user nominates the best player on its board in the dry run. The session prices nominations, but the rule for the user's nomination is part 2's.
8. The decisions are noisy. The break-even of a $62.1 player (the first lot, 4 seeds of the worlds): SD $4.1 on win and $2.9 on roto points at 200 simulations; SD $10.9 and $9.6 at 40 (`tests.py`, `break_even_repeatability`).

## 11. Part 2 and part 3

Part 2:

1. The CE (R7) with M, S and H from this engine (the `target` of each result), and the payout setting (winner-take-all, head-to-head playoffs).
2. The page: a worker (`nhl-draft/worker.js` pattern) that loads `py/*.py`, the table from `table.js` and the two risk files; the stops (pick, nominate, bid, enter a real draft's result).
3. A rule for the user's nomination; an option to price fewer lots (`auto_below`).
4. ADP for the snake rivals if a source exists.

Part 3: run the draft mode against drafters by the median values, as the evaluation of `nhl_draft` (win% and mean standings points), in both modes and both formats. Compare it with a plain value bidder on the same rooms.
