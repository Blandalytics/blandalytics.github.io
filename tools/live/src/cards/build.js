/**
 * One pitcher's card dict from a live game: the Worker's build_data.py.
 *
 * Takes the game's feed (box score, bio, teams), its rows (feed.js), the scorer's
 * per-pitch values (scorer.js), the xSLG model, the pitcher's arm angles and his pack
 * of comparison seasons (written nightly by the Python pipeline), and returns the same
 * dict build_data.build returns (version 2: numbers, formatted by the renderer). The
 * per-pitch metrics follow prep.py, keeping its float32 arithmetic where the scraper's
 * float32 columns carry it (see npf.js).
 *
 * The comparison regions are the one approximation. Python draws them from the season's
 * pitches of the types thrown in this game, at this game's flight times; the pack holds
 * each season's regions for the whole repertoire at the season's own flight times, and
 * they are scaled here to the game's. The nightly card is exact.
 */

import {
  binIndex, f32, fixed, groupMean32, groupMean64, round32, round64, seriesMean, seriesSum,
} from "./npf.js";

export const PITCH_TYPE_MAP = {
  FF: "FF", FA: "FF", SI: "SI", FT: "SI", FC: "FC", SL: "SL", ST: "ST", CH: "CH", SC: "CH",
  CU: "CU", KC: "CU", CS: "CU", SV: "CU", FS: "FS", FO: "FS", KN: "KN", UN: "UN", EP: "UN",
};
const DESC_MAP = {
  S: "swinging_strike", W: "swinging_strike", T: "swinging_strike", M: "swinging_strike",
  O: "swinging_strike", C: "called_strike", F: "foul_strike", L: "foul_strike", D: "in_play",
  E: "in_play", X: "in_play", B: "ball", "*B": "ball", P: "ball", 1: "pickoff", 2: "pickoff",
  3: "pickoff", H: "hit_by_pitch", PSO: "step_off",
};
const SWINGS = new Set(["swinging_strike", "foul_strike", "in_play"]);
const STRIKES = new Set(["called_strike", ...SWINGS]);
const TRACKING = [
  "sz_top", "sz_bot", "velo", "extension", "plate_time", "HB", "IVB", "spin_rate", "spin_dir",
  "pX", "pZ", "x0", "z0", "vY0", "vZ0", "aY", "aZ",
];
const LOCATION = ["sz_top", "sz_bot", "pX", "pZ"];
const GAME_TYPE_LABEL = {
  R: "Box Score", S: "Spring\nTraining", E: "Exhibition", A: "All-Star\nGame", F: "Playoffs",
  D: "Playoffs", L: "Playoffs", W: "World\nSeries",
};
const TEAM_ABBR = { AZ: "ARI", KC: "KCR", SD: "SDP", SF: "SFG", TB: "TBR" };
const LETTERS = ["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
// grades.GRADE_CUTS: Stuff, Location and PLV, each fitted by grade_cuts.py
const GRADE_CUTS = {
  stuff: [77.7, 81.2, 84.3, 86.9, 89, 91.8, 94.6, 98, 101.9, 106.3, 111.6, 122.4],
  loc: [85.3, 89.1, 92.1, 94.5, 96.4, 98.9, 101.1, 103.7, 106.3, 109.3, 112.6, 118.3],
  plv: [83.5, 87.3, 90.2, 92.5, 94.5, 97, 99.4, 102, 104.8, 108.2, 111.9, 118.8],
};
const SP_CUTS = [12, 22.3, 30, 36.6, 41, 47.6, 53.6, 60.6, 67, 74, 82.3, 95];
const RP_CUTS = [27, 37, 42, 46, 48, 50, 51, 52, 53, 56, 61, 67];
// reliever game-score weights by inning (4-9) and run-differential bucket (0-3), grades.py
const RP_WEIGHTS = {
  out: [[3, 3, 2, 1], [4, 3, 2, 1], [4, 3, 2, 1], [4, 3, 2, 1], [5, 3, 2, 1], [6, 4, 2, 1]],
  strikeout: [[3, 2, 2, 1], [4, 3, 2, 1], [4, 3, 2, 1], [5, 4, 2, 1], [6, 4, 2, 1], [9, 7, 6, 1]],
  walk: [[-3, -2, -2, -1], [-3, -2, -2, -1], [-3, -3, -2, -1], [-4, -3, -2, -1], [-4, -3, -2, -1], [-5, -4, -2, -1]],
  hit: [[-8, -7, -6, -2], [-10, -9, -6, -2], [-11, -8, -6, -2], [-12, -8, -5, -2], [-15, -8, -5, -1], [-21, -9, -4, -1]],
  home_run: [[-17, -14, -11, -4], [-21, -18, -14, -4], [-23, -17, -12, -3], [-26, -17, -11, -3], [-33, -18, -9, -2], [-43, -18, -8, -1]],
};
export const MIN_GAMES = 3; // a season needs this many appearances to be offered as a comparison
const DEFAULT_HEIGHT = 6.25; // feet, as the original assumed when a height was unavailable
// pitch_model.GRADES: the card's column, the run value and the aggregation its scale is from
const GRADES = [
  ["plvStuff+", "stuff_rv", "pitcher_game_pitch_type"],
  ["PLV+", "pitching_rv", "pitcher_game_pitch_type"],
  ["stuffGrade_game", "stuff_rv", "pitcher_game"],
  ["locGrade_game", "location_rv", "pitcher_game"],
  ["plvGrade_game", "pitching_rv", "pitcher_game"],
];
const TABLE_STATS = ["Velo", "IVB", "HB", "Str%", "SwStr%", "CSW%", "xSLGcon", "plvStuff+", "PLV+"];
const missing = (v) => v === null || v === undefined || Number.isNaN(v);
const num = (v) => (missing(v) ? null : v);

// ---- the feed ------------------------------------------------------------------------
/** The `fields` names gameInfo reads, beyond feed.js's ROW_FIELDS: bio and box score. */
export const CARD_FIELDS = [
  "status", "codedGameState", "detailedState", "players", "fullName", "currentAge", "height",
  "boxscore", "pitchers", "stats", "pitching", "inningsPitched", "earnedRuns", "hits",
  "homeRuns", "baseOnBalls", "strikeOuts", "numberOfPitches", "gamesStarted", "outs",
  "battersFaced",
];

export function parseHeight(text) {
  const m = /^\s*(\d+)'\s*(\d+)\s*$/.exec(String(text ?? "").replace(/"/g, ""));
  return m ? Number(m[1]) + Number(m[2]) / 12 : DEFAULT_HEIGHT;
}

/** game_info: who, where and the box-score line. */
export function gameInfo(feed, pid) {
  const gd = feed.gameData;
  const box = feed.liveData.boxscore;
  const side = ["home", "away"].find((s) => box.teams[s].pitchers.includes(pid));
  const opp = side === "home" ? "away" : "home";
  const player = gd.players[`ID${pid}`];
  const abbr = (s) => TEAM_ABBR[gd.teams[s].abbreviation] ?? gd.teams[s].abbreviation;
  return {
    name: player.fullName,
    hand: player.pitchHand.code,
    age: player.currentAge,
    height: parseHeight(player.height),
    team: abbr(side),
    opp: abbr(opp),
    home: side === "home",
    date: gd.datetime.officialDate,
    game_type: gd.game.type,
    label: GAME_TYPE_LABEL[gd.game.type] ?? "Box Score",
    starter: box.teams[side].pitchers[0] === pid,
    box: box.teams[side].players[`ID${pid}`].stats.pitching,
  };
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function gameLine(box, p) {
  const hr = box.homeRuns ? ` (${box.homeRuns} HR)` : "";
  const whiffs = seriesSum(p.map((r) => r.sw_str));
  const csw = seriesMean(p.map((r) => r.csw)) * 100;
  return `${box.inningsPitched} IP, ${box.earnedRuns} ER, ${count(box.hits, "Hit", "Hits")}${hr}, `
    + `${count(box.baseOnBalls, "BB", "BBs")}, ${count(box.strikeOuts, "K", "Ks")} - `
    + `${count(whiffs, "Whiff", "Whiffs")}, ${fixed(csw, 0)}% CSW, ${box.numberOfPitches} Pitches`;
}

// ---- grades.py -------------------------------------------------------------------------
export function letterGrade(v, grade) {
  return missing(v) ? "-" : LETTERS[binIndex(v, GRADE_CUTS[grade])];
}

function runDiffBucket(field, bat) {
  const diff = Math.max(-3, Math.min(4, field - bat));
  return diff > 0 ? diff - 1 : Math.abs(diff);
}

function gameGrade(box, inning, bucket) {
  const relief = (box.gamesStarted === 0 && box.outs < 11) || box.battersFaced <= 6;
  if (!relief) {
    const score = 30 + (8 / 3) * box.outs + 2 * box.strikeOuts - 2 * box.baseOnBalls - box.hits
      - 7 * box.earnedRuns - box.homeRuns;
    return LETTERS[binIndex(score, SP_CUTS)];
  }
  const w = (k) => RP_WEIGHTS[k][Math.max(4, Math.min(9, inning)) - 4][bucket];
  const score = 50 + (box.outs - box.strikeOuts) * w("out") + box.strikeOuts * w("strikeout")
    + box.baseOnBalls * w("walk") + box.hits * w("hit") + box.homeRuns * w("home_run");
  return LETTERS[binIndex(score, RP_CUTS)];
}

/** outing_grade: a relief outing is scored by the situation the pitcher entered in. */
function outingGrade(box, p) {
  const first = p[0];
  return gameGrade(box, first.inning, runDiffBucket(first.post_field_score, first.post_bat_score));
}

// ---- prep.py -----------------------------------------------------------------------------
/** prep.base: the scraper's columns renamed, mapped pitch types and outcome families, the
 * count before each pitch (from this pitcher's previous pitch in the plate appearance),
 * the zone flag and horizontal break arm-side positive. */
function base(rows) {
  let prev = null;
  return rows.map((r) => {
    const same = prev && prev.game_pk === r.game_pk && prev.at_bat_index === r.at_bat_index;
    const balls = same && !missing(prev.balls) ? prev.balls : 0;
    const strikes = same && !missing(prev.strikes) ? prev.strikes : 0;
    prev = r;
    return {
      game_pk: r.game_pk, abi: r.at_bat_index, pitch_no: r.pitch_number, inning: r.inning,
      stand: r.stand, hand: r.p_throws, sz_top: r.sz_top, sz_bot: r.sz_bot, plate_time: r.plate_time,
      launch_speed: r.launch_speed, launch_angle: r.launch_angle,
      post_bat_score: r.post_bat_score, post_field_score: r.post_field_score,
      velo: r.release_speed, extension: r.release_extension, spin_rate: r.release_spin_rate,
      spin_dir: r.spin_axis, pX: r.plate_x, pZ: r.plate_z, x0: r.release_pos_x, z0: r.release_pos_z,
      vY0: r.vy0, vZ0: r.vz0, aY: r.ay, aZ: r.az, IVB: r.ivb,
      raw_type: r.pitch_type,
      pitchType: PITCH_TYPE_MAP[r.pitch_type] ?? "UN",
      desc: DESC_MAP[r.det_code] ?? null,
      balls: Math.min(Math.max(balls, 0), 3),
      strikes: Math.min(Math.max(strikes, 0), 2),
      HB: r.p_throws === "R" ? r.hb : -r.hb,
    };
  });
}

/** prep.flags: strike / swing / whiff, and the batter's side, as 0-1 (NaN when undefined). */
function flags(p) {
  p.sw_str = p.desc === "swinging_strike" ? 1 : 0;
  p.csw = p.desc === "called_strike" || p.desc === "swinging_strike" ? 1 : 0;
  p.strike = STRIKES.has(p.desc) ? 1 : 0;
  p.vRHH = p.stand === "R" ? 1 : NaN;
  p.vLHH = p.stand === "L" ? 1 : NaN;
}

/** prep.strikezone: height mapped onto one standard zone for the plot (float32). */
function strikezone(p) {
  const mid = f32(f32(p.sz_top + p.sz_bot) / 2);
  const szZ = f32(f32(p.pZ - mid) / f32(p.sz_top - p.sz_bot));
  if (p.pZ <= f32(p.sz_bot + 0.25)) p.sz_plot_z = f32(f32(p.pZ - p.sz_bot) + 1.5);
  else if (p.pZ >= f32(p.sz_top - 0.25)) p.sz_plot_z = f32(f32(p.pZ - p.sz_top) + 3.5);
  else p.sz_plot_z = f32(f32(szZ * 2) + 2.5);
}

const PLATE_DROP = f32(50 - 17 / 12);
const DEGREES32 = f32(f32(180) / f32(Math.PI)); // np.degrees' float32 factor
const [A1, A0, B2, B1, B0] = [1.5635, 10.092, -0.1996, 2.704, 11.69].map(f32);

/** prep.approach_angles: VAA, and HAVAA against the height-expected VAA (float32). */
function approachAngles(p) {
  const vyF = -f32(Math.sqrt(f32(f32(p.vY0 * p.vY0) - f32(f32(2 * p.aY) * PLATE_DROP))));
  const t = f32(f32(vyF - p.vY0) / p.aY);
  const vzF = f32(p.vZ0 + f32(p.aZ * t));
  const vaa = -f32(f32(Math.atan(f32(vzF / vyF))) * DEGREES32);
  const z = p.pZ;
  const expected = z < 3.5
    ? f32(f32(z * A1) - A0)
    : f32(f32(f32(B2 * f32(z * z)) + f32(B1 * z)) - B0);
  p.HAVAA = f32(vaa - expected);
}

/** prep.movement: break as acceleration, independent of flight time. */
function movement(p) {
  const t2 = f32(p.plate_time * p.plate_time);
  p.HB_acc = p.HB / t2; // HB is float64, so this one is too
  p.IVB_acc = f32(p.IVB / t2);
}

function prepare(rows, arm) {
  return base(rows).map((p) => {
    p.armAngle = arm?.[p.raw_type] ?? NaN;
    flags(p);
    strikezone(p);
    approachAngles(p);
    movement(p);
    return p;
  });
}

// ---- scoring ---------------------------------------------------------------------------
/** The card's model columns per pitch (the scale is affine, so a mean of them is the
 * unit's number), blanked where the tracking data the models need is missing. */
function scoreColumns(p, values, scale, xslg) {
  const plus = (rv, column, level) => {
    if (missing(rv)) return NaN;
    const stat = scale.aggregations[level].columns[column];
    return scale.plus.mean + (scale.plus.sd * (100 * rv - stat.mean)) / stat.sd;
  };
  for (const r of p) {
    const v = values.get(`${r.abi}:${r.pitch_no}`);
    for (const [col, rv, level] of GRADES) r[col] = v ? plus(v[rv], rv, level) : NaN;
    r.xSLGcon = missing(r.launch_speed) || missing(r.launch_angle) ? NaN : xslg(r.launch_speed, r.launch_angle);
    if (TRACKING.some((c) => missing(r[c]))) {
      for (const c of ["plvStuff+", "PLV+", "stuffGrade_game", "plvGrade_game"]) r[c] = NaN;
    }
    if (LOCATION.some((c) => missing(r[c]))) r.locGrade_game = NaN;
  }
}

function gradeSummary(p) {
  const mean = (col, side) => seriesMean(p.filter((r) => !side || r.stand === side).map((r) => r[col]));
  return {
    stuff: letterGrade(mean("stuffGrade_game"), "stuff"),
    loc: letterGrade(mean("locGrade_game"), "loc"),
    plv: letterGrade(mean("plvGrade_game"), "plv"),
    loc_vl: letterGrade(mean("locGrade_game", "L"), "loc"),
    loc_vr: letterGrade(mean("locGrade_game", "R"), "loc"),
  };
}

// ---- the tables ------------------------------------------------------------------------
function byType(p) {
  const groups = new Map();
  for (const r of p) {
    if (!groups.has(r.pitchType)) groups.set(r.pitchType, []);
    groups.get(r.pitchType).push(r);
  }
  return groups;
}

/** _shares: usage overall and against each side, in percent. */
function shares(t) {
  const n = t.reduce((s, r) => s + r.n, 0);
  const vR = t.reduce((s, r) => s + r.vRHH, 0);
  const vL = t.reduce((s, r) => s + r.vLHH, 0);
  for (const r of t) {
    r["Usage%"] = (r.n / n) * 100;
    r.vsR = vR ? (r.vRHH / vR) * 100 : NaN;
    r.vsL = vL ? (r.vLHH / vL) * 100 : NaN;
  }
}

/** n desc, as pandas' sort leaves equal counts in the groupby's alphabetical order. */
const byCount = (a, b) => b.n - a.n || (a.pitchType < b.pitchType ? -1 : 1);

/** prep.game_table: one row per pitch type, most thrown first, rounded as the card shows. */
function gameTable(p) {
  const t = [];
  for (const [pitchType, g] of byType(p)) {
    const col = (c) => g.map((r) => r[c]);
    t.push({
      pitchType,
      n: g.length,
      vRHH: seriesSumGroup(col("vRHH")),
      vLHH: seriesSumGroup(col("vLHH")),
      Velo: groupMean32(col("velo")),
      Ext: groupMean32(col("extension")),
      IVB: groupMean32(col("IVB")),
      HB: groupMean64(col("HB")),
      IVB_acc: groupMean32(col("IVB_acc")),
      HB_acc: groupMean64(col("HB_acc")),
      HAVAA: groupMean32(col("HAVAA")),
      "Str%": groupMean64(col("strike")) * 100,
      "SwStr%": groupMean64(col("sw_str")) * 100,
      "CSW%": groupMean64(col("csw")) * 100,
      xSLGcon: groupMean64(col("xSLGcon")),
      "plvStuff+": groupMean64(col("plvStuff+")),
      "PLV+": groupMean64(col("PLV+")),
    });
  }
  t.sort(byCount);
  shares(t);
  for (const r of t) {
    for (const c of ["Velo", "Ext", "IVB", "HAVAA"]) r[c] = round32(r[c], 1);
    for (const c of ["vsL", "Usage%", "vsR", "HB", "Str%", "SwStr%", "CSW%"]) r[c] = round64(r[c], 1);
    r.xSLGcon = round64(r.xSLGcon, 3);
    r["plvStuff+"] = round64(r["plvStuff+"], 0);
    r["PLV+"] = round64(r["PLV+"], 0);
  }
  return t;
}

/** pandas' groupby sum skips NaN and gives 0 for an all-NaN group. */
function seriesSumGroup(values) {
  return values.reduce((s, v) => (Number.isNaN(v) ? s : s + v), 0);
}

function typeRows(table) {
  return table.map((r) => ({
    code: r.pitchType,
    n: r.n,
    usage: num(r["Usage%"]),
    vsR: num(r.vsR),
    vsL: num(r.vsL),
    values: Object.fromEntries(TABLE_STATS.map((s) => [s, num(r[s])])),
  }));
}

function fastballPanel(table) {
  const r = table.find((x) => ["FF", "SI", "FC"].includes(x.pitchType));
  if (!r) return null;
  const keys = ["Velo", "Ext", "IVB", "HB", "HAVAA", "IVB_acc", "HB_acc"];
  return { code: r.pitchType, values: Object.fromEntries(keys.map((k) => [k, num(r[k])])) };
}

// ---- comparison seasons ----------------------------------------------------------------
/** A path from shapes.py (absolute start, relative moves in tenths of an inch) scaled
 * about the origin, re-encoded the same way. */
export function scalePath(d, k) {
  const tenths = (v) => {
    const s = (v / 10).toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2).replace(/^-0$/, "0") : s;
  };
  return d.split("Z").filter((ring) => ring.trim()).map((ring) => {
    let x = 0;
    let y = 0;
    let last = null;
    const parts = [];
    for (const m of ring.trim().matchAll(/([Ml])(-?[\d.]+),(-?[\d.]+)/g)) {
      const [dx, dy] = [Number(m[2]), Number(m[3])];
      [x, y] = m[1] === "M" ? [dx, dy] : [x + dx, y + dy];
      const pt = [Math.round(x * k * 10), Math.round(y * k * 10)];
      parts.push(last ? `l${tenths(pt[0] - last[0])},${tenths(pt[1] - last[1])}` : `M${tenths(pt[0])},${tenths(pt[1])}`);
      last = pt;
    }
    return parts.join(" ") + "Z";
  }).join(" ");
}

/**
 * One season from the pitcher's pack against this game: the season's usage over the
 * types he threw today (prep.season_table + prep.compare) and its regions, scaled from
 * the season's flight times to today's.
 */
function comparison(table, plateTimes, season) {
  const types = table
    .map((r) => r.pitchType)
    .filter((t) => season.types[t] && !Number.isNaN(plateTimes.get(t)));
  const szn = types.map((t) => ({ pitchType: t, ...season.types[t] }));
  const vR = szn.reduce((s, r) => s + r.vRHH, 0);
  const vL = szn.reduce((s, r) => s + r.vLHH, 0);
  const sznBy = new Map(szn.map((r) => [r.pitchType, {
    vsR: round64(vR ? (r.vRHH / vR) * 100 : NaN, 1),
    vsL: round64(vL ? (r.vLHH / vL) * 100 : NaN, 1),
    Velo: round32(r.velo, 1),
  }]));
  const arrow = (d) => (d > 0 ? "↑" : d < 0 ? "↓" : "");
  const out = {};
  for (const r of table) {
    const s = sznBy.get(r.pitchType);
    const diff = (k) => (s && !Number.isNaN(s[k]) ? r[k] - s[k] : r[k] - r[k]);
    out[r.pitchType] = {
      vsR_arrow: arrow(diff("vsR")),
      vsL_arrow: arrow(diff("vsL")),
      velo_diff: num(f32(diff("Velo"))),
    };
  }
  const shapes = {};
  for (const t of types) {
    const paths = season.shapes?.[t];
    if (!paths?.length) continue;
    const k = (plateTimes.get(t) / season.types[t].plate_time) ** 2;
    shapes[t] = paths.map((d) => scalePath(d, k));
  }
  return { year: season.year, shapes, types: out };
}

function comparisons(p, table, pack) {
  if (!pack) return [];
  const plateTimes = new Map([...byType(p)].map(([t, g]) => [t, groupMean32(g.map((r) => r.plate_time))]));
  return [...pack.seasons]
    .sort((a, b) => b.year - a.year)
    .filter((s) => s.games >= MIN_GAMES)
    .map((s) => comparison(table, plateTimes, s));
}

// ---- the plots ---------------------------------------------------------------------------
function plotPoints(p) {
  const clip = (v, lo, hi) => (Number.isNaN(v) ? v : Math.min(Math.max(v, lo), hi));
  return p.map((r) => ({
    t: r.pitchType,
    hb: num(r.HB * (r.hand === "R" ? 1 : -1)),
    ivb: num(r.IVB),
    x: num(clip(-r.pX, -2, 2)),
    z: num(clip(r.sz_plot_z, -0.25, 5.25)),
    stand: r.stand,
  }));
}

function chartLimit(p) {
  const vals = p.flatMap((r) => [Math.abs(r.HB), Math.abs(r.IVB)]).filter((v) => !Number.isNaN(v));
  if (!vals.length) return 29;
  return Math.max(29, Math.trunc(Math.max(...vals) / 6 + 2) * 6 - 1);
}

// ---- the card --------------------------------------------------------------------------
/**
 * build: the card dict for one pitcher. `rows` are that pitcher's rows from gameRows;
 * `values` the game's scorer output; `xslg(launchSpeed, launchAngle)` expected total
 * bases; `arm` {raw pitch type: arm angle}; `pack` his comparison seasons or null.
 */
export function build({ feed, pitcherId, rows, values, scale, xslg, arm, pack }) {
  const info = gameInfo(feed, pitcherId);
  const p = prepare(rows, arm);
  scoreColumns(p, values, scale, xslg);
  const table = gameTable(p);
  const [y, m, d] = info.date.split("-").map(Number);
  const at = info.home ? "vs" : "@";
  const sum = (c) => seriesSum(p.map((r) => r[c]));
  return {
    version: 2,
    game_pk: rows[0].game_pk,
    pitcher_id: pitcherId,
    name: info.name, hand: info.hand, age: info.age, team: info.team, opp: info.opp,
    home: info.home, date: info.date, label: info.label,
    starter: info.starter,
    title: `Pitcher Performance: ${m}/${d}/${y} ${at} ${info.opp}`,
    bio: `${info.hand}HP | ${info.team} | Age: ${info.age}`,
    line: gameLine(info.box, p),
    grades: { game: outingGrade(info.box, p), ...gradeSummary(p) },
    n_vl: sum("vLHH"),
    n_vr: sum("vRHH"),
    arm_angle: num(seriesMean(p.map((r) => r.armAngle))),
    chart_lim: chartLimit(p),
    fastball: fastballPanel(table),
    types: typeRows(table),
    pitches: plotPoints(p),
    missing_data: p.some((r) => TRACKING.some((c) => missing(r[c]))),
    comparisons: comparisons(p, table, pack),
  };
}

