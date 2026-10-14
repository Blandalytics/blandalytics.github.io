// poll() (src/index.js) against a stubbed Stats API and an in-memory bucket, offline:
// one game's failed or malformed feed costs neither the other games nor today.json; a
// failed write is retried on the next poll; a finished game's last write waits for its
// own feed to say Final (and, for MLB, the cards' pass), up to FINAL_TRIES polls; and
// the arm angles (src/cards/live.js) are looked at again after ten minutes.
//
//   node tools/live/test/poll.mjs
import { arms } from "../src/cards/live.js";
import { FINAL_TRIES, poll } from "../src/index.js";

// the R2 binding, as much of it as the poller and the cards use; every put is a new etag
const store = new Map();
const meta = new Map();
const failGet = new Set();
const failPut = new Set();
let version = 0;
const set = (key, body, http = {}) => {
  store.set(key, body);
  meta.set(key, { etag: `e${++version}`, ...http });
};
const BUCKET = {
  async get(key) {
    if (failGet.has(key)) throw new Error(`get ${key}: simulated failure`);
    const v = store.get(key);
    return v === undefined ? null : { json: async () => JSON.parse(v) };
  },
  async head(key) { return store.has(key) ? { etag: meta.get(key).etag } : null; },
  async put(key, body, opts) {
    if (failPut.has(key)) throw new Error(`put ${key}: simulated failure`);
    set(key, body, opts?.httpMetadata);
  },
};
const env = { BUCKET };
const read = (key) => JSON.parse(store.get(key));
const state = () => read("state/games.json");

// the Stats API: the schedule and each game's feed (an object, or an HTTP status to fail with)
const AAA = 11;
const MLB = 1;
let schedule = [];
const feeds = new Map();
const fetched = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body) });
  if (u.pathname.endsWith("/sports")) return ok({ sports: [{ id: MLB }, { id: AAA }] });
  if (u.pathname.endsWith("/schedule")) return ok({ dates: [{ date: "2026-10-13", games: schedule }] });
  const pk = Number(u.pathname.match(/game\/(\d+)\/feed\/live/)?.[1]);
  fetched.push(pk);
  const f = feeds.get(pk);
  return typeof f === "number" || f === undefined ? { ok: false, status: f ?? 404, json: async () => ({}) } : ok(f);
};

const team = (id, sport) => ({ id, abbreviation: `T${id}`, name: `Team ${id}`, sport: { id: sport, name: "x" }, league: { name: "L" } });
const game = (pk, sport, abstract) => ({
  gamePk: pk, gameType: "R", gameDate: "2026-10-13T23:05:00Z",
  status: { abstractGameState: abstract, detailedState: abstract, codedGameState: abstract[0] },
  teams: { away: { team: team(1, sport), score: 0 }, home: { team: team(2, sport), score: 1 } },
  venue: { name: "Park" }, linescore: { currentInning: 5, inningState: "Top" },
});
const pitch = { isPitch: true, pitchNumber: 1, count: { balls: 0, strikes: 1, outs: 0 },
  details: { type: { code: "FF" }, call: { code: "C" }, description: "Called Strike" }, pitchData: { startSpeed: 95.1 } };
const play = { about: { atBatIndex: 0, inning: 1, halfInning: "top", isComplete: false },
  matchup: { batter: { id: 10 }, pitcher: { id: 20 }, batSide: { code: "R" }, pitchHand: { code: "R" } }, result: {}, playEvents: [pitch] };
const feed = (pk, abstract, stamp, plays = [play]) => ({
  metaData: { timeStamp: stamp },
  gameData: {
    game: { pk, type: "R" }, datetime: { officialDate: "2026-10-13" },
    status: { abstractGameState: abstract, detailedState: abstract, codedGameState: abstract[0] },
    teams: { away: { id: 1, abbreviation: "T1", name: "Team 1" }, home: { id: 2, abbreviation: "T2", name: "Team 2" } },
    players: {},
  },
  liveData: { plays: { allPlays: plays }, linescore: {} },
});
// a feed caught mid-play: no batter yet, a pitch with no count or details
const malformed = (pk, stamp) => feed(pk, "Live", stamp, [{ about: { atBatIndex: 0, inning: 1, halfInning: "top" },
  matchup: { pitcher: { id: 20 } }, playEvents: [{ isPitch: true, pitchNumber: 1, pitchData: { startSpeed: 90 } }] }]);

const logs = [];
const print = console.log;
console.log = (...a) => logs.push(a.join(" "));
let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  print(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

// 1. three live games: one fine, one whose feed fails, one malformed
schedule = [game(101, AAA, "Live"), game(102, AAA, "Live"), game(103, AAA, "Live")];
feeds.set(101, feed(101, "Live", "s1")).set(102, 500).set(103, malformed(103, "s1"));
await poll(env);
check("today.json is written despite a failing feed", store.has("live/today.json") && read("live/today.json").games.length === 3);
check("the state is written too", store.has("state/games.json") && state()[101]?.tracked === true);
check("the good game's file is written", read("live/games/101.json").updated === "s1");
check("the malformed game's file is written, its gaps null",
  read("live/games/103.json").pitches[0].balls === null && read("live/games/103.json").plays[0].batter === null);
check("the failing game has no file and is logged", !store.has("live/games/102.json") && logs.some((l) => l.startsWith("game 102 failed")));

// 2. a write that fails is retried on the next poll, not skipped as already held
feeds.set(101, feed(101, "Live", "s2"));
failPut.add("live/games/101.json");
await poll(env);
check("a failed write leaves the feed's timestamp unrecorded", state()[101].stamp === "s1");
failPut.clear();
await poll(env);
check("...so the next poll writes it", read("live/games/101.json").updated === "s2" && state()[101].stamp === "s2");

// 3. the schedule calls a game Final before its feed does: the last write waits for the feed
schedule = [game(101, AAA, "Final")];
feeds.set(101, feed(101, "Live", "s3"));
await poll(env);
check("a game the feed still calls Live is not let go", state()[101].final === false && state()[101].finalTries === 1);
check("...but its file is rewritten for the final cache", meta.get("live/games/101.json").cacheControl === "public, max-age=3600");
feeds.set(101, feed(101, "Final", "s4"));
await poll(env);
check("once the feed says Final the game is done", state()[101].final === true && read("live/games/101.json").updated === "s4");
fetched.length = 0;
await poll(env);
check("...and is not fetched again", !fetched.includes(101));

// 4. a finished game whose feed keeps failing is let go after FINAL_TRIES polls
schedule = [game(301, AAA, "Final")];
feeds.set(301, 503);
set("state/games.json", JSON.stringify({ 301: { tracked: true, pitches: 50, probed: 0, stamp: "x", final: false } }));
for (let i = 1; i < FINAL_TRIES; i++) await poll(env);
check(`still tried after ${FINAL_TRIES - 1} failed polls`, state()[301].final === false);
await poll(env);
check(`let go at ${FINAL_TRIES}`, state()[301].final === true && state()[301].finalTries === FINAL_TRIES);

// 5. an MLB game's last pass waits for the cards: an unreadable card index sits a poll out
schedule = [game(401, MLB, "Final")];
feeds.set(401, feed(401, "Final", "f1", []));
set("state/games.json", JSON.stringify({ 401: { tracked: true, pitches: 50, probed: 0, stamp: "x", final: false } }));
failGet.add("live/cards/index.json");
await poll(env);
check("an MLB game is not let go while the cards sit out", state()[401].final === false);
failGet.clear();
await poll(env);
check("...and is once they have run", state()[401].final === true);

// 6. the arm angles: kept ten minutes per isolate, then reloaded when the file has changed
const t0 = Date.UTC(2031, 5, 1);
set("cards/arms/2031.json", JSON.stringify({ R: { 7: { angle: 40 } } }));
check("arm angles load", (await arms(env, "2031-06-01", "R", t0))[7]?.angle === 40);
set("cards/arms/2031.json", JSON.stringify({ R: { 7: { angle: 45 } } }));
check("...are kept within ten minutes", (await arms(env, "2031-06-01", "R", t0 + 60_000))[7]?.angle === 40);
check("...and reloaded after, when the file changed", (await arms(env, "2031-06-01", "R", t0 + 10 * 60_000))[7]?.angle === 45);
check("a missing season is empty", Object.keys(await arms(env, "2032-06-01", "R", t0)).length === 0);
set("cards/arms/2032.json", JSON.stringify({ R: { 7: { angle: 30 } } }));
check("...and picked up once it appears", (await arms(env, "2032-06-01", "R", t0 + 10 * 60_000))[7]?.angle === 30);

console.log = print;
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
