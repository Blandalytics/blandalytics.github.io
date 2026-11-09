// Checks the fast bootstrap (engine.js bootstrap) against the reference (bootstrapRef) on the same random draws,
// and times it. Same seed means the same day draws in both, so replicate by replicate they should agree.
//   node check_bootstrap.js <season file> [reps] [day]
"use strict";
const fs = require("fs"), path = require("path");
const E = require(path.join(__dirname, "../../player-rater/engine.js"));
const file = process.argv[2], reps = +(process.argv[3] || 40);
const raw = JSON.parse(fs.readFileSync(file, "utf8")), db = E.prepare(raw), S = E.YAHOO_DEFAULT;
const b = process.argv[4] != null ? +process.argv[4] : db.ndays - 1;
const point = E.valuate(db, S, 0, b);
const pointSgpar = new Map([...point.h.rows, ...point.p.rows].map((r) => [r.key, r.sgpar]));
const rostered = new Set([...point.h.rows, ...point.p.rows].filter((r) => r.slot).map((r) => r.key));

// per replicate SGPAR from each, for players in the point pool
const ref = [], fast = [];
E.bootstrapRef(db, S, 0, b, { reps, seed: 7, point, onReplicate: (i, rep, act) => {
  const m = new Map(); for (const g of ["h", "p"]) for (const r of act[g].rows) m.set(r.key, r.sgpar); ref.push(m);
} });
E.bootstrap(db, S, 0, b, { reps, seed: 7, point, prune: process.env.PRUNE !== "0", onReplicate: (i, d) => {
  const m = new Map(); for (const g of ["h", "p"]) { const x = d[g]; x.keys.forEach((k, p) => m.set(k, x.sgpar[p])); } fast.push(m);
} });
const diffs = [];
let worst = { d: 0 };
for (let i = 0; i < reps; i++) for (const k of rostered) {
  const d = Math.abs(ref[i].get(k) - fast[i].get(k)); diffs.push(d);
  if (d > worst.d) worst = { d, k, i };
}
diffs.sort((x, y) => x - y);
const pct = (f) => diffs[Math.floor((diffs.length - 1) * f)];
console.log(`day ${b}, ${reps} replicates, rostered players: |fast - reference| SGPAR median ${pct(0.5).toFixed(4)}, 95th ${pct(0.95).toFixed(4)}, 99th ${pct(0.99).toFixed(4)}, max ${worst.d.toFixed(3)} (replicate ${worst.i}); exact (< 1e-6): ${(diffs.filter((d) => d < 1e-6).length / diffs.length * 100).toFixed(1)}%`);

// intervals: fast vs reference at the same seed (different code, same draws)
const keys = ["Cristopher Sánchez", "Jacob Misiorowski", "Pete Crow-Armstrong", "Cal Raleigh", "Logan Webb"].map((nm) => [...point.h.rows, ...point.p.rows].filter((r) => r.name === nm).sort((x, y) => y.dollars - x.dollars)[0]).filter(Boolean);
const cf = E.bootstrap(db, S, 0, b, { reps: 300, seed: 11, point }), cr = E.bootstrapRef(db, S, 0, b, { reps: 300, seed: 11, point });
for (const r of keys) { const f = cf.get(r.key), q = cr.get(r.key); console.log(`  ${r.name.padEnd(20)} $${r.dollars.toFixed(1)}  fast [${f.lo.toFixed(2)}, ${f.hi.toFixed(2)}]  reference [${q.lo.toFixed(2)}, ${q.hi.toFixed(2)}]`); }

// timing
for (const R of [1000]) {
  const t = process.hrtime.bigint();
  E.bootstrap(db, S, 0, b, { reps: R, point });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`fast: ${R} replicates in ${ms.toFixed(0)} ms (${(ms / R).toFixed(2)} ms each), one thread`);
}
if (process.env.DEBUG) {
  const byKey = new Map([...point.h.rows, ...point.p.rows].map((r) => [r.key, r]));
  const bad = {}; for (let i = 0; i < reps; i++) for (const k of rostered) if (Math.abs(ref[i].get(k) - fast[i].get(k)) > 1e-6) { const g = byKey.get(k).g; bad[g] = bad[g] || new Set(); bad[g].add(i); }
  console.log("replicates with differences by pool:", Object.fromEntries(Object.entries(bad).map(([g, s]) => [g, [...s].join(",")])));
}
