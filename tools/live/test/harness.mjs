import worker, { probe } from "../src/index.js";

// in-memory stand-in for the R2 binding: just enough for the poller
const store = new Map();
const BUCKET = {
  async get(key) { const v = store.get(key); return v ? { json: async () => JSON.parse(v) } : null; },
  async put(key, body) { store.set(key, body); },
};

const t0 = Date.now();
await worker.scheduled({}, { BUCKET });
console.log(`scheduled() ran in ${((Date.now() - t0) / 1000).toFixed(1)}s, wrote ${store.size} objects: ${[...store.keys()].join(", ")}`);

const today = JSON.parse(store.get("live/today.json"));
const bySport = {};
for (const g of today.games) {
  const k = `${g.sport.id} ${g.sport.name}`;
  (bySport[k] ??= { n: 0, live: 0, final: 0, tracked: 0 });
  bySport[k].n++; bySport[k][g.status.abstract.toLowerCase()] = (bySport[k][g.status.abstract.toLowerCase()] ?? 0) + 1;
  if (g.tracked) bySport[k].tracked++;
}
console.table(bySport);
console.log("today.json bytes:", store.get("live/today.json").length, "| state:", store.get("state/games.json"));
const ex = today.games.find((g) => g.sport.id !== 1);
console.log("sample non-MLB game:", JSON.stringify(ex));

console.log("\nprobe() on known games:");
for (const [pk, label, expect] of [
  [824545, "MLB DET@CWS", true], [816607, "AAA Gwinnett", true],
  [851018, "AA Erie", false], [850943, "A Jupiter", true], [850936, "A Fayetteville", false],
]) {
  const r = await probe(pk);
  console.log(`  ${label.padEnd(16)} pitches=${String(r.pitches).padEnd(4)} tracked=${r.tracked}  ${r.tracked === expect ? "✓" : "✗ expected " + expect}`);
}
