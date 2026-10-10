/**
 * The scorer bundle (cards/models/scorer.pack, written by
 * tools/pitcher_card/export_scorer.py) as the structures scorer.js and build.js run on.
 *
 * One pack: per chained model and pitch group its thetas, location draws and LightGBM
 * boosters / location / residual models; the count mix, run-value tables, plus scale and
 * 2026 ABS env in its meta; pitch_l1's arm-angle estimator and field; the xSLG model.
 * The arrays are views on the buffer, so loading costs little beyond the header.
 */

import { readPack } from "./pack.js";
import { loadModel } from "./trees.js";

const range = (n) => Array.from({ length: n }, (_, i) => i);

function group(pack, stage, name, gm) {
  const prefix = `${stage}/${name}`;
  const thetas = pack.arrays[`${prefix}/thetas`];
  const all = pack.arrays[`${prefix}/draws`];
  const S = gm.nstages;
  const models = (kind) => range(S).map((s) => loadModel(pack, `${prefix}/${kind}/${s}`));
  return {
    seasons: gm.seasons,
    thetas: range(S).map((s) => thetas.subarray(s * 12, s * 12 + 12)),
    draws: new Map(Object.entries(gm.draws).map(([key, [offset, m]]) => [
      key, { m, S, data: all.subarray(offset, offset + m * S) },
    ])),
    boosters: models("boosters"),
    loc: models("loc_models"),
    r: models("r_models"),
  };
}

function level1(pack, l1) {
  const a = (name) => pack.arrays[`l1/${name}`];
  const offPs = new Map();
  a("off_ps_pitcher").forEach((p, i) => offPs.set(`${p}:${a("off_ps_season")[i]}`, a("off_ps_val")[i]));
  const pairs = (keys, vals) => new Map(Array.from(keys, (k, i) => [k, vals[i]]));
  return {
    coef: l1.coef, intercept: l1.intercept, aaMean: l1.aa_mean, dspeedQ: l1.dspeed_q, T: l1.T, s: l1.s,
    offPs,
    offP: pairs(a("off_p_pitcher"), a("off_p_val")),
    height: pairs(a("height_pitcher"), a("height_val")),
    field: { p: a("field"), lo: l1.lo, width: l1.width, bins: l1.bins },
  };
}

/** The bundle from the pack's bytes (an ArrayBuffer or a view of one). */
export function loadBundle(data) {
  const pack = readPack(data);
  const m = pack.meta;
  const xgb = loadModel(pack, "xslg");
  return {
    sources: m.sources,
    stages: m.stages.map((st) => ({
      name: st.name,
      shift: st.shift,
      groups: Object.fromEntries(Object.entries(st.groups).map(([name, gm]) => [name, group(pack, st.name, name, gm)])),
    })),
    mix: m.mix,
    values: m.values,
    byCount: m.by_count,
    scale: m.scale,
    env: { ...m.env, zone: { ...m.env.zone, byBatter: new Map(m.env.zone.ref.map(([b, t, s]) => [b, [t, s]])) } },
    l1: level1(pack, m.l1),
    // expected total bases on contact: predict_proba(...)[:, 1:] @ [1, 2, 3, 4]
    xslg: (launchSpeed, launchAngle) => {
      const p = xgb.predictProba([launchSpeed, launchAngle]);
      return p[1] * 1 + p[2] * 2 + p[3] * 3 + p[4] * 4;
    },
  };
}
