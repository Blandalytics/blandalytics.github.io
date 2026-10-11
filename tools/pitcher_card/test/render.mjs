// pitcher-cards/card.js against golden SVGs, byte for byte. The goldens are what the
// Python renderer card.js was ported from (render.py before the card dict carried numbers)
// drew for three real cards, whose v2 dicts sit beside them:
//
//   823084-669302  Logan Gilbert: a start, seven pitch types, four comparison seasons
//   823084-684665  Luke Murphy: one pitch in relief, no left-handed batter
//   849832-607200  Erick Fedde: a postseason relief outing, no arm angle, a sinker
//
//   node tools/pitcher_card/test/render.mjs            # check
//   node tools/pitcher_card/test/render.mjs --update   # rewrite the goldens from card.js
//
// --update is for an intentional change to the card's drawing: look at the cards it says
// changed, then commit the new goldens with the change. Each card is also checked to be
// well-formed XML with nothing like "undefined" or "NaN" leaking into it.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARDS = path.join(HERE, "cards");
const require = createRequire(import.meta.url);
const PitcherCard = require(path.join(HERE, "..", "..", "..", "pitcher-cards", "card.js"));
const update = process.argv.includes("--update");

let failed = 0;
function check(label, ok, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");

// Well-formedness, without a parser: every tag balanced, attributes quoted, no stray '<'
// and no '&' that is not an entity. Returns the first problem, or null.
const ENTITY = "&(?:amp|lt|gt|quot|apos|#\\d+|#x[\\da-fA-F]+);";
const BARE_AMP = new RegExp(`&(?!${ENTITY.slice(1)})`);
const ENTITY_HERE = new RegExp(`^${ENTITY}`);
function xmlProblem(s) {
  if (!s.startsWith("<svg ") || !s.endsWith("</svg>")) return "not one <svg> element";
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<|&/g;
  const open = [];
  let m;
  while ((m = tag.exec(s))) {
    if (m[0] === "<") return `stray '<' at ${m.index}`;
    if (m[0] === "&") {
      if (!ENTITY_HERE.test(s.slice(m.index, m.index + 12))) return `bare '&' at ${m.index}`;
      continue;
    }
    if (BARE_AMP.test(m[3])) return `bare '&' in <${m[2]}> at ${m.index}`;
    if (m[1]) {
      if (open.pop() !== m[2]) return `</${m[2]}> at ${m.index} closes nothing open`;
    } else if (!m[4]) {
      open.push(m[2]);
    }
    if (!open.length && tag.lastIndex !== s.length) return `content after the root at ${tag.lastIndex}`;
  }
  return open.length ? `<${open.pop()}> never closed` : null;
}

// ---- the cards ------------------------------------------------------------------------
console.log("cards");
const names = fs.readdirSync(CARDS).filter((f) => f.endsWith(".json.gz")).sort();
check("there are cards to test", names.length > 0);
for (const name of names) {
  const id = name.slice(0, -".json.gz".length);
  const card = JSON.parse(gunzip(path.join(CARDS, name)));
  const svg = PitcherCard.svg(card); // card.js's own logo, as the goldens were drawn with
  const goldenPath = path.join(CARDS, `${id}.svg.gz`);
  const golden = fs.existsSync(goldenPath) ? gunzip(goldenPath) : null;
  check(`${id} is well-formed XML`, xmlProblem(svg) === null, xmlProblem(svg));
  const leak = /undefined|NaN|\bnull\b|\[object|Infinity/.exec(svg);
  check(`${id} has no undefined / NaN / null`, !leak, leak && svg.slice(leak.index - 60, leak.index + 20));
  if (update) {
    if (svg !== golden) {
      fs.writeFileSync(goldenPath, zlib.gzipSync(Buffer.from(svg, "utf8"), { level: 9 }));
      console.log(`  UPDATED  ${id}.svg.gz`);
    }
    continue;
  }
  let i = 0;
  while (golden !== null && i < svg.length && svg[i] === golden[i]) i++;
  check(`${id} matches its golden`, svg === golden,
    golden === null ? "no golden; run with --update" :
      `first difference at ${i}:\n        got    ${svg.slice(Math.max(0, i - 60), i + 60)}\n        golden ${golden.slice(Math.max(0, i - 60), i + 60)}`);
}

// ---- the formatting is Python's -------------------------------------------------------
// f"{v:.Nf}" and round(): exact binary ties go to even, the sign survives rounding to zero
console.log("formatting");
const FIXED = [
  [0.125, 2, "0.12"], [0.375, 2, "0.38"], [2.5, 0, "2"], [3.5, 0, "4"], [-2.5, 0, "-2"],
  [-0.0, 1, "-0.0"], [-0.04, 1, "-0.0"], [1.005, 2, "1.00"], [2.675, 2, "2.67"],
  [0.0625, 3, "0.062"], [1e21, 1, "1000000000000000000000.0"], [5e-324, 3, "0.000"],
  [97.9000015258789, 1, "97.9"], [0.1 + 0.2, 16, "0.3000000000000000"],
];
for (const [v, n, want] of FIXED) {
  check(`fixed(${Object.is(v, -0) ? "-0" : v}, ${n}) = ${want}`, PitcherCard.fixed(v, n) === want, PitcherCard.fixed(v, n));
}
const ROUND = [[32.5, 32], [33.5, 34], [-0.4, 0], [-2.5, -2], [0.49999999999999994, 0], [101.5, 102]];
for (const [v, want] of ROUND) {
  check(`pyRound(${v}) = ${want}`, Object.is(PitcherCard.pyRound(v), want), PitcherCard.pyRound(v));
}

// ---- the page helpers -----------------------------------------------------------------
console.log("helpers");
const gilbert = JSON.parse(gunzip(path.join(CARDS, "823084-669302.json.gz")));
const years = gilbert.comparisons.map((c) => c.year);
check("comparisonYear defaults to the latest season", PitcherCard.comparisonYear(gilbert, null) === years[0]);
check("comparisonYear keeps a season the card has", PitcherCard.comparisonYear(gilbert, years[2]) === years[2]);
check("comparisonYear keeps 0 (no comparison)", PitcherCard.comparisonYear(gilbert, 0) === 0);
check("comparisonYear swaps an unknown season for the latest", PitcherCard.comparisonYear(gilbert, 1999) === years[0]);
check("comparisonYear without seasons is 0", PitcherCard.comparisonYear({ ...gilbert, comparisons: [] }, null) === 0);
check("filename", PitcherCard.filename(gilbert) === "Logan_Gilbert_2026-09-27_SEA_LAA_PLV_card.png", PitcherCard.filename(gilbert));
let threw = false;
try { PitcherCard.svg({ ...gilbert, version: 1 }); } catch { threw = true; }
check("a dict of another version is refused", threw);

console.log(failed ? `${failed} failed` : update ? "goldens up to date" : "all passed");
process.exit(failed ? 1 : 0);
