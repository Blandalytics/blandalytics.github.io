// The tree evaluators (src/cards/trees.js) and the pack reader against small committed
// models: fixtures/trees.pack holds LightGBM and XGBoost models trained by
// tools/pitcher_card/make_tree_fixture.py, with the libraries' own outputs on awkward rows.
// No network. check_trees.py runs the same comparison on the real models.
import { readFileSync } from "node:fs";
import { readPack } from "../src/cards/pack.js";
import { loadModel } from "../src/cards/trees.js";
import { checkPack } from "./parity.mjs";

const bytes = readFileSync(new URL("./fixtures/trees.pack", import.meta.url));
const pack = readPack(bytes);
let ok = checkPack(pack);

function check(label, pass) {
  ok &&= pass;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
}
function throws(fn, Type = Error) {
  try { fn(); } catch (e) { return e instanceof Type; }
  return false;
}

console.log("");
// a view that doesn't start on an 8-byte boundary is copied, and reads the same
const shifted = new Uint8Array(bytes.length + 3);
shifted.set(bytes, 3);
const again = readPack(shifted.subarray(3));
const name = "lgb/binary/threshold";
check("unaligned view reads the same arrays", again.arrays[name].every((v, i) => v === pack.arrays[name][i]));
check("bad magic is refused", throws(() => readPack(new Uint8Array(16))));
check("a truncated pack is refused", throws(() => readPack(bytes.subarray(0, bytes.length - 64))));
check("an unknown model is refused", throws(() => loadModel(pack, "lgb/nope")));

const binary = loadModel(pack, "lgb/binary");
const row = Array.from(pack.arrays["cases/lgb/binary/x64"].subarray(0, binary.numFeatures));
row[1] = NaN;
const withNull = row.slice();
withNull[1] = null;
check("null reads as missing", binary.raw(withNull) === binary.raw(row));
check("out too small is a RangeError",
  throws(() => binary.rawBatch(new Float64Array(10 * binary.numFeatures), new Float64Array(9)), RangeError));

const multi = loadModel(pack, "lgb/multiclass");
const p = multi.predict(row);
check("multiclass predict: one probability per class, summing to 1",
  p.length === 3 && Math.abs(p[0] + p[1] + p[2] - 1) < 1e-15);
const proba = loadModel(pack, "xgb/logistic").predictProba(row.slice(0, 3));
check("binary XGBoost predictProba is [1 - p, p]", proba.length === 2 && proba[0] === Math.fround(1 - proba[1]));

process.exitCode = ok ? 0 : 1;
