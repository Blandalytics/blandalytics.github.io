# Live games

A Cloudflare Worker that polls the MLB Stats API live feed for in-progress games
in every league the API carries (MLB, the affiliated minors, winter and
international ball, ...) every ~30 seconds and writes trimmed JSON to an R2
bucket. The site reads those files directly; nothing here touches the repo.
For MLB games it also builds the PLV pitcher cards from the same feed (below).

Pitch tracking is per venue rather than per league: all of MLB and Triple-A, a
Single-A park with Hawk-Eye here and there, none of Double-A. So the poller
doesn't assume — each live game is probed with a tiny fetch of just its pitch
speeds, and only games that turn out to be tracked get the full feed.

| file | role |
|---|---|
| `src/index.js` | `scheduled()` polls and writes; `fetch()` serves `live/` read-only |
| `test/harness.mjs` | `npm test`: one cron pass against an in-memory bucket, plus the probe on games with known answers |
| `src/cards/pack.js` | reads a model pack (written by `tools/pitcher_card/model_pack.py`, layout there) as zero-copy typed arrays |
| `src/cards/trees.js` | LightGBM and XGBoost tree ensembles evaluated from a pack, matching the Python libraries bit for bit on raw scores / margins |
| `test/trees.mjs` | `npm test`: those evaluators against small committed models with the libraries' outputs (`test/fixtures/trees.pack`, from `tools/pitcher_card/make_tree_fixture.py`) |
| `test/parity.mjs` | the comparison behind `trees.mjs`; `tools/pitcher_card/check_trees.py` runs it on the real pitch-modeling and xSLG models |
| `src/cards/live.js` | the live pitcher cards: which pitchers to rebuild after a feed moves, the card files and `live/cards/index.json` |
| `src/cards/feed.js` | the feed's plays as the rows statfast builds from them (its columns, its float32) |
| `src/cards/scorer.js` | pitch-modeling's `score_pitches.py`: Stuff, Pitching and Location run values per pitch |
| `src/cards/groups.js`, `src/cards/abs.js` | its `pitch_groups.py` / `pitch_l1.py` and `abs_2026.py` |
| `src/cards/build.js` | `tools/pitcher_card/build_data.py`: one pitcher's card dict |
| `src/cards/npf.js` | numpy / pandas numerics (float32 steps, group means, rounding, Python's formatting) |
| `src/cards/bundle.js` | the scorer bundle (`cards/models/scorer.pack`) as what `scorer.js` runs on |
| `test/card_parity.mjs` | the port against the Python pipeline on real games (inputs from `tools/pitcher_card/parity.py`); the nightly cards workflow runs it before publishing a bundle |
| `test/live_cards.mjs` | `live.js` on a real game against an in-memory bucket: mid-game builds, no-op ticks, the final pass, the index |
| `wrangler.jsonc` | Worker name, cron window (game hours, UTC) and the R2 binding |
| `cors.json` | bucket CORS policy, for when the bucket is served from its own domain |

Objects written:

| key | contents | cache |
|---|---|---|
| `live/today.json` | yesterday's and today's schedule for every league: status, score, inning, sport, venue, and `tracked` (`true` / `false` / `null` = not enough pitches yet) | 20s |
| `live/games/<gamePk>.json` | plays and pitches (type, velo, location, spin, EV/LA) for tracked games | 20s, 1h once final |
| `state/games.json` | what the poller knows about each game (tracked? last feed timestamp? finalised?); not served | — |
| `live/cards/<gamePk>-<pitcherId>.json` | one MLB pitcher's card dict, as `tools/pitcher_card/build_data.py` makes it | 60s |
| `live/cards/index.json` | the games and pitchers with cards, as a day manifest plus each game's status and each pitcher's pitch count at his last build | 15s |

The feed is fetched with a `fields=` filter (~400 KB instead of ~800 KB per game)
and a game is only re-written when the feed's `metaData.timeStamp` has moved. A
game with 20+ pitches and no speeds is marked untracked and re-checked every ten
minutes. Seven tracked games cost about 50 ms CPU per cron tick; an in-season
evening with MLB and Triple-A both going is a few hundred, which needs the Workers
Paid plan (the free plan's 10 ms limit is enforced on consistent overage).

Read it from the site at `https://blandalytics-live.blandalytics.workers.dev/live/...`
until a custom domain is attached to the bucket.

## Live pitcher cards

When an MLB game's feed moves, `src/cards/live.js` rebuilds the card of every
pitcher whose pitch count has changed since his last build: the game's pitches are
scored by the JS port of the pitch-modeling models and the card dict is built as
the nightly Python pipeline builds it, so the picker's **Live** entry is within a
minute of the pitch. A game gets one last pass for every pitcher when it goes final,
and leaves the live index once `cards/index.json` (the nightly build) has it.

It reads what the nightly cards workflow publishes to the bucket:
`cards/models/scorer.pack` (the models, ~17 MB, reloaded within ten minutes of a new
one), `cards/pitchers/<id>.json` (each pitcher's comparison seasons) and
`cards/arms/<season>.json`. Until the first of those exists the card builds log
`scorer.pack is missing` and skip; the poller itself is unaffected, as it is by any
card that fails.

Scoring is the expensive part, about a millisecond per pitch here: a rebuild re-scores
the pitcher's whole outing (his primary fastball, and so every pitch's differences
from it, can change with each pitch), so a busy evening costs a second or two of CPU
per tick, well inside a cron invocation's 30 seconds.

The cards used to be built by a GitHub workflow (`pitcher-cards-live.yml`) that this
Worker dispatched every five minutes with a `GH_TOKEN` secret. Neither exists now;
the secret can be removed with `npx.cmd wrangler secret delete GH_TOKEN` (from this
folder).

## Deploying

`.github/workflows/live-worker.yml` runs `wrangler deploy` on any push to `main`
that touches `tools/live/`. It needs two repository secrets:
`CLOUDFLARE_API_TOKEN` (an *Edit Cloudflare Workers* token) and
`CLOUDFLARE_ACCOUNT_ID`. Deploying also (re)registers the cron trigger.

By hand, from this directory (`npx.cmd` sidesteps PowerShell's script policy):

```powershell
npm install
npx.cmd wrangler login
npx.cmd wrangler deploy
npx.cmd wrangler tail blandalytics-live --format json   # cpuTime / outcome per tick
```

## One-time bucket setup

Already done for `blandalytics-live`; kept here for a rebuild.

```powershell
npx.cmd wrangler r2 bucket create blandalytics-live
npx.cmd wrangler r2 bucket lifecycle add blandalytics-live expire-live live/ --expire-days 7
npx.cmd wrangler r2 bucket cors set blandalytics-live --file cors.json
```

To serve the bucket from a domain on Cloudflare (adds CDN caching per the
`Cache-Control` headers the Worker sets):

```powershell
npx.cmd wrangler r2 bucket domain add blandalytics-live --domain data.blandalytics.com --zone-id <ZONE_ID>
```

## Local run

```powershell
npm run dev                                        # local worker + simulated bucket
curl.exe "http://127.0.0.1:8787/__scheduled"       # fire the cron handler once
curl.exe  http://127.0.0.1:8787/live/today.json    # read what it wrote
```

Add `--remote` to `wrangler dev` to run against the real bucket instead.
