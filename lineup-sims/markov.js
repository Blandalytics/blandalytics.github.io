// Exact expected runs for a lineup, for the optimizer (and the pipeline's checks).
//
// A Markov chain over (batter due up, outs, bases) built from the same running-game and
// advancement tables the simulation draws from (prepare() in sim.js), so its expected
// runs are what the simulation would average over infinitely many games. Simulated
// differences between two lineups of a few hundredths of a run are mostly noise; these
// are not.
//
// States within an inning are s = mask * 3 + outs (24), as in sim.js's tables. One step
// is one plate appearance: the running game first (which can end the inning with the
// same hitter due up next inning), then the hitter's outcome and the runners' moves.
//
// Against a given pitcher, each hitter's chances are first combined with the pitcher's by
// log5, platoon splits and all (facing() in sim.js). The pitching comes in stages: the
// starter, then whoever takes over at a set number of outs into the game (a follower, the
// bullpen). An inning one of them has to himself uses the hitters against him; an inning
// with a change in it uses, from each state, whoever is pitching at that state's outs.
import { facing, summarize } from "./sim.js?v=7";

const NS = 24;
const NY = 13; // a plate appearance's tallies for expectedLine: PA, the eleven outcomes, sacrifice flies
const probsOf = (cell) => Array.from(cell.cum, (c, i) => c - (i ? cell.cum[i - 1] : 0));
const maskOf = (digits) => digits.reduce((m, d) => (d >= 1 && d <= 3 ? m | (1 << (d - 1)) : m), 0);

// Per base-out state, everything that doesn't depend on who is batting:
//   endRun[s]       chance the running game ends the inning before the plate appearance
//   runRuns[s]      expected runs scored in the running game
//   T[c][s*24+t]    chance of reaching state t after a plate appearance ending in outcome c
//   endPA[c][s]     chance outcome c ends the inning
//   runsPA[c][s]    expected runs scored on outcome c (weighted by reaching the PA at all)
//   sfPA[c][s]      chance outcome c is a sacrifice fly (weighted the same way)
export function chainTables(model, ncats = 11) {
  const endRun = new Float64Array(NS), runRuns = new Float64Array(NS);
  const T = Array.from({ length: ncats }, () => new Float64Array(NS * NS));
  const endPA = Array.from({ length: ncats }, () => new Float64Array(NS));
  const runsPA = Array.from({ length: ncats }, () => new Float64Array(NS));
  const sfPA = Array.from({ length: ncats }, () => new Float64Array(NS));
  for (let mask = 0; mask < 8; mask++) {
    for (let outs = 0; outs < 3; outs++) {
      const s = mask * 3 + outs;
      const before = []; // [chance, mask, outs] going into the plate appearance
      if (!mask) {
        before.push([1, 0, outs]);
      } else {
        const cell = model.running[s], p = probsOf(cell);
        cell.codes.forEach((o, i) => {
          runRuns[s] += p[i] * o.runs;
          if (outs + o.outs >= 3) endRun[s] += p[i];
          else before.push([p[i], maskOf(o.digits), outs + o.outs]);
        });
      }
      for (const [pm, m1, o1] of before) {
        for (let c = 0; c < ncats; c++) {
          const cell = model.advance[(c * 8 + m1) * 3 + o1], p = probsOf(cell);
          cell.codes.forEach((o, i) => {
            const pr = pm * p[i];
            runsPA[c][s] += pr * o.runs;
            if (o.sf) sfPA[c][s] += pr;
            if (o1 + o.outs >= 3) endPA[c][s] += pr;
            else T[c][s * NS + maskOf(o.digits) * 3 + o1 + o.outs] += pr;
          });
        }
      }
    }
  }
  return { endRun, runRuns, T, endPA, runsPA, sfPA, ncats };
}

// One hitter's step through the chain, from that hitter's outcome chances (summing to 1).
// With `line`, also Y: the plate appearances, outcomes and sacrifice flies a step from
// each state is expected to add (for expectedLine).
export function hitterBlock(tab, probs, line = false) {
  const Q = new Float64Array(NS * NS), A = new Float64Array(NS), R = Float64Array.from(tab.runRuns);
  for (let c = 0; c < tab.ncats; c++) {
    const q = probs[c];
    if (!q) continue;
    const Tc = tab.T[c], Ec = tab.endPA[c], Rc = tab.runsPA[c];
    for (let i = 0; i < NS * NS; i++) Q[i] += q * Tc[i];
    for (let s = 0; s < NS; s++) {
      A[s] += q * Ec[s];
      R[s] += q * Rc[s];
    }
  }
  if (!line) return { Q, A, R };
  const Y = new Float64Array(NS * NY);
  for (let s = 0; s < NS; s++) {
    const reach = 1 - tab.endRun[s], row = s * NY;
    Y[row] = reach;
    for (let c = 0; c < tab.ncats; c++) {
      Y[row + 1 + c] = reach * probs[c];
      Y[row + 1 + tab.ncats] += probs[c] * tab.sfPA[c][s];
    }
  }
  return { Q, A, R, Y };
}

// A hitter's blocks against the pitching the lineup faces. `hitter` is as for facing()
// ({ all, parts }); `vs` is null for MLB-average pitching, or { sp: the starter's pitching,
// relief: [{ from, pitching }] }: who takes over later, in order, each at `from` outs into
// the game (empty when he pitches the whole game), every pitching as facing() takes it.
// `theta` moves the hitter along the contact-power axis (perSd) first. The blocks:
// { sp, relief: [{ from, block }] }.
export function matchup(tab, hitter, vs = null, line = false, theta = 0, perSd = null) {
  return { sp: hitterBlock(tab, facing(hitter, vs?.sp ?? null, theta, perSd), line),
    relief: (vs?.relief ?? []).map((r) => ({ from: r.from, block: hitterBlock(tab, facing(hitter, r.pitching, theta, perSd), line) })) };
}

// the relief stages of nine hitters' matchup() blocks, as expectedRuns() takes them
const reliefOf = (ms) => (ms[0].relief ?? []).map((r, i) => ({ from: r.from, blocks: ms.map((m) => m.relief[i].block) }));

// Exact expected runs for nine hitters' matchup() blocks in batting order, relief and all.
export function lineupRuns(tab, ms) {
  return expectedRuns(tab, ms.map((m) => m.sp), 9, reliefOf(ms));
}

// Expected runs over `innings` innings for nine hitter blocks in batting order, against
// the starter and then each of `relief` ([{ from, blocks }], the nine against that pitching)
// from `from` outs into the game. Within an inning: V_k = R_k + Q_k V_(k+1) (expected runs
// to the inning's end with hitter k due up) and N_k, the chance each hitter leads off the
// next inning, solved by sweeping round the order until nothing moves. Then innings chain
// through N.
export function expectedRuns(tab, blocks, innings = 9, relief = []) {
  let lead = new Float64Array(9), total = 0;
  lead[0] = 1;
  for (const { V, N } of byInning(tab, [{ from: 0, blocks }, ...relief], innings, solve)) {
    const next = new Float64Array(9);
    for (let k = 0; k < 9; k++) {
      if (!lead[k]) continue;
      total += lead[k] * V[k * NS];
      for (let j = 0; j < 9; j++) next[j] += lead[k] * N[k * NS * 9 + j];
    }
    lead = next;
  }
  return total;
}

// The solved inning for each inning of the game. `stages`: the pitching in order, each
// { from, blocks } (the first from 0), a stage taking over from the plate appearance that
// starts with `from` outs made in the game, as in the simulation. An inning one stage has
// to itself is solved on its blocks; an inning with a change in it, on blocks that step
// from each state by whoever pitches at its outs. Innings alike are solved once.
function byInning(tab, stages, innings, solver) {
  const at = (o) => stages.reduce((k, st, i) => (o >= st.from ? i : k), 0);
  const solved = new Map();
  return Array.from({ length: innings }, (_, i) => {
    const ks = [0, 1, 2].map((j) => at(i * 3 + j));
    const key = ks.join();
    if (!solved.has(key)) {
      solved.set(key, solver(tab, ks[0] === ks[2] ? stages[ks[0]].blocks
        : stages[0].blocks.map((_, h) => splitBlock(ks.map((k) => stages[k].blocks[h])))));
    }
    return solved.get(key);
  });
}

// a hitter's step from each state against whoever pitches at its outs: bs[j] from states with j outs
function splitBlock(bs) {
  const Q = new Float64Array(NS * NS), A = new Float64Array(NS), R = new Float64Array(NS);
  const Y = bs[0].Y ? new Float64Array(NS * NY) : null;
  for (let s = 0; s < NS; s++) {
    const b = bs[s % 3];
    Q.set(b.Q.subarray(s * NS, (s + 1) * NS), s * NS);
    A[s] = b.A[s];
    R[s] = b.R[s];
    if (Y) Y.set(b.Y.subarray(s * NY, (s + 1) * NY), s * NY);
  }
  return { Q, A, R, Y };
}

function solve(tab, blocks) {
  const V = new Float64Array(9 * NS), N = new Float64Array(9 * NS * 9), acc = new Float64Array(9);
  for (let sweep = 0; sweep < 200; sweep++) {
    let delta = 0;
    for (let k = 8; k >= 0; k--) {
      const { Q, A, R } = blocks[k], nk = (k + 1) % 9;
      for (let s = 0; s < NS; s++) {
        let v = R[s];
        acc.fill(0);
        acc[k] += tab.endRun[s];
        acc[nk] += A[s];
        const row = s * NS;
        for (let t = 0; t < NS; t++) {
          const q = Q[row + t];
          if (!q) continue;
          v += q * V[nk * NS + t];
          const base = (nk * NS + t) * 9;
          for (let j = 0; j < 9; j++) acc[j] += q * N[base + j];
        }
        const at = k * NS + s;
        delta = Math.max(delta, Math.abs(v - V[at]));
        V[at] = v;
        N.set(acc, at * 9);
      }
    }
    if (delta < 1e-13) break;
  }
  return { V, N };
}

// solve(), with every tally a plate appearance adds carried alongside the runs: V holds
// 1 + NY values per (hitter, state), runs first. Blocks need Y (hitterBlock's `line`).
const NV = 1 + NY;
function solveLine(tab, blocks) {
  const V = new Float64Array(9 * NS * NV), N = new Float64Array(9 * NS * 9);
  const acc = new Float64Array(9), v = new Float64Array(NV);
  for (let sweep = 0; sweep < 200; sweep++) {
    let delta = 0;
    for (let k = 8; k >= 0; k--) {
      const { Q, A, R, Y } = blocks[k], nk = (k + 1) % 9;
      for (let s = 0; s < NS; s++) {
        v[0] = R[s];
        v.set(Y.subarray(s * NY, (s + 1) * NY), 1);
        acc.fill(0);
        acc[k] += tab.endRun[s];
        acc[nk] += A[s];
        const row = s * NS;
        for (let t = 0; t < NS; t++) {
          const q = Q[row + t];
          if (!q) continue;
          const vb = (nk * NS + t) * NV;
          for (let y = 0; y < NV; y++) v[y] += q * V[vb + y];
          const base = (nk * NS + t) * 9;
          for (let j = 0; j < 9; j++) acc[j] += q * N[base + j];
        }
        const at = k * NS + s;
        for (let y = 0; y < NV; y++) delta = Math.max(delta, Math.abs(v[y] - V[at * NV + y]));
        V.set(v, at * NV);
        N.set(acc, at * 9);
      }
    }
    if (delta < 1e-12) break;
  }
  return { V, N };
}

// The expected nine-inning line of a lineup, exactly: summarize()'s numbers for nine
// matchup() blocks built with `line`, as a simulation would average them over endless games.
export function expectedLine(tab, ms, w, innings = 9) {
  const tot = new Float64Array(NV);
  let lead = new Float64Array(9);
  lead[0] = 1;
  const plan = byInning(tab, [{ from: 0, blocks: ms.map((m) => m.sp) }, ...reliefOf(ms)], innings, solveLine);
  for (const { V, N } of plan) {
    const next = new Float64Array(9);
    for (let k = 0; k < 9; k++) {
      if (!lead[k]) continue;
      for (let y = 0; y < NV; y++) tot[y] += lead[k] * V[k * NS * NV + y];
      for (let j = 0; j < 9; j++) next[j] += lead[k] * N[k * NS * 9 + j];
    }
    lead = next;
  }
  const [R, PA, K, BB, HBP, b1, b2, b3, HR] = tot, SF = tot[NV - 1];
  const H = b1 + b2 + b3 + HR;
  return summarize({ outs: innings * 3, R, PA, K, BB, HBP, "1B": b1, "2B": b2, "3B": b3, HR, H, SF, AB: PA - BB - HBP - SF }, w);
}

// expectedLine for several lineups whose matchups are already worked out: nine
// { sp, relief } each, the hitter's chances against the starter and against each relief
// stage in turn (relief empty when the starter goes nine), which take over at `from` outs
export function expectedLines(tab, lineups, from, w) {
  return lineups.map((l) => expectedLine(tab, l.map((x) => ({ sp: hitterBlock(tab, x.sp, true),
    relief: x.relief.map((p, i) => ({ from: from[i], block: hitterBlock(tab, p, true) })) })), w));
}

// expectedLines() when a relief stage takes over at "hook" (the hook model's, so at no set out):
// averaged over the outs it takes over at, mix [{ p, at }] (chances adding up to 1; at 27 he
// finishes the game). Each hitter's blocks are worked out once.
export function expectedLinesMix(tab, lineups, from, w, mix) {
  return lineups.map((l) => {
    const ms = l.map((x) => ({ sp: hitterBlock(tab, x.sp, true), relief: x.relief.map((p) => hitterBlock(tab, p, true)) }));
    const acc = {};
    for (const { p, at } of mix) {
      const line = expectedLine(tab, ms.map((m) => ({ sp: m.sp, relief: m.relief.map((block, i) => ({ from: from[i] === "hook" ? at : from[i], block })) })), w);
      for (const key in line) acc[key] = (acc[key] ?? 0) + p * line[key];
    }
    return acc;
  });
}
// a hook's outs, simulated ([outs 0..27] counts), as the mix expectedLinesMix() takes: outs that
// came up at least `min` of the time (2%: about a dozen, which moves runs per 9 by under .01 from
// every one), scaled to add up to 1
export function hookMix(outs, min = 0.02) {
  const n = outs.reduce((s, x) => s + x, 0);
  const kept = outs.map((c, at) => ({ p: c / n, at })).filter((m) => m.p >= min);
  const t = kept.reduce((s, m) => s + m.p, 0);
  return kept.map((m) => ({ p: m.p / t, at: m.at }));
}

// Best batting order and contact-power settings by exact expected runs.
//
// hitters, in their current batting order: { all, parts } as for facing(), plus `theta`
// (its setting now, in steps of 0.1) for an MLB-average spot that can move along the
// contact-power axis; a hitter without one stays as he is. Options:
//   order   search batting orders (swaps of unlocked slots)
//   tilt    search the settings of the movable hitters in unlocked slots
//   mix     "same": they trade contact for power among themselves, so their total (and
//           the lineup's average setting) stays where it is; "free": each goes anywhere
//   locked  slots whose hitter and setting stay put
//   perSd, range  the axis and its reach (data.tradeoff)
//   vs      the pitching faced, as for matchup(); hitters' chances are their own, and
//           the search combines them with the pitcher's (and moves them along the axis)
// Settings are searched in whole tenths. "free": each hitter in turn takes the best
// value on a half-step grid, then the best tenth around it. "same": moves of 1, 0.5,
// 0.2 or 0.1 from one hitter to another, taken whenever they help. Order: the best swap
// of two unlocked slots, until none helps. Settings and order alternate until neither
// improves. These are local searches over a flat landscape, so the search runs twice,
// from the lineup as given and from its settings made uniform (same total), and keeps
// the better. The pipeline's tests check it against brute force on smaller problems.
export function optimize(tab, hitters, opts, progress = () => {}) {
  const runs = [search(tab, hitters, opts, progress)];
  const movable = hitters.map((h, s) => (h.theta != null && !(opts.locked ?? []).includes(s) ? s : -1)).filter((s) => s >= 0);
  if (opts.tilt !== false && movable.length > 1) {
    // the same total spread as evenly as tenths allow (the free search starts from 0)
    const total = movable.reduce((t, s) => t + Math.round(hitters[s].theta * 10), 0);
    const even = opts.mix === "free" ? movable.map(() => 0)
      : movable.map((_, i) => Math.floor(total / movable.length) + (i < total - Math.floor(total / movable.length) * movable.length ? 1 : 0));
    if (movable.some((s, i) => Math.round(hitters[s].theta * 10) !== even[i])) {
      const start = hitters.map((h) => ({ ...h }));
      movable.forEach((s, i) => { start[s].theta = even[i] / 10; });
      const second = search(tab, start, opts, (n) => progress(runs[0].evals + n));
      second.before = runs[0].before;
      runs.push(second);
    }
  }
  const best = runs.reduce((a, b) => (b.after > a.after + 1e-12 ? b : a));
  return { ...best, evals: runs.reduce((n, r) => n + r.evals, 0) };
}

function search(tab, hitters, opts, progress) {
  const { order = true, tilt: doTilt = true, mix = "same", locked = [], perSd, range, vs = null } = opts;
  const lim = Math.round(range * 10);
  const tenth = hitters.map((h) => (h.theta != null ? Math.round(h.theta * 10) : null));
  const slot = hitters.map((_, i) => i); // slot -> hitter
  const free = slot.filter((s) => !locked.includes(s));
  const movable = free.filter((s) => tenth[s] != null); // hitters; locked slots never move
  const cache = new Map();
  let evals = 0;
  const block = (h) => {
    const key = tenth[h] == null ? `${h}` : `${h}@${tenth[h]}`;
    if (!cache.has(key)) {
      cache.set(key, matchup(tab, hitters[h], vs, false, tenth[h] == null ? 0 : tenth[h] / 10, perSd));
    }
    return cache.get(key);
  };
  const value = () => {
    if (++evals % 250 === 0) progress(evals);
    return lineupRuns(tab, slot.map(block));
  };
  const start = value();
  let best = start;

  const freePass = () => {
    let moved = false;
    for (const h of movable) {
      const was = tenth[h];
      let at = was, top = best;
      const tried = new Set([was]);
      const tryAt = (t) => {
        t = Math.max(-lim, Math.min(lim, t));
        if (tried.has(t)) return;
        tried.add(t);
        tenth[h] = t;
        const v = value();
        if (v > top + 1e-12) { top = v; at = t; }
      };
      for (let t = -lim; t <= lim; t += 5) tryAt(t);
      const coarse = at;
      for (let d = -4; d <= 4; d++) tryAt(coarse + d);
      tenth[h] = at;
      if (at !== was) { moved = true; best = top; }
    }
    return moved;
  };

  const samePass = () => {
    let moved = false;
    for (let again = true; again;) {
      again = false;
      for (const a of movable) {
        for (const b of movable) {
          if (a === b) continue;
          for (const d of [10, 5, 2, 1]) {
            if (tenth[a] + d > lim || tenth[b] - d < -lim) continue;
            tenth[a] += d;
            tenth[b] -= d;
            const v = value();
            if (v > best + 1e-12) { best = v; moved = again = true; break; }
            tenth[a] -= d;
            tenth[b] += d;
          }
        }
      }
    }
    return moved;
  };

  const orderPass = () => {
    let moved = false;
    for (;;) {
      let gain = 1e-12, pick = null;
      for (let a = 0; a < free.length; a++) {
        for (let b = a + 1; b < free.length; b++) {
          const [i, j] = [free[a], free[b]];
          [slot[i], slot[j]] = [slot[j], slot[i]];
          const v = value();
          [slot[i], slot[j]] = [slot[j], slot[i]];
          if (v - best > gain) { gain = v - best; pick = [i, j]; }
        }
      }
      if (!pick) return moved;
      const [i, j] = pick;
      [slot[i], slot[j]] = [slot[j], slot[i]];
      best += gain;
      moved = true;
    }
  };

  for (let r = 0; r < 12; r++) {
    const a = doTilt && movable.length ? (mix === "free" ? freePass() : movable.length > 1 && samePass()) : false;
    const b = order && free.length > 1 ? orderPass() : false;
    if (!a && !b) break;
  }
  return { slot, theta: tenth.map((t) => (t == null ? null : t / 10)), before: start,
    after: lineupRuns(tab, slot.map(block)), evals };
}
