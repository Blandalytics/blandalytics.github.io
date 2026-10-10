/**
 * LightGBM and XGBoost tree ensembles evaluated in plain JS, from the flat arrays that
 * tools/pitcher_card/model_pack.py writes into a pack (pack.js reads it; the layout is in
 * model_pack.py). check_trees.py holds these to the Python libraries on the real models;
 * test/trees.mjs does the same on small committed ones.
 *
 *   const pack = readPack(await (await env.BUCKET.get(key)).arrayBuffer());
 *   const m = loadModel(pack, "swing_take/Fastball vs Same Hand/boosters/0");
 *   m.raw(row);                     // one row -> number (or array, one per output)
 *   m.rawBatch(X, out);             // row-major matrix -> out, no allocation per row
 *
 * A row is anything indexable (Array, Float64Array, Float32Array); NaN, null and undefined
 * are missing. Batch methods read `ncol` values per row (default numFeatures; extra
 * trailing columns are ignored) and write row i's outputs at out[i * width ...].
 *
 * LightGBM works in double. It widens float32 input to double, so to match Python fed
 * float32 arrays (score_pitches.py is) pass float32 values: a Float32Array matrix, or each
 * value Math.fround-ed. Raw scores are bit-exact -- the same comparisons on the same
 * thresholds, the same leaf values summed in the same order; predict() adds the objective's
 * transform via Math.exp, within an ulp or so of LightGBM's.
 *
 * XGBoost works in float32: input is rounded to float32, and the margin starts at the base
 * margin and adds each tree's float32 leaf in float32, tree by tree, as its CPU predictor
 * does -- so margins are bit-exact, probabilities within a float32 ulp or two.
 */

// LightGBM's kZeroThreshold, declared `const double kZeroThreshold = 1e-35f`
const KZERO = Math.fround(1e-35);
const MAX_EXP_ARG = Math.fround(88.7);   // XGBoost's Sigmoid clamps -x here

/** The model stored under `prefix`, as a LightGBM or XGBoost instance by its meta.kind. */
export function loadModel(pack, prefix) {
  const kind = pack.meta.models?.[prefix]?.kind;
  if (kind === "lightgbm") return new LightGBM(pack, prefix);
  if (kind === "xgboost") return new XGBoost(pack, prefix);
  throw new Error(`no model "${prefix}" in the pack`);
}

function parts(pack, prefix, kind) {
  const meta = pack.meta.models?.[prefix];
  if (meta?.kind !== kind) throw new Error(`no ${kind} model "${prefix}" in the pack`);
  const get = (name) => {
    const a = pack.arrays[`${prefix}/${name}`];
    if (!a) throw new Error(`model "${prefix}" has no ${name}`);
    return a;
  };
  return [meta, get];
}

function rows(model, X, ncol, out, width) {
  if (!(ncol >= model.numFeatures)) throw new RangeError(`ncol ${ncol} < the model's ${model.numFeatures} features`);
  const n = Math.floor(X.length / ncol);
  if (out.length < n * width) throw new RangeError(`out holds ${out.length} values, needs ${n * width}`);
  return n;
}

// ---- LightGBM -------------------------------------------------------------------------

/**
 * LightGBM's Tree::GetLeaf, over the joined arrays: (node, x) -> leaf index. decision_type
 * bits: 1 categorical, 2 default left, (d >> 2) & 3 the missing type (0 none, 1 zero, 2 NaN).
 *
 * Numerical split (NumericalDecision): NaN becomes 0 unless the missing type is NaN; then a
 * missing value -- NaN under type NaN, |x| <= kZeroThreshold under type zero -- takes the
 * default side; anything else goes left iff x <= threshold.
 *
 * Categorical split (CategoricalDecision): NaN goes right; otherwise c = (int)x, truncated
 * toward zero (so -0.5 is category 0) and right if negative -- as is anything past 2^31,
 * which x86's cast turns into INT_MIN; left iff bit c of the split's bitset is set (a
 * category past the bitset's end is unset).
 */
function lightgbmWalk(feat, thr, dt, left, right, catB, catT) {
  return (node, x) => {
    while (node >= 0) {
      const d = dt[node];
      let v = x[feat[node]];
      if ((d & 1) === 0) {
        const missing = (d >> 2) & 3;
        if (v !== v) {
          if (missing === 2) { node = d & 2 ? left[node] : right[node]; continue; }
          v = 0;
        }
        if (missing === 1 && v >= -KZERO && v <= KZERO) { node = d & 2 ? left[node] : right[node]; continue; }
        node = v <= thr[node] ? left[node] : right[node];
      } else if (v > -1 && v < 2147483648) {
        const c = v | 0, i = thr[node], lo = catB[i], w = c >>> 5;
        node = w < catB[i + 1] - lo && (catT[lo + w] >>> (c & 31)) & 1 ? left[node] : right[node];
      } else {
        node = right[node];
      }
    }
    return ~node;
  };
}

export class LightGBM {
  constructor(pack, prefix) {
    const [meta, a] = parts(pack, prefix, "lightgbm");
    this.meta = meta;
    this.numFeatures = meta.num_features;
    this.numOutputs = meta.num_outputs;
    this.root = a("tree_root");
    this.cls = a("tree_class");
    this.leafValue = a("leaf_value");
    this.walk = lightgbmWalk(a("split_feature"), a("threshold"), a("decision_type"),
      a("left_child"), a("right_child"), a("cat_boundaries"), a("cat_threshold"));
    this._x = new Float64Array(this.numFeatures);
    this._acc = new Float64Array(this.numOutputs);
  }

  /** Raw score(s) of one row: a number, or with several outputs a Float64Array (`out`). */
  raw(row, out) { return this._one(row, out, false); }

  /** raw() through the objective's transform: a probability for binary / cross_entropy. */
  predict(row, out) { return this._one(row, out, true); }

  /** Raw scores of every row of a row-major matrix into `out` (numOutputs per row). */
  rawBatch(X, out, ncol = this.numFeatures) { return this._batch(X, out, ncol, false); }

  /** predict() of every row into `out`. */
  predictBatch(X, out, ncol = this.numFeatures) { return this._batch(X, out, ncol, true); }

  /** One row into the scratch row as LightGBM's predictor has it: double, and a value with
   *  |x| <= kZeroThreshold as 0 (it drops those, and a dropped feature reads as zero). */
  _load(X, off) {
    const x = this._x;
    for (let j = 0; j < x.length; j++) {
      const r = X[off + j];
      const v = r == null ? NaN : +r;
      x[j] = v >= -KZERO && v <= KZERO ? 0 : v;
    }
    return x;
  }

  /** GBDT::PredictRaw for one output: every tree's leaf, summed in tree order from 0. */
  _sum1(x) {
    const { root, leafValue, walk } = this;
    let s = 0;
    for (let t = 0; t < root.length; t++) s += leafValue[walk(root[t], x)];
    return s;
  }

  _sumN(x) {
    const { root, cls, leafValue, walk, _acc: acc } = this;
    acc.fill(0);
    for (let t = 0; t < root.length; t++) acc[cls[t]] += leafValue[walk(root[t], x)];
    return acc;
  }

  _one(row, out, transform) {
    const x = this._load(row, 0);
    if (this.numOutputs === 1) return transform ? this._convert1(this._sum1(x)) : this._sum1(x);
    const acc = this._sumN(x);
    if (transform) this._convertN(acc);
    out ??= new Float64Array(this.numOutputs);
    out.set(acc);
    return out;
  }

  _batch(X, out, ncol, transform) {
    const k = this.numOutputs, n = rows(this, X, ncol, out, k);
    for (let i = 0; i < n; i++) {
      const x = this._load(X, i * ncol);
      if (k === 1) {
        out[i] = transform ? this._convert1(this._sum1(x)) : this._sum1(x);
      } else {
        const acc = this._sumN(x);
        if (transform) this._convertN(acc);
        for (let j = 0; j < k; j++) out[i * k + j] = acc[j];
      }
    }
    return out;
  }

  /** GBDT::Predict after the raw sum: a random forest's average, then ConvertOutput. */
  _convert1(s) {
    if (this.meta.average_output) s /= this.meta.num_iterations;
    return this._link(s);
  }

  _convertN(acc) {
    const m = this.meta, k = acc.length;
    if (m.average_output) for (let j = 0; j < k; j++) acc[j] /= m.num_iterations;
    if (m.transform !== "softmax") {
      for (let j = 0; j < k; j++) acc[j] = this._link(acc[j]);
      return;
    }
    let wmax = acc[0], wsum = 0;                  // Common::Softmax
    for (let j = 1; j < k; j++) wmax = Math.max(acc[j], wmax);
    for (let j = 0; j < k; j++) {
      acc[j] = Math.exp(acc[j] - wmax);
      wsum += acc[j];
    }
    for (let j = 0; j < k; j++) acc[j] /= wsum;
  }

  /** The objective's ConvertOutput, for one value (softmax is _convertN's). */
  _link(s) {
    switch (this.meta.transform) {
      case "sigmoid": return 1 / (1 + Math.exp(-this.meta.sigmoid * s));
      case "exp": return Math.exp(s);
      case "square": return ((s > 0) - (s < 0)) * s * s;   // Common::Sign(x) * x * x
      default: return s;
    }
  }
}

// ---- XGBoost --------------------------------------------------------------------------

/** XGBoost's RegTree::GetNext: missing (NaN) takes the default side, otherwise left iff
 *  x < split, both float32. (node, x) -> leaf index. */
function xgboostWalk(feat, thr, defaultLeft, left, right) {
  return (node, x) => {
    while (node >= 0) {
      const v = x[feat[node]];
      node = v !== v
        ? (defaultLeft[node] ? left[node] : right[node])
        : (v < thr[node] ? left[node] : right[node]);
    }
    return ~node;
  };
}

export class XGBoost {
  constructor(pack, prefix) {
    const [meta, a] = parts(pack, prefix, "xgboost");
    this.meta = meta;
    this.numFeatures = meta.num_features;
    this.numOutputs = meta.num_outputs;
    this.base = Float32Array.from(meta.base_margin);
    this.root = a("tree_root");
    this.cls = a("tree_class");
    this.leafValue = a("leaf_value");
    this.walk = xgboostWalk(a("split_feature"), a("threshold"), a("default_left"),
      a("left_child"), a("right_child"));
    this._x = new Float32Array(this.numFeatures);
    this._m = new Float32Array(this.numOutputs);
    this._e = new Float32Array(this.numOutputs);
    this._r = new Float32Array(1);
  }

  /** Values per row from predict() / predictProba(). */
  width(fn) {
    if (fn === "predictProba" && this.meta.transform === "sigmoid") return 2;
    if (fn === "predict" && this.meta.transform === "sigmoid") return 1;
    return this.numOutputs;
  }

  /** The margin (output_margin=True): a number, or per class a Float32Array (`out`). */
  margin(row, out) { return this._one(row, out, "margin"); }

  /** Booster.predict: softmax probabilities (softprob), P(1) (logistic), or the margin. */
  predict(row, out) { return this._one(row, out, "predict"); }

  /** XGBClassifier.predict_proba: per class; a binary model gives [1 - p, p]. */
  predictProba(row, out) { return this._one(row, out, "predictProba"); }

  marginBatch(X, out, ncol = this.numFeatures) { return this._batch(X, out, ncol, "margin"); }
  predictBatch(X, out, ncol = this.numFeatures) { return this._batch(X, out, ncol, "predict"); }
  predictProbaBatch(X, out, ncol = this.numFeatures) { return this._batch(X, out, ncol, "predictProba"); }

  _load(X, off) {
    const x = this._x;
    for (let j = 0; j < x.length; j++) {
      const r = X[off + j];
      x[j] = r == null ? NaN : r;   // the Float32Array rounds it
    }
    return x;
  }

  /** The margin of the loaded row in this._m, accumulated in float32 in tree order. */
  _sum(x) {
    const { root, cls, leafValue, walk, _m: m } = this;
    m.set(this.base);
    if (m.length === 1) {
      let s = m[0];
      for (let t = 0; t < root.length; t++) s = Math.fround(s + leafValue[walk(root[t], x)]);
      m[0] = s;
    } else {
      for (let t = 0; t < root.length; t++) m[cls[t]] += leafValue[walk(root[t], x)];
    }
    return m;
  }

  /** The row's values for `fn` written at out[o...]. */
  _write(m, fn, out, o) {
    const tf = this.meta.transform;
    if (fn === "margin" || tf === "identity") { for (let j = 0; j < m.length; j++) out[o + j] = m[j]; return; }
    if (tf === "softmax") { this._softmax(m, out, o); return; }
    const p = sigmoid32(m[0]);
    if (fn === "predictProba") { out[o] = Math.fround(1 - p); out[o + 1] = p; } else out[o] = p;
  }

  /** common::Softmax: max and exp in float32, the sum in double, divided as float32. */
  _softmax(m, out, o) {
    const e = this._e;
    let wmax = m[0], wsum = 0;
    for (let j = 1; j < m.length; j++) wmax = Math.max(m[j], wmax);
    for (let j = 0; j < m.length; j++) {
      e[j] = Math.exp(Math.fround(m[j] - wmax));   // stored as float32
      wsum += e[j];
    }
    const s = Math.fround(wsum);
    for (let j = 0; j < m.length; j++) out[o + j] = Math.fround(e[j] / s);
  }

  _one(row, out, fn) {
    const m = this._sum(this._load(row, 0)), w = this.width(fn);
    const buf = w === 1 ? this._r : (out ?? new Float32Array(w));
    this._write(m, fn, buf, 0);
    return w === 1 ? buf[0] : buf;
  }

  _batch(X, out, ncol, fn) {
    const w = this.width(fn), n = rows(this, X, ncol, out, w);
    for (let i = 0; i < n; i++) this._write(this._sum(this._load(X, i * ncol)), fn, out, i * w);
    return out;
  }
}

/** common::Sigmoid in float32: 1 / (1 + expf(min(-x, 88.7))). */
function sigmoid32(x) {
  const e = Math.fround(Math.exp(Math.min(-x, MAX_EXP_ARG)));
  return Math.fround(1 / Math.fround(e + 1));
}
