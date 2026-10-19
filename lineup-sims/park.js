// A ballpark's effect on one plate appearance, for the Game Sim (game.js) and its checks
// (tools/lineup_sims/test_game.mjs). No imports, so it doesn't follow sim.js's ?v=.
//
// q: a matchup's outcome chances, in sim.js's CATS order (K, BB, HBP, 1B, 2B, 3B, HR, then the
// outs in play GB, LD, FB, PU). f: the park's factors for the first seven, as ratios (1: the
// average park). eh, ep: the hitter's and the pitcher's environments, the same seven (what their
// 2026 rates already carry from their home parks). Each of the seven is scaled by f / (eh * ep)
// (log5 multiplies the hitter's and the pitcher's rates, so each one's environment comes out once),
// and the outs in play share what's left, in their own proportions. Where every ratio is exactly
// 1 (an average park, players with no home park in their rates), q comes back unchanged.
export const PARK_N = 7;          // K, BB, HBP, 1B, 2B, 3B, HR: CATS[0..6]
const OUTS = [7, 8, 9, 10];       // GB, LD, FB, PU

export function parkAdjust(q, f, eh, ep) {
  const r = new Array(PARK_N);
  let same = true;
  for (let j = 0; j < PARK_N; j++) {
    r[j] = f[j] / (eh[j] * ep[j]);
    if (r[j] !== 1) same = false;
  }
  if (same) return q;
  const out = Array.from(q);
  let kept = 0, outs = 0;
  for (let j = 0; j < PARK_N; j++) { out[j] = q[j] * r[j]; kept += out[j]; }
  for (const i of OUTS) outs += q[i];
  if (kept >= 1 || outs <= 0) {
    // nothing left for the outs in play (a lineup that never makes one): scale everything instead
    const t = out.reduce((a, x) => a + x, 0);
    return out.map((x) => x / t);
  }
  for (const i of OUTS) out[i] = (q[i] * (1 - kept)) / outs;
  return out;
}
