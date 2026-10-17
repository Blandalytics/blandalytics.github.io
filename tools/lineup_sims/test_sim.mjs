// Checks on the simulation engine (lineup-sims/sim.js) against the built data file.
//
//   node tools/lineup_sims/test_sim.mjs 2026
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { CATS, bullpenOf, chances, cumulative, facing, hitterOf, hookChance, log5, pitchChances, pitcherOf, prepare, rates, simulate, summarize, tilt } from "../../lineup-sims/sim.js";
import { chainTables, expectedLine, expectedLines, expectedLinesMix, expectedRuns, hitterBlock, hookMix, lineupRuns, matchup, optimize } from "../../lineup-sims/markov.js";

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
  const lineup = data.mlb.spots.map((s) => ({ all: probs(s.counts), theta: 0 }));
  const lim = Math.round(T.range * 10);
  let best = -1;
  for (let a = -lim; a <= lim; a++) {
    for (let b = -lim; b <= lim; b++) {
      const c = -a - b;
      if (c < -lim || c > lim) continue;
      const th = [0, a, b, c, 0, 0, 0, 0, 0];
      best = Math.max(best, exact(data.mlb.spots.map((s, i) => tilt(s.counts, T.per_sd, th[i] / 10))));
    }
  }
  const r = optimize(chain, lineup, { order: false, tilt: true, mix: "same", locked: [0, 4, 5, 6, 7, 8], ...axis });
  assert.ok(r.after >= best - 1e-9, `optimizer ${r.after} vs brute force ${best}`);
});

check("the optimizer matches brute force: batting order of five spots", () => {
  const team = data.teams.find((t) => t.abbr === "NYY").spots.map((s) => ({ all: probs(s.counts) }));
  const blocks = team.map((h) => hitterBlock(chain, h.all));
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
  const start = data.mlb.spots.map((s, i) => ({ all: probs(s.counts), theta: [0.5, -1, 0, 2, 0, 0, -0.5, 1, 0][i] }));
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

// ---- the opposing pitcher: log5 matchups, platoon splits, and who takes over when ----
const league = { all: probs(data.pitching.league),
  cells: Object.fromEntries(Object.entries(data.pitching.cells).map(([k, c]) => [k, probs(c)])) };
const relief = probs(data.pitching.relief);
const ace = data.pitchers.find((p) => p[6] >= 25 && p[5] >= 600); // a full-time starter
const lefty = data.pitchers.find((p) => p[3] === "L" && p[6] >= 25); // a left-handed one
const aceP = probs(ace[4]);
const mlbP = data.mlb.spots.map((s) => probs(s.counts));
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);
const wv = [0, data.weights.wBB, data.weights.wHBP, data.weights.w1B, data.weights.w2B, data.weights.w3B, data.weights.wHR, 0, 0, 0, 0];
const woba = (q) => q.reduce((s, x, i) => s + x * wv[i], 0) / q.reduce((s, x) => s + x, 0);
// the pitching the page builds, for a pitcher row of the data file: him, then (with a hook
// under 27 outs) MLB's bullpen
const vsOf = (row, mode, hook = 27) => ({ sp: pitcherOf(row[4], row[8], row[3], { mode, league }),
  relief: hook < 27 ? [{ from: hook, pitching: bullpenOf(data.pitching.relief, data.pitching.relief_cells, { mode, league }) }] : [] });
// a bullpen (a team's, or bulk relief) from its cells, as the page builds it
const penOf = (cells, mode) => bullpenOf(CATS.map((_, i) => Object.values(cells).reduce((t, c) => t + c[i], 0)), cells, { mode, league });
// the lineup against each relief stage, for simulate()
const reliefSim = (hs, vs) => vs.relief.map((r) => ({ from: r.from, lineup: hs.map((x) => cumulative(facing(x, r.pitching))) }));
// an MLB-average pitcher of one hand: every 2026 pitcher of that hand pooled
const pooled = (hand) => {
  const cells = { L: data.pitching.cells[hand + "L"], R: data.pitching.cells[hand + "R"] };
  return [0, "MLB-average", "", hand, cells.L.map((x, i) => x + cells.R[i]), 0, 0, 0, cells];
};
const spotOf = (s, mode) => hitterOf(s.counts, s.cells, { mode, league });

check("log5: a league-average pitcher changes nothing, and a league-average hitter takes the pitcher's rates", () => {
  for (const b of mlbP) {
    log5(b, league.all, league.all).forEach((x, i) => close(x, b[i], 1e-12, `spot outcome ${i}`));
    const q = log5(b, aceP, league.all);
    close(q.reduce((s, x) => s + x, 0), 1, 1e-12, "sums to 1");
  }
  log5(league.all, aceP, league.all).forEach((x, i) => close(x, aceP[i], 1e-12, `outcome ${i}`));
  // more strikeouts against a pitcher who strikes out more than the league
  const ks = probs(data.pitchers.reduce((a, p) => (p[5] >= 400 && p[4][0] / p[5] > a[4][0] / a[5] ? p : a), ace)[4]);
  assert.ok(log5(mlbP[3], ks, league.all)[0] > mlbP[3][0], "K against a strikeout pitcher");
});

check("platoon data: every split adds up, and the league has the usual platoon gap", () => {
  const sum = (cells) => CATS.map((_, i) => Object.values(cells).reduce((t, c) => t + c[i], 0));
  for (const row of data.players) assert.deepEqual(sum(row[5]), row[3], `${row[1]}`);
  for (const row of data.pitchers) assert.deepEqual(sum(row[8]), row[4], `${row[1]}`);
  for (const s of [...data.mlb.spots, ...data.teams.flatMap((t) => t.spots)]) assert.deepEqual(sum(s.cells), s.counts);
  const c = league.cells;
  // hitters do worse against a pitcher of their own hand, and strike out more
  assert.ok(woba(c.LL) < woba(c.RL) - 0.015 && woba(c.RR) < woba(c.LR) - 0.01, "wOBA, same hand vs opposite");
  assert.ok(c.LL[0] > c.RL[0] && c.RR[0] > c.LR[0], "K%, same hand vs opposite");
  // switch hitters (nearly all of them; the splits use the side actually batted from) bat
  // from the other side to the pitcher
  const sw = data.players.filter((r) => r[6] === "S" && r[3].reduce((a, b) => a + b, 0) > 200);
  const opposite = sw.filter((row) => {
    const pa = (k) => (row[5][k] ?? []).reduce((a, b) => a + b, 0);
    return pa("RL") + pa("LR") > 0.95 * (pa("RL") + pa("LR") + pa("RR") + pa("LL"));
  });
  assert.ok(sw.length > 20 && opposite.length >= 0.9 * sw.length, `${opposite.length} of ${sw.length}`);
});

check("platoon builders: an MLB-average right-hander leaves every spot at its own rates against righties", () => {
  const R = pooled("R"), vsR = pitcherOf(R[4], R[8], "R", { mode: "own", league });
  for (const s of data.mlb.spots) {
    const own = probs(CATS.map((_, i) => (s.cells.RL?.[i] ?? 0) + (s.cells.RR?.[i] ?? 0)));
    facing(spotOf(s, "own"), vsR).forEach((x, i) => close(x, own[i], 1e-12, `outcome ${i}`));
  }
  // with splits off, a pitcher is his overall rates against the hitter's overall rates, as before
  const off = facing(spotOf(data.mlb.spots[0], "off"), vsOf(ace, "off").sp);
  log5(mlbP[0], aceP, league.all).forEach((x, i) => close(x, off[i], 1e-12, `off, outcome ${i}`));
  // league-average gaps: averaged over the matchups he had, a pitcher is about his overall self
  const lg = vsOf(lefty, "league").sp[0], n = (s) => lefty[8][s].reduce((a, b) => a + b, 0);
  const avg = CATS.map((_, i) => (n("L") * lg.p.L[i] + n("R") * lg.p.R[i]) / (n("L") + n("R")));
  probs(lefty[4]).forEach((x, i) => close(avg[i], x, 0.003, `league gaps, outcome ${i}`));
  // a switch hitter with no plate appearances against lefties is taken to bat right against them
  const sw = hitterOf([10, 5, 0, 15, 5, 0, 3, 20, 7, 12, 3], { RL: [10, 5, 0, 15, 5, 0, 3, 20, 7, 12, 3] }, { mode: "own", league, bats: "S" });
  assert.equal(sw.parts.L[0].side, "R");
  assert.equal(sw.parts.R[0].side, "L");
  // Small samples pulls a thin split toward the player's own season (with the league's gap),
  // not toward the league: a right-handed regular with 500 PA against righties and 3
  // strikeouts in 3 PA against lefties
  const rr = league.cells.RR.map((x) => Math.round(x * 500)), lr = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const thin = (mode) => hitterOf(rr.map((x, i) => x + lr[i]), { RR: rr, LR: lr }, { mode, league, regress: 200, bats: "R" }).parts.L[0].b;
  const own = thin("own"), gap = thin("league");
  own.forEach((x, i) => close(x, gap[i], 0.02, `thin split, outcome ${i}`));
  assert.ok(own[0] > gap[0] && own[0] < 0.25, "the 3 strikeouts count for a little");
});

check("the exact line (expectedLine) agrees with expectedRuns and with the simulated MLB lineup", () => {
  const w = data.weights;
  const line = expectedLine(chain, mlbP.map((p) => matchup(chain, { all: p }, null, true)), w);
  close(line.R, exact(mlbP), 1e-9, "runs");
  for (const k of ["AVG", "OBP", "SLG", "wOBA"]) close(line[k], data.sims.mlb[k], 0.002, k);
  for (const k of ["H", "HR", "K", "BB", "PA27"]) close(line[k] / data.sims.mlb[k], 1, 0.01, k);
});

check("against a pitcher, exact and simulated agree: splits off and on, nine innings or a hook and the bullpen", () => {
  const w = data.weights;
  const hook = Math.round(ace[7] / ace[6]);
  for (const [mode, h] of [["off", 27], ["off", hook], ["own", 27], ["own", hook], ["league", hook]]) {
    const vs = vsOf(mode === "off" ? ace : lefty, mode, h);
    const hs = data.mlb.spots.map((s) => spotOf(s, mode));
    const sim = simulate(model, hs.map((x) => cumulative(facing(x, vs.sp))), 100000, 11, reliefSim(hs, vs));
    const s = summarize(sim.totals, w);
    const ex = expectedLine(chain, hs.map((x) => matchup(chain, x, vs, true)), w);
    close(ex.R, lineupRuns(chain, hs.map((x) => matchup(chain, x, vs))), 1e-9, `line vs runs, ${mode} ${h}`);
    close(s.R, ex.R, 0.05, `R, ${mode} ${h}`);
    for (const k of ["AVG", "OBP", "SLG", "wOBA"]) close(s[k], ex[k], 0.002, `${k}, ${mode} ${h}`);
    close(s.K, ex.K, 0.06, `K, ${mode} ${h}`);
  }
  // the hook's edge cases: after the last out is the same as no bullpen; at 0, all bullpen
  const vs = vsOf(lefty, "own", 16);
  const m = data.mlb.spots.map((s) => matchup(chain, spotOf(s, "own"), vs));
  const sp = m.map((x) => x.sp), pen = m.map((x) => x.relief[0].block);
  const at = (from) => expectedRuns(chain, sp, 9, [{ from, blocks: pen }]);
  close(at(27), expectedRuns(chain, sp), 1e-12, "hook 27");
  close(at(0), expectedRuns(chain, pen), 1e-12, "hook 0");
  // a later hook means more of a good starter and fewer runs
  assert.ok(at(18) < at(17), "17 vs 18 outs");
  // a league-average pitcher is no pitcher at all
  const flat = { sp: [{ w: 1, hand: "", p: { "": league.all }, l: { "": league.all } }], relief: [] };
  close(lineupRuns(chain, mlbP.map((p) => matchup(chain, { all: p }, flat))), exact(mlbP), 1e-9, "league-average pitcher");
});

check("against a pitcher, the optimizer matches brute force: batting order of five spots, with platoon splits", () => {
  const vs = vsOf(lefty, "own", 16);
  const team = data.teams.find((t) => t.abbr === "LAD").spots.map((s) => spotOf(s, "own"));
  const ms = team.map((h) => matchup(chain, h, vs));
  let best = -1;
  const perm = (arr, k = 0) => {
    if (k === arr.length) {
      best = Math.max(best, lineupRuns(chain, [0, 1, ...arr, 7, 8].map((h) => ms[h])));
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
  close(r.before, lineupRuns(chain, ms), 1e-12, "the search's starting value");
  // and a movable spot is tilted inside the search exactly as facing() tilts it
  const mv = data.mlb.spots.map((s, i) => ({ ...spotOf(s, "own"), theta: i === 2 ? 1.5 : null }));
  const t = optimize(chain, mv, { order: false, tilt: true, mix: "free", locked: [0, 1, 3, 4, 5, 6, 7, 8], vs, ...axis });
  const th = t.theta[2];
  const want = lineupRuns(chain, mv.map((h, i) => matchup(chain, h, vs, false, i === 2 ? th : 0, T.per_sd)));
  close(t.after, want, 1e-12, "tilted inside the search");
});

check("pitching data for openers: team bullpens add up to MLB's, and openers, followers and bulk relief look right", () => {
  const P = data.pitching, sum = (cells) => CATS.map((_, i) => Object.values(cells).reduce((t, c) => t + c[i], 0));
  assert.equal(Object.keys(P.teams).length, 30);
  assert.deepEqual(CATS.map((_, i) => Object.values(P.teams).reduce((t, c) => t + sum(c)[i], 0)), P.relief, "team bullpens");
  assert.ok(P.opener.games >= 50 && P.opener.outs >= 1 && P.opener.outs <= 6, `opener ${JSON.stringify(P.opener)}`);
  assert.ok(P.follower.games >= 30 && P.follower.games <= P.opener.games && P.follower.outs >= 9, `follower ${JSON.stringify(P.follower)}`);
  assert.ok(P.bulk.outings >= P.follower.games && sum(P.bulk.cells).reduce((a, b) => a + b, 0) > 5000, "bulk relief");
  // a bullpen's hand shares add to 1; full-time starters have the most bulk outings
  for (const cells of [P.teams.DET, P.bulk.cells]) close(penOf(cells, "own").reduce((t, c) => t + c.w, 0), 1, 1e-12, "hand shares");
  const top = [...data.pitchers].sort((a, b) => b[9] - a[9]).slice(0, 20);
  assert.ok(top.every((r) => r[6] >= 20), "the top bulk arms are starters");
});

check("opener, follower, bullpen: exact and simulated agree, and stages behave at their edges", () => {
  const w = data.weights, mode = "own";
  const hs = data.mlb.spots.map((s) => spotOf(s, mode));
  const opener = pitcherOf(lefty[4], lefty[8], lefty[3], { mode, league });
  const follow = pitcherOf(ace[4], ace[8], ace[3], { mode, league });
  const pen = penOf(data.pitching.teams.DET, mode);
  // a typical opener and follower, and two changes inside one inning (after the 4th and 5th outs)
  for (const [f, b] of [[data.pitching.opener.outs, data.pitching.opener.outs + data.pitching.follower.outs], [4, 5]]) {
    const vs = { sp: opener, relief: [{ from: f, pitching: follow }, { from: b, pitching: pen }] };
    const sim = summarize(simulate(model, hs.map((x) => cumulative(facing(x, vs.sp))), 100000, 13, reliefSim(hs, vs)).totals, w);
    const ex = expectedLine(chain, hs.map((x) => matchup(chain, x, vs, true)), w);
    close(ex.R, lineupRuns(chain, hs.map((x) => matchup(chain, x, vs))), 1e-9, `line vs runs, ${f}/${b}`);
    close(sim.R, ex.R, 0.05, `R, ${f}/${b}`);
    for (const k of ["AVG", "OBP", "SLG", "wOBA"]) close(sim[k], ex[k], 0.002, `${k}, ${f}/${b}`);
  }
  const ms = (relief) => hs.map((x) => matchup(chain, x, { sp: opener, relief }));
  const two = lineupRuns(chain, ms([{ from: 3, pitching: pen }]));
  // a follower who never gets an out in is no follower; one taking over at 27 never pitches
  close(lineupRuns(chain, ms([{ from: 3, pitching: follow }, { from: 3, pitching: pen }])), two, 1e-12, "zero-length follower");
  close(lineupRuns(chain, ms([{ from: 3, pitching: pen }, { from: 27, pitching: follow }])), two, 1e-12, "a stage at 27");
  // and a follower who is the bullpen is the bullpen
  close(lineupRuns(chain, ms([{ from: 3, pitching: pen }, { from: 16, pitching: pen }])), two, 1e-12, "follower = bullpen");
});

// ---- the per-pitch model (data/<season>-pitch.json, pipeline/pitch_model.py) ----
const pitchFile = join(repo, "lineup-sims", "data", `${process.argv[2] ?? "2026"}-pitch.json`);
if (existsSync(pitchFile)) {
  const pd = JSON.parse(readFileSync(pitchFile, "utf8"));
  const tables = Object.fromEntries(Object.entries(pd.tables).map(([k, steps]) => [k, steps.map((t) => Float64Array.from(t))]));
  const side = (r, mode) => (r ? { all: r.a, gap: r.g, cells: mode === "own" && r.c ? r.c : null } : { all: null, gap: null, cells: null });
  // a lineup spot or hitter as the page builds it with the per-pitch model
  const pitchSpot = (abbr, i, mode) => ({ ...spotOf((abbr === "MLB" ? data.mlb : data.teams.find((t) => t.abbr === abbr)).spots[i], mode),
    pitch: { tables, ...side(pd.spots[`${abbr}-${i + 1}`], mode), theta: 0, perSd: data.tradeoff.per_sd } });
  const pitchArm = (row, mode) => pitcherOf(row[4], row[8], row[3], { mode, league }).map((c) => ({ ...c, pitch: side(pd.pitchers[row[0]], mode) }));

  check("per-pitch: the page's count chain matches the pipeline's, matchup by matchup", () => {
    assert.ok(pd.checks.length >= 4, "checks");
    for (const c of pd.checks) {
      const pick = (r) => (r == null ? null : c.use === "c" ? r.c[c.cell] : r.a);
      const out = pitchChances(tables[c.cell], pick(pd.hitters[c.hitter]), pick(pd.pitchers[c.pitcher]));
      out.forEach((x, i) => close(x, c.out[i], 1e-8, `${c.hitter} vs ${c.pitcher} ${c.cell} ${CATS[i]}`));
    }
  });

  check("per-pitch: outcomes add up to 1, and MLB average reproduces the league's PA rates", () => {
    const lg = pitchChances(tables.all, null, null), actual = probs(data.pitching.league);
    close(lg.reduce((t, x) => t + x, 0), 1, 1e-9, "sum");
    lg.forEach((x, i) => close(x, actual[i], 0.003, `league ${CATS[i]}`));
    for (const mode of ["off", "league", "own"]) {
      const q = facing(pitchSpot("NYY", 3, mode), pitchArm(ace, mode));
      close(q.reduce((t, x) => t + x, 0), 1, 1e-9, `sum, ${mode}`);
    }
  });

  check("per-pitch: a setting moves the chain's outcomes along the contact-power axis, and facing() keeps nothing between calls", () => {
    const h = pitchSpot("MLB", 0, "own"), vs = pitchArm(ace, "own");
    const q0 = facing(h, vs), q1 = facing(h, vs, 1, data.tradeoff.per_sd);
    tilt(q0, data.tradeoff.per_sd, 1).forEach((x, i) => close(q1[i], x, 1e-12, `tilted ${CATS[i]}`));
    q0[0] = 99; // a caller writing into the result
    close(facing(h, vs)[0], q1[0] - data.tradeoff.per_sd[0], 1e-12, "a fresh copy");
  });

  check("per-pitch: exact expected runs agree with the simulation, with a starter and a bullpen", () => {
    const mode = "own", w = data.weights;
    const hs = Array.from({ length: 9 }, (_, i) => pitchSpot("MLB", i, mode));
    const pen = penOf(data.pitching.teams.DET, mode).map((c) => ({ ...c, pitch: side(pd.pens.DET, mode) }));
    const vs = { sp: pitchArm(ace, mode), relief: [{ from: 18, pitching: pen }] };
    const sim = summarize(simulate(model, hs.map((x) => cumulative(facing(x, vs.sp))), 100000, 17, reliefSim(hs, vs)).totals, w);
    const ex = expectedLine(chain, hs.map((x) => matchup(chain, x, vs, true)), w);
    close(sim.R, ex.R, 0.05, "R");
    for (const k of ["AVG", "OBP", "SLG", "wOBA"]) close(sim[k], ex[k], 0.002, k);
    // and against MLB-average pitching the model's MLB spots score like 2026's
    const avg = lineupRuns(chain, hs.map((x) => matchup(chain, x, null)));
    close(avg, data.mlb.actual.R, 0.35, "MLB spots vs average, R/9");
  });
}

// ---- the modeled hook (data/<season>-hook.json, pipeline/hook_model.py) ----
const hookFile = join(repo, "lineup-sims", "data", `${process.argv[2] ?? "2026"}-hook.json`);
if (existsSync(hookFile)) {
  const H = JSON.parse(readFileSync(hookFile, "utf8"));
  const t = H.trees;
  const T = { feat: Int32Array.from(t.feat), thr: Float64Array.from(t.thr), dl: Uint8Array.from(t.dl), miss: Uint8Array.from(t.miss),
    left: Int32Array.from(t.left), right: Int32Array.from(t.right), leaf: Float64Array.from(t.leaf), roots: Int32Array.from(t.roots) };
  const pitchCum = CATS.map((c) => cumulative(probs(H.pitches[c])));
  const hookFor = (row, trees = T) => {
    const own = H.pitchers[row[0]], x = new Float64Array(H.features.length).fill(NaN);
    const set = (k, v) => { x[H.features.indexOf(k)] = v; };
    for (const [k, v] of Object.entries(H.defaults)) set(k, v);
    set("team_start_outs", H.teams[own[4]]);
    ["max3", "max5", "mean3", "starts_season"].forEach((k, i) => set(k, own[i]));
    return { trees, features: H.features, x, pitches: pitchCum, runsPerInning: H.runs_per_inning };
  };
  const mode = "own", hs = data.mlb.spots.map((s) => spotOf(s, mode));
  const sp = pitcherOf(ace[4], ace[8], ace[3], { mode, league }), pen = penOf(data.pitching.teams[ace[2]] ?? data.pitching.relief_cells, mode);
  const cums = hs.map((x) => cumulative(facing(x, sp))), penCums = hs.map((x) => cumulative(facing(x, pen)));
  // trees whose every leaf says the same thing: never take him out, or always
  const flat = (v) => ({ ...T, leaf: T.leaf.map(() => v / T.roots.length) });

  check("hook: the page's trees give the model's own answers", () => {
    for (const c of H.checks) close(hookChance(T, Float64Array.from(c.x, (v) => (v == null ? NaN : v))), c.p, 1e-12, "a check row");
  });

  check("hook: a starter never taken out pitches the game, one always taken out faces one batter", () => {
    const never = simulate(model, cums, 3000, 5, [{ from: "hook", lineup: penCums }], hookFor(ace, flat(-50)));
    assert.equal(never.hook.outs[27], 3000);
    const always = simulate(model, cums, 3000, 5, [{ from: "hook", lineup: penCums }], hookFor(ace, flat(50)));
    assert.equal(always.hook.games, 3000);
    assert.ok(always.hook.outs.slice(4).every((c) => c === 0), "gone within the first batter's outs");
    assert.ok(always.hook.pitches / 3000 < 8, "one batter's pitches");
    // and the game is the bullpen's: runs as if it pitched from the start, within noise
    const pen0 = summarize(simulate(model, penCums, 30000, 9).totals, data.weights).R;
    close(summarize(simulate(model, cums, 30000, 9, [{ from: "hook", lineup: penCums }], hookFor(ace, flat(50))).totals, data.weights).R, pen0, 0.1, "bullpen R/9");
  });

  check("hook: one hook point is that fixed stage, and a typical start lasts about as long as his 2026 starts did", () => {
    const lineups = [hs.map((x) => ({ sp: facing(x, sp), relief: [facing(x, pen)] }))];
    const one = expectedLinesMix(chain, lineups, ["hook"], data.weights, [{ p: 1, at: 16 }])[0];
    const fixed = expectedLines(chain, lineups, [16], data.weights)[0];
    for (const k of ["R", "AVG", "OBP", "SLG"]) close(one[k], fixed[k], 1e-12, k);
    const res = simulate(model, cums, 20000, 3, [{ from: "hook", lineup: penCums }], hookFor(ace));
    const outs = res.hook.outs.reduce((a, c, i) => a + c * i, 0) / res.hook.games, own = H.pitchers[ace[0]];
    close(outs, own[6], 2.5, `${ace[1]}: outs per start`);
    close(res.hook.pitches / res.hook.games, own[5], 12, `${ace[1]}: pitches per start`);
    // the exact runs averaged over his simulated hook points come close to the simulation's (the hook
    // depends on how the game is going, which the average leaves out)
    const mixR = expectedLinesMix(chain, lineups, ["hook"], data.weights, hookMix(res.hook.outs))[0].R;
    close(mixR, summarize(res.totals, data.weights).R, 0.25, "exact over the hook points vs simulated");
  });
}

console.log(`${n} checks passed`);
