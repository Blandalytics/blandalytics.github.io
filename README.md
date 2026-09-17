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
