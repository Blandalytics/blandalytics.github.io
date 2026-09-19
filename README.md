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

## Swing Profiles

[blandalytics.com/swing-profiles/](https://blandalytics.com/swing-profiles/) — bat speed,
acceleration and jerk through an MLB hitter's swing. Pick a season, a player and a bat side;
the page fetches the player's Baseball Savant swing-path card, digitizes the bat-speed chart
out of its pixels, imputes the swing's real duration from the bat-tracking leaderboard
(swing length / mean bat speed), and differentiates. The figure downloads as a PNG, the
curve as a CSV, and a profile is linkable as `swing-profiles/#<mlbam id>-<season>-<L|R>`.

It is [Blandalytics/swing_profiles](https://github.com/Blandalytics/swing_profiles) ported
to JavaScript, module for module, so it runs in the browser with nothing to install: both
Savant endpoints allow cross-origin requests, and the browser decodes the card natively.
The port was checked against the Python on six player-seasons — the digitized curves are
bit-identical, and durations and derivatives agree to floating-point noise.

| file | role |
|---|---|
| `swing-profiles/swing.js` | the pipeline: leaderboard fetch and name resolution (`savant_lookup`), card digitizer (`swing_path_extract`), duration (`swing_duration`), Savitzky–Golay derivatives (`swing_profile`) |
| `swing-profiles/plot.js` | the figure, on a canvas at 200 dpi with the same geometry and theme as `swing_plot.py` |
| `swing-profiles/index.html`, `app.js` | the page: season, player and bat-side controls, the stats strip, downloads |

### Updating

Nothing is stored: every profile is fetched and computed on request. If Savant changes the
card template, the pixel anchors at the top of `swing.js` (`WIN_*`, `X_START`, `X_IMPACT`,
`Y_ZERO`, `PX_PER_MPH`) need rechecking, exactly as in the Python. After any change to the
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
