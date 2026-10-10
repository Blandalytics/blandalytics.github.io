/**
 * Holds the tree evaluators (src/cards/trees.js) to the libraries they stand in for: runs
 * the test cases packs carry -- meta.tests, with the libraries' own outputs, from
 * tools/pitcher_card/check_trees.py (the real models) or make_tree_fixture.py (test/trees.mjs)
 * -- and prints the largest error per model kind.
 *
 *   node test/parity.mjs models.pack cases.pack [--bench "Fastball vs Same Hand"]
 *
 * A test is {model, kind, fn, x, expect, tol: {abs, rel}}: `fn` (raw, predict, margin or
 * proba) of the model stored under `model`, on the row-major matrix `x`, against `expect`;
 * a value passes within max(abs, rel * |expected|). The first rows also go one at a time
 * through the single-row method, as plain arrays, which must match the batch exactly.
 *
 * --bench times the models whose prefix contains the string, per row, batch and one by one.
 * The first pack is taken to be the models: the memory line is for it alone.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readPack } from "../src/cards/pack.js";
import { loadModel } from "../src/cards/trees.js";

const BATCH = { raw: "rawBatch", predict: "predictBatch", margin: "marginBatch", proba: "predictProbaBatch" };
const SINGLE = { raw: "raw", predict: "predict", margin: "margin", proba: "predictProba" };
const SINGLE_ROWS = 64;

/** Several packs read as one: arrays merged, meta.models merged, meta.tests concatenated. */
export function mergePacks(packs) {
  const out = { meta: { models: {}, tests: [] }, arrays: Object.create(null), shapes: Object.create(null) };
  for (const p of packs) {
    Object.assign(out.arrays, p.arrays);
    Object.assign(out.shapes, p.shapes);
    Object.assign(out.meta.models, p.meta.models ?? {});
    out.meta.tests.push(...(p.meta.tests ?? []));
  }
  return out;
}

const same = (a, b) => a === b || (a !== a && b !== b);

function compare(out, expect, tol, s) {
  for (let i = 0; i < expect.length; i++) {
    const a = out[i], e = expect[i];
    s.values++;
    if (same(a, e)) { s.exact++; continue; }
    const d = Math.abs(a - e);
    s.maxAbs = Math.max(s.maxAbs, d);
    s.maxRel = Math.max(s.maxRel, d / Math.abs(e));
    if (!(d <= Math.max(tol.abs ?? 0, (tol.rel ?? 0) * Math.abs(e)))) s.fails++;
  }
}

/** The first rows through the single-row method, as plain arrays: must equal the batch. */
function compareSingle(model, fn, X, ncol, out, s) {
  const n = Math.floor(X.length / ncol), width = out.length / n;
  for (let i = 0; i < Math.min(n, SINGLE_ROWS); i++) {
    const row = Array.from(X.subarray(i * ncol, (i + 1) * ncol));
    const r = model[SINGLE[fn]](row);
    for (let j = 0; j < width; j++) {
      if (!same(typeof r === "number" ? r : r[j], out[i * width + j])) s.singleFails++;
    }
  }
}

function fmt(v) {
  return v === 0 ? "0" : v.toExponential(2);
}

/** Runs every test in `pack`; prints one line per model kind, fn and input type. True if all pass. */
export function checkPack(pack, log = console.log) {
  const models = new Map(), stats = new Map();
  for (const test of pack.meta.tests ?? []) {
    if (!models.has(test.model)) models.set(test.model, loadModel(pack, test.model));
    const model = models.get(test.model);
    const X = pack.arrays[test.x], ncol = pack.shapes[test.x][1], expect = pack.arrays[test.expect];
    const out = model[BATCH[test.fn]](X, new Float64Array(expect.length), ncol);

    const key = `${test.kind}|${test.fn}|${X.constructor.name.replace("Array", "").toLowerCase()}`;
    if (!stats.has(key)) stats.set(key, { models: new Set(), values: 0, exact: 0, maxAbs: 0, maxRel: 0, fails: 0, singleFails: 0, tol: test.tol });
    const s = stats.get(key);
    s.models.add(test.model);
    compare(out, expect, test.tol, s);
    compareSingle(model, test.fn, X, ncol, out, s);
  }

  log(`${"kind".padEnd(22)}${"fn".padEnd(9)}${"input".padEnd(9)}${"models".padStart(7)}${"values".padStart(10)}`
    + `${"exact".padStart(10)}${"max abs".padStart(11)}${"max rel".padStart(11)}  tol                     result`);
  let ok = true;
  for (const [key, s] of stats) {
    const [kind, fn, input] = key.split("|");
    const pass = s.fails === 0 && s.singleFails === 0;
    ok &&= pass;
    const tol = `abs ${fmt(s.tol.abs ?? 0)} rel ${fmt(s.tol.rel ?? 0)}`;
    log(`${kind.padEnd(22)}${fn.padEnd(9)}${input.padEnd(9)}${String(s.models.size).padStart(7)}`
      + `${String(s.values).padStart(10)}${String(s.exact).padStart(10)}${fmt(s.maxAbs).padStart(11)}`
      + `${fmt(s.maxRel).padStart(11)}  ${tol.padEnd(24)}${pass ? "PASS" : `FAIL (${s.fails} over tol, ${s.singleFails} single-row mismatches)`}`);
  }
  if (!stats.size) log("no tests in the pack");
  return ok && stats.size > 0;
}

/** Per-row time of each model whose prefix contains `filter`, on its own test rows. */
export function bench(pack, filter, log = console.log) {
  const prefixes = Object.keys(pack.meta.models).filter((p) => p.includes(filter));
  let batchTotal = 0, singleTotal = 0, treeTotal = 0;
  for (const prefix of prefixes) {
    const test = pack.meta.tests.find((t) => t.model === prefix && t.x.endsWith("32"))
      ?? pack.meta.tests.find((t) => t.model === prefix);
    if (!test) continue;
    const model = loadModel(pack, prefix), fn = model.meta.kind === "xgboost" ? "margin" : "raw";
    const X = pack.arrays[test.x], ncol = pack.shapes[test.x][1], n = Math.floor(X.length / ncol);
    const out = new Float64Array(n * model.numOutputs);
    const views = Array.from({ length: n }, (_, i) => X.subarray(i * ncol, (i + 1) * ncol));
    const batch = timePerRow(() => model[BATCH[fn]](X, out, ncol), n);
    const single = timePerRow(() => { for (const v of views) model[SINGLE[fn]](v); }, n);
    batchTotal += batch; singleTotal += single; treeTotal += model.meta.num_trees;
    log(`  ${prefix.padEnd(52)} ${String(model.meta.num_trees).padStart(5)} trees  `
      + `${(batch * 1e3).toFixed(2).padStart(7)} us/row batch  ${(single * 1e3).toFixed(2).padStart(7)} us/row single  `
      + `${(batch * 1e6 / model.meta.num_trees).toFixed(1).padStart(5)} ns/tree`);
  }
  log(`  ${"total".padEnd(52)} ${String(treeTotal).padStart(5)} trees  ${(batchTotal * 1e3).toFixed(2).padStart(7)} us/row batch  `
    + `${(singleTotal * 1e3).toFixed(2).padStart(7)} us/row single`);
}

function timePerRow(run, n) {
  run();   // warm up
  let reps = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 300) { run(); reps++; }
  return (performance.now() - t0) / (reps * n);   // ms per row
}

function mb(bytes) {
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--bench");
  const filter = at >= 0 ? args.splice(at, 2)[1] : null;
  const gc = globalThis.gc ?? (() => {});

  gc();
  const m0 = process.memoryUsage(), t0 = performance.now();
  const first = readPack(readFileSync(args[0]));
  const loaded = Object.keys(first.meta.models ?? {}).map((p) => loadModel(first, p));
  const ms = performance.now() - t0;
  gc();
  const m1 = process.memoryUsage();
  console.log(`${args[0]}: ${loaded.length} models read and loaded in ${ms.toFixed(0)} ms; `
    + `heap +${mb(m1.heapUsed - m0.heapUsed)}, array buffers +${mb(m1.arrayBuffers - m0.arrayBuffers)}, rss +${mb(m1.rss - m0.rss)}`);

  const pack = mergePacks([first, ...args.slice(1).map((p) => readPack(readFileSync(p)))]);
  const ok = checkPack(pack);
  if (filter !== null) {
    console.log(`\nbench: models matching "${filter}"`);
    bench(pack, filter);
  }
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
