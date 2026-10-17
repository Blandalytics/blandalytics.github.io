// Lineup simulator engine, shared by the page (app.js) and pipeline/precompute.mjs.
//
// A game is 27 outs (9 innings) of one lineup batting in order. Before each plate
// appearance with runners on, a running-game result is drawn for the base-out state
// (steals, caught stealing, pickoffs, wild pitches, passed balls, balks); if that ends
// the inning, the same hitter leads off the next one. Then the hitter's outcome is
// drawn from the hitter's rates, and what the runners and the hitter do on it is drawn from
// the league's 2026 results for that outcome in that base-out state. Against a given
// pitcher, the hitter's rates are first combined with the pitcher's by log5 (below).
//
// Baserunning is league average throughout. Runner-specific baserunning would replace
// pickRunning / pickAdvance with draws that also see who is on base (`bases` holds the
// lineup slot of each runner for that reason).

export const CATS = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "GB", "LD", "FB", "PU"];
const C = Object.fromEntries(CATS.map((c, i) => [c, i]));

// sfc32: small, fast, seedable
export function rng(seed = 1) {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next();
  return next;
}

// A table cell: outcomes as digit arrays (lead runner first, then the batter) with a
// cumulative probability for each. Cells thinner than MIN_CELL borrow from the same
// outcome and runners at the other out counts, keeping only results possible there.
const MIN_CELL = 30;

function cell(entries, outs) {
  const codes = [], weights = [];
  for (const [code, n] of entries) {
    const sf = code.endsWith("s");
    const digits = [...(sf ? code.slice(0, -1) : code)].map(Number);
    if (outs + digits.filter((d) => d === 0).length > 3) continue;
    codes.push({ digits, sf, runs: digits.filter((d) => d === 4).length, outs: digits.filter((d) => d === 0).length });
    weights.push(n);
  }
  const total = weights.reduce((s, x) => s + x, 0);
  let acc = 0;
  const cum = Float64Array.from(weights, (x) => (acc += x) / total);
  return { codes, cum, n: total };
}

function withPrior(entries, pooled) {
  const n = entries.reduce((s, [, k]) => s + k, 0);
  if (n >= MIN_CELL || !pooled.length) return entries;
  const pn = pooled.reduce((s, [, k]) => s + k, 0);
  const scale = (MIN_CELL - n) / pn;
  const m = new Map(entries);
  for (const [code, k] of pooled) m.set(code, (m.get(code) ?? 0) + k * scale);
  return [...m.entries()];
}

// Turn the data file's tables into lookup arrays: running[mask*3+outs] and
// advance[(cat*8+mask)*3+outs].
export function prepare(data) {
  const running = new Array(24).fill(null);
  for (const [key, entries] of Object.entries(data.running)) {
    const [mask, outs] = key.split(",").map(Number);
    running[mask * 3 + outs] = cell(entries, outs);
  }
  const advance = new Array(CATS.length * 24).fill(null);
  const pooled = {};
  for (const [key, entries] of Object.entries(data.advance)) {
    const [cat, mask] = key.split(",");
    const p = (pooled[`${cat},${mask}`] ??= new Map());
    for (const [code, n] of entries) p.set(code, (p.get(code) ?? 0) + n);
  }
  for (const cat of CATS) {
    for (let mask = 0; mask < 8; mask++) {
      for (let outs = 0; outs < 3; outs++) {
        const own = data.advance[`${cat},${mask},${outs}`] ?? [];
        const pool = [...(pooled[`${cat},${mask}`] ?? new Map()).entries()];
        const c = cell(withPrior(own, pool), outs);
        if (!c.codes.length) throw new Error(`no ${cat} results with bases ${mask}, ${outs} out`);
        advance[(C[cat] * 8 + mask) * 3 + outs] = c;
      }
    }
  }
  return { running, advance };
}

// A hitter's outcome probabilities (cumulative, in CATS order) from counts. `regress`
// adds that many plate appearances at `prior` rates (MLB average) to small samples.
export function rates(counts, prior = null, regress = 0) {
  return cumulative(chances(counts, prior, regress));
}

// rates(), not cumulative: the chance of each outcome
export function chances(counts, prior = null, regress = 0) {
  const n = counts.reduce((s, x) => s + x, 0);
  return counts.map((x, i) => (regress && prior ? (x + regress * prior[i]) / (n + regress) : x / n));
}

export function cumulative(probs) {
  let acc = 0;
  return Float64Array.from(probs, (x) => (acc += x));
}

// A hitter's outcome chances against a pitcher by log5 (the odds-ratio method, one
// outcome at a time): hitter × pitcher / league for each of the eleven, then scaled to sum
// to 1. `b`, `p` and `l` are the hitter's, the pitcher's and the league's chances (each
// summing to 1). A league-average pitcher leaves the hitter as he is, and a
// league-average hitter takes on the pitcher's rates. Returns plain chances, not cumulative.
export function log5(b, p, l) {
  const q = Array.from(b, (x, i) => (l[i] > 0 ? (x * p[i]) / l[i] : 0));
  const t = q.reduce((s, x) => s + x, 0);
  // only when every outcome the hitter has is one the pitcher never allowed
  return t > 0 ? q.map((x) => x / t) : Array.from(b);
}

// ---- platoon splits: building facing()'s hitters and pitching from the data file ----
//
// Counts by "cell": the pitcher's hand and the side the batter hit from ("RL" is a lefty
// batting against a right-hander). `league` is { all, cells }: the league's chances overall
// and in each cell, the baselines log5 needs. Modes:
//   "own"     each player's 2026 rates in each split (Small samples adds `regress` PA at
//             his "league" rates for that split, below, so a thin split leans on the rest
//             of his season rather than on the league)
//   "league"  each player's overall rates, moved by the league's platoon gap: in each
//             cell, times the league's rate there over the league's rate for the mix of
//             matchups the player had (steadier where a split is a small sample)
//   "off"     overall rates for everyone, as before
// A split with no plate appearances at all falls back to "league".
const HANDS = ["R", "L"], SIDES = ["L", "R"];
const sumOf = (c) => (c ? c.reduce((s, x) => s + x, 0) : 0);
const scaled = (x) => {
  const t = x.reduce((s, v) => s + v, 0);
  return x.map((v) => v / t);
};
// `all` moved from the league's mix of the given cells (weights) to cell k
const gapped = (all, mix, cell) => scaled(all.map((x, i) => (mix[i] > 0 ? (x * cell[i]) / mix[i] : 0)));
function mixOf(league, weights) {
  const n = Object.values(weights).reduce((s, x) => s + x, 0);
  const m = new Array(CATS.length).fill(0);
  for (const [k, x] of Object.entries(weights)) league.cells[k].forEach((v, i) => { m[i] += (x / n) * v; });
  return m;
}

// A hitter or a pooled lineup spot, for facing(). cells: { RL: counts, ... }; bats "L", "R",
// "S" or "" (for which side he'd bat from in a split he has no plate appearances in).
export function hitterOf(counts, cells, { mode = "off", league, regress = 0, bats = "" } = {}) {
  const all = chances(counts, league.all, regress);
  if (mode === "off" || !cells) return { all };
  const pa = Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, sumOf(c)]));
  const mix = mixOf(league, pa);
  const lefty = (pa.RL ?? 0) + (pa.LL ?? 0), righty = (pa.RR ?? 0) + (pa.LR ?? 0);
  const usual = bats === "L" || bats === "R" ? bats : lefty > righty ? "L" : "R";
  const parts = {};
  for (const hand of HANDS) {
    const sides = SIDES.filter((s) => pa[hand + s] > 0);
    const n = sides.reduce((t, s) => t + pa[hand + s], 0);
    if (!n) {
      const side = bats === "S" ? (hand === "R" ? "L" : "R") : usual;
      parts[hand] = [{ w: 1, side, b: gapped(all, mix, league.cells[hand + side]) }];
      continue;
    }
    parts[hand] = sides.map((side) => {
      const k = hand + side;
      return { w: pa[k] / n, side,
        b: mode === "own" ? chances(cells[k], gapped(all, mix, league.cells[k]), regress) : gapped(all, mix, league.cells[k]) };
    });
  }
  return { all, parts };
}

// A pitcher, as facing()'s pitching: cells by batter side ({ L: counts, R: counts }).
export function pitcherOf(counts, cells, hand, { mode = "off", league, regress = 0 } = {}) {
  const all = chances(counts, league.all, regress);
  if (mode === "off" || !cells) return [{ w: 1, hand: "", p: { "": all }, l: { "": league.all } }];
  const h = hand === "L" ? "L" : "R";
  const mix = mixOf(league, Object.fromEntries(SIDES.map((s) => [h + s, sumOf(cells[s])])));
  const p = {}, l = {};
  for (const side of SIDES) {
    const k = h + side;
    l[side] = league.cells[k];
    const gap = gapped(all, mix, league.cells[k]);
    p[side] = mode === "own" && sumOf(cells[side]) ? chances(cells[side], gap, regress) : gap;
  }
  return [{ w: 1, hand: h, p, l }];
}

// A bullpen, as facing()'s pitching: its relievers pooled, right- and left-handers in the
// shares they pitched (cells keyed hand + side, as the league's). MLB's bullpen, a team's,
// or MLB's bulk relief (relief outings of 3+ innings).
export function bullpenOf(counts, cells, { mode = "off", league } = {}) {
  if (mode === "off" || !cells) return [{ w: 1, hand: "", p: { "": scaled(counts) }, l: { "": league.all } }];
  const n = sumOf(counts);
  return HANDS.map((h) => ({
    w: SIDES.reduce((t, s) => t + sumOf(cells[h + s]), 0) / n, hand: h,
    p: Object.fromEntries(SIDES.map((s) => [s, scaled(cells[h + s])])),
    l: Object.fromEntries(SIDES.map((s) => [s, league.cells[h + s]])),
  }));
}

// A hitter's outcome chances against one stretch of pitching (the starter, a follower, or the bullpen).
//
// hitter: { all, parts }. `all` is his chances overall. `parts`, for platoon splits, holds
// his chances against each pitcher hand, split by the side he batted from:
// parts.R = [{ w, b, side }] against right-handers (w: the share of those PAs, b: chances,
// side: "L" or "R"), and parts.L the same against left-handers. A pooled lineup spot has a
// part for each side; most hitters have one.
// pitching: [{ w, hand, p, l }], one entry per pitcher hand in the mix (a starter has one;
// a bullpen has a right- and a left-handed share): w its share, hand "R", "L", or "" with
// platoon splits off, p the pitcher's chances against each batter side (p.L, p.R; p[""]
// with splits off), and l the league's for the same matchups.
// null pitching is MLB-average pitching: the hitter as he is. `theta` moves every part
// along the contact-power axis first (tilt).
// A hitter with `pitch` set is the per-pitch model's instead (facingByPitch(), below).
export function facing(hitter, pitching, theta = 0, perSd = null) {
  if (hitter.pitch) return facingByPitch(hitter, pitching, theta, perSd);
  const mv = (b) => (theta ? tilt(b, perSd, theta) : b);
  if (!pitching) return mv(hitter.all);
  const q = new Array(CATS.length).fill(0);
  for (const c of pitching) {
    const parts = (c.hand && hitter.parts?.[c.hand]) || [{ w: 1, b: hitter.all, side: "" }];
    for (const part of parts) {
      const x = log5(mv(part.b), c.p[part.side], c.l[part.side]);
      for (let i = 0; i < x.length; i++) q[i] += c.w * part.w * x[i];
    }
  }
  return q;
}

// ---- the per-pitch model ("Per-Pitch (modeled)"; pipeline/pitch_model.py) ----
//
// A plate appearance built pitch by pitch. In each of the 12 counts a pitch goes through a
// chain of steps: in the zone or not; swing or take; a take's ball, called strike or HBP; a
// swing's contact or whiff; contact in play or foul; in play, a home run or not, then the other
// seven batted balls. Each step's chances are the league's in that count (and zone), in that
// platoon cell, times the hitter's and the pitcher's ratios to the league, scaled to add up to 1
// (log5 a step at a time). Walking the counts, where three balls and a ball is a walk, two strikes
// and a strike a strikeout, and a two-strike foul leaves the count as it was, gives the eleven
// outcomes facing() returns.
// tables: a cell's (or "all"'s) seven step tables, each [context][class] flat (contexts: the
// count, or count * 2 + zone). h, p: the hitter's and the pitcher's 13 ratios, each step's
// classes after the first over its first, in step order; null is MLB average.
const STEP_K = [2, 2, 3, 2, 2, 2, 7];               // zone swing take contact fair hr inplay
const STEP_AT = [0, 1, 2, 4, 5, 6, 7];              // where each step's ratios start among the 13
const COUNT_ORDER = [0, 1, 3, 2, 4, 6, 5, 7, 9, 8, 10, 11]; // balls * 3 + strikes, each after the counts that lead to it
const REST_AT = [3, 4, 5, 7, 8, 9, 10];             // the inplay step's 1B 2B 3B GB LD FB PU in CATS
const scratch = STEP_K.map((k) => new Float64Array(k));
function stepAt(tables, h, p, s, ctx) {
  const K = STEP_K[s], t = tables[s], o = STEP_AT[s] - 1, out = scratch[s];
  let sum = 0;
  for (let k = 0; k < K; k++) {
    const x = t[ctx * K + k] * (k ? (h ? h[o + k] : 1) * (p ? p[o + k] : 1) : 1);
    out[k] = x;
    sum += x;
  }
  for (let k = 0; k < K; k++) out[k] /= sum;
  return out;
}
export function pitchChances(tables, h, p) {
  const pB = new Float64Array(12), pCS = new Float64Array(12), pSS = new Float64Array(12), pF = new Float64Array(12);
  const pX = new Float64Array(12), pH = new Float64Array(12), pHR = new Float64Array(12), rest = [];
  for (let c = 0; c < 12; c++) {
    const pz = stepAt(tables, h, p, 0, c)[1];
    for (let z = 0; z < 2; z++) {
      const wz = z ? pz : 1 - pz, ctx = c * 2 + z;
      const sw = stepAt(tables, h, p, 1, ctx)[1];
      const tk = stepAt(tables, h, p, 2, ctx);
      const take = wz * (1 - sw), swing = wz * sw;
      pB[c] += take * tk[0];
      pCS[c] += take * tk[1];
      pH[c] += take * tk[2];
      const con = stepAt(tables, h, p, 3, ctx)[1], fair = stepAt(tables, h, p, 4, ctx)[1];
      pSS[c] += swing * (1 - con);
      pF[c] += swing * con * (1 - fair);
      pX[c] += swing * con * fair;
    }
    pHR[c] = stepAt(tables, h, p, 5, c)[1];
    rest.push(Float64Array.from(stepAt(tables, h, p, 6, c)));
  }
  const arrive = new Float64Array(12), out = new Array(CATS.length).fill(0);
  arrive[0] = 1;
  for (const c of COUNT_ORDER) {
    const b = Math.floor(c / 3), s = c % 3;
    // with two strikes a foul loops back: the count is left, on average, 1 / (1 - foul) pitches later
    const v = s === 2 ? arrive[c] / (1 - Math.min(pF[c], 0.999)) : arrive[c];
    if (b === 3) out[C.BB] += v * pB[c];
    else arrive[c + 3] += v * pB[c];
    const strike = pCS[c] + pSS[c] + (s < 2 ? pF[c] : 0);
    if (s === 2) out[C.K] += v * strike;
    else arrive[c + 1] += v * strike;
    out[C.HBP] += v * pH[c];
    const x = v * pX[c];
    out[C.HR] += x * pHR[c];
    for (let j = 0; j < 7; j++) out[REST_AT[j]] += x * (1 - pHR[c]) * rest[c][j];
  }
  return out;
}

// facing() for the per-pitch model. hitter.pitch: { tables, all, gap, cells, theta, perSd }:
// the league's tables ({ all, RR, RL, LR, LL }); his ratios with platoon splits off (`all`),
// against the league in the cells he played in (`gap`), and in each cell as the mode has it
// (`cells`: his own, or none for the league's gap); `theta` his contact-power setting. Each
// pitching entry's `pitch` is the same for the pitcher's side ({ all, gap, cells }), or null
// for MLB average. `theta` and `perSd` as for facing().
// The setting moves him as log5 does with the per-PA model (log5(tilt(b), p, l)): in each cell,
// his chances against the pitching are scaled, outcome by outcome, by how far the setting moves
// his chances against MLB-average pitching in that cell (tilt(a) / a), then renormalized. So a
// power setting costs more strikeouts against a strikeout pitcher than against an average one,
// and against MLB-average pitching it is the tilt itself. It's worked as tilt(a) times the
// pitching's effect (q / a), which stays finite where a is tiny; where a is (nearly) 0 the
// effect is taken as none, so the tilt itself.
// The chains don't depend on the setting, so each hitter's are kept per pitching (the optimizer
// tries setting after setting against the same pitching).
const chained = new WeakMap();
const TINY = 1e-12;
function facingByPitch(hitter, pitching, theta, perSd) {
  const hp = hitter.pitch, th = (hp.theta ?? 0) + theta;
  let seen = chained.get(hp);
  if (!seen) chained.set(hp, (seen = new Map()));
  let ch = seen.get(pitching);
  if (!ch) seen.set(pitching, (ch = chainParts(hitter, pitching)));
  if (!th) return ch.q.slice();
  const per = perSd ?? hp.perSd;
  if (!pitching) return tilt(ch.q, per, th);
  const q = new Array(CATS.length).fill(0);
  for (const { w, q: x, a } of ch.parts) {
    const t = tilt(a, per, th), y = t.map((v, i) => (a[i] > TINY ? v * (x[i] / a[i]) : v));
    const sum = y.reduce((s, v) => s + v, 0);
    for (let i = 0; i < y.length; i++) q[i] += w * (sum > 0 ? y[i] / sum : x[i]);
  }
  return q;
}
// a hitter's chains against the pitching: by part (pitcher hand and batter side, as facing()
// splits them) his chances against it (q) and against MLB-average pitching in the same cell (a),
// with the part's weight; and q, all parts together
function chainParts(hitter, pitching) {
  const hp = hitter.pitch;
  if (!pitching) {
    const a = pitchChances(hp.tables.all, hp.all, null);
    return { q: a, parts: [{ w: 1, q: a, a }] };
  }
  const parts = [];
  for (const c of pitching) {
    const cell = c.hand && hitter.parts?.[c.hand];
    if (!cell) {
      parts.push({ w: c.w, q: pitchChances(hp.tables.all, hp.all, c.pitch?.all ?? null), a: pitchChances(hp.tables.all, hp.all, null) });
      continue;
    }
    for (const part of cell) {
      const k = c.hand + part.side, pp = c.pitch, own = hp.cells?.[k] ?? hp.gap;
      parts.push({ w: c.w * part.w, q: pitchChances(hp.tables[k], own, pp ? pp.cells?.[k] ?? pp.gap : null), a: pitchChances(hp.tables[k], own, null) });
    }
  }
  const q = new Array(CATS.length).fill(0);
  for (const { w, q: x } of parts) for (let i = 0; i < x.length; i++) q[i] += w * x[i];
  return { q, parts };
}

// Move an outcome profile (counts or rates, in CATS order) along the contact-power axis
// (data.tradeoff.per_sd) by `theta` standard deviations of 2026 hitters: negative is
// the contact end (fewer strikeouts, more singles and balls in play), positive the
// power end (more strikeouts, walks and homers). The axis sums to zero and carries no
// wOBA, so the profile keeps its wOBA. Rates are floored at zero, which only comes into
// play beyond data.tradeoff.range.
export function tilt(counts, perSd, theta) {
  const n = counts.reduce((s, x) => s + x, 0);
  return counts.map((x, i) => Math.max(0, x / n + theta * perSd[i]));
}

function pick(cum, r) {
  let i = 0;
  while (i < cum.length - 1 && r >= cum[i]) i++;
  return i;
}

// Move the runners (and the batter, slot `up`, when there is one) by a drawn outcome.
// Returns the runs scored; credits each run to the scoring runner's slot.
function move(bases, lead, o, up, spotR) {
  let k = 0;
  if (bases[3] >= 0) lead[k++] = bases[3];
  if (bases[2] >= 0) lead[k++] = bases[2];
  if (bases[1] >= 0) lead[k++] = bases[1];
  if (up >= 0) lead[k++] = up;
  bases[1] = bases[2] = bases[3] = -1;
  let runs = 0;
  for (let i = 0; i < k; i++) {
    const d = o.digits[i];
    if (d === 4) { spotR[lead[i]]++; runs++; } else if (d > 0) bases[d] = lead[i];
  }
  return runs;
}

const maskOf = (bases) => (bases[1] >= 0 ? 1 : 0) | (bases[2] >= 0 ? 2 : 0) | (bases[3] >= 0 ? 4 : 0);

// An inning that reaches this many plate appearances is called off, so a lineup of
// hitters who never made an out in 2026 (a 1-for-1 call-up, say) can't run forever.
// Results report how many innings it happened in (`capped`).
const MAX_INNING_PA = 60;

// ---- the modeled hook ("Modeled hook"; pipeline/hook_model.py) ----
// The chance the starter is taken out after a plate appearance, from the hook model's trees
// (LightGBM's, flattened: a node's split feature, threshold, default-left, missing type 0 none,
// 1 zero, 2 NaN, and children, a child below zero being leaf ~child) and x, the features in
// the model's order (NaN for one it doesn't know).
export function hookChance(T, x) {
  let raw = 0;
  for (let t = 0; t < T.roots.length; t++) {
    let n = T.roots[t];
    while (n >= 0) {
      let v = x[T.feat[n]], left;
      const mt = T.miss[n];
      if (Number.isNaN(v)) {
        if (mt === 2) left = T.dl[n] === 1;
        else v = 0;
      }
      if (left === undefined) left = mt === 1 && v === 0 ? T.dl[n] === 1 : v <= T.thr[n];
      n = left ? T.left[n] : T.right[n];
    }
    raw += T.leaf[~n];
  }
  return 1 / (1 + Math.exp(-raw));
}
const HOOK_IN_GAME = ["pc", "bf_so_far", "outs_so_far", "h_so_far", "hr_so_far", "bb_so_far", "k_so_far", "r_so_far", "tto_next",
  "inning", "outs_in_inn", "inning_end", "runners_after", "margin", "inn_pitches", "inn_runs", "inn_reached", "max_inn_pitches",
  "prev_inn_pitches", "last3_reached"];

// Simulate `games` 9-inning games for a lineup of 9 cumulative-rate arrays.
// Returns season-style totals plus the per-game run distribution and per-spot lines.
// `relief` is who pitches after the starter, in order: [{ from, lineup }], `lineup` another
// 9 arrays (the lineup against that pitching), taking over from the plate appearance that
// starts with `from` outs made in the game. A follower and then the bullpen are two.
// A stage with `from` "hook" takes over when the hook model takes the starter out. `hook` is then
// { trees, features (names, in the model's order), x (a Float64Array of them, the before-the-game
// ones filled in), pitches (each outcome's pitch count, cumulative, by CATS: index 0 is one
// pitch), runsPerInning (his team's side of the score, which isn't played) }. After each of the
// starter's plate appearances, and an inning ended on the bases, the game so far fills in the
// rest of x and a draw against hookChance() says whether he goes; the result's `hook` counts the
// outs he had made when he went (27: the whole game) and his pitches.
export function simulate(model, lineup, games, seed = 1, relief = [], hook = null) {
  const rand = rng(seed);
  const { running, advance } = model;
  const t = { G: games, PA: 0, AB: 0, H: 0, "1B": 0, "2B": 0, "3B": 0, HR: 0, BB: 0, HBP: 0, K: 0, SF: 0, R: 0, outs: 0 };
  const runDist = new Float64Array(31);
  const spotPA = new Float64Array(9), spotR = new Float64Array(9);
  const lead = [0, 0, 0, 0];
  const bases = [-1, -1, -1, -1]; // bases[1..3]: lineup slot of the runner, -1 empty
  let capped = 0;
  const atHook = relief.map((r) => r.from === "hook");
  const hooks = !!hook && atHook.some(Boolean);
  const x = hooks ? Float64Array.from(hook.x) : null;
  const F = hooks ? Object.fromEntries(HOOK_IN_GAME.map((key) => [key, hook.features.indexOf(key)])) : null;
  const hookOuts = new Float64Array(28);
  let hookPitches = 0;
  // the starter's game so far
  let gone = !hooks, pc = 0, bf = 0, made = 0, h = 0, hr = 0, bb = 0, k = 0, runs = 0;
  let innPitches = 0, innRuns = 0, innReached = 0, maxInn = 0, prevInn = 0;
  const last3 = [0, 0, 0];
  const boundary = (inning, outs, end, gameRuns) => {
    x[F.pc] = pc; x[F.bf_so_far] = bf; x[F.outs_so_far] = made; x[F.h_so_far] = h; x[F.hr_so_far] = hr;
    x[F.bb_so_far] = bb; x[F.k_so_far] = k; x[F.r_so_far] = runs; x[F.tto_next] = Math.floor(bf / 9) + 1;
    x[F.inning] = inning + 1; x[F.outs_in_inn] = end ? 0 : outs; x[F.inning_end] = end ? 1 : 0;
    x[F.runners_after] = end ? 0 : (bases[1] >= 0) + (bases[2] >= 0) + (bases[3] >= 0);
    // his team's runs aren't played: its share of a half-inning's runs per inning it has batted, on average
    x[F.margin] = hook.runsPerInning * (inning + 0.5) - gameRuns;
    x[F.inn_pitches] = innPitches; x[F.inn_runs] = innRuns; x[F.inn_reached] = innReached;
    x[F.max_inn_pitches] = maxInn; x[F.prev_inn_pitches] = prevInn; x[F.last3_reached] = last3[0] + last3[1] + last3[2];
    if (rand() < hookChance(hook.trees, x)) {
      gone = true;
      hookOuts[Math.min(inning * 3 + Math.min(outs, 3), 27)]++;
      hookPitches += pc;
    }
  };

  for (let g = 0; g < games; g++) {
    let up = 0, gameRuns = 0;
    if (hooks) {
      gone = false;
      pc = bf = made = h = hr = bb = k = runs = innPitches = innRuns = innReached = maxInn = prevInn = 0;
      last3[0] = last3[1] = last3[2] = 0;
    }
    for (let inning = 0; inning < 9; inning++) {
      let outs = 0, pas = 0;
      bases[1] = bases[2] = bases[3] = -1;
      if (!gone && inning > 0) {
        prevInn = innPitches;
        innPitches = innRuns = innReached = 0;
      }
      while (outs < 3) {
        if (++pas > MAX_INNING_PA) { capped++; break; }
        // who's pitching is settled as the plate appearance starts, before any running
        let bat = lineup;
        for (let r = 0; r < relief.length; r++) if (atHook[r] ? gone : inning * 3 + outs >= relief[r].from) bat = relief[r].lineup;
        const starter = !gone, runs0 = gameRuns, outs0 = outs;
        let mask = maskOf(bases);
        if (mask) {
          const cr = running[mask * 3 + outs];
          const o = cr.codes[pick(cr.cum, rand())];
          gameRuns += move(bases, lead, o, -1, spotR);
          outs += o.outs;
          if (outs >= 3) {
            // the inning ended on the bases; this hitter leads off the next
            if (starter) {
              made += outs - outs0; runs += gameRuns - runs0; innRuns += gameRuns - runs0;
              boundary(inning, outs, true, gameRuns);
            }
            break;
          }
          mask = maskOf(bases);
        }
        const cat = pick(bat[up], rand());
        const ca = advance[(cat * 8 + mask) * 3 + outs];
        const o = ca.codes[pick(ca.cum, rand())];
        gameRuns += move(bases, lead, o, up, spotR);
        outs += o.outs;
        if (starter) {
          const n = pick(hook.pitches[cat], rand()) + 1;
          const reached = cat === C.BB || cat === C.HBP || cat === C["1B"] || cat === C["2B"] || cat === C["3B"] || cat === C.HR;
          pc += n; innPitches += n; if (innPitches > maxInn) maxInn = innPitches;
          bf++; made += outs - outs0; runs += gameRuns - runs0; innRuns += gameRuns - runs0;
          if (cat === C.BB || cat === C.HBP) bb++;
          else if (cat === C.K) k++;
          else if (reached) { h++; if (cat === C.HR) hr++; }
          if (reached) innReached++;
          last3[bf % 3] = reached ? 1 : 0;
          boundary(inning, outs, outs >= 3, gameRuns);
        }
        spotPA[up]++;
        t.PA++;
        switch (cat) {
          case C.BB: t.BB++; break;
          case C.HBP: t.HBP++; break;
          case C.K: t.K++; t.AB++; break;
          case C["1B"]: t["1B"]++; t.H++; t.AB++; break;
          case C["2B"]: t["2B"]++; t.H++; t.AB++; break;
          case C["3B"]: t["3B"]++; t.H++; t.AB++; break;
          case C.HR: t.HR++; t.H++; t.AB++; break;
          default: if (o.sf) t.SF++; else t.AB++;
        }
        up = (up + 1) % 9;
      }
      t.outs += 3;
    }
    t.R += gameRuns;
    runDist[Math.min(gameRuns, 30)]++;
    if (hooks && !gone) {
      hookOuts[27]++;
      hookPitches += pc;
    }
  }
  return { totals: t, runDist: Array.from(runDist), spotPA: Array.from(spotPA), spotR: Array.from(spotR), capped,
    ...(hooks && { hook: { outs: Array.from(hookOuts), pitches: hookPitches, games } }) };
}

// Per-game and rate stats from simulate()'s totals, using the season's wOBA weights.
export function summarize(totals, w) {
  const t = totals;
  const per = (x) => (x * 27) / t.outs;
  const obpDen = t.AB + t.BB + t.HBP + t.SF;
  const tb = t["1B"] + 2 * t["2B"] + 3 * t["3B"] + 4 * t.HR;
  return {
    R: per(t.R), H: per(t.H), HR: per(t.HR), K: per(t.K), BB: per(t.BB),
    AVG: t.H / t.AB, OBP: (t.H + t.BB + t.HBP) / obpDen, SLG: tb / t.AB,
    wOBA: (w.wBB * t.BB + w.wHBP * t.HBP + w.w1B * t["1B"] + w.w2B * t["2B"] + w.w3B * t["3B"] + w.wHR * t.HR) / obpDen,
    PA27: per(t.PA),
  };
}
