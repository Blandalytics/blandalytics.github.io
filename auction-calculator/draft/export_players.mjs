// The draft engine's player table from two auction CSVs, with the calculator's own model and its
// default settings (the Yahoo 5x5 roto league, as app.js builds them). For the engine's tests and
// dry runs; the page builds the same table from the result it already has (table.js).
//
//   node export_players.mjs hitters_auction_ev.csv pitchers_auction_ev.csv out.json ['<settings JSON>']
import { readFileSync, writeFileSync } from "node:fs";
import * as C from "../calc.js";
import { draftTable } from "./table.js";

export const DEFAULTS = {
  slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 0, MI: 0, OF: 3, UT: 2 },
  pitcherSlots: { SP: 2, RP: 2, P: 4 },
  teams: 12, bench: 5, minimizeBench: true, span: 3, style: "Categories", format: "roto", weeks: 23,
  minBid: 1, budget: 260, pool: "All", includeFa: true, phi: 1, ptCV: 0.15, fillPT: true, specialists: true,
  curve: 1.05, hitterShare: 0.65, lock: "daily", twoWay: "split",
  hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS,
  hitterPoints: C.DEFAULT_HITTER_POINTS, pitcherPoints: C.DEFAULT_PITCHER_POINTS,
};

const [hPath, pPath, outPath, extra] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: node export_players.mjs hitters.csv pitchers.csv out.json ['<settings JSON>']");
  process.exit(2);
}
const read = (p) => C.readProjections(readFileSync(p, "utf8"));
const s0 = { ...DEFAULTS, ...JSON.parse(extra || "{}") };
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const s = { ...s0, hitters: total(s0.slots), pitchers: total(s0.pitcherSlots) };
const H = C.prepHitters(read(hPath), s.pool, s.includeFa);
const P = C.prepPitchers(read(pPath), s.pool, s.includeFa);
const t0 = Date.now();
const result = C.auctionValues(H, P, s);
const table = draftTable(result, H, P, s);
writeFileSync(outPath, JSON.stringify(table));
console.log(`${table.players.length} players, calc.js ${Date.now() - t0} ms -> ${outPath}`);
