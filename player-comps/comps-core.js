'use strict';
// One comps query (spec section 5): Gower-style hybrid distance, exact top-K scan, kernel-weighted delta
// aggregation shrunk toward an aging prior. Pure functions over typed arrays; runs in the Web Worker and in Node
// (tests, backtest). Based on the spec's reference implementation (section 16), with these additions:
//   * filters are data, not functions ({ cat, same: true } or { cat, value }), so a query can be posted to a worker;
//   * options.minSample drops small-sample comps;
//   * each comp carries its per-group share of D_G (contribution bars by group);
//   * the forecast is converted back to stat units (section 5.10) through data.convert.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULTS = {
    K: 100,            // comps kept (top-K cap)
    kh: 50,            // bandwidth anchor: distance of the kh-th comp
    beta: 0.5,         // bandwidth multiplier; h = beta * D(kh)
    m: 15,             // shrinkage strength toward the aging prior
    minCoverage: 0.7,  // share of selected rate weight both rows must have
    lambda: 0.3,       // correlation shrinkage toward identity (1 = diagonal)
    h0: 0.3,           // fixed bandwidth for the displayed 0-100 score
    calibrationPairs: 512,
    ageWindow: 1.0,    // years, forecast mode only
    minSample: 0,      // comps need at least this sample (BF or pitches)
    quantiles: [0.1, 0.5, 0.9],
    seed: 12345,
  };

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Bounded max-heap that keeps the K smallest distances.
  class TopK {
    constructor(k) { this.k = k; this.key = new Float64Array(k); this.id = new Int32Array(k); this.size = 0; }
    push(key, id) {
      if (this.size < this.k) {
        let i = this.size++; this.key[i] = key; this.id[i] = id;
        while (i > 0) { const p = (i - 1) >> 1; if (this.key[p] >= this.key[i]) break; this._swap(i, p); i = p; }
      } else if (key < this.key[0]) {
        this.key[0] = key; this.id[0] = id;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < this.size && this.key[l] > this.key[m]) m = l;
          if (r < this.size && this.key[r] > this.key[m]) m = r;
          if (m === i) break; this._swap(i, m); i = m;
        }
      }
    }
    _swap(a, b) {
      const k = this.key[a]; this.key[a] = this.key[b]; this.key[b] = k;
      const d = this.id[a]; this.id[a] = this.id[b]; this.id[b] = d;
    }
    sorted() {
      const out = [];
      for (let i = 0; i < this.size; i++) out.push({ row: this.id[i], D: this.key[i] });
      return out.sort((a, b) => a.D - b.D || a.row - b.row);
    }
  }

  function cholesky(A, d) {
    const L = new Float64Array(d * d);
    for (let i = 0; i < d; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i * d + j];
        for (let k = 0; k < j; k++) s -= L[i * d + k] * L[j * d + k];
        if (i === j) { if (!(s > 1e-10)) return null; L[i * d + i] = Math.sqrt(s); }
        else L[i * d + j] = s / L[j * d + j];
      }
    }
    return L;
  }

  function median(values) {
    const a = Float64Array.from(values.filter((v) => !Number.isNaN(v))).sort();
    if (!a.length) return NaN;
    const h = a.length >> 1;
    return a.length % 2 ? a[h] : 0.5 * (a[h - 1] + a[h]);
  }

  function buildContext(data, q, opts) {
    const { n, p } = data, t = q.targetRow;
    const forecast = q.mode !== 'style';
    const W = Object.assign({ rate: 1, mix: 0, cat: 0 }, q.groupWeights);

    // Rate group: drop selected features the target lacks.
    const selRate = (q.features.rate || []).filter((f) => !Number.isNaN(data.rate[f * n + t]));
    const wAll = q.weights || (data.learnedWeights && data.learnedWeights[q.stat]) || data.defaultWeights;
    const d = selRate.length;
    const w = new Float64Array(d), sqrtW = new Float64Array(d);
    let wSum = 0;
    for (let a = 0; a < d; a++) { w[a] = wAll[selRate[a]]; sqrtW[a] = Math.sqrt(w[a]); wSum += w[a]; }

    // Effective dimension of the selection: d^2 / ||R_S||_F^2 (participation ratio).
    let dEff = d;
    if (d > 0) {
      let fro = 0;
      for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) { const r = data.corr[selRate[a] * p + selRate[b]]; fro += r * r; }
      dEff = (d * d) / fro;
    }

    // Correlation toggle: Cholesky of the shrunk correlation sub-block (never a slice of the precision matrix).
    let L = null, lambdaUsed = 1;
    if (q.correlation && d > 1) {
      let lam = opts.lambda;
      while (!L) {
        const A = new Float64Array(d * d);
        for (let a = 0; a < d; a++) for (let b = 0; b < d; b++)
          A[a * d + b] = a === b ? 1 : (1 - lam) * data.corr[selRate[a] * p + selRate[b]];
        L = cholesky(A, d);
        if (!L) lam = Math.min(1, lam + 0.1); // identity always factors
        else lambdaUsed = lam;
      }
    }

    const selCat = (q.features.cat || []).filter((c) => data.cat[c * n + t] !== 255);
    // Mix blocks (spec 4.6): several share-vectors per row (e.g. batted-ball type and spray), norms stored n x B.
    const blocks = data.mixBlocks || (data.M ? [{ start: 0, width: data.M }] : []);
    let targetHasMix = false;
    for (let k = 0; k < blocks.length; k++) if (data.mixNorm[t * blocks.length + k] > 0) targetHasMix = true;
    const useMix = !!q.features.mix && W.mix > 0 && !!data.mixNorm && targetHasMix;
    const filters = (q.filters || []).map((f) => ({
      cat: f.cat, value: f.value !== undefined ? f.value : data.cat[f.cat * n + t],
    }));

    return {
      t, forecast, W, selRate, w, sqrtW, wSum, d, dEff, L, lambdaUsed, selCat, useMix, filters, blocks,
      useRate: d > 0 && W.rate > 0,
      useCat: selCat.length > 0 && W.cat > 0,
      minCoverage: opts.minCoverage, minSample: opts.minSample,
      delta: forecast ? data.outcomes[q.stat].delta : null,
      targetPlayer: data.playerId[t], targetSeason: data.season[t], targetAge: data.age[t],
      ageWindow: opts.ageWindow,
      scratch: { v: new Float64Array(d), y: new Float64Array(d) },
      scale: { rate: 1, mix: 1 }, pairD: null,
    };
  }

  function makeProbe(data, ctx, row) {
    const z = new Float64Array(ctx.d);
    for (let a = 0; a < ctx.d; a++) z[a] = data.rate[ctx.selRate[a] * data.n + row];
    const B = ctx.blocks.length, mixNorm = new Float64Array(B);
    for (let k = 0; k < B; k++) mixNorm[k] = data.mixNorm ? data.mixNorm[row * B + k] : 0;
    return { row, z, mixOff: row * data.M, mixNorm, cats: ctx.selCat.map((c) => data.cat[c * data.n + row]) };
  }

  // Squared RMS distance over the rate group. Weights sit outside the inverse:
  // D^2 = (sqrt(w) o delta)^T R^-1 (sqrt(w) o delta) / sum(w).
  function rawRate(data, ctx, probe, b) {
    const n = data.n, d = ctx.d, z = probe.z;
    if (ctx.L) {
      const { v, y } = ctx.scratch;
      let full = true;
      for (let a = 0; a < d; a++) {
        const diff = z[a] - data.rate[ctx.selRate[a] * n + b];
        if (Number.isNaN(diff)) { full = false; break; }
        v[a] = ctx.sqrtW[a] * diff;
      }
      if (full) {
        const L = ctx.L; let s = 0;
        for (let i = 0; i < d; i++) {
          let acc = v[i];
          for (let k = 0; k < i; k++) acc -= L[i * d + k] * y[k];
          y[i] = acc / L[i * d + i];
          s += y[i] * y[i];
        }
        return s / ctx.wSum;
      }
      // A row missing a selected feature falls back to the diagonal metric.
    }
    let s = 0, wu = 0;
    for (let a = 0; a < d; a++) {
      const diff = z[a] - data.rate[ctx.selRate[a] * n + b];
      if (Number.isNaN(diff)) continue;
      s += ctx.w[a] * diff * diff; wu += ctx.w[a];
    }
    return wu >= ctx.minCoverage * ctx.wSum ? s / wu : NaN;
  }

  // Mean over the blocks both rows have of 1 - cosine(shares); NaN when they share none.
  function rawMix(data, ctx, probe, b) {
    const B = ctx.blocks.length, M = data.M, ob = b * M;
    let sum = 0, cnt = 0;
    for (let k = 0; k < B; k++) {
      const na = probe.mixNorm[k], nb = data.mixNorm[b * B + k];
      if (!(na > 0) || !(nb > 0)) continue;
      const { start, width } = ctx.blocks[k];
      let dot = 0;
      for (let j = start; j < start + width; j++) dot += data.mix[probe.mixOff + j] * data.mix[ob + j];
      sum += Math.max(0, 1 - dot / (na * nb)); cnt++;
    }
    return cnt ? sum / cnt : NaN;
  }

  function rawCat(data, ctx, probe, b) {
    let mis = 0, cnt = 0;
    for (let a = 0; a < ctx.selCat.length; a++) {
      const va = probe.cats[a], vb = data.cat[ctx.selCat[a] * data.n + b];
      if (va === 255 || vb === 255) continue;
      cnt++; if (va !== vb) mis++;
    }
    return cnt ? mis / cnt : NaN;
  }

  // Per-group transformed distances d_g (rate, mix: 1 - exp(-r / scale); cat: mismatch share), or null when a
  // selected group is missing for this pair.
  function groupD(ctx, r, mi, c) {
    const out = [0, 0, 0];
    if (ctx.useRate) { if (Number.isNaN(r)) return null; out[0] = 1 - Math.exp(-r / ctx.scale.rate); }
    if (ctx.useMix) { if (Number.isNaN(mi)) return null; out[1] = 1 - Math.exp(-mi / ctx.scale.mix); }
    if (ctx.useCat) { if (Number.isNaN(c)) return null; out[2] = c; }
    return out;
  }

  function combine(ctx, r, mi, c) {
    const g = groupD(ctx, r, mi, c);
    if (!g) return NaN;
    let num = 0, den = 0;
    if (ctx.useRate) { num += ctx.W.rate * g[0]; den += ctx.W.rate; }
    if (ctx.useMix) { num += ctx.W.mix * g[1]; den += ctx.W.mix; }
    if (ctx.useCat) { num += ctx.W.cat * g[2]; den += ctx.W.cat; }
    return den > 0 ? num / den : NaN;
  }

  function raws(data, ctx, probe, b) {
    return [
      ctx.useRate ? rawRate(data, ctx, probe, b) : 0,
      ctx.useMix ? rawMix(data, ctx, probe, b) : 0,
      ctx.useCat ? rawCat(data, ctx, probe, b) : 0,
    ];
  }

  function isEligible(data, ctx, i) {
    if (data.playerId[i] === ctx.targetPlayer) return false; // the target's whole career is excluded
    if (ctx.forecast) {
      if (data.season[i] + 1 > ctx.targetSeason) return false; // comp outcome must predate the forecast
      if (Number.isNaN(ctx.delta[i])) return false;
      if (Math.abs(data.age[i] - ctx.targetAge) > ctx.ageWindow) return false;
    }
    if (ctx.minSample > 0 && data.sample[i] < ctx.minSample) return false;
    for (const f of ctx.filters) if (data.cat[f.cat * data.n + i] !== f.value) return false;
    return true;
  }

  // Per-group scales = median raw distance over random eligible pairs, so a random pair maps to about 0.63 in
  // every group whatever features are selected.
  function calibrate(data, ctx, rows, opts) {
    const rng = mulberry32(opts.seed), m = rows.length, pairs = [];
    for (let k = 0; k < opts.calibrationPairs * 4 && pairs.length < opts.calibrationPairs; k++) {
      const a = rows[(rng() * m) | 0], b = rows[(rng() * m) | 0];
      if (a === b || data.playerId[a] === data.playerId[b]) continue;
      const r = raws(data, ctx, makeProbe(data, ctx, a), b);
      if (r.some(Number.isNaN)) continue;
      pairs.push(r);
    }
    ctx.scale = { rate: median(pairs.map((x) => x[0])) || 1, mix: median(pairs.map((x) => x[1])) || 1 };
    ctx.pairD = Float64Array.from(pairs.map((x) => combine(ctx, x[0], x[1], x[2]))).sort();
  }

  function shareCloser(sorted, D) { // share of random pairs farther apart than D
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= D) lo = mid + 1; else hi = mid; }
    return sorted.length ? (sorted.length - lo) / sorted.length : NaN;
  }

  function weightedQuantile(sortedPts, p) {
    let cum = 0;
    for (const [v, w] of sortedPts) { cum += w; if (cum >= p - 1e-12) return v; }
    return sortedPts[sortedPts.length - 1][0];
  }

  function featureShares(data, ctx, probe, b) { // diagonal contributions, labeled approximate when the toggle is on
    const out = []; let tot = 0;
    for (let a = 0; a < ctx.d; a++) {
      const diff = probe.z[a] - data.rate[ctx.selRate[a] * data.n + b];
      const c = Number.isNaN(diff) ? 0 : ctx.w[a] * diff * diff;
      out.push(c); tot += c;
    }
    return out.map((c, a) => ({ feature: ctx.selRate[a], share: tot > 0 ? c / tot : 0 }));
  }

  function runQuery(data, q) {
    const opts = Object.assign({}, DEFAULTS, q.options);
    const ctx = buildContext(data, q, opts);
    const dropped = (q.features.rate || []).filter((f) => !ctx.selRate.includes(f));
    const base = { eligible: 0, d: ctx.d, dEff: ctx.dEff, lambdaUsed: ctx.lambdaUsed, droppedFeatures: dropped };

    const rows = [];
    for (let i = 0; i < data.n; i++) if (isEligible(data, ctx, i)) rows.push(i);
    base.eligible = rows.length;
    const warnings = [];
    if (!ctx.useRate && !ctx.useMix && !ctx.useCat) return { comps: [], forecast: null, diagnostics: { ...base, warnings: ['no-features'] } };
    if (rows.length < 2) return { comps: [], forecast: null, diagnostics: { ...base, warnings: ['no-eligible-comps'] } };
    calibrate(data, ctx, rows, opts);

    const probeT = makeProbe(data, ctx, ctx.t);
    const top = new TopK(opts.K);
    for (const i of rows) {
      const r = raws(data, ctx, probeT, i);
      const D = combine(ctx, r[0], r[1], r[2]);
      if (!Number.isNaN(D)) top.push(D, i);
    }
    const comps = top.sorted();
    if (!comps.length) return { comps: [], forecast: null, diagnostics: { ...base, scale: ctx.scale, warnings: ['no-comps'] } };

    const Wsum = (ctx.useRate ? ctx.W.rate : 0) + (ctx.useMix ? ctx.W.mix : 0) + (ctx.useCat ? ctx.W.cat : 0);
    for (const c of comps) {
      c.score = Math.round(100 * Math.exp(-0.5 * (c.D / opts.h0) ** 2));
      c.closerThan = shareCloser(ctx.pairD, c.D);
      c.contrib = featureShares(data, ctx, probeT, c.row);
      const r = raws(data, ctx, probeT, c.row), g = groupD(ctx, r[0], r[1], r[2]);
      c.groups = {
        rate: ctx.useRate ? (ctx.W.rate * g[0]) / Wsum : 0,
        mix: ctx.useMix ? (ctx.W.mix * g[1]) / Wsum : 0,
        cat: ctx.useCat ? (ctx.W.cat * g[2]) / Wsum : 0,
      };
    }

    let forecast = null;
    if (ctx.forecast) {
      const prior = data.prior(q.stat, ctx.targetAge, q.priorThrough); // { mean, q: 99-point grid of the aging delta }
      const h = Math.max(opts.beta * comps[Math.min(opts.kh, comps.length) - 1].D, 1e-9);
      let sw = 0, sw2 = 0, swy = 0;
      for (const c of comps) {
        c.weight = Math.exp(-0.5 * (c.D / h) ** 2);
        c.delta = ctx.delta[c.row];
        sw += c.weight; sw2 += c.weight * c.weight; swy += c.weight * c.delta;
      }
      const nEff = (sw * sw) / sw2, compMean = swy / sw;
      const alpha = nEff / (nEff + opts.m);
      const pts = comps.map((c) => [c.delta, (alpha * c.weight) / sw]);
      for (const v of prior.q) pts.push([v, (1 - alpha) / prior.q.length]);
      pts.sort((a, b) => a[0] - b[0]);
      const deltaHat = alpha * compMean + (1 - alpha) * prior.mean;
      const conv = data.convert ? (dl) => data.convert(q.stat, ctx.t, dl) : (dl) => dl;
      forecast = {
        stat: q.stat, bandwidth: h, nEff, compMean, alpha, priorMean: prior.mean,
        deltaHat, value: conv(deltaHat), baselineValue: conv(0), compValue: conv(compMean), priorValue: conv(prior.mean),
        quantiles: opts.quantiles.map((p) => { const dl = weightedQuantile(pts, p); return { p, delta: dl, value: conv(dl) }; }),
      };
      if (opts.returnPoints) forecast.points = pts; // sorted [delta, weight] mixture, for PIT in backtests
      if (nEff < 10) warnings.push('few-effective-comps');
    }
    if (ctx.d > 12) warnings.push('many-features');
    if (!q.correlation && ctx.d > 1 && ctx.dEff / ctx.d < 0.5) warnings.push('correlated-features');
    if (comps.length < opts.K) warnings.push('small-pool');

    return {
      comps, forecast,
      diagnostics: { ...base, scale: ctx.scale, selRate: ctx.selRate, warnings },
    };
  }

  // Aging prior lookup from prior.json ({ stat: { age: { mean, q } } }), clipped to the stored ages.
  function makePrior(priorJson) {
    return function (stat, age) {
      const t = priorJson[stat];
      const ages = Object.keys(t).map(Number);
      const lo = Math.min(...ages), hi = Math.max(...ages);
      const a = Math.min(hi, Math.max(lo, Math.floor(age)));
      return t[String(a)];
    };
  }

  // Aging prior refit from the data's own deltas, using only rows whose outcome season is at most `through`
  // (backtests: nothing fitted for season T may use T+1 outcomes).
  function fitPrior(data, stat, through, lo = 22, hi = 37) {
    const delta = data.outcomes[stat].delta, byAge = {};
    for (let a = lo; a <= hi; a++) byAge[a] = [];
    for (let i = 0; i < data.n; i++) {
      if (Number.isNaN(delta[i]) || data.season[i] + 1 > through) continue;
      const a = Math.min(hi, Math.max(lo, Math.floor(data.age[i])));
      byAge[a].push(delta[i]);
    }
    const out = {};
    for (let a = lo; a <= hi; a++) {
      let v = byAge[a];
      if (v.length < 20) { v = []; for (let b = a - 2; b <= a + 2; b++) if (byAge[b]) v.push(...byAge[b]); }
      v = Float64Array.from(v).sort();
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      const q = [];
      for (let j = 1; j < 100; j++) {
        const pos = (j / 100) * (v.length - 1), f = Math.floor(pos);
        q.push(v[f] + (v[Math.min(f + 1, v.length - 1)] - v[f]) * (pos - f));
      }
      const qm = q.reduce((s, x) => s + x, 0) / q.length;
      out[String(a)] = { n: v.length, mean, q: q.map((x) => x - qm + mean) };
    }
    return out;
  }

  const logit = (p) => Math.log(p / (1 - p));
  const invlogit = (x) => 1 / (1 + Math.exp(-x));

  return { runQuery, DEFAULTS, cholesky, TopK, makePrior, fitPrior, logit, invlogit, mulberry32 };
});
