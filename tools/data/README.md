# Data files

Completed games as pitch-level Parquet in the `blandalytics-live` R2 bucket, served
at `https://data.blandalytics.com/data/...`. One immutable file per day, month or
season; the manifest says which files exist and what each covers.

| key | contents |
|---|---|
| `data/manifest.json` | every file below with sport, span, game and pitch counts, and `last_finalized` per sport |
| `data/<sport>/<YYYY>.parquet` | a closed season (~130 MB for MLB, postseason included) |
| `data/<sport>/<YYYY>/<YYYY-MM>.parquet` | a closed month of the current season (~20 MB) |
| `data/<sport>/<YYYY>/days/<YYYY-MM-DD>.parquet` | a settled day of the current month (~0.8 MB) |

`<sport>` is the Stats API code: `mlb`, `aaa`, `aax`, `afa`, `afx`, `win` (Arizona
Fall League) and so on. The schema is `statfast.COLUMNS` plus `sport_id` and
`game_type`, identical across sports and seasons; sorted by game, at-bat, pitch;
zstd-compressed with 100k-row groups, so a Parquet reader can range-request one
game or one pitcher out of a season file.

## How the tiers work

- A day is written once it has **settled** — two days after the games — because the
  API corrects pitch classifications and fills in missing pitches for a day or so.
- When a month's last day has settled, the month is **pulled fresh** (folding in every
  correction) and its day files are dropped. Closing a season replaces its months.
- A file is never rewritten unless `--force`, so the edge cache stays valid and a
  client reading the manifest can cache anything it lists.
- A game is kept only if some pitch in it was measured. That is what makes Double-A
  contribute nothing and lets one tracked Single-A park show up on its own.

Data before the manifest's `last_finalized` date comes from here; anything after
it, from the live feed in `live/`.

## Running

`.github/workflows/data.yml` runs `roll` nightly at 10:30 UTC for `mlb,aaa` and takes
`workflow_dispatch` inputs for everything else. It needs `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` (an R2 API token with object read/write on the bucket) plus
the existing `CLOUDFLARE_ACCOUNT_ID`.

```bash
# the nightly step: the settled day, and any month whose last day has settled
python tools/data/backfill.py roll --sport mlb,aaa

# explicit units; --prune drops the finer files a unit supersedes
python tools/data/backfill.py build --sport mlb --unit season --start 2015 --end 2025
python tools/data/backfill.py build --sport aaa --unit month --start 2026-04 --end 2026-08 --prune
python tools/data/backfill.py build --sport mlb --unit day --start 2026-09-18 --force

# anything with --out writes to a directory instead of R2
python tools/data/backfill.py --out /tmp/data build --sport mlb --unit day --start 2026-09-19
```

Runs from the repo root with `statcast_scraper` cloned alongside, as the workflow
does. A day takes ~2 s, a month ~12 s, a season a couple of minutes.

A `--force` rewrite of an existing file should be followed by a purge of its URL in
the Cloudflare dashboard (Caching → Purge by URL); everything else is cache-safe.
