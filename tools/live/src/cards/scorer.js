/**
 * Per-pitch Stuff, Pitching and Location run values: pitch-modeling's score_pitches.py,
 * for one game's rows (see feed.js), in runs per pitch from the pitcher's side.
 *
 *   stuff_rv         count-neutral Stuff: the pitch over the league's location mix,
 *                    averaged over the league count mix, valued count-neutrally
 *   stuff_rv_asused  Stuff at the pitch's own count (league location mix)
 *   pitching_rv      the pitch at its actual location and count
 *   location_rv      pitching_rv - stuff_rv_asused
 *
 * Four chained models (swing/take, take outcome, swing outcome, ball in play), each a
 * "sequential logit" per pitch group and platoon: LightGBM boosters give the pitch's
 * stuff log-odds D per stage, scaled by a per-count theta; the location-aware
 * probability adds a LightGBM location model l(W) and residual r(W) at the pitch's
 * actual location; the location-free ones average over the league's location draws for
 * the cell (season, count, hands). The class probabilities chain into nine outcomes,
 * valued with the run-value tables.
 *
 * Like the scorer's compiled kernel this runs in float64 throughout; the card pipeline's
 * numpy fallback rounds the location-draw average through float32, so the two agree to
 * about 1e-7 rather than exactly. Pass whole outings: each pitch's differences from its
 * pitcher's primary fastball, and its pitch group, come from the rows given.
 */

import { adjust, applyZone, asusedDelta } from "./abs.js";
import { pitchGroups } from "./groups.js";
import { groupMean64 } from "./npf.js";

export const STAGES = ["swing_take", "take_outcome", "swing_outcome", "in_play"];
export const OUTCOMES = [
  "ball", "called_strike", "swinging_strike", "foul", "field_out", "single", "double", "triple", "home_run",
];
const STUFF_NUM = [
  "velo", "ax_m", "az", "rel_x_m", "rel_z", "extension", "spin_rate", "spin_eff", "axis_diff",
  "velo_diff", "ax_diff", "az_diff",
];
const REQUIRED = [
  "pitcher", "pitch_type", "p_throws", "release_speed", "release_extension", "release_pos_x",
  "release_pos_z", "vx0", "vy0", "vz0", "ax", "ay", "az", "release_spin_rate", "spin_axis",
  "stand", "plate_x", "plate_z", "sz_top", "sz_bot", "balls", "strikes",
];
const FB_CANDIDATES = new Set(["FF", "SI", "FC"]);
const DECISIONS = new Set(["S", "W", "F", "T", "X", "D", "E", "B", "*B", "C", "H"]);
const IN_PLAY_CODES = new Set(["X", "D", "E"]);
const G = 32.174; // ft/s^2
const Y_FIT = 50; // ft: the plane of statfast's 9-parameter fit
const Y_PLATE = 17 / 12;
const BALL_R = 0.1208;
const BALL_A = Math.PI * BALL_R ** 2;
const BALL_M = 0.3203;
const RHO_SEA = 0.0747; // lb/ft^3, ~70F
const SCALE_HEIGHT = 27_500; // ft
const PARK_ELEVATION = {
  AZ: 1082, ARI: 1082, ATL: 1050, BAL: 33, BOS: 20, CHC: 595, CWS: 595, CIN: 490, CLE: 653,
  COL: 5190, DET: 600, HOU: 43, KC: 750, LAA: 160, LAD: 515, MIA: 7, MIL: 635, MIN: 815,
  NYM: 20, NYY: 55, OAK: 25, ATH: 25, PHI: 20, PIT: 730, SD: 20, SF: 0, SEA: 10, STL: 465,
  TB: 45, TEX: 551, TOR: 270, WSH: 25,
};
const DEFAULT_ELEVATION = 517; // ft: the pitch-weighted mean park elevation, 2023-26

const missing = (v) => v === null || v === undefined || Number.isNaN(v);
/** numpy's float remainder: the sign of the divisor, as Python's % has it. */
const mod = (a, n) => {
  const r = a % n;
  return r !== 0 && r < 0 !== n < 0 ? r + n : r === 0 ? 0 : r;
};
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const DEGREES = 180 / Math.PI; // np.degrees multiplies by this factor; (x * 180) / pi rounds differently

/** _pre_pitch_count: the count each pitch was thrown in, from the previous pitch of its
 * plate appearance (statsapi reports the count after the pitch). Rows are in PA order. */
function prePitchCounts(rows) {
  let prev = null;
  return rows.map((r) => {
    const same = prev && prev.game_pk === r.game_pk && prev.at_bat_index === r.at_bat_index;
    const out = {
      ...r,
      balls: same && !missing(prev.balls) ? prev.balls : 0,
      strikes: same && !missing(prev.strikes) ? prev.strikes : 0,
    };
    prev = r;
    return out;
  });
}

/** _flight_times: release and plate times relative to the y = 50 ft fit plane. */
function flightTimes(r) {
  const ay = Math.abs(r.ay) < 1e-6 ? 1e-6 : r.ay;
  const yRel = 60.5 - r.release_extension;
  const vyR = -Math.sqrt(r.vy0 ** 2 + 2 * ay * (yRel - Y_FIT));
  const vyF = -Math.sqrt(r.vy0 ** 2 + 2 * ay * (Y_PLATE - Y_FIT));
  return [(vyR - r.vy0) / ay, (vyF - r.vy0) / ay];
}

/** physics: release point, glove-side-negative mirrored x, gravity-free az, spin
 * efficiency (park air density by the home team's elevation) and axis difference. */
function physics(r) {
  const [tRel, tPlate] = flightTimes(r);
  const mirror = r.p_throws === "R" ? -1 : 1;
  const xRel = r.release_pos_x + r.vx0 * tRel + 0.5 * r.ax * tRel ** 2;
  const zRel = r.release_pos_z + r.vz0 * tRel + 0.5 * r.az * tRel ** 2;
  // _magnus: spin-induced acceleration (drag and gravity removed) at mid-flight
  const tMid = 0.5 * (tRel + tPlate);
  const a = [r.ax, r.ay, r.az + G];
  const v = [r.vx0 + a[0] * tMid, r.vy0 + a[1] * tMid, r.vz0 + a[2] * tMid];
  const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const vhat = v.map((x) => x / speed);
  const along = a[0] * vhat[0] + a[1] * vhat[1] + a[2] * vhat[2];
  const mag = a.map((x, i) => x - along * vhat[i]);
  const inferred = mod(180 + Math.atan2(-mag[0], mag[2]) * DEGREES, 360);
  const diff = mod(r.spin_axis - inferred + 180, 360) - 180;
  // _spin_efficiency: transverse spin implied by the Magnus acceleration / total spin
  const rho = RHO_SEA * Math.exp(-(PARK_ELEVATION[r.home_team] ?? DEFAULT_ELEVATION) / SCALE_HEIGHT);
  const magNorm = Math.sqrt(mag[0] * mag[0] + mag[1] * mag[1] + mag[2] * mag[2]);
  const cl = magNorm / (((0.5 * rho * BALL_A) / BALL_M) * speed ** 2);
  const spinParam = cl < 0.15 ? cl / 1.5 : (cl - 0.09) / 0.6;
  const transverse = (((spinParam * speed) / BALL_R) * 60) / (2 * Math.PI);
  const eff = Math.min(Math.max(transverse / Math.max(r.release_spin_rate, 1), 0), 1.25);
  return {
    velo: r.release_speed,
    ax_m: r.ax * mirror,
    az: r.az + G,
    rel_x_m: xRel * mirror,
    rel_z: zRel,
    extension: r.release_extension,
    spin_rate: r.release_spin_rate,
    spin_eff: eff,
    axis_diff: diff * (mirror < 0 ? 1 : -1),
  };
}

/** _primary_fastballs: the most-thrown FF/SI/FC per pitcher (ties to the harder one),
 * with its mean velocity and movement. The rows are one game, so the season fallback the
 * scorer keeps for multi-game input is this same set. */
function primaryFastballs(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!FB_CANDIDATES.has(r.pt)) continue;
    const k = `${r.pitcher}:${r.pt}`;
    if (!by.has(k)) by.set(k, { pitcher: r.pitcher, pt: r.pt, rows: [] });
    by.get(k).rows.push(r);
  }
  const best = new Map();
  for (const g of by.values()) {
    const cand = {
      fb_type: g.pt,
      n: g.rows.length,
      fb_velo: groupMean64(g.rows.map((r) => r.velo)),
      fb_ax: groupMean64(g.rows.map((r) => r.ax_m)),
      fb_az: groupMean64(g.rows.map((r) => r.az)),
    };
    const have = best.get(g.pitcher);
    if (!have || cand.n > have.n || (cand.n === have.n && cand.fb_velo > have.fb_velo)) best.set(g.pitcher, cand);
  }
  return best;
}

/** arsenal: the primary-fastball flag, the deltas from it, and the platoon flag. */
function arsenal(rows) {
  const fbs = primaryFastballs(rows);
  return rows.map((r) => {
    const fb = fbs.get(r.pitcher);
    const primary = fb !== undefined && r.pt === fb.fb_type;
    const ref = fb ?? { fb_velo: NaN, fb_ax: NaN, fb_az: NaN };
    return {
      ...r,
      is_primary: primary ? 1 : 0,
      velo_diff: primary ? 0 : r.velo - ref.fb_velo,
      ax_diff: primary ? 0 : r.ax_m - ref.fb_ax,
      az_diff: primary ? 0 : r.az - ref.fb_az,
      platoon: r.p_throws === r.stand ? 1 : 0,
    };
  });
}

/** prepare(raw, SWING_TAKE): the scoreable pitches with their stuff and location inputs,
 * pitch group and model name. `heights` maps pitcher -> feet for the arm-angle estimate
 * of pitchers the classifier has not seen. */
export function features(rows, bundle, heights) {
  let df = prePitchCounts(applyZone(rows, bundle.env));
  const groups = pitchGroups(df, bundle.l1, heights); // whole outings, before any filter
  df = df
    .map((r, i) => ({ ...r, group: groups[i] }))
    .filter((r) => REQUIRED.every((c) => !missing(r[c])) && r.balls <= 3 && r.strikes <= 2
      && r.sz_top > r.sz_bot && (r.p_throws === "L" || r.p_throws === "R")
      && (r.stand === "L" || r.stand === "R"))
    .map((r) => ({ ...r, pt: r.pitch_type ?? "UN", ...physics(r) }));
  df = arsenal(df).filter((r) => Number.isFinite(r.spin_eff));
  // swing/take decisions only, as in training: no pitchouts, bunts or automatic balls
  df = df.filter((r) => DECISIONS.has(r.call_code)
    && !(IN_PLAY_CODES.has(r.call_code) && /bunt/i.test(r.event_desc ?? "")));
  return df.map((r) => ({
    ...r,
    x_b: r.plate_x * (r.stand === "R" ? -1 : 1),
    z_n: (r.plate_z - r.sz_bot) / (r.sz_top - r.sz_bot),
    model: `${r.group} vs ${r.platoon ? "Same Hand" : "Opposite Hand"}`,
  }));
}

/** _season / _season_code: seasons after the last training season are scored as it. */
function seasonOf(gm, r) {
  return Math.min(r.season, gm.seasons[gm.seasons.length - 1]);
}
function seasonCode(gm, r) {
  if (gm.seasons.length < 2) return [];
  const s = seasonOf(gm, r);
  let i = 0;
  while (i < gm.seasons.length && gm.seasons[i] < s) i += 1; // searchsorted, left
  return [i];
}

/** _stuff_index: per-stage stuff log-odds D from the boosters. */
function stuffIndex(gm, r) {
  const x = Float64Array.from([...STUFF_NUM.map((c) => r[c]), r.is_primary, r.platoon, ...seasonCode(gm, r)], Math.fround);
  return gm.boosters.map((b) => b.raw(x));
}

/** _location_matrix: batter-relative x, zone-normalised z, count, hands (and season). */
function locationRow(gm, r) {
  const w = [r.x_b, r.z_n, r.balls, r.strikes, r.p_throws === "L" ? 1 : 0, r.stand === "L" ? 1 : 0, ...seasonCode(gm, r)];
  return Float64Array.from(w, Math.fround);
}

/** _sequential: class probabilities from stage probabilities. */
function sequential(q) {
  const out = [];
  let stay = 1;
  for (const qs of q) {
    out.push(stay * qs);
    stay *= 1 - qs;
  }
  out.push(stay);
  return out;
}

/** _full_probs: per stage, logit l(W) + r(W) + theta_c (D - r) at the pitch's location
 * and count, chained into class probabilities. */
function fullProbs(gm, r, D) {
  const w = locationRow(gm, r);
  const c = r.balls * 3 + r.strikes;
  return sequential(gm.loc.map((lm, s) => {
    const ell = Math.min(Math.max(lm.predict(w), 1e-4), 1 - 1e-4);
    const res = gm.r[s].predict(w);
    return sigmoid(Math.log(ell / (1 - ell)) + res + gm.thetas[s][c] * (D[s] - res));
  }));
}

/** _draws: the cell's league location draws, else the nearest season that has them. */
function draws(gm, season, balls, strikes, pThrows, stand) {
  const exact = gm.draws.get(`${season}:${balls}:${strikes}:${pThrows}:${stand}`);
  if (exact) return exact;
  const order = [...gm.seasons].sort((a, b) => Math.abs(a - season) - Math.abs(b - season));
  for (const s of order) {
    const d = gm.draws.get(`${s}:${balls}:${strikes}:${pThrows}:${stand}`);
    if (d) return d;
  }
  throw new Error(`no location draws for ${season} ${balls}-${strikes} ${pThrows}/${stand}`);
}

/** class_probs: sequential-logit class probabilities for stuff log-odds t, averaged
 * over the draws ({m, S, data: row-major m x S}). */
function classProbs(t, d, shift) {
  const S = t.length;
  const out = new Array(S + 1).fill(0);
  for (let g = 0; g < d.m; g++) {
    let stay = 1;
    for (let s = 0; s < S; s++) {
      const q = 1 / (1 + Math.exp(-(t[s] + d.data[g * S + s] + shift[s])));
      out[s] += stay * q;
      stay *= 1 - q;
    }
    out[S] += stay;
  }
  return out.map((x) => x / d.m);
}

/** _neutral for one pitch: league-location class probabilities at count c. */
function neutralProbs(stage, gm, r, D, c, delta) {
  const t = D.map((d, s) => gm.thetas[s][c] * d);
  const shift = Array.from(stage.shift);
  if (delta) shift[0] += delta[c];
  return classProbs(t, draws(gm, seasonOf(gm, r), Math.floor(c / 3), c % 3, r.p_throws, r.stand), shift);
}

/** combine._chain: the nine outcomes from the four models' class probabilities. */
function chain([swingTake, takeOutcome, swingOutcome, inPlay]) {
  const [swing, take] = swingTake;
  const bip = swing * swingOutcome[2];
  return [
    take * takeOutcome[1], take * takeOutcome[0], swing * swingOutcome[0], swing * swingOutcome[1],
    ...inPlay.map((p) => bip * p),
  ];
}

/** -(probs . values) summed as numpy sums nine numbers along a row (pairwise, 8 + 1). */
function value(probs, values) {
  const v = probs.map((p, k) => -(p * values[k]));
  return ((v[0] + v[1]) + (v[2] + v[3])) + ((v[4] + v[5]) + (v[6] + v[7])) + v[8];
}

/** One scored pitch's three probability blocks and its values. */
function scorePitch(bundle, r) {
  const gms = bundle.stages.map((st) => st.groups[r.model]);
  const D = gms.map((gm) => stuffIndex(gm, r));
  const c = r.balls * 3 + r.strikes;
  const env = bundle.env;
  const inEnv = env && r.season === env.season;
  const used = bundle.stages.map((st, i) => neutralProbs(st, gms[i], r, D[i], c, inEnv ? asusedDelta(st.name, env) : null));
  const full = bundle.stages.map((st, i) => adjust(st.name, fullProbs(gms[i], r, D[i]), r, env));
  const neutral = new Array(OUTCOMES.length).fill(0);
  for (let k = 0; k < 12; k++) {
    if (!bundle.mix[k]) continue;
    const probs = chain(bundle.stages.map((st, i) => neutralProbs(st, gms[i], r, D[i], k, null)));
    for (let o = 0; o < OUTCOMES.length; o++) neutral[o] += bundle.mix[k] * probs[o];
  }
  const asused = chain(used);
  const pitching = chain(full);
  const atCount = OUTCOMES.map((_, o) => bundle.byCount[o * 12 + c]);
  const out = {
    stuff_rv: value(neutral, bundle.values),
    stuff_rv_asused: value(asused, atCount),
    pitching_rv: value(pitching, atCount),
  };
  out.location_rv = out.pitching_rv - out.stuff_rv_asused;
  return { out, neutral, asused, pitching, D };
}

/**
 * score: per-pitch values for one game's rows, keyed "abi:pitch_number" -> {stuff_rv,
 * stuff_rv_asused, pitching_rv, location_rv}. Pitches the models do not cover (outside
 * the modeled groups, missing tracking, not a swing/take decision) are simply absent.
 * Pass the whole game even to score a few pitchers (`only`, a Set of ids): the count a
 * relieved pitcher's first pitch was thrown in comes from his predecessor's last. With
 * `trace`, each entry also carries the probability blocks and D (for the tests).
 */
export function score(rows, bundle, { heights = new Map(), trace = false, only = null } = {}) {
  const df = features(rows, bundle, heights);
  const modeled = new Set(Object.keys(bundle.stages[0].groups).filter((n) => bundle.stages.every((st) => n in st.groups)));
  const out = new Map();
  for (const r of df) {
    if (!modeled.has(r.model) || (only && !only.has(r.pitcher))) continue;
    const s = scorePitch(bundle, r);
    out.set(`${r.at_bat_index}:${r.pitch_number}`, trace ? { ...s.out, ...s, row: r } : s.out);
  }
  return out;
}

/** plus: a mean per-pitch value as the card's 100 +/- 15 number at an aggregation
 * ("pitcher_game" or "pitcher_game_pitch_type") of plus_scale_constants.json. */
export function plus(scale, rv, column, level) {
  if (rv === null || rv === undefined || Number.isNaN(rv)) return NaN;
  const stat = scale.aggregations[level].columns[column];
  return scale.plus.mean + (scale.plus.sd * (100 * rv - stat.mean)) / stat.sd;
}
