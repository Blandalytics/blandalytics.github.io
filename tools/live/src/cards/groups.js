/**
 * Pitch groups (Fastball / Breaking / Offspeed / Other): pitch-modeling's pitch_groups.py
 * and the Level 1 classifier it runs (pitch_l1.py), for one game's rows.
 *
 * Level 1 estimates each pitcher's arm angle, rotates his movement so the arm points
 * straight up, and looks the pitch up in a frozen soft-membership field over
 * {arm-adjusted horizontal, arm-adjusted vertical, speed below his 95th percentile that
 * game}. A pitcher-game-pitch type takes its most common family. pitch_groups switches
 * the raw-movement field off (cap = 0), so only the arm-adjusted field (A) is used. A
 * type the classifier leaves Unassigned falls back to its Statcast pitch type.
 *
 * `l1` is the classifier's data from the scorer bundle: {coef, intercept, aaMean,
 * dspeedQ, T, s, offPs: Map("pitcher:season" -> deg), offP: Map(pitcher -> deg),
 * height: Map(pitcher -> ft), field: {p: Float32Array, lo, width, bins}}.
 */

const LABELS = ["Unassigned", "Fastball", "Breaking", "Offspeed"]; // L1 names, as pitch_groups renames them
const FALLBACK = {
  Fastball: new Set(["FF", "SI"]),
  Breaking: new Set(["SL", "FC", "SV", "ST", "KC", "CU", "CS"]),
  Offspeed: new Set(["CH", "FS", "FO"]),
};
const CAP = 0; // pitch_groups.model(): w = min(cap, s * H) = 0, the arm-adjusted field only
const RADIANS = Math.PI / 180; // np.radians multiplies by this factor

/** pandas' Series.quantile (numpy's linear method, NaN skipped). numpy interpolates
 * from the nearer end, b - (b - a)(1 - t) past the midpoint, which is kept for parity. */
export function quantile(values, q) {
  const v = values.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const a = v[lo];
  const b = v[Math.min(lo + 1, v.length - 1)];
  const t = pos - lo;
  return t >= 0.5 ? b - (b - a) * (1 - t) : a + (b - a) * t;
}

/** A statsapi height such as 6' 2" in feet, NaN when unusable (pitch_l1._heights). */
export function heightFeet(text) {
  const m = /(\d+)'\s*(\d+)/.exec(text ?? "");
  return m ? Number(m[1]) + Number(m[2]) / 12 : NaN;
}

/** pitch_l1.features: arm angle, arm-adjusted movement and dspeed per row. */
function features(rows, l1, heights) {
  const p95 = new Map();
  for (const r of rows) {
    const k = `${r.pitcher}:${r.game_pk}`;
    if (!p95.has(k)) p95.set(k, []);
    p95.get(k).push(r.release_speed);
  }
  for (const [k, v] of p95) p95.set(k, quantile(v, l1.dspeedQ));
  return rows.map((r) => {
    const lhp = r.p_throws === "L";
    const hbArm = lhp ? -r.hb : r.hb;
    const yRel = 60.5 - r.release_extension;
    const t = (-r.vy0 - Math.sqrt(r.vy0 ** 2 - 2 * r.ay * (r.release_pos_y - yRel))) / r.ay;
    const relX = r.release_pos_x + r.vx0 * t + 0.5 * r.ax * t ** 2;
    const relZ = r.release_pos_z + r.vz0 * t + 0.5 * r.az * t ** 2;
    const h = l1.height.get(r.pitcher) ?? heights.get(r.pitcher) ?? NaN;
    const x = [h, r.release_extension, relX * (lhp ? 1 : -1), relZ];
    let est = x[0] * l1.coef[0] + x[1] * l1.coef[1] + x[2] * l1.coef[2] + x[3] * l1.coef[3] + l1.intercept;
    const off = l1.offPs.get(`${r.pitcher}:${r.season}`) ?? l1.offP.get(r.pitcher) ?? NaN;
    est += Number.isNaN(off) ? 0 : off;
    const angle = Number.isNaN(est) ? l1.aaMean : est;
    const phi = (90 - angle) * RADIANS;
    return {
      horz: hbArm * Math.cos(phi) - r.ivb * Math.sin(phi),
      vert: hbArm * Math.sin(phi) + r.ivb * Math.cos(phi),
      dspeed: r.release_speed - p95.get(`${r.pitcher}:${r.game_pk}`),
    };
  });
}

/** pitch_l1._lookup: the field's three family memberships at a point, zeros outside it. */
function lookup(field, point) {
  const { p, lo, width, bins } = field;
  let flat = 0;
  for (let d = 0; d < 3; d++) {
    if (!Number.isFinite(point[d])) return [0, 0, 0];
    const idx = Math.floor((point[d] - lo[d]) / width[d]);
    if (!(idx >= 0 && idx < bins[d])) return [0, 0, 0];
    flat = flat * bins[d] + idx;
  }
  return [p[flat * 3], p[flat * 3 + 1], p[flat * 3 + 2]];
}

function argmax(v) {
  let best = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i;
  return best;
}

/** pitch_l1.classify: the modal Level 1 family of each row's pitcher-game-pitch type. */
export function level1(rows, l1, heights = new Map()) {
  const feats = features(rows, l1, heights);
  const PA = feats.map((f) => lookup(l1.field, [f.horz, f.vert, f.dspeed]));
  const codes = new Map();
  const code = rows.map((r) => {
    const k = `${r.pitcher}:${r.game_pk}:${r.pitch_type ?? "NA"}`;
    if (!codes.has(k)) codes.set(k, codes.size);
    return codes.get(k);
  });
  const G = codes.size;
  const cnt = Array.from({ length: G }, () => [0, 0, 0]);
  PA.forEach((pa, i) => { if (Math.max(...pa) > 0) cnt[code[i]][argmax(pa)] += 1; });
  const w = cnt.map((c) => {
    const n = Math.max(c[0] + c[1] + c[2], 1);
    let H = 0;
    for (const x of c) if (x > 0) H -= (x / n) * Math.log2(x / n);
    return H >= l1.T ? Math.min(CAP, l1.s * H) : 0;
  });
  const votes = Array.from({ length: G }, () => [0, 0, 0]);
  const score = Array.from({ length: G }, () => [0, 0, 0]);
  PA.forEach((pa, i) => {
    // (1 - w) A + w B + 1e-9 A, with w = 0: the raw-movement field B drops out
    const g = code[i];
    const S = pa.map((x) => (1 - w[g]) * x + 1e-9 * x);
    if (Math.max(...S) > 0) votes[g][argmax(S)] += 1;
    for (let k = 0; k < 3; k++) score[g][k] += S[k];
  });
  const modal = votes.map((v, g) => (v[0] + v[1] + v[2] > 0 ? argmax(v.map((x, k) => x * 1e6 + score[g][k])) + 1 : 0));
  return code.map((g) => LABELS[modal[g]]);
}

/** pitch_groups.assign: Level 1, else the pitch-type fallback, else Other. */
export function pitchGroups(rows, l1, heights) {
  const fam = level1(rows, l1, heights);
  return rows.map((r, i) => {
    if (fam[i] !== "Unassigned") return fam[i];
    for (const [name, types] of Object.entries(FALLBACK)) if (types.has(r.pitch_type)) return name;
    return "Other";
  });
}
