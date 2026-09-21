/**
 * Live game poller: MLB Stats API live feed -> small JSON files in R2.
 *
 *   live/today.json           every game on every league's schedule (yesterday ET
 *                             + today ET) with status, score, inning and whether
 *                             its feed carries pitch tracking data
 *   live/games/<gamePk>.json  pitch-by-pitch for any tracked game that was live
 *                             while we were watching; rewritten once more when
 *                             it goes final
 *   state/games.json          what the poller has learned about each game
 *                             (tracked? last feed timestamp? finalised?) so a
 *                             tick only fetches what it needs. Not served.
 *
 * Tracking is per venue, not per league (all of MLB and Triple-A, one Single-A
 * park with Hawk-Eye, none of Double-A), so every game is probed: a cheap fetch
 * of just the pitch speeds decides whether the full feed is worth pulling.
 *
 * The nightly scorecards workflow is still the source of truth for finished
 * games; these files only need to be good enough to render "right now".
 *
 * `scheduled` is the cron entry point. `fetch` serves live/ and data/ (the
 * completed-games Parquet from tools/data) read-only, for `wrangler dev` and as a
 * *.workers.dev fallback beside the bucket's own domain.
 */

const API = "https://statsapi.mlb.com/api/v1";
const FEED = "https://statsapi.mlb.com/api/v1.1/game/%d/feed/live";

const POLLS_PER_TICK = 2;          // cron granularity is one minute; we want ~30s
const POLL_GAP_MS = 30_000;
const LIVE_CACHE = "public, max-age=20";
const FINAL_CACHE = "public, max-age=3600";

const STATE_KEY = "state/games.json";
const UNTRACKED_AFTER = 20;        // pitches with no speed before a game is written off
const REPROBE_MS = 10 * 60_000;    // ...and how often to give it another look

// The hydrated schedule is ~5 KB a game; this keeps it to what today.json needs.
const SCHEDULE_FIELDS = [
  "dates", "date", "games", "gamePk", "gameType", "gameDate",
  "status", "abstractGameState", "detailedState", "codedGameState",
  "teams", "away", "home", "score", "team", "id", "abbreviation", "name",
  "sport", "league", "venue",
  "linescore", "currentInning", "inningState",
].join(",");

// Just enough of the feed to tell whether pitches are being tracked.
const PROBE_FIELDS = "liveData,plays,allPlays,playEvents,isPitch,pitchData,startSpeed";

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
    if (!key.startsWith("live/") && !key.startsWith("data/")) {
      return new Response("not found", { status: 404, headers: CORS });
    }

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

/** One pass over every league's schedule. Returns true if any game is in progress. */
async function poll(env) {
  const [games, state] = await Promise.all([schedule(), loadState(env)]);
  const now = Date.now();

  // forget games that have dropped off the two-day window
  const current = new Set(games.map((g) => g.gamePk));
  for (const pk of Object.keys(state)) if (!current.has(Number(pk))) delete state[pk];

  const live = games.filter((g) => g.status.abstract === "Live");
  const final = games.filter((g) => g.status.abstract === "Final");

  await Promise.all([
    ...live.map((g) => followGame(env, state, g.gamePk, now)),
    // a tracked game we were following needs one last write after its final pitch
    ...final.filter((g) => state[g.gamePk]?.tracked && !state[g.gamePk].final)
      .map((g) => writeGame(env, state, g.gamePk, FINAL_CACHE).then(() => { state[g.gamePk].final = true; })),
  ]);

  for (const g of games) g.tracked = state[g.gamePk]?.tracked ?? null;
  await Promise.all([
    putJson(env, "live/today.json", { updated: new Date(now).toISOString(), games }, LIVE_CACHE),
    putJson(env, STATE_KEY, state),
  ]);
  return live.length > 0;
}

/** Decide whether a live game is worth the full feed, and write it if so. */
async function followGame(env, state, gamePk, now) {
  const s = (state[gamePk] ??= { tracked: null, pitches: 0, probed: 0, stamp: null, final: false });

  if (s.tracked === false && now - s.probed < REPROBE_MS) return;

  if (s.tracked !== true) {
    const { pitches, tracked } = await probe(gamePk);
    s.pitches = pitches;
    s.probed = now;
    if (tracked) s.tracked = true;
    else if (pitches >= UNTRACKED_AFTER) s.tracked = false;
    if (s.tracked !== true) return;   // not enough pitches yet, or no tracking at this park
  }

  await writeGame(env, state, gamePk, LIVE_CACHE);
}

/** (pitch count, whether any pitch has a tracked speed) from a trimmed feed. */
async function probe(gamePk) {
  const d = await getJson(`${FEED.replace("%d", gamePk)}?fields=${PROBE_FIELDS}`);
  let pitches = 0;
  let tracked = false;
  for (const play of d.liveData?.plays?.allPlays ?? []) {
    for (const ev of play.playEvents ?? []) {
      if (!ev.isPitch) continue;
      pitches++;
      if (ev.pitchData?.startSpeed != null) tracked = true;
    }
  }
  return { pitches, tracked };
}

async function writeGame(env, state, gamePk, cacheControl) {
  const feed = await getJson(`${FEED.replace("%d", gamePk)}?fields=${FEED_FIELDS}`);
  const stamp = feed.metaData?.timeStamp ?? "";
  const s = state[gamePk];

  // the feed carries a timestamp of its last change; nothing to do if we
  // already hold that version and aren't changing its cache lifetime
  if (s.stamp === stamp && cacheControl === LIVE_CACHE) return;
  s.stamp = stamp;

  await putJson(env, `live/games/${gamePk}.json`, shapeGame(feed), cacheControl);
}

/** Every league's games for yesterday and today (Eastern), flattened and trimmed. */
async function schedule() {
  const sports = await getJson(`${API}/sports?fields=sports,id`);
  const ids = sports.sports.map((s) => s.id).join(",");
  const today = easternDate(new Date());
  const yesterday = easternDate(new Date(Date.now() - 86_400_000));
  const url = `${API}/schedule?sportId=${ids}&startDate=${yesterday}&endDate=${today}`
    + `&hydrate=team,linescore&fields=${SCHEDULE_FIELDS}`;
  const data = await getJson(url);
  const games = [];
  for (const day of data.dates ?? []) {
    for (const g of day.games) {
      const ls = g.linescore ?? {};
      const home = g.teams.home.team;
      games.push({
        gamePk: g.gamePk,
        date: day.date,
        gameType: g.gameType,
        startTime: g.gameDate,
        sport: { id: home.sport?.id ?? null, name: home.sport?.name ?? null },
        league: home.league?.name ?? null,
        venue: g.venue?.name ?? null,
        status: {
          abstract: g.status.abstractGameState,   // Preview | Live | Final
          detailed: g.status.detailedState,
          coded: g.status.codedGameState,
        },
        inning: ls.currentInning ?? null,
        half: ls.inningState ?? null,             // Top | Middle | Bottom | End
        away: side(g.teams.away),
        home: side(g.teams.home),
        tracked: null,                            // filled in from state by poll()
      });
    }
  }
  return games;
}

const side = (t) => ({
  id: t.team.id,
  abbr: t.team.abbreviation ?? null,
  name: t.team.name,
  score: t.score ?? null,
});

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
    away: { id: g.teams.away.id, abbr: g.teams.away.abbreviation ?? null, name: g.teams.away.name },
    home: { id: g.teams.home.id, abbr: g.teams.home.abbreviation ?? null, name: g.teams.home.name },
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

async function loadState(env) {
  const obj = await env.BUCKET.get(STATE_KEY);
  return obj ? obj.json() : {};
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "blandalytics-live (blandalytics.com)" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function putJson(env, key, value, cacheControl) {
  return env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl },
  });
}

/** YYYY-MM-DD in Eastern time, which is what the schedule endpoint calls a day. */
function easternDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// exposed for tests
export { probe, schedule, shapeGame };
