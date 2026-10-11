// Score the same projections and settings with auction-calculator/calc.js and compare every
// player's start value (summed z-scores, or points) with run_ref.py's output. The page starts
// its standings-gain (SGP) valuation from these scores and prices from there its own way, so
// the start values are where it and the script still line up.
//
//   node compare.mjs hitters.csv pitchers.csv ref.json      (same ST_OVERRIDES as run_ref.py)
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";

const [hcsv, pcsv, refPath] = process.argv.slice(2);
const o = JSON.parse(process.env.ST_OVERRIDES || "{}");
const g = (k, d) => (k in o ? o[k] : d);
const style = g("League Type", "Categories");
const pool = g("Player pool", "All");
const fa = g("Include FA?", true);
const H = C.prepHitters(C.readProjections(readFileSync(hcsv, "utf8")), pool, fa);
const P = C.prepPitchers(C.readProjections(readFileSync(pcsv, "utf8")), pool, fa);
// The script's Hitters / Catchers / Pitchers as lineup slots: the scores only see the totals
const hitters = g("Hitters", 10), catchers = g("Catchers", 1);
const res = C.auctionValues(H, P, {
  slots: { C: catchers, UT: hitters - catchers }, pitcherSlots: { P: g("Pitchers", 8) }, span: 0,
  bench: g("Bench spots", 5), minimizeBench: g("Minimize bench value", true), style, teams: g("Number of Teams", 12),
  minBid: g("Min bid", 1), budget: g("Team Budget", 260),
  hitterCats: g("Hitter categories", C.DEFAULT_HITTER_CATS), pitcherCats: g("Pitcher categories", C.DEFAULT_PITCHER_CATS),
  hitterPoints: g("h", C.DEFAULT_HITTER_POINTS), pitcherPoints: g("p", C.DEFAULT_PITCHER_POINTS),
});

const ref = JSON.parse(readFileSync(refPath, "utf8"));
const key = (name, team, side) => `${name}|${team}|${side}`;
const mine = new Map(res.players.map((p) => [key(p.name, p.team, p.type), p]));
let worst = 0, missing = 0;
for (const r of ref) {
  const p = mine.get(key(r.name, r.team, r.side));
  if (!p) { missing++; continue; }
  const d = Math.abs(r.score - p.start);
  if (d > 1e-6) console.log(`  ${r.name}: script ${r.score.toFixed(4)}, page ${p.start.toFixed(4)}`);
  worst = Math.max(worst, d);
}
const ok = ref.length === res.players.length && !missing && worst < 1e-6;
console.log(`${ok ? "OK" : "MISMATCH"}: ${res.players.length} players (script ${ref.length}), ${missing} unmatched, `
  + `max score diff ${worst.toExponential(1)}`);
process.exit(ok ? 0 : 1);
