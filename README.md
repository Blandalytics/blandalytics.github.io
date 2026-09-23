# blandalytics.github.io

Source for [blandalytics.com](https://blandalytics.com).

## Homepage

[blandalytics.com](https://blandalytics.com) — a tile for each tool, built on the
[Phantom](https://html5up.net/phantom) template by HTML5 UP (CCA 3.0; the footer carries the
credit) with the site's dark palette. Each tile's picture is real output from its tool.

| file | role |
|---|---|
| `index.html` | the page: the definition, a section of tiles per sport (Baseball, then Hockey), the menu grouped the same way, and the footer |
| `assets/css/main.css`, `assets/js/` | the Phantom template, unchanged |
| `assets/css/blandalytics.css` | the site's palette and font over the template, the tile scrim, the footer wordmark |
| `images/tile-*.png` | the tile pictures, one per tool |
| `tools/homepage/grab_app_pngs.py` | runs each tool in headless Chrome and saves the PNG from its own export button (the NHL Draft Tool has none, so it screenshots the options table of a mock draft) |
| `tools/homepage/make_tiles.py` | crops those exports into the tiles, all at the template's tile aspect ratio |

### Updating the tiles

`grab_app_pngs.py` pins the game each tile shows in its `APPS` list (a tool's link hash);
the rest take whatever the tool opens on. It needs Chrome and `websocket-client`:

```
python tools/homepage/grab_app_pngs.py            # every tool, or name some: pitcher-cards sequencing-flow
python tools/homepage/make_tiles.py
```

The full-size exports land in `tools/homepage/cache/` (not committed). After changing
`blandalytics.css`, bump its `?v=` query in `index.html` so browsers fetch the new file.

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
type (stacked top to bottom by how often it was thrown that game, sized by every pitch of that type
at that count), and each link one plate appearance's step from a pitch to the next, so the ribbons
show what followed what. A pitch that ended its plate appearance has no link after its band. Pitch
types are labelled left of the first column; a type never thrown as a first pitch is labelled inside
the first band it appears in.

- **Hover a link** to trace that plate appearance across the columns. Its tooltip gives the batter,
  the inning and the full pitch chain ending in the actual event (colored by outcome group, home runs
  in pink), and is placed clear of the traced path.
- **Hover a band** to trace every plate appearance through it; the tooltip gives the pitch's share
  of pitches at that count and how many ended a plate appearance there.
- **Click a legend chip** to isolate a pitch type; only the outcome nodes it produced stay lit.
- **Show where plate appearances end** adds hollow outcome nodes (strikeout, batted-ball out,
  walk/HBP, hit, other — told apart by outline color) after the pitch that ended each plate
  appearance. Hovering one lists each plate appearance that ended there as the pitch that ended it
  and the event.
- On a phone, where there is no hover, a tap pins a tooltip and a second tap (or a tap elsewhere in
  the chart) clears it.
- **Save PNG** writes a square 2000 × 2000 image: the box-score line, the pitch-type key, the flow
  as shown (with the ending nodes and their key if they are on), and the Pitcher List Stats wordmark.

A flow is linkable as `sequencing-flow/#<pitcherId>-<YYYY-MM-DD>`.

**Batters** filters the diagram to the pitches thrown to right- or left-handed hitters; the
subheader then reads e.g. *June 12, 2026 @ PHI (vRHH)*, on the page and in the image.

Search a pitcher to open their most recent appearance (falling back to their latest season that
has one) and list the rest of that season; or pick a game date to list everyone who threw a tracked
pitch that day, longest outing first. With both set the page goes straight to that game. On arrival
with nothing asked for, it shows the longest outing of the most recent day with finished games.

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
- Pitcher search, game logs and team abbreviations come from the MLB Stats API directly, which
  allows cross-origin requests. The page is MLB only.
- Innings pitched are the change in the out count while the pitcher was on the mound, not the
  outs his plate appearances recorded: a runner picked off or caught stealing mid-plate-appearance
  is an out on the play but not the batter's result, so counting events alone loses it. A split by
  batter side has no continuous out count to read, so it falls back to counting events.

The chart is Plotly's sankey trace in a *fixed* layout the page computes itself, so that every
column is exactly one pitch number and the bands stack in usage order: node positions are the
centres Plotly expects and the heights are recomputed on d3-sankey's own scale (`value × ky`), with
`node.align = 'left'` so d3's columns match. Two quirks worth knowing before touching `sankey.js`:

- d3 sizes a node by max(inflow, outflow) and a first pitch has no inflow, so with the ending nodes
  hidden an invisible source node feeds each first-pitch band a link worth its full count. It is
  transparent, unoutlined, ignores the pointer and is skipped by the hover handlers.
- Plotly drops a node that has no links and reindexes the rest, which shifts every later node's
  position by one — so every node handed to Plotly must carry a link (the feed guarantees it).

Each link is one plate appearance's step (value 1) labelled with the plate appearance's id; that is
what lets a hover trace a whole plate appearance. Tooltips are drawn by the page rather than Plotly
so they can be placed away from the traced ribbons (sampled along each ribbon's outline plus
`isPointInFill` probes) and use the page's font. Save PNG rebuilds the layout at the export size,
lets Plotly rasterise the sankey, and draws the text and labels on the canvas.

| file | role |
|---|---|
| `sequencing-flow/data.js` | manifest, Parquet queries, the live-feed fallback, Stats API lookups, and `buildFlow`: pitches → nodes, links and plate appearances |
| `sequencing-flow/sankey.js` | the chart: the fixed layout, hover / tap tracing, the tooltips, Save PNG |
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
| `swing-profiles/data/<season>.json` | every hitter and bat side with a card that season: bat speed at contact, imputed duration, peak acceleration — what the small distribution charts under the numbers draw |
| `tools/swing_profiles/build_data.py` | builds those files by running the Python pipeline over the whole leaderboard (~500 cards, about a minute) |

Under each of the three numbers the page draws where that hitter sits among everyone else
that season: a KDE of the metric over every other hitter with a card, in the figure's own
colour, with the hitter's value marked and the share of the league below it tinted.
[`.github/workflows/swing-profiles.yml`](.github/workflows/swing-profiles.yml) rebuilds the
current season's file every morning at 11:00 UTC (a hitter's duration moves a little as the
leaderboard's swing length does) and takes a `seasons` input for backfills; it clones
[Blandalytics/swing_profiles](https://github.com/Blandalytics/swing_profiles) alongside,
as the scorecards clone the scraper.

### Updating

Nothing is stored for a profile: it is fetched and computed on request. If Savant changes the
card template, the pixel anchors at the top of `swing.js` (`WIN_*`, `X_START`, `X_IMPACT`,
`Y_ZERO`, `PX_PER_MPH`, `AXIS_*`) need rechecking, exactly as in the Python. The chart's
vertical position is measured per card from its y-axis line, because a player name that
wraps onto two lines pushes the whole Bat Speed panel down a line. After any change to the
JavaScript, bump the `?v=` query on the three script tags in `index.html` so browsers fetch
the new files.

## Batted Ball Charts

[blandalytics.com/batted-balls/](https://blandalytics.com/batted-balls/) — where a hitter's batted
balls go, spray angle against launch angle, as a density compared to every MLB batted ball that
season or to the hitter's own prior season. Pick a season and a hitter (or tick *Team-wide* and
pick a team); *Self (prior year)* subtracts the hitter's previous season instead of the league. The
boxed numbers are the hitter's share of batted balls in each pull / centre / oppo by ground ball
/ line drive / fly ball / pop up cell, with the row and column shares along the axes (as changes
from the prior season in the self comparison). Isaac Paredes' current season loads on arrival; a
chart is linkable as `batted-balls/#<season>-<mlbam id>` or `#<season>-<team>`, with a
`-self` suffix. **Download PNG** saves the figure at 2x.

It is the chart [batted-ball-charts.streamlit.app](https://batted-ball-charts.streamlit.app/)
draws ([PLV_viz `batted_ball_charts.py`](https://github.com/Blandalytics/PLV_viz/blob/main/hitter_app/pages/batted_ball_charts.py)),
in its discrete colour scale, rebuilt for the browser with the same geometry, palette (seaborn's
`vlag` bands, at 11 levels rather than 13) and layout, under the header the Swing Profiles figure
carries — the hitter in the header colour, what the chart shows muted beneath it, and the Pitcher
List Stats wordmark opposite: a Gaussian KDE of the hitter's balls on a 91 × 91 grid over 0–90° of spray by
−30–60° of launch angle, scaled to sum to 100, minus the league's. The hitter's density is
computed in the page exactly as `scipy.stats.gaussian_kde` would (Scott's factor on the full
sample covariance; checked against scipy to floating-point noise); the league's is built ahead of
time. The bands are drawn as Tanaka (illuminated) contours: every contour edge is stroked white
where its downhill side faces a light from the upper left and black where it faces away, thinning
to nothing as the edge turns parallel to the light, so the peaks read as hills.

### How it works

The data comes from the completed-games Parquet in the bucket (see *Data files*) rather than the
app's own files, and is reduced to two small JSON files there that the page reads:

- `https://data.blandalytics.com/batted-balls/index.json` — the seasons built, with what each
  covers.
- `https://data.blandalytics.com/batted-balls/<season>.json` — every hitter's regular-season
  batted balls (spray angle in the app's convention — 0° at the pull-side line, 45° dead centre,
  90° at the opposite line, for either hand — and launch angle), their team and bat side, the
  team list, and the league density on the grid. About 1.5 MB, 450 KB compressed.
- [`.github/workflows/batted-balls.yml`](.github/workflows/batted-balls.yml) rebuilds the current
  season every morning at 11:15 UTC, after the data files roll, and takes a `seasons` input for
  backfills; a season takes about ten seconds.

| file | role |
|---|---|
| `tools/batted_balls/build_data.py` | reads a season's files from the bucket, keeps regular-season balls in play with a launch angle and a landing spot, writes the season file and the index |
| `batted-balls/chart.js` | the figure: the KDE, the shares, the contour bands (d3-contour) with their edges lit as Tanaka contours, the colourbar and labels, on a canvas in the app image's 1390 × 1135 pixels at 2x |
| `batted-balls/index.html`, `app.js` | the page: season, hitter / team and comparison controls, the link hash, the download |

A traded hitter's batted balls count for each of his teams in the team-wide chart, and his
listed team is the last he hit for. A hitter needs three batted balls (not all in a line) for a
density; the self comparison needs the prior season built, and reports when the hitter has no
batted balls in it. Locally, `python tools/batted_balls/build_data.py --out batted-balls/data
--seasons 2026` writes the same files under `batted-balls/data/batted-balls/`, and the page reads
them with `?data=data/`. After any change to the JavaScript, bump the `?v=` query on the two
script tags in `index.html` so browsers fetch the new files.

## Release Angles

[blandalytics.com/release-angles/](https://blandalytics.com/release-angles/) — where each of an
MLB pitcher's pitch types leaves the hand, as horizontal (HRA) against vertical (VRA) release
angle: one 1-SD covariance ellipse per pitch type, and how much they overlap. Four views of the
same chart: the outlines alone, **Overlap count** (how many ellipses cover each spot),
**Usage-weighted** (the share of the pitcher's pitches whose type covers it) and
**Concentration** (each exact set of overlapping ellipses — a segment — shaded by the pitches
that landed in it per square degree). **Play loop** cross-fades through the four; **Download
GIF** saves that loop (928 × 928, 17.2 s) and the PNGs are the stills at 2320 × 2320. Pick a
season and a pitcher (regular season only, the script's default); *From* / *Through* cut the
season to a date segment. *Options* sets the ellipse size, the
fewest pitches a type needs to be drawn, and the smallest segment the concentration scale
counts. **Overlap numbers** is the script's printed report: per pitch type area, mean depth and
mean share, and the most concentrated segments. Paul Skenes' current season loads on arrival; a
chart is linkable as `release-angles/#<season>-<mlbam id>`, with
`&from=` / `&to=` (ISO dates), `&sd=`, `&min=`, `&seg=` and `&view=type|count|share|segment`.

It is [baseball_snippets `release_angles.py`](https://github.com/Blandalytics/baseball_snippets/blob/main/release_angles.py)
(with the ellipse maths of [`ellipse_depth.py`](https://github.com/Blandalytics/baseball_snippets/blob/main/ellipse_depth.py))
ported to the browser: the same figure geometry, depth / share / segment maps on the same
1100-point grid, colour ramp (stepped through L\*a\*b\*), leaders, titles and four-state loop,
and an overlap report whose per-type table and summary agree with the script's to every
printed digit (checked on Paul Skenes' 2026; segment densities move in the first decimal, since
the tighter frame puts the grid's cells closer together). It departs from the script in four
places:

- **Names never collide.** Candidate spots ring each ellipse at a ladder of distances and must
  clear every ellipse's fill; the names are placed greedily, in 120 seeded orders, under hard
  rules — no name overlaps another, and no leader crosses a name or another leader — and the
  arrangement with the smallest frame wins (nearness to its own ellipse, and a leader that stays
  off other ellipses, break ties). The same chart always comes out the same. Each name's
  candidates are sorted by the part of their cost that placement can't change, so a pass stops
  at the first one that can't beat the best so far; the whole layout takes 40–90 ms.
- **The frame is as tight as the names allow.** Rather than a fixed margin round the ellipses,
  the frame is the square round the ellipses and the placed names plus a small margin. Text is
  sized in points while the frame sets the degree scale, so frame, name sizes and placement are
  iterated until the frame settles — on the first 20 orders, with all 120 run once at the end.
- **One bottom row.** The footer note, the scale and the Pitcher List Stats wordmark share one
  centre line, below the chart.
- **No spines.** The degree grid is the only frame.

The GIF merges each hold's identical frames into one long frame, as Pillow does, so it has the
Python's 57 frames and runs in the browser in a few seconds.

### How it works

The angles come from the completed-games Parquet in the bucket (see *Data files*): release
velocity is backed out of the 50 ft trajectory fit to the release point (60.5 ft minus
extension), and HRA / VRA are the angles it makes with the line to the plate — the script's
`pitch_angles()`. They are computed once a night and written back to the bucket:

- `https://data.blandalytics.com/release-angles/index.json` — the seasons built, with what each
  covers.
- `https://data.blandalytics.com/release-angles/<season>.json` — the pitchers: id, name, team,
  hand, regular-season pitch count, first and last dates. About 110 KB.
- `https://data.blandalytics.com/release-angles/<season>.parquet` — every regular-season pitch's
  pitcher, date, game type, pitch type, HRA and VRA, sorted by pitcher in 8,192-row groups (~8 MB a season). The
  page reads the row-group statistics on `pitcher` from the footer and range-requests only the
  one or two groups holding the chosen pitcher, with
  [hyparquet](https://github.com/hyparam/hyparquet) — a chart costs 150–200 KB. Opening a season
  is one suffix request (the footer, and the file's length from `Content-Range`, so no HEAD), and
  a pitcher is one request for the byte span of their row groups, which hyparquet then reads
  from memory: a new pitcher is on screen in ~100 ms.
- [`.github/workflows/release-angles.yml`](.github/workflows/release-angles.yml) rebuilds the
  current season every morning at 11:30 UTC, after the data files roll, and takes a `seasons`
  input for backfills; every season from 2020 builds in under half a minute.

| file | role |
|---|---|
| `tools/release_angles/build_data.py` | reads a season's files from the bucket, computes HRA and VRA, writes the season's Parquet, pitcher list and the index |
| `release-angles/angles.js` | the figure: ellipses, the name placement and the frame it sets, the three shaded maps and the segments, drawing at any dpi, the GIF (gifenc), the report |
| `release-angles/index.html`, `app.js` | the page: season, pitcher, games and date controls, the views and loop, the Parquet read, downloads, the link hash |

Locally, `python tools/release_angles/build_data.py --out release-angles/data --seasons 2026`
writes the same files under `release-angles/data/release-angles/`, and the page reads them with
`?data=data/` — from a server that honours `Range` requests, which `python -m http.server` does
not. After any change to the JavaScript, bump the `?v=` query on the two script tags in
`index.html` so browsers fetch the new files.

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
