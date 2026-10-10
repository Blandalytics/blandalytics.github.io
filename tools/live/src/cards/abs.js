/**
 * pitch-modeling's 2026 adjustment (abs_2026.py) for the location-aware values.
 *
 * statfast's 2026 sz_top / sz_bot are the fixed ABS zone, shorter than the pose-tracked
 * zones the 2023-25 models learned, so each 2026 pitch is scored against its batter's
 * reference zone (the ABS zone is kept as sz_top_abs / sz_bot_abs). The swing,
 * called-strike and whiff stages are recalibrated on 2026's calls with restricted cubic
 * splines in the zone heights and the distance off the plate, and their as-used
 * probabilities get the matching per-count shift. Rows outside the env's season pass
 * through unchanged; count-neutral Stuff never changes.
 *
 * `env` is abs_2026.json as published: {season, zone: {top_a, top_b, bot_a, bot_b,
 * ref: [[batter, top, bot], ...]}, stages: {name: {knots, L_knots?, coef, asused_delta}}},
 * with `zone.byBatter` (a Map) added when the bundle is loaded.
 */

const ABS_BOT = 0.27; // the ABS zone's bottom as a share of height
const EDGE_X = 17 / 24 + 0.1208; // ft: plate half-width plus ball radius
const CLIP = { L: [-12, 12], z_n: [-1.5, 2.5], z_abs: [-1.5, 2.5], xe: [-1, 1.5] };
const N_COUNT = 12;

const clip = (v, [lo, hi]) => Math.min(Math.max(v, lo), hi);

/** apply_zone: the env season's rows with the batter's reference zone in sz_top / sz_bot
 * and the ABS zone kept beside it; returns new rows, the input is left alone. */
export function applyZone(rows, env) {
  if (!env) return rows;
  const z = env.zone;
  return rows.map((r) => {
    if (r.season !== env.season) return { ...r, sz_top_abs: NaN, sz_bot_abs: NaN };
    const height = r.sz_bot / ABS_BOT;
    const ref = z.byBatter.get(r.batter);
    const top = ref ? ref[0] : z.top_a + z.top_b * height;
    const bot = ref ? ref[1] : z.bot_a + z.bot_b * height;
    return { ...r, sz_top_abs: r.sz_top, sz_bot_abs: r.sz_bot, sz_top: top, sz_bot: bot };
  });
}

/** rcs: Harrell's restricted cubic spline basis, x and len(knots) - 2 nonlinear terms. */
export function rcs(x, t) {
  const k = t.length;
  const p = (u) => Math.max(u, 0) ** 3;
  const out = [x];
  for (let j = 0; j < k - 2; j++) {
    const b = p(x - t[j]) - p(x - t[k - 2]) * (t[k - 1] - t[j]) / (t[k - 1] - t[k - 2])
      + p(x - t[k - 1]) * (t[k - 2] - t[j]) / (t[k - 1] - t[k - 2]);
    out.push(b / (t[k - 1] - t[0]) ** 2);
  }
  return out;
}

function logit(p) {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return clip(Math.log(q / (1 - q)), CLIP.L);
}

/** One row's design vector and offset for a stage (abs_2026.design / inputs). */
function design(spec, L, r) {
  const zN = clip((r.plate_z - r.sz_bot) / (r.sz_top - r.sz_bot), CLIP.z_n);
  const zAbs = clip((r.plate_z - r.sz_bot_abs) / (r.sz_top_abs - r.sz_bot_abs), CLIP.z_abs);
  const xe = clip(Math.abs(r.plate_x) - EDGE_X, CLIP.xe);
  const count = r.balls * 3 + r.strikes;
  const x = [1];
  for (let c = 1; c < N_COUNT; c++) x.push(c === count ? 1 : 0);
  if (spec.L_knots) x.push(...rcs(L, spec.L_knots));
  x.push(...rcs(zN, spec.knots.z_n), ...rcs(zAbs, spec.knots.z_abs), ...rcs(xe, spec.knots.xe));
  return [x, spec.L_knots ? 0 : L];
}

/**
 * adjust: a model's location-aware class probabilities for one row (its recalibrated
 * class first) with the env season's recalibration applied; the other classes keep their
 * shares of the rest. `probs` is modified in place and returned.
 */
export function adjust(stage, probs, r, env) {
  const spec = env?.stages?.[stage];
  if (!spec || r.season !== env.season) return probs;
  const [x, off] = design(spec, logit(probs[0]), r);
  let eta = 0;
  for (let i = 0; i < x.length; i++) eta += x[i] * spec.coef[i];
  const p = 1 / (1 + Math.exp(-(off + eta)));
  let rest = 0;
  for (let k = 1; k < probs.length; k++) rest += probs[k];
  for (let k = 1; k < probs.length; k++) probs[k] = (probs[k] / rest) * (1 - p);
  probs[0] = p;
  return probs;
}

/** asused_delta: the per-count shift on the stage's first league shift, or null. */
export function asusedDelta(stage, env) {
  return env?.stages?.[stage]?.asused_delta ?? null;
}
