/**
 * numpy / pandas numerics, as the card pipeline gets them, so the Worker's numbers match
 * the nightly Python ones to the last digit shown.
 *
 * statfast's measurements are float32, and under numpy 2's promotion rules arithmetic
 * on a float32 column stays float32 (a Python scalar is cast down to it), as do pandas'
 * group means and numpy's rounding of such a column. `f32` below does one such step:
 * float32 operands, the exact float64 result rounded once to float32, which equals the
 * IEEE single-precision result for + - * / and sqrt. numpy's float32 arctan is not
 * correctly rounded, so HAVAA can differ in its seventh digit; nothing else does.
 */

export const f32 = Math.fround;

/** np.rint: round half to even. */
export function rint(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/** DataFrame.round on a float64 column: rint(x * 10^d) / 10^d. */
export function round64(x, d) {
  const f = 10 ** d;
  return rint(x * f) / f;
}

/** DataFrame.round on a float32 column, every step in float32. */
export function round32(x, d) {
  const f = 10 ** d;
  return f32(rint(f32(x * f)) / f);
}

/** pandas' groupby mean (Kahan-summed, NaN skipped), in float64. */
export function groupMean64(values) {
  let sum = 0;
  let comp = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    n += 1;
    const y = v - comp;
    const t = sum + y;
    comp = t - sum - y;
    if (Number.isNaN(comp)) comp = 0;
    sum = t;
  }
  return n ? sum / n : NaN;
}

/** The same on a float32 column: pandas keeps the sums and the result float32. */
export function groupMean32(values) {
  let sum = 0;
  let comp = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    n += 1;
    const y = f32(v - comp);
    const t = f32(sum + y);
    comp = f32(f32(t - sum) - y);
    if (Number.isNaN(comp)) comp = 0;
    sum = t;
  }
  return n ? f32(sum / f32(n)) : NaN;
}

/** numpy's pairwise summation (what np.sum does along a contiguous float64 axis). */
export function pairwiseSum(a, lo = 0, n = a.length) {
  if (n < 8) {
    let s = 0;
    for (let i = lo; i < lo + n; i++) s += a[i];
    return s;
  }
  if (n <= 128) {
    const r = [];
    for (let j = 0; j < 8; j++) r.push(a[lo + j]);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[lo + i + j];
    let s = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) s += a[lo + i];
    return s;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, lo, n2) + pairwiseSum(a, lo + n2, n - n2);
}

/** Series.mean / Series.sum on float64 (no bottleneck): NaN filled with 0 for a pairwise
 * sum over every element, divided by the count of real values. */
export function seriesMean(values) {
  const filled = values.map((v) => (Number.isNaN(v) ? 0 : v));
  const n = values.filter((v) => !Number.isNaN(v)).length;
  return n ? pairwiseSum(filled) / n : NaN;
}
export function seriesSum(values) {
  return pairwiseSum(values.map((v) => (Number.isNaN(v) ? 0 : v)));
}

/** Python's f"{x:.{d}f}": correctly rounded, ties (exact binary halves) to even, where
 * Number#toFixed rounds them away from zero. x is a tie at d places exactly when
 * x * 2^(d+1) is an odd integer. */
export function fixed(x, d) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const y = x * 2 ** (d + 1);
  if (!(Number.isInteger(y) && y % 2 !== 0)) return x.toFixed(d);
  const k0 = Math.floor(Math.abs(x) * 10 ** d);
  const k = k0 % 2 === 0 ? k0 : k0 + 1;
  const digits = String(k).padStart(d + 1, "0");
  const body = d ? `${digits.slice(0, -d)}.${digits.slice(-d)}` : digits;
  return (x < 0 ? "-" : "") + body;
}

/** Python's round(x) on a float (half to even), as an integer. */
export const pyRound = rint;

/** bisect.bisect_left on sorted cut points: the right-closed bin x falls in. */
export function binIndex(x, cuts) {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
