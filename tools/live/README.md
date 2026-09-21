# Live games

A Cloudflare Worker that polls the MLB Stats API live feed for in-progress games
every ~30 seconds and writes trimmed JSON to an R2 bucket. The site reads those
files directly; nothing here touches the repo.

| file | role |
|---|---|
| `src/index.js` | `scheduled()` polls and writes; `fetch()` serves the bucket read-only |
| `wrangler.jsonc` | Worker name, cron window (game hours, UTC) and the R2 binding |
| `cors.json` | bucket CORS policy, for when the bucket is served from its own domain |

Objects written:

| key | contents | cache |
|---|---|---|
| `live/today.json` | yesterday's and today's schedule with status, score, inning | 20s |
| `live/games/<gamePk>.json` | plays and pitches (type, velo, location, spin, EV/LA) | 20s, 1h once final |

The feed is fetched with a `fields=` filter (~250 KB instead of ~750 KB per game)
and a game is only re-written when the feed's `metaData.timeStamp` has moved. A
full seven-game evening costs about 50 ms CPU per cron tick, which needs the
Workers Paid plan (the free plan's 10 ms limit is enforced on consistent overage).

Read it from the site at `https://blandalytics-live.blandalytics.workers.dev/live/...`
until a custom domain is attached to the bucket.

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
