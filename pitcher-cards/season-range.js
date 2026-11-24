// SeasonRange: a season card over part of a pitcher's season, pooled in the browser from his
// pitch file (tools/pitcher_card/season.py's pitch_file: his season game by game, with every
// pitch) as season.py's build() pools the whole season's, for the Season Cards page's date
// range. Each function here is build()'s namesake there, line for line, so a card over the
// whole season comes out as the published one (to the pitch file's rounding). Two things
// differ: the plots are each type's pitches, not its KDE regions (season.py's contours are
// a later port), and the summary line is the range's, from MLB's Stats API (byDateRange).
//
//   SeasonRange.games(file, from, to, stint)  the file's games in [from, to] (ISO dates, either
//                                             blank for open), one team's for a stint key
//   SeasonRange.statsUrl(file, from, to)      the Stats API request for the range's lines
//   SeasonRange.lines(response)               its lines by team id (null: the total)
//   SeasonRange.build(file, games, opts)      the card dict; opts: {from, to, lines, scale, stint}
//
// A classic <script> after card.js defines window.SeasonRange; require() returns the same.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./card.js"));
  else root.SeasonRange = factory(root.PitcherCard);
})(typeof self !== "undefined" ? self : this, (PC) => {
  "use strict";

  const STATSAPI = "https://statsapi.mlb.com/api/v1";
  const FASTBALLS = ["FF", "SI", "FC"];
  const LEVELS = { mlb: [1, "MLB"], aaa: [11, "Triple-A"], afx: [14, "Single-A"] };
  // grades.DESC_MAP: a pitch's call to its outcome family
  const DESC = {
    S: "swinging_strike", W: "swinging_strike", T: "swinging_strike", M: "swinging_strike",
    O: "swinging_strike", C: "called_strike", F: "foul_strike", L: "foul_strike", D: "in_play",
    E: "in_play", X: "in_play", B: "ball", "*B": "ball", P: "ball", 1: "pickoff", 2: "pickoff",
    3: "pickoff", H: "hit_by_pitch", PSO: "step_off",
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // _num: round(float(v), n) as Python rounds, or float(v); None for a blank
  function num(v, n) {
    if (v == null || v !== v) return null;
    return n == null ? +v : Number(PC.fixed(+v, n));
  }
  function mean(values) {
    let s = 0, c = 0;
    for (const v of values) if (v != null) { s += v; c++; }
    return c ? s / c : null;
  }
  function weighted(pairs) {
    const ps = pairs.filter(([v, n]) => v != null && n);
    const w = ps.reduce((a, [, n]) => a + n, 0);
    let s = 0;
    for (const [v, n] of ps) s += v * n;
    return w ? s / w : null;
  }
  const pct = (part, whole, digits = 1) => (whole ? num((100 * part) / whole, digits) : null);
  const desc = (p) => DESC[p.d];
  const count = (xs, f) => xs.reduce((a, x) => a + (f(x) ? 1 : 0), 0);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ---- which games ----
  // the file's games as season.py's cards: each pitch a dict of the file's keys
  function unpack(file) {
    if (!file._games) {
      file._games = file.games.map((g) => ({
        ...g, pitches: g.pitches.map((row) => Object.fromEntries(file.keys.map((k, i) => [k, row[i]]))),
      }));
    }
    return file._games;
  }
  // stints(): each team's games in the order he pitched for it, named by its last game's team
  function stints(games) {
    const by = new Map();
    for (const g of games) {
      if (!by.has(g.team_id)) by.set(g.team_id, []);
      by.get(g.team_id).push(g);
    }
    return [...by].map(([tid, gs]) => ({ tid, team: gs[gs.length - 1].team, games: gs }));
  }
  // the games in [from, to]; a stint key (<id>-<team>) keeps that team's part of the season
  function games(file, from, to, stint) {
    let gs = unpack(file);
    if (stint) {
      const part = stints(gs).filter((p) => p.team === stint)[0];
      gs = part ? part.games : [];
    }
    return gs.filter((g) => (!from || g.date >= from) && (!to || g.date <= to));
  }

  // ---- the summary line's stats ----
  function statsUrl(file, from, to) {
    const sport = (LEVELS[file.level] || LEVELS.mlb)[0];
    const start = from || `${file.season}-01-01`, end = to || `${file.season}-12-31`;
    const h = `stats(group=[pitching],type=[byDateRange],startDate=${start},endDate=${end},gameType=[R],sportId=${sport})`;
    return `${STATSAPI}/people/${file.pitcher_id}?hydrate=${encodeURIComponent(h)}`;
  }
  // season.py's person().lines: by team id, and the range's total at null (a traded
  // pitcher's total, else his one line)
  function lines(response) {
    const p = ((response && response.people) || [])[0] || {};
    const out = new Map();
    for (const st of p.stats || []) for (const x of st.splits || []) out.set((x.team || {}).id ?? null, x.stat);
    if (!out.has(null) && out.size === 1) out.set(null, [...out.values()][0]);
    return out;
  }
  const share = (part, whole) => (part != null && whole ? (100 * part) / whole : null);
  const segment = (value, unit, digits) => (value == null ? "-" : digits == null ? String(value) : PC.fixed(value, digits)) + unit;
  function summary(stat, pitches) {
    stat = stat || {};
    const bf = stat.battersFaced;
    const called = count(pitches, (p) => ["called_strike", "swinging_strike"].includes(desc(p)));
    const csw = (100 * called) / pitches.length;
    const nums = {
      IP: stat.inningsPitched ?? null, ERA: stat.era ?? null, WHIP: stat.whip ?? null,
      K: stat.strikeOuts ?? null, "K%": share(stat.strikeOuts, bf), "BB%": share(stat.baseOnBalls, bf), "CSW%": csw,
    };
    const segments = [
      segment(nums.IP, " IP"), segment(nums.ERA, " ERA"), segment(nums.WHIP, " WHIP"), segment(nums.K, " Ks"),
      segment(nums["K%"], "% K", 1), segment(nums["BB%"], "% BB", 1), segment(csw, "% CSW", 1),
    ];
    const isFloat = (v) => typeof v === "number" && !Number.isInteger(v);
    const stats = {};
    for (const [k, v] of Object.entries(nums)) stats[k] = isFloat(v) || k.endsWith("%") ? num(v, 3) : v;
    return [segments, stats];
  }

  // ---- the pooled card ----
  function typeRows(pitches, hand, scale) {
    const sign = hand === "R" ? 1 : -1;
    const by = new Map();
    for (const p of pitches) {
      if (!by.has(p.t)) by.set(p.t, []);
      by.get(p.t).push(p);
    }
    const sides = { L: count(pitches, (p) => p.stand === "L"), R: count(pitches, (p) => p.stand === "R") };
    const swing = ["swinging_strike", "foul_strike", "in_play"];
    const digits = { xSLGcon: 3, "plvStuff+": 0, "PLV+": 0 };
    return [...by].sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0])).map(([code, ps]) => {
      const d = ps.map(desc);
      const values = {
        Velo: mean(ps.map((p) => p.velo)),
        IVB: mean(ps.map((p) => p.ivb)),
        HB: mean(ps.map((p) => (p.hb != null ? p.hb * sign : null))),
        "Str%": (100 * count(d, (x) => x === "called_strike" || swing.includes(x))) / ps.length,
        "SwStr%": (100 * count(d, (x) => x === "swinging_strike")) / ps.length,
        "CSW%": (100 * count(d, (x) => x === "called_strike" || x === "swinging_strike")) / ps.length,
        xSLGcon: mean(ps.map((p) => p.xSLGcon)),
        "plvStuff+": mean(ps.map((p) => p["plvStuff+"])),
        "PLV+": mean(ps.map((p) => p["PLV+"])),
      };
      for (const [stat, [a, b]] of Object.entries(scale)) values[stat] = values[stat] == null ? null : a + b * values[stat];
      const out = {};
      for (const [k, v] of Object.entries(values)) out[k] = num(v, k in digits ? digits[k] : 1);
      return {
        code, n: ps.length, usage: pct(ps.length, pitches.length),
        vsR: pct(count(ps, (p) => p.stand === "R"), sides.R), vsL: pct(count(ps, (p) => p.stand === "L"), sides.L),
        values: out,
      };
    });
  }

  function fastball(rows, gs) {
    const fb = rows.filter((r) => FASTBALLS.includes(r.code))[0];
    if (!fb) return null;
    const values = { Velo: fb.values.Velo, IVB: fb.values.IVB, HB: fb.values.HB };
    const led = gs.filter((g) => (g.fastball || {}).code === fb.code)
      .map((g) => [g.fastball.values, count(g.pitches, (p) => p.t === fb.code)]);
    for (const k of ["Ext", "HAVAA", "IVB_acc", "HB_acc"]) {
      values[k] = num(weighted(led.map(([v, n]) => [v[k], n])), k === "Ext" || k === "HAVAA" ? 1 : null);
    }
    return { code: fb.code, values };
  }

  function seasonSkills(gs) {
    const out = {};
    for (const k of ["stuff", "loc", "plv", "loc_vl", "loc_vr"]) out[k] = weighted(gs.map((g) => [g.skills[k], g.graded[k]]));
    return out;
  }

  function chartLimit(pitches) {
    let biggest = null;
    for (const p of pitches) for (const k of ["hb", "ivb"]) if (p[k] != null) biggest = Math.max(biggest ?? -Infinity, Math.abs(p[k]));
    return biggest == null ? 29 : Math.max(29, Math.trunc(biggest / 6 + 2) * 6 - 1);
  }

  // each type's points in one plot, in `order`; a pitch missing either is left out
  function byType(pitches, xk, yk, order, unit, digits) {
    const out = [];
    for (const code of order) {
      const pts = pitches.filter((p) => p.t === code && p[xk] != null && p[yk] != null)
        .map((p) => [num(p[xk] * unit, digits), num(p[yk] * unit, digits)]);
      if (pts.length) out.push({ code, points: pts });
    }
    return out;
  }
  // movement_layers / location_plots, as pitches: Movement most thrown first; a location
  // plot least thrown to that side first, so the most thrown lies on top. None is listed as
  // scattered: the card's "<20 pitches shown as scatter" note is for a few types among regions
  function plots(pitches, order) {
    const out = { movement: byType(pitches, "hb", "ivb", order, 1, 2), min: 20, scattered: { L: [], R: [] } };
    for (const side of ["L", "R"]) {
      const faced = pitches.filter((p) => p.stand === side);
      const usage = (c) => count(faced, (p) => p.t === c);
      const ranked = order.map((c, i) => [c, i]).sort((a, b) => usage(a[0]) - usage(b[0]) || a[1] - b[1]).map((x) => x[0]);
      out[side] = byType(faced, "x", "z", ranked, 12, 1);
    }
    return out;
  }

  function niceDate(iso) {
    const [, m, d] = iso.split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}`;
  }
  // season_age: his age on June 30 of the season
  function seasonAge(birth, year) {
    if (!birth) return null;
    const [y, m, d] = birth.split("-").map(Number);
    return year - y - (m > 6 || (m === 6 && d > 30) ? 1 : 0);
  }

  // the card for `gs` (games() of the file); opts.lines from lines(), opts.scale the season
  // index's scale, opts.stint the team of a stint key, opts.from / opts.to the range asked for
  function build(file, gs, opts) {
    const { from = "", to = "", scale = {}, stint = null } = opts;
    const lineMap = opts.lines || new Map();
    const level = LEVELS[file.level] || LEVELS.mlb;
    const last = gs[gs.length - 1];
    const pitches = gs.flatMap((g) => g.pitches);
    const rows = typeRows(pitches, file.hand, scale);
    const order = rows.map((r) => r.code);
    const parts = stints(gs);
    const teams = parts.map((p) => p.team);
    // pitcher_cards(): one team's games take that team's line, else the total
    const line = stint ? lineMap.get(parts.length ? parts[0].tid : null)
      : (parts.length === 1 ? lineMap.get(parts[0].tid) : null) || lineMap.get(null);
    const [segments, stats] = summary(line, pitches);
    const arm = weighted(gs.map((g) => [g.arm_angle, g.pitches.length]));
    const org = last.org || null;
    const team = file.level === "mlb" ? teams.join("/") : last.team;
    const named = org ? `${team} (${org})` : team;
    const age = seasonAge(file.birth, file.season);
    const span = from || to ? `${niceDate(from || gs[0].date)}–${niceDate(to || last.date)}` : "Season";
    return {
      version: 4,
      season: file.season,
      range: { from: from || null, to: to || null },
      pitcher_id: file.pitcher_id,
      name: file.name,
      hand: file.hand,
      team, teams, org,
      stint: !!stint,
      title: `${file.season} ${level[1]} ${span}`, // 2026 MLB Jun 1–Jul 31
      bio: `${file.hand}HP | ${named}` + (age == null ? "" : ` | Age: ${age}`),
      line: segments.join(", "),
      summary: segments,
      stats,
      games: gs.length,
      starts: count(gs, (g) => g.starter),
      skills: seasonSkills(gs),
      n_vl: count(pitches, (p) => p.stand === "L"),
      n_vr: count(pitches, (p) => p.stand === "R"),
      arm_angle: num(arm, 2),
      chart_lim: chartLimit(pitches),
      fastball: fastball(rows, gs),
      types: rows,
      plus_scale: PC.SEASON_SCALE,
      plots: plots(pitches, order),
      missing_data: pitches.some((p) => p["plvStuff+"] == null),
      comparisons: [],
      // the game cards' level: the Stats API's sport (card.js names a minor level's PNG by it)
      level: { code: file.level, id: level[0], name: file.level === "mlb" ? "Major League Baseball" : level[1] },
      graded_vs: "mlb",
      provisional: [...new Set(gs.flatMap((g) => g.provisional || []))].sort(),
    };
  }

  return { games, statsUrl, lines, build, stints };
});
