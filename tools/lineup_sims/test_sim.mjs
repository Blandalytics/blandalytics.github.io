// Checks on the simulation engine (lineup-sims/sim.js) against the built data file.
//
//   node tools/lineup_sims/test_sim.mjs 2026
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { CATS, prepare, rates, simulate, summarize, tilt } from "../../lineup-sims/sim.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const data = JSON.parse(readFileSync(join(repo, "lineup-sims", "data", `${process.argv[2] ?? "2026"}.json`), "utf8"));
const model = prepare(data);
const only = (cat) => rates(CATS.map((c) => (c === cat ? 1 : 0)));
const nine = (cum) => Array(9).fill(cum);
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

check("every table cell has outcomes", () => {
  model.running.forEach((c, i) => assert.ok(i < 3 ? c === null : c.codes.length, `running ${i}`));
  model.advance.forEach((c, i) => assert.ok(c.codes.length, `advance ${i}`));
});

check("a lineup that only strikes out: about 27 K, next to no runs", () => {
  const r = simulate(model, nine(only("K")), 2000, 1);
  const s = summarize(r.totals, data.weights);
  // a few strikeouts end with the batter safe at first on a wild pitch or passed ball
  assert.ok(s.K >= 27 && s.K < 27.3, `K ${s.K}`);
  assert.equal(s.PA27, s.K);
  assert.ok(s.R < 0.05, `R ${s.R}`);
  assert.equal(s.AVG, 0);
  assert.equal(r.capped, 0);
});

check("a lineup that only homers is called off instead of running forever", () => {
  const r = simulate(model, nine(only("HR")), 3, 1);
  assert.equal(r.capped, 27);
});

check("same seed, same result; different seed, different result", () => {
  const lineup = data.mlb.spots.map((s) => rates(s.counts));
  const a = simulate(model, lineup, 2000, 7), b = simulate(model, lineup, 2000, 7), c = simulate(model, lineup, 2000, 8);
  assert.deepEqual(a.totals, b.totals);
  assert.notDeepEqual(a.totals, c.totals);
});

check("plate appearances fall from the leadoff spot down", () => {
  const r = simulate(model, data.mlb.spots.map((s) => rates(s.counts)), 20000, 3);
  for (let i = 1; i < 9; i++) assert.ok(r.spotPA[i] < r.spotPA[i - 1], `spot ${i + 1}`);
  // a leadoff hitter bats about 4.6-4.8 times a game; the 9th, about 3.8
  assert.ok(r.spotPA[0] / 20000 > 4.5 && r.spotPA[0] / 20000 < 4.9);
});

check("rate stats come back out as they went in (MLB lineup spots vs actual, within .003)", () => {
  const r = simulate(model, data.mlb.spots.map((s) => rates(s.counts)), 50000, 4);
  const s = summarize(r.totals, data.weights);
  for (const k of ["AVG", "OBP", "SLG", "wOBA"]) assert.ok(Math.abs(s[k] - data.mlb.actual[k]) < 0.003, `${k} ${s[k]} vs ${data.mlb.actual[k]}`);
  assert.ok(Math.abs(s.R - data.mlb.actual.R) / data.mlb.actual.R < 0.03, `R ${s.R} vs ${data.mlb.actual.R}`);
});

check("regressing toward MLB average pulls a tiny sample in", () => {
  const prior = CATS.map((_, i) => data.mlb.spots.reduce((s, x) => s + x.counts[i], 0));
  const tot = prior.reduce((s, x) => s + x, 0);
  const p = prior.map((x) => x / tot);
  const raw = rates([0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0]); // 2 PA, 2 HR
  const reg = rates([0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0], p, 200);
  assert.equal(raw[5], 0);
  assert.ok(reg[6] - reg[5] < 0.05, "HR share after adding 200 PA");
});

check("contact vs power keeps each MLB-average spot's wOBA and moves K%, BB%, AVG, SLG the right way", () => {
  const T = data.tradeoff, w = data.weights;
  const wv = [0, w.wBB, w.wHBP, w.w1B, w.w2B, w.w3B, w.wHR, 0, 0, 0, 0];
  const line = (p) => {
    const n = p.reduce((s, x) => s + x, 0);
    const ab = n - p[1] - p[2] - T.sf_per_fb * p[9];
    return { K: p[0] / n, BB: p[1] / n, AVG: (p[3] + p[4] + p[5] + p[6]) / ab,
      SLG: (p[3] + 2 * p[4] + 3 * p[5] + 4 * p[6]) / ab, wOBA: p.reduce((s, x, i) => s + x * wv[i], 0) / n };
  };
  data.mlb.spots.forEach((s, i) => {
    const [con, mid, pow] = [-T.range, 0, T.range].map((th) => tilt(s.counts, T.per_sd, th));
    assert.ok(con.every((x) => x >= 0) && pow.every((x) => x >= 0), `spot ${i + 1} rates stay non-negative`);
    const [c, m, p] = [con, mid, pow].map(line);
    for (const l of [c, p]) assert.ok(Math.abs(l.wOBA - m.wOBA) < 1e-9, `spot ${i + 1} wOBA`);
    assert.ok(c.K < m.K && m.K < p.K, `spot ${i + 1} K%`);
    assert.ok(c.AVG > m.AVG && m.AVG > p.AVG, `spot ${i + 1} AVG`);
    assert.ok(p.SLG > m.SLG && m.SLG > c.SLG, `spot ${i + 1} SLG`);
    assert.ok(p.BB > m.BB && m.BB > c.BB, `spot ${i + 1} BB%`);
  });
  // and in the simulated games
  const pts = data.sims.tradeoff.points;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    assert.ok(b.K > a.K && b.BB > a.BB && b.SLG > a.SLG && b.AVG < a.AVG, `simulated ${a.theta} -> ${b.theta}`);
    assert.ok(Math.abs(b.wOBA - pts[0].wOBA) < 0.002, `simulated wOBA at ${b.theta}`);
  }
});

console.log(`${n} checks passed`);
