// Value one league with calc.js and write the last pass's workings (pool, draft order,
// contributions, weights, positions) as JSON for sgp_check.py to recompute independently. With an
// eligibility file, positions come from last season's games, by settings.eligibility (Yahoo's
// thresholds unless it says otherwise).
//
//   node sgp_dump.mjs hitters.csv pitchers.csv '<settings JSON>' [position_eligibility.csv] > dump.json
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";

const [hcsv, pcsv, extra, ecsv] = process.argv.slice(2);
const s = {
  teams: 12, slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 2 }, pitcherSlots: { SP: 2, RP: 2, P: 4 },
  bench: 5, minimizeBench: true, style: "Categories", format: "roto", weeks: 23, minBid: 1, budget: 260, span: 3,
  hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS, ...JSON.parse(extra || "{}"), debug: true,
};
if (ecsv) s.eligibility = { ...C.YAHOO_ELIGIBILITY, ...s.eligibility };
const elig = ecsv ? { table: C.readProjections(readFileSync(ecsv, "utf8")), rules: s.eligibility } : null;
const H = C.prepHitters(C.readProjections(readFileSync(hcsv, "utf8")), "All", true, elig);
const P = C.prepPitchers(C.readProjections(readFileSync(pcsv, "utf8")), "All", true, elig);
const res = C.auctionValues(H, P, s);
const side = (d, cats, T, none) => ({
  cats, pos: (T.data["Y! Pos"] || new Array(T.n).fill(null)).map((x) => x ?? none), pool: d.inPool.flatMap((x, i) => (x ? [i] : [])), poolSlot: d.poolSlot, order: d.order,
  own: d.own, x: d.x, G: d.G, averaged: d.averaged, sigmaDraft: d.sigmaDraft, nu: d.nu, rates: d.rates, score: d.score, sgpar: d.sgpar,
  valuedAt: d.byPos.valuedAt, levels: d.byPos.levels.map((l) => ({ slot: l.slot, level: l.level, vec: l.vec })),
  caps: d.caps, finalSlot: d.byPos.slot, kappa: d.lock && d.lock.kappa ? d.lock.kappa : null,
});
process.stdout.write(JSON.stringify({
  settings: s, h: side(res.debug.h, s.hitterCats, H, "UT"), p: side(res.debug.p, s.pitcherCats, P, "P"), lock: res.lock,
}, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
