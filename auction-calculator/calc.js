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

// ---- position eligibility -------------------------------------------------------

// Yahoo's: a hitter qualifies at a position with 5 starts or 10 games there, a pitcher at SP with 3
// starts and at RP with 5 relief appearances
export const YAHOO_ELIGIBILITY = { gs: 5, g: 10, sp: 3, rp: 5 };
const FIELDING = ["C", "1B", "2B", "3B", "SS", "OF"];

/**
 * One player's positions from a season's games, as a site counts them. E: the eligibility table
 * ("<pos> G" and "<pos> GS" for C, 1B, 2B, 3B, SS, OF, DH and P), i: his row, rules: { gs, g, sp,
 * rp }, any of them null to skip that test. A hitter qualifies at each fielding position where he
 * has gs starts or g games; a pitcher at SP with sp starts and at RP with rp relief appearances
 * (games less starts). One who qualifies nowhere goes where he played most: most games, then
 * starts (UT for a DH; SP or RP by which he did more of). Returns { pos, games, most, season },
 * games the positions he played, most games first; null when he didn't play on that side.
 */
export function eligibilityOf(E, i, side, rules) {
  const num = (col) => (E.data[col] && Number.isFinite(E.data[col][i]) ? E.data[col][i] : 0);
  const meets = (min, n) => min !== null && min !== undefined && n >= min;
  const season = num("Season") || null;
  if (side === "p") {
    const gs = num("P GS"), relief = Math.max(0, num("P G") - gs);
    if (gs + relief === 0) return null;
    const pos = [...(meets(rules.sp, gs) ? ["SP"] : []), ...(meets(rules.rp, relief) ? ["RP"] : [])];
    return { pos: pos.length ? pos.join(",") : gs >= relief ? "SP" : "RP", games: [{ pos: "P", g: gs + relief, gs }], most: !pos.length, season };
  }
  const games = [...FIELDING, "DH"].map((p) => ({ pos: p, g: num(`${p} G`), gs: num(`${p} GS`) }))
    .filter((x) => x.g > 0 || x.gs > 0).sort((a, b) => b.g - a.g || b.gs - a.gs);
  if (!games.length) return null;
  const pos = FIELDING.filter((p) => games.some((x) => x.pos === p && (meets(rules.g, x.g) || meets(rules.gs, x.gs))));
  if (pos.length) return { pos: pos.join(","), games, most: false, season };
  const most = games.filter((x) => x.g === games[0].g && x.gs === games[0].gs).map((x) => (x.pos === "DH" ? "UT" : x.pos));
  return { pos: (most.length > 1 ? most.filter((p) => p !== "UT") : most).join(","), games, most: true, season };
}

/**
 * The table with each player's positions from a season's games where the eligibility table has
 * him (by MLBAM id) and he played on that side, and the projections' own otherwise. Adds an
 * Eligibility column: what eligibilityOf found, or null. The table passed in is left as it is.
 */
export function withEligibility(T, E, side, rules) {
  const key = (v) => (v === null || v === undefined || Number.isNaN(v) || String(v).trim() === "" ? null : String(v).trim());
  const rowOf = new Map();
  if (E.data.MLBAMID) E.data.MLBAMID.forEach((v, j) => { if (key(v) !== null) rowOf.set(key(v), j); });
  const t = { columns: T.columns.slice(), n: T.n, data: { ...T.data } };
  const own = t.data["Y! Pos"] || new Array(t.n).fill(null);
  const found = (t.data.MLBAMID || new Array(t.n).fill(null)).map((v) => {
    const j = key(v) === null ? undefined : rowOf.get(key(v));
    return j === undefined ? null : eligibilityOf(E, j, side, rules);
  });
  addColumn(t, "Y! Pos", found.map((f, i) => (f ? f.pos : own[i])));
  addColumn(t, "Eligibility", found);
  return t;
}

// elig (optional): { table, rules }, the positions from a season's games (withEligibility)
export function prepHitters(table, pool, includeFa, elig = null) {
  let t = filterLeague(table, pool, includeFa);
  if (elig) t = withEligibility(t, elig.table, "h", elig.rules);
  const pos = t.data["Y! Pos"] || new Array(t.n).fill(null);
  addColumn(t, "Y! Pos", pos.map((p) => p ?? "UT"));
  return t;
}

export function prepPitchers(table, pool, includeFa, elig = null) {
  let t = filterLeague(table, pool, includeFa);
  if (elig) t = withEligibility(t, elig.table, "p", elig.rules);
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

/** How one category turns a player's projection into the count he adds to a team (risk.js reads simulation draws with it too) */
export function categorySpec(T, side, cat, points) {
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

// ---- lineup locks (lineup-locks spec, Tasks 1-4) ---------------------------------------------

// How often a league sets its lineups: every day, twice a week (Monday-Thursday, then
// Friday-Sunday) or once a week. A lock window's SPs can't be swapped out mid-window, so when a
// team rosters more SPs than it has SP spots, some of their starts sit on its bench
export const LOCKS = { daily: [1], split: [4, 3], weekly: [7] };   // window lengths, in days
// Table 9.2: the share of an SP's value above replacement that a team can use, by bench depth
// (rostered SPs beyond its SP spots, 1-3) and tier (ace, good, mid, low); daily locks keep it all
export const KAPPA = {
  split: { 1: [1.00, 1.00, 0.99, 0.99], 2: [0.99, 0.98, 0.98, 0.97], 3: [0.98, 0.97, 0.96, 0.93] },
  weekly: { 1: [0.97, 0.95, 0.92, 0.88], 2: [0.94, 0.91, 0.85, 0.78], 3: [0.91, 0.87, 0.81, 0.69] },
};
export const SP_TIERS = ["ace", "good", "mid", "low"];
const TIER_CUTS = [0.15, 0.40, 0.70];   // ace: the top 15% of drafted SPs by value per start; good, the next 25%; mid, 30%
const choose = (n, k) => { let c = 1; for (let j = 1; j <= k; j++) c = (c * (n - k + j)) / j; return c; };
/** The chance one SP has a start in a window of `days` (5-man rotation, 6% of turns skipped) */
export function qWindow(days, rotation = 5, skip = 0.06) {
  const rate = ((162 / 182) / rotation) * (1 - skip);
  return days < rotation ? Math.min(1, rate * days) : 0.95;
}
/** The chance more of a team's nSP starters pitch in a window than it has S spots for: P(K > S) */
export function pBind(nSP, S, q) {
  let p = 0;
  for (let k = S + 1; k <= nSP; k++) p += choose(nSP, k) * q ** k * (1 - q) ** (nSP - k);
  return p;
}
/** The same, averaged over a lock's windows (twice weekly: a 4-day and a 3-day one) */
export const pBindLock = (lock, nSP, S) => LOCKS[lock].reduce((a, d) => a + pBind(nSP, S, qWindow(d)), 0) / LOCKS[lock].length;

// Task 1: a typical team's SPs, from the side valued without the lock: S, the SPs in its lineup
// (SP spots and the P spots SPs take), and nSP, those plus the SPs on its bench (the pitchers'
// half of the bench, minimized or not: it's rostered either way). Task 3: if the slots bind in
// under 5% of windows the lock changes nothing. Task 2 (capture factors): each SP's tier by his
// value per start among the drafted SPs (undrafted ones are low), and its share from Table 9.2
function lockSpecOf(c, bare) {
  const roles = rolesOf(c.T, "p");
  const { slot } = positionReplacement(bare.score, c.pos, { ...c.lineupCaps, BN: c.benchFull }, { ...c.types, BN: null }, 0);
  const rostered = [];
  let active = 0;
  slot.forEach((t, i) => { if (t !== null && roles[i] === "SP") { rostered.push(i); if (t !== "BN") active++; } });
  const S = Math.round(active / c.N), nSP = Math.round(rostered.length / c.N), depth = nSP - S;
  const info = { lock: c.lock, S, nSP, depth, pBind: pBindLock(c.lock, nSP, S), kappa: null, tier: null };
  if (c.lock === "daily" || info.pBind < 0.05 || depth < 1) return info;
  const gs = isNumeric(c.T, "GS") ? c.T.data.GS : null, ip = c.T.data.IP;
  const perStart = (i) => bare.score[i] / (gs && gs[i] > 0 ? gs[i] : Math.max(1, ip[i] / 5.5));
  rostered.sort((a, b) => perStart(b) - perStart(a));
  const tier = roles.map((r) => (r === "SP" ? 3 : null));
  rostered.forEach((i, j) => { const q = j / rostered.length; tier[i] = TIER_CUTS.findIndex((cut) => q < cut); if (tier[i] < 0) tier[i] = 3; });
  const shares = KAPPA[c.lock][Math.min(3, depth)];
  return { ...info, tier, kappa: tier.map((t) => (t === null ? 1 : shares[t])) };
}

// ---- two-way players (lineup-locks spec, Task 6) ----------------------------------------------

// How a league lists a player who hits and pitches (by MLBAM id, a row in each file): as two
// players (split); as one who fills a hitter and a pitcher spot at once, both lines counting
// (simultaneous); or as one in one spot (oneslot), hitter or pitcher switched whenever lineups
// lock: each day, each Monday and Friday, or each week
export const TWO_WAY_MODES = ["split", "simultaneous", "oneslot"];
const SEASON_DAYS = 182, OFF_DAYS = 20, GAMES = 162;
// A lock window's team games: L days of a 182-day season with 20 off days
const windowGames = (L) => Array.from({ length: L + 1 }, (_, k) => (L - k <= OFF_DAYS ? (choose(GAMES, k) * choose(OFF_DAYS, L - k)) / choose(SEASON_DAYS, L) : 0));
// A starter's lock windows of L days, as [chance, team games, his starts]: a turn every 6 team
// games (5 when he projects for more than 27 starts) from a random start, with turns skipped
// (rest, innings limits) so the season comes to his projected starts. The spec's schedule
// simulation, in closed form: about 6% of weeks have 2 starts in a 6-man rotation
function startWindows(starts, L) {
  const r = starts <= GAMES / 6 ? 6 : 5, keep = Math.min(1, (starts * r) / GAMES);
  const windows = [];
  windowGames(L).forEach((pg, g) => {
    const base = Math.floor(g / r), frac = g / r - base;
    for (const [turns, pt] of [[base, 1 - frac], [base + 1, frac]]) {
      if (pt <= 0 || pg <= 0) continue;
      for (let n = 0; n <= turns; n++) windows.push([pg * pt * choose(turns, n) * keep ** n * (1 - keep) ** (turns - n), g, n]);
    }
  });
  return windows;
}
/**
 * A two-way player's SGP above replacement from his hitting (H) and his pitching (P, each above
 * its own replacement), his projected starts and the league's lineup lock, as his league uses
 * him: both lines at once (simultaneous); or one spot (oneslot), hitter or pitcher for each lock
 * window, whichever the window is worth more as: its hitting, or its starts. Under daily locks
 * that's the spec's one-slot daily rule (he pitches his start days when a start beats a day's
 * hitting, and loses those days' hitting, about 15%); under weekly ones its one-slot weekly rule;
 * Monday/Friday locks switch twice a week. The roster spot he saves (b) adds nothing: a spot's
 * best bench use is a replacement player, 0 above replacement here. Split leagues value two
 * players (NaN)
 */
export function twoWayValue(H, P, mode, starts, lock = "daily") {
  if (mode === "split") return NaN;
  const { hit, pitch } = twoWayShares(H, P, mode, starts, lock);
  return hit * H + pitch * P;
}
/** The same as the shares of his season hitting and pitching he's used for (value = hit·H + pitch·P) */
export function twoWayShares(H, P, mode, starts, lock = "daily") {
  if (mode === "simultaneous") return H > 0 || P > 0 ? { hit: H > 0 ? 1 : 0, pitch: P > 0 ? 1 : 0 } : H >= P ? { hit: 1, pitch: 0 } : { hit: 0, pitch: 1 };
  if (!(starts > 0) || mode !== "oneslot") return { hit: 1, pitch: 0 };
  const lengths = LOCKS[lock] || LOCKS.daily;
  const count = SEASON_DAYS / lengths.reduce((a, b) => a + b, 0);   // windows of each length a season
  const all = lengths.map((L) => startWindows(starts, L));
  const season = count * all.flat().reduce((a, [q, , n]) => a + q * n, 0), perStart = P / season;
  let hit = 0, pitch = 0;
  for (const windows of all) for (const [q, g, n] of windows) {
    if ((H * g) / GAMES >= n * perStart) hit += (count * q * g) / GAMES;
    else pitch += (count * q * n) / season;
  }
  return { hit, pitch };
}
// The hitter and pitcher rows of each two-way player (one MLBAM id, playing time in both files)
function twoWayPairs(H, P) {
  const id = (T, i) => (T.data.MLBAMID ? T.data.MLBAMID[i] : null);
  const hitters = new Map();
  for (let i = 0; i < H.n; i++) if (id(H, i) !== null && id(H, i) !== "" && H.data.PA[i] > 0) hitters.set(String(id(H, i)), i);
  const pairs = [];
  for (let i = 0; i < P.n; i++) {
    const ih = id(P, i) !== null ? hitters.get(String(id(P, i))) : undefined;
    if (ih !== undefined && P.data.IP[i] > 0) pairs.push({ ih, ip: i });
  }
  return pairs;
}
const startsOf = (P, i) => (isNumeric(P, "GS") && P.data.GS[i] > 0 ? P.data.GS[i] : P.data.IP[i] / 5.5);

/** Each player's role, for filling his missing playing time: C or H; SP or RP (or P) */
export function rolesOf(T, side) {
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
  const locked = c.side === "p" && !!c.lock && c.lock !== "daily";
  if (!c.fillPT && !locked) return valueSideWith(c, null, null);
  // (the bare run only has to settle the pool and each player's own value: no span refills)
  const bare = valueSideWith({ ...c, span: 0, specialists: false }, null, null);
  const lockSpec = locked ? lockSpecOf(c, bare) : null;
  const fillSpec = c.fillPT ? fillSpecOf(c, bare) : null;
  return { ...valueSideWith(c, fillSpec, lockSpec), lock: lockSpec };
}

function fillSpecOf(c, bare) {
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
  return fillSpec;
}

function valueSideWith(c, fillSpec, lockSpec) {
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
  // Task 4: a lock cuts the pitching a team can use, so the league's team totals (its pool
  // rates, the draft's spread, a season's luck) count each SP at his share of his line
  const w = lockSpec && lockSpec.kappa ? lockSpec.kappa : null;

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
      for (const i of pool) { const wi = w ? w[i] : 1; sn += wi * sp.num[i]; sd += wi * sp.den[i]; }
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
        const xT = w ? x.map((xk) => xk.map((v, i) => v * w[i])) : x;
        sigmaDraft = xT.map((xk) => {
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
            const wi = w ? w[i] : 1, xi = wi * own[k][i];
            if (sp.kind === "count") {
              total += sp.sd && Number.isFinite(sp.sd[i]) ? (wi * sp.sd[i]) ** 2 : c.phi * wi * Math.abs(sp.raw[i]) + (cv[i] * xi) ** 2;
            } else if (sp.sd && Number.isFinite(sp.sd[i]) && sp.den[i] > 0) {
              const rate = sp.num[i] / sp.den[i];
              total += (wi * sp.den[i] * sp.sd[i]) ** 2 + ((rate - rates[k]) * wi * sp.den[i] * cv[i]) ** 2;
            } else {
              const count = sp.prop && sp.den[i] > 0 ? sp.num[i] * (1 - sp.num[i] / sp.den[i]) : Math.abs(sp.num[i]);
              total += c.phi * wi * Math.max(0, count) + (cv[i] * xi) ** 2;
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
    // Task 2: under a binding lock an SP keeps his tier's share of his value above replacement
    const lockAdj = w ? sgpar.map((v, i) => (v > 0 && w[i] < 1 ? (w[i] - 1) * v : 0)) : null;
    if (lockAdj) for (let i = 0; i < n; i++) sgpar[i] += lockAdj[i];
    const ownScore = new Array(n).fill(0);
    for (let k = 0; k < K; k++) for (let i = 0; i < n; i++) ownScore[i] += G[k] * own[k][i];
    return {
      G, sigmaDraft, nu, rates, own, fill, x, targets: fillSpec, score, ownScore, byPos: bp, lin, specAdj, lockAdj, sgpar, deepLevel, deepVec,
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
 *   minBid, budget, hitterShare (0-1: the hitters' share of the dollars above the min bids;
 *   null for the split the values make), curve (1 or more: the dollar curve's exponent, 1 for
 *   a straight line), lock ("daily" | "split" | "weekly": how often lineups are set),
 *   twoWay ("split" | "simultaneous" | "oneslot": how two-way players are used; one slot
 *   switches at each lineup lock),
 *   phi, ptCV (noise where the projections have no percentiles), fillPT, specialists,
 *   hitterCats, pitcherCats (Categories), hitterPoints, pitcherPoints ([[cat, pts]], Points)
 * Exactly the players on legal rosters (lineups, plus the bench unless it's minimized) are
 * worth the min bid or more, and they add up to the league's budget (less a minimized bench's
 * min bids, which it's drafted at). The dollars above the min bids go to hitters and pitchers
 * by the hitter share, or with no share at one $/SGP across both sides, so the values set the
 * split.
 * Returns { players, hitterCols, pitcherCols, positions, valueCols, weights, split (the values'
 * own), hitterShare (the one used), perSGP ({ h, p }: each side's average), curve, lock (the
 * typical roster and whether its SP spots bind), twoWay, iterations, converged }, players sorted
 * by value.
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
    lock: s.lock ?? "daily", lineupCaps: pCaps, benchFull: s.teams * s.bench - Math.floor((s.teams * s.bench) / 2),
    specs: points ? pPoints.map(([c, w]) => categorySpec(P, "p", c, w)) : pitcherCats.map((c) => categorySpec(P, "p", c)),
  });

  // Task 11: dollars. The drafted players fill every team's legal roster (lineups, and half the
  // bench each side unless it's minimized); each side's last one goes for the min bid. The
  // dollars beyond the min bids go to hitters and pitchers by the hitter share (with none, by
  // the split one rate per SGP across both sides makes), and out on each side by SGP above its
  // last player. Every bench spot's min bid comes out of the budget either way: a minimized
  // bench is still drafted, at the min bid, just not priced.
  // The dollar curve: a side's dollars above its last drafted player go by (SGP over him)^γ.
  // γ = 1 is a straight line; above it a star costs more than lesser players with the same SGP
  // between them. The last drafted player still gets the min bid and each side its dollars
  const benchH = Math.floor((s.teams * bench) / 2);
  const spare = s.teams * s.budget - s.teams * (hitters + pitchers + s.bench) * s.minBid;
  const baseOf = (v, slot) => Math.min(...v.filter((_, i) => slot[i] !== null));
  const over = (v, slot, base) => v.reduce((a, x, i) => (slot[i] !== null ? a + x - base : a), 0);
  const gamma = Math.max(1, s.curve ?? 1);
  const curved = (v, slot, base) => v.reduce((a, x, i) => (slot[i] !== null ? a + Math.max(0, x - base) ** gamma : a), 0);
  // A side's curve (k), its average dollars per SGP over its last player, or its dollars split
  // evenly when nobody's above him
  const rateOf = (sgp, curve, n, dollars) => (sgp > 0 ? { k: dollars / curve, perSGP: dollars / sgp, flat: 0 }
    : { k: 0, perSGP: 0, flat: n ? dollars / n : 0 });
  // Each side's drafted players and its last one (the base), the split, and each side's curve
  const price = () => {
    const hSlot = draftPool(h.sgpar, hPos, hCaps, SLOT_TYPES, benchH);
    const pSlot = draftPool(p.sgpar, pPos, pCaps, PITCHER_SLOT_TYPES, s.teams * bench - benchH);
    const hBase = baseOf(h.sgpar, hSlot), pBase = baseOf(p.sgpar, pSlot);
    const hOver = over(h.sgpar, hSlot, hBase), pOver = over(p.sgpar, pSlot, pBase);
    const hCurve = curved(h.sgpar, hSlot, hBase), pCurve = curved(p.sgpar, pSlot, pBase);
    const hN = hSlot.filter((t) => t !== null).length, pN = pSlot.filter((t) => t !== null).length;
    // The values' own split: one curve across both sides (by head count when everyone's level)
    const ownShare = hCurve + pCurve > 0 ? hCurve / (hCurve + pCurve) : hN + pN > 0 ? hN / (hN + pN) : 0.5;
    const share = s.hitterShare ?? ownShare;
    return { hSlot, pSlot, hBase, pBase, ownShare, share,
      hRate: rateOf(hOver, hCurve, hN, share * spare), pRate: rateOf(pOver, pCurve, pN, (1 - share) * spare) };
  };

  // Two-way players: in a one-spot league (switched at each lineup lock) he's in the hitter pool at his
  // combined value, and his pitcher row leaves the pitcher pool, so each side still drafts its
  // spots and spends its dollars. His pitching counts at the pitchers' price, since the hitter
  // split can make a pitcher's SGP cost less than a hitter's. Simultaneous leagues value both
  // rows on their own sides, then show them as one
  const twoWay = s.twoWay ?? "split";
  const pairs = twoWay === "split" ? [] : twoWayPairs(H, P);
  const oneSpot = twoWay === "oneslot";
  h.twAdj = new Array(H.n).fill(0);
  const before = pairs.length && oneSpot ? price() : null;
  const ratio = before && before.hRate.perSGP > 0 ? before.pRate.perSGP / before.hRate.perSGP : 1;
  for (const t of pairs) {
    t.H = h.sgpar[t.ih]; t.P = p.sgpar[t.ip]; t.starts = startsOf(P, t.ip);
    if (!oneSpot || !Number.isFinite(t.H) || !Number.isFinite(t.P)) continue;
    // (his days or weeks are chosen in those same units, so he's never worth less than either role)
    Object.assign(t, twoWayShares(t.H, t.P * ratio, twoWay, t.starts, s.lock ?? "daily"));
    const V = t.hit * t.H + t.pitch * t.P * ratio;
    h.twAdj[t.ih] = V - t.H;
    h.sgpar[t.ih] = V;
    p.sgpar[t.ip] = NaN;
  }
  const { hSlot, pSlot, hBase, pBase, ownShare, share, hRate, pRate } = price();
  // A player's own dollars per SGP, so his dollars are the min bid + rate × (SGP over the last
  // drafted player): the curve's k·u^(γ−1) above him; below him (no curve there) the side's average
  const rateAt = (u, r) => (u > 0 ? r.k * u ** (gamma - 1) : r.perSGP);
  const dollars = (v, slot, base, r) => v.map((x, i) => {
    if (Number.isNaN(x)) return NaN;
    const d = s.minBid + (x - base) * rateAt(x - base, r);
    // a player no legal roster has room for stays under the min bid
    return slot[i] !== null ? d + r.flat : Math.min(d, s.minBid - 0.01);
  });
  const hValue = dollars(h.sgpar, hSlot, hBase, hRate), pValue = dollars(p.sgpar, pSlot, pBase, pRate);

  // Each player's dollars, part by part (they add back up exactly): the min bid; the side's
  // baseline (its last drafted player); his position's premium over the side's deepest one;
  // each stat over the deepest position's replacement; the playing time filled in for him;
  // the specialist correction; and anything holding a player with no roster spot under the min bid
  // (each at the player's own rate along the curve)
  const parts = (side, value, slot, base, r) => side.score.map((_, i) => {
    if (Number.isNaN(value[i])) return null;
    const perSGP = rateAt(side.sgpar[i] - base, r), flat = r.flat;
    const stats = {};
    let sum = s.minBid;
    side.own.forEach((o, k) => { stats[side.catNames[k]] = perSGP * side.G[k] * (o[i] - side.deepVec[k]); sum += stats[side.catNames[k]]; });
    const fill = side.fill ? perSGP * side.fill.reduce((a, f, k) => a + side.G[k] * f[i], 0) : 0;
    const t = side.byPos.valuedAt[i];
    const level = t === null ? side.deepLevel : side.byPos.levels.find((l) => l.slot === t).level;
    const position = perSGP * (side.deepLevel - level);
    const specialist = perSGP * side.specAdj[i];
    const lock = perSGP * (side.lockAdj ? side.lockAdj[i] : 0);
    const twoWayPart = perSGP * (side.twAdj ? side.twAdj[i] : 0);
    const baseline = -perSGP * base + (slot[i] !== null ? flat : 0);
    sum += fill + position + specialist + lock + twoWayPart + baseline;
    const other = value[i] - sum;
    return { minBid: s.minBid, baseline, position, fill, specialist, lock, twoWay: twoWayPart, stats, other: Math.abs(other) < 1e-9 ? 0 : other };
  });
  h.catNames = hitterCats; p.catNames = pitcherCats;
  const hParts = parts(h, hValue, hSlot, hBase, hRate), pParts = parts(p, pValue, pSlot, pBase, pRate);

  const hitterCols = ["PA", ...hitterCats.filter((c) => c !== "PA")];
  const pitcherCols = ["IP", ...pitcherCats.filter((c) => c !== "IP")];
  const players = [];
  const rows = { h: [], p: [] };
  const add = (T, side, start, value, slot, type, cols, partsOf) => {
    for (let i = 0; i < T.n; i++) {
      const stats = {};
      for (const c of cols) stats[c] = T.data[c][i];
      const v = value[i];
      players.push({
        type, name: T.data.Name[i] ?? "", mlbamid: T.data.MLBAMID[i], team: T.data.Team[i] ?? "",
        pos: T.data["Y! Pos"] ? (T.data["Y! Pos"][i] ?? (type === "p" ? "P" : "UT")) : "P",
        elig: T.data.Eligibility ? T.data.Eligibility[i] : null,
        start: start.total[i], points: points ? start.total[i] : NaN, sgp: side.score[i], sgpar: side.sgpar[i],
        value: v,
        drafted: slot[i] !== null, slot: slot[i], valuedAt: side.byPos.valuedAt[i], stats, breakdown: partsOf[i],
        lockShare: side.lock && side.lock.kappa ? side.lock.kappa[i] : 1,
        lockTier: side.lock && side.lock.tier && side.lock.tier[i] !== null ? SP_TIERS[side.lock.tier[i]] : null,
      });
      rows[type][i] = players[players.length - 1];
    }
  };
  add(H, h, hStart, hValue, hSlot, "h", hitterCols, hParts);
  add(P, p, pStart, pValue, pSlot, "p", pitcherCols, pParts);
  // A two-way player shows as one row, his hitter row, with his pitching beside it: in a
  // one-spot league priced into it already; in a simultaneous one his pitcher row's dollars and
  // parts added on (he's drafted for both spots), so the rows' totals don't change
  const sumParts = (a, b) => {
    const out = { stats: a.stats, pstats: b.stats };
    for (const key of ["minBid", "baseline", "position", "fill", "specialist", "lock", "twoWay", "other"]) out[key] = a[key] + b[key];
    return out;
  };
  for (const t of pairs) {
    const hp = rows.h[t.ih], pp = rows.p[t.ip];
    hp.twoWay = { mode: twoWay, lock: s.lock ?? "daily", pos: pp.pos, elig: pp.elig, stats: pp.stats, H: t.H, P: t.P, starts: t.starts, hit: t.hit ?? 1, pitch: t.pitch ?? 0, priceRatio: ratio,
      hPos: hp.pos, hValue: hp.value, hDrafted: hp.drafted, pDrafted: false, value: 0 };
    hp.pos = `${hp.pos},${pp.pos}`;
    if (twoWay === "simultaneous" && pp.drafted) {
      if (hp.drafted) {
        hp.value += pp.value;
        hp.breakdown = sumParts(hp.breakdown, pp.breakdown);
        hp.slot = `${hp.slot} + ${pp.slot}`;
      } else {
        hp.value = pp.value;
        hp.breakdown = { ...pp.breakdown, stats: {}, pstats: pp.breakdown.stats };
        hp.drafted = true;
        hp.slot = pp.slot;
      }
      hp.twoWay.value = pp.value;
      hp.twoWay.pitch = 1;
      hp.twoWay.pDrafted = true;
    }
    players.splice(players.indexOf(pp), 1);
  }
  players.sort((a, b) => (Number.isNaN(a.value) ? 1 : Number.isNaN(b.value) ? -1 : b.value - a.value));
  rankDescending(players);

  // Each slot type's scarcity in dollars: how much more a player there is worth than the same
  // player at his side's deepest position (at the side's average dollars per SGP)
  const premiums = (side, key, r) => side.byPos.levels
    .map((l) => ({ slot: l.slot, slots: l.slots, level: l.level, worst: l.worst, side: key, premium: (side.deepLevel - l.level) * r.perSGP }))
    .sort((a, b) => b.premium - a.premium);
  const positions = [...premiums(h, "h", hRate), ...premiums(p, "p", pRate)];
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
    weights: { h: weights(h, hSpecs), p: weights(p, pSpecs) }, split: { hitters: ownShare, pitchers: 1 - ownShare }, hitterShare: share,
    perSGP: { h: hRate.perSGP, p: pRate.perSGP }, curve: gamma, lock: p.lock || null,
    twoWay: { mode: twoWay, players: pairs.map((t) => rows.h[t.ih].name) },
    iterations: { h: h.iterations, p: p.iterations }, converged: h.converged && p.converged,
    fillTargets: { h: h.targets, p: p.targets },
    // the last pass's workings, for tools/auction_calculator/sgp_check.py, and the pricing that
    // risk.js prices other values with (each side's drafted slots, last player, curve and rate, and
    // the slots, bench and positions its drafted players are chosen by)
    debug: s.debug ? { h, p, pricing: {
      h: { slot: hSlot, base: hBase, ...hRate, caps: hCaps, bench: benchH, pos: hPos, types: SLOT_TYPES },
      p: { slot: pSlot, base: pBase, ...pRate, caps: pCaps, bench: s.teams * bench - benchH, pos: pPos, types: PITCHER_SLOT_TYPES },
      spare, share, gamma } } : undefined,
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
