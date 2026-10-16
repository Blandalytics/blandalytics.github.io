// Checks on the simulation engine (lineup-sims/sim.js) against the built data file.
//
//   node tools/lineup_sims/test_sim.mjs 2026
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { CATS, cumulative, log5, prepare, rates, simulate, summarize, tilt } from "../../lineup-sims/sim.js";
import { chainTables, expectedLine, expectedRuns, hitterBlock, lineupRuns, matchup, optimize } from "../../lineup-sims/markov.js";

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

// ---- the optimizer's exact expected runs (markov.js) ----
const chain = chainTables(model);
const probs = (counts) => { const t = counts.reduce((s, x) => s + x, 0); return counts.map((x) => x / t); };
const exact = (profiles) => expectedRuns(chain, profiles.map((p) => hitterBlock(chain, p)));
const T = data.tradeoff, axis = { perSd: T.per_sd, range: T.range };

check("exact expected runs agree with the simulation", () => {
  const mlb = exact(data.mlb.spots.map((s) => probs(s.counts)));
  assert.ok(Math.abs(mlb - data.sims.mlb.R) < 0.02, `MLB spots: exact ${mlb} vs simulated ${data.sims.mlb.R}`);
  const diffs = data.teams.map((t) => exact(t.spots.map((s) => probs(s.counts))) - data.sims.teams[t.abbr].spots.R);
  const mean = diffs.reduce((a, d) => a + d, 0) / diffs.length;
  assert.ok(Math.abs(mean) < 0.01, `teams: mean difference ${mean}`);
  assert.ok(Math.max(...diffs.map(Math.abs)) < 0.04, "teams: largest difference");
});

check("the optimizer matches brute force: settings of three spots with the total fixed", () => {
  const lineup = data.mlb.spots.map((s) => ({ base: s.counts, theta: 0 }));
  let best = -1;
  for (let a = -30; a <= 30; a++) {
    for (let b = -30; b <= 30; b++) {
      const c = -a - b;
      if (c < -30 || c > 30) continue;
      const th = [0, a, b, c, 0, 0, 0, 0, 0];
      best = Math.max(best, exact(data.mlb.spots.map((s, i) => tilt(s.counts, T.per_sd, th[i] / 10))));
    }
  }
  const r = optimize(chain, lineup, { order: false, tilt: true, mix: "same", locked: [0, 4, 5, 6, 7, 8], ...axis });
  assert.ok(r.after >= best - 1e-9, `optimizer ${r.after} vs brute force ${best}`);
});

check("the optimizer matches brute force: batting order of five spots", () => {
  const team = data.teams.find((t) => t.abbr === "NYY").spots.map((s) => ({ probs: probs(s.counts) }));
  const blocks = team.map((h) => hitterBlock(chain, h.probs));
  let best = -1;
  const perm = (arr, k = 0) => {
    if (k === arr.length) {
      best = Math.max(best, expectedRuns(chain, [0, 1, ...arr, 7, 8].map((h) => blocks[h])));
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm([2, 3, 4, 5, 6]);
  const r = optimize(chain, team, { order: true, tilt: false, locked: [0, 1, 7, 8], ...axis });
  assert.ok(r.after >= best - 1e-9, `optimizer ${r.after} vs brute force ${best}`);
});

check("the optimizer keeps locked spots, the total setting, and the sliders' range", () => {
  const start = data.mlb.spots.map((s, i) => ({ base: s.counts, theta: [0.5, -1, 0, 2, 0, 0, -0.5, 1, 0][i] }));
  const total = start.reduce((t, h) => t + h.theta, 0);
  const r = optimize(chain, start, { order: true, tilt: true, mix: "same", locked: [0, 3], ...axis });
  assert.equal(r.slot[0], 0);
  assert.equal(r.slot[3], 3);
  assert.equal(r.theta[0], 0.5);
  assert.equal(r.theta[3], 2);
  assert.ok(Math.abs(r.theta.reduce((t, x) => t + x, 0) - total) < 1e-9, "total setting");
  assert.ok(r.theta.every((t) => Math.abs(t) <= T.range + 1e-9), "range");
  assert.ok(r.after >= r.before - 1e-12, "never worse");
  assert.deepEqual([...r.slot].sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8], "a permutation");
  const free = optimize(chain, start, { order: true, tilt: true, mix: "free", locked: [0, 3], ...axis });
  assert.ok(free.after >= r.after - 1e-9, "free can only do better than the same mix");
});

// ---- the opposing pitcher: log5 matchups, a starter's hook and the bullpen ----
const league = probs(data.pitching.league), relief = probs(data.pitching.relief);
const ace = data.pitchers.find((p) => p[6] >= 25 && p[5] >= 600); // a full-time starter
const aceP = probs(ace[4]);
const mlbP = data.mlb.spots.map((s) => probs(s.counts));
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);

check("log5: a league-average pitcher changes nothing, and a league-average hitter takes the pitcher's rates", () => {
  for (const b of mlbP) {
    log5(b, league, league).forEach((x, i) => close(x, b[i], 1e-12, `spot outcome ${i}`));
    const q = log5(b, aceP, league);
    close(q.reduce((s, x) => s + x, 0), 1, 1e-12, "sums to 1");
  }
  log5(league, aceP, league).forEach((x, i) => close(x, aceP[i], 1e-12, `outcome ${i}`));
  // more strikeouts against a pitcher who strikes out more than the league
  const ks = probs(data.pitchers.reduce((a, p) => (p[5] >= 400 && p[4][0] / p[5] > a[4][0] / a[5] ? p : a), ace)[4]);
  assert.ok(log5(mlbP[3], ks, league)[0] > mlbP[3][0], "K against a strikeout pitcher");
});

check("the exact line (expectedLine) agrees with expectedRuns and with the simulated MLB lineup", () => {
  const w = data.weights;
  const line = expectedLine(chain, mlbP.map((p) => matchup(chain, p, null, true)), null, w);
  close(line.R, exact(mlbP), 1e-9, "runs");
  for (const k of ["AVG", "OBP", "SLG", "wOBA"]) close(line[k], data.sims.mlb[k], 0.002, k);
  for (const k of ["H", "HR", "K", "BB", "PA27"]) close(line[k] / data.sims.mlb[k], 1, 0.01, k);
});

check("against a pitcher, exact and simulated agree: all nine innings, and a starter's hook with the bullpen after", () => {
  const w = data.weights;
  const whole = { p: aceP, pen: null, league, hook: 27 };
  const start = { p: aceP, pen: relief, league, hook: Math.round(ace[7] / ace[6]) };
  for (const vs of [whole, start]) {
    const sim = simulate(model, mlbP.map((p) => cumulative(log5(p, vs.p, league))), 100000, 11,
      vs.pen ? mlbP.map((p) => cumulative(log5(p, vs.pen, league))) : null, vs.hook);
    const s = summarize(sim.totals, w);
    const ex = expectedLine(chain, mlbP.map((p) => matchup(chain, p, vs, true)), vs, w);
    close(ex.R, lineupRuns(chain, mlbP.map((p) => matchup(chain, p, vs)), vs), 1e-9, "line vs runs");
    close(s.R, ex.R, 0.05, `R, hook ${vs.hook}`);
    for (const k of ["AVG", "OBP", "SLG", "wOBA"]) close(s[k], ex[k], 0.002, `${k}, hook ${vs.hook}`);
    close(s.K, ex.K, 0.06, `K, hook ${vs.hook}`);
  }
  // the hook's edge cases: after the last out is the same as no bullpen; at 0, all bullpen
  const m = mlbP.map((p) => matchup(chain, p, start));
  const sp = m.map((x) => x.sp), pen = m.map((x) => x.pen);
  close(expectedRuns(chain, sp, 9, pen, 27), expectedRuns(chain, sp), 1e-12, "hook 27");
  close(expectedRuns(chain, sp, 9, pen, 0), expectedRuns(chain, pen), 1e-12, "hook 0");
  // a later hook means more of the ace and fewer runs
  assert.ok(expectedRuns(chain, sp, 9, pen, 18) < expectedRuns(chain, sp, 9, pen, 17), "17 vs 18 outs");
  // a league-average pitcher is no pitcher at all
  close(lineupRuns(chain, mlbP.map((p) => matchup(chain, p, { p: league, pen: null, league, hook: 27 })),
    { p: league, pen: null, league, hook: 27 }), exact(mlbP), 1e-9, "league-average pitcher");
});

check("against a pitcher, the optimizer matches brute force: batting order of five spots", () => {
  const vs = { p: aceP, pen: relief, league, hook: 16 };
  const team = data.teams.find((t) => t.abbr === "LAD").spots.map((s) => ({ probs: probs(s.counts) }));
  const ms = team.map((h) => matchup(chain, h.probs, vs));
  let best = -1;
  const perm = (arr, k = 0) => {
    if (k === arr.length) {
      best = Math.max(best, lineupRuns(chain, [0, 1, ...arr, 7, 8].map((h) => ms[h]), vs));
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm([2, 3, 4, 5, 6]);
  const r = optimize(chain, team, { order: true, tilt: false, locked: [0, 1, 7, 8], vs, ...axis });
  assert.ok(r.after >= best - 1e-9, `optimizer ${r.after} vs brute force ${best}`);
  close(r.before, lineupRuns(chain, ms, vs), 1e-12, "the search's starting value");
});

console.log(`${n} checks passed`);
