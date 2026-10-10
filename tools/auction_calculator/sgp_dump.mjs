// Value one league with calc.js and write the last pass's workings (pool, draft order,
// contributions, weights) as JSON for sgp_check.py to recompute independently.
//
//   node sgp_dump.mjs hitters.csv pitchers.csv '<settings JSON>' > dump.json
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";

const [hcsv, pcsv, extra] = process.argv.slice(2);
const s = {
  teams: 12, slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 2 }, pitcherSlots: { SP: 2, RP: 2, P: 4 },
  bench: 5, minimizeBench: true, style: "Categories", format: "roto", weeks: 23, minBid: 1, budget: 260, span: 3,
  hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS, ...JSON.parse(extra || "{}"), debug: true,
};
const H = C.prepHitters(C.readProjections(readFileSync(hcsv, "utf8")), "All", true);
const P = C.prepPitchers(C.readProjections(readFileSync(pcsv, "utf8")), "All", true);
const res = C.auctionValues(H, P, s);
const side = (d, cats) => ({
  cats, pool: d.inPool.flatMap((x, i) => (x ? [i] : [])), poolSlot: d.poolSlot, order: d.order,
  own: d.own, x: d.x, G: d.G, averaged: d.averaged, sigmaDraft: d.sigmaDraft, nu: d.nu, rates: d.rates, score: d.score, sgpar: d.sgpar,
  valuedAt: d.byPos.valuedAt, levels: d.byPos.levels.map((l) => ({ slot: l.slot, level: l.level, vec: l.vec })),
  caps: d.caps, finalSlot: d.byPos.slot,
});
process.stdout.write(JSON.stringify({
  settings: s, h: side(res.debug.h, s.hitterCats), p: side(res.debug.p, s.pitcherCats),
}, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
