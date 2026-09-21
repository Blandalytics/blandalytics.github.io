/**
 * Live game poller: MLB Stats API live feed -> small JSON files in R2.
 *
 *   live/today.json           every game on the schedule (yesterday ET + today ET),
 *                             with status, score and inning
 *   live/games/<gamePk>.json  pitch-by-pitch for any game that was live while we
 *                             were watching; rewritten once more when it goes final
 *
 * The nightly scorecards workflow is still the source of truth for finished
 * games; these files only need to be good enough to render "right now".
 *
 * `scheduled` is the cron entry point. `fetch` serves the bucket read-only, for
 * `wrangler dev` and as a *.workers.dev fallback if no custom domain is attached.
 */

const API = "https://statsapi.mlb.com/api/v1";
const FEED = "https://statsapi.mlb.com/api/v1.1/game/%d/feed/live";

// The feed is ~750 KB mid-game; `fields` trims it to the ~250 KB shapeGame()
// reads, which is most of the CPU time on a busy night. Names are matched
// anywhere in the tree, so keep this in sync with shapeGame().
const FEED_FIELDS = [
  "metaData", "timeStamp",
  "gameData", "game", "pk", "status", "detailedState", "codedGameState",
  "teams", "away", "home", "id", "abbreviation", "name", "players", "fullName",
  "liveData", "plays", "allPlays", "about", "atBatIndex", "inning", "halfInning", "isComplete",
  "matchup", "batter", "pitcher", "batSide", "pitchHand", "code",
  "result", "eventType", "rbi", "description",
  "playEvents", "isPitch", "pitchNumber", "count", "balls", "strikes", "outs",
  "details", "type", "call",
  "pitchData", "startSpeed", "coordinates", "pX", "pZ",
  "breaks", "spinRate", "breakVerticalInduced", "breakHorizontal",
  "hitData", "launchSpeed", "launchAngle", "totalDistance",
  "linescore", "currentInning", "inningState", "runs", "innings", "num",
].join(",");

const POLLS_PER_TICK = 2;          // cron granularity is one minute; we want ~30s
const POLL_GAP_MS = 30_000;
const LIVE_CACHE = "public, max-age=20";
const FINAL_CACHE = "public, max-age=3600";

export default {
  async scheduled(event, env) {
    for (let i = 0; i < POLLS_PER_TICK; i++) {
      if (i) await sleep(POLL_GAP_MS);
      const anyLive = await poll(env);
      if (!anyLive) break;
    }
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: CORS });
    }
    const key = new URL(request.url).pathname.replace(/^\/+/, "");
    if (!key.startsWith("live/")) return new Response("not found", { status: 404, headers: CORS });

    const obj = await env.BUCKET.get(key, {
      onlyIf: request.headers,   // honours If-None-Match -> 304
      range: request.headers,
    });
    if (!obj) return new Response("not found", { status: 404, headers: CORS });

    const headers = new Headers(CORS);
    obj.writeHttpMetadata(headers);
    headers.set("ETag", obj.httpEtag);
    headers.set("Content-Length", String(obj.size));
    if (!("body" in obj)) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : obj.body, { headers });
  },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One pass over the schedule. Returns true if any game is still in progress. */
async function poll(env) {
  const games = await schedule();
  const live = games.filter((g) => g.status.abstract === "Live");
  const final = games.filter((g) => g.status.abstract === "Final");

  await Promise.all([
    ...live.map((g) => writeGame(env, g.gamePk, LIVE_CACHE)),
    // a game we were following needs one last write after its final pitch
    ...final.map((g) => finaliseGame(env, g.gamePk)),
  ]);

  await putJson(env, "live/today.json", { updated: new Date().toISOString(), games }, LIVE_CACHE);
  return live.length > 0;
}

/** Yesterday's and today's games (Eastern), flattened and trimmed. */
async function schedule() {
  const today = easternDate(new Date());
  const yesterday = easternDate(new Date(Date.now() - 86_400_000));
  const url = `${API}/schedule?sportId=1&startDate=${yesterday}&endDate=${today}&hydrate=team,linescore`;
  const data = await getJson(url);
  const games = [];
  for (const day of data.dates ?? []) {
    for (const g of day.games) {
      const ls = g.linescore ?? {};
      games.push({
        gamePk: g.gamePk,
        date: day.date,
        gameType: g.gameType,
        startTime: g.gameDate,
        status: {
          abstract: g.status.abstractGameState,   // Preview | Live | Final
          detailed: g.status.detailedState,
          coded: g.status.codedGameState,
        },
        inning: ls.currentInning ?? null,
        half: ls.inningState ?? null,             // Top | Middle | Bottom | End
        away: side(g.teams.away),
        home: side(g.teams.home),
      });
    }
  }
  return games;
}

const side = (t) => ({
  id: t.team.id,
  abbr: t.team.abbreviation,
  name: t.team.name,
  score: t.score ?? null,
});

async function writeGame(env, gamePk, cacheControl) {
  const feed = await getJson(`${FEED.replace("%d", gamePk)}?fields=${FEED_FIELDS}`);
  const stamp = feed.metaData?.timeStamp ?? "";
  const key = `live/games/${gamePk}.json`;

  // the feed carries a timestamp of its last change; skip the PUT if we
  // already hold that version (a HEAD is far cheaper than a write)
  const head = await env.BUCKET.head(key);
  if (head?.customMetadata?.stamp === stamp) return;

  await putJson(env, key, shapeGame(feed), cacheControl, {
    stamp,
    state: feed.gameData.status.codedGameState,
  });
}

async function finaliseGame(env, gamePk) {
  const head = await env.BUCKET.head(`live/games/${gamePk}.json`);
  if (!head || head.customMetadata?.state === "F") return;   // never followed, or done
  await writeGame(env, gamePk, FINAL_CACHE);
}

/** Trim the live feed to what a scorecard needs. Counts are *after* the pitch. */
function shapeGame(feed) {
  const g = feed.gameData;
  const l = feed.liveData;
  const players = g.players ?? {};
  const name = (id) => players[`ID${id}`]?.fullName ?? String(id);

  const plays = [];
  const pitches = [];
  for (const play of l.plays?.allPlays ?? []) {
    const { about, matchup: m, result } = play;
    plays.push({
      atBat: about.atBatIndex,
      inning: about.inning,
      half: about.halfInning,
      batter: m.batter.id,
      pitcher: m.pitcher.id,
      event: result.eventType ?? null,
      rbi: result.rbi ?? 0,
      description: result.description ?? null,
      complete: about.isComplete,
    });
    let last = null;
    for (const ev of play.playEvents ?? []) {
      if (!ev.isPitch) continue;
      const pd = ev.pitchData ?? {};
      const hd = ev.hitData;
      last = {
        atBat: about.atBatIndex,
        inning: about.inning,
        half: about.halfInning,
        n: ev.pitchNumber,
        batter: m.batter.id,
        pitcher: m.pitcher.id,
        stand: m.batSide?.code ?? null,
        throws: m.pitchHand?.code ?? null,
        balls: ev.count.balls,
        strikes: ev.count.strikes,
        outs: ev.count.outs,
        type: ev.details.type?.code ?? null,      // FF, SL, CH ...
        call: ev.details.call?.code ?? null,      // C S B X F ...
        description: ev.details.description,
        velo: pd.startSpeed ?? null,
        px: pd.coordinates?.pX ?? null,
        pz: pd.coordinates?.pZ ?? null,
        spin: pd.breaks?.spinRate ?? null,
        ivb: pd.breaks?.breakVerticalInduced ?? null,
        hb: pd.breaks?.breakHorizontal ?? null,
        ev: hd?.launchSpeed ?? null,
        la: hd?.launchAngle ?? null,
        dist: hd?.totalDistance ?? null,
        result: null,
      };
      pitches.push(last);
    }
    if (last && about.isComplete) last.result = result.eventType ?? null;
  }

  const ls = l.linescore ?? {};
  const ids = new Set([...plays.map((p) => p.batter), ...plays.map((p) => p.pitcher)]);
  return {
    gamePk: g.game.pk,
    updated: feed.metaData?.timeStamp ?? null,
    status: g.status.detailedState,
    coded: g.status.codedGameState,
    away: { id: g.teams.away.id, abbr: g.teams.away.abbreviation, name: g.teams.away.name },
    home: { id: g.teams.home.id, abbr: g.teams.home.abbreviation, name: g.teams.home.name },
    linescore: {
      inning: ls.currentInning ?? null,
      half: ls.inningState ?? null,
      away: ls.teams?.away ?? null,
      home: ls.teams?.home ?? null,
      innings: (ls.innings ?? []).map((i) => ({ n: i.num, away: i.away?.runs ?? null, home: i.home?.runs ?? null })),
    },
    players: Object.fromEntries([...ids].map((id) => [id, name(id)])),
    plays,
    pitches,
  };
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "blandalytics-live (blandalytics.com)" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function putJson(env, key, value, cacheControl, customMetadata) {
  return env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl },
    customMetadata,
  });
}

/** YYYY-MM-DD in Eastern time, which is what the schedule endpoint calls a day. */
function easternDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
