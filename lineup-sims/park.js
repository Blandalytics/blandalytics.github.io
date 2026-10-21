// A ballpark's effect on one plate appearance, and home field's, for the Game Sim (game.js) and its checks
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

// Home field, on one plate appearance (after the park): the home team's batters strike out less,
// walk more and get more hits on the balls they put in play; the road team's the reverse. From 2026's
// regular season at the home team's own park, park-neutral, each PA's batter and pitching (the starter,
// or his team's bullpen) accounted for, fitted together with BULLPEN_LEAD below (the Game Sim's dev
// analysis, scores/joint.py): home over road, K 0.954, BB 1.035, HBP 1.00, hits per ball in play 1.016,
// split evenly between the two sides (home x m, road / m). Then, with the bullpen by the score in the
// sim, each multiplier raised to the 1.25 power: that put the home team's wins over every 2026 game at
// 2026's own 52.9% (52.3% as fitted) and gave the best log loss on who won (scores/calib.mjs).
// K and BB move per PA; the balls in play are what that leaves, the hits keep their share of them times
// HperBIP (their mix of 1B, 2B, 3B and HR kept) and the outs in play take the rest, in their own proportions.
// sign: +1 the batter is at home, -1 on the road, 0 neither (a neutral site): q unchanged.
export const HOME_FIELD = { K: 0.9711, BB: 1.0218, HBP: 1, HperBIP: 1.0100 };
const HITS = [3, 4, 5, 6];        // 1B, 2B, 3B, HR

// The bullpen by the score (the Game Sim's dev analysis, scores/joint.py, fitted together with home
// field): teams bring in their best relievers to hold a close lead and their mop-up men when a game is
// out of hand either way, so a bullpen's K, BB and hits per ball in play move with the pitching side's
// lead as each plate appearance begins. Its 2026 rates are the average over all of them, so these average
// 1 over 2026's relief plate appearances. Applied as homeField() applies its multipliers (sign +1).
// Leads: down 5+, down 3-4, down 1-2, tied, up 1-2, up 3-4, up 5+ (leadBucket()).
export const BULLPEN_LEAD = [
  { K: 0.871, BB: 0.966, HBP: 1, HperBIP: 1.023 },
  { K: 0.927, BB: 1.082, HBP: 1, HperBIP: 1.022 },
  { K: 1.000, BB: 0.990, HBP: 1, HperBIP: 1.011 },
  { K: 1.041, BB: 1.012, HBP: 1, HperBIP: 1.040 },
  { K: 1.082, BB: 1.018, HBP: 1, HperBIP: 0.963 },
  { K: 1.091, BB: 1.001, HBP: 1, HperBIP: 0.963 },
  { K: 0.994, BB: 0.918, HBP: 1, HperBIP: 0.978 },
];
export const leadBucket = (lead) => (lead <= -5 ? 0 : lead <= -3 ? 1 : lead < 0 ? 2 : lead === 0 ? 3 : lead <= 2 ? 4 : lead <= 4 ? 5 : 6);

export function homeField(q, sign, hf = HOME_FIELD) {
  if (!sign) return q;
  const out = Array.from(q);
  out[0] = q[0] * hf.K ** sign;
  out[1] = q[1] * hf.BB ** sign;
  out[2] = q[2] * hf.HBP ** sign;
  const bip0 = 1 - q[0] - q[1] - q[2], bip1 = 1 - out[0] - out[1] - out[2];
  let h0 = 0, o0 = 0;
  for (const i of HITS) h0 += q[i];
  for (const i of OUTS) o0 += q[i];
  if (bip0 <= 0 || bip1 <= 0) {
    // no balls in play (or none left): scale the three and renormalize
    const t = out.reduce((a, x) => a + x, 0);
    return out.map((x) => x / t);
  }
  // every ball in play a hit (no outs in play to trade with): the hits are all of them
  const h1 = o0 > 0 ? Math.min(bip1, (h0 / bip0) * bip1 * hf.HperBIP ** sign) : bip1, o1 = bip1 - h1;
  for (const i of HITS) out[i] = h0 > 0 ? (q[i] * h1) / h0 : 0;
  for (const i of OUTS) out[i] = o0 > 0 ? (q[i] * o1) / o0 : 0;
  return out;
}
