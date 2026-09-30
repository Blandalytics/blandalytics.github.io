// dispatchCards() on its own: no network, no bucket, just the throttle and the
// window that decides when the cards workflow is asked to run.
import { dispatchCards } from "../src/index.js";

const MIN = 60_000;
const store = new Map();
const env = {
  GH_TOKEN: "t",
  BUCKET: {
    async get(k) { const v = store.get(k); return v ? { json: async () => JSON.parse(v) } : null; },
    async put(k, body) { store.set(k, body); },
  },
};

const game = (id, abstract) => ({ sport: { id }, status: { abstract } });
const MLB_LIVE = [game(1, "Live"), game(11, "Final")];
const MLB_DONE = [game(1, "Final"), game(11, "Live")];

let calls = [];
let status = 204;
globalThis.fetch = async (url, init) => {
  calls.push({ url, ref: JSON.parse(init.body).ref, auth: init.headers.Authorization });
  return { ok: status < 300, status, text: async () => "boom" };
};

let failed = 0;
function check(label, want) {
  const got = calls.length;
  calls = [];
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} dispatches=${got} want=${want}`);
}

const t = Date.UTC(2026, 8, 29, 20, 0, 0);

await dispatchCards({ BUCKET: env.BUCKET }, MLB_LIVE, t);
check("no GH_TOKEN -> never dispatches", 0);

await dispatchCards(env, MLB_LIVE, t);
check("MLB live, first tick", 1);

await dispatchCards(env, MLB_LIVE, t + 1 * MIN);
check("1 min later, throttled", 0);

await dispatchCards(env, MLB_LIVE, t + 4 * MIN);
check("4 min later, still throttled", 0);

await dispatchCards(env, MLB_LIVE, t + 5 * MIN);
check("5 min later, due again", 1);

await dispatchCards(env, MLB_DONE, t + 10 * MIN);
check("no MLB live, inside the 20 min tail", 1);

await dispatchCards(env, MLB_DONE, t + 40 * MIN);
check("past the tail, nothing on", 0);

// a non-MLB game on its own must not wake the cards build
store.clear();
await dispatchCards(env, [game(11, "Live")], t);
check("only a minors game is live", 0);

// a refused dispatch must not count as done
store.clear();
status = 401;
await dispatchCards(env, MLB_LIVE, t);
check("bad token -> attempted", 1);
status = 204;
await dispatchCards(env, MLB_LIVE, t + 1 * MIN);
check("...and retried on the very next tick", 1);

const last = JSON.parse(store.get("state/dispatch.json"));
console.log("  state:", JSON.stringify(last));

console.log(failed ? `\n${failed} failed` : "\nall dispatch checks passed");
process.exit(failed ? 1 : 0);
