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

// The bullpen, as facing()'s pitching: every reliever pooled, right- and left-handers
// in the shares they pitched (cells keyed hand + side, as the league's).
export function bullpenOf(counts, cells, { mode = "off", league } = {}) {
  if (mode === "off" || !cells) return [{ w: 1, hand: "", p: { "": scaled(counts) }, l: { "": league.all } }];
  const n = sumOf(counts);
  return HANDS.map((h) => ({
    w: SIDES.reduce((t, s) => t + sumOf(cells[h + s]), 0) / n, hand: h,
    p: Object.fromEntries(SIDES.map((s) => [s, scaled(cells[h + s])])),
    l: Object.fromEntries(SIDES.map((s) => [s, league.cells[h + s]])),
  }));
}

// A hitter's outcome chances against one stretch of pitching (the starter, or the bullpen).
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
export function facing(hitter, pitching, theta = 0, perSd = null) {
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

// Simulate `games` 9-inning games for a lineup of 9 cumulative-rate arrays.
// Returns season-style totals plus the per-game run distribution and per-spot lines.
// `pen`, another 9 arrays, is the lineup against the bullpen, which takes over from the
// plate appearance that starts with `hook` outs made in the game (the starter's last out).
export function simulate(model, lineup, games, seed = 1, pen = null, hook = 27) {
  const rand = rng(seed);
  const { running, advance } = model;
  const t = { G: games, PA: 0, AB: 0, H: 0, "1B": 0, "2B": 0, "3B": 0, HR: 0, BB: 0, HBP: 0, K: 0, SF: 0, R: 0, outs: 0 };
  const runDist = new Float64Array(31);
  const spotPA = new Float64Array(9), spotR = new Float64Array(9);
  const lead = [0, 0, 0, 0];
  const bases = [-1, -1, -1, -1]; // bases[1..3]: lineup slot of the runner, -1 empty
  let capped = 0;

  for (let g = 0; g < games; g++) {
    let up = 0, gameRuns = 0;
    for (let inning = 0; inning < 9; inning++) {
      let outs = 0, pas = 0;
      bases[1] = bases[2] = bases[3] = -1;
      while (outs < 3) {
        if (++pas > MAX_INNING_PA) { capped++; break; }
        // who's pitching is settled as the plate appearance starts, before any running
        const bat = pen && inning * 3 + outs >= hook ? pen : lineup;
        let mask = maskOf(bases);
        if (mask) {
          const cr = running[mask * 3 + outs];
          const o = cr.codes[pick(cr.cum, rand())];
          gameRuns += move(bases, lead, o, -1, spotR);
          outs += o.outs;
          if (outs >= 3) break; // the inning ended on the bases; this hitter leads off the next
          mask = maskOf(bases);
        }
        const cat = pick(bat[up], rand());
        const ca = advance[(cat * 8 + mask) * 3 + outs];
        const o = ca.codes[pick(ca.cum, rand())];
        gameRuns += move(bases, lead, o, up, spotR);
        outs += o.outs;
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
  }
  return { totals: t, runDist: Array.from(runDist), spotPA: Array.from(spotPA), spotR: Array.from(spotR), capped };
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
