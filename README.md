# blandalytics.github.io

Source for [blandalytics.com](https://blandalytics.com).

## MLB Scorecards

[blandalytics.com/scorecards/](https://blandalytics.com/scorecards/) — a pitch-by-pitch
scorecard for every MLB game, built from Statcast tracking data. Pick a date, a team
and a game; hover any plate appearance for its full pitch sequence, or any inning for
its plate appearances.

### How it works

GitHub Pages only serves static files, so the pages are pre-built by a scheduled
workflow rather than generated on request:

- [`.github/workflows/scorecards.yml`](.github/workflows/scorecards.yml) runs every
  morning at 10:00 UTC, once the previous night's games are all final. It clones
  [Blandalytics/statcast_scraper](https://github.com/Blandalytics/statcast_scraper),
  scrapes each new game, renders it, and commits the result.
- [`scorecards/games/<gamePk>.html`](scorecards/games/) — one standalone page per game.
- [`scorecards/games.json`](scorecards/games.json) — the manifest the index page reads
  to populate its date / team / game selectors. Games already listed are skipped on
  later runs, so the nightly job only pays for new games.
- [`scorecards/index.html`](scorecards/index.html) — the selector page. A game can be
  linked directly as `scorecards/#<gamePk>`.

The pipeline lives in [`tools/scorecard/`](tools/scorecard/):

| file | role |
|---|---|
| `scorecard.py` | `scorecard(game_pk)` → HTML string; `scorecards_for_date(date)` → every game that day from one scrape |
| `build_data.py` | joins the scraper's pitches to the Stats API play-by-play into a scorecard dict |
| `render.py` | renders that dict as the page |
| `build_site.py` | builds a date range into `scorecards/` and maintains the manifest |

### Backfilling or re-rendering

Run the workflow by hand from the **Actions** tab (*Build scorecards → Run workflow*)
with a `start` and `end` date. Tick `force` to re-render games that already exist,
which is what you want after changing anything in `render.py`. A full season is
roughly 2,400 games at about a second each; the manifest is checkpointed after every
date, so an interrupted backfill resumes where it stopped.

Locally, from the repo root with the scraper cloned alongside:

```bash
git clone --depth 1 https://github.com/Blandalytics/statcast_scraper.git
pip install -r tools/scorecard/requirements.txt
python tools/scorecard/build_site.py --start 2026-08-01 --end 2026-08-31
```

Or one game, without the site machinery:

```python
from tools.scorecard.scorecard import scorecard
html = scorecard(824638)
```

## Live games

[blandalytics.com/live/](https://blandalytics.com/live/) — every game in progress,
pitch by pitch. The scorecards are built the morning after; for games in progress
a Cloudflare Worker in [`tools/live/`](tools/live/) polls the Stats API live feed
every ~30s during game hours and writes trimmed JSON to an R2 bucket served at
`https://data.blandalytics.com`, which [`live/index.html`](live/index.html) reads
directly (no build step; it re-fetches every 30s while the tab is visible). The
Worker watches every league the API carries and probes each game for pitch
tracking (all of MLB and Triple-A have it, plus the odd lower-level park):

- `live/today.json` — yesterday's and today's schedule for every league with status,
  score, inning, sport, venue and a `tracked` flag
- `live/games/<gamePk>.json` — plays and pitches (type, velocity, location, spin, EV/LA)
  for tracked games

Nothing is committed to the repo; the objects expire after a week and the nightly
scorecard build remains the record for finished games.

## Data files

Completed games as pitch-level Parquet, in the same bucket under
`https://data.blandalytics.com/data/`: one immutable file per settled day, closed
month or closed season, per league, with a manifest saying what exists. Built by
[`tools/data/backfill.py`](tools/data/backfill.py) on top of the scraper;
[`.github/workflows/data.yml`](.github/workflows/data.yml) rolls the settled day
(and any month that has just closed) in every night and takes inputs for backfills.
Details in [`tools/data/README.md`](tools/data/README.md).
[`.github/workflows/live-worker.yml`](.github/workflows/live-worker.yml) deploys
the Worker on any push that touches `tools/live/`. Setup and local testing are in
[`tools/live/README.md`](tools/live/README.md).

## PLV Pitcher Game Cards

[blandalytics.com/pitcher-cards/](https://blandalytics.com/pitcher-cards/) — the Pitcher List
Stats game card for every pitcher in every MLB game. Pick a date, a game (or every game that
day) and a pitcher; toggle the comparison to an earlier season and choose which one. The card
is the same one the Streamlit app in
[Blandalytics/player_cards](https://github.com/Blandalytics/player_cards) draws
(`pitcher_game_card.py`), rebuilt as a page: the box-score line and game grade, the Stuff /
Locations / PLV grades, the primary fastball's shape, usage against each side of the plate,
movement with the arm angle and the comparison season's shaded regions, locations against
each side, and the per-pitch-type metrics table. **Save PNG** rasterises the card at 2x with
the font and logo embedded.

### How it works

The pages are pre-built by a scheduled workflow, into the same R2 bucket as the data
files rather than the repo — a season is ~22,000 cards, more than a GitHub Pages site may
hold — and the picker in [`pitcher-cards/index.html`](pitcher-cards/index.html) reads them
from there:

- [`.github/workflows/pitcher-cards.yml`](.github/workflows/pitcher-cards.yml) runs every
  morning at 10:30 UTC. It clones
  [Blandalytics/statcast_scraper](https://github.com/Blandalytics/statcast_scraper) (the
  pitches) and [Blandalytics/player_cards](https://github.com/Blandalytics/player_cards) (the
  PLV model files) and builds a card for every pitcher who threw a tracked pitch the day
  before. A backfill splits its range into months and builds them as parallel jobs; the index
  is rebuilt from the day manifests once they have all finished.
- [`.github/workflows/pitcher-cards-live.yml`](.github/workflows/pitcher-cards-live.yml) runs
  every 15 minutes through game hours and builds cards for the pitchers in the games in
  progress — the same card, from the pitches thrown so far — into `live/cards/`. A card is
  rebuilt only when its pitcher's pitch count has moved; a game gets one last build after it
  ends, and the nightly run then writes the permanent card. The picker shows these under a
  **Live** entry while games are on.
- `https://data.blandalytics.com/cards/<gamePk>-<pitcherId>.html` — one standalone page per
  pitcher per game. The card is a single SVG drawn in the original figure's 1500 × 2000
  coordinate system, so every panel keeps the matplotlib layout. Every comparison season's
  layer is in the page, tagged `data-cmp="<year>"`; `#cmp=<year>` in the URL picks one and
  `#cmp=0` hides them. The picker frames the page from the other origin and asks it, by
  `postMessage`, to switch layers or hand back a PNG.
- `https://data.blandalytics.com/cards/days/<date>.json` — that day's games and pitchers,
  which the picker reads; `.../cards/index.json` lists the dates built and which date each
  game is on. A card can be linked directly as `pitcher-cards/#<gamePk>-<pitcherId>`.

The pipeline lives in [`tools/pitcher_card/`](tools/pitcher_card/):

| file | role |
|---|---|
| `card.py` | `pitcher_card(game_pk, pitcher_id)` → HTML string, for a finished game or one in progress; `cards_for_date(date)` → every pitcher that day |
| `fetch.py` | the statsapi live feed (box score, bio, teams), Baseball Savant's arm angles, and `DataStore`: pitches by date from the data files in the bucket, topped up through the scraper for the days the files don't reach yet |
| `live_cards.py` | the cards for the games in progress, published to the bucket; what `pitcher-cards-live.yml` runs |
| `prep.py` | per-pitch metrics from the scraper's columns: counts before the pitch, approach angles, break as acceleration, fastball differences, the per-type tables |
| `models.py` | the stuff / location / PLV model chains and the xSLG model, from the `player_cards` checkout |
| `shapes.py` | the comparison season's movement regions (seaborn's 90%-mass KDE contours) as SVG paths |
| `grades.py` | palette, pitch-type names and colours, benchmark bins, letter grades and both game-score formulas |
| `build_data.py` | assembles all of that into one card dict |
| `render.py` | renders the dict as the page |
| `build_site.py` | builds a date range into the bucket (or a folder with `--out`) and maintains the manifests; `--reindex` rebuilds the index alone |

The comparison seasons, and the pitches of any settled date, come from the completed-games
Parquet in the bucket (see *Data files*): each file is downloaded once, narrowed to the ~40
columns a card reads and cached, so a cold build of a card is under a minute rather than
four. The days the files don't reach yet — the two most recent — are pulled through the
scraper, as is a game in progress (one game at a time, so a card can be built mid-game). The
only other sources are the game's live feed (box score, bio, team names — one request per
game) and Baseball Savant's arm-angle leaderboard, which the scraper does not cover. The card is MLB
only, because the scraper is; the minor-league and international levels the app offered
are not built. Comparison seasons go back to 2023, as in the app; a season is offered once
the pitcher has three appearances in it before the game.

The code passes `ruff check` and `ruff format` with the config in
[`tools/pitcher_card/ruff.toml`](tools/pitcher_card/ruff.toml), including a McCabe
complexity limit of 5 per function.

### Backfilling or re-rendering

Run the workflow by hand from the **Actions** tab (*Build pitcher cards → Run workflow*)
with a `start` and `end` date; tick `force` to re-render cards that already exist, which is
what you want after changing anything in `render.py`. A day of games is roughly 150 cards
at about half a second each; a whole season runs as one job per month, four at a time, in
under an hour. Cards already in a day's manifest are skipped, so an interrupted backfill
resumes where it stopped. The first run also downloads each comparison season's data file
once (a few seconds per season), after which they come from the workflow's cache. Writing
to the bucket needs the `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
`CLOUDFLARE_ACCOUNT_ID` secrets the data files use.

Locally, from the repo root with the scraper and the models cloned alongside:

```bash
git clone --depth 1 https://github.com/Blandalytics/statcast_scraper.git
git clone --depth 1 https://github.com/Blandalytics/player_cards.git
pip install -r tools/pitcher_card/requirements.txt
python tools/pitcher_card/build_site.py --out pitcher-cards --start 2026-09-17 --end 2026-09-17
```

`--out` writes to a folder instead of the bucket; open the picker with
`?index=cards/index.json` to read that local build.

Or one card, without the site machinery — for a finished game or one in progress:

```python
from tools.pitcher_card.card import pitcher_card
html = pitcher_card(822845, 543243)
```

The live cards can be run by hand too: `python tools/pitcher_card/live_cards.py --game <gamePk>`
builds every pitcher in that game into the bucket, or into a folder with `--out`.

## Sequencing Flow

[blandalytics.com/sequencing-flow/](https://blandalytics.com/sequencing-flow/) — one pitcher's game as
a Sankey diagram. Each column is the pitch's number within the plate appearance, each band a pitch
type (stacked by how often it was thrown that game), and each link one plate appearance's step from
a pitch to the next, so the ribbons show what followed what. Hover a link to trace that plate
appearance across the columns (its tooltip gives the batter, inning and the full chain ending in the
event, and is placed clear of the traced path); hover a band to trace every plate appearance through
it; click a legend chip to isolate a pitch type. *Show where plate appearances end* adds outcome
nodes (strikeout, batted-ball out, walk/HBP, hit, other) after the pitch that ended each PA, so every
pitch is drawn. A flow is linkable as `sequencing-flow/#<pitcherId>-<YYYY-MM-DD>`.

Search a pitcher to list their appearances in a season, or pick a game date to list everyone who
threw a tracked pitch that day; with both set the page goes straight to that game. On arrival it
shows the longest outing of the most recent day with finished games.

### How it works

Nothing is built ahead of time; the page queries the data in the browser:

- Settled dates come from the completed-games Parquet in the bucket (see *Data files*). The page
  reads the manifest, picks the finest file covering the date (day, month or season) and queries it
  with [hyparquet](https://github.com/hyparam/hyparquet) over HTTP range requests, narrowed to the
  date and ~20 columns — a few hundred KB and under a second even out of a 130 MB season file, since
  the files are sorted by date and the row-group statistics rule most of them out.
- Dates after the manifest's `last_finalized` come from the live feed's `live/games/<gamePk>.json`
  while those objects exist (the schedule for the day comes from the Stats API); a game in progress
  draws what has been thrown so far.
- Pitcher search and game logs come from the MLB Stats API directly, which allows cross-origin
  requests. The page is MLB only.

| file | role |
|---|---|
| `sequencing-flow/data.js` | manifest, Parquet queries, the live-feed fallback, Stats API lookups, and `buildFlow`: pitches → nodes, links and plate appearances |
| `sequencing-flow/sankey.js` | the chart: Plotly's sankey trace in a fixed layout computed to match d3-sankey's scale, hover tracing, the path-dodging tooltip |
| `sequencing-flow/index.html`, `app.js` | the page and its pitcher / season / date / game controls |

After any change to the JavaScript, bump the `?v=` query on the module imports in `index.html` and
`app.js` so browsers fetch the new files.

## Swing Profiles

[blandalytics.com/swing-profiles/](https://blandalytics.com/swing-profiles/) — Bat Speed,
Acceleration, and Jerk through an MLB hitter's swing. Pick a season and a player; the page
fetches the player's Baseball Savant swing-path card, digitizes the Bat Speed chart out of its
pixels, imputes the swing's real duration from the bat-tracking leaderboard (swing length /
mean bat speed), and differentiates. The player list shows ten names and scrolls through
everyone on that season's leaderboard, regulars first; *Bats* offers only the sides the hitter
actually has there, so a switch hitter gets two and everyone else one. Junior Caminero's latest
season loads on arrival. The figure downloads as a PNG with the Pitcher List Stats wordmark,
the curve as a CSV, and a profile is linkable as `swing-profiles/#<mlbam id>-<season>-<L|R>`.

It is [Blandalytics/swing_profiles](https://github.com/Blandalytics/swing_profiles) ported
to JavaScript, module for module, so it runs in the browser with nothing to install: both
Savant endpoints allow cross-origin requests, and the browser decodes the card natively.
The port was checked against the Python on a set of player-seasons — the digitized curves
are bit-identical, and durations and derivatives agree to floating-point noise.

| file | role |
|---|---|
| `swing-profiles/swing.js` | the pipeline: leaderboard fetch and name resolution (`savant_lookup`), card digitizer (`swing_path_extract`), duration (`swing_duration`), Savitzky–Golay derivatives (`swing_profile`) |
| `swing-profiles/plot.js` | the figure, on a canvas at 200 dpi with the same geometry and theme as `swing_plot.py` |
| `swing-profiles/index.html`, `app.js` | the page: season, player and bat-side controls, the stats strip, downloads |

### Updating

Nothing is stored: every profile is fetched and computed on request. If Savant changes the
card template, the pixel anchors at the top of `swing.js` (`WIN_*`, `X_START`, `X_IMPACT`,
`Y_ZERO`, `PX_PER_MPH`, `AXIS_*`) need rechecking, exactly as in the Python. The chart's
vertical position is measured per card from its y-axis line, because a player name that
wraps onto two lines pushes the whole Bat Speed panel down a line. After any change to the
JavaScript, bump the `?v=` query on the three script tags in `index.html` so browsers fetch
the new files.

## NHL Draft Tool

[blandalytics.com/nhl-draft/](https://blandalytics.com/nhl-draft/) — a draft tool for a 12-team
rotisserie hockey league. You sit in one seat; the other teams draft themselves off boards
that blend a value-over-replacement ranking with ADP, and at every stop each of your options
is priced by simulating the rest of the draft hundreds of times and scoring the league it
leads to: roto points, plus what the pick adds in every category and where every team sits.

It runs entirely in the browser: [Pyodide](https://pyodide.org) loads the same Python the
command-line tool uses, so there is no server and nothing to install.

| file | role |
|---|---|
| `nhl-draft/index.html`, `app.js` | the page: settings for every argument of the CLI tool, a do-not-draft list, the draft console |
| `nhl-draft/worker.js` | a Web Worker that loads Pyodide, numpy and pandas, then drives `web_api.Session` |
| `nhl-draft/py/` | the tool itself — `league.py`, `valuation.py`, `boards.py`, `draft_sim.py`, `pick_engine.py`, `draft_tool.py`, `web_api.py` |
| `nhl-draft/data/sheet_live.csv` | the projections and eligibility sheet; `merged_players.csv` carries Yahoo ranks |

### Updating

The projections are a snapshot. To refresh them, replace `nhl-draft/data/sheet_live.csv`
with a new export of the sheet (same columns), then bump `VERSION` in `app.js` and the
`app.js?v=` query in `index.html` so browsers fetch the new files. The same bump is needed
after any change to the Python under `nhl-draft/py/`. A different projections file can also
be loaded on the page itself, without deploying, through the *Projections* file input.
