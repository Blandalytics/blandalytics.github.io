// Checks that every league prices exactly its roster spots (lineups, plus the bench unless it is
// minimized) at the min bid or more, costing exactly teams × budget (less a minimized bench's min
// bids, which it's drafted at), on rosters that fill every slot
// legally; that the Slot column agrees with who is drafted; and that each player's value breakdown
// adds back up to his dollars; that bid prices toward a market split keep the count and the budget;
// and that the valuation settled.
//
//   node invariants.mjs hitters.csv pitchers.csv
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";
const raw = { h: C.readProjections(readFileSync(process.argv[2], "utf8")), p: C.readProjections(readFileSync(process.argv[3], "utf8")) };
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const fmts = {
  Yahoo: [12, { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 2 }, { SP: 2, RP: 2, P: 4 }],
  ESPN: [10, { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, { P: 9 }],
  CBS: [12, { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 1 }, { SP: 5, RP: 2 }],
  NFBC: [15, { C: 2, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, { P: 9 }],
  noUT: [12, { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 5 }, { SP: 6, RP: 3 }],
};
const variants = [
  {}, { span: 0 }, { span: 6 }, { bench: 0 }, { bench: 7, minimizeBench: false }, { minBid: 0 }, { minBid: 2, budget: 300 },
  { style: "Points", hitterPoints: C.DEFAULT_HITTER_POINTS, pitcherPoints: C.DEFAULT_PITCHER_POINTS },
  { pool: "AL-Only" }, { pool: "NL-Only", includeFa: false }, { span: 3, bench: 0, teams: 15 }, { span: 1, minimizeBench: false, bench: 2 },
  { hitterCats: ["R", "HR", "RBI", "SB", "OBP", "K%"], pitcherCats: ["K/BB", "W+QS", "ERA", "WHIP", "SV+H"] },
  { format: "h2h" }, { format: "allplay", weeks: 20 }, { fillPT: false }, { specialists: false }, { marketHitterShare: 0.63 },
];
let fails = 0, runs = 0;
for (const [name, [teams, slots, pitcherSlots]] of Object.entries(fmts)) for (const v of variants) {
  const s = { slots, pitcherSlots, hitters: sum(slots), pitchers: sum(pitcherSlots),
    bench: 5, minimizeBench: true, style: "Categories", format: "roto", weeks: 23, teams, minBid: 1, budget: 260, span: 3,
    hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS, pool: "All", includeFa: true, ...v };
  const H = C.prepHitters(raw.h, s.pool, s.includeFa), P = C.prepPitchers(raw.p, s.pool, s.includeFa);
  const res = C.auctionValues(H, P, s);
  const effBench = s.minimizeBench ? 0 : s.bench;
  const spots = s.teams * (s.hitters + s.pitchers + effBench);
  // what the priced players cost: the budget, less a minimized bench's min bids (it's drafted at them)
  const budget = s.teams * s.budget - s.teams * (s.bench - effBench) * s.minBid;
  const atMin = res.players.filter((p) => p.value >= s.minBid - 1e-9);
  const total = atMin.reduce((a, p) => a + p.value, 0);
  const drafted = res.players.filter((p) => p.drafted);
  const sameSet = atMin.length === drafted.length && atMin.every((p) => p.drafted);
  // legal: each side's drafted players fill its slots (plus its bench share)
  const benchH = Math.floor(s.teams * effBench / 2);
  const legal = ["h", "p"].every((side) => {
    const T = side === "h" ? C.SLOT_TYPES : C.PITCHER_SLOT_TYPES;
    const ps = res.players.filter((p) => p.type === side && p.drafted);
    const per = side === "h" ? slots : pitcherSlots;
    const caps = Object.fromEntries(Object.entries(per).map(([t, n]) => [t, s.teams * n]));
    const any = side === "h" ? "UT" : "P";
    caps[any] = (caps[any] || 0) + (side === "h" ? benchH : s.teams * effBench - benchH);
    const r = C.positionReplacement(ps.map(() => 1), ps.map((p) => p.pos), caps, T, 0);
    return r.slot.every((x) => x !== null) && ps.length === sum(caps);
  });
  const slotsAgree = res.players.every((p) => p.drafted === (p.slot !== null));
  // bid prices (moved toward a market split) keep the same players at the min bid or more, and the budget
  const bidsAt = res.players.filter((p) => p.bid >= s.minBid - 1e-9);
  const bidsOk = bidsAt.length === spots && Math.abs(bidsAt.reduce((a, p) => a + p.bid, 0) - budget) < 1e-6
    && (s.marketHitterShare == null || Math.abs(res.players.filter((p) => p.drafted && p.type === "h").reduce((a, p) => a + p.bid - s.minBid, 0)
      - s.marketHitterShare * (budget - spots * s.minBid)) < 1e-6);
  // the breakdown adds back up to every player's dollars
  const parts = (b) => b.minBid + Object.values(b.stats).reduce((a, v) => a + v, 0) + b.baseline + b.position + b.fill + b.specialist + b.other;
  const adds = res.players.every((p) => (p.breakdown ? Math.abs(parts(p.breakdown) - p.value) < 1e-6 : Number.isNaN(p.value)));
  const ok = atMin.length === spots && Math.abs(total - budget) < 1e-6 && sameSet && legal && slotsAgree && adds && bidsOk && res.converged;
  runs++;
  if (!ok) { fails++; console.log(`FAIL ${name} ${JSON.stringify(v)}: ${atMin.length} at min bid+ (spots ${spots}), total $${total.toFixed(4)} (budget ${budget}), same set ${sameSet}, legal ${legal}, slots agree ${slotsAgree}, breakdown adds up ${adds}, bids ${bidsOk}, settled ${res.converged}`); }
}
console.log(`${fails ? "FAIL" : "OK"}: ${runs} leagues, ${fails} failing`);
process.exit(fails ? 1 : 0);
