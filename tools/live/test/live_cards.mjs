// LiveCards (src/cards/live.js) on one real game against an in-memory bucket: the cards a
// game in progress gets, nothing rebuilt when no count has moved, the final pass, and the
// index the picker reads. Uses a folder from tools/pitcher_card/parity.py:
//
//   node tools/live/test/live_cards.mjs /tmp/parity [gamePk]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { build } from "../src/cards/build.js";
import { loadBundle } from "../src/cards/bundle.js";
import { gameRows } from "../src/cards/feed.js";
import { heightFeet } from "../src/cards/groups.js";
import { INDEX, LiveCards } from "../src/cards/live.js";
import { score } from "../src/cards/scorer.js";

const dir = process.argv[2];
const pk = process.argv[3] ?? readdirSync(dir).find((f) => statSync(`${dir}/${f}`).isDirectory());
const read = (f) => JSON.parse(readFileSync(`${dir}/${pk}/${f}`));
const full = JSON.parse(gunzipSync(readFileSync(`${dir}/${pk}/feed.json.gz`)));
const [arms, packs] = [read("arms.json"), read("packs.json")];
const year = full.gameData.datetime.officialDate.slice(0, 4);

// the R2 binding, as much of it as live.js uses
const store = new Map();
const BUCKET = {
  async get(key) {
    const v = store.get(key);
    if (v === undefined) return null;
    return { json: async () => JSON.parse(v), arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) };
  },
  async head(key) { return store.has(key) ? { etag: String(store.get(key).length) } : null; },
  async put(key, body) { store.set(key, body); },
};
store.set("cards/models/scorer.pack", readFileSync(`${dir}/scorer.pack`));
store.set(`cards/arms/${year}.json`, JSON.stringify({ [full.gameData.game.type]: arms, R: arms }));
for (const [pid, p] of Object.entries(packs)) store.set(`cards/pitchers/${pid}.json`, JSON.stringify(p));
const env = { BUCKET };

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};
const games = [{ gamePk: Number(pk) }];

async function tick(feed, now) {
  const cards = new LiveCards(env, now);
  await cards.load();
  const n = await cards.game(feed);
  await cards.finish(games);
  return n;
}

// mid-game: the first half of the plays, the game not yet final
const plays = full.liveData.plays.allPlays;
const half = structuredClone(full);
half.liveData.plays.allPlays = plays.slice(0, Math.floor(plays.length / 2));
half.gameData.status.codedGameState = "I";
half.gameData.status.detailedState = "In Progress";
const halfRows = gameRows(half);
const pitchersSoFar = new Set(halfRows.map((r) => r.pitcher));
const built = await tick(half, Date.UTC(2026, 8, 20, 22));
let index = JSON.parse(store.get(INDEX));
check("mid-game: a card for every pitcher who has thrown", built === pitchersSoFar.size, `${built} of ${pitchersSoFar.size}`);
const game = index.games[pk];
check("index lists the game in progress", game && !game.final && game.status === "In Progress");
check("each entry carries the pitch count it was built at",
  game.pitchers.every((p) => p.pitches === halfRows.filter((r) => r.pitcher === p.id).length));

// the card file is what build() makes from the same inputs
const b = loadBundle(readFileSync(`${dir}/scorer.pack`));
const heights = new Map(Object.values(half.gameData.players).map((p) => [p.id, heightFeet(p.height)]));
const values = score(halfRows, b, { heights });
const pid = game.pitchers[0].id;
const want = build({ feed: half, pitcherId: pid, rows: halfRows.filter((r) => r.pitcher === pid), values, scale: b.scale, xslg: b.xslg, arm: arms[pid] ?? {}, pack: packs[pid] });
check("the card file is build()'s dict", store.get(`live/cards/${pk}-${pid}.json`) === JSON.stringify(want));
check("entries point at the card files", game.pitchers.every((p) => p.file.endsWith(`/live/cards/${pk}-${p.id}.json`)));

// the same feed again: nothing has moved
check("an unchanged feed rebuilds nothing", (await tick(half, Date.UTC(2026, 8, 20, 22, 1))) === 0);

// the final pass: every pitcher once more, and the game marked final
const pitchersAll = new Set(gameRows(full).map((r) => r.pitcher));
const last = await tick(full, Date.UTC(2026, 8, 21, 2));
index = JSON.parse(store.get(INDEX));
check("the final pass rebuilds every pitcher", last === pitchersAll.size, `${last} of ${pitchersAll.size}`);
check("the game is marked final", index.games[pk].final === true);
check("after that, nothing", (await tick(full, Date.UTC(2026, 8, 21, 2, 1))) === 0);

// once the nightly build has the game, it leaves the live index
store.set("cards/index.json", JSON.stringify({ days: {}, games: { [pk]: "2026-09-20" } }));
await tick(full, Date.UTC(2026, 8, 21, 11));
check("a game with permanent cards leaves the index", !(pk in JSON.parse(store.get(INDEX)).games));

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
