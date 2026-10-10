// The Worker's card pipeline against the Python one on real games: the pitch models (the
// JS port of pitch-modeling, on the bundle export_scorer.py writes) and the card dict
// (build.js against build_data.py). The inputs come from tools/pitcher_card/parity.py:
//
//   python tools/pitcher_card/parity.py /tmp/parity --game 822761
//   node tools/live/test/card_parity.mjs /tmp/parity
//
// Everything on the card has to match exactly but for two things. The model columns:
// the Python scorer averages the location draws in float32 (no numba), so its run
// values sit ~1e-7 from these and a plus number or letter right on a rounding edge can
// land one step over; a few of those are allowed. And the comparison regions, which the
// Worker scales from the pitcher's pack rather than drawing (reported, not failed).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadBundle } from "../src/cards/bundle.js";
import { build } from "../src/cards/build.js";
import { gameRows } from "../src/cards/feed.js";
import { heightFeet } from "../src/cards/groups.js";
import { plus, score } from "../src/cards/scorer.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node test/card_parity.mjs <dir written by parity.py>");
const t0 = performance.now();
const bundle = loadBundle(readFileSync(`${dir}/scorer.pack`));
console.log(`bundle loaded in ${(performance.now() - t0).toFixed(0)} ms`);

const GRADES = [["plvStuff+", "stuff_rv", "pitcher_game_pitch_type"], ["PLV+", "pitching_rv", "pitcher_game_pitch_type"],
  ["stuffGrade_game", "stuff_rv", "pitcher_game"], ["locGrade_game", "location_rv", "pitcher_game"],
  ["plvGrade_game", "pitching_rv", "pitcher_game"]];
const MODEL = new Set(["plvStuff+", "PLV+", "stuff", "loc", "plv", "loc_vl", "loc_vr"]);
const LETTERS = ["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
const stats = { cards: 0, pitches: 0, maxPlus: 0, modelFields: 0, modelSteps: 0, exact: 0, regions: 0, maxRegion: 0 };
const failures = [];

/** One step: a plus number off by one, or a letter one notch away. */
function oneStep(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) === 1;
  return Math.abs(LETTERS.indexOf(a) - LETTERS.indexOf(b)) === 1;
}

function compare(path, got, want) {
  if (MODEL.has(path.split(".").at(-1))) {
    stats.modelFields++;
    if (got !== want) {
      if (oneStep(got, want)) stats.modelSteps++;
      else failures.push(`${path}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    }
    return;
  }
  if (path.endsWith(".shapes")) return regions(got, want);
  if (got && want && typeof got === "object" && typeof want === "object") {
    const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
    for (const k of keys) compare(`${path}.${k}`, got[k], want[k]);
    return;
  }
  stats.exact++;
  if (got !== want) failures.push(`${path}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
}

function extent(paths) {
  const xs = [], ys = [];
  for (const d of paths) {
    let x = 0, y = 0;
    for (const m of d.matchAll(/([Ml])(-?[\d.]+),(-?[\d.]+)/g)) {
      [x, y] = m[1] === "M" ? [+m[2], +m[3]] : [x + +m[2], y + +m[3]];
      xs.push(x); ys.push(y);
    }
  }
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

function regions(got, want) {
  for (const t of Object.keys(want)) {
    if (!got[t]) continue;
    stats.regions++;
    const a = extent(got[t]), b = extent(want[t]);
    stats.maxRegion = Math.max(stats.maxRegion, ...a.map((v, i) => Math.abs(v - b[i])));
  }
}

for (const g of readdirSync(dir).filter((f) => statSync(`${dir}/${f}`).isDirectory())) {
  const read = (f) => JSON.parse(readFileSync(`${dir}/${g}/${f}`));
  const feed = JSON.parse(gunzipSync(readFileSync(`${dir}/${g}/feed.json.gz`)));
  const [values, cards, arms, packs] = ["values.json", "cards.json", "arms.json", "packs.json"].map(read);
  const rows = gameRows(feed);
  const heights = new Map(Object.values(feed.gameData.players).map((p) => [p.id, heightFeet(p.height)]));
  const t1 = performance.now();
  const got = score(rows, bundle, { heights });
  const ms = performance.now() - t1;
  const keys = new Set([...got.keys(), ...Object.keys(values)]);
  for (const k of keys) {
    const a = got.get(k), b = values[k];
    if (!a || !b) { failures.push(`${g} pitch ${k}: scored on one side only`); continue; }
    stats.pitches++;
    for (const [col, rv, level] of GRADES) stats.maxPlus = Math.max(stats.maxPlus, Math.abs(plus(bundle.scale, a[rv], rv, level) - b[col]));
  }
  for (const [pid, want] of Object.entries(cards)) {
    const card = build({
      feed, pitcherId: Number(pid), rows: rows.filter((r) => r.pitcher === Number(pid)), values: got,
      scale: bundle.scale, xslg: bundle.xslg, arm: arms[pid], pack: packs[pid],
    });
    stats.cards++;
    compare(`${g}.${pid}`, card, want);
  }
  console.log(`${g}: ${rows.length} pitches scored in ${ms.toFixed(0)} ms, ${Object.keys(cards).length} cards`);
}

console.log(`${stats.cards} cards, ${stats.pitches} pitches; max per-pitch plus difference ${stats.maxPlus.toExponential(1)}`);
console.log(`${stats.exact} exact fields; ${stats.modelSteps} of ${stats.modelFields} model numbers/grades one step over`);
console.log(`${stats.regions} comparison regions, max extent difference ${stats.maxRegion.toFixed(1)} in (scaled from the pack, not failed)`);
const allowed = Math.max(2, Math.ceil(stats.modelFields * 0.01));
if (stats.maxPlus > 1e-3) failures.push(`per-pitch plus numbers differ by up to ${stats.maxPlus}`);
if (stats.modelSteps > allowed) failures.push(`${stats.modelSteps} model numbers one step over (allowed ${allowed})`);
if (failures.length) {
  console.log(`FAIL: ${failures.length} differences\n  ${failures.slice(0, 40).join("\n  ")}`);
  process.exit(1);
}
console.log("PASS");
