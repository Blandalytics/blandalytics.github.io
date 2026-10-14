// The risk-aware value (risk-aware-valuation-parameters.md; the risk plan's steps R6, R7 and R9).
// Off by default: the page runs it only when the Risk setting is on.
//
// Each player's season outcomes come from the projections' simulation as 50 stratified draws (the
// risk file, "RSK1": one real draw at the middle of each of 50 equal quantile bins of his $). Every
// draw is valued exactly as calc.js values his projection, in the finished run's frame: its category
// weights G, the drafted pool's rates, the playing-time fill for his role, the slot level he is
// valued at, the specialist correction and a lineup lock's share. That gives V, his SGP above
// replacement in each draw. Then, with r the in-season free-agent floor (L1) and λ the share of the
// season played before a bust shows (P7):
//
//   the projection    m = E[V] + k·(V − E[V]): what the team knows of the draw when it decides at λ
//                     (the in-season projection, whose spread is k × the draws'; INFO_K by side)
//   option increment  Δ = E[max(m, r)] − E[m], over the draws (spec 6.1 on m: the upgrade rule, a
//                     team replaces a player only by a free agent it projects higher). r is r_pos read
//                     at the replacement: the share of the season played at λ (R4's section 7)
//   effective value   EffValue = μ + (1 − λ)·Δ − IL cost (spec 6.2 as an increment over the
//                     calculator's own value μ: the draws' mean V is above μ by the convexity of the
//                     playing-time fill, not by risk, so E[V] = μ is not assumed)
//   effective var.    Var_eff = (λ·σ)² + (1 − λ)²·(Var[max(m, r)] + (1 − k²)·Var[V]·P(m ≥ r)) (spec
//                     6.3 with the part of the season m does not see kept in the kept draws; σ from the
//                     draws; no covariance with the rest of the roster: P8 = 0)
//   certainty equiv.  CE = EffValue − (z / 2S)·c²·Var_eff, z = (M − H) / S (spec 6.4), or the certain
//                     value with the exact probability gain when √(c²·Var_eff) > 0.4·S (spec section 9).
//                     c² (roto only) puts a side's variance in standings points: calc.js's G prices
//                     a unit with its own luck model ν, the draws carry more luck per team, so a unit
//                     of a draw's spread buys fewer points: c² = (D + L_calc) / (D + L_draws)
//
// The model "draws" (rs.model) is risk.js before these three changes (PLAN rows 13-14): k = 1, r read
// at the month of the valuation, c² = 1. It stays for comparison.
//
// The risk-aware $ is CE priced as calc.js prices SGP above replacement: the drafted players chosen
// by CE over the same slots and bench, the same budget, hitter split and dollar curve. No DOM here;
// calc.js comes in as an argument (C), so the page and Node use one copy of it.

// ---- placeholders that later steps measure ------------------------------------------------------

/** The spread factor (R2 fits it): V' = median + f·(V − median), by role and by the player's $ tier */
export const SPREAD_CUTS = [1, 5, 15, 30];   // $: <1, 1-5, 5-15, 15-30, 30+
export const TIER_NAMES = ["<$1", "$1-5", "$5-15", "$15-30", "$30+"];
export const SPREAD = { H: [1, 1, 1, 1, 1], C: [1, 1, 1, 1, 1], SP: [1, 1, 1, 1, 1], RP: [1, 1, 1, 1, 1], P: [1, 1, 1, 1, 1] };

/**
 * λ (P7, R3 measures it): the share of the season played before a bust shows, by side and by the
 * cause of the draw's shortfall: "time" (a draw that loses a quarter of the season or more: injury,
 * demotion), "role" (a pitcher's saves or starts lost without lost time), "skill" (the rest). The
 * values are the specification's assumptions (hitters 0.20-0.30, pitchers 0.10-0.15). The
 * specification's λ = 0 for an injury bust is not used for "time": the playing-time fill already
 * replaces the lost time at replacement level in μ and in each draw, so a "time" draw below r is
 * below it by his production in the time he plays, which shows as slowly as a skill bust.
 */
export const LAMBDA = { h: { time: 0.25, role: 0.25, skill: 0.25 }, p: { time: 0.125, role: 0.125, skill: 0.125 } };

/**
 * r_pos (L1): the floor is the replacement level of the player's slot (0 SGP above replacement)
 * plus an in-season premium (R4 measures it: call-ups and breakouts) by slot, league size and month
 * (0 = before the season, 1-6 = April to September): { slot: { teams: [by month] } }. Empty: 0.
 */
export const R_PREMIUM = {};

/** The share of the season played at months 0-6 (the mean over 2023-26; R4's report section 7) */
export const MONTH_SHARE = [0, 0.10, 0.19, 0.36, 0.53, 0.68, 0.85];

/**
 * k (PLAN row 13, measured): the spread of the in-season projection's change over the spread of the
 * player's draws, the calculator's drafted players of 2023-26, at the check date nearest each side's
 * λ (hitters 06-01, pitchers 05-01; projections repository, data/backtest/risk/tilt/info_k.json). A
 * team drops on that projection, not on the season it will have.
 */
export const INFO_K = { h: 0.502, p: 0.403 };

/**
 * The models of the option and the CE term (rs.model; the single settings rs.infoK, rs.floorAt and
 * rs.teamVar override a model's):
 *   upgrade  PLAN row 14 with row 13's two fixes: the option on the projection m at λ
 *            (INFO_K), the floor read at the replacement, the CE term's variance in standings points
 *   fixes    row 13's two fixes only (k and c²), the floor read at the month of the valuation
 *   draws    the default (the risk-aware value is held, 2026-10-14; R10's rooms: upgrade loses to it
 *            in head-to-head): risk.js before them: the option on the season's draws themselves (k = 1), the floor read
 *            at the month of the valuation, the CE term on the SGP variance
 */
export const RISK_MODELS = {
  upgrade: { infoK: INFO_K, floorAt: "replacement", teamVar: true, label: "Upgrade on the projection" },
  fixes: { infoK: INFO_K, floorAt: "valuation", teamVar: true, label: "Row 13's fixes (k, c²)" },
  draws: { infoK: null, floorAt: "valuation", teamVar: false, label: "The draws (before rows 13-14)" },
};

/**
 * The transaction speed (L2): how long a visible bust stays in the lineup (days added to λ) and the
 * share of the in-season premium a team gets (others claim the best free agents first).
 */
export const TRANSACTIONS = {
  daily: { lagDays: 2, rScale: 1, label: "Daily free agents" },     // a claim clears in about 2 days
  weekly: { lagDays: 5, rScale: 0.9, label: "Weekly waivers (FAAB)" },   // half a week to the run, then the run
  limited: { lagDays: 14, rScale: 0.75, label: "Limited moves" },   // a cap on moves or long waivers
};
export const SEASON_DAYS = 182;

/**
 * The injured list (L3): a draw that loses this share of his full-season playing time (his draws'
 * 75th percentile) is an extended loss of time. The draws don't say why, so a demotion or a lost
 * rotation spot counts too, and the IL's load is overstated.
 */
export const IL_RULE = { extended: 0.25 };

export const DEFAULT_RISK = { payout: "winner", playoffTeams: 4, transactions: "daily", ilSlots: 2, month: 0, model: "draws" };

// ---- the normal distribution -------------------------------------------------------------------

const SQRT2PI = Math.sqrt(2 * Math.PI);
export const phi = (x) => Math.exp(-0.5 * x * x) / SQRT2PI;

/** Φ to about 1e-15: Marsaglia's series inside ±5, the tail's continued fraction outside */
export function Phi(x) {
  if (Number.isNaN(x)) return NaN;
  const a = Math.abs(x);
  if (a < 5) {
    const x2 = x * x;
    let term = x, sum = x;
    for (let k = 3; k < 500; k += 2) {
      term *= x2 / k;
      const next = sum + term;
      if (next === sum) break;
      sum = next;
    }
    return 0.5 + phi(x) * sum;
  }
  if (a > 38) return x > 0 ? 1 : 0;
  let f = a;   // a + 1/(a + 2/(a + 3/(...))), from the inside out
  for (let k = 80; k >= 1; k--) f = a + k / f;
  const q = phi(a) / f;
  return x > 0 ? 1 - q : q;
}

/** Φ⁻¹: Acklam's rational approximation, then one Halley step on Φ */
export function PhiInv(p) {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  let x;
  if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
  else if (p > 1 - 0.02425) x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
  else {
    const q = p - 0.5, r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const u = (Phi(x) - p) * SQRT2PI * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// ---- the specification's formulas (section 9's reference code, same names) ----------------------

/** E[max(V, r)] for V ~ N(μ, σ²) (spec 6.1) */
export function optionValue(mu, sigma, r) {
  if (!(sigma > 0)) return Math.max(mu, r);
  const d = (mu - r) / sigma;
  return mu * Phi(d) + r * Phi(-d) + sigma * phi(d);
}
/** Var[max(V, r)] for V ~ N(μ, σ²) */
export function truncatedVariance(mu, sigma, r) {
  if (!(sigma > 0)) return 0;
  const m1 = optionValue(mu, sigma, r), a = (r - mu) / sigma;
  const ev2Above = (mu ** 2 + sigma ** 2) * Phi(-a) + (mu + r) * sigma * phi(a);
  return ev2Above + r ** 2 * Phi(a) - m1 ** 2;
}
/** λ·μ + (1 − λ)·E[max(V, r)] (spec 6.2) */
export const effectiveValue = (mu, sigma, r, lam) => lam * mu + (1 - lam) * optionValue(mu, sigma, r);
/** value − (z / 2S)·Var_eff, z = (M − H) / S (spec 6.4) */
export function certaintyEquivalent(value, varEff, M, S, H) {
  const z = (M - H) / S;
  return value - (z / (2 * S)) * varEff;
}
export function riskAdjustedSurplus(mu, sigma, r, lam, cost, M, S, H, covWithRoster = 0) {
  const ev = effectiveValue(mu, sigma, r, lam);
  const varEff = (lam * sigma) ** 2 + (1 - lam) ** 2 * truncatedVariance(mu, sigma, r) + 2 * covWithRoster;
  return certaintyEquivalent(ev, varEff, M, S, H) - cost;
}
/** The exact change in P(team ≥ H) from one independent player of mean μ and variance v */
export const exactProbGain = (mu, v, M, S, H) => Phi((M + mu - H) / Math.sqrt(S * S + v)) - Phi((M - H) / S);
/** The first-order change in P(team ≥ H) from a certain value c (what the CE formula prices) */
export const linearProbGain = (c, M, S, H) => (phi((M - H) / S) * c) / S;
/** The certain value with the exact probability gain of a player of mean μ and variance v */
export function exactCertainty(mu, v, M, S, H) {
  const z = (M - H) / S;
  const p = Math.min(1 - 1e-15, Math.max(1e-300, Phi(z) + exactProbGain(mu, v, M, S, H)));
  return S * (PhiInv(p) - z);
}

/** Over equally weighted draws v: E[V], Var[V], E[max(V, r)], Var[max(V, r)]; r a number or one per draw */
export function drawMoments(v, r) {
  const n = v.length, each = typeof r !== "number";
  let s = 0, s2 = 0, m = 0, m2 = 0;
  for (let j = 0; j < n; j++) {
    const x = v[j], rj = each ? r[j] : r, y = x > rj ? x : rj;
    s += x; s2 += x * x; m += y; m2 += y * y;
  }
  const mean = s / n, opt = m / n;
  return { mean, var: Math.max(0, s2 / n - mean * mean), option: opt, optVar: Math.max(0, m2 / n - opt * opt) };
}

// ---- the risk file -------------------------------------------------------------------------------

/**
 * A risk file (projections repository, src/valuation/risk_draws.py), little-endian: "RSK1", the
 * header's length (uint32), a UTF-8 JSON header (side, basis, season, draws N, players P, stats,
 * ip_in_outs, order "stat, player, draw"), MLBAMID int32 × P, counts uint16 × stats × P × N. Returns
 * { head, side, ids, players, draws, stats: { name: Float64Array, player-major (p·N + n) } }, IP in innings.
 */
export function parseRiskFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "RSK1") throw new Error("not a risk file (no RSK1)");
  const hl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  if (head.order && head.order !== "stat, player, draw") throw new Error(`risk file: unknown order "${head.order}"`);
  const P = head.players, N = head.draws, S = head.stats.length;
  const need = 8 + hl + 4 * P + 2 * S * P * N;
  if (bytes.length !== need) throw new Error(`risk file: ${bytes.length} bytes, its header says ${need}`);
  let o = 8 + hl;
  const ids = new Int32Array(P);
  for (let i = 0; i < P; i++) ids[i] = dv.getInt32(o + 4 * i, true);
  o += 4 * P;
  const stats = {};
  head.stats.forEach((name, k) => {
    const out = new Float64Array(P * N), at = o + 2 * k * P * N, div = name === "IP" && head.ip_in_outs ? 3 : 1;
    for (let j = 0; j < P * N; j++) out[j] = dv.getUint16(at + 2 * j, true) / div;
    stats[name] = out;
  });
  return { head, side: head.side, ids, players: P, draws: N, stats };
}

// The draws as a calc.js table (one row per player and draw), with every column a category can be
// built from: the counts under the calculator's names (BF is TBF, HLD is HD), the combined counts
// (1B, XBH, TB, SV+H, W+QS) and the rates (for the presence check; categorySpec takes rate stats
// from their components). Kept per file.
const LINES = new WeakMap();
const P_NAMES = { BF: "TBF", HLD: "HD" };
function drawLines(file) {
  if (LINES.has(file)) return LINES.get(file);
  const n = file.players * file.draws, data = {};
  for (const [name, arr] of Object.entries(file.stats)) data[(file.side === "p" && P_NAMES[name]) || name] = arr;
  const has = (...cols) => cols.every((c) => c in data);
  const make = (f) => { const a = new Float64Array(n); for (let j = 0; j < n; j++) a[j] = f(j); return a; };
  const div = (a, b) => (b > 0 ? a / b : NaN);
  const g = data;
  if (file.side === "h") {
    if (has("H", "2B", "3B", "HR")) {
      g["1B"] = make((j) => Math.max(0, g.H[j] - g["2B"][j] - g["3B"][j] - g.HR[j]));
      g.XBH = make((j) => g["2B"][j] + g["3B"][j] + g.HR[j]);
      g.TB = make((j) => g["1B"][j] + 2 * g["2B"][j] + 3 * g["3B"][j] + 4 * g.HR[j]);
    }
    if (has("H", "AB")) g.AVG = make((j) => div(g.H[j], g.AB[j]));
    if (has("H", "BB", "HBP", "AB", "SF")) g.OBP = make((j) => div(g.H[j] + g.BB[j] + g.HBP[j], g.AB[j] + g.BB[j] + g.HBP[j] + g.SF[j]));
    if (has("TB", "AB")) g.SLG = make((j) => div(g.TB[j], g.AB[j]));
    if (has("SLG", "AVG")) g.ISO = make((j) => g.SLG[j] - g.AVG[j]);
    if (has("OBP", "SLG")) g.OPS = make((j) => g.OBP[j] + g.SLG[j]);
    if (has("BB", "PA")) g["BB%"] = make((j) => div(g.BB[j], g.PA[j]));
    if (has("K", "PA")) g["K%"] = make((j) => div(g.K[j], g.PA[j]));
  } else {
    if (has("SV", "HD")) g["SV+H"] = make((j) => g.SV[j] + g.HD[j]);
    if (has("W", "QS")) g["W+QS"] = make((j) => g.W[j] + g.QS[j]);
    if (has("ER", "IP")) g.ERA = make((j) => div(9 * g.ER[j], g.IP[j]));
    if (has("BB", "H", "IP")) g.WHIP = make((j) => div(g.BB[j] + g.H[j], g.IP[j]));
    for (const [rate, cnt] of [["K/9", "K"], ["BB/9", "BB"], ["HR/9", "HR"]]) if (has(cnt, "IP")) g[rate] = make((j) => div(9 * g[cnt][j], g.IP[j]));
    for (const [rate, cnt] of [["K%", "K"], ["BB%", "BB"]]) if (has(cnt, "TBF")) g[rate] = make((j) => div(g[cnt][j], g.TBF[j]));
    if (has("K", "BB", "TBF")) g["K-BB%"] = make((j) => div(g.K[j] - g.BB[j], g.TBF[j]));
    if (has("K", "BB")) g["K/BB"] = make((j) => g.K[j] / Math.min(Math.max(g.BB[j], 0.1), 1000));
  }
  const table = { columns: Object.keys(data), n, data };
  LINES.set(file, table);
  return table;
}

// wOBA's weights aren't in the projections: a draw's wOBA is FanGraphs-style linear weights scaled
// so that the player's projected line gives his projected wOBA
const WOBA = { BB: 0.69, HBP: 0.72, "1B": 0.89, "2B": 1.27, "3B": 1.62, HR: 2.1 };
function linearWoba(d, j) {
  const num = WOBA.BB * d.BB[j] + WOBA.HBP * d.HBP[j] + WOBA["1B"] * d["1B"][j] + WOBA["2B"] * d["2B"][j] + WOBA["3B"] * d["3B"][j] + WOBA.HR * d.HR[j];
  const den = d.AB[j] + d.BB[j] + d.SF[j] + d.HBP[j];
  return den > 0 ? num / den : NaN;
}
function withWoba(lines, file, T, rowOfPlayer) {
  const need = ["BB", "HBP", "1B", "2B", "3B", "HR", "AB", "SF"];
  if (!need.every((c) => c in lines.data) || !("wOBA" in T.data)) return lines;
  const t = T.data, N = file.draws;
  const col = (c, i) => (t[c] && Number.isFinite(t[c][i]) ? t[c][i] : NaN);
  const proj = (i) => {
    const one = Number.isFinite(col("1B", i)) ? col("1B", i) : col("H", i) - col("2B", i) - col("3B", i) - col("HR", i);
    const line = { BB: [col("BB", i)], HBP: [col("HBP", i)], "1B": [one], "2B": [col("2B", i)], "3B": [col("3B", i)], HR: [col("HR", i)], AB: [col("AB", i)], SF: [col("SF", i)] };
    return linearWoba(line, 0);
  };
  const w = new Float64Array(lines.n);
  for (let m = 0; m < file.players; m++) {
    const i = rowOfPlayer[m], base = i >= 0 ? proj(i) : NaN;
    const scale = i >= 0 && Number.isFinite(t.wOBA[i]) && base > 0 ? t.wOBA[i] / base : 1;
    for (let n = 0; n < N; n++) w[m * N + n] = scale * linearWoba(lines.data, m * N + n);
  }
  return { columns: [...lines.columns, "wOBA"], n: lines.n, data: { ...lines.data, wOBA: w } };
}

// ---- valuing stat lines in a finished run's frame -----------------------------------------------

/** The categories (with their points in a points league) of one side, as calc.js reads the settings */
function categoriesOf(s, side) {
  if (s.style === "Points") {
    const rows = side === "h" ? s.hitterPoints : s.pitcherPoints;
    return [...new Map(rows.filter(([c]) => c)).entries()].map(([cat, pts]) => ({ cat, pts }));
  }
  return (side === "h" ? s.hitterCats : s.pitcherCats).map((cat) => ({ cat, pts: undefined }));
}

/**
 * SGP above replacement of stat lines (a calc.js table Tl), each priced as player row rowOf[j] of the
 * side is priced in the last pass d (calc.js valueSideWith): own production (rate stats against the
 * pool's rate) plus the playing-time fill at his role's replacement production, weighted by G, less
 * the level of the slot he is valued at, with the specialist correction, capped at 0 for a player no
 * slot takes, at a binding lineup lock's share. Lines with rowOf −1 are skipped (NaN).
 */
export function lineValues(C, d, side, specs, Tl, rowOf, ctx) {
  const K = specs.length, n = Tl.n;
  const vol = Tl.data[side === "h" ? "PA" : "IP"];
  const levels = d.byPos.levels, idx = new Map(levels.map((l, k) => [l.slot, k]));
  let deep = 0;
  levels.forEach((l, k) => { if (l.level > levels[deep].level) deep = k; });
  const w = d.lock && d.lock.kappa ? d.lock.kappa : null;
  const out = new Float64Array(n).fill(NaN), x = new Float64Array(K);
  for (let j = 0; j < n; j++) {
    const i = rowOf[j];
    if (i < 0) continue;
    const f = d.targets ? d.targets[ctx.roles[i]] : null;
    const v = Number.isNaN(vol[j]) ? 0 : vol[j];
    let score = 0;
    for (let k = 0; k < K; k++) {
      const sp = specs[k];
      const own = sp.kind === "count" ? sp.sign * sp.raw[j] : sp.sign * (sp.num[j] - d.rates[k] * sp.den[j]);
      let xk = own;
      if (f) {
        const u = f.perUnit[k], missing = Math.max(0, f.target - v);
        xk = own + missing * sp.sign * (sp.kind === "count" ? u.count : u.num - d.rates[k] * u.den);
      }
      x[k] = xk;
      score += d.G[k] * xk;
    }
    const at = d.byPos.valuedAt[i], s = at === null ? deep : idx.get(at);
    const level = levels[s].level, vec = levels[s].vec;
    let adj = 0;
    if (ctx.specialists) {
      for (let k = 0; k < K; k++) {
        const dd = x[k] - vec[k];
        if (dd > 0.5 * d.sigma[k]) adj += (ctx.N - 1) * (C.normCdf(dd / (Math.SQRT2 * d.sigma[k])) - 0.5) - d.G[k] * dd;
      }
    }
    const lin = score - level;
    let sgpar = at === null ? Math.min(0, lin + adj) : lin + adj;
    if (w && sgpar > 0 && w[i] < 1) sgpar += (w[i] - 1) * sgpar;
    out[j] = sgpar;
  }
  return out;
}

// calc.js's dollars for SGP above replacement x on a side: its last drafted player (base), its rate
// along the dollar curve, and the cap that keeps a player no roster has room for under the min bid
const rateAt = (u, r, gamma) => (u > 0 ? r.k * u ** (gamma - 1) : r.perSGP);
export function dollarsOf(x, drafted, pr, gamma, minBid, cap) {
  const d = minBid + (x - pr.base) * rateAt(x - pr.base, pr, gamma);
  return drafted ? d + pr.flat : cap ? Math.min(d, minBid - 0.01) : d;
}
/** A side's pricing from its drafted players' values (calc.js price(): rateOf over the last drafted one) */
export function pricingOf(values, slot, dollars, gamma) {
  let base = Infinity, n = 0;
  for (let i = 0; i < values.length; i++) if (slot[i] !== null && Number.isFinite(values[i])) { base = Math.min(base, values[i]); n++; }
  let over = 0, curve = 0;
  for (let i = 0; i < values.length; i++) {
    if (slot[i] === null || !Number.isFinite(values[i])) continue;
    over += values[i] - base;
    curve += Math.max(0, values[i] - base) ** gamma;
  }
  return over > 0 ? { base, k: dollars / curve, perSGP: dollars / over, flat: 0 } : { base, k: 0, perSGP: 0, flat: n ? dollars / n : 0 };
}

/**
 * Values of a side's rows (SGP above replacement) priced as calc.js prices its own: the drafted
 * players chosen by them over the league's slots and bench, the last one at the min bid, the side's
 * dollars over him along the curve, and anyone no roster has room for under the min bid. With the
 * calculator's own values it gives the calculator's $ exactly.
 */
export function priceValues(C, pricing, side, values, minBid) {
  const pr = pricing[side];
  const slot = C.positionReplacement(Array.from(values), pr.pos, { ...pr.caps, BN: pr.bench }, { ...pr.types, BN: null }, 0).slot;
  const dollars = side === "h" ? pricing.share * pricing.spare : (1 - pricing.share) * pricing.spare;
  const rp = pricingOf(values, slot, dollars, pricing.gamma);
  const value = Array.from(values, (x, i) => (Number.isFinite(x) ? dollarsOf(x, slot[i] !== null, rp, pricing.gamma, minBid, true) : NaN));
  return { slot, pricing: rp, value };
}

const quantileSorted = (v, q) => {
  const at = (v.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return v[lo] + (v[hi] - v[lo]) * (at - lo);
};
const median = (v) => quantileSorted(Float64Array.from(v).sort(), 0.5);

/** r_pos (L1) for a slot, league size and month: 0 plus the premium table's entry, linear in league size */
export function rPos(slot, teams, month = 0, table = R_PREMIUM) {
  const bySize = slot ? table[slot] : null;
  if (!bySize) return 0;
  const sizes = Object.keys(bySize).map(Number).sort((a, b) => a - b);
  const at = (t) => { const row = bySize[t]; return row[Math.min(month, row.length - 1)] ?? 0; };
  if (teams <= sizes[0]) return at(sizes[0]);
  if (teams >= sizes[sizes.length - 1]) return at(sizes[sizes.length - 1]);
  for (let j = 1; j < sizes.length; j++) {
    if (teams <= sizes[j]) { const a = sizes[j - 1], b = sizes[j]; return at(a) + ((teams - a) / (b - a)) * (at(b) - at(a)); }
  }
  return 0;
}

/**
 * r_pos at a share of the season played (R4's section 7): the table's months placed at MONTH_SHARE,
 * linear between them (the last month beyond its share)
 */
export function rPosAt(slot, teams, share, table = R_PREMIUM) {
  const S = MONTH_SHARE;
  if (!(share > S[0])) return rPos(slot, teams, 0, table);
  for (let j = 1; j < S.length; j++) {
    if (share <= S[j]) {
      const a = rPos(slot, teams, j - 1, table), b = rPos(slot, teams, j, table);
      return a + ((share - S[j - 1]) / (S[j] - S[j - 1])) * (b - a);
    }
  }
  return rPos(slot, teams, S.length - 1, table);
}

// ---- the objective (O1-O3): the target H, the mean M and the spread S of an average team ---------

function uniforms(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normals(seed) {   // Marsaglia's polar method
  const u = uniforms(seed);
  let spare = NaN;
  return () => {
    if (!Number.isNaN(spare)) { const s = spare; spare = NaN; return s; }
    let a, b, q;
    do { a = 2 * u() - 1; b = 2 * u() - 1; q = a * a + b * b; } while (q >= 1 || q === 0);
    const f = Math.sqrt((-2 * Math.log(q)) / q);
    spare = b * f;
    return a * f;
  };
}
/** The weeks' pairings of a round robin (the circle method; with an odd count, one team sits each week) */
function roundRobin(N, weeks) {
  const M = N % 2 ? N + 1 : N, rest = Array.from({ length: M - 1 }, (_, j) => j + 1), out = [];
  for (let w = 0; w < weeks; w++) {
    const r = w % (M - 1), order = [0, ...rest.slice(r), ...rest.slice(0, r)], pairs = [];
    for (let j = 0; j < M / 2; j++) { const a = order[j], b = order[M - 1 - j]; if (a < N && b < N) pairs.push([a, b]); }
    out.push(pairs);
  }
  return out;
}

const OBJECTIVES = new Map();
/**
 * The objective of an average team before the draft, from the calculator's team-total model: in each
 * category every team's total is normal, spread by the draft (σ²_draft,k) and a season's luck (ν_k),
 * independent across teams and categories.
 *   roto: standings points by rank in each category. Before the draft every team's rank is uniform
 *     whatever σ_k, so M = K(N + 1)/2 and S² = K(N² − 1)/12 exactly; H by simulation.
 *   h2h (each category, one opponent a week, a round robin): a team's weekly total is its draft
 *     strength / W plus a week's luck, variance ν_k / W, as calc.js's G for H2H assumes; the record
 *     is its category wins (scaled to a full schedule when an odd league has byes). M = W·K/2, S and
 *     H by simulation.
 *   allplay: the same weeks, every team against every other.
 * payout "winner": H = the expected total of the first-placed team; "playoffs": of the team in the
 * last playoff place (the place-th best). Simulated with a fixed seed, so a setting repeats exactly.
 */
export function objective({ format = "roto", teams, weeks = 23, sigmaDraft, nu, payout = "winner", playoffTeams = 4, sims, seed = 20271013 }) {
  const N = teams, K = sigmaDraft.length, W = weeks;
  const place = payout === "playoffs" ? Math.min(N, Math.max(1, Math.round(playoffTeams))) : 1;
  const key = JSON.stringify([format, N, W, place, sims, seed, ...(format === "roto" ? [K] : [...sigmaDraft, ...nu])]);
  if (OBJECTIVES.has(key)) return OBJECTIVES.get(key);
  const z = normals(seed);
  const score = new Float64Array(N), sorted = new Float64Array(N);
  let sumH = 0, s1 = 0, s2 = 0, count = 0, M;
  const finish = () => {
    sorted.set(score);
    sorted.sort();
    sumH += sorted[N - place];
    for (let j = 0; j < N; j++) { s1 += score[j]; s2 += score[j] * score[j]; }
    count += N;
  };
  if (format === "roto") {
    sims = sims ?? 20000;
    const t = new Float64Array(N);
    for (let it = 0; it < sims; it++) {
      score.fill(0);
      for (let k = 0; k < K; k++) {
        for (let j = 0; j < N; j++) t[j] = z();
        for (let j = 0; j < N; j++) { let rank = 1; for (let i = 0; i < N; i++) if (t[i] < t[j]) rank++; score[j] += rank; }
      }
      finish();
    }
    M = (K * (N + 1)) / 2;
    const S = Math.sqrt((K * (N * N - 1)) / 12), H = sumH / sims;
    const out = { format, payout, place, N, K, W, M, S, H, z: (M - H) / S, sims, unit: "standings points", simS: Math.sqrt(s2 / count - (s1 / count) ** 2) };
    OBJECTIVES.set(key, out);
    return out;
  }
  const sd = sigmaDraft.map((v) => Math.sqrt(Math.max(0, v))), wk = nu.map((v) => Math.sqrt(Math.max(0, v) / W));
  const delta = new Float64Array(N * K), games = new Float64Array(N), X = new Float64Array(N);
  if (format === "allplay") {
    sims = sims ?? 800;
    for (let it = 0; it < sims; it++) {
      for (let j = 0; j < N * K; j++) delta[j] = sd[j % K] * z();
      score.fill(0);
      for (let w = 0; w < W; w++) {
        for (let k = 0; k < K; k++) {
          for (let j = 0; j < N; j++) X[j] = delta[j * K + k] / W + wk[k] * z();
          for (let j = 0; j < N; j++) { let won = 0; for (let i = 0; i < N; i++) if (X[i] < X[j]) won++; score[j] += won; }
        }
      }
      finish();
    }
    M = (W * K * (N - 1)) / 2;
  } else {
    sims = sims ?? 2000;
    const plan = roundRobin(N, W), pairWk = wk.map((v) => Math.SQRT2 * v);
    for (let it = 0; it < sims; it++) {
      for (let j = 0; j < N * K; j++) delta[j] = sd[j % K] * z();
      score.fill(0);
      games.fill(0);
      for (const pairs of plan) {
        for (const [a, b] of pairs) {
          games[a]++; games[b]++;
          for (let k = 0; k < K; k++) {
            if ((delta[a * K + k] - delta[b * K + k]) / W + pairWk[k] * z() > 0) score[a]++;
            else score[b]++;
          }
        }
      }
      for (let j = 0; j < N; j++) score[j] *= games[j] > 0 ? W / games[j] : 0;
      finish();
    }
    M = (W * K) / 2;
  }
  const S = Math.sqrt(s2 / count - (s1 / count) ** 2), H = sumH / sims;
  const out = { format, payout, place, N, K, W, M, S, H, z: (M - H) / S, sims, unit: "category wins", simS: S };
  OBJECTIVES.set(key, out);
  return out;
}

// ---- the risk-aware value ------------------------------------------------------------------------

/** P(Poisson(m) ≥ k) */
function poissonAtLeast(m, k) {
  if (k <= 0) return 1;
  let term = Math.exp(-m), below = term;
  for (let j = 1; j < k; j++) { term *= m / j; below += term; }
  return Math.max(0, 1 - below);
}

/**
 * The risk-aware value of every player with draws, priced in a finished calculator run. result:
 * calc.js auctionValues(H, P, { ...s, debug: true }); H, P: the tables it priced; s: its settings;
 * files: { h, p } from parseRiskFile; rs: the risk settings (DEFAULT_RISK: payout "winner" or
 * "playoffs", playoffTeams, transactions "daily" | "weekly" | "limited", ilSlots, month; model
 * "upgrade" | "fixes" | "draws" (RISK_MODELS) and its single settings infoK ({ h, p } or null for k = 1),
 * floorAt "replacement" | "valuation", teamVar; and the tables lambda, spread, premium to replace the
 * placeholders). Sets player.risk on result.players and returns the league's summary.
 */
export function applyRisk(C, result, H, P, s, files, rs = {}) {
  const t0 = Date.now();
  rs = { ...DEFAULT_RISK, ...rs };
  const model = RISK_MODELS[rs.model];
  if (!model) throw new Error(`unknown risk model "${rs.model}"`);
  const infoK = rs.infoK !== undefined ? rs.infoK : model.infoK;
  const floorAt = rs.floorAt ?? model.floorAt, teamVar = rs.teamVar ?? model.teamVar;
  if (floorAt !== "replacement" && floorAt !== "valuation") throw new Error(`unknown floor "${floorAt}"`);
  const month = Math.min(Math.max(0, Math.round(rs.month ?? 0)), MONTH_SHARE.length - 1), share0 = MONTH_SHARE[month];
  const dbg = result.debug;
  if (!dbg || !dbg.pricing) throw new Error("the calculator's workings are missing (run it with debug)");
  const points = s.style === "Points";
  const minBid = s.minBid, gamma = dbg.pricing.gamma, teams = s.teams;
  const txn = TRANSACTIONS[rs.transactions] || TRANSACTIONS.daily;
  const lag = txn.lagDays / SEASON_DAYS;
  const lambdaTable = rs.lambda || LAMBDA, spreadTable = rs.spread || SPREAD, premium = rs.premium || R_PREMIUM;
  const ctx = { N: teams, specialists: (s.specialists ?? true) && (s.format ?? "roto") === "roto" && !points };
  const tables = { h: H, p: P };
  const warnings = [];

  // a two-way player in a one-slot league: his hitter row holds hit·H + his pitching, and the
  // draws move only his hitting (his pitching stays at its projection)
  const oneSlot = new Map();
  for (const p of result.players) if (p.type === "h" && p.twoWay && p.twoWay.mode === "oneslot") oneSlot.set(p.mlbamid, p.twoWay);

  const sides = {};
  for (const side of ["h", "p"]) {
    const T = tables[side], d = dbg[side], pr = dbg.pricing[side], file = files[side];
    const rowById = new Map();
    T.data.MLBAMID.forEach((id, i) => { if (Number.isFinite(id) && !rowById.has(id)) rowById.set(id, i); });
    const rows = T.n, ce = Float64Array.from(d.sgpar), info = new Array(rows).fill(null);
    const calc$ = d.sgpar.map((x, i) => (Number.isFinite(x) ? dollarsOf(x, pr.slot[i] !== null, pr, gamma, minBid, true) : NaN));
    sides[side] = { T, d, pr, rowById, ce, info, calc$, matched: 0, players: file ? file.players : 0 };
    if (!file) continue;
    if (file.side !== side) throw new Error(`the ${side === "h" ? "hitters'" : "pitchers'"} risk file is for side "${file.side}"`);
    const N = file.draws;
    const rowOfPlayer = new Int32Array(file.players).fill(-1);
    for (let m = 0; m < file.players; m++) {
      const i = rowById.get(file.ids[m]);
      if (i !== undefined && Number.isFinite(d.sgpar[i])) rowOfPlayer[m] = i;
    }
    const cats = categoriesOf(s, side);
    let lines = drawLines(file);
    if (cats.some((c) => c.cat === "wOBA")) lines = withWoba(lines, file, T, rowOfPlayer);
    const missing = cats.filter(({ cat }) => !(cat in lines.data)).map((c) => c.cat);
    if (missing.length) { warnings.push(`The draws have no ${missing.join(", ")}: the ${side === "h" ? "hitters" : "pitchers"} keep their calculator values`); continue; }
    const specs = cats.map(({ cat, pts }) => C.categorySpec(lines, side, cat, pts));
    const rowOf = new Int32Array(lines.n).fill(-1);
    for (let m = 0; m < file.players; m++) if (rowOfPlayer[m] >= 0) for (let n = 0; n < N; n++) rowOf[m * N + n] = rowOfPlayer[m];
    const roles = C.rolesOf(T, side);
    const V = lineValues(C, d, side, specs, lines, rowOf, { ...ctx, roles });

    const pt = file.stats[side === "h" ? "PA" : "IP"], sv = file.stats.SV, gs = file.stats.GS;
    const lam = lambdaTable[side];
    const k = infoK && Number.isFinite(infoK[side]) ? infoK[side] : 1;
    const Vp = new Float64Array(N), lamN = new Float64Array(N), missed = new Float64Array(N);
    const rN = floorAt === "replacement" ? new Float64Array(N) : null;
    for (let m = 0; m < file.players; m++) {
      const i = rowOfPlayer[m];
      if (i < 0) continue;
      sides[side].matched++;
      const at = m * N, mu = d.sgpar[i];
      for (let n = 0; n < N; n++) Vp[n] = V[at + n];
      const tw = side === "h" ? oneSlot.get(T.data.MLBAMID[i]) : null;
      if (tw) {
        const own = d.sgpar[i] - (d.twAdj ? d.twAdj[i] : 0);   // his hitting before the two-way value
        for (let n = 0; n < N; n++) Vp[n] = tw.hit * Vp[n] + (mu - tw.hit * own);
      }
      // the spread factor by role and $ tier
      const tier = calc$[i] < SPREAD_CUTS[0] ? 0 : calc$[i] < SPREAD_CUTS[1] ? 1 : calc$[i] < SPREAD_CUTS[2] ? 2 : calc$[i] < SPREAD_CUTS[3] ? 3 : 4;
      const f = (spreadTable[roles[i]] || [])[tier] ?? 1;
      const med = median(Vp);
      if (f !== 1) for (let n = 0; n < N; n++) Vp[n] = med + f * (Vp[n] - med);
      // each draw's cause, from its playing time against his full season: his draws' 75th
      // percentile (on the 2027 test files about 1.04 × the healthy-basis PA and IP, both sides)
      const ptSorted = Float64Array.from(pt.subarray(at, at + N)).sort();
      const full = quantileSorted(ptSorted, 0.75);
      let svMed = 0, gsMed = 0;
      if (side === "p" && sv && gs) { svMed = median(sv.subarray(at, at + N)); gsMed = median(gs.subarray(at, at + N)); }
      let ext = 0;
      for (let n = 0; n < N; n++) {
        missed[n] = full > 0 ? Math.max(0, 1 - pt[at + n] / full) : 0;
        const time = missed[n] >= IL_RULE.extended;
        const role = !time && side === "p" && sv && gs && ((svMed >= 5 && sv[at + n] < 0.5 * svMed) || (gsMed >= 10 && gs[at + n] < 0.5 * gsMed));
        lamN[n] = Math.min(1, (time ? lam.time : role ? lam.role : lam.skill) + lag);
        if (time) ext += missed[n];
      }
      ext /= N;
      // the floor: r_pos at the month of the valuation, or at the replacement (each draw's λ of the
      // season left after that month; a draw's λ takes one of a few values, so they are cached)
      const slot = d.byPos.valuedAt[i];
      let r;
      if (rN) {
        const at = new Map();
        r = 0;
        for (let n = 0; n < N; n++) {
          let v = at.get(lamN[n]);
          if (v === undefined) { v = rPosAt(slot, teams, share0 + lamN[n] * (1 - share0), premium) * txn.rScale; at.set(lamN[n], v); }
          rN[n] = v;
          r += v;
        }
        r /= N;
      } else r = rPos(slot, teams, rs.month, premium) * txn.rScale;
      // the option over the draws, on what the team knows at λ: m = mean + k (V − mean)
      const mo = drawMoments(Vp, r);
      const Vm = k === 1 ? Vp : Vp.map((x) => mo.mean + k * (x - mo.mean));
      const mi = k === 1 && !rN ? mo : drawMoments(Vm, rN || r);
      let opt = 0, keep = 0, below = 0;
      for (let n = 0; n < N; n++) {
        const rn = rN ? rN[n] : r;
        opt += (1 - lamN[n]) * (Math.max(Vm[n], rn) - Vm[n]);
        if (Vm[n] >= rn) keep++;
        else below++;
      }
      opt /= N;
      const delta = mi.option - mi.mean;
      // one λ for the variance: the draws' λ weighted by how far each is below the floor
      const lambda = delta > 1e-12 ? 1 - opt / delta : Math.min(1, lam.skill + lag);
      // the kept draws keep the part of the season's variance m does not see, (1 − k²) Var[V]
      const unseen = k === 1 ? 0 : (1 - k * k) * mo.var * (keep / N);
      info[i] = {
        mu, mean: mo.mean, median: med, sd: Math.sqrt(mo.var), optSd: Math.sqrt(mi.optVar), f, r, k, below: below / N, lambda, delta, option: opt, ext,
        varEff: (lambda * Math.sqrt(mo.var)) ** 2 + (1 - lambda) ** 2 * (mi.optVar + unseen), tier, role: roles[i], draws: N,
      };
    }
  }

  // L3, the injured list: the chance a team's IL slots are all taken when a player is hurt, from
  // the extended injury time of a typical team's drafted players (Poisson). A player who can't go
  // on the IL then holds a roster spot for his extended injury time: one bench slot's value, here
  // the min bid (what the auction pays for a roster spot), for that share of the season
  let load = 0;
  for (const side of ["h", "p"]) {
    const { info, pr } = sides[side];
    info.forEach((x, i) => { if (x && pr.slot[i] !== null) load += x.ext; });
  }
  load /= teams;
  const ilSlots = Math.max(0, Math.round(rs.ilSlots ?? 0));
  const pFull = poissonAtLeast(load, ilSlots);
  const bench$ = minBid > 0 ? minBid : 1;

  // the CE term's variance in standings points (roto): calc.js's G (points per unit) comes from its
  // luck model ν; the draws give each side more luck per team (L_draws: the drafted players' draw
  // variance a team), and under it a unit buys fewer points: G' = c·G, c² = (D + L_calc) / (D +
  // L_draws), D = Σ G²σ²_draft, L_calc = Σ G²ν. μ's scale does not matter (each side's dollars are
  // fixed) and the option scales with μ, so only the CE term's variance takes c²
  const teamC2 = { h: 1, p: 1 };
  if (teamVar && !points && (s.format ?? "roto") === "roto") {
    for (const side of ["h", "p"]) {
      const { info, pr, d } = sides[side];
      let Ld = 0, D = 0, Lc = 0;
      info.forEach((x, i) => { if (x && pr.slot[i] !== null) Ld += x.sd ** 2; });
      Ld /= teams;
      d.G.forEach((g, k) => { D += g * g * d.sigmaDraft[k]; Lc += g * g * d.nu[k]; });
      if (Ld > 0 && D + Lc > 0) teamC2[side] = (D + Lc) / (D + Ld);
    }
  }

  // O1-O3: an average team before the draft
  let obj = null;
  if (!points) {
    obj = objective({
      format: s.format ?? "roto", teams, weeks: s.weeks ?? 23, payout: rs.payout, playoffTeams: rs.playoffTeams,
      sigmaDraft: [...dbg.h.sigmaDraft, ...dbg.p.sigmaDraft], nu: [...dbg.h.nu, ...dbg.p.nu],
    });
  }

  // CE, then each side's risk-aware $: CE priced as calc.js prices its values (drafted players
  // chosen by CE over the same slots and bench, the same dollars, split and curve)
  for (const side of ["h", "p"]) {
    const S_ = sides[side], { pr, info, ce } = S_;
    const perSGP = result.perSGP[side];
    info.forEach((x, i) => {
      if (!x) return;
      x.il = pFull * x.ext * (perSGP > 0 ? bench$ / perSGP : 0);
      x.eff = x.mu + x.option - x.il;
      x.exact = false;
      x.teamC2 = teamC2[side];
      x.varCE = x.varEff * teamC2[side];   // the variance the CE term prices (standings points²)
      if (obj) {
        if (Math.sqrt(x.varCE) > 0.4 * obj.S) { x.ce = exactCertainty(x.eff, x.varCE, obj.M, obj.S, obj.H); x.exact = true; }
        else x.ce = certaintyEquivalent(x.eff, x.varCE, obj.M, obj.S, obj.H);
      } else x.ce = x.eff;
      x.payout = x.ce - x.eff;
      ce[i] = x.ce;
    });
    const priced = priceValues(C, dbg.pricing, side, ce, minBid);
    Object.assign(S_, priced);
    info.forEach((x, i) => {
      if (!x) return;
      x.value = S_.value[i];
      x.bid = dollarsOf(x.ce, pr.slot[i] !== null, pr, gamma, minBid, false);   // CE at the calculator's own prices
      x.calc = S_.calc$[i];
    });
  }

  // onto the players (a simultaneous two-way row is his hitting and pitching added, as calc.js adds them)
  for (const p of result.players) {
    const S_ = sides[p.type], i = S_.rowById.get(p.mlbamid);
    if (i === undefined) { p.risk = null; continue; }
    const x = S_.info[i];
    let value = S_.value[i], drafted = S_.slot[i] !== null;
    const j = p.twoWay && p.twoWay.mode === "simultaneous" ? sides.p.rowById.get(p.mlbamid) : undefined;
    if (j !== undefined && sides.p.slot[j] !== null) {
      value = (drafted ? value : 0) + sides.p.value[j];
      drafted = true;
    }
    p.risk = { ...(x || { mu: S_.d.sgpar[i], ce: S_.ce[i], draws: 0 }), value, drafted };
  }
  return {
    objective: obj, il: { slots: ilSlots, load, pFull, bench$ }, transactions: { ...txn, key: rs.transactions, lag },
    model: { key: rs.model, label: model.label, infoK, floorAt, teamVar, teamC2 },
    sides: { h: { matched: sides.h.matched, players: sides.h.players, pricing: sides.h.pricing }, p: { matched: sides.p.matched, players: sides.p.players, pricing: sides.p.pricing } },
    settings: rs, warnings, ms: Date.now() - t0,
  };
}
