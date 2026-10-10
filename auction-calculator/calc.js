// The auction model. It reads projections as plv_viz auction_calc.py does and starts from
// its z-scores, then values players by standings gain (generalized SGP), by lineup slot, and
// prices exactly the players on legal rosters. No DOM here, so Node runs it too (README.md).
//
// A table is column-oriented: { columns: [...], n, data: { col: [values] } },
// numbers as numbers (NaN when missing) and text as strings (null when missing).

export const TEAM_LEAGUES = {
  LAA: "AL", NYY: "AL", SDP: "NL", CLE: "AL", LAD: "NL", TOR: "AL", ATL: "NL", HOU: "AL",
  NYM: "NL", PHI: "NL", STL: "NL", SEA: "AL", BOS: "AL", TEX: "AL", KCR: "AL", PIT: "NL",
  TBR: "AL", CHC: "NL", MIL: "NL", BAL: "AL", ARI: "NL", MIN: "AL", MIA: "NL", COL: "NL",
  CHW: "AL", DET: "AL", SFG: "NL", CIN: "NL", ATH: "AL", OAK: "AL", WAS: "NL", WSN: "NL",
  // the other spellings an uploaded file might use
  SD: "NL", KC: "AL", TB: "AL", SF: "NL", WSH: "NL", CWS: "AL", AZ: "NL",
};
const FA_TEAMS = new Set(["", "FA", "- - -", "---"]);
const TEXT_COLS = new Set(["Name", "Team", "Y! Pos"]);

// What pandas' read_csv reads as missing
const NA = new Set(["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND",
  "1.#QNAN", "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null"]);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export const HITTER_CATS = ["G", "AB", "PA", "R", "HR", "RBI", "SB", "AVG", "OBP", "ISO", "SLG", "OPS",
  "wOBA", "BB%", "K%", "H", "1B", "2B", "3B", "XBH", "TB", "K", "BB", "HBP", "SF", "CS"];
export const PITCHER_CATS = ["IP", "TBF", "G", "GS", "W", "L", "QS", "SV", "HD", "SV+H", "K", "ERA",
  "WHIP", "K%", "BB%", "K-BB%", "K/9", "BB/9", "HR/9", "H", "ER", "HBP", "HR", "BB", "BS", "K/BB", "W+QS"];
export const HITTER_POINT_CATS = ["G", "AB", "PA", "R", "HR", "RBI", "SB", "H", "1B", "2B", "3B", "K", "BB",
  "HBP", "SF", "CS"];
export const PITCHER_POINT_CATS = ["IP", "TBF", "G", "GS", "W", "L", "QS", "SV", "HD", "K", "H", "ER", "HBP",
  "HR", "BB", "BS"];
export const DEFAULT_HITTER_CATS = ["R", "HR", "RBI", "SB", "AVG"];
export const DEFAULT_PITCHER_CATS = ["W", "SV", "K", "ERA", "WHIP"];
export const DEFAULT_HITTER_POINTS = [["AB", -1.0], ["H", 5.6], ["2B", 2.9], ["3B", 5.7], ["HR", 9.4],
  ["BB", 3.0], ["HBP", 3.0], ["SB", 1.9], ["CS", -2.8]];
export const DEFAULT_PITCHER_POINTS = [["IP", 7.4], ["K", 2.0], ["H", -2.6], ["BB", -3.0], ["HBP", -3.0],
  ["HR", -12.3], ["SV", 5.0], ["HD", 4.0]];

// Rate categories are weighted by playing time; inverted ones score fewer as better
const RATE_H = new Set(["AVG", "OBP", "ISO", "SLG", "OPS", "wOBA", "BB%", "K%"]);
const RATE_P = new Set(["ERA", "WHIP", "K%", "BB%", "K-BB%", "K/9", "BB/9", "HR/9"]);
const INVERT_H = new Set(["K", "CS", "SF", "K%"]);
const INVERT_P = new Set(["BB", "H", "ER", "BS", "ERA", "WHIP", "L", "HBP", "HR", "BB/9", "HR/9", "BB%"]);

// ---- reading ----------------------------------------------------------------

/** RFC 4180 CSV to rows of strings. */
function csvRows(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", quoted = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** A projections CSV as a table, cleaned the way the script's clean_projections does. */
export function readProjections(text) {
  const rows = csvRows(text);
  if (!rows.length) throw new Error("the file is empty");
  const seen = {};
  const columns = rows[0].map((c) => {
    const name = seen[c] === undefined ? c : `${c}.${seen[c]}`;
    seen[c] = (seen[c] || 0) + 1;
    return name;
  });
  const n = rows.length - 1;
  const data = {};
  columns.forEach((col, j) => {
    const raw = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = rows[i + 1][j];
      raw[i] = v === undefined || NA.has(v) ? null : v;
    }
    data[col] = TEXT_COLS.has(col) ? raw : numericOrText(raw);
  });
  for (const col of ["MLBAMID", "Team"]) {
    if (!(col in data)) { columns.push(col); data[col] = new Array(n).fill(col === "Team" ? null : NaN); }
  }
  return { columns, n, data };
}

// '13.6%' and '1,031' are numbers too, as long as every value in the column is one
function numericOrText(raw) {
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === null) { out[i] = NaN; continue; }
    const t = raw[i].trim().replace(/%+$/, "").replaceAll(",", "");
    if (!NUMBER.test(t)) return raw;
    out[i] = Number(t);
  }
  return out;
}

export const isNumeric = (table, col) => col in table.data && (table.n === 0 || typeof firstPresent(table.data[col]) === "number");
const firstPresent = (arr) => { for (const v of arr) if (v !== null) return v; return 0; };

/** Only offer stats the projections have, as numbers */
export const availableStats = (options, table) => options.filter((c) => isNumeric(table, c));

function take(table, keep) {
  const data = {};
  for (const col of table.columns) data[col] = keep.map((i) => table.data[col][i]);
  return { columns: table.columns.slice(), n: keep.length, data };
}

function addColumn(table, col, values) {
  if (!(col in table.data)) table.columns.push(col);
  table.data[col] = values;
}

/**
 * The player pool. pool is "All", "NL-Only" or "AL-Only". With no Team column there's
 * nothing to filter on, and the projections pass through whole.
 */
export function filterLeague(table, pool, includeFa) {
  const teams = table.data.Team;
  if (teams.every((t) => t === null)) return table;
  const keep = [];
  for (let i = 0; i < table.n; i++) {
    const team = (teams[i] ?? "").trim().toUpperCase();
    if (FA_TEAMS.has(team)) { if (includeFa) keep.push(i); continue; }
    if (pool === "All" || TEAM_LEAGUES[team] === pool.slice(0, 2)) keep.push(i);
  }
  return take(table, keep);
}

export function prepHitters(table, pool, includeFa) {
  const t = filterLeague(table, pool, includeFa);
  const pos = t.data["Y! Pos"] || new Array(t.n).fill(null);
  addColumn(t, "Y! Pos", pos.map((p) => p ?? "UT"));
  return t;
}

export function prepPitchers(table, pool, includeFa) {
  const t = filterLeague(table, pool, includeFa);
  const d = t.data;
  if (isNumeric(t, "W") && isNumeric(t, "QS")) addColumn(t, "W+QS", d.W.map((w, i) => w + d.QS[i]));
  if (isNumeric(t, "K") && isNumeric(t, "BB")) {
    addColumn(t, "K/BB", d.K.map((k, i) => rint(k / Math.min(Math.max(d.BB[i], 0.1), 1000) * 100) / 100));
  }
  return t;
}

/** What a hitters/pitchers pair is missing to be priced at all */
export function missingColumns(hitters, pitchers) {
  const missing = [];
  for (const [pos, t, pt] of [["hitters", hitters, "PA"], ["pitchers", pitchers, "IP"]]) {
    if (!("Name" in t.data)) missing.push(`Name (${pos})`);
    if (!isNumeric(t, pt)) missing.push(`${pt} (${pos})`);
  }
  return missing;
}

// ---- pandas, the parts the model uses ----------------------------------------

function mean(arr) {
  let s = 0, k = 0;
  for (const v of arr) if (!Number.isNaN(v)) { s += v; k++; }
  return k ? s / k : NaN;
}
function std(arr) {   // ddof = 1
  const m = mean(arr);
  let s = 0, k = 0;
  for (const v of arr) if (!Number.isNaN(v)) { s += (v - m) ** 2; k++; }
  return k > 1 ? Math.sqrt(s / (k - 1)) : NaN;
}
/** Indexes of the n largest values, NaN skipped, ties to the earlier row (nlargest, keep='first') */
function nlargestIdx(arr, n) {
  const idx = [];
  for (let i = 0; i < arr.length; i++) if (!Number.isNaN(arr[i])) idx.push(i);
  idx.sort((a, b) => arr[b] - arr[a] || a - b);
  return idx.slice(0, Math.max(0, n));
}
const nlargestMin = (arr, n) => {
  const idx = nlargestIdx(arr, n);
  return idx.length ? arr[idx[idx.length - 1]] : NaN;
};
/** Python's round() and numpy's rint(): halves to even */
function rint(x) {
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
}

// ---- value -------------------------------------------------------------------

function volumeZ(pop, sample) {
  const m = mean(sample), s = std(sample);
  return pop.map((v) => (v - m) / s);
}

// A rate stat regressed toward the league by a team's worth of league-average playing
// time, so a rate over little playing time moves a team's category less
function rateZ(rate, pt, sampleIdx, nPlayers) {
  const sRate = sampleIdx.map((i) => rate[i]), sPt = sampleIdx.map((i) => pt[i]);
  const leaguePt = mean(sPt);
  const leagueVol = mean(sRate) * leaguePt;
  const k = nPlayers - 1;
  const blend = (r, p) => (r * p + k * leagueVol) / (p + k * leaguePt);
  const sampleVal = sRate.map((r, j) => blend(r, sPt[j]));
  const m = mean(sampleVal), s = std(sampleVal);
  return rate.map((r, i) => (blend(r, pt[i]) - m) / s);
}

// Both scores return the total and each category's part of it (NaN counted as nothing)
function zValue(table, cats, rateSet, invertSet, sampleIdx, nPlayers, ptCol) {
  const total = new Array(table.n).fill(0);
  const parts = new Map();
  for (const cat of cats) {
    const col = table.data[cat];
    const z = rateSet.has(cat)
      ? rateZ(col, table.data[ptCol], sampleIdx, nPlayers)
      : volumeZ(col, sampleIdx.map((i) => col[i]));
    const sign = invertSet.has(cat) ? -1 : 1;
    const part = z.map((v) => (Number.isNaN(v) ? 0 : sign * v));
    for (let i = 0; i < table.n; i++) total[i] += part[i];
    parts.set(cat, part);
  }
  return { total, parts };
}

function pointsValue(table, points) {
  const total = new Array(table.n).fill(0);
  const parts = new Map();
  for (const [cat, pts] of points) {
    const part = table.data[cat].map((v) => (Number.isNaN(v) ? 0 : v * pts));
    for (let i = 0; i < table.n; i++) total[i] += part[i];
    parts.set(cat, part);
  }
  return { total, parts };
}

// ---- position replacement -----------------------------------------------------

// A slot takes anyone eligible at one of its positions; UT and P (and the bench) take anyone
export const SLOT_TYPES = {
  C: ["C"], "1B": ["1B"], "2B": ["2B"], "3B": ["3B"], SS: ["SS"],
  CI: ["1B", "3B"], MI: ["2B", "SS"], OF: ["OF", "LF", "CF", "RF"], UT: null,
};
export const PITCHER_SLOT_TYPES = { SP: ["SP"], RP: ["RP"], P: null };

/**
 * Replacement level by position, from the league's best lineups rather than a fixed
 * hierarchy. Every team's slots are filled to the most total value: hitters in order of
 * value, each placed if a chain of moves among the starters already placed opens a slot
 * it can take. (Which sets of hitters fit the slots is a transversal matroid, so this
 * greedy fill is the best one.) A slot type's replacement level is then what the league
 * loses with one fewer of those slots: the worst starter it can shift to, through
 * starters eligible elsewhere. So a position whose surplus spills into UT is exactly as
 * deep as UT, and one whose starters can't move anywhere sits on its own last starter.
 * A hitter is priced against the cheapest replacement among the slots he fits.
 *
 * Pitchers work the same way over SP, RP and P slots.
 *
 * One player at the margin makes a noisy level, so with a span the level is the average
 * over the slots around it instead: what the league gains per player going from `span`
 * fewer of those slots to `span` more. Chains and all, that's the average of the last
 * `span` starters it could lose and the first `span` non-starters it could add. A span
 * of 0 is the single last starter.
 *
 * caps: { slotType: number of slots in the league }; types: SLOT_TYPES or
 * PITCHER_SLOT_TYPES; vecs (optional): per-category contributions [category][player] that
 * raw is a weighted sum of, to get each level's replacement player by category too.
 * Returns per-player replacement (NaN for one no slot takes), the slot each starter fills,
 * and the levels (with vec, the replacement's contribution in each category).
 */
export function positionReplacement(raw, posStrings, caps, types_ = SLOT_TYPES, span = 0, vecs = null) {
  const types = Object.keys(caps).filter((t) => caps[t] > 0);
  const tokens = posStrings.map((p) => p.split(/[,/ ]+/).map((x) => x.trim().toUpperCase()));
  const fits = tokens.map((tok) => types.map((t) => types_[t] === null || types_[t].some((x) => tok.includes(x))));
  const order = [];
  for (let i = 0; i < raw.length; i++) if (!Number.isNaN(raw[i])) order.push(i);
  order.sort((a, b) => raw[b] - raw[a] || a - b);

  // The best fill of `cap` slots (by type index): who starts where, their total value, how many.
  // movable[k][m] counts the starters at slot type k who also fit type m, so the search for a
  // chain of moves to an open slot only walks the slot types.
  const T = types.length;
  function fill(cap) {
    const at = types.map(() => []);
    const movable = types.map(() => new Int32Array(T));
    const place = (k, j) => { at[k].push(j); for (let m = 0; m < T; m++) if (fits[j][m]) movable[k][m]++; };
    const lift = (k, j) => {
      const list = at[k], ix = list.indexOf(j);
      list[ix] = list[list.length - 1];
      list.pop();
      for (let m = 0; m < T; m++) if (fits[j][m]) movable[k][m]--;
    };
    const total = cap.reduce((a, c) => a + c, 0);
    const prev = new Int8Array(T), queue = new Int8Array(T);
    let filled = 0, value = 0;
    for (const i of order) {
      if (filled === total) break;
      // breadth-first over slot types: an open slot, or starters moving along to one
      prev.fill(-2);
      let head = 0, tail = 0, end = -1;
      for (let k = 0; k < T; k++) if (fits[i][k]) { prev[k] = -1; queue[tail++] = k; }
      while (head < tail) {
        const k = queue[head++];
        if (at[k].length < cap[k]) { end = k; break; }
        for (let m = 0; m < T; m++) if (prev[m] === -2 && movable[k][m] > 0) { prev[m] = k; queue[tail++] = m; }
      }
      if (end < 0) continue;
      let k = end;
      while (prev[k] !== -1) {
        const from = prev[k];
        const j = at[from].find((q) => fits[q][k]);
        lift(from, j);
        place(k, j);
        k = from;
      }
      place(k, i);
      filled++;
      value += raw[i];
    }
    return { at, filled, value };
  }
  const caps0 = types.map((t) => caps[t]);
  const { at } = fill(caps0);

  // A slot type left short (too few eligible hitters) is as deep as its worst eligible hitter
  const worstAt = types.map((_, k) => {
    if (at[k].length === caps[types[k]]) return at[k].reduce((w, j) => (raw[j] < raw[w] ? j : w), at[k][0]);
    const eligible = order.filter((j) => fits[j][k]);
    return eligible.length ? eligible[eligible.length - 1] : -1;
  });
  // The last starter it can reach: the value of the one slot at the margin
  const lastAt = types.map((_, k) => {
    const seen = new Set([k]), stack = [k];
    while (stack.length) {
      const from = stack.pop();
      for (const j of at[from]) {
        types.forEach((_, m) => { if (!seen.has(m) && fits[j][m]) { seen.add(m); stack.push(m); } });
      }
    }
    let last = -1;
    for (const m of seen) { const j = worstAt[m]; if (j >= 0 && (last < 0 || raw[j] < raw[last])) last = j; }
    return last;
  });
  const lastStarter = lastAt.map((j) => (j < 0 ? NaN : raw[j]));
  const vecOf = (j) => (vecs ? vecs.map((x) => (j < 0 ? NaN : x[j])) : null);
  // Over a span, the average value of the slots around the margin: refill with `span` fewer
  // and `span` more of that slot type, and divide the difference by the players it moves
  // (the last starters it could lose and the first non-starters it could add)
  const marginal = types.map((_, k) => {
    if (span <= 0) return { level: lastStarter[k], vec: vecOf(lastAt[k]) };
    const lo = fill(caps0.map((c, m) => (m === k ? c - Math.min(span, c) : c)));
    const hi = fill(caps0.map((c, m) => (m === k ? c + span : c)));
    const moved = hi.filled - lo.filled;
    if (moved <= 0) return { level: lastStarter[k], vec: vecOf(lastAt[k]) };
    let vec = null;
    if (vecs) {
      const weight = new Int8Array(raw.length);
      hi.at.forEach((list) => list.forEach((j) => { weight[j] += 1; }));
      lo.at.forEach((list) => list.forEach((j) => { weight[j] -= 1; }));
      vec = vecs.map((x) => { let v = 0; weight.forEach((w, j) => { if (w) v += w * x[j]; }); return v / moved; });
    }
    return { level: (hi.value - lo.value) / moved, vec };
  });
  const level = marginal.map((m) => m.level);

  const slot = new Array(raw.length).fill(null);
  at.forEach((list, k) => list.forEach((j) => { slot[j] = types[k]; }));
  const repl = new Array(raw.length);
  const valuedAt = new Array(raw.length).fill(null);
  for (let i = 0; i < raw.length; i++) {
    let best = Infinity;
    types.forEach((t, k) => { if (fits[i][k] && level[k] < best) { best = level[k]; valuedAt[i] = t; } });
    repl[i] = best === Infinity ? NaN : best;
  }
  return {
    repl, slot, valuedAt,
    levels: types.map((t, k) => ({ slot: t, slots: caps[t], level: level[k], worst: lastStarter[k], vec: marginal[k].vec })),
  };
}

/**
 * The slots one side fills. perTeam: { slotType: slots per team }; without position info in
 * the projections every slot takes anyone (anyType: UT, P), as the script's one pool does.
 */
function sideCaps(posStrings, perTeam, types, anyType, teams) {
  const named = new Set(Object.values(types).flatMap((x) => x || []));
  const known = posStrings.some((p) => p.split(/[,/ ]+/).some((x) => named.has(x.trim().toUpperCase())));
  const caps = {};
  for (const [t, n] of Object.entries(perTeam)) {
    const type = known ? t : anyType;
    caps[type] = (caps[type] || 0) + teams * n;
  }
  return caps;
}
const withAny = (caps, anyType, extra) => ({ ...caps, [anyType]: (caps[anyType] || 0) + extra });
const tokensOf = (p) => (p ?? "").split(/[,/ ]+/).map((x) => x.trim().toUpperCase());

// ---- standings-gain values: the generalized SGP procedure -------------------------
//
// A category's weight is the standings points one more unit of it buys a team, from how
// spread out team totals are: G_k = C / (2√π · √(σ²_draft,k + P·ν_k)), with C comparisons
// per season and P scoring periods (roto: N − 1 and 1). σ²_draft,k is what the draft
// spreads team totals by (tiers of N in draft order), ν_k what a season's luck adds.
// Values are then Σ G_k × (category contribution − its replacement), iterated with the
// drafted pool until the pool and the weights settle.

const Z90 = 1.2815515655446004;   // a standard normal's 90th percentile
const SQRT_PI = Math.sqrt(Math.PI);

/** The standard normal CDF (Abramowitz & Stegun 7.1.26 for erf, error under 1.5e-7) */
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const at = (v.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return v[lo] + (v[hi] - v[lo]) * (at - lo);
}

/** A column's spread from its 10th and 90th percentiles (cat_p10, cat_p90), as an SD */
function percentileSd(T, col) {
  const lo = T.data[col + "_p10"], hi = T.data[col + "_p90"];
  if (!lo || !hi || !isNumeric(T, col + "_p10") || !isNumeric(T, col + "_p90")) return null;
  return lo.map((v, i) => (Number.isNaN(v) || Number.isNaN(hi[i]) ? NaN : (hi[i] - v) / (2 * Z90)));
}

// Rate stats as numerator / denominator, so each player's rate becomes the count he adds
// above the drafted pool's rate: xH = H − r·AB, xER = r·IP/9 − ER, xWHIP = r·IP − (BB+H).
// From the components when the file has them, otherwise rate × denominator. unit names
// what one SGP denominator counts; prop marks a proportion (binomial count noise).
const RATE_SPECS = {
  h: {
    AVG: { num: ["H"], den: ["AB"], unit: "H", prop: true },
    OBP: { num: ["H", "BB", "HBP"], den: ["AB", "BB", "HBP", "SF"], unit: "times on base", prop: true },
    SLG: { num: ["TB"], den: ["AB"], unit: "TB" },
    ISO: { num: ["TB", "-H"], den: ["AB"], unit: "extra bases" },
    OPS: { den: ["PA"], unit: "PA × OPS" },
    wOBA: { den: ["PA"], unit: "PA × wOBA" },
    "BB%": { num: ["BB"], den: ["PA"], unit: "BB", prop: true },
    "K%": { num: ["K"], den: ["PA"], unit: "K", prop: true },
  },
  p: {
    ERA: { num: ["ER"], den: ["IP/9"], unit: "ER" },
    WHIP: { num: ["BB", "H"], den: ["IP"], unit: "BB+H" },
    "K/9": { num: ["K"], den: ["IP/9"], unit: "K" },
    "BB/9": { num: ["BB"], den: ["IP/9"], unit: "BB" },
    "HR/9": { num: ["HR"], den: ["IP/9"], unit: "HR" },
    "K%": { num: ["K"], den: ["TBF"], unit: "K", prop: true },
    "BB%": { num: ["BB"], den: ["TBF"], unit: "BB", prop: true },
    "K-BB%": { num: ["K", "-BB"], den: ["TBF"], unit: "K − BB" },
    "K/BB": { num: ["K"], den: ["BB"], unit: "K" },
  },
};

/** Columns added up (a leading "-" subtracts; "IP/9" is innings over 9), or null if one is missing */
function sumCols(T, terms) {
  const out = new Array(T.n).fill(0);
  for (const term of terms) {
    const neg = term.startsWith("-"), name = neg ? term.slice(1) : term;
    const col = name === "IP/9" ? "IP" : name;
    if (!isNumeric(T, col)) return null;
    T.data[col].forEach((v, i) => {
      const x = Number.isNaN(v) ? 0 : name === "IP/9" ? v / 9 : v;
      out[i] += neg ? -x : x;
    });
  }
  return out;
}

/** How one category turns a player's projection into the count he adds to a team */
function categorySpec(T, side, cat, points) {
  const sd = percentileSd(T, cat);
  const nums = (col) => T.data[col].map((v) => (Number.isNaN(v) ? 0 : v));
  if (points !== undefined) {
    return { cat, kind: "count", sign: 1, raw: nums(cat).map((v) => v * points), unit: "points", sd: null };
  }
  const sign = (side === "h" ? INVERT_H : INVERT_P).has(cat) ? -1 : 1;
  const spec = RATE_SPECS[side][cat];
  if (!spec) return { cat, kind: "count", sign, raw: nums(cat), unit: cat, sd };
  const den = sumCols(T, spec.den)
    || sumCols(T, [side === "h" ? (isNumeric(T, "AB") && spec.den[0] === "AB" ? "AB" : "PA") : spec.den[0] === "IP/9" ? "IP/9" : "IP"]);
  const num = (spec.num && sumCols(T, spec.num)) || T.data[cat].map((r, i) => (Number.isNaN(r) ? 0 : r * den[i]));
  return { cat, kind: "rate", sign, num, den, unit: spec.unit, prop: !!spec.prop, sd };
}

/** Each player's role, for filling his missing playing time: C or H; SP or RP (or P) */
function rolesOf(T, side) {
  if (side === "h") return T.data["Y! Pos"].map((p) => (tokensOf(p).includes("C") ? "C" : "H"));
  const pos = T.data["Y! Pos"], gs = isNumeric(T, "GS") ? T.data.GS : null, g = isNumeric(T, "G") ? T.data.G : null;
  return T.data.IP.map((_, i) => {
    if (gs && g && g[i] > 0 && !Number.isNaN(gs[i])) return gs[i] >= 0.5 * g[i] ? "SP" : "RP";
    const t = pos ? tokensOf(pos[i]) : [];
    return t.includes("SP") ? "SP" : t.includes("RP") ? "RP" : "P";
  });
}

/**
 * Value one side (hitters or pitchers). c: { T, side, N, pos, caps, types, span, start,
 * specs, points, format, weeks, phi, ptCV, fillPT, specialists }. Returns the side's SGP
 * weights and every player's SGP, SGP above replacement and what goes into it.
 *
 * Playing time: what each player doesn't play is filled with replacement production for his
 * role, then replacement levels are found again with everyone filled. That production is
 * set once, from the side valued without any fill: the per-PA (per-IP) output of the players
 * a tier (N) either side of each role's cutoff, ranked by their own projections, i.e. what
 * the waiver wire has. A full season is the role's 90th percentile among drafted players.
 * (Set from the filled values instead, the cutoff fills with part-timers whose rates no
 * free agent supplies over a season, and the pool and the fill chase each other.)
 */
function valueSide(c) {
  if (!c.fillPT) return valueSideWith(c, null);
  // (the bare run only has to settle the pool and each player's own value: no span refills)
  const bare = valueSideWith({ ...c, span: 0, specialists: false }, null);
  const roles = rolesOf(c.T, c.side);
  const vol = c.T.data[c.side === "h" ? "PA" : "IP"].map((v) => (Number.isNaN(v) ? 0 : v));
  const pool = [];
  bare.byPos.slot.forEach((t, i) => { if (t !== null) pool.push(i); });
  const sideTarget = quantile(pool.map((i) => vol[i]), 0.9);
  const fillSpec = {};
  for (const role of new Set(roles)) {
    const drafted = pool.filter((i) => roles[i] === role);
    const ranked = [];
    for (let i = 0; i < c.T.n; i++) if (roles[i] === role && vol[i] > 0 && Number.isFinite(bare.ownScore[i])) ranked.push(i);
    ranked.sort((a, b) => bare.ownScore[b] - bare.ownScore[a]);
    const cut = Math.min(drafted.length, ranked.length);
    const repl = ranked.slice(Math.max(0, cut - c.N), cut + c.N);
    const v = repl.reduce((a, i) => a + vol[i], 0);
    const per = (arr) => (v > 0 ? repl.reduce((a, i) => a + arr[i], 0) / v : 0);
    fillSpec[role] = {
      target: drafted.length >= 5 ? quantile(drafted.map((i) => vol[i]), 0.9) : sideTarget,
      // per unit of playing time: counts, or a rate stat's numerator and denominator
      perUnit: c.specs.map((sp) => (sp.kind === "count" ? { count: per(sp.raw) } : { num: per(sp.num), den: per(sp.den) })),
    };
  }
  return valueSideWith(c, fillSpec);
}

function valueSideWith(c, fillSpec) {
  const n = c.T.n, K = c.specs.length, N = c.N;
  const volCol = c.side === "h" ? "PA" : "IP";
  const vol = c.T.data[volCol].map((v) => (Number.isNaN(v) ? 0 : v));
  const volSd = percentileSd(c.T, volCol);
  // playing-time uncertainty: each player's from his PA/IP percentiles, else the default
  const cv = vol.map((v, i) => (volSd && v > 0 && Number.isFinite(volSd[i]) ? volSd[i] / v : c.ptCV));
  const roles = rolesOf(c.T, c.side);
  const [comps, periods] = c.format === "h2h" ? [c.weeks, c.weeks]
    : c.format === "allplay" ? [c.weeks * (N - 1), c.weeks] : [N - 1, 1];
  const catcherGroup = c.side === "h" && (c.caps.C || 0) > 0;
  const typeIndex = (byPos) => new Map(byPos.levels.map((l, k) => [l.slot, k]));

  let value = c.start.slice();   // draft order: start values, then (linear) SGP above replacement
  let byPos = positionReplacement(c.start, c.pos, c.caps, c.types, 0);
  let out = null;
  const history = [];

  // One pass: rates, fill, weights from the current pool; then SGP, replacement, SGPAR
  function pass(G0) {
    const inPool = byPos.slot.map((t) => t !== null);
    const pool = [];
    inPool.forEach((d, i) => { if (d) pool.push(i); });
    // Task 3: rate stats against the drafted pool's own rate
    const rates = new Array(K).fill(null);
    const own = c.specs.map((sp, k) => {
      if (sp.kind === "count") return sp.raw.map((v) => sp.sign * v);
      let sn = 0, sd = 0;
      for (const i of pool) { sn += sp.num[i]; sd += sp.den[i]; }
      const r = sd > 0 ? sn / sd : 0;
      rates[k] = r;
      return sp.num.map((v, i) => sp.sign * (v - r * sp.den[i]));
    });
    // Playing time: what each player doesn't play, at his role's replacement production
    let fill = null;
    if (fillSpec) {
      fill = c.specs.map((sp, k) => vol.map((v, i) => {
        const f = fillSpec[roles[i]], u = f.perUnit[k], missing = Math.max(0, f.target - v);
        return missing * sp.sign * (sp.kind === "count" ? u.count : u.num - rates[k] * u.den);
      }));
    }
    const x = own.map((o, k) => (fill ? o.map((v, i) => v + fill[k][i]) : o));

    let G = G0, sigmaDraft = new Array(K).fill(NaN), nu = new Array(K).fill(NaN);
    if (c.points) G = G || new Array(K).fill(1);
    else {
      {
        // Task 5: the draft's spread of team totals, tier by tier in draft order
        const groups = catcherGroup
          ? [pool.filter((i) => byPos.slot[i] === "C"), pool.filter((i) => byPos.slot[i] !== "C")] : [pool];
        sigmaDraft = x.map((xk) => {
          let total = 0;
          for (const g of groups) {
            const ordered = g.slice().sort((a, b) => value[b] - value[a]);
            for (let t = 0; t + N <= ordered.length; t += N) {
              let m = 0;
              for (let j = t; j < t + N; j++) m += xk[ordered[j]];
              m /= N;
              let ss = 0;
              for (let j = t; j < t + N; j++) ss += (xk[ordered[j]] - m) ** 2;
              total += ss / (N - 1);
            }
          }
          return total;
        });
        // Task 6: a season's luck in one team's total
        nu = c.specs.map((sp, k) => {
          let total = 0;
          for (const i of pool) {
            const xi = own[k][i];
            if (sp.kind === "count") {
              total += sp.sd && Number.isFinite(sp.sd[i]) ? sp.sd[i] ** 2 : c.phi * Math.abs(sp.raw[i]) + (cv[i] * xi) ** 2;
            } else if (sp.sd && Number.isFinite(sp.sd[i]) && sp.den[i] > 0) {
              const rate = sp.num[i] / sp.den[i];
              total += (sp.den[i] * sp.sd[i]) ** 2 + ((rate - rates[k]) * sp.den[i] * cv[i]) ** 2;
            } else {
              const count = sp.prop && sp.den[i] > 0 ? sp.num[i] * (1 - sp.num[i] / sp.den[i]) : Math.abs(sp.num[i]);
              total += c.phi * Math.max(0, count) + (cv[i] * xi) ** 2;
            }
          }
          return total / N;
        });
        // Task 7: standings points per unit
        G = G || sigmaDraft.map((v, k) => comps / (2 * SQRT_PI * Math.sqrt(v + periods * nu[k])));
      }
    }
    // Task 8: SGP, then Task 4: replacement by lineup slot on it, per category too
    const score = new Array(n).fill(0);
    for (let k = 0; k < K; k++) for (let i = 0; i < n; i++) score[i] += G[k] * x[k][i];
    const bp = positionReplacement(score, c.pos, c.caps, c.types, c.span, x);
    const idx = typeIndex(bp);
    let deep = 0;
    bp.levels.forEach((l, k) => { if (l.level > bp.levels[deep].level) deep = k; });
    const deepLevel = bp.levels[deep].level, deepVec = bp.levels[deep].vec;
    // SGP above replacement, with Task 9 for one-category specialists (roto)
    const sigma = sigmaDraft.map((v, k) => Math.sqrt(v + nu[k]));
    const spec = c.specialists && c.format === "roto" && !c.points;
    const lin = new Array(n), specAdj = new Array(n).fill(0), sgpar = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = bp.valuedAt[i] === null ? deep : idx.get(bp.valuedAt[i]);
      const level = bp.levels[s].level, vec = bp.levels[s].vec;
      lin[i] = score[i] - level;
      if (spec) {
        for (let k = 0; k < K; k++) {
          const d = x[k][i] - vec[k];
          if (d > 0.5 * sigma[k]) specAdj[i] += (N - 1) * (normCdf(d / (Math.SQRT2 * sigma[k])) - 0.5) - G[k] * d;
        }
      }
      // a player no slot takes (a DH with no UT) is worth a bench spot at most
      sgpar[i] = bp.valuedAt[i] === null ? Math.min(0, lin[i] + specAdj[i]) : lin[i] + specAdj[i];
    }
    const ownScore = new Array(n).fill(0);
    for (let k = 0; k < K; k++) for (let i = 0; i < n; i++) ownScore[i] += G[k] * own[k][i];
    return {
      G, sigmaDraft, nu, rates, own, fill, x, targets: fillSpec, score, ownScore, byPos: bp, lin, specAdj, sgpar, deepLevel, deepVec,
      inPool, poolSlot: byPos.slot, order: value, sigma, caps: c.caps,
    };
  }

  // Task 10: until the pool stops changing and no weight moves 1%. A pool that cycles through
  // the same few states, swapping marginal players, with weights within 3% across the cycle,
  // has settled too: on the mean of the cycle's weights. Otherwise, after 20 passes, the mean
  // of the last two (the procedure's fallback), flagged.
  let converged = false, cycle = 0, it = 0;
  const key = (bp) => bp.slot.map((t) => (t === null ? 0 : 1)).join("");
  const keys = [key(byPos)];
  const spreadOk = (Gs, tol) => Gs[0].every((_, j) => {
    const d = Gs.map((g) => 1 / g[j]);
    return Math.max(...d) / Math.min(...d) - 1 <= tol;
  });
  for (it = 1; it <= 20; it++) {
    out = pass(null);
    const k = key(out.byPos);
    history.push(out.G);
    byPos = out.byPos;
    // the draft order for the next pass's tiers: value above replacement before the specialist
    // correction, which itself depends on the tiers' spread (ordered by it, the two can cycle)
    value = out.lin;
    if (k === keys[keys.length - 1] && history.length >= 2 && spreadOk(history.slice(-2), 0.01)) { converged = true; break; }
    for (let p = 2; p <= 4 && !cycle; p++) {
      if (keys.length >= p && k === keys[keys.length - p] && history.length >= p && spreadOk(history.slice(-p), 0.03)) cycle = p;
    }
    if (cycle) { converged = true; break; }
    keys.push(k);
  }
  if (!converged || cycle) {
    const Gs = history.slice(-(cycle || 2));
    out = pass(Gs[0].map((_, j) => Gs.reduce((a, g) => a + g[j], 0) / Gs.length));
  }
  // averaged: the weights are a mean over passes (a settled cycle, or the fallback)
  return { ...out, iterations: Math.min(it, 20), converged, averaged: !converged || cycle > 0 };
}

/** Last entry wins for a category listed twice, as the script's dict does */
const dedupePoints = (rows) => [...new Map(rows.filter(([c]) => c)).entries()];

/** The players who fill every team's legal roster: lineup slots plus bench (BN), by value */
function draftPool(value, posStrings, caps, types, benchSlots) {
  const { slot } = positionReplacement(value, posStrings, { ...caps, BN: benchSlots }, { ...types, BN: null }, 0);
  return slot;
}

/**
 * Price every player. s holds the settings:
 *   teams, slots and pitcherSlots ({ slotType: per team }), bench, minimizeBench,
 *   span (players either side of each position's cutoff; 0 is the last starter),
 *   style ("Categories" | "Points"), format ("roto" | "h2h" | "allplay"), weeks,
 *   minBid, budget, marketHitterShare (0-1 or null: bid prices toward a market split),
 *   phi, ptCV (noise where the projections have no percentiles), fillPT, specialists,
 *   hitterCats, pitcherCats (Categories), hitterPoints, pitcherPoints ([[cat, pts]], Points)
 * Exactly the players on legal rosters (lineups, plus the bench unless it's minimized) are
 * worth the min bid or more, and they add up to the league's budget (less a minimized bench's
 * min bids, which it's drafted at); one $/SGP across hitters and pitchers, so the values set
 * the split.
 * Returns { players, hitterCols, pitcherCols, positions, valueCols, weights, split,
 * perSGP, iterations, converged }, players sorted by value.
 */
export function auctionValues(H, P, s) {
  const bench = s.minimizeBench ? 0 : s.bench;
  const hitters = Object.values(s.slots).reduce((a, n) => a + n, 0);
  const pitchers = Object.values(s.pitcherSlots).reduce((a, n) => a + n, 0);
  const points = s.style === "Points";
  const hPoints = points ? dedupePoints(s.hitterPoints) : null;
  const pPoints = points ? dedupePoints(s.pitcherPoints) : null;
  const hitterCats = points ? hPoints.map(([c]) => c) : s.hitterCats;
  const pitcherCats = points ? pPoints.map(([c]) => c) : s.pitcherCats;
  const opts = {
    N: s.teams, span: s.span ?? 3, points, format: s.format ?? "roto", weeks: s.weeks ?? 23,
    phi: s.phi ?? 1, ptCV: s.ptCV ?? 0.15, fillPT: s.fillPT ?? true, specialists: s.specialists ?? true,
  };

  // Task 2's start values: the z-scores (or points) the calculator has always had
  const hSample = nlargestIdx(H.data.PA, rint(s.teams * (hitters + bench / 2) * 1.1));
  const hStart = points ? pointsValue(H, hPoints) : zValue(H, hitterCats, RATE_H, INVERT_H, hSample, hitters, "PA");
  const ip = P.data.IP;
  const ipThresh = Math.min(50, nlargestMin(ip, s.teams * pitchers));
  const pSample = [];
  for (let i = 0; i < P.n; i++) if (ip[i] >= ipThresh) pSample.push(i);
  const pStart = points ? pointsValue(P, pPoints) : zValue(P, pitcherCats, RATE_P, INVERT_P, pSample, pitchers, "IP");

  // Each side: its slots (plus half the bench when it counts) and its categories
  const hPos = H.data["Y! Pos"];
  const pPos = P.data["Y! Pos"] ? P.data["Y! Pos"].map((p) => p ?? "P") : new Array(P.n).fill("P");
  const hCaps = sideCaps(hPos, s.slots, SLOT_TYPES, "UT", s.teams);
  const pCaps = sideCaps(pPos, s.pitcherSlots, PITCHER_SLOT_TYPES, "P", s.teams);
  const benchOf = (starters) => Math.trunc(s.teams * (starters + bench / 2)) - s.teams * starters;
  const h = valueSide({
    ...opts, T: H, side: "h", pos: hPos, caps: withAny(hCaps, "UT", benchOf(hitters)), types: SLOT_TYPES, start: hStart.total,
    specs: points ? hPoints.map(([c, w]) => categorySpec(H, "h", c, w)) : hitterCats.map((c) => categorySpec(H, "h", c)),
  });
  const p = valueSide({
    ...opts, T: P, side: "p", pos: pPos, caps: withAny(pCaps, "P", benchOf(pitchers)), types: PITCHER_SLOT_TYPES, start: pStart.total,
    specs: points ? pPoints.map(([c, w]) => categorySpec(P, "p", c, w)) : pitcherCats.map((c) => categorySpec(P, "p", c)),
  });

  // Task 11: dollars. The drafted players fill every team's legal roster (lineups, and half the
  // bench each side unless it's minimized); each side's last one goes for the min bid, and the
  // dollars beyond the min bids go out at one rate per SGP above him, whichever side he's on.
  // Every bench spot's min bid comes out of the budget either way: a minimized bench is still
  // drafted, at the min bid, just not priced
  const benchH = Math.floor((s.teams * bench) / 2);
  const hSlot = draftPool(h.sgpar, hPos, hCaps, SLOT_TYPES, benchH);
  const pSlot = draftPool(p.sgpar, pPos, pCaps, PITCHER_SLOT_TYPES, s.teams * bench - benchH);
  const spare = s.teams * s.budget - s.teams * (hitters + pitchers + s.bench) * s.minBid;
  const baseOf = (v, slot) => Math.min(...v.filter((_, i) => slot[i] !== null));
  const hBase = baseOf(h.sgpar, hSlot), pBase = baseOf(p.sgpar, pSlot);
  const over = (v, slot, base) => v.reduce((a, x, i) => (slot[i] !== null ? a + x - base : a), 0);
  const total = over(h.sgpar, hSlot, hBase) + over(p.sgpar, pSlot, pBase);
  const drafted = hSlot.filter((t) => t !== null).length + pSlot.filter((t) => t !== null).length;
  const perSGP = total > 0 ? spare / total : 0;
  const flat = total > 0 || !drafted ? 0 : spare / drafted;   // everyone level: split it evenly
  const dollars = (v, slot, base) => v.map((x, i) => {
    if (Number.isNaN(x)) return NaN;
    const d = s.minBid + (x - base) * perSGP;
    // a player no legal roster has room for stays under the min bid
    return slot[i] !== null ? d + flat : Math.min(d, s.minBid - 0.01);
  });
  const hValue = dollars(h.sgpar, hSlot, hBase), pValue = dollars(p.sgpar, pSlot, pBase);

  // The split the values make, and bid prices moved toward a market's split (values unchanged)
  const surplus = (v, slot) => v.reduce((a, x, i) => (slot[i] !== null ? a + x - s.minBid : a), 0);
  const hSurplus = surplus(hValue, hSlot), pSurplus = surplus(pValue, pSlot);
  const split = { hitters: spare > 0 ? hSurplus / spare : NaN, pitchers: spare > 0 ? pSurplus / spare : NaN };
  const market = s.marketHitterShare;
  const scale = market === null || market === undefined ? null
    : { h: hSurplus > 0 ? (market * spare) / hSurplus : 1, p: pSurplus > 0 ? ((1 - market) * spare) / pSurplus : 1 };

  // Each player's dollars, part by part (they add back up exactly): the min bid; the side's
  // baseline (its last drafted player); his position's premium over the side's deepest one;
  // each stat over the deepest position's replacement; the playing time filled in for him;
  // the specialist correction; and anything holding a player with no roster spot under the min bid
  const parts = (side, value, slot, base) => side.score.map((_, i) => {
    if (Number.isNaN(value[i])) return null;
    const stats = {};
    let sum = s.minBid;
    side.own.forEach((o, k) => { stats[side.catNames[k]] = perSGP * side.G[k] * (o[i] - side.deepVec[k]); sum += stats[side.catNames[k]]; });
    const fill = side.fill ? perSGP * side.fill.reduce((a, f, k) => a + side.G[k] * f[i], 0) : 0;
    const t = side.byPos.valuedAt[i];
    const level = t === null ? side.deepLevel : side.byPos.levels.find((l) => l.slot === t).level;
    const position = perSGP * (side.deepLevel - level);
    const specialist = perSGP * side.specAdj[i];
    const baseline = -perSGP * base + (slot[i] !== null ? flat : 0);
    sum += fill + position + specialist + baseline;
    const other = value[i] - sum;
    return { minBid: s.minBid, baseline, position, fill, specialist, stats, other: Math.abs(other) < 1e-9 ? 0 : other };
  });
  h.catNames = hitterCats; p.catNames = pitcherCats;
  const hParts = parts(h, hValue, hSlot, hBase), pParts = parts(p, pValue, pSlot, pBase);

  const hitterCols = ["PA", ...hitterCats.filter((c) => c !== "PA")];
  const pitcherCols = ["IP", ...pitcherCats.filter((c) => c !== "IP")];
  const players = [];
  const add = (T, side, start, value, slot, type, cols, partsOf) => {
    for (let i = 0; i < T.n; i++) {
      const stats = {};
      for (const c of cols) stats[c] = T.data[c][i];
      const v = value[i];
      players.push({
        type, name: T.data.Name[i] ?? "", mlbamid: T.data.MLBAMID[i], team: T.data.Team[i] ?? "",
        pos: T.data["Y! Pos"] ? (T.data["Y! Pos"][i] ?? (type === "p" ? "P" : "UT")) : "P",
        start: start.total[i], points: points ? start.total[i] : NaN, sgp: side.score[i], sgpar: side.sgpar[i],
        value: v, bid: scale ? s.minBid + (v - s.minBid) * scale[type] : v,
        drafted: slot[i] !== null, slot: slot[i], valuedAt: side.byPos.valuedAt[i], stats, breakdown: partsOf[i],
      });
    }
  };
  add(H, h, hStart, hValue, hSlot, "h", hitterCols, hParts);
  add(P, p, pStart, pValue, pSlot, "p", pitcherCols, pParts);
  players.sort((a, b) => (Number.isNaN(a.value) ? 1 : Number.isNaN(b.value) ? -1 : b.value - a.value));
  rankDescending(players);

  // Each slot type's scarcity in dollars: how much more a player there is worth than the same
  // player at his side's deepest position
  const premiums = (side, key) => side.byPos.levels
    .map((l) => ({ slot: l.slot, slots: l.slots, level: l.level, worst: l.worst, side: key, premium: (side.deepLevel - l.level) * perSGP }))
    .sort((a, b) => b.premium - a.premium);
  const positions = [...premiums(h, "h"), ...premiums(p, "p")];
  // The weights: standings points per unit (G), its inverse (the SGP denominator D), and
  // what went into it
  const weights = (side, specs) => specs.map((sp, k) => ({
    cat: points ? sp.cat : sp.cat, unit: sp.unit, G: side.G[k], D: 1 / side.G[k], rate: side.rates[k],
    sigmaDraft: Math.sqrt(side.sigmaDraft[k]), noise: Math.sqrt(side.nu[k]),
  }));
  const hSpecs = points ? hPoints.map(([c]) => ({ cat: c, unit: "points" })) : hitterCats.map((c) => ({ cat: c, unit: (RATE_SPECS.h[c] || {}).unit || c }));
  const pSpecs = points ? pPoints.map(([c]) => ({ cat: c, unit: "points" })) : pitcherCats.map((c) => ({ cat: c, unit: (RATE_SPECS.p[c] || {}).unit || c }));
  return {
    players, hitterCols, pitcherCols, positions, valueCols: { h: hitterCats, p: pitcherCats },
    weights: { h: weights(h, hSpecs), p: weights(p, pSpecs) }, split, perSGP, market: scale ? market : null,
    iterations: { h: h.iterations, p: p.iterations }, converged: h.converged && p.converged,
    fillTargets: { h: h.targets, p: p.targets },
    // the last pass's workings, for tools/auction_calculator/sgp_check.py
    debug: s.debug ? { h, p } : undefined,
  };
}

// pandas' rank(ascending=False): ties share the average of their places
function rankDescending(sorted) {
  let i = 0;
  while (i < sorted.length) {
    if (Number.isNaN(sorted[i].value)) { sorted[i++].rank = NaN; continue; }
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].value === sorted[i].value) j++;
    for (let k = i; k <= j; k++) sorted[k].rank = (i + j) / 2 + 1;
    i = j + 1;
  }
}
