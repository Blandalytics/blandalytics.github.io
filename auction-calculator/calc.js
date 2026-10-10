// The auction model: plv_viz auction_calc.py's pipeline, ported. No DOM here, so
// Node can run it against the Python script's output (see README.md).
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

function zValue(table, cats, rateSet, invertSet, sampleIdx, nPlayers, ptCol) {
  const total = new Array(table.n).fill(0);
  for (const cat of cats) {
    const col = table.data[cat];
    const z = rateSet.has(cat)
      ? rateZ(col, table.data[ptCol], sampleIdx, nPlayers)
      : volumeZ(col, sampleIdx.map((i) => col[i]));
    const sign = invertSet.has(cat) ? -1 : 1;
    for (let i = 0; i < table.n; i++) if (!Number.isNaN(z[i])) total[i] += sign * z[i];
  }
  return total;
}

function pointsValue(table, points) {
  const total = new Array(table.n).fill(0);
  for (const [cat, pts] of points) {
    const col = table.data[cat];
    for (let i = 0; i < table.n; i++) if (!Number.isNaN(col[i])) total[i] += col[i] * pts;
  }
  return total;
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
 * caps: { slotType: number of slots in the league }; types: SLOT_TYPES or
 * PITCHER_SLOT_TYPES. Returns per-player replacement (NaN for one no slot takes), the
 * slot each starter fills, and the levels.
 */
export function positionReplacement(raw, posStrings, caps, types_ = SLOT_TYPES) {
  const types = Object.keys(caps).filter((t) => caps[t] > 0);
  const tokens = posStrings.map((p) => p.split(/[,/ ]+/).map((x) => x.trim().toUpperCase()));
  const fits = tokens.map((tok) => types.map((t) => types_[t] === null || types_[t].some((x) => tok.includes(x))));
  const at = types.map(() => []);
  const total = types.reduce((a, t) => a + caps[t], 0);
  let filled = 0;

  const order = [];
  for (let i = 0; i < raw.length; i++) if (!Number.isNaN(raw[i])) order.push(i);
  order.sort((a, b) => raw[b] - raw[a] || a - b);
  for (const i of order) {
    if (filled === total) break;
    // breadth-first over slot types: an open slot, or starters moving along to one
    const prev = new Array(types.length).fill(undefined);
    const queue = [];
    types.forEach((_, k) => { if (fits[i][k]) { prev[k] = null; queue.push(k); } });
    let end = -1;
    while (queue.length) {
      const k = queue.shift();
      if (at[k].length < caps[types[k]]) { end = k; break; }
      for (const j of at[k]) {
        types.forEach((_, m) => { if (prev[m] === undefined && fits[j][m]) { prev[m] = [k, j]; queue.push(m); } });
      }
    }
    if (end < 0) continue;
    let k = end;
    while (prev[k] !== null) {
      const [from, j] = prev[k];
      at[k].push(j);
      at[from].splice(at[from].indexOf(j), 1);
      k = from;
    }
    at[k].push(i);
    filled++;
  }

  // A slot type left short (too few eligible hitters) is as deep as its worst eligible hitter
  const worst = types.map((_, k) => {
    if (at[k].length === caps[types[k]]) return Math.min(...at[k].map((j) => raw[j]));
    const eligible = order.filter((j) => fits[j][k]);
    return eligible.length ? raw[eligible[eligible.length - 1]] : NaN;
  });
  const level = types.map((_, k) => {
    const seen = new Set([k]), stack = [k];
    while (stack.length) {
      const from = stack.pop();
      for (const j of at[from]) {
        types.forEach((_, m) => { if (!seen.has(m) && fits[j][m]) { seen.add(m); stack.push(m); } });
      }
    }
    return Math.min(...[...seen].map((m) => worst[m]));
  });

  const slot = new Array(raw.length).fill(null);
  at.forEach((list, k) => list.forEach((j) => { slot[j] = types[k]; }));
  const repl = new Array(raw.length);
  const valuedAt = new Array(raw.length).fill(null);
  for (let i = 0; i < raw.length; i++) {
    let best = Infinity;
    types.forEach((t, k) => { if (fits[i][k] && level[k] < best) { best = level[k]; valuedAt[i] = t; } });
    repl[i] = best === Infinity ? NaN : best;
  }
  return { repl, slot, valuedAt, levels: types.map((t, k) => ({ slot: t, slots: caps[t], level: level[k], worst: worst[k] })) };
}

/**
 * One side's value above replacement by lineup slot. perTeam: { slotType: slots per team };
 * anyType is the slot that takes anyone (UT, P), which also holds half the bench when it
 * counts. Without position info in the projections every slot takes anyone, as the script's
 * one pool does.
 */
function slotAdjust(raw, posStrings, perTeam, types, anyType, teams, starters, bench) {
  const named = new Set(Object.values(types).flatMap((x) => x || []));
  const known = posStrings.some((p) => p.split(/[,/ ]+/).some((x) => named.has(x.trim().toUpperCase())));
  const caps = {};
  for (const [t, n] of Object.entries(perTeam)) {
    const type = known ? t : anyType;
    caps[type] = (caps[type] || 0) + teams * n;
  }
  caps[anyType] = (caps[anyType] || 0) + Math.trunc(teams * (starters + bench / 2)) - teams * starters;
  const byPos = positionReplacement(raw, posStrings, caps, types);
  const deepest = Math.max(...byPos.levels.map((l) => l.level));
  // A player no slot takes (a DH with no UT) is worth a bench spot at most
  const adj = raw.map((v, i) => (Number.isNaN(byPos.repl[i]) ? Math.min(0, v - deepest) : v - byPos.repl[i]));
  return { adj, byPos, deepest };
}

/** Last entry wins for a category listed twice, as the script's dict does */
const dedupePoints = (rows) => [...new Map(rows.filter(([c]) => c)).entries()];

/**
 * Price every player. s holds the settings:
 *   positions ("slots" | "catchers"), slots and pitcherSlots ({ slotType: per team }, for "slots"),
 *   hitters, pitchers, catchers, bench, minimizeBench, style ("Categories" | "Points"),
 *   teams, minBid, budget, hitterSplit (0-1),
 *   hitterCats, pitcherCats (Categories), hitterPoints, pitcherPoints ([[cat, pts]], Points)
 * In "slots" mode, hitters and pitchers are the sums of their slots and catchers is ignored.
 * Returns { players, hitterCols, pitcherCols, positions }, players sorted by value;
 * positions holds each slot type's replacement level and its price in dollars ("slots").
 */
export function auctionValues(H, P, s) {
  const bench = s.minimizeBench ? 0 : s.bench;
  const points = s.style === "Points";
  const hPoints = points ? dedupePoints(s.hitterPoints) : null;
  const pPoints = points ? dedupePoints(s.pitcherPoints) : null;
  const hitterCats = points ? hPoints.map(([c]) => c) : s.hitterCats;
  const pitcherCats = points ? pPoints.map(([c]) => c) : s.pitcherCats;

  // Replacement is assumed to be ~10% worse than the last player taken
  const hittersAboveRepl = rint(s.teams * (s.hitters + bench / 2) * 1.1);
  // Dollars beyond the minimum bids, split between hitters and pitchers
  const spare = s.teams * s.budget - s.teams * (s.hitters + s.pitchers + s.bench) * s.minBid;
  const hitterDollars = spare * s.hitterSplit;
  const pitcherDollars = spare * (1 - s.hitterSplit);

  // Hitters
  const hSample = nlargestIdx(H.data.PA, hittersAboveRepl);
  const hRaw = points ? pointsValue(H, hPoints)
    : zValue(H, hitterCats, RATE_H, INVERT_H, hSample, s.hitters, "PA");
  const posStrings = H.data["Y! Pos"];
  let hAdj, hByPos = null, hDeepest = 0;
  if (s.positions === "slots") {
    ({ adj: hAdj, byPos: hByPos, deepest: hDeepest } = slotAdjust(hRaw, posStrings, s.slots, SLOT_TYPES, "UT",
      s.teams, s.hitters, bench));
  } else {
    const isC = posStrings.map((p) => p.replaceAll("CF", "").includes("C"));
    // Without position info (or catcher slots) every hitter is priced against one pool
    const catcherSlots = isC.some(Boolean) ? s.catchers : 0;
    const split = catcherSlots > 0;
    const cAdj = nlargestMin(hRaw.filter((_, i) => isC[i]), s.teams * catcherSlots);
    const otherAdj = nlargestMin(hRaw.filter((_, i) => !split || !isC[i]),
      Math.trunc(s.teams * (s.hitters - catcherSlots + bench / 2)));
    hAdj = hRaw.map((v, i) => v - (split && isC[i] ? cAdj : otherAdj));
  }
  const hitterPerValue = hitterDollars / hAdj.reduce((a, v) => (v > 0 ? a + v : a), 0);

  // Pitchers
  const ip = P.data.IP;
  const ipThresh = Math.min(50, nlargestMin(ip, s.teams * s.pitchers));
  const pSample = [];
  for (let i = 0; i < P.n; i++) if (ip[i] >= ipThresh) pSample.push(i);
  const pRaw = points ? pointsValue(P, pPoints)
    : zValue(P, pitcherCats, RATE_P, INVERT_P, pSample, s.pitchers, "IP");
  let pAdj, pByPos = null, pDeepest = 0;
  if (s.positions === "slots") {
    const pPos = P.data["Y! Pos"] ? P.data["Y! Pos"].map((p) => p ?? "P") : new Array(P.n).fill("P");
    ({ adj: pAdj, byPos: pByPos, deepest: pDeepest } = slotAdjust(pRaw, pPos, s.pitcherSlots, PITCHER_SLOT_TYPES, "P",
      s.teams, s.pitchers, bench));
  } else {
    const pRepl = nlargestMin(pRaw, Math.trunc(s.teams * (s.pitchers + bench / 2)));
    pAdj = pRaw.map((v) => v - pRepl);
  }
  const pitcherPerValue = pitcherDollars / pAdj.reduce((a, v) => (v > 0 ? a + v : a), 0);

  const hitterCols = ["PA", ...hitterCats.filter((c) => c !== "PA")];
  const pitcherCols = ["IP", ...pitcherCats.filter((c) => c !== "IP")];
  const players = [];
  const add = (T, raw, adj, perValue, type, cols, byPos) => {
    for (let i = 0; i < T.n; i++) {
      const stats = {};
      for (const c of cols) stats[c] = T.data[c][i];
      players.push({
        type, name: T.data.Name[i] ?? "", mlbamid: T.data.MLBAMID[i], team: T.data.Team[i] ?? "",
        pos: T.data["Y! Pos"] ? (T.data["Y! Pos"][i] ?? (type === "p" ? "P" : "UT")) : "P",
        points: raw[i], value: s.minBid + adj[i] * perValue, stats,
        slot: byPos ? byPos.slot[i] : null, valuedAt: byPos ? byPos.valuedAt[i] : null,
      });
    }
  };
  add(H, hRaw, hAdj, hitterPerValue, "h", hitterCols, hByPos);
  add(P, pRaw, pAdj, pitcherPerValue, "p", pitcherCols, pByPos);

  // Level the dollars so the positive values spend exactly the league's budget
  const projected = players.reduce((a, p) => (p.value > 0 ? a + p.value : a), 0);
  const fudge = (s.teams * s.budget) / projected;
  for (const p of players) p.value *= fudge;

  players.sort((a, b) => (Number.isNaN(a.value) ? 1 : Number.isNaN(b.value) ? -1 : b.value - a.value));
  rankDescending(players);

  // Each slot type's scarcity in dollars: how much more a player there is worth than the
  // same player at his side's deepest position
  let positions = null;
  if (hByPos) {
    const premiums = (byPos, deepest, perValue, side) => byPos.levels
      .map((l) => ({ ...l, side, premium: (deepest - l.level) * perValue * fudge }))
      .sort((a, b) => b.premium - a.premium);
    positions = [...premiums(hByPos, hDeepest, hitterPerValue, "h"), ...premiums(pByPos, pDeepest, pitcherPerValue, "p")];
  }
  return { players, hitterCols, pitcherCols, positions };
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
