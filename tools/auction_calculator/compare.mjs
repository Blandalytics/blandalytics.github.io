// Price the same projections and settings with auction-calculator/calc.js and compare
// every player with run_ref.py's output.
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
const res = C.auctionValues(H, P, {
  positions: "catchers", dollars: "script",   // the script's split and dollars; the rest is the page's own
  hitters: g("Hitters", 10), pitchers: g("Pitchers", 8), catchers: g("Catchers", 1), bench: g("Bench spots", 5),
  minimizeBench: g("Minimize bench value", true), style, teams: g("Number of Teams", 12), minBid: g("Min bid", 1),
  budget: g("Team Budget", 260), hitterSplit: g("Hitter Split (%)", style === "Categories" ? 65 : 50) / 100,
  hitterCats: g("Hitter categories", C.DEFAULT_HITTER_CATS), pitcherCats: g("Pitcher categories", C.DEFAULT_PITCHER_CATS),
  hitterPoints: g("h", C.DEFAULT_HITTER_POINTS), pitcherPoints: g("p", C.DEFAULT_PITCHER_POINTS),
});

const ref = JSON.parse(readFileSync(refPath, "utf8"));
const key = (name, team, isP) => `${name}|${team}|${isP}`;
const mine = new Map(res.players.map((p) => [key(p.name, p.team, p.type === "p"), p]));
let worst = 0, worstRank = 0, missing = 0, nanMismatch = 0;
for (const r of ref) {
  const p = mine.get(key(r.Name, r.Team ?? "", r["Y! Pos"] === "P"));
  if (!p) { missing++; continue; }
  if ((r.Value === null) !== Number.isNaN(p.value)) { nanMismatch++; continue; }
  if (r.Value === null) continue;
  if (Math.abs(r.Value - p.value) > 0.005) console.log(`  ${r.Name}: script $${r.Value.toFixed(2)}, page $${p.value.toFixed(2)}`);
  worst = Math.max(worst, Math.abs(r.Value - p.value));
  worstRank = Math.max(worstRank, Math.abs(r.Rank - p.rank));
}
const ok = ref.length === res.players.length && !missing && !nanMismatch && worst < 0.005;
console.log(`${ok ? "OK" : "MISMATCH"}: ${res.players.length} players (script ${ref.length}), ${missing} unmatched, `
  + `${nanMismatch} blank on one side only, max $ diff ${worst.toExponential(1)}, max rank diff ${worstRank}`);
process.exit(ok ? 0 : 1);
