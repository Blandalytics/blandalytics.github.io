# blandalytics.github.io

Source for [blandalytics.com](https://blandalytics.com).

## Homepage

[blandalytics.com](https://blandalytics.com) — a tile for each tool, built on the
[Phantom](https://html5up.net/phantom) template by HTML5 UP (CCA 3.0; the footer carries the
credit) with the site's dark palette. Each tile's picture is real output from its tool.
Model Drilldown leads the Baseball tiles, the menu and the footer's tool list. PLV Pitcher Game
Cards is hidden from all three for now: its tile and links are commented out in `index.html`, and
`/pitcher-cards/` itself is still live.

| file | role |
|---|---|
| `index.html` | the page: the definition, a section of tiles per sport (Baseball, Hockey, then Basketball), the menu grouped the same way, and the footer |
| `assets/css/main.css`, `assets/js/` | the Phantom template, unchanged |
| `assets/css/blandalytics.css` | the site's palette and font over the template, the tile scrim, the footer wordmark |
| `shared/share-image.js` | **Share image**, the one export button of every tool that makes a figure: a menu of Copy image and Download PNG (plus a tool's other downloads, such as Release Angles' GIF). Copy image falls back to a download where the browser refuses the clipboard. Each tool hands it a function that draws the PNG and one that names the file; the menu items get ids (`<button id>_copy`, `<button id>_download`) for `grab_app_pngs.py`. Pages load it as `/shared/share-image.js?v=N`: bump N with each change |
| `images/tile-*.webp` | the tile pictures, one per tool: `tile-NAME.webp` at 900 px and `tile-NAME-720.webp`, offered through `srcset` |
| `tools/homepage/grab_app_pngs.py` | runs each tool in headless Chrome and saves the PNG from its own export button (the NHL Draft Tool and the Auction Calculator have none, so it screenshots the options table of a mock draft and the top of the values table) |
| `tools/homepage/make_tiles.py` | crops those exports into square tiles (a figure whose edges carry text, like Batted Ball Charts and Swing Profiles, is padded out with its background instead; Model Drilldown's is the card's header over its waterfall tile, cut from the 16:9 card); `blandalytics.css` holds every tile at 1:1 |

### Updating the tiles

`grab_app_pngs.py` pins the game each tile shows in its `APPS` list (a tool's link hash);
the rest take whatever the tool opens on. It needs Chrome and `websocket-client`:

```
python tools/homepage/grab_app_pngs.py            # every tool, or name some: pitcher-cards sequencing-flow
python tools/homepage/make_tiles.py               # same: name the tiles you re-pulled, so the rest aren't redone from older exports
```

The full-size exports land in `tools/homepage/cache/` (not committed). Cloudflare holds images
and stylesheets for four hours under their exact URL, so each tile's `<img>` carries a `?v=`
query: `make_tiles.py` bumps it whenever a tile comes out different, so commit `index.html` with
the image. After changing `blandalytics.css`, bump its `?v=` in `index.html` by hand.

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
every ~30s while games are live and writes trimmed JSON to an R2 bucket served at
`https://data.blandalytics.com`, which [`live/index.html`](live/index.html) reads
directly (no build step; it re-fetches every 30s while the tab is visible). The
Worker watches every league the API carries and probes each game for pitch
tracking (all of MLB and Triple-A have it, plus the odd lower-level park):

- `live/today.json` — yesterday's and today's schedule for every league with status,
  score, inning, sport, venue and a `tracked` flag
- `live/games/<gamePk>.json` — plays and pitches (type, velocity, location, spin, EV/LA)
  for tracked games
- `live/cards/` — the PLV pitcher cards for the MLB games in progress, rebuilt from the same
  feed as each pitcher's count moves (see *PLV Pitcher Game Cards*)

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
Stats game card for every pitcher in every game with Statcast tracking: MLB, Triple-A, the
Florida State League's Hawk-Eye parks, the Arizona Fall League's MLB-park games and the rest
(see *Levels*). Pick a date, then a level (those with cards that day), a game (or every game
that day) and a pitcher; toggle
the comparison to an earlier season (MLB only) and choose which one. The card
is the same one the Streamlit app in
[Blandalytics/player_cards](https://github.com/Blandalytics/player_cards) draws
(`pitcher_game_card.py`), rebuilt as a page: the box-score line and game grade, the Stuff /
Locations / PLV grades, the primary fastball's shape, usage against each side of the plate,
movement with the arm angle and the comparison season's shaded regions, locations against
each side, and the per-pitch-type metrics table. **Share image** rasterises the card at 2x with
the font and logo embedded, to copy to the clipboard or download (a copy downloads where the
browser won't).

### How it works

The cards are data, drawn in the browser. The pipeline writes each pitcher's card as a dict
of numbers into the same R2 bucket as the data files (a season is ~22,000 cards, more than a
GitHub Pages site may hold), and [`pitcher-cards/card.js`](pitcher-cards/card.js) draws it:
one SVG in the original figure's 1500 × 2000 coordinate system, so every panel keeps the
matplotlib layout, with every format and colour decided there. So a change to how the card
looks is a commit to `card.js` and needs no rebuild; only a change to the data does. Both
pages load it as `card.js?v=N` (Cloudflare holds scripts for hours under their exact URL):
bump N in `index.html` and `card.html` with each change.
The picker in [`pitcher-cards/index.html`](pitcher-cards/index.html) draws the card in the
page, and [`pitcher-cards/card.html`](pitcher-cards/card.html)`#<gamePk>-<pitcherId>` shows
one full size (`&cmp=<year>` picks the comparison season, `&cmp=0` none). A card can be
linked in the picker as `pitcher-cards/#<gamePk>-<pitcherId>`, at any level (the index's
`level_games` finds it); `?level=<code>` opens the picker on a level, MLB otherwise. Below MLB
both pages note that PLV and Location are provisional. Either page reads an index from before
the levels as MLB's alone.

The picker's grades table lists every pitcher the Pitcher list offers (the chosen date, level
and game), with his Stuff, Locations, PLV and box-score letters and each pitch type's Stuff+,
as his card shows them, sorted by Stuff from A+ down to F; a header sorts by its column instead
and a name opens that card. A day's rows
come from its card data (the file the card on stage is drawn from), a live game's from the
live index, whose entries carry each card's `skills` and per-type Stuff+ (`stuff`). On a
desktop the two split the window below the picker, the table scrolling in its own box: on a
landscape window the table on the left and the card on the right at the window's height; on a
portrait one the table on top, at most half the height, and the card below in the rest. On a
phone the page scrolls, the card after the table. The table collapses, which gives the card
the window again, and remembers it.

A demo of a **season-long card** is at `pitcher-cards/season.html`, for eight pitchers' 2026
regular seasons (`pitcher-cards/season-demo/`, written by `tools/pitcher_card/season.py` from
the bucket's day files). It is the game card for a whole season, with no comparison season:
the summary line is in segments sized to their text, the same room either side of each, ruled
between: IP, ERA, WHIP, strikeouts, K% and BB% (MLB's season line) and CSW% (from the
pitches); one Skills tile takes the room of Skills and Results, its letters the season means
on `card.js`'s `SEASON_GRADE_CUTS` (`season.py --cuts` fits them as `grade_cuts.py` fits the
game cuts, to every pitcher's season); and Movement shows each pitch type as three KDE tiers
around its densest pitches, ranked by the KDE at each pitch (95%, 63% and 32% of them), each
type on its own Scott kernel widened twice over (seaborn's `bw_adjust=2`) so the edges come
out smooth. The two location plots show 100 of the season's pitches between them, each side's
pitch types by their share of all the pitcher's pitches (30% of them four-seamers to righties,
30 four-seamers in the vs RHB plot; at least one of every type thrown to a side), each type's
at its most common locations: the pitches its KDE puts densest, on one kernel shared by that
plot's types (Scott's rule on all its pitches, their spread pooled within types) so that a
rarely thrown pitch is ranked on the same scale as the rest. A note in each location plot's
outer bottom corner reads "Most common locations" (or, for a pitcher with 100 or fewer
pitches, says all of them are shown).

- [`.github/workflows/pitcher-cards.yml`](.github/workflows/pitcher-cards.yml) runs every
  morning at 10:30 UTC. It clones
  [Blandalytics/statcast_scraper](https://github.com/Blandalytics/statcast_scraper) (the
  pitches) and [Blandalytics/player_cards](https://github.com/Blandalytics/player_cards) (the
  xSLG model) and fetches the pitch-modeling chain from the bucket, then builds a card for
  every pitcher who threw a tracked pitch the day before, at every level with Statcast
  tracking (see *Levels* below). A backfill splits its range into
  months and builds them as parallel jobs; the index is rebuilt from the day manifests once
  they have all finished. A last job writes what the live cards need (below).
- `https://data.blandalytics.com/cards/<level>/data/<date>.json` — that day's card dicts at
  a level, keyed `<gamePk>-<pitcherId>` (about 1.8 MB for a full MLB slate, 320 KB
  compressed).
- `https://data.blandalytics.com/cards/<level>/days/<date>.json` — that day's games and
  pitchers at a level, which the picker lists; each game carries its `level` and `league`.
- `.../cards/index.json` — `levels` (each level's dates, card counts and leagues) and
  `level_games` (gamePk → [level, date]); and, for the picker and the live Worker that read
  them today, the MLB-only `days` and `games` (gamePk → date) of before the levels. MLB's
  cards are also still written to `cards/data/` and `cards/days/`, and the reindex copies any
  MLB day found only there to `cards/mlb/`.
- Before the cards were data, each had a page of its own
  (`.../cards/<gamePk>-<pitcherId>.html`, its manifest entry's `file`), which the picker frames
  until a `force` run rebuilds the day. Once a day is rebuilt its old pages are retired (see
  *Backfilling or rebuilding*): each becomes a small redirect to the card's view,
  `pitcher-cards/card.html#<gamePk>-<pitcherId>`, so a link to one still lands on the card.

### Live cards

While MLB games are on, the live Worker ([`tools/live/`](tools/live/)) builds the cards itself,
from the same feed it polls every 30 seconds: a pitcher's card is rebuilt whenever his pitch
count or his box-score line moves (the box score trails the pitches by a poll or two, and the
runners he leaves on base can score after he's gone), so the picker's **Live** entry is within
a minute of the last pitch (it re-reads the live index every 20 seconds and redraws the card
in place). A game gets one last pass when it ends, at "Game Over" or "Final", whichever the
poller sees first, and leaves the live index once the nightly run has written its permanent
cards.

The Worker can't run the Python, so [`tools/live/src/cards/`](tools/live/src/cards/) is a
JavaScript port of the card's pipeline: `feed.js` reads the feed into the scraper's rows,
`scorer.js` (with `groups.js` and `abs.js`) is pitch-modeling's `score_pitches.py`,
`pitch_groups.py`, `pitch_l1.py` and `abs_2026.py`, `trees.js` evaluates the LightGBM and
XGBoost models, and `build.js` is `build_data.py`, down to its float32 arithmetic. The nightly
job feeds it from the bucket:

- `cards/models/scorer.pack` — the pitch-modeling models and constants, the Level 1
  classifier and the xSLG model in one 17 MB pack (`export_scorer.py`, `model_pack.py`). A
  retrained model goes straight through; changed pitch-modeling code doesn't, because the port
  has to follow it: `export_scorer.py` pins the sources the port matches and refuses to
  publish while they differ.
- `cards/pitchers/<pitcherId>.json` — each pitcher's comparison seasons through the day
  before (`packs.py`): appearances, pitch counts by batter side, velocity and flight time per
  type, and the movement regions. `cards/arms/<season>.json` — Savant's arm angles.

Before publishing the bundle the job checks the port against this pipeline on the previous
day's games (`parity.py`, then `node tools/live/test/card_parity.mjs`): every number on the
card has to match, bar a plus number or grade a hair from a rounding edge (the Python scorer
averages in float32). So a change on either side stops there, with the Worker still on the
last good bundle. One part is approximate by design: the comparison regions, which Python
draws from the season's pitches of the types thrown that day at that day's flight times, are
the season's whole-repertoire regions scaled to the game's (typically within a fifth of an
inch; the nightly card is exact).

The pipeline lives in [`tools/pitcher_card/`](tools/pitcher_card/):

| file | role |
|---|---|
| `card.py` | `pitcher_card(game_pk, pitcher_id)` → HTML string, for a finished game or one in progress; `cards_for_date(date)` → every pitcher that day |
| `fetch.py` | the statsapi live feed (box score, bio, teams), Baseball Savant's arm angles, and `DataStore`: pitches by date from the data files in the bucket, topped up through the scraper for the days the files don't reach yet |
| `prep.py` | per-pitch metrics from the scraper's columns: counts before the pitch, approach angles, break as acceleration, fastball differences, the per-type tables |
| `pitch_model.py` | Stuff, Locations and PLV: the pitch-modeling chain from the bucket, and the scale that turns its run values into the card's numbers |
| `models.py` | expected slugging on contact, the one model still read from the `player_cards` checkout |
| `shapes.py` | the comparison season's movement regions (seaborn's 90%-mass KDE contours) as SVG paths |
| `grades.py` | pitch-type maps, letter grades and both game-score formulas |
| `grade_cuts.py` | fits the Stuff / Locations / PLV letter cuts (`card.js`'s `GRADE_CUTS`) to a target grade distribution |
| `season.py` | the season card demo's dicts, pooled from the bucket's day files, and its season letter cuts |
| `build_data.py` | assembles all of that into one card dict (numbers; `card.js` formats them) |
| `render.py` | a standalone page around one card dict, drawn by `card.js` |
| `build_site.py` | builds a date range into the bucket (or a folder with `--out`) and maintains the manifests; `--reindex` rebuilds the index alone; `--prune-pages` retires the old per-card pages |
| `packs.py` | the live Worker's pitcher packs and arm angles |
| `export_scorer.py`, `model_pack.py` | the live Worker's scorer bundle, and the pack format it is in |
| `parity.py` | real games, carded here, for the Worker's port to be checked against |
| `test/render.mjs` | `card.js` against the SVG the Python renderer drew for three real cards |

### The models

Stuff, Locations and PLV come from the
[pitch-modeling](https://github.com/Blandalytics/pitch-modeling) repo. It is published to
the bucket under `pitch-modeling/` (60 MB, downloaded once and cached beside the data files)
and contains:

* `score_pitches.py`, the scorer, with `pitch_groups.py` and `pitch_l1.py` (the Level 1
  pitch classifier that assigns each pitch type its Fastball / Breaking / Offspeed group)
  and `abs_2026.py` (2026's ABS zone and calls);
* `models/`, the four chained logit models and the classifier (`pitch_l1_v1.npz`);
* `constants/`, the run-value tables, the plus scale and the 2026 ABS adjustment.

Each file is fetched past the CDN's 4-hour cache, so a new publish reaches the next build.

The scorer gives a run value per pitch from the pitcher's side: count-neutral Stuff, what the
location added, and the two together as Pitching, which is the card's PLV.
`constants/plus_scale_constants.json` puts a unit's mean on the card's 100 ± 15 scale, with
2020–26 constants (weighted by pitches × 0.9^(2026 − season)); 2026 games are scored with
the ABS adjustment, as the scale was. The card uses whole outings for the three grades, and one pitch type of
one outing for the plvStuff+ and PLV+ columns. Each grade's letters have their own cut
points, fitted by `grade_cuts.py` to a target share of each letter: every MLB pitcher-game
in the data files is scored as its card is, and the cuts are the pitch-weighted quantiles of
the outings' means (Location's cuts also grade each side of the plate). The card dict
carries the means and `card.js` gives the letters as it draws (its `GRADE_CUTS`), so new
cuts reach every card, past days included, as soon as `card.js` is published; only cards
built before the dict carried the means (version 2) keep the letters they were built with.
The
per-pitch-type colour bins are the 10th, 30th, 70th and 90th percentiles of that pitch
type's 2026 pitcher-games. A pitch the chain does not model — a position player's eephus,
anything missing tracking — simply has no value, and the card shows a dash. Expected
slugging on contact is still the xSLG model from `player_cards`.

The comparison seasons, and the pitches of any settled date, come from the completed-games
Parquet in the bucket (see *Data files*): each file is downloaded once, narrowed to the
columns a card reads and cached, so a cold build of a card is under a minute rather than
four. The days the files don't reach yet — the two most recent — are pulled through the
scraper, as is a game in progress (one game at a time, so a card can be built mid-game). The
only other sources are the game's live feed (box score, bio, team names — one request per
game) and Baseball Savant's arm-angle leaderboard, which the scraper does not cover.
Comparison seasons go back to 2023, as in the app; a season is offered once the pitcher has
three appearances in it before the game.

#### Levels

A level is a Stats API sport code, as in the data files: `mlb`, `aaa`, `afx` (the Florida
State League's Hawk-Eye parks), `win` (the Arizona Fall League's MLB-park games; the other
winter leagues aren't tracked), `rok`, `bbc` (college), `int`, `hsb`. Every level with
tracked games in the data files' manifest gets cards, built the same way, with these
differences below MLB:

- **Graded against MLB.** The pitch models are MLB's and every grade is on the MLB scale,
  by design: a grade measures the pitch against MLB quality, so a minor leaguer's usually
  reads lower (`graded_vs: "mlb"` in the dict; the card shows no label for it).
- **Pitching (PLV) and Location are provisional** (`provisional: ["plv", "loc"]`): the
  scorer isn't calibrated to the minors' strike zones (their ABS zones are fixed per batter,
  the models were fit on MLB's pose-tracked ones) or their parks' elevations. Stuff, which is
  count- and location-neutral, isn't affected. The 2026 ABS adjustment, fit on MLB, is not
  applied.
- **No comparison seasons.**
- **No arm angle**, usually: Savant's leaderboard is MLB's (an MLB pitcher on a rehab
  assignment keeps his).
- The club keeps its own abbreviation, and every postseason round reads *Playoffs*.

A day not yet in the data files is pulled through `tools/data/backfill.py`'s own schedule and
pull, which find any level's games by sportId (MLB still goes through statfast). The live
cards are MLB only.

The code passes `ruff check` and `ruff format` with the config in
[`tools/pitcher_card/ruff.toml`](tools/pitcher_card/ruff.toml), including a McCabe
complexity limit of 5 per function.

### Backfilling or rebuilding

Run the workflow by hand from the **Actions** tab (*Build pitcher cards → Run workflow*)
with a `start` and `end` date, and `levels` to limit it (e.g. `aaa,afx`; every tracked level
by default); tick `force` to rebuild cards that already exist, which is
what you want after changing the data or the models (a change to `card.js` needs only its
`?v=` bump).
A day of games is roughly 150 cards at about half a second each; a whole season runs as one
job per month, four at a time, in under an hour. Cards already in a day's manifest are
skipped, so an interrupted backfill resumes where it stopped. The first run also downloads
each comparison season's data file once (a few seconds per season), after which they come
from the workflow's cache. Tick `all_packs` to rebuild every pitcher's pack rather than the
recent ones (the first run builds every pack it doesn't find). Writing to the bucket needs
the `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `CLOUDFLARE_ACCOUNT_ID` secrets the data
files use.

After a `force` rebuild, set `prune_pages` to retire the old per-card pages: `report` lists
what would happen, `apply` does it. A page whose card is still listed is rewritten as a
redirect to the card's view; a page whose card is not, and every page the old live build
left in `live/cards/`, is deleted; a page a manifest still frames (its day not yet rebuilt)
is left alone. Locally it is `build_site.py --prune-pages [--apply]`.

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

The live port can be checked by hand against any games:

```bash
python tools/pitcher_card/parity.py /tmp/parity --game 822844 --game 823084
node tools/live/test/card_parity.mjs /tmp/parity    # the scores and the card dicts
node tools/live/test/live_cards.mjs /tmp/parity     # the Worker's builds and live index
node tools/pitcher_card/test/render.mjs             # card.js's drawing
```

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
- **Share image** copies or downloads a square 2000 × 2000 image: the box-score line, the pitch-type key, the flow
  as shown (with the ending nodes and their key if they are on), and the Pitcher List Stats wordmark.

A flow is linkable as `sequencing-flow/#<pitcherId>-<YYYY-MM-DD>`.

**Batters** filters the diagram to the pitches thrown to right- or left-handed hitters; the
subheader then reads e.g. *June 12, 2026 @ PHI (vRHH)*, on the page and in the image.

Search a pitcher to open their most recent appearance (falling back to their latest season that
has one) and list the rest of that season; or pick a game date to list everyone who threw a tracked
pitch that day, longest outing first. With both set the page goes straight to that game. With nothing
asked for — on arrival, or after **Clear** — it shows the longest outing of the most recent day
with finished games.

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
`isPointInFill` probes) and use the page's font. The shared image rebuilds the layout at the export size,
lets Plotly rasterise the sankey, and draws the text and labels on the canvas.

| file | role |
|---|---|
| `sequencing-flow/data.js` | manifest, Parquet queries, the live-feed fallback, Stats API lookups, and `buildFlow`: pitches → nodes, links and plate appearances |
| `sequencing-flow/sankey.js` | the chart: the fixed layout, hover / tap tracing, the tooltips, the PNG for Share image |
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
season or to the hitter's own prior season (every xwOBA on the page, as its header says, is
calculated from bat speed, launch angle and spray angle). Pick a season and a hitter (or tick
*Team-wide* and pick a team); *Self (prior year)* subtracts the hitter's previous season instead
of the league. The
boxed numbers are the hitter's share of batted balls in each pull / centre / oppo by ground ball
/ line drive / fly ball / pop up cell, with the row and column shares along the axes (as changes
from the prior season in the self comparison).

A switch hitter's chart is for one side at a time: *Bats* (Left / Right) appears for them, set
to the side they bat from most, and every view and comparison (the prior season included) uses
only the balls hit from the side picked, drawn the way that side faces. Spray is measured from
the pull side of the side batted from, so either side's balls sit against the same league grid.
A hitter counts as a switch hitter when their less-used side has at least 3 batted balls and 5%
of them (a stray ball from the other side doesn't make one).

From 2024, the first season Statcast tracked bat speed from opening day, two more views sit
beside it (neither takes the comparison; the seasons before 2024 don't offer them):

- **xwOBA** swaps the density for the [3D xwOBA model](#3d-xwoba)'s surface averaged over the hitter's
  (or team's) bat speeds on balls in play, and the boxes and axis figures become the model's
  xwOBA of the balls hit into each zone. Its colours run through each outcome's wOBA value —
  white for an out (0), `#2D99C8` for a single (.900), `#54D29B` for a double (1.250), `#FFE066`
  for a triple (1.600), `#F04542` for a home run (2.000) — in ten levels of .200, spread end to
  end as matplotlib's `contourf` spreads a colormap.
- **xwOBA vs MLB** compares where the hitter's xwOBA comes from with where MLB's does from
  swings as fast as theirs: the hitter's batted-ball density with each ball weighted by its
  xwOBA, less MLB's batted balls weighted the same way and reweighted to the hitter's bat
  speeds — the batted-ball chart again, counting value rather than balls, on its levels and
  palette. Each of the hitter's balls hands a weight of 1 to MLB's balls off swings near its
  own (a Gaussian 1.5 mph wide), so every ball is measured against MLB at its own bat speed.
  Measuring them all against MLB at the hitter's *average* bat speed would favour everyone:
  through most swings xwOBA climbs faster the harder the swing (.307 at 64–68 mph, .345 at
  68–72, .404 at 72–76, .463 at 76–80 in 2026), so the average over a spread of swings sits
  above the xwOBA at the average swing — by .009 for MLB against itself, and most for teams,
  whose spread is widest. Matched swing for swing, MLB against itself and the 30 teams
  together come to within .0004 of zero in each of 2024–2026. Both maps are spread with the
  hitter's own kernels (Scott's factor on their points), so the two maps differ only in where
  the balls go and what they're worth: MLB's ~100,000 balls are binned to the grid and spread
  by a table of the kernel at every offset, which takes the page about a third of a second.
  Red is where the hitter gets more xwOBA than MLB's hitters swinging that hard, blue where
  MLB's get more — so a hitter who doesn't produce the pulled fly balls hard swingers usually
  do shows blue there. The boxes and axis figures are each zone's part of the gap, adding up
  to the subtitle's: the hitter's xwOBA on contact less MLB's at the same bat speeds.

Isaac Paredes' current season loads on arrival; a chart is linkable as
`batted-balls/#<season>-<mlbam id>` or `#<season>-<team code>` (the page shows teams by their
full names, Cleveland and Oakland as they were called that season), with `-left` / `-right` (a
switch hitter's side), `-self`, `-xwoba` and `-value` suffixes (an old link's `-continuous` is
ignored). **Share image** copies the figure at 2x to the clipboard or downloads it (a browser
that can't copy an image downloads it instead).

It is the chart [batted-ball-charts.streamlit.app](https://batted-ball-charts.streamlit.app/)
draws ([PLV_viz `batted_ball_charts.py`](https://github.com/Blandalytics/PLV_viz/blob/main/hitter_app/pages/batted_ball_charts.py)),
in its discrete colour scale, rebuilt for the browser with the same geometry, palette (seaborn's
`vlag` bands, at 11 levels rather than 13, their edges at ±1, ±3 … ±9 so the middle band is
centred on no difference) and layout, under the header the Swing Profiles figure
carries — the hitter in the header colour, what the chart shows muted beneath it, and the Pitcher
List Stats wordmark opposite: a Gaussian KDE of the hitter's balls on a 91 × 91 grid over 0–90° of spray by
−30–60° of launch angle, scaled to sum to 100, minus the league's. The hitter's density is
computed in the page exactly as `scipy.stats.gaussian_kde` would (Scott's factor on the full
sample covariance; checked against scipy to floating-point noise); the league's is built ahead of
time. Every view's bands are drawn as Tanaka (illuminated) contours: every contour edge is stroked white
where its downhill side faces a light from the upper left and black where it faces away, thinning
to nothing as the edge turns parallel to the light, so the peaks read as hills.

### How it works

The data comes from the completed-games Parquet in the bucket (see *Data files*) rather than the
app's own files, and is reduced to small JSON files there that the page reads:

- `https://data.blandalytics.com/batted-balls/index.json` — the seasons built, with what each
  covers.
- `https://data.blandalytics.com/batted-balls/<season>.json` — every hitter's regular-season
  batted balls (spray angle in the app's convention — 0° at the pull-side line, 45° dead centre,
  90° at the opposite line, for either hand — and launch angle) in date order, their team and
  usual bat side, a switch hitter's `sides` (the side each ball was hit from, a letter a ball:
  `"LRRL…"`), their stints (`[team, balls]` for each run of balls hit for one team, so a traded
  hitter's balls count for the team they were hit for), the team list, and the league density
  on the grid. From 2024 each ball also carries its bat speed
  and its 3D xwOBA (null for a bunt or an untracked swing), read with the season's calibration
  (see *3D xwOBA*), and the file the league's average of both, its wOBA on contact (hits only)
  and the calibration's multipliers. About 1.5 MB before 2024, 3 MB after (450 / 930 KB
  compressed).
- `https://data.blandalytics.com/batted-balls/xwoba-<season>.json` — the 3D xwOBA model's surface,
  read with that season's calibration, on the same 91 × 91 grid at each of its bat-speed nodes
  (every 3 mph), in thousandths; the page reads a hitter's surface by interpolating between the
  two slices around their bat speed, which is exactly how the model reads between its own nodes.
  650 KB, 240 KB compressed, fetched the first time the xwOBA view is shown for a season.
  `xwoba.json` is the model's own surface, uncalibrated, which the page falls back on.
- [`.github/workflows/batted-balls.yml`](.github/workflows/batted-balls.yml) rebuilds the current
  season every morning at 11:15 UTC, after the data files roll, and takes a `seasons` input for
  backfills, built in the order given and each on the page as soon as it's done (the index is
  rewritten after every season); a season takes about ten seconds, plus, from 2024, the bat
  speeds. The Stats API the
  bucket is built from has no bat tracking, so those come from Baseball Savant's Statcast search
  through `tools/xwoba/savant.py`, a week per request, joined pitch for pitch (Savant numbers a
  plate appearance from 1, the Stats API from 0; 99.8% of balls match). The settled weeks are
  kept in the Actions cache between runs, so the nightly job asks Savant only for the days since
  the last one; a cold season is about thirty requests.

| file | role |
|---|---|
| `tools/batted_balls/build_data.py` | reads a season's files from the bucket, keeps regular-season balls in play with a launch angle and a landing spot, joins Savant's bat speeds and scores the 3D xwOBA from 2024, writes the season file, the surface file and the index |
| `batted-balls/chart.js` | the figure: the KDE, the shares, the contour bands (d3-contour) with their edges lit as Tanaka contours, the colourbar and labels, on a canvas in the app image's 1390 × 1135 pixels at 2x; for the xwOBA view the surface at a bat speed and the zones' xwOBA on the same layout; for xwOBA vs MLB the hitter's and MLB's xwOBA-weighted maps at the hitter's bat speeds and the zones' parts of the gap |
| `batted-balls/index.html`, `app.js` | the page: season, hitter / team, a switch hitter's side, view and comparison controls, the link hash, the download |

In the team-wide chart a traded hitter's batted balls count for the team each was hit for
(a file built before the stints counts every ball for the hitter's last team), and his listed
team is the last he hit for. A hitter needs three batted balls (not all in a line) for a
density; the self comparison needs the prior season built, and reports when the hitter has no
batted balls in it. Locally, `python tools/batted_balls/build_data.py --out batted-balls/data
--seasons 2026` writes the same files under `batted-balls/data/batted-balls/`, and the page reads
them with `?data=data/` (from 2024 it pulls the season's bat speeds from Savant first, cached
under `tools/xwoba/cache/`). After any change to the JavaScript, bump the `?v=` query on the two
script tags in `index.html` so browsers fetch the new files. After a refit of the 3D model
(`tools/xwoba/model.json`), rebuild 2024 on so the balls' xwOBA and the surface file follow it.

## 3D xwOBA

[`tools/xwoba/`](tools/xwoba/) — expected wOBA of a batted ball from **spray direction, launch
angle and bat speed** alone, with no exit velocity: the probability of each wOBA outcome (out,
single, double, triple, home run) on a 3D grid, and xwOBA as their weighted sum with Savant's
weights. It is fit on every regular-season MLB ball in play with bat tracking since bat
tracking began (14 July 2023 to the end of the 2026 regular season, 401,321 balls), which comes from Baseball
Savant's Statcast search: the completed-games Parquet the rest of the site uses is built from
the Stats API, which carries no bat speed. Spray is the Batted Ball Charts page's (0° at the
pull line, 45° centre, 90° the opposite line).

Each grid node fits a kernel-weighted plane through the outcomes of the balls around it, and a
second pass smooths the first pass's residuals and adds them back, so the sharp parts of the
surface (the line-drive peak, the pockets where outfielders stand, the edges of the home-run
band) survive the smoothing. The outcome is the hit (an error or a fielder's choice is an out,
where Savant's `woba_value` gives it a single's .900). Fit on 2023–2025 and tested on 2026, it
explains 36% of the variance in a ball's wOBA value (R² 0.363), level with gradient boosting
on the same inputs and behind Savant's exit-velocity xwOBA (0.452). For hitters it is steadier
year to year than wOBA on contact (r = 0.66 against 0.50). With no term for the season, a
season can read high or low against its own results (2026 by .008 on the full fit), so the
Batted Ball Charts build calibrates each season's outcome mix to its actual one
(`model.calibration`), and the league's xwOBA on contact is its wOBA on contact.

| file | role |
|---|---|
| `tools/xwoba/model.json` | the fitted model: four hit probabilities on a 2° (spray) × 1° (launch angle) × 3 mph (bat speed) grid, read by trilinear interpolation |
| `tools/xwoba/model.py` | the smoother, prediction, and the JSON format (`Grid.from_json(...).xwoba(spray, launch_angle, bat_speed)`) |
| `tools/xwoba/savant.py` | the weekly Savant pulls, cached under `tools/xwoba/cache/` |
| `tools/xwoba/build.py`, `evaluate.py`, `plot.py` | the fit, the held-out evaluation ([`evaluation.md`](tools/xwoba/evaluation.md)), the figure |

The Batted Ball Charts page draws it (the **xwOBA** and **xwOBA vs MLB** views, 2024 on). Method, use, results and
limits are in [`tools/xwoba/README.md`](tools/xwoba/README.md); `python tools/xwoba/build.py
--cv` rebuilds it.

## Release Angles

[blandalytics.com/release-angles/](https://blandalytics.com/release-angles/) — where each of an
MLB pitcher's pitch types leaves the hand, as horizontal (HRA) against vertical (VRA) release
angle: one 1-SD covariance ellipse per pitch type, and how much they overlap. Four views of the
same chart: the outlines alone, **Overlap count** (how many ellipses cover each spot),
**Usage-weighted** (the share of the pitcher's pitches whose type covers it) and
**Concentration** (each exact set of overlapping ellipses — a segment — shaded by the pitches
that landed in it per square degree). **Play loop** cross-fades through the four. **Share image**
copies or downloads the view shown as a 2320 × 2320 still; its menu also downloads the loop as a
GIF, sized for X (Twitter), or the four stills and the loop as one zip. Pick a
season and a pitcher (regular season only, the script's default); *From* / *Through* cut the
season to a date segment. *Options* sets the ellipse size, the
fewest pitches a type needs to be drawn, and the smallest segment the concentration scale
counts. **Overlap numbers** is the script's printed report: per pitch type area, mean depth and
mean share, and the most concentrated segments. Nolan McLean's current season loads on arrival; a
chart is linkable as `release-angles/#<season>-<mlbam id>`, with
`&from=` / `&to=` (ISO dates), `&sd=`, `&min=`, `&seg=` and `&view=type|count|share|segment`.

It is [baseball_snippets `release_angles.py`](https://github.com/Blandalytics/baseball_snippets/blob/main/release_angles.py)
(with the ellipse maths of [`ellipse_depth.py`](https://github.com/Blandalytics/baseball_snippets/blob/main/ellipse_depth.py))
ported to the browser: the same figure geometry, depth / share / segment maps on the same
1100-point grid, colour ramp (stepped through L\*a\*b\*), leaders, titles and four-state loop,
and an overlap report whose per-type table and summary agree with the script's to every
printed digit (checked on Paul Skenes' 2026; segment densities move in the first decimal, since
the tighter frame puts the grid's cells closer together). It departs from the script in five
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
- **The Swing Profiles header.** The pitcher's name in large teal type, what the chart shows
  (season, view, date segment) in a muted line under it, and the Pitcher List Stats wordmark top
  right — Swing Profiles' sizes and offsets, scaled to this figure's width. No rule under it,
  and the footer note set as Swing Profiles sets its note: 10 pt regular in the
  sub-header's muted colour, baselines 7.5 pt × 1.6 apart (scaled the same way).
- **One bottom row.** The footer note and the scale share one centre line, below the chart.
- **No spines.** The degree grid is the only frame.

The GIF is built for X, which re-encodes GIFs as video: 1080 × 1080 (its GIF limit is
1280 × 1080) and all 344 frames at a constant 20 fps (its limit is 350 frames), so nothing rests on
how the re-encode treats long per-frame delays. A frame identical to the one before — the rest of
every hold — is a 1 × 1 transparent frame left over it, so the file is ~3 MB (X allows 15 MB) and
encodes in the browser in about three seconds; it is built once per chart and shared by Download
GIF and Download All.

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
  from memory: a new pitcher is on screen in ~100 ms. The file is rebuilt nightly under the
  same name, so its URL carries the build stamp from `<season>.json` (`?v=<built>`): a browser
  never splices byte ranges of yesterday's file into today's.
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

## Series Win

[blandalytics.com/series-win/](https://blandalytics.com/series-win/) — how often one MLB team
beats another over a series, and how long the series goes. The controls and layout are Swing
Profiles': a season, the higher and lower seed as type-ahead fields (club name, city or
abbreviation; an empty field lists every team, best xWin% first, with its record), **Best of**
(3 to 15) and **Home games** (split, or all in the higher seed's park), then **Simulate**. A
pick from a list, or a change to a select, draws straight away. One card holds both charts —
the higher seed's series win% at every length from a best of 1 to a best of 15, and, for the
chosen length, who wins in how many games — then each team's xWin% (with RS/G, RA/G and
record) and the series win% with its likeliest outcome, the app's summary sentence, and
**Share image** (either figure at 2x, 400 dpi, to copy or download) and **Swap seeds**.
Yankees over Red Sox loads on arrival, best of 7; a matchup is linkable as `series-win/#<season>-<higher>-<lower>&games=<n>`, with `&home=1` for
all home games (teams by MLB abbreviation, e.g. `#2026-LAD-TB&games=7`).

It is [baseball_snippets `mlb_series_win.py`](https://github.com/Blandalytics/baseball_snippets/blob/main/mlb_series_win.py)
(the [mlb-series-win.streamlit.app](https://mlb-series-win.streamlit.app/) app) ported to the
browser: the same model, schedule and two charts. It departs from the script in four places:

- **Swing Profiles figures.** Both charts wear the Swing Profiles figure's template, square: 8 × 8 in at
  200 dpi with its axes box, the matchup as the large teal title over a muted subtitle, the
  Pitcher List Stats wordmark top right, regular-weight axis text and a footer note. Neither has
  gridlines or an x spine. The series win% chart is a teal line with ringed markers and plain
  value labels, over a y axis (`<higher seed> Series Win%`) trimmed to its first and last
  labelled ticks, with a dashed 50% line. The outcomes chart has no y axis at all: team-coloured
  stacked bars (higher seed below) labelled inside, or above the bar in a tag of the team's colour
  when a slice is too thin, and each side's series win% centred over the bars. When the two
  teams' colours look alike (under 30 apart in CIELAB, e.g. Dodgers/Yankees, Red Sox/Angels,
  or a team against itself) the lower seed's slices, tags and key swatch get a faint
  cross-hatch. The footer notes carry the neutral-site single-game chance and who hosts which
  games (`LAD hosts games 1, 2, 5 and 7 (2-2-1-1-1)`). `?style=app` draws the Streamlit app's
  own matplotlib figures instead, laid out in the pixels of its 200 dpi output.

- **Exact, not simulated.** The script plays 100,000 (and 250,000) random series; the page sums
  every path to a clinch, so its numbers are the ones the simulations scatter around (within
  ~0.2 points on Dodgers–Rays) and never change between loads.
- **MLB's standings, any season.** Runs scored, runs allowed and games played come straight from
  the StatsAPI standings (it allows any origin), one request per season, for 2000 onwards,
  rather than from the app's Google Sheet. Team colours are the sheet's, keyed by MLB team id.
- **All home games moves both charts.** In the script the checkbox only changes the outcomes
  chart; here the series win% line follows it too, and both subtitles say `all @<team>`.

### How it works

Each team's xWin% is its Pythagorean win% with the PythagenPat exponent, from runs per game:
`total_runs_factor = (RS/G + RA/G) ^ 0.285`, `xWin% = RS/G ^ total_runs_factor / (RS/G ^
total_runs_factor + RA/G ^ total_runs_factor)`. log5 turns the two into the higher seed's
chance to win one game at a neutral site, `(h − h·l) / (h + l − 2·h·l)` (0.5 for a team against
itself). Home field is worth 4 points either way. A best of 3 is home–road–home; longer series
open 2-2 and then alternate from home (2-2-1, 2-2-1-1-1, …), the script's schedule.

| file | role |
|---|---|
| `series-win/chart.js` | the model (xWin%, log5, schedule, the exact series) and the two figures in both styles (Swing Profiles, the default; the app's, `?style=app`), drawn on a canvas at any scale |
| `series-win/index.html`, `app.js` | the page: season, seed, length and home controls, the StatsAPI fetch, downloads, the link hash |

After any change to the JavaScript, bump the `?v=` query on the two script tags in `index.html`
so browsers fetch the new files.

## Park Factors

[blandalytics.com/park-factors/](https://blandalytics.com/park-factors/) — a Baseball
Savant-style leaderboard of park factors for MLB and MiLB (AAA, AA, A+, A) parks, going into 2027
and for every season the park model covers, plus a week-by-week **Seasonal** view of every level
and season. Filters for **View** (Full season / Seasonal), **Batter side** (All / LHB / RHB),
**Level** (one level or All levels), **Year**, **League** (the level and year's leagues),
**Team** (the level, year, league and org's clubs) and **Org**, plus **Qualified parks**; it opens
on MLB 2027, all batters, qualified parks, sorted by Park Factor. Picking an org
switches Level to All levels, so the whole system shows at once. The Org column is hidden on MLB,
where it repeats Team. All levels adds a Level column,
and every row stays indexed to its own level's average. Any header sorts the table, and
**Reset filters** goes back to the opening view.

**Year** opens on each level's most recent year: 2027 for MLB (the factors centred on the 2027
schedule) and 2026 for the minors; any earlier season can be picked (MLB from 2015, the minors
from 2021), or **All years**, one row per park and season (with a Team or Org, a park's history). On All levels, the most recent year mixes MLB 2027 with the minors' 2026, so a Year
column appears. Past seasons are all batters only, so LHB / RHB switch off for them. Each past
season is indexed to that season's average park at its level, and shows the venue under its name
that season (Miller Park, Safeco Field, U.S. Cellular Field, …) with that season's home club,
league and parent org; 2021's interim minor-league names show as the leagues' current ones
(Triple-A East as IL, High-A West as NWL, and so on).

**Seasonal** shows one level and year's parks week by week, from the park model's seasonal fit.
- **Coverage:** MLB 2015–2027 and AAA, AA, A+ and A 2021–2026.
  - 2027 runs on its schedule (opening week, Mar 25 – Mar 31, through Sep 23 – Sep 26).
  - Earlier seasons come from the games played, so MLB 2020 starts Jul 23 and the minors' 2021
    starts May 4.
- **The fit** adds two curves by date: each level's own calendar (every park together: cold April
  air, summer heat) and each park's deviation from it (a roof-type curve plus the venue's own), one
  shape per park across all its seasons.
- **Controls:** a slider moves through the weeks, with month ticks, and ▶ plays through the season a
  week at a time. Switching the level or year keeps the same date: before that season, the first
  week; after it, the last.

**Compared to** sets the baseline:
- **Season average** (the default): 100 = the average park over the whole season, so the factors
  also carry the league's calendar, e.g. home runs run about 8% below average in early April. This
  is how the park plays that week. The page multiplies each park's same-week index by the league's
  own index that week. An **average** row on top (MLB average, AAA average, …) shows that league
  index: the league that week against its season average.
- **Same week**: 100 = that week's average park, which leaves only the park's own pattern; for
  example, American Family Field plays relatively better in April, before the summer lift
  elsewhere.

The view shows one level and one year at a time, so All levels and All years are off in it, and an
org shows its park at the level picked (MLB by default). Past seasons are all batters, and each
level's most recent year has LHB / RHB, as on the board. The other filters and the sort work as on
the board. The indexes show one decimal, because most parks move only a point or two over a season.
It opens on this week's date when that falls within the season, else on opening week. Each level
and year's data is a separate file, which the page fetches the first time that view is shown.

The filters and sort are linkable: the page keeps them in the hash, leaving defaults out, e.g.
`park-factors/#org=SEA&side=L` or `#level=AAA&league=PCL&sort=HR&dir=desc` (keys `side` = `L` /
`R`, `level` = a level or `all`, `year` = a year or `all`, `league`, `team`, `org`, `qual=0`, `sort` = a column header,
`dir` = `asc` / `desc`; the Seasonal view adds `view=seasonal`, `wk` = the week's first day as
`MM-DD` and `base=week`, e.g. `#view=seasonal&level=AAA&year=2024&wk=07-15&sort=HR`). With an org
in the link, the level defaults to All levels (MLB in the Seasonal view). Unknown
values fall back to the defaults, and **Copy link** copies the current address. **Download CSV**
saves the table as shown (filters and sort applied, with Level, Year and Side columns always
included) as `park_factors_<year>_<level>[_<org>_<league>_<team>_<side>HB].csv` (`most-recent` for
the year on All levels' default, `all-years` for All years). In the Seasonal view, the CSV adds
Week and Compared to columns, and the name adds `_seasonal_wk<MM-DD>_vs-season` (or `_vs-week`).

Every column is an index where 100 is that level's average park: Park Factor (wOBA), R
(BaseRuns), OBP, AVG, 1B, 2B, 3B, HR, BB, K, HBP, BACON (hits per contact, HR included), wOBACon,
and HR p10 / p90 (the HR index's 80% interval), then Games and PA. The index columns are shaded
on one diverging scale centred on 100 and saturated at 90 and 110: red helps hitters and blue
hurts them, so K runs the other way (more strikeouts shade blue). The CSVs keep the model's
names for two of them: AVG is `H` and K is `SO`.

**Qualified parks** keeps venues with more than 50 games, pro-rated to each row's level's home
schedule and rounded to the nearest game: MLB 50 of 81, AAA 46 of 75, AA 43 of 69, A+ and A 41 of
66. A past season pro-rates to its own median games per venue, so short seasons scale down (MLB
2020: more than 19; the minors' 2021: 37 to 40). MLB 2027 games are the 2027 schedule's at each venue (neutral
sites included, so Las Vegas Ballpark's 6 and Field of Dreams' 1 drop out); every other year
counts the venue's completed regular-season games that season.

**Neutral sites** are credited to League. A venue with fewer games at a level that season
than a tenth of a full home schedule (the same full schedule as the qualifying cutoff: under 8.1
MLB games, under 7.5 AAA games, and so on) is no club's home. Its Team and Org show League instead of the club that was home in those
games. Examples: London Stadium, Tokyo Dome,
Gocheok Sky Dome, Estadio Alfredo Harp Helú, Estadio de Beisbol Monterrey, Hiram Bithorn Stadium,
Field of Dreams, Rickwood Field, Bristol Motor Speedway, the Little League Classic's Williamsport
park, and the Athletics' six games a year at Las Vegas Ballpark (which stays LV / ATH at AAA). The
Blue Jays' 2021 homes, Sahlen Field and TD Ballpark, keep TOR. `build_leaderboard.py` applies
this (`NEUTRAL_SHARE`, `NEUTRAL`), so the CSVs keep StatsAPI's home club. League comes right
after the All option in the Team and Org lists, and picking it lists the neutral sites. They are hidden while Qualified parks is on.

The factors come from the projection system's park model: one joint Bayesian fit of every plate
appearance (MLB 2015–26, the full-season minors 2021–26) with batter, pitcher, league-season,
home-field and platoon terms, a venue factor that drifts across seasons with breaks at known
dimension changes, and a venue left/right split. Factors are full (not halved) and adjusted for
who batted and pitched there.

| file | role |
|---|---|
| `park-factors/index.html` | the page, with the leaderboard data inlined; besides the fonts, it requests only the Seasonal view's files |
| `park-factors/seasonal/<level>_<year>.json` | the Seasonal view, one file per level and year (A+ as `Aplus`; 37 files, 2.6 MB; 50–180 KB each). Each file holds the weeks (first day, last day, label) and the page's index columns as 10 × the index, per batter side, for each venue under the board's name for that level and year, plus the league row (the league that week against its season average) |
| `tools/park_factors/park_factors_2027.csv` | the data: one row per level, batter side (`All`, `L`, `R`) and venue, with every column on the page and the date the factors were generated (`As Of`) |
| `tools/park_factors/park_factors_history.csv` | every season before each level's most recent: one row per level, year and venue (all batters), with the season's venue name, League, Team, Org and Games added from StatsAPI, and the StatsAPI `venue_id` |
| `tools/park_factors/build_history.py` | writes that file from the park model's `park_factors_history.csv` (index columns, PA and StatsAPI venue ids): each row's venue name, home club (most games there that season), league, org and completed-game count come from that season's StatsAPI schedule and teams. Responses are cached in `tools/park_factors/cache/` (not committed); it checks its 2026 minor-league rows against the board's |
| `tools/park_factors/build_seasonal.py` | writes the Seasonal view's files from the park model's `park_factors_seasonal_weekly_2027.csv` (MLB 2027) and `park_factors_seasonal_history.csv` (every earlier level and season). It names each park as the board does: by name for each level's most recent year, and by `venue_id` from the history CSV for earlier years. It fails if a board park has no seasonal data, or a seasonal park has no board row |
| `tools/park_factors/build_leaderboard.py` | builds the page from both CSVs, and lists the years that have Seasonal files; `--from-md` first rewrites the board CSV from the park model's handoff markdown (every table in its section 10) |
| `tools/park_factors/build_tile.py` | the homepage tile, from the CSV: the top and bottom seven qualified MLB parks as a heatmap in the Pitcher List Stats figure style, laid out as HTML, screenshotted at 900 × 900 by headless Edge and saved as `images/tile-park-factors.webp` and `-720.webp` |
| `tools/park_factors/tile_logo.png` | the Pitcher List Stats wordmark for the tile, cropped from the Series Win tile |

### Updating

```
python tools/park_factors/build_leaderboard.py                       # page from the committed CSV
python tools/park_factors/build_leaderboard.py --from-md path/to/park_factors_2027.md   # new factors
python tools/park_factors/build_history.py path/to/park_factors_history.csv   # then rebuild the page
python tools/park_factors/build_tile.py                              # homepage tile from the CSV
```

For new seasonal factors:
1. Run `python -m src.model.parks --seasonal-table 2026` in the projection system. It writes both
   files to `data/projections/2027/`.
2. Run
   `python tools/park_factors/build_seasonal.py path/to/park_factors_seasonal_weekly_2027.csv path/to/park_factors_seasonal_history.csv`.
3. Rebuild the page, so it lists the years.
4. Rebuild League Factors (below), which reads the same files.

The handoff markdown and the model's history file stay with the park model; only the CSVs
built from them are committed. After
rebuilding the tile, bump its `?v=` in `index.html` so Cloudflare serves the new image.

## League Factors

`league-factors/` charts each level's run environment week by week, from the same park model:
the model's calendar curve (the Seasonal view's league row: the level's curve with the same
batters and pitchers all season, plus the parks in use that week) against what each week
produced. 100 is the level's season average. It covers MLB 2015–2027 (2027 on its schedule) and
AAA, AA, A+ and A 2021–2026. A level, a year (or All years), a stat and the week slider pick the
view (**Reset filters** goes back to MLB, All years, Runs and opening week): a chart of that stat (the model line, the actual weeks as dots sized by plate appearances,
and in All years their average by date) and a table of every stat by week (Model or Actual,
colored as on Park Factors). **Share image** copies or downloads the chart on screen as a
900 × 900 PNG in the homepage tile's style (the title "<level> <metric> Factor" over "<years>, by
Week", the Pitcher List Stats wordmark, the key and "100 = <level> Season Average"), drawn on a
canvas in the browser.

| file | role |
|---|---|
| `league-factors/index.html`, `app.js` | the page; it loads `data.json` and the fonts only (and `logo.png` for Share image) |
| `league-factors/logo.png` | the Pitcher List Stats wordmark for the shared image, a copy of `tools/park_factors/tile_logo.png` |
| `league-factors/data.json` | per level and year: the weeks, the model's indexes and (past years) the actual indexes, games and PAs of each week, as 10 × the index (150 kB) |
| `tools/park_factors/park_factors_calendar_observed.csv` | the actual weeks, from the park model's `parks.calendar_observed` (every level, season and week: that week's PAs against the season's, unadjusted) |
| `tools/park_factors/build_league_factors.py` | writes `data.json` from the Seasonal view's files and that CSV. It fails if the two disagree on a level-season's weeks |
| `tools/park_factors/build_league_factors_tile.py` | the homepage tile, from `data.json`: MLB wOBA by week as the page's All years chart draws it (the model curve, the actual weeks of 2015–2026 and their average), in the style of the Park Factors tile, screenshotted at 900 × 900 by headless Edge and saved as `images/tile-league-factors.webp` and `-720.webp` |

To update, after new seasonal factors (`--seasonal-table` also writes
`park_factors_calendar_observed.csv`):

```
python tools/park_factors/build_league_factors.py path/to/park_factors_calendar_observed.csv
python tools/park_factors/build_league_factors_tile.py    # then bump the tile's ?v= in index.html
```

## Model Drilldown

[blandalytics.com/model-drilldown/](https://blandalytics.com/model-drilldown/) — why a pitch grades
the way it does. Pick a season, a pitcher and a pitch type, then a model (Stuff+, count-neutral; or
PLV+, which adds location and count) and a target: the plus score split by feature (*Stuff+
(features)*, the default) or by outcome (*Stuff+ (outcomes)*), the model's pitch type ERA
(*Stuff ERA* / *PLV ERA*), any of the nine outcome probabilities, or wOBAcon. The controls are Swing Profiles'. Jacob Misiorowski's 2026 four-seamer
loads on arrival.

*Location+* (the third model) is PLV minus Stuff at the actual count, from
`units_location_<season>.parquet`. It is split by outcome only, so its one target is *Location+ (outcomes)*:
the nine `rv_<outcome>` rows are location's change in each outcome's probability × its run value at
the pitch's count, and sum exactly to Location+ − 100. The sub-labels give that change (`dp_<outcome>`,
pp, vs the league's), and the league card and beeswarm plot each run value against it. There is no
Sankey for Location (it has no feature SHAP).

*Stuff ERA* / *PLV ERA* is the tables' `era` target (`model_era.py --by pt`, runs per 9: a season
constant − 9 × run value per pitch × modelled pitches per inning), split by feature like the other
targets. Its reference line is the season's league ERA, lower is better (gold), rows under 0.05 runs
fold into Other, and the `calibration` column goes into Other too, as the card draws it.

*By outcome* is `shap_values_card.py --by outcome`: the plus score as 100 plus the nine
`rv_<outcome>` rows (each outcome's predicted rate × its average run value, in plus points vs the
league), plus *Count Leverage* for PLV, which prices outcomes at the pitch's actual count. It is an
exact split with no proxy, and every outcome is shown (nothing folds into Other). The league panel
and the beeswarm then plot each outcome's run value against the unit's predicted rate of it. In
the figures the score is only ever named *Stuff+* / *PLV+*; *(features)* and *(outcomes)* appear
only in the Target menu.

Three figures, in the Swing Profiles card colours:

- **The drilldown.** The card drawn by `card.js`, 16:9 on a navy ground: the pitcher, pitch type
  and season over three tiles, with the KPI alone in the top right corner. On the left, **Pitches**:
  a pill per pitch type, as tall as its share of the pitches; click one to switch pitch types. In
  the middle, the chosen pitch type's SHAP waterfall, as `shap_values_card.py` draws it (the same
  rows, folding, gold/teal bars and connectors), from AVG to the final value: at most the eight
  largest rows (`MAX_ROWS` in `data.js`), the rest in Other, unless *Show every row* is on. On the
  right, the selected row (click any row) against the league: each dot is another pitcher's version of the
  pitch, with its mean input on x and that row's value on y, the binned mean as a white line (the
  dependence plot of `shap_analysis.py`, per unit rather than per pitch); under it, the row's input
  and its impact on the target, each with its percentile (the best change for the pitcher is the
  100th). Location and Count plot their two inputs against each other, coloured by the row's
  value. Hover a dot for the pitcher; click it to open them. Changing any input morphs the card
  from one draw to the next. The three numbers below carry Swing Profiles' league KDEs: the value,
  the biggest lift and the biggest drag. On a desktop or laptop the card scales to fit the page's
  width and the screen's height (less 40 px); **Share image** gives it at 2560 × 1440. On a phone
  (600 px or narrower) the page shows only the waterfall (in the card's style: its navy ground and titled tile, its bars,
  lines and row labels), drawn at the screen's width with static
  rows, and the three numbers with their KDEs: no league card, beeswarm or Sankey (**Share image**
  still gives the full card).
The next two are hidden for now (`SHOW_LEAGUE_FIGS` in `app.js`): their cards stay hidden and
they are not drawn.

- **Against the league.** A beeswarm of every row's SHAP over the comparison group, coloured by
  each unit's input, with the pitcher marked.
- **Where the probability goes.** A Sankey of the nine outcome probabilities. They sum to 100%, so
  each row's SHAP takes probability from some outcomes (left) and gives it to others (right).

Hovering a row anywhere lights it in all three figures and fades the rest, the way Sequencing
Flow traces a plate appearance. Hovering a dot names the pitcher, and clicking it opens them.
*Compare with* sets the league group (same pitch type, same pitch group or every pitch type) and
*Min. pitches* its floor. **Share image** copies or downloads each figure at 2x with the font and
the wordmark embedded (a copy downloads where the browser refuses the clipboard); the CSV holds the
unit's rows for every target. A view is linkable as
`model-drilldown/#<season>-<pitcher id>-<pitch type>&model=plv&target=p_swinging_strike&row=velo`
(`&vs=group|all` for the comparison group).

**Transitions** follow Sequencing Flow's Plotly sankey (`Plotly.react`: 500 ms, linear). When any
input changes, whatever persists moves and resizes from its old place to its new one: bars, bands,
nodes, axis ticks, the league panel and each pitcher's dot in it, and the numbers count across. The
ribbons are redrawn at their new shape and fade in, new elements fade in, and removed ones fade out
where they were. `model-drilldown/morph.js` does this for any two SVGs by matching `data-m` keys
and tweening every number in their geometry attributes.

### How it works

Nothing is built for the page: it reads the tables that stuff_model's `shap_values.py` publishes
to the bucket's `shap-values/` folder (`publish_shap_values.py`), with
[hyparquet](https://github.com/hyparam/hyparquet):

- `https://data.blandalytics.com/shap-values/unit_features_<season>.parquet`: the pitcher list,
  pitch counts and mean inputs (0.6 MB). It is read first, so the controls fill quickly.
- `.../units_<model>_<season>.parquet`: one row per pitcher × pitch type × target, with
  `exact = league + baseline + Σ feature SHAP + residual`, and the `rv_<outcome>` rows the outcome split reads (13–17 MB). Each file is a single row
  group, so a season × model is read whole, once, and every later pick is instant. The other
  model's file is fetched in the background after the first draw.
- `.../meta.json` (feature lists, labels) and `.../fidelity.csv` (each proxy's held-out R², shown
  under the figure).

The URLs carry an hourly `?v=` so a republish reaches browsers within the hour, despite the zone's
four-hour browser cache.

| file | role |
|---|---|
| `model-drilldown/data.js` | reading and indexing the tables; the card's rows, labels, detail formats and folding (`shap_values_card.rows_for`) |
| `model-drilldown/charts.js` | the three figures as SVG, their hover lookups, and the PNG export |
| `model-drilldown/morph.js` | the Plotly-style transition between two renders of a figure |
| `model-drilldown/index.html`, `app.js` | the page: controls, the linked focus, tooltips, downloads, the link hash |
| `model-drilldown/card.js` | the page's desktop drilldown, a 16:9 card (`cardSvg(ctx)`, from app.js's `view`): pitch type pills, the waterfall, the selected row against the league, the KPI in the corner; morph keys, and the league dots' hover lookup (`nearestCardPoint`) |
| `model-drilldown/package.json`, `eslint.config.mjs`, `.prettierrc.json` | the lint and format tooling (the page never loads them) |
| `model-drilldown/card-demo.html` | a demo of the card from the live Stuff+ tables (Brody Hopkins' 2026 four-seamer by default; linked like the drilldown, `#<season>-<pitcher id>-<pitch type>&model=plv&target=wobacon&row=<row>`, any target split by feature), or from made-up numbers at `#synthetic`; click a row or a tab, **Share image** gives it at 3x |

Locally, copy the staged tables (`stuff_model/build/shap-values/`) to `model-drilldown/data/shap-values/`
and open the page with `?data=data/`. After any change to the JavaScript, bump the `?v=` query on the
module imports in `index.html` and the `.js` files so browsers fetch the new files.

The code is linted with ESLint (its recommended rules, for browser modules) and formatted with
Prettier (120 columns, single quotes). There is no build step; `package.json` holds only the tooling.
In `model-drilldown/`, run `npm install`, then `npm run check` (lint plus a format check),
`npm run lint` or `npm run format`.

## MLB Auction Calculator

[blandalytics.com/auction-calculator/](https://blandalytics.com/auction-calculator/) — auction
dollar values for every projected hitter and pitcher, priced for a league's settings. The sidebar
holds a **League format**, which fills in a site's default teams and lineup slots (below; editing
any of them makes it Custom); lineup slots per team for C, 1B, 2B, 3B, SS, CI, MI, OF and UT, and for
SP, RP and P; **Position eligibility**, the games a player needs at a position to play it (GS and G
for hitters, SP GS and RP G for pitchers; Yahoo's by default; below); **Bench spots**, **Minimize bench value**; **League type** (Categories or Points),
**Teams**, **Min bid**, **Team budget**, **Categories format** (Roto, Head-to-head or H2H all-play,
with **Weeks** for the H2H formats), **Player pool** (All, NL-Only, AL-Only), **Lineup lock** (Daily,
Bi-weekly on Mondays and Fridays, or Weekly; below), **Two-way players** (Split, Simultaneous or One
slot; below), the **Hitter split
(%)** (65 in categories and 50 in points, as the script has it, or **From the values**, which shows
the split the values make in the box) and **Include free agents**; the scoring, as category
toggles (5x5 roto by default) or editable points tables; and two collapsed sections:
**Projections**, optional hitter and pitcher projection CSVs (it opens itself if the defaults don't
load), and **Valuation details**, the **Replacement span**, the **Dollar curve**, **Fill missing
playing time**, **Specialist correction** and the noise placeholders (**Count noise φ**,
**Playing-time CV**). A
setting's small print is in the tooltip on its ⓘ (on hover, keyboard focus or a tap). Any change
reprices at once. The table beside it is every player by auction dollars, with the stats grouped
under Hitting and Pitching; a **Slot** column says where each drafted player plays, BN for the
bench. Each scored stat's cells are shaded by what that stat adds to the player's dollars (the
same dollars as its column in the value breakdown), on its column's own scale: no shade at or
below its drafted players' median, rising to the Auction $ green at their top 5% (the text switches
to dark where it needs to, keeping 4.5:1). Each cell's tooltip gives the dollars, and a key sits
over the table. Over it, a row of **Position premiums** says what each position is worth over its
side's deepest one. Any header sorts the table, a search box and position filter narrow it, and
**Download CSV** saves the whole table in the script's layout (a stat both sides score is suffixed
`_h` / `_p`). **View** switches the stat columns for a **Value breakdown** of each player's dollars
(below), and the CSV follows it. Settings are kept in the browser between visits; **Reset all
settings** clears them. The chevron at the top of the sidebar folds it away, to a slim rail beside
the table (a bar over it on a phone), and it stays folded between visits.

It began as [plv_viz `auction_calc.py`](https://github.com/blandalytics/plv_viz/blob/main/auction_calc.py)
(the PL Auction Calculator Streamlit app) ported to the browser, and it still reads projections as
the script does and starts from its z-scores (`tools/auction_calculator/` runs the script itself
on the same CSVs and compares every player's start value). From there it values players by
standings gain, the generalized SGP procedure (no league history needed), and prices them its own
way:

- **SGP, not z-scores.** A z-score divides by the spread of player stats, which isn't tied to
  standings. The page weights each category by the standings points one more unit buys a team,
  from the spread of team totals (below).
- **Rate stats as counts.** The script regresses each rate toward the league; the page counts what
  a player adds above the drafted pool's rate (hits above it, earned runs saved below it), so a
  rate carries its playing time.
- **Playing time.** What a player doesn't play is filled with replacement production for his role.
- **The split.** The script splits the dollars 65/35 (50/50 in points) by fiat, and so does the
  page by default; **From the values** lets the values set it instead, at one price per SGP on
  both sides.
- **Drafted players and dollars.** The script prices every player at min bid + value × dollars per
  value, then scales every positive value to the budget, so neither the number of players at $1+
  nor what they cost matches the league. The page drafts exactly the players who fill every team's
  legal roster: exactly `teams × roster spots` come out at $1+, for exactly `teams × budget` (less
  a minimized bench's min bids).
- **Replacement by lineup slot.** The script prices catchers against catchers, every other hitter
  in one pool and every pitcher in another. The page sets a replacement level for every position,
  SP and RP included, from the league's best lineups, so scarcity comes from the projections and
  the roster, not a fixed order.
- **Default projections from the bucket.** `https://data.blandalytics.com/projections/hitters_auction_ev.csv`
  and `pitchers_auction_ev.csv`, not the app's Google Sheet, with `position_eligibility.csv` beside
  them; `?data=<base>` reads all three from elsewhere.
- **Team abbreviations.** The All pool keeps every player whatever their team (the script drops a
  team it doesn't know), and AL/NL-Only also knows `TB`, `SD`, `SF`, `KC`, `WSH`, `CWS` and `AZ`.
  A blank team, `FA` or `- - -` is a free agent.
- **Positions from games.** The script takes the projections' `Y! Pos`; the page sets each
  player's positions from last season's games by the league's eligibility rules (below), and the
  table shows SP / RP rather than `P`. The dollar column sits by the name so it stays on screen on
  a phone.

### How it works

Each side (hitters, pitchers) is valued on its own, from the script's z-scores (or points) as a
start, then in passes until it settles:

1. **The drafted pool**: the league's lineup slots (plus half the bench each side unless it's
   minimized) filled for the most value, below.
2. **Rate stats as counts** against the pool's own rate: `xH = H − r·AB` for AVG,
   `xER = r·IP/9 − ER` for ERA, `xWHIP = r·IP − (BB+H)` for WHIP, and the same for OBP, SLG, ISO,
   K%, BB%, K/9, BB/9, HR/9, K-BB% and K/BB, from the components when the file has them
   (`r·PA × rate` for OPS and wOBA). Never the all-MLB rate, which counts players nobody drafts.
3. **Playing time**: what each player doesn't play is filled with replacement production for his
   role (C or other hitter; SP or RP, by starts): the per-PA (per-IP) output of the players a tier
   (N) either side of the role's cutoff, ranked by their own projections, up to the role's 90th
   percentile among drafted players. That production is set once, from the side valued without any
   fill, then held: set from the filled values, the cutoff fills with part-timers whose rates no
   free agent supplies over a season, and the pool and the fill chase each other.
4. **The draft's spread** (σ²_draft): the pool in draft order cut into tiers of N (one player per
   team, as a snake draft deals them), and each tier's variance added up; catchers are a tier list
   of their own when the league has catcher slots, and a flex slot group (P) is one list.
5. **A season's luck** (ν): each drafted player's outcome variance, summed and divided by N. From
   the projections' 10th and 90th percentiles where the file has them (`HR_p10`, `HR_p90`, …: SD =
   (p90 − p10) / 2.563; for a rate stat, the rate's spread times its denominator, plus the playing
   time's); elsewhere count noise φ × the count plus (CV × the contribution)², with each player's CV
   from his PA/IP percentiles when there are some. φ = 1 and CV = 0.15 are placeholders until
   they're fit to projection errors. No strategy term (τ² = 0), so SB and SV may weigh a little
   heavy.
6. **The weights**: `G = C / (2√π · √(σ²_draft + P·ν))` standings points per unit, with C
   comparisons per category and P scoring periods a season: roto N − 1 and 1, head-to-head W and W,
   all-play W·(N − 1) and W weeks. The SGP denominator is `D = 1 / G`. Points leagues skip this: a
   point is the unit.
7. **SGP** is Σ G × contribution; **SGP above replacement** subtracts the player's position's
   replacement level (below), category by category. In roto, a category more than half a
   standings SD over replacement gains on a curve instead of a line (the **Specialist
   correction**): `(N − 1)(Φ(Δ / (√2 σ)) − ½)`, so 50 SB over replacement at σ = 27 is 4.4 SGP,
   not 5.7.

The passes stop when the pool doesn't change and no denominator moves 1%; a pool that only swaps
marginal players back and forth with weights within 3% has settled on the mean of its states; after
20 passes, the mean of the last two (the page says so). On the 2027 projections (as of October 13)
the Yahoo format settles in 4 passes for hitters and 3 for pitchers, in about 0.2 s. Its
denominators: R 22.6, HR 10.1, RBI 23.9, SB 11.3, AVG 13.4 hits; W 4.3, SV 9.7, K 59.4, ERA 10.9
earned runs, WHIP 16.9 walks + hits.

**Dollars.** The drafted players are the ones that fill every team's legal roster: each side's
lineup slots, plus half the bench each (as BN slots anyone fits) unless **Minimize bench value** is
on, filled for the most SGP above replacement. That's `teams × (hitters + pitchers + bench)`
players, or `teams × (hitters + pitchers)` with the bench minimized. Every roster spot's min bid
comes out of the budget first, bench included: a minimized bench is still drafted, at the min bid,
just not priced. Every drafted player gets the min bid, the last drafted on each side exactly that,
and the rest of the budget goes to hitters and pitchers by the **Hitter split**, then out on each
side along the **Dollar curve**: a player's dollars above the min bid are `k × u^γ`, where `u` is
his SGP above the side's last drafted player and `k` is set so the side spends exactly its dollars.
So exactly the drafted players are at the min bid or more, together they cost `teams × budget` (less
`teams × bench × min bid` for a minimized bench), and the hitters get exactly their share of the
dollars above the min bids. With γ = 1 the curve is a straight line, one price per SGP; the
research handoff's mildly convex curve is the default, γ = 1.05, where stars cost more than a
straight line gives them (the top player about 5% more) and the middle rounds a little less. It
keeps the player order, and the last drafted player on each side still gets the min bid. **From the
values** puts both sides on one curve instead, so the split is the values' own. A player no legal
roster has room for (a 13th catcher when nothing else takes him, say) stays under the min bid; a
player below the last drafted one is priced at his side's average dollars per SGP, since the curve
starts at him. On the 2027 projections (as of October 13) the Yahoo format (bench minimized)
prices its 216 lineup players for $3,060 (12 × $260, less 60 bench spots at $1). At the default
65/35 and γ = 1.05, Pete Crow-Armstrong is first at $75.87 ($71.94 on a straight line) and Tarik
Skubal the first pitcher at $53.80, at an average $13.88 per SGP for hitters and $8.92 for pitchers.
The values make it 54/46 (Skubal first at $69.82); without the playing time fill, 63/37. The fill moves value to part-timers with good
rates (Byron Buxton, Luis Robert Jr., closers) and away from full-time players near replacement
rates (Bo Bichette, Luis Arraez, back-end starters).

**Value breakdown.** A player's dollars split exactly into: **Min bid**; **Baseline** (less the last
drafted player's SGP above replacement); **Position**, his
position's premium over his side's deepest one; **Playing time**, the replacement production filled
in for the time he doesn't play; **each stat**, what it adds over the deepest position's replacement
in his own playing time; **Specialist**, the roto curve's correction; **Lineup lock**, what a
binding lock takes from an SP; **Two-way**, a one-slot two-way player's pitching less the hitting he
gives up for it; and **No spot**, shown only when it isn't zero, what holds a player no legal roster
has room for under the min bid. Each part
is at the player's own dollars per SGP along the dollar curve (`k × u^(γ − 1)`), so they add back up
to the dollars to the cent for every player.

**Lineup locks** (the research bundle's lineup-locks spec, Tasks 1–4, capture-factor method). With
daily lineups a team starts whichever SPs pitch that day. With weekly ones, or Monday/Friday ones,
it sets its SPs for the window, and when more of its rostered SPs start in a window than it has SP
spots, some starts sit on the bench. A typical team's SPs come from the pitchers valued without the
lock: `S`, the SPs in its lineup (SP spots and the P spots SPs take), and `nSP`, those plus the SPs on
its half of the bench, minimized or not, since teams roster them either way. The slots bind when
`K > S` for `K ~ Binomial(nSP, q)`, with `q` the chance one SP starts in the window (0.17 for a day,
0.50 / 0.67 for the 3- and 4-day halves of a Monday/Friday week, 0.95 for a week, in a 5-man
rotation). Under 5% of windows, nothing changes; otherwise each SP keeps a share of his value above
replacement by tier (ace, good, mid, low: the top 15%, next 25%, 30% and 30% of rostered SPs by
value per start; undrafted SPs are low) and bench depth (`nSP − S`, 1 to 3), from the spec's
simulations: weekly 0.97 / 0.95 / 0.92 / 0.88 with one bench SP down to 0.91 / 0.87 / 0.81 / 0.69
with three; Monday/Friday 0.93 to 1.00. The league's pitching shrinks with it: each SP's line counts
at his share in the pool rates, the draft's spread and a season's luck, so the SGP denominators move
too (weekly locks cut team innings about 14% in the spec's simulations), which raises pitchers
against hitters when the split comes from the values. The shares are set once, from the side valued
without the lock, and held. On the October 13 projections the Yahoo format rosters 8 SPs for 6
spots: weekly, they bind in 94% of weeks and SPs keep 78–94%; Monday/Friday, in 12% of windows, and
SPs keep 97–99%. The lock's ⓘ says what it does in
the league on the page, and an SP's position tooltip his tier and share.

**Two-way players** (the same spec, Task 6). A player in both projection files under one MLBAM id
(Shohei Ohtani) is valued by how the league uses him. **Split**, the default, lists him as two
players, as Yahoo does. **Simultaneous** (one player in a hitter spot and a pitcher spot, both lines
counting) values both rows on their own sides and shows him as one row, at both rows' dollars.
**One slot**: one player in one spot, hitter or pitcher, switched whenever lineups lock (the
**Lineup lock**), each lock window taken as whichever it's worth more as, its hitting or its starts.
Daily, that's the spec's one-slot daily rule: he pitches his start days when a start is worth more
than a day's hitting, so he's his hitting less those days (`H × (1 − starts/162)`, about 13% for
Ohtani's 21 starts) plus all his pitching. Weekly, it's the spec's one-slot weekly rule, and
Monday/Friday switches at each 4- and 3-day half. A window's games and his starts in it come from
the spec's schedule simulation in closed form (a turn every 6 team games, or 5 past 27 starts, in a
182-day season with 20 off days, turns skipped to his projected starts: about 6% of weeks have 2
starts); a 1-day window gives the daily rule exactly, and a below-replacement hitter sits rather
than hits. The more often lineups lock, the more he's worth. In a one-slot league he's in the hitter pool at that
combined value and his pitcher row leaves the pitcher pool, so each side still drafts its spots and
spends its dollars; his pitching counts at the pitchers' dollars per SGP, since the hitter split can
make a pitcher's SGP cheaper than a hitter's, and his windows are chosen in those units, so he's
never worth less than his hitting alone. The roster spot he frees (the spec's `b`) adds nothing: its
best bench use is a replacement player, 0 above replacement here. In the default league (October 13
projections) he's $55.84 as a hitter and $24.06 as a pitcher, $79.90 simultaneous; one slot, $72.68
under daily locks, $58.16 under Monday/Friday ones (78% of his hitting, 60% of his pitching), and
$55.87 under weekly ones, where he pitches only the weeks his starts are worth more than his hitting
(11% of his pitching).

**Position eligibility.** Positions come from last season's games, in
`https://data.blandalytics.com/projections/position_eligibility.csv`: games (G) and games started
(GS) at C, 1B, 2B, 3B, SS, OF and DH, and as a pitcher, for every player who played (by MLBAM id).
A hitter qualifies at each fielding position where he has the **GS** or the **G**; a pitcher at SP
with the **SP GS** and at RP with the **RP G** relief appearances (games less starts). The defaults
are Yahoo's, from its help page: 5 starts or 10 games at a position, 3 starts for SP, 5 relief
appearances for RP. A blank box skips that test (20 games alone, say). One short everywhere goes
where he played most (games, then starts; UT when that's DH, SP or RP by which he did more of), as
Fantrax does; Yahoo's help doesn't say. A player the file doesn't have, a prospect or a player who
missed the season, or one in it who didn't play on that side, keeps the projections' `Y! Pos`, and
so does everyone if the file doesn't load (the page says so). An uploaded projection file is
matched by its `MLBAMID`. The legend says which season's games the positions come from, and each
player's position tooltip the games behind his positions. The file's own `Y! Pos` (Yahoo's positions
this season, which carry the season before over) backs the defaults up: Yahoo's thresholds never
give a position it doesn't list, over 1,472 players, and loosening any of them by one does (GS 4
adds 16, G 9 11, SP GS 2 21, RP G 4 18). On the October 13 files, 631 projected hitters and 775
pitchers have 2026 games; at Yahoo's thresholds 26 of the hitters' positions differ from the
projections' (George Springer, Christian Yelich, Brent Rooker, Jorge Polanco and Dominic Smith go to
UT, CJ Kayfus from 1B,OF to OF) and none of the pitchers'. Only Rooker is drafted in the default
league, at the same $9.27.

**Replacement by lineup slot.** Each side's slots (`teams ×` each slot, plus `teams × bench/2` more
UT or P when the bench isn't minimized) are filled for the most total value: players in order of
value, each one placed if a slot it fits is open or can be opened by shifting starters already
placed (a 2B,SS moving from SS to MI, or an SP,RP from RP to P, say). The sets of players that fit
the slots form a transversal matroid, so this greedy fill is optimal (it matches scipy's
`linear_sum_assignment` over player × slot). A slot type's replacement level is then the value of
the slots around its cutoff: refill the league with **Replacement span** fewer and that many more of
those slots, and divide the difference in total value (and in each category) by the players it
moves. Chains and all, that's the average of the last few starters it could lose and the first few
non-starters it could add, so one player's projection doesn't set a position's price (the default
span is 3; 0 is the single last starter). A player is priced against the lowest replacement level
among the slots he fits; one no slot takes (a DH when there's no UT) is worth a bench spot at most.
A position whose starters spill into UT, P or a flex slot is exactly as deep as it. On the 2027
projections (as of October 13) the Yahoo format prices C at +$12.36 and everything else level; CBS
(one UT, 5 SP and 2 RP, no P) has C +$18.17, 2B / 3B +$1.13, SS +$0.99, 1B +$0.53; five OF, no UT,
6 SP and 3 RP goes C +$14.02, 2B / 3B / OF +$1.49, SS +$0.96. Without any position info (no `Y! Pos` and no games),
every slot takes anyone.

The league formats set teams, hitter slots and pitcher slots only; budget ($260), bench and scoring
stay as they are. Yahoo, the page's default, and ESPN are from the sites' own help pages; CBS is
from third-party write-ups that agree with CBS's prize-league roster counts; Fantrax's 14 hitters
and 9 pitchers are from FantraxHQ, laid out as the classic 23-player roto roster, with the team
count assumed.

| format | teams | hitter slots | pitchers |
|---|---|---|---|
| Yahoo | 12 | C, 1B, 2B, 3B, SS, 3 OF, 2 UT | 2 SP, 2 RP, 4 P |
| ESPN | 10 | C, 1B, 2B, 3B, SS, CI, MI, 5 OF, UT | 9 P |
| CBS | 12 | C, 1B, 2B, 3B, SS, 3 OF, UT | 5 SP, 2 RP |
| Fantrax | 12 | 2 C, 1B, 2B, 3B, SS, CI, MI, 5 OF, UT | 9 P |
| NFBC | 15 | 2 C, 1B, 2B, 3B, SS, CI, MI, 5 OF, UT | 9 P |

Not done from the lineup-locks spec: the θ method (Task 2, method A), which needs per-start
projections and schedules, so the capture factors stand in; a rotation-size setting (the binding
chances and the capture factors assume 5-man rotations); innings or starts caps, which bind even
daily; and the optional H2H daily-lock haircut (Task 5.5).
Not done from the procedure: the draft-state weights (Task 12, re-weighting categories for one
team during a live draft) and the history check against real standings (Task 13.4); risk as an
option value is the beta below. The dollar curve's γ = 1.05 is the handoff's "mildly convex", not
fit to auction prices. The method is checked by simulation only, not against real
league standings.

**Risk-aware $ (beta, off by default; `risk.js`).** The risk-aware valuation spec
(`risk-aware-valuation-parameters.md` in the projections repository; its plan's steps R6, R7 and
R9). With **Risk (beta) › Risk-aware $** on, the page loads each side's risk file beside the
projections (`hitters_risk_ev.bin`, `pitchers_risk_ev.bin`: every player's season as 50 draws from
the projections' simulation, one from each 2% band of his outcomes; not in the bucket yet, so for
now `?riskdata=<base>`, or `?data=<base>` for both, points at a local server) and values every draw exactly as it values his projection, in the finished
run's frame (weights, pool rates, the playing-time fill for his role, the slot he's valued at, the
specialist correction, a lineup lock's share): V, SGP above replacement, per draw. Then
`Δ = E[max(V, r)] − E[V]` over the draws is the option to drop a bust for a free agent (r, the
floor, is his slot's replacement level, 0 SGP, plus an in-season premium table that's empty for
now), and `EffValue = μ + (1 − λ)·Δ` with μ the calculator's own value (the draws' mean V sits
$2–4 above μ for hitters on the expected-value basis, from the convexity of the playing-time fill,
so the option is an increment over μ rather than `E[max(V, r)]` itself); λ, the share of the
season a bust plays before it shows, is the spec's placeholder (hitters 0.25, pitchers 0.125),
plus the transaction delay (2, 5 or 14 days). `Var_eff = (λσ)² + (1 − λ)²·Var[max(V, r)]`. The
**Payout** sets the target H for an average team before the draft: the expected total of the
winner, or of the last playoff team, simulated from the calculator's team-total model (roto:
standings points by rank, where every team's rank is uniform whatever σ_k, so M = K(N + 1)/2 and
S² = K(N² − 1)/12; head-to-head: a round robin of weekly matchups, each week's total its draft
strength / W plus a week's luck ν_k / W, as the H2H weights assume, the record its category wins;
all-play the same against everyone). `CE = EffValue − (z / 2S)·Var_eff` with `z = (M − H)/S`, or
the certain value with the exact probability gain when `√Var_eff > 0.4·S`. **IL slots**: with a
team's IL slots all taken (Poisson, from the drafted players' extended lost time: draws a quarter or
more below their 75th percentile), a player's extended lost time costs a bench spot's price, the min
bid. The **Risk $** column is CE priced as the calculator prices SGP: the drafted players chosen by
CE over the same slots and bench, the same budget, split and curve, so it spends exactly the same
dollars on exactly as many roster spots. Points leagues get the option value only. In the default
league on the 2027 test simulation the largest moves are about ±$5: high-variance SPs gain
(Misiorowski +$4.25), low-variance closers lose (their draws carry no preseason role risk yet).
Not done: the spread factor, λ and the in-season premium are placeholders (all 1, the spec's
values, and 0) until the backtests fit them; no correlation between players; no keeper horizon.
The draft mode is its own page, `auction-calculator/draft/` (beta; its `DESIGN.md`), linked from the calculator's header. Turned off, the page's values are byte-for-byte what they were.

| file | role |
|---|---|
| `auction-calculator/calc.js` | the model: CSV reading and cleaning (`'13.6%'`, `'1,031'`), the player pool, positions from last season's games (`eligibilityOf`, `withEligibility`), the start z-scores and points, the SGP passes (`valueSide`), replacement by lineup slot (`positionReplacement`, with a span and per category), the drafted players, dollars and value breakdown (`auctionValues`), rank; no DOM, so Node runs it too |
| `auction-calculator/index.html`, `app.js` | the page: settings and the league formats (`PRESETS`), uploads (UTF-8 or Windows-1252), the scoring controls, the table, the CSV; with the Risk setting on, the risk files and the Risk $ columns |
| `auction-calculator/risk.js` | the risk-aware $: the risk file's reader, each draw valued in the calculator's frame (`lineValues`), the option value, the objective (`objective`, simulated), CE and its pricing (`applyRisk`), and the spec's section 9 formulas; the placeholder tables (`SPREAD`, `LAMBDA`, `R_PREMIUM`, `TRANSACTIONS`); no DOM |
| `tools/auction_calculator/risk_checks.mjs`, `risk_ref.py` | the spec's section 7 checks; parity with its section 9 reference code in Python (`risk_ref.py`, or the spec bundle's `risk_reference.py` with `--ref`); that `risk.js` values every projection line exactly as `calc.js` does and that the Risk $ spends the same dollars on the same roster spots, over 51 leagues; that the calculator's output is the same with risk's hook on or off (and as an older `calc.js` with `--baseline`); the risk files against the CSVs; and an end-to-end run with the 15 largest moves and Δ by $ tier (`--csv` writes every player's numbers) |
| `tools/auction_calculator/run_ref.py` | runs `auction_calc.py` headless through a stub `streamlit` (`stub/`), on local CSVs with settings from `ST_OVERRIDES`, and prints every player's score (its `unadjusted_value`) |
| `tools/auction_calculator/compare.mjs` | scores the same CSVs and settings with `calc.js` and checks every player's start value against the script's |
| `tools/auction_calculator/sgp_dump.mjs`, `sgp_check.py` | dumps one league's last pass and recomputes it independently in Python (numpy, scipy): with an eligibility file, every player's positions from his games (pandas) against the positions calc.js priced; pool rates and rate-stat counts from the raw CSVs, tier variance, noise, G, SGP, the specialist curve with the procedure's reference code, and the drafted pool against `linear_sum_assignment`; under a lineup lock, the chance the SP spots bind by scipy's binomial, each SP's capture factor from Table 9.2, and the lock's weights on the pool rates, the draft variance, the noise and SGP above replacement |
| `tools/auction_calculator/sgp_checks.mjs` | the procedure's own validation: the 2√π / (N − 1) constant against simulated standings (within 2%), the tier variance against 3000 simulated snake drafts with ADP noise (within 5%), and a report of players who moved more than 20 places against the z-scores, with why |
| `tools/auction_calculator/locks_checks.mjs` | the lineup-locks spec's own validation (Task 7): the binding chances against its Table 9.1 (within 0.03) and its 0.118 example, the q values, the two-way values against its Table 9.6 (one slot under daily locks and simultaneous exact, under weekly ones within 0.12), simultaneous ≥ max(H, P) and one slot daily ≥ Monday/Friday ≥ weekly ≥ H over a grid, daily locks changing no value, weekly locks not shrinking the pitchers' share, and the default league's two-way values in order under each lock |
| `tools/auction_calculator/eligibility_checks.mjs` | the eligibility rule on made-up players (starts or games, a blank threshold, where he played most, UT for a DH, SP / RP, ids, the projections' positions for the rest), then Yahoo's thresholds against the file's own `Y! Pos` (never a position it doesn't list; one looser, some), and whose positions the games change |
| `tools/auction_calculator/invariants.mjs` | over 190 leagues (every format; bench on and off, Points, roto / H2H / all-play, AL/NL-only, min bids, spans, fill and specialists off, hitter splits from 0 to 100% and the values' own, dollar curves, lineup locks, two-way modes, other categories; with an eligibility file, Yahoo's thresholds throughout and 20 more leagues on other ones), checks that exactly the roster spots are drafted at the min bid or more, on legal rosters, for exactly the budget (less a minimized bench's min bids), that the hitters get exactly their split, that every value breakdown adds up, and that the values settled |

To check the model after a change (pandas, Pillow, numpy and scipy for the Python side):

```bash
curl -sO https://data.blandalytics.com/projections/hitters_auction_ev.csv
curl -sO https://data.blandalytics.com/projections/pitchers_auction_ev.csv
curl -sO https://data.blandalytics.com/projections/position_eligibility.csv
curl -sO https://raw.githubusercontent.com/blandalytics/plv_viz/main/auction_calc.py
export ST_OVERRIDES='{"League Type": "Points", "Number of Teams": 15}'   # or {} for the defaults
python tools/auction_calculator/run_ref.py auction_calc.py hitters_auction_ev.csv pitchers_auction_ev.csv > ref.json
node tools/auction_calculator/compare.mjs hitters_auction_ev.csv pitchers_auction_ev.csv ref.json
node tools/auction_calculator/sgp_dump.mjs hitters_auction_ev.csv pitchers_auction_ev.csv '{"format": "h2h"}' position_eligibility.csv > dump.json
python tools/auction_calculator/sgp_check.py hitters_auction_ev.csv pitchers_auction_ev.csv dump.json position_eligibility.csv   # dump '{"lock": "weekly"}' to check a lock
node tools/auction_calculator/sgp_checks.mjs hitters_auction_ev.csv pitchers_auction_ev.csv
node tools/auction_calculator/eligibility_checks.mjs position_eligibility.csv hitters_auction_ev.csv pitchers_auction_ev.csv
node tools/auction_calculator/invariants.mjs hitters_auction_ev.csv pitchers_auction_ev.csv position_eligibility.csv   # and without it
node tools/auction_calculator/locks_checks.mjs hitters_auction_ev.csv pitchers_auction_ev.csv position_eligibility.csv
node tools/auction_calculator/risk_checks.mjs hitters_auction_ev.csv pitchers_auction_ev.csv hitters_risk_ev.bin pitchers_risk_ev.bin
```

To update the projections, upload new `hitters_auction_ev.csv` / `pitchers_auction_ev.csv` to the
bucket's `projections/` folder with the same columns (`Name`, `MLBAMID`, `Team`, `Y! Pos`, then
the stats, and the `<stat>_p10` / `<stat>_p90` percentiles the season's luck is read from). The page shows how many players each default file has, not where
it comes from. `position_eligibility.csv` is one row per player with `Name`, `MLBAMID`, `Team`,
`Y! Pos`, `Season` and `<pos> G` / `<pos> GS` for C, 1B, 2B, 3B, SS, LF, CF, RF, OF, DH and P (the
page reads OF, games at any outfield spot, not LF / CF / RF); upload a new one each season. The page revalidates all three on every load (a 304 when they haven't changed), so a new
upload shows on the next one; if the zone ever caches them, purge their URLs. After
any change to the JavaScript, bump the `?v=` on the script tag in `index.html` and on `app.js`'s
imports of `calc.js` and `risk.js` (`risk.js` imports nothing: `app.js` hands it `calc.js`).

## Projection pages

Four pages explain the 2027 projections behind the Auction Calculator. The first three come from
the factor ledger of the projections repository (`src/ledger.py`); What Changed comes from its
daily change (`src/change.py`).

* [Projection Drilldown](https://blandalytics.com/projection-drilldown/): one player, stat by stat.
  A waterfall goes from a league-average player to his projection, one factor at a time: talent,
  aging, parks, platoon mix, the pull toward the average, the league environment, team context, and
  playing time by cause. Gold raises the stat and teal lowers it, as on the Model Drilldown. The page
  also shows the 10th–90th percentile range, split into talent, playing time and luck, and the
  largest effects in plain sentences. *Expected* / *Healthy* switches the playing-time basis.
  `?p=h:<mlbam>&s=<stat>&b=ev|healthy` opens a player, a stat and a basis.
* [Playing-Time Risk](https://blandalytics.com/playing-time-risk/): every projection's PA (hitters)
  or batters faced (pitchers) lost per cause against a full season, and the auction value that the
  risk costs. The table sorts by any column and filters by team and position.
* [Promotion Timelines](https://blandalytics.com/promotion-timelines/): each prospect's chance of a
  first MLB day in each of the next five seasons, and the first season by service-time window.
* [What Changed](https://blandalytics.com/what-changed/) (in season): each day's change of every
  player's rest-of-season auction value, split by cause: new results, role and playing time, the
  league environment, the parks left, and the days played. A bar per player stacks the causes
  left (lower) and right (higher) of zero. A row opens the stats by cause and a sentence. By
  default the page shows only the material changes: larger than the change on a day with no new
  data (a placebo refit). `?date=YYYY-MM-DD&r=h|p&b=ev|hb` opens a day, a role and a basis.

### How it works

The pages read JSON from `data.blandalytics.com/projections/site/<season>/` (`projection-drilldown/data.js`):

| file | what it holds |
|---|---|
| `meta.json` | the schema version, the runs, the factors' labels and sentences, the stats |
| `index.json` | one row per player and role, for the search |
| `team/<TEAM>.json` | each player's waterfalls per stat and basis, his playing-time causes, his bands |
| `pt_risk.json`, `promotion.json` | the two leaderboards |
| `change/index.json`, `change/<date>.json` | in season: the dates, and one day's change per player |
| `manifest.json` | in season: the date of the newest run; uploaded last |

The playing-time causes are stored once per player. A stat's "Playing time" row splits by them in
proportion when it opens. Rates are exact Shapley values over the factors. Counting stats and $ come
from simulations with each factor removed, and a last row holds the factors' interaction.

### Updating

The projections repository writes and uploads the files:

    python -m src.ledger --season 2027 --release      # the ledger of the live runs
    python -m src.site_export --season 2027           # the JSON (data/site/projections/2027/)
    python -m src.publish --site                      # the upload (it asks first)

To work on a page without uploading, run `python -m src.site_export --serve <this checkout>` in the
projections repository, and open `http://127.0.0.1:8771/projection-drilldown/?data=/_data/`. The
`?data=` is kept on the links between the pages. The files' URLs carry an hourly stamp. After a
change to the JavaScript, bump the `?v=` on its script tag and imports.

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
| `nhl-draft/index.html`, `app.js` | the page: settings for every argument of the CLI tool (including a separate finish count for rival stops in a real draft), a do-not-draft list, the draft console |
| `nhl-draft/worker.js` | a Web Worker that loads Pyodide and numpy (kept in Cache Storage across visits), then drives `web_api.Session` |
| `nhl-draft/py/` | the tool itself — `league.py`, `valuation.py`, `boards.py`, `draft_sim.py`, `pick_engine.py`, `draft_tool.py`, `web_api.py` |
| `nhl-draft/data/sheet_live.csv` | the projections and eligibility sheet; `merged_players.csv` carries Yahoo ranks |

### Updating

The projections are a snapshot. To refresh them, replace `nhl-draft/data/sheet_live.csv`
with a new export of the sheet (same columns), then bump `VERSION` in `app.js` and the
`app.js?v=` query in `index.html` so browsers fetch the new files. The same bump is needed
after any change to the Python under `nhl-draft/py/`. A different projections file can also
be loaded on the page itself, without deploying, through the *Projections* file input.

## NBA Shot Charts

[blandalytics.com/nba-shot-charts/](https://blandalytics.com/nba-shot-charts/) — how an NBA
player scored in one game or across a season. It is the
[nba-scoring-chart.streamlit.app](https://nba-scoring-chart.streamlit.app/) app
([Blandalytics/nba_shot_chart](https://github.com/Blandalytics/nba_shot_chart)) rebuilt for the
browser on the PLPD design system: amber for makes and points added and cyan for misses and
points given back (as Model Drilldown uses them), each set to equal contrast against the
background and white, and the court in the app's seaborn `vlag`. It holds the
scoring chart (the app's two panels stacked, the court shaded by the xFG model's expected points
per shot with the shots and their xPTS spread on the scale above it, then the six-part points
waterfall underneath), the season and game leaderboards (totals or per shot, with the app's two
minimum-shot sliders), Shot Value Added (shot quality against shot making for the top quarter
of players by shots) and Team Minutes (one team, or every team by division). Pick a season, a
player and a game, or the season-long chart; a chart is linkable as
`nba-shot-charts/#<season>/<player id>/<game id | season>`. A leaderboard row or a scatter
point opens that player or game in the chart. **Share image** exports the chart at 2x.

It departs from the app in a few places, all deliberate:

- **Every player.** The app keeps players on `nba_api`'s bundled active list, which lags the
  season (rookies and since-retired players missing, some names spelled differently from the
  stats API, which breaks its name-to-id lookup). Here everyone who logged a game is listed,
  each id under its most frequent spelling.
- **The whole season.** The app's one league-wide `ShotChartDetail` call silently stops at
  102,400 rows (about half a season); the build asks a month at a time.
- **Per-shot game Volume.** The app's per-shot game leaderboard folds xFTA points into Volume;
  here Volume is 1.09 a shot in both tables, so it is left out of the per-shot views.

### How it works

[`tools/nba_shot_charts/build_data.py`](tools/nba_shot_charts/build_data.py) pulls a season's
game logs and shots from stats.nba.com with `nba_api`, retrying until the two agree on every
player-game's FGA (the API's caches can lag each other by a night's games), and writes JSON to
the `blandalytics-live` bucket under `nba/`:

| key | contents |
|---|---|
| `nba/manifest.json` | the seasons on offer, each with its `updated` stamp, games, shots and last date; written last |
| `nba/<season>/shots.json` | every regular-season FGA (player, game, location, make, 2 or 3, xPTS, shot zone) and each player-game's FTA, FTM and matchup (~7 MB a full season, ~1.5 MB compressed) |
| `nba/<season>/minutes.json` | every player-game's minutes |
| `nba/xfg_grid.json` | the court's background: matplotlib's hexbin of the xFG grid with the app's gridsize and extent, and the `vlag` colormap |

The page fetches the manifest under a ten-minute `?v=` and each season's files under its
`updated` stamp, so a morning's upload shows at once despite the edge cache.
[`nba-shot-charts/model.js`](nba-shot-charts/model.js) is the app's pandas arithmetic as pure
functions (checked against the app's own code on all of 2025-26: every leaderboard total,
per-shot mean, waterfall part, the scatter's threshold and guides, and team minutes agree to
display precision); `figure.js` draws the chart and `scatter.js` the value-added plot, both on
canvases at 2x.

| file | role |
|---|---|
| `nba-shot-charts/index.html`, `app.js` | the page: pickers, leaderboards, minutes tables, the link hash |
| `nba-shot-charts/model.js` | the app's arithmetic (summary, leaderboards, value added, team minutes, the colorbar's KDE) |
| `nba-shot-charts/figure.js`, `scatter.js` | the scoring chart and the value-added scatter |
| `tools/nba_shot_charts/build_data.py` | stats.nba.com → `nba/` in R2 |

### Updating

stats.nba.com answers a home connection but not cloud runners, so the build runs on the
site owner's own machine, not in GitHub Actions or a Cloudflare Worker: a Windows Task Scheduler
task (`\Blandalytics\NBA Shot Charts daily data`, 7:11 AM daily, waking the computer from sleep
if need be; run whether or not the user is signed in, as the user without a stored password (S4U),
catching up at the next chance when a run is missed) runs a local PowerShell wrapper
around `build_data.py` for the current season, uploading with the local wrangler login. The
wrapper retries a failed run once after 10 minutes, checks the manifest at origin afterwards and
logs each day's run. By hand, from the repo root (Python with
`tools/nba_shot_charts/requirements.txt`, and `npx wrangler` signed in):

```bash
python tools/nba_shot_charts/build_data.py                    # the current season, uploaded
python tools/nba_shot_charts/build_data.py --season 2025-26   # any season (adds it to the manifest)
python tools/nba_shot_charts/build_data.py --out /tmp/nba     # write the files, upload nothing
```

To try the page on local files, serve the repo on port 8000 and add
`?data=/tools/nba_shot_charts/cache/web/` with the files under `cache/web/nba/`. After any change
to the JavaScript, bump the `?v=` on `app.js` in `index.html` and on the module imports.
