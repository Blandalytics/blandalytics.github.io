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
// log5 (sim.js). A starter who leaves after a set number of outs hands over to the
// bullpen: innings before that use the hitters against him, innings after use them
// against the bullpen, and the inning he leaves in uses him while fewer than that many
// outs are made in it.
import { log5, summarize, tilt } from "./sim.js?v=3";

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

// A hitter's blocks against the pitching the lineup faces. `vs` is null for league-average
// pitching, or { p: the pitcher's chances, pen: the bullpen's (null when he pitches the
// whole game), league: the league's, hook: outs into the game when the bullpen takes over }.
export function matchup(tab, probs, vs = null, line = false) {
  if (!vs) return { sp: hitterBlock(tab, probs, line), pen: null };
  return { sp: hitterBlock(tab, log5(probs, vs.p, vs.league), line),
    pen: vs.pen ? hitterBlock(tab, log5(probs, vs.pen, vs.league), line) : null };
}

// Exact expected runs for nine hitters' matchup() blocks in batting order.
export function lineupRuns(tab, ms, vs = null) {
  return expectedRuns(tab, ms.map((m) => m.sp), 9, vs?.pen ? ms.map((m) => m.pen) : null, vs?.hook ?? 27);
}

// Expected runs over `innings` innings for nine hitter blocks in batting order, and with
// `pen` (the nine against the bullpen) the bullpen taking over once `hook` outs are made.
// Within an inning: V_k = R_k + Q_k V_(k+1) (expected runs to the inning's end with
// hitter k due up) and N_k, the chance each hitter leads off the next inning, solved by
// sweeping round the order until nothing moves. Then innings chain through N.
export function expectedRuns(tab, blocks, innings = 9, pen = null, hook = innings * 3) {
  let lead = new Float64Array(9), total = 0;
  lead[0] = 1;
  for (const { V, N } of byInning(tab, blocks, innings, pen, hook, solve)) {
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

// The solved inning for each inning of the game: the starter's until the inning the hook
// falls in, that inning split at the hook, then the bullpen's.
function byInning(tab, blocks, innings, pen, hook, solver) {
  const k = pen ? Math.max(0, Math.min(innings, Math.floor(hook / 3))) : innings, j = pen ? hook % 3 : 0;
  const sp = k > 0 ? solver(tab, blocks) : null;
  const bp = k < innings ? solver(tab, pen) : null;
  const mid = j && k < innings ? solver(tab, blocks.map((b, h) => splitBlock(b, pen[h], j))) : null;
  return Array.from({ length: innings }, (_, i) => (i < k ? sp : i === k && mid ? mid : bp));
}

// a hitter's step against the starter from states with fewer than j outs, the bullpen from the rest
function splitBlock(a, b, j) {
  const Q = Float64Array.from(b.Q), A = Float64Array.from(b.A), R = Float64Array.from(b.R);
  const Y = b.Y ? Float64Array.from(b.Y) : null;
  for (let s = 0; s < NS; s++) {
    if (s % 3 >= j) continue;
    Q.set(a.Q.subarray(s * NS, (s + 1) * NS), s * NS);
    A[s] = a.A[s];
    R[s] = a.R[s];
    if (Y) Y.set(a.Y.subarray(s * NY, (s + 1) * NY), s * NY);
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
export function expectedLine(tab, ms, vs, w, innings = 9) {
  const tot = new Float64Array(NV);
  let lead = new Float64Array(9);
  lead[0] = 1;
  const plan = byInning(tab, ms.map((m) => m.sp), innings, vs?.pen ? ms.map((m) => m.pen) : null, vs?.hook ?? innings * 3, solveLine);
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

// expectedLine for several lineups of raw outcome chances (nine arrays each) against `vs`
export function expectedLines(tab, lineups, vs, w) {
  return lineups.map((l) => expectedLine(tab, l.map((p) => matchup(tab, p, vs, true)), vs, w));
}

// Best batting order and contact-power settings by exact expected runs.
//
// hitters, in their current batting order: { probs } for a hitter as is, or
// { base, theta } for an MLB-average spot that can move along the contact-power axis
// (base: its counts; theta: its setting now, in steps of 0.1). Options:
//   order   search batting orders (swaps of unlocked slots)
//   tilt    search the settings of the movable hitters in unlocked slots
//   mix     "same": they trade contact for power among themselves, so their total (and
//           the lineup's average setting) stays where it is; "free": each goes anywhere
//   locked  slots whose hitter and setting stay put
//   perSd, range  the axis and its reach (data.tradeoff)
//   vs      the pitching faced, as for matchup(); hitters' chances are their own, and
//           the search combines them with the pitcher's
// Settings are searched in whole tenths. "free": each hitter in turn takes the best
// value on a half-step grid, then the best tenth around it. "same": moves of 1, 0.5,
// 0.2 or 0.1 from one hitter to another, taken whenever they help. Order: the best swap
// of two unlocked slots, until none helps. Settings and order alternate until neither
// improves. These are local searches over a flat landscape, so the search runs twice,
// from the lineup as given and from its settings made uniform (same total), and keeps
// the better. The pipeline's tests check it against brute force on smaller problems.
export function optimize(tab, hitters, opts, progress = () => {}) {
  const runs = [search(tab, hitters, opts, progress)];
  const movable = hitters.map((h, s) => (h.base && !(opts.locked ?? []).includes(s) ? s : -1)).filter((s) => s >= 0);
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
  const tenth = hitters.map((h) => (h.base ? Math.round(h.theta * 10) : null));
  const slot = hitters.map((_, i) => i); // slot -> hitter
  const free = slot.filter((s) => !locked.includes(s));
  const movable = free.filter((s) => tenth[s] != null); // hitters; locked slots never move
  const cache = new Map();
  let evals = 0;
  const block = (h) => {
    const key = tenth[h] == null ? `${h}` : `${h}@${tenth[h]}`;
    if (!cache.has(key)) {
      const p = tenth[h] == null ? hitters[h].probs : tilt(hitters[h].base, perSd, tenth[h] / 10);
      cache.set(key, matchup(tab, p, vs));
    }
    return cache.get(key);
  };
  const value = () => {
    if (++evals % 250 === 0) progress(evals);
    return lineupRuns(tab, slot.map(block), vs);
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
    after: lineupRuns(tab, slot.map(block), vs), evals };
}
