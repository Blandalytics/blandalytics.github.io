// SGP player-rater engine. Pure functions; no DOM.
// Method (project doc claude/generalized-sgp-procedure-ste.md):
//  - an anchor pool (who the counting categories alone would roster) sets the rate baselines and the
//    denominators below, which are then frozen; the rostered pool is picked on every category against them
//  - rate stats become volume-weighted marginals vs the anchor-pool rate, in team-rate units
//  - team-total spread from the anchor's draft tiers of N players: sigma^2 = sum of within-tier variances
//  - roto SGP denominator D_k = 2*sqrt(pi)*sigma_k/(N-1)
//  - starting slots by greedy assignment; bench = next best players (roster spots, no team totals)
//  - replacement = mean SGP of the best W players outside starters+bench; a position gets its own
//    replacement level only when it binds (no player eligible there is starting in a flex slot).
//    Its split by category comes from the best `teams` such players, shifted to the same total.
//  - dollars: min bid per rostered spot, the rest of each pool (hitter/pitcher split) by SGP above replacement
(function (root) {
  "use strict";
  const HK = ["PA", "AB", "H", "D2", "D3", "HR", "R", "RBI", "SB", "CS", "BB", "HBP", "SF", "SO"];
  const PK = ["G", "GS", "OUTS", "W", "L", "SV", "HLD", "K", "ER", "H", "BB", "HBP", "QS", "BS"];
  const HI = Object.fromEntries(HK.map((k, i) => [k, i]));
  const PI = Object.fromEntries(PK.map((k, i) => [k, i]));
  const tb = (s) => s[HI.H] + s[HI.D2] + 2 * s[HI.D3] + 3 * s[HI.HR];

  // Category catalog. kind: "count" (sign +/-) or "rate" (num/den, sign +/-)
  const CATS = {
    // hitting
    R:   { g: "h", label: "R",   kind: "count", f: (s) => s[HI.R] },
    HR:  { g: "h", label: "HR",  kind: "count", f: (s) => s[HI.HR] },
    RBI: { g: "h", label: "RBI", kind: "count", f: (s) => s[HI.RBI] },
    SB:  { g: "h", label: "SB",  kind: "count", f: (s) => s[HI.SB] },
    NSB: { g: "h", label: "NSB", kind: "count", f: (s) => s[HI.SB] - s[HI.CS] },
    H:   { g: "h", label: "H",   kind: "count", f: (s) => s[HI.H] },
    TB:  { g: "h", label: "TB",  kind: "count", f: tb },
    BBh: { g: "h", label: "BB",  kind: "count", f: (s) => s[HI.BB] },
    SOh: { g: "h", label: "K",   kind: "count", sign: -1, f: (s) => s[HI.SO] },
    AVG: { g: "h", label: "AVG", kind: "rate", num: (s) => s[HI.H], den: (s) => s[HI.AB], dec: 3 },
    OBP: { g: "h", label: "OBP", kind: "rate", num: (s) => s[HI.H] + s[HI.BB] + s[HI.HBP],
           den: (s) => s[HI.AB] + s[HI.BB] + s[HI.HBP] + s[HI.SF], dec: 3 },
    SLG: { g: "h", label: "SLG", kind: "rate", num: tb, den: (s) => s[HI.AB], dec: 3 },
    OPS: { g: "h", label: "OPS", kind: "sum", parts: ["OBP", "SLG"], dec: 3 },
    // pitching
    W:   { g: "p", label: "W",   kind: "count", f: (s) => s[PI.W] },
    L:   { g: "p", label: "L",   kind: "count", sign: -1, f: (s) => s[PI.L] },
    SV:  { g: "p", label: "SV",  kind: "count", f: (s) => s[PI.SV] },
    NSV: { g: "p", label: "NSV", kind: "count", f: (s) => s[PI.SV] - s[PI.BS] },
    HLD: { g: "p", label: "HLD", kind: "count", f: (s) => s[PI.HLD] },
    SVH: { g: "p", label: "SV+H", kind: "count", f: (s) => s[PI.SV] + s[PI.HLD] },
    K:   { g: "p", label: "K",   kind: "count", f: (s) => s[PI.K] },
    QS:  { g: "p", label: "QS",  kind: "count", f: (s) => s[PI.QS] },
    IP:  { g: "p", label: "IP",  kind: "count", f: (s) => s[PI.OUTS] / 3 },
    ERA: { g: "p", label: "ERA", kind: "rate", sign: -1, num: (s) => 9 * s[PI.ER], den: (s) => s[PI.OUTS] / 3, dec: 2 },
    WHIP:{ g: "p", label: "WHIP",kind: "rate", sign: -1, num: (s) => s[PI.H] + s[PI.BB], den: (s) => s[PI.OUTS] / 3, dec: 2 },
    K9:  { g: "p", label: "K/9", kind: "rate", num: (s) => 9 * s[PI.K], den: (s) => s[PI.OUTS] / 3, dec: 2 },
  };

  const YAHOO_DEFAULT = {
    teams: 12, budget: 260, hitterShare: 0.65, minBid: 1,
    slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, CI: 0, MI: 0, Util: 2, SP: 2, RP: 2, P: 4 },
    bench: 5, benchHitterShare: 10 / 18,
    hitCats: ["R", "HR", "RBI", "SB", "AVG"],
    pitCats: ["W", "SV", "K", "ERA", "WHIP"],
    replW: 3,
  };

  // ---------- data prep: per-player cumulative sums over their game lines ----------
  function prepare(raw) {
    const players = [];
    for (const r of raw.players) {
      const base = { id: r.i, name: r.n, team: r.t };
      if (r.h) players.push(Object.assign({ g: "h", elig: r.he, key: r.i + "h" }, base, cum(r.h, HK.length)));
      if (r.p) players.push(Object.assign({ g: "p", elig: r.pe, key: r.i + "p" }, base, cum(r.p, PK.length)));
    }
    return { players, start: raw.start, ndays: raw.ndays };
  }
  function cum(flat, k) {
    const w = k + 1, n = flat.length / w;
    const days = new Int16Array(n), c = new Float64Array((n + 1) * k);
    for (let j = 0; j < n; j++) {
      days[j] = flat[j * w];
      for (let q = 0; q < k; q++) c[(j + 1) * k + q] = c[j * k + q] + flat[j * w + 1 + q];
    }
    return { days, c, k };
  }
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function rangeStats(p, a, b) {
    const j0 = lowerBound(p.days, a), j1 = lowerBound(p.days, b + 1);
    if (j1 <= j0) return null;
    const k = p.k, s = new Float64Array(k);
    for (let q = 0; q < k; q++) s[q] = p.c[j1 * k + q] - p.c[j0 * k + q];
    return s;
  }

  // ---------- slot assignment (greedy, least-slack position first) ----------
  function slotPlan(settings, g) {
    const T = settings.teams, s = settings.slots;
    const benchH = Math.round(settings.bench * settings.benchHitterShare);
    if (g === "h") {
      return {
        pos: { C: s.C * T, "1B": s["1B"] * T, "2B": s["2B"] * T, "3B": s["3B"] * T, SS: s.SS * T, OF: s.OF * T },
        flex: [["CI", s.CI * T, ["1B", "3B"]], ["MI", s.MI * T, ["2B", "SS"]], ["Util", s.Util * T, null]],
        bench: benchH * T,
      };
    }
    return { pos: { SP: s.SP * T, RP: s.RP * T }, flex: [["P", s.P * T, null]], bench: (settings.bench - benchH) * T };
  }
  function assign(list, plan) {
    // list sorted by value desc; returns Map key->slot
    const cap = Object.assign({}, plan.pos);
    const flexCap = plan.flex.map((f) => f[1]);
    const eligLeft = {};
    for (const p of Object.keys(cap)) eligLeft[p] = 0;
    for (const pl of list) for (const e of pl.elig) if (e in eligLeft) eligLeft[e]++;
    const out = new Map();
    let left = Object.values(cap).reduce((a, b) => a + b, 0) + flexCap.reduce((a, b) => a + b, 0);
    for (const pl of list) {
      if (left <= 0) break;
      let best = null, bestSlack = Infinity;
      for (const e of pl.elig) {
        if (cap[e] > 0) { const slack = eligLeft[e] - cap[e]; if (slack < bestSlack) { bestSlack = slack; best = e; } }
      }
      for (const e of pl.elig) if (e in eligLeft) eligLeft[e]--;
      if (best) { cap[best]--; out.set(pl.key, best); left--; continue; }
      for (let i = 0; i < plan.flex.length; i++) {
        const [name, , allowed] = plan.flex[i];
        if (flexCap[i] > 0 && (!allowed || pl.elig.some((e) => allowed.includes(e)))) {
          flexCap[i]--; out.set(pl.key, name); left--; break;
        }
      }
    }
    return out;
  }

  // ---------- one valuation for one pool ----------
  // Two pools, two jobs. The anchor pool (who the counting categories alone would roster) sets the rate
  // baselines and the standings-point denominators, which are then frozen. The rostered pool (picked on
  // every category against those frozen baselines) sets replacement and dollars. Letting the rostered pool
  // set its own baselines feeds back on itself: low-innings relievers with tiny ERAs pull the pool ERA
  // down, good 200-inning starters then grade out as ratio negatives and drop out, and the loop settles on
  // a reliever-heavy pool no real league rosters (2026: a 2.81 ERA, 47 of 96 starters relievers).
  //
  // opt.fixed: another valuation's members (a bootstrap replicate's pools: who is in the anchor, who is rostered
  // and on the bench, and which players set replacement). Baselines, SGP and replacement are then computed from
  // these rows' lines for exactly those players, with no selection. opt.perSgp: a fixed price per point.
  function valuePool(rows, settings, g, cats, opt = {}) {
    const T = settings.teams, fixed = opt.fixed;
    const byKey = fixed ? new Map(rows.map((r) => [r.key, r])) : null;
    const pick = (keys) => keys.map((k) => byKey.get(k)).filter(Boolean);
    const plan = slotPlan(settings, g);
    const startN = Object.values(plan.pos).reduce((a, b) => a + b, 0) + plan.flex.reduce((a, f) => a + f[1], 0);
    const rosterN = startN + plan.bench;
    const vol = g === "h" ? (s) => s[HI.PA] : (s) => s[PI.OUTS] + 3 * s[PI.SV] + 3 * s[PI.HLD];
    const countCats = cats.filter((c) => CATS[c].kind === "count");
    const flatCats = [];
    for (const c of cats) { const d = CATS[c]; if (d.kind === "sum") d.parts.forEach((p) => flatCats.push([c, p])); else flatCats.push([c, c]); }

    // counting marginals don't depend on any pool; rate marginals are added once the anchor fixes the rates
    for (const r of rows) {
      r.x = {};
      for (const cat of cats) r.x[cat] = 0;
      for (const [cat, c] of flatCats) { const d = CATS[c]; if (d.kind !== "rate") r.x[cat] += (d.sign || 1) * d.f(r.s); }
    }
    // tier-stratified team-total spread -> D_k; `ordered` is a starting pool in draft order
    const spread = (ordered, cs) => {
      const D = {}, tiers = [];
      for (let i = 0; i + T <= ordered.length; i += T) tiers.push(ordered.slice(i, i + T));
      for (const cat of cs) {
        let v = 0;
        for (const t of tiers) {
          let m = 0; for (const r of t) m += r.x[cat]; m /= t.length;
          let ss = 0; for (const r of t) ss += (r.x[cat] - m) ** 2;
          v += ss / (t.length - 1);
        }
        const sigma = Math.sqrt(v);
        D[cat] = sigma > 0 ? 2 * Math.sqrt(Math.PI) * sigma / (T - 1) : Infinity;
      }
      return D;
    };
    // bench = next best non-starters; they take roster spots but not team totals
    const benchOf = (starting, val) =>
      new Set(rows.filter((r) => !starting.has(r.key)).sort((a, b) => val(b) - val(a)).slice(0, plan.bench).map((r) => r.key));
    const sigOf = (starting, bench) => [...starting.keys()].sort().join() + "|" + (bench ? [...bench].sort().join() : "");

    // replacement players: the best W outside the full roster (starters + bench) by sc, and the best T for the
    // category split; per position too, where it binds. A replacement level is the mean SGP of those W.
    // With `given` (a replicate's players, as rows of this valuation), reuse them instead of choosing.
    const replacement = (starting, bench, sc, withCats, given) => {
      const W = settings.replW;
      let sets, binding;
      if (given) ({ sets, binding } = given);
      else {
        const un = rows.filter((r) => !starting.has(r.key) && !bench.has(r.key)).sort((a, b) => sc(b) - sc(a));
        const choose = (arr) => ({ top: arr.slice(0, W), wide: arr.slice(0, T) });
        sets = { _any: choose(un) }; binding = {};
        // a position has its own (lower) replacement level only when it binds: no player eligible there
        // sits in a flex slot. Otherwise removing him chains to the best unrostered player overall.
        for (const pos of Object.keys(plan.pos)) {
          binding[pos] = !rows.some((r) => starting.has(r.key) && r.elig.includes(pos) && !(starting.get(r.key) in plan.pos));
          if (binding[pos]) sets[pos] = choose(un.filter((r) => r.elig.includes(pos)));
        }
      }
      const meanTop = (set) => set.top.length ? set.top.reduce((a, r) => a + sc(r), 0) / set.top.length : 0;
      // the category baseline averages a wider group (one player per team), because the best W players'
      // category mix is a few small samples (e.g. two relievers with tiny ERAs). It is shifted by the same
      // amount in every category so it sums to meanTop, so (player - replacement) by category still sums
      // to the player's SGP above replacement.
      const meanTopCats = (set) => {
        const top = set.wide, o = {};
        let sum = 0;
        for (const cat of cats) { o[cat] = top.length ? top.reduce((a, r) => a + r.sgpCat[cat], 0) / top.length : 0; sum += o[cat]; }
        const shift = (meanTop(set) - sum) / cats.length;
        for (const cat of cats) o[cat] += shift;
        return o;
      };
      const repl = { _any: meanTop(sets._any) };
      const replCat = withCats ? { _any: meanTopCats(sets._any) } : null;
      for (const pos of Object.keys(plan.pos)) {
        repl[pos] = binding[pos] ? meanTop(sets[pos]) : repl._any;
        if (withCats) replCat[pos] = binding[pos] ? meanTopCats(sets[pos]) : replCat._any;
      }
      repl._binding = binding;
      const levelFor = (r) => {
        let base = repl._any, at = "_any";
        for (const e of r.elig) if (e in plan.pos && repl[e] < base) { base = repl[e]; at = e; }
        return { base, at };
      };
      return { repl, replCat, levelFor, sets, binding };
    };

    // 1. anchor pool: fixed point of slot assignment on counting-category SGP above replacement (playing
    //    time when there are no counting categories). It can end in a 2-cycle at the margin (2026: two pairs
    //    of hitters and of pitchers trade places), which left the result to the iteration cap; then the two
    //    states' denominators are averaged and the slots assigned once.
    let anchorList = [];
    if (fixed) anchorList = pick(fixed.anchor);
    else {
      for (const r of rows) r.vc = vol(r.s);
      const hist = [];
      for (let it = 0; it < 12; it++) {
        rows.sort((a, b) => b.vc - a.vc);
        let anchor = assign(rows, plan);
        anchorList = rows.filter((r) => anchor.has(r.key));
        const sig = sigOf(anchor);
        if (!countCats.length || (hist.length && sig === hist[hist.length - 1].sig)) break;
        let Dc = spread(anchorList, countCats);
        const cycle = hist.length >= 2 && sig === hist[hist.length - 2].sig;
        if (cycle) { const o = hist[hist.length - 1].Dc; Dc = Object.fromEntries(countCats.map((c) => [c, (Dc[c] + o[c]) / 2])); }
        hist.push({ sig, Dc });
        for (const r of rows) r.sc = countCats.reduce((a, c) => a + r.x[c] / Dc[c], 0);
        const { levelFor } = replacement(anchor, benchOf(anchor, (r) => r.vc), (r) => r.sc, false);
        for (const r of rows) r.vc = r.sc - levelFor(r).base;
        if (cycle) {
          rows.sort((a, b) => b.vc - a.vc);
          anchor = assign(rows, plan);
          anchorList = rows.filter((r) => anchor.has(r.key));
          break;
        }
      }
    }

    // 2-3. frozen baselines: the anchor's rates and team denominators, and D_k from its draft tiers. The tier
    //      order comes from one all-category valuation of the anchor against its own rates.
    const rates = {};
    for (const [, c] of flatCats) {
      const d = CATS[c];
      if (d.kind !== "rate") continue;
      let num = 0, den = 0;
      for (const r of anchorList) { num += d.num(r.s); den += d.den(r.s); }
      rates[c] = { r: den > 0 ? num / den : 0, teamDen: den / T };
    }
    for (const r of rows) {
      for (const [cat, c] of flatCats) {
        const d = CATS[c], rt = rates[c];
        if (d.kind === "rate" && rt.teamDen > 0) r.x[cat] += (d.sign || 1) * (d.num(r.s) - rt.r * d.den(r.s)) / rt.teamDen;
      }
    }
    const D0 = spread(anchorList, cats);
    const sgpWith = (r, Dk) => cats.reduce((a, c) => a + r.x[c] / Dk[c], 0);
    const D = spread([...anchorList].sort((a, b) => sgpWith(b, D0) - sgpWith(a, D0)), cats);

    // 4. everyone's SGP against the frozen baselines; it no longer depends on who is rostered
    for (const r of rows) {
      r.sgpCat = {}; let tot = 0;
      for (const cat of cats) { const q = r.x[cat] / D[cat]; r.sgpCat[cat] = q; tot += q; }
      r.sgp = tot;
    }

    // 5. rostered pool on all-category value; only the replacement levels move, so it settles in a few passes
    const setRepl = (rep) => {
      for (const r of rows) {
        const { base, at } = rep.levelFor(r);
        r.repl = base; r.sgpar = r.sgp - base; r.v = r.sgpar; r.replCat = rep.replCat[at];
      }
    };
    let rostered = new Map(), bench = new Set(), rep = null;
    if (fixed) {
      for (const [k, slot] of fixed.rostered) if (byKey.has(k)) rostered.set(k, slot);
      bench = new Set(fixed.bench.filter((k) => byKey.has(k)));
      const sets = {};
      for (const [pos, s] of Object.entries(fixed.sets)) sets[pos] = { top: pick(s.top), wide: pick(s.wide) };
      rep = replacement(rostered, bench, (r) => r.sgp, true, { sets, binding: fixed.binding });
      setRepl(rep);
    } else {
      for (const r of rows) r.v = r.sgp;
      let prev = "";
      for (let it = 0; it < 10; it++) {
        rows.sort((a, b) => b.v - a.v);
        rostered = assign(rows, plan);
        bench = benchOf(rostered, (r) => r.v);
        const sig = sigOf(rostered, bench);
        if (sig === prev) break;
        prev = sig;
        rep = replacement(rostered, bench, (r) => r.sgp, true);
        setRepl(rep);
      }
    }

    // 6. dollars: min bid per roster spot, the rest of the pool split by positive SGP above replacement
    const pool = settings.budget * T * (g === "h" ? settings.hitterShare : 1 - settings.hitterShare);
    const above = rows.reduce((a, r) => a + (rostered.has(r.key) || bench.has(r.key) ? Math.max(r.sgpar, 0) : 0), 0);
    const perSgp = opt.perSgp != null ? opt.perSgp : above > 0 ? (pool - rosterN * settings.minBid) / above : 0;
    for (const r of rows) {
      r.dollars = settings.minBid + r.sgpar * perSgp;
      r.slot = rostered.get(r.key) || (bench.has(r.key) ? "BN" : null);
    }
    const keys = (arr) => arr.map((r) => r.key);
    const members = {
      anchor: keys(anchorList), rostered: [...rostered], bench: [...bench], binding: rep.binding,
      sets: Object.fromEntries(Object.entries(rep.sets).map(([pos, s]) => [pos, { top: keys(s.top), wide: keys(s.wide) }])),
    };
    return { rows, D, rates, repl: rep.repl, perSgp, rosterN, startN, pool, anchorN: anchorList.length, members };
  }

  // opt.stats(p): each player's line (a bootstrap replicate's) in place of days a..b;
  // opt.fixed[g], opt.perSgp[g]: as in valuePool
  function valuate(db, settings, a, b, opt = {}) {
    const out = {};
    for (const g of ["h", "p"]) {
      const cats = g === "h" ? settings.hitCats : settings.pitCats;
      const rows = [];
      for (const p of db.players) {
        if (p.g !== g) continue;
        const s = opt.stats ? opt.stats(p) : rangeStats(p, a, b);
        if (!s) continue;
        if (g === "h" && s[HI.PA] <= 0) continue;
        if (g === "p" && s[PI.G] <= 0) continue;
        rows.push({ key: p.key, id: p.id, name: p.name, team: p.team, elig: p.elig.length ? p.elig : [], g, s });
      }
      out[g] = cats.length
        ? valuePool(rows, settings, g, cats, { fixed: opt.fixed && opt.fixed[g], perSgp: opt.perSgp && opt.perSgp[g] })
        : { rows: [], D: {}, rates: {}, repl: {}, perSgp: 0 };
    }
    return out;
  }

  // ---------- uncertainty: which players "should" have been rostered (retrospective, Mode R) ----------
  // In hindsight the only uncertainty in the rostered pool is the season record itself. Each replicate
  // resamples the frame's days in blocks (one draw shared by every player, so a week of games stays together)
  // and runs the full valuation on those lines to get its pools: the anchor, the rostered players and bench,
  // and the replacement players. Each player's ACTUAL line is then valued against that replicate's pools, with
  // the actual lines of the players in them. So the interval is the range of defensible pools, not of what
  // the player did. Two choices keep it from drifting off the point estimate: dollars use the point price
  // per point (a replicate's own price inflates stars), and the interval is centred on the point value
  // (point + replicate quantile - replicate median).
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // blocks of L days with uniform starts inside a..b, enough to cover the frame's n days (the last cut short)
  function drawBlocks(a, b, L, rand) {
    const n = b - a + 1, Lx = Math.min(L, n), out = [];
    for (let left = n; left > 0; left -= Lx) {
      const s = a + Math.floor(rand() * (n - Lx + 1));
      out.push([s, s + Math.min(Lx, left) - 1]);
    }
    return out;
  }
  // opt: reps (200), conf (0.95), block (7 days, 3 under six weeks), seed, keys (players to report; all by
  // default), point (a valuate() of a..b already made). Returns Map key -> { lo, hi }.
  function bootstrap(db, settings, a, b, opt = {}) {
    const R = opt.reps || 200, conf = opt.conf || 0.95, n = b - a + 1;
    const L = opt.block || (n >= 42 ? 7 : 3);
    const rand = mulberry32(opt.seed == null ? 20260 + a * 1000 + b : opt.seed);
    const point = opt.point || valuate(db, settings, a, b);
    const pointOf = new Map();
    for (const g of ["h", "p"]) for (const r of point[g].rows) pointOf.set(r.key, r.dollars);
    const keys = opt.keys ? opt.keys.filter((k) => pointOf.has(k)) : [...pointOf.keys()];
    const draws = new Map(keys.map((k) => [k, new Float64Array(R).fill(NaN)]));
    const perSgp = { h: point.h.perSgp, p: point.p.perSgp };
    for (let i = 0; i < R; i++) {
      const blocks = drawBlocks(a, b, L, rand);
      const stats = (p) => {
        let s = null;
        for (const [x, y] of blocks) {
          const t = rangeStats(p, x, y);
          if (!t) continue;
          if (!s) s = t; else for (let q = 0; q < s.length; q++) s[q] += t[q];
        }
        return s;
      };
      const rep = valuate(db, settings, a, b, { stats });
      const act = valuate(db, settings, a, b, { fixed: { h: rep.h.members, p: rep.p.members }, perSgp });
      for (const g of ["h", "p"]) for (const r of act[g].rows) { const d = draws.get(r.key); if (d) d[i] = r.dollars; }
    }
    const q = (arr, f) => { const k = (arr.length - 1) * f, lo = Math.floor(k); return arr[lo] + (arr[Math.min(lo + 1, arr.length - 1)] - arr[lo]) * (k - lo); };
    const out = new Map();
    for (const k of keys) {
      const d = Array.from(draws.get(k)).filter((x) => !Number.isNaN(x)).sort((x, y) => x - y);
      if (!d.length) continue;
      const med = q(d, 0.5), pt = pointOf.get(k);
      out.set(k, { lo: pt + q(d, (1 - conf) / 2) - med, hi: pt + q(d, (1 + conf) / 2) - med });
    }
    return out;
  }

  const api = { HK, PK, HI, PI, CATS, YAHOO_DEFAULT, prepare, rangeStats, valuate, bootstrap, tb };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RaterEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
