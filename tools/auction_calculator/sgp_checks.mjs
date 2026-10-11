// The generalized-SGP procedure's validation checks (Task 13), run against calc.js:
//   1. constant: add a little to one of N normal team totals, and the standings points it buys
//      match (N − 1) / (2√π σ) within 2%;
//   2. tiers: snake drafts with ADP noise spread team totals as the tier formula says, within 5%;
//   3. order: who moved more than 20 places against the z-score order, and why (a report).
//
//   node sgp_checks.mjs hitters.csv pitchers.csv ['<settings JSON>']
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";

const [hcsv, pcsv, extra] = process.argv.slice(2);
const s = {
  teams: 12, slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 2 }, pitcherSlots: { SP: 2, RP: 2, P: 4 },
  bench: 5, minimizeBench: true, style: "Categories", format: "roto", weeks: 23, minBid: 1, budget: 260, span: 3,
  hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS, ...JSON.parse(extra || "{}"), debug: true,
};
const N = s.teams;
let ok = true;

// A seeded normal generator, so a run repeats exactly
let seed = 20261010;
const uniform = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());

// 1. The constant
{
  const sigma = 50, eps = 0.5, leagues = 400000;
  let gain = 0;
  for (let l = 0; l < leagues; l++) {
    const me = normal() * sigma;
    for (let j = 1; j < N; j++) {
      const other = normal() * sigma;
      gain += (me + eps > other) - (me > other);
    }
  }
  const measured = gain / leagues / eps, formula = (N - 1) / (2 * Math.sqrt(Math.PI) * sigma);
  const err = Math.abs(measured / formula - 1);
  ok &&= err < 0.02;
  console.log(`${err < 0.02 ? "ok " : "BAD"} constant: ${measured.toFixed(5)} standings points per unit measured, ${formula.toFixed(5)} by formula (${(100 * err).toFixed(1)}% off)`);
}

// 2. Tiers against simulated snake drafts
const H = C.prepHitters(C.readProjections(readFileSync(hcsv, "utf8")), "All", true);
const P = C.prepPitchers(C.readProjections(readFileSync(pcsv, "utf8")), "All", true);
const res = C.auctionValues(H, P, s);
for (const [side, cats] of [["h", s.hitterCats], ["p", s.pitcherCats]]) {
  const d = res.debug[side];
  const pool = d.inPool.flatMap((x, i) => (x ? [i] : []));
  const groups = side === "h" && (s.slots.C || 0) > 0
    ? [pool.filter((i) => d.poolSlot[i] === "C"), pool.filter((i) => d.poolSlot[i] !== "C")] : [pool];
  const drafts = 3000;
  const sums = cats.map(() => 0), sq = cats.map(() => 0);
  for (let t = 0; t < drafts; t++) {
    const totals = cats.map(() => new Float64Array(N));
    for (const g of groups) {
      // each draft: the group in value order, jostled by ADP noise, taken in snake order
      const ranked = g.slice().sort((a, b) => d.order[b] - d.order[a]);
      const noisy = ranked.map((i, r) => ({ i, key: r + normal() * (2 + 0.1 * r) })).sort((a, b) => a.key - b.key);
      const rounds = Math.floor(noisy.length / N);
      for (let r = 0; r < rounds; r++) {
        for (let pick = 0; pick < N; pick++) {
          const team = r % 2 ? N - 1 - pick : pick;
          const i = noisy[r * N + pick].i;
          cats.forEach((_, k) => { totals[k][team] += d.x[k][i]; });
        }
      }
    }
    cats.forEach((_, k) => {
      const m = totals[k].reduce((a, v) => a + v, 0) / N;
      const v = totals[k].reduce((a, x) => a + (x - m) ** 2, 0) / (N - 1);
      sums[k] += v;
    });
  }
  cats.forEach((cat, k) => {
    const simulated = Math.sqrt(sums[k] / drafts), tier = Math.sqrt(d.sigmaDraft[k]);
    const err = Math.abs(tier / simulated - 1);
    ok &&= err < 0.05;
    console.log(`${err < 0.05 ? "ok " : "BAD"} tiers ${cat}: team-total SD ${simulated.toFixed(2)} in ${drafts} snake drafts, ${tier.toFixed(2)} by tiers (${(100 * err).toFixed(1)}% off)`);
  });
}

// 3. Order against the z-score start values, within each side (a report: each big move should
// have a reason). Among the drafted players (below the pool, the playing time fill puts every
// nobody at about replacement, so ranks there mean little), and who came in or went out.
{
  const why = (p) => {
    const b = p.breakdown, out = [];
    if (Math.abs(b.fill) >= 2) out.push(`playing time ${b.fill > 0 ? "+" : "−"}$${Math.abs(b.fill).toFixed(0)}`);
    if (Math.abs(b.specialist) >= 1) out.push(`specialist −$${Math.abs(b.specialist).toFixed(0)}`);
    const [cat, v] = Object.entries(b.stats).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0];
    out.push(`${cat} ${v > 0 ? "+" : "−"}$${Math.abs(v).toFixed(0)}`);
    return out.join(", ");
  };
  for (const side of ["h", "p"]) {
    const ps = res.players.filter((p) => p.type === side);
    const n = ps.filter((p) => p.drafted).length;
    const byZ = [...ps].sort((a, b) => b.start - a.start);
    const zTop = new Set(byZ.slice(0, n));
    const zRank = new Map(byZ.map((p, r) => [p, r + 1]));
    const drafted = ps.filter((p) => p.drafted).sort((a, b) => b.value - a.value);
    const both = drafted.filter((p) => zTop.has(p));
    const zOrder = new Map([...both].sort((a, b) => b.start - a.start).map((p, r) => [p, r + 1]));
    const vOrder = new Map(both.map((p, r) => [p, r + 1]));
    const movers = both.map((p) => ({ p, move: zOrder.get(p) - vOrder.get(p) })).filter((m) => Math.abs(m.move) > 20)
      .sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
    const label = side === "h" ? "hitters" : "pitchers";
    console.log(`order ${label}: of ${n} drafted, ${both.length} are in the z-score top ${n}; ${movers.length} of them moved more than 20 places`);
    for (const { p, move } of movers.slice(0, 8)) {
      const vol = side === "h" ? `${Math.round(p.stats.PA)} PA` : `${Math.round(p.stats.IP)} IP`;
      console.log(`    ${move > 0 ? "up  " : "down"} ${String(Math.abs(move)).padStart(3)}  ${p.name.padEnd(22)} ${p.pos.padEnd(8)} ${vol.padEnd(7)} $${p.value.toFixed(0).padStart(3)}  (${why(p)})`);
    }
    const cameIn = drafted.filter((p) => !zTop.has(p));
    const wentOut = byZ.slice(0, n).filter((p) => !p.drafted);
    console.log(`  in (not in the z-score top ${n}): ${cameIn.slice(0, 10).map((p) => `${p.name} z#${zRank.get(p)} (${why(p)})`).join("; ")}`);
    console.log(`  out: ${wentOut.slice(0, 10).map((p) => `${p.name} z#${zRank.get(p)} (${why(p)})`).join("; ")}`);
  }
}
console.log(ok ? "OK" : "FAIL");
process.exit(ok ? 0 : 1);
