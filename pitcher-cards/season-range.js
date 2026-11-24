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

  // ---- the KDE regions (season.py's movement_layers and location_plots) ----------------
  // regions() is the published card's plots for a range: each type's KDE regions as path
  // data, or its pitches when it has too few for them. It is the slow part (a Gaussian sum
  // over a 150 x 150 grid per type and side), so the page runs it in kde-worker.js and
  // draws the card with plots() meanwhile.
  const GRIDSIZE = 150, CUT = 3, KDE_MIN = 10, LOCATION_MIN = 20;
  const MOVEMENT_BW = 2, MOVEMENT_SHARE = 0.95, TIER_SHARES = [1, 2 / 3, 1 / 3], LOCATION_LEVELS = [0.64];
  const THIN = 0.35; // shapes.THIN: inches between kept vertices

  // kernel([xy]): the type's Scott kernel, [cxx, cxy, cyy]; null if degenerate
  function kernel(xy) {
    const n = xy.length;
    if (n < 2) return null;
    let mx = 0, my = 0;
    for (const [x, y] of xy) { mx += x; my += y; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of xy) { const dx = x - mx, dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const f = Math.pow(n, -1 / 3) / (n - 1);
    const c = [sxx * f, sxy * f, syy * f];
    return c[0] * c[2] - c[1] * c[1] > 0 ? c : null;
  }
  // density(): the KDE of xy (unnormalised) at each of the points (xs[k], ys[k])
  function density(xy, xs, ys, c) {
    const det = c[0] * c[2] - c[1] * c[1];
    const a = c[2] / det, b = -c[1] / det, d = c[0] / det;
    const n = xy.length, px = new Float64Array(n), py = new Float64Array(n);
    xy.forEach(([x, y], i) => { px[i] = x; py[i] = y; });
    const out = new Float64Array(xs.length);
    for (let k = 0; k < xs.length; k++) {
      const qx = xs[k], qy = ys[k];
      let s = 0;
      for (let i = 0; i < n; i++) {
        const dx = qx - px[i], dy = qy - py[i];
        const d2 = a * dx * dx + 2 * b * dx * dy + d * dy * dy;
        s += Math.exp(-0.5 * (d2 > 0 ? d2 : 0));
      }
      out[k] = s;
    }
    return out;
  }
  // numpy's linspace
  function linspace(lo, hi, n) {
    const step = (hi - lo) / (n - 1), out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = lo + i * step;
    out[n - 1] = hi;
    return out;
  }
  // the grid, CUT bandwidths past the points, and the density over it (row i is gy[i])
  function grid(xy, c) {
    const bw = [Math.sqrt(c[0]), Math.sqrt(c[2])];
    const xsAll = xy.map((p) => p[0]), ysAll = xy.map((p) => p[1]);
    const gx = linspace(Math.min(...xsAll) - bw[0] * CUT, Math.max(...xsAll) + bw[0] * CUT, GRIDSIZE);
    const gy = linspace(Math.min(...ysAll) - bw[1] * CUT, Math.max(...ysAll) + bw[1] * CUT, GRIDSIZE);
    const xs = new Float64Array(GRIDSIZE * GRIDSIZE), ys = new Float64Array(GRIDSIZE * GRIDSIZE);
    for (let i = 0; i < GRIDSIZE; i++) for (let j = 0; j < GRIDSIZE; j++) { xs[i * GRIDSIZE + j] = gx[j]; ys[i * GRIDSIZE + j] = gy[i]; }
    return { gx, gy, z: density(xy, xs, ys, c) };
  }

  // ---- shapes._paths: the region where z > level as path data, one string per outer
  // boundary with its holes. Marching squares with each boundary piece run so the region
  // lies on its left: outer rings anticlockwise, holes clockwise, as contourpy gives them;
  // a saddle cell joins its high corners when the mean of its four is above the level. The
  // grid is padded with a border far below any level, so a region reaching the edge closes
  // along it.
  const PAD = -1e300;
  function contours(gx, gy, z, level) {
    const nx = gx.length, ny = gy.length, W = nx + 2, H = ny + 2;
    const X = new Float64Array(W), Y = new Float64Array(H), Z = new Float64Array(W * H).fill(PAD);
    for (let j = 0; j < nx; j++) X[j + 1] = gx[j];
    for (let i = 0; i < ny; i++) Y[i + 1] = gy[i];
    X[0] = 2 * gx[0] - gx[1]; X[W - 1] = 2 * gx[nx - 1] - gx[nx - 2];
    Y[0] = 2 * gy[0] - gy[1]; Y[H - 1] = 2 * gy[ny - 1] - gy[ny - 2];
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) Z[(i + 1) * W + j + 1] = z[i * nx + j];
    const up = (i, j) => Z[i * W + j] > level;
    // a crossing on the edge from vertex (i0, j0) to (i1, j1): [edge id, x, y]
    function cross(i0, j0, i1, j1) {
      const za = Z[i0 * W + j0], zb = Z[i1 * W + j1], t = (level - za) / (zb - za);
      const id = i0 === i1 ? (i0 * W + Math.min(j0, j1)) * 2 : (Math.min(i0, i1) * W + j0) * 2 + 1;
      return [id, X[j0] + t * (X[j1] - X[j0]), Y[i0] + t * (Y[i1] - Y[i0])];
    }
    const next = new Map(); // a crossing's edge id -> [its point, the edge id the segment ends on]
    for (let i = 0; i < H - 1; i++) {
      for (let j = 0; j < W - 1; j++) {
        const corners = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]]; // anticlockwise from bottom left
        const ups = corners.map(([a, b]) => up(a, b));
        if (ups.every((u) => u) || ups.every((u) => !u)) continue;
        const cs = []; // crossings anticlockwise: [kind, crossing], kind "x" leaving the region, "e" entering
        for (let k = 0; k < 4; k++) {
          const a = corners[k], b = corners[(k + 1) % 4];
          if (ups[k] !== ups[(k + 1) % 4]) cs.push([ups[k] ? "x" : "e", cross(a[0], a[1], b[0], b[1])]);
        }
        const link = (x, e) => next.set(x[0], [[x[1], x[2]], e[0]]);
        if (cs.length === 2) {
          const x = cs[0][0] === "x" ? cs[0][1] : cs[1][1], e = cs[0][0] === "e" ? cs[0][1] : cs[1][1];
          link(x, e);
        } else {
          const mid = (Z[i * W + j] + Z[i * W + j + 1] + Z[(i + 1) * W + j + 1] + Z[(i + 1) * W + j]) / 4;
          for (let k = 0; k < 4; k++) {
            if (cs[k][0] !== "x") continue;
            // joined: on to the next entry round the cell; apart: back to the one before
            link(cs[k][1], mid > level ? cs[(k + 1) % 4][1] : cs[(k + 3) % 4][1]);
          }
        }
      }
    }
    // the rings, each from its lowest edge id so the order is fixed
    const rings = [];
    const ids = [...next.keys()].sort((a, b) => a - b), used = new Set();
    for (const start of ids) {
      if (used.has(start)) continue;
      const ring = [];
      let at = start;
      while (!used.has(at) && next.has(at)) {
        used.add(at);
        const [pt, to] = next.get(at);
        ring.push(pt);
        at = to;
      }
      if (ring.length >= 3) rings.push(ring);
    }
    return rings;
  }
  function area(ring) {
    let s = 0;
    for (let k = 0; k < ring.length; k++) {
      const [x0, y0] = ring[k], [x1, y1] = ring[(k + 1) % ring.length];
      s += x0 * y1 - x1 * y0;
    }
    return s / 2;
  }
  function inside([x, y], ring) {
    let c = false;
    for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
      const [xi, yi] = ring[k], [xm, ym] = ring[m];
      if (yi > y !== ym > y && x < ((xm - xi) * (y - yi)) / (ym - yi) + xi) c = !c;
    }
    return c;
  }
  const tenths = (v) => (v / 10).toFixed(1).replace(/0+$/, "").replace(/\.$/, "");
  // shapes._ring: absolute start, then relative moves in tenths, thinned
  function ringPath(points) {
    const pts = points.map(([x, y]) => [PC.pyRound(x * 10), PC.pyRound(y * 10)]);
    let last = pts[0];
    const parts = [`M${tenths(last[0])},${tenths(last[1])}`];
    for (const pt of pts.slice(1)) {
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= THIN * 10) {
        parts.push(`l${tenths(pt[0] - last[0])},${tenths(pt[1] - last[1])}`);
        last = pt;
      }
    }
    return parts.join(" ") + "Z";
  }
  function paths(gx, gy, z, level) {
    const rings = contours(gx, gy, z, level).map((r) => ({ r, a: area(r) }));
    const outers = rings.filter((x) => x.a > 0).map((x) => ({ ...x, holes: [] }));
    for (const h of rings.filter((x) => x.a < 0)) {
      const home = outers.filter((o) => inside(h.r[0], o.r)).sort((p, q) => p.a - q.a)[0];
      if (home) home.holes.push(h.r);
    }
    return outers.map((o) => [o.r, ...o.holes].map(ringPath).join(" "));
  }

  // season.py's tiers: Movement's, the outermost around the `share` densest pitches
  function tiers(xy, insideN, c) {
    const { gx, gy, z } = grid(xy, c);
    const at = Array.from(density(xy, xy.map((p) => p[0]), xy.map((p) => p[1]), c)).sort((p, q) => q - p);
    return TIER_SHARES.map((f) => paths(gx, gy, z, at[Math.max(1, PC.pyRound(insideN * f)) - 1]));
  }
  // season.py's _level: the density above which 1 - isoprop of the mass lies
  function massLevel(z, isoprop) {
    const v = Array.from(z).sort((p, q) => q - p);
    let total = 0;
    for (const x of v) total += x;
    const want = 1 - isoprop;
    let cum = 0;
    for (let k = 0; k < v.length; k++) {
      cum += v[k];
      if (cum / total >= want) return v[k];
    }
    return v[v.length - 1];
  }
  function massTiers(xy, c, isoprops) {
    const { gx, gy, z } = grid(xy, c);
    return isoprops.map((q) => paths(gx, gy, z, massLevel(z, q)));
  }
  function pointsOf(pitches, xk, yk, code, unit) {
    return pitches.filter((p) => p.t === code && p[xk] != null && p[yk] != null).map((p) => [p[xk] * unit, p[yk] * unit]);
  }
  // the plots with KDE regions, from the pitches (each with t, hb, ivb, x, z, stand) and the
  // types most thrown first
  function regions(pitches, order) {
    const movement = [];
    for (const code of order) {
      const xy = pointsOf(pitches, "hb", "ivb", code, 1);
      if (!xy.length) continue;
      let c = xy.length >= KDE_MIN ? kernel(xy) : null;
      c = c && c.map((v) => v * MOVEMENT_BW * MOVEMENT_BW);
      movement.push(c ? { code, tiers: tiers(xy, PC.pyRound(MOVEMENT_SHARE * xy.length), c) }
        : { code, points: xy.map(([x, y]) => [num(x, 2), num(y, 2)]) });
    }
    const out = { movement, min: LOCATION_MIN, scattered: {} };
    for (const side of ["L", "R"]) {
      out[side] = []; out.scattered[side] = [];
      const faced = pitches.filter((p) => p.stand === side);
      const usage = (cd) => count(faced, (p) => p.t === cd);
      const ranked = order.map((cd, i) => [cd, i]).sort((a, b) => usage(a[0]) - usage(b[0]) || a[1] - b[1]).map((x) => x[0]);
      for (const code of ranked) {
        const xy = pointsOf(faced, "x", "z", code, 12);
        if (!xy.length) continue;
        const c = xy.length >= LOCATION_MIN ? kernel(xy) : null;
        if (c) out[side].push({ code, tiers: massTiers(xy, c, LOCATION_LEVELS) });
        else {
          out.scattered[side].push(code);
          out[side].push({ code, points: xy.map(([x, y]) => [num(x, 1), num(y, 1)]) });
        }
      }
    }
    return out;
  }

  return { games, statsUrl, lines, build, stints, regions };
});
