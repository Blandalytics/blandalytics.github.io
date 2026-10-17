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
  const C_HBP = CATS.indexOf("HBP");
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

  check("per-pitch: a setting moves him as log5 does with the per-PA model, and facing() keeps nothing between calls", () => {
    const per = data.tradeoff.per_sd;
    // against a pitcher (splits off: one part) his chances scaled by tilt(a) / a, renormalized:
    // log5's identity, log5(tilt(b), p, l) = log5(b, p, l) * tilt(b) / b, renormalized
    const off = pitchSpot("MLB", 0, "off"), vs = pitchArm(ace, "off"), a0 = facing(off, null), q0 = facing(off, vs);
    const t = tilt(a0, per, 1.5), y = q0.map((x, i) => (x * t[i]) / a0[i]), n = y.reduce((s, x) => s + x, 0);
    const q1 = facing(off, vs, 1.5, per);
    y.forEach((x, i) => close(q1[i], x / n, 1e-12, `vs ${ace[1]}, tilted ${CATS[i]}`));
    close(q1.reduce((s, x) => s + x, 0), 1, 1e-12, "sum");
    q0[0] = 99; // a caller writing into the result
    close(facing(off, vs)[0], facing(off, vs.map((c) => ({ ...c })))[0], 1e-12, "a fresh copy");
  });

  check("per-pitch: against MLB-average pitching a setting does what it did before (the tilt of the chain's outcomes)", () => {
    const per = data.tradeoff.per_sd;
    // MLB-average pitching (null), and an arm of each hand and a bullpen with no ratios of their own
    const none = { all: null, gap: null, cells: null };
    const avgArms = [null, ...["R", "L"].map((t) => pitcherOf(data.pitching.league, data.pitching.cells, t, { mode: "own", league }).map((c) => ({ ...c, pitch: none }))),
      penOf(data.pitching.relief_cells, "own").map((c) => ({ ...c, pitch: none }))];
    for (const mode of ["off", "league", "own"]) {
      for (let i = 0; i < 9; i++) {
        const h = pitchSpot("MLB", i, mode);
        for (const arm of avgArms) {
          for (const th of [-2, -0.7, 0.4, 2]) {
            // as the page had it: the chain's outcomes against the pitching, then tilted
            const was = tilt(facing(h, arm), per, th), now = facing(h, arm, th, per);
            was.forEach((x, k) => close(now[k], x, 1e-12, `${mode} MLB-${i + 1} ${arm ? arm.length + " hands" : "null"} ${th} ${CATS[k]}`));
          }
        }
      }
    }
  });

  check("per-pitch: a power setting's strikeouts against strikeout and contact pitchers go the way log5's do", () => {
    const per = data.tradeoff.per_sd, h = pitchSpot("MLB", 0, "own"), a = facing(h, null);
    const b = hitterOf(data.mlb.spots[0].counts, null, { mode: "off", league }).all, l = probs(data.pitching.league);
    const kRate = (r) => r[4][0] / r[4].reduce((s, x) => s + x, 0);
    const starters = data.pitchers.filter((r) => r[6] >= 20 && pd.pitchers[r[0]]).sort((x, y) => kRate(y) - kRate(x));
    const dAvg = facing(h, null, 2, per)[0] - a[0], relAvg = dAvg / a[0];
    const dPaAvg = tilt(b, per, 2)[0] - b[0], relPaAvg = dPaAvg / b[0];
    for (const [r, high] of [[starters[0], true], [starters[starters.length - 1], false]]) {
      const arm = pitchArm(r, "own"), k0 = facing(h, arm)[0], dK = facing(h, arm, 2, per)[0] - k0;
      const p = probs(r[4]), k0pa = log5(b, p, l)[0], dPa = log5(tilt(b, per, 2), p, l)[0] - k0pa;
      const what = `${r[1]} (K ${(100 * kRate(r)).toFixed(1)}%): +${dK.toFixed(3)} K (${(100 * dK / k0).toFixed(0)}%) vs +${dAvg.toFixed(3)} (${(100 * relAvg).toFixed(0)}%) against average`;
      // a strikeout pitcher: more strikeouts added, but a smaller share of what he already gets; a contact pitcher the reverse
      assert.ok(high ? dK > dAvg && dK / k0 < relAvg : dK < dAvg && dK / k0 > relAvg, what);
      assert.ok(high ? dPa > dPaAvg && dPa / k0pa < relPaAvg : dPa < dPaAvg && dPa / k0pa > relPaAvg, `per-PA, ${r[1]}`);
      close(dK, dPa, 0.03, `${r[1]}: per-pitch vs per-PA, the setting's extra strikeouts`);
    }
  });

  check("per-pitch: a setting stays finite where a cell's chance is 0 or tiny", () => {
    const per = data.tradeoff.per_sd, vs = pitchArm(ace, "off");
    for (const r of [0, 1e-14, 1e-7]) {
      // a hitter who's never (or almost never) hit by a pitch: the take step's HBP-to-ball ratio
      const base = pitchSpot("MLB", 0, "off"), ratios = Array.from(base.pitch.all ?? new Array(13).fill(1));
      ratios[3] = r;
      const h = { ...base, pitch: { ...base.pitch, all: ratios } };
      for (const th of [-2.5, 2.5]) {
        const q = facing(h, vs, th, per);
        assert.ok(q.every((x) => Number.isFinite(x) && x >= 0), `ratio ${r}, ${th}: ${q}`);
        close(q.reduce((s, x) => s + x, 0), 1, 1e-12, `ratio ${r}, ${th}: sum`);
        assert.ok(q[C_HBP] < 1e-3, `ratio ${r}, ${th}: HBP ${q[C_HBP]}`);
      }
    }
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

  // ---- the hypothetical pitcher (data/<season>-quality.json, pipeline/quality_axis.py) ----
  const qualityFile = join(repo, "lineup-sims", "data", `${process.argv[2] ?? "2026"}-quality.json`);
  if (existsSync(qualityFile)) {
    const Q = JSON.parse(readFileSync(qualityFile, "utf8")), R = Q.range;
    const w = data.weights, wv = [0, w.wBB, w.wHBP, w.w1B, w.w2B, w.w3B, w.wHR, 0, 0, 0, 0];
    const woba = (c) => c.reduce((t, x, i) => t + x * wv[i], 0) / c.reduce((t, x) => t + x, 0);
    // the page's MLB-average RHP, moved: his rates and each cell's by q steps (app.js hypothetical())
    const moved = (c, q) => tilt(c, Q.pa.per_sd, q).map((x) => x * c.reduce((t, y) => t + y, 0));
    const rhp = (q, mode) => {
      const cells = { L: moved(data.pitching.cells.RL, q), R: moved(data.pitching.cells.RR, q) };
      return pitcherOf(cells.L.map((x, i) => x + cells.R[i]), cells, "R", { mode, league });
    };
    // and with the per-pitch model, his ratios (app.js hypoRatios())
    const ratiosAt = (q) => { const s = Q.pitch.steps[Math.round((q + R) * 10)]; return Q.pitch.slope.map((x) => Math.exp(s * x)); };
    const pitchRhp = (q, mode) => pitcherOf(data.pitching.league, data.pitching.cells, "R", { mode, league })
      .map((c) => ({ ...c, pitch: q ? { all: ratiosAt(q), gap: ratiosAt(q), cells: null } : side(null, mode) }));

    check("quality: the per-PA axis keeps a profile adding up to 1, moves wOBA allowed a talent SD a step, and keeps every MLB-average cell at or above 0", () => {
      close(Q.pa.per_sd.reduce((t, x) => t + x, 0), 0, 1e-12, "sum");
      close(Q.pa.per_sd.reduce((t, x, i) => t + x * wv[i], 0), -Q.pa.sd, 1e-12, "wOBA per step");
      assert.ok(Q.pa.sd > 0.01 && Q.pa.sd < Q.pa.observed_sd, `talent SD ${Q.pa.sd} under the observed ${Q.pa.observed_sd}`);
      for (const k of ["RL", "RR", "LL", "LR"]) for (const q of [-R, R]) {
        const c = data.pitching.cells[k], n = c.reduce((t, x) => t + x, 0);
        c.forEach((x, i) => assert.ok(x / n + q * Q.pa.per_sd[i] >= 0, `${k} at ${q}: ${CATS[i]}`));
      }
    });

    check("quality: the per-pitch steps put the count chain's wOBA allowed as many talent SDs from average, tenth by tenth", () => {
      const avg = woba(pitchChances(tables.all, null, null));
      close(avg, Q.pitch.woba, 1e-9, "average");
      assert.equal(Q.pitch.steps.length, Math.round(R * 20) + 1);
      for (let k = 0; k < Q.pitch.steps.length; k++) {
        const q = k / 10 - R;
        close(woba(pitchChances(tables.all, null, ratiosAt(q))), avg - q * Q.pa.sd, 1e-6, `at ${q.toFixed(1)}`);
      }
    });

    check("quality: in both models a pitcher toward the Ace end strikes out more, allows less and holds MLB's spots to fewer runs", () => {
      const mode = "own", spots = data.mlb.spots.map((s) => spotOf(s, mode)), pspots = Array.from({ length: 9 }, (_, i) => pitchSpot("MLB", i, mode));
      const runs = (hs, sp) => lineupRuns(chain, hs.map((h) => matchup(chain, h, { sp, relief: [] })));
      let prev = null;
      for (const q of [-R, -1, 0, 1, R]) {
        const pa = rhp(q, mode), pp = pitchRhp(q, mode), h = spotOf(data.mlb.spots[3], mode), hp = pitchSpot("MLB", 3, mode);
        const now = { paR: runs(spots, pa), pitchR: runs(pspots, pp), paK: facing(h, pa)[0], pitchK: facing(hp, pp)[0] };
        if (prev) for (const k of Object.keys(now)) assert.ok(k.endsWith("R") ? now[k] < prev[k] : now[k] > prev[k], `${k} at ${q}: ${now[k]} vs ${prev[k]}`);
        // the same quality in both: runs within a few tenths of each other at every setting
        close(now.pitchR, now.paR, 0.4, `per-pitch vs per-PA runs at ${q}`);
        prev = now;
      }
    });

    check("quality: at 0 the hypothetical pitcher is today's MLB-average arm, in both models", () => {
      // (the page hands over the MLB-average entry itself at 0; moved by 0, or at the 0 step, he's the same)
      close(Q.pitch.steps[Math.round(R * 10)], 0, 1e-12, "the per-pitch step at 0");
      for (const hand of ["R", "L"]) {
        const cl = data.pitching.cells[hand + "L"], cr = data.pitching.cells[hand + "R"];
        for (const mode of ["off", "league", "own"]) {
          const base = pitcherOf(cl.map((x, i) => x + cr[i]), { L: cl, R: cr }, hand, { mode, league });
          const cells = { L: moved(cl, 0), R: moved(cr, 0) }, zero = pitcherOf(cells.L.map((x, i) => x + cells.R[i]), cells, hand, { mode, league });
          const none = side(null, mode), at0 = { all: ratiosAt(0), gap: ratiosAt(0), cells: null };
          for (let i = 0; i < 9; i++) {
            const h = spotOf(data.mlb.spots[i], mode), hp = pitchSpot("MLB", i, mode);
            const a = facing(h, base), b = facing(h, zero);
            a.forEach((x, k) => close(b[k], x, 1e-12, `per-PA ${hand}HP ${mode} spot ${i + 1} ${CATS[k]}`));
            const c = facing(hp, base.map((x) => ({ ...x, pitch: none }))), d = facing(hp, base.map((x) => ({ ...x, pitch: at0 })));
            c.forEach((x, k) => close(d[k], x, 1e-12, `per-pitch ${hand}HP ${mode} spot ${i + 1} ${CATS[k]}`));
          }
        }
      }
    });
  }
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

  check("hook: the same seed gives the same games (every hook, pitch-count and outcome draw is the seeded one)", () => {
    const go = (seed) => simulate(model, cums, 2000, seed, [{ from: "hook", lineup: penCums }], hookFor(ace));
    const a = go(7), b = go(7);
    assert.deepEqual(a.hook, b.hook);
    assert.deepEqual(a.totals, b.totals);
    assert.deepEqual(Array.from(a.runDist), Array.from(b.runDist));
    assert.notDeepEqual(go(8).hook.outs, a.hook.outs);
  });
}

console.log(`${n} checks passed`);
