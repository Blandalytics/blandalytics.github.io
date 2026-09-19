# blandalytics.github.io

Source for [blandalytics.com](https://blandalytics.com).

## Scorecards

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

Like the scorecards, the pages are pre-built by a scheduled workflow:

- [`.github/workflows/pitcher-cards.yml`](.github/workflows/pitcher-cards.yml) runs every
  morning at 10:30 UTC. It clones
  [Blandalytics/statcast_scraper](https://github.com/Blandalytics/statcast_scraper) (the
  pitches) and [Blandalytics/player_cards](https://github.com/Blandalytics/player_cards) (the
  PLV model files), builds a card for every pitcher who threw a tracked pitch the day before,
  and commits the result.
- [`pitcher-cards/cards/<gamePk>-<pitcherId>.html`](pitcher-cards/cards/) — one standalone
  page per pitcher per game. The card is a single SVG drawn in the original figure's
  1500 × 2000 coordinate system, so every panel keeps the matplotlib layout. Every comparison
  season's layer is in the page, tagged `data-cmp="<year>"`; `#cmp=<year>` in the URL picks
  one and `#cmp=0` hides them.
- [`pitcher-cards/days/<date>.json`](pitcher-cards/days/) — that day's games and pitchers,
  which the picker reads; [`pitcher-cards/index.json`](pitcher-cards/index.json) lists the
  dates built and which date each game is on. A card can be linked directly as
  `pitcher-cards/#<gamePk>-<pitcherId>`.

The pipeline lives in [`tools/pitcher_card/`](tools/pitcher_card/):

| file | role |
|---|---|
| `card.py` | `pitcher_card(game_pk, pitcher_id)` → HTML string; `cards_for_date(date)` → every pitcher that day from one scrape |
| `fetch.py` | the statsapi live feed (box score, bio, teams), Baseball Savant's arm angles, and `SeasonStore`: regular-season pitches by year, cached as parquet and topped up a day at a time |
| `prep.py` | per-pitch metrics from the scraper's columns: counts before the pitch, approach angles, break as acceleration, fastball differences, the per-type tables |
| `models.py` | the stuff / location / PLV model chains and the xSLG model, from the `player_cards` checkout |
| `shapes.py` | the comparison season's movement regions (seaborn's 90%-mass KDE contours) as SVG paths |
| `grades.py` | palette, pitch-type names and colours, benchmark bins, letter grades and both game-score formulas |
| `build_data.py` | assembles all of that into one card dict |
| `render.py` | renders the dict as the page |
| `build_site.py` | builds a date range into `pitcher-cards/` and maintains the manifests |

Data comes from statsapi.mlb.com through the scraper wherever it can: the game's pitches
(`statfast.mlb_day`) and the comparison seasons (`statfast.mlb_season`). The only other
sources are the game's live feed (box score, bio, team names — one request per game) and
Baseball Savant's arm-angle leaderboard, which the scraper does not cover. The card is MLB
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
at about half a second each. The first run also pulls each comparison season once (about a
minute per season), after which they come from the workflow's cache.

Locally, from the repo root with the scraper and the models cloned alongside:

```bash
git clone --depth 1 https://github.com/Blandalytics/statcast_scraper.git
git clone --depth 1 https://github.com/Blandalytics/player_cards.git
pip install -r tools/pitcher_card/requirements.txt
python tools/pitcher_card/build_site.py --start 2026-09-17 --end 2026-09-17
```

Or one card, without the site machinery:

```python
from tools.pitcher_card.card import pitcher_card
html = pitcher_card(822845, 543243)
```

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
