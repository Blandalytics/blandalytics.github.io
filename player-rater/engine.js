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
    fillMissing: true, // a player's missing time is filled with a replacement-level player's production
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
    // every ordering breaks ties by key, so equal values (common among players whose lines are mostly filled
    // missing time) never depend on the order a list happened to be in
    const byKeyOrder = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
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
      new Set(rows.filter((r) => !starting.has(r.key)).sort((a, b) => val(b) - val(a) || byKeyOrder(a, b)).slice(0, plan.bench).map((r) => r.key));
    const sigOf = (starting, bench) => [...starting.keys()].sort().join() + "|" + (bench ? [...bench].sort().join() : "");

    // replacement players: the best W outside the full roster (starters + bench) by sc, and the best T for the
    // category split; per position too, where it binds. A replacement level is the mean SGP of those W.
    // With `given` (a replicate's players, as rows of this valuation), reuse them instead of choosing.
    const replacement = (starting, bench, sc, withCats, given) => {
      const W = settings.replW;
      let sets, binding;
      if (given) ({ sets, binding } = given);
      else {
        const un = rows.filter((r) => !starting.has(r.key) && !bench.has(r.key)).sort((a, b) => sc(b) - sc(a) || byKeyOrder(a, b));
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
    let anchorList = [], anchor = new Map();
    if (fixed) { for (const [k, slot] of fixed.anchor) if (byKey.has(k)) anchor.set(k, slot); }
    else {
      for (const r of rows) r.vc = vol(r.s);
      const hist = [];
      for (let it = 0; it < 12; it++) {
        rows.sort((a, b) => b.vc - a.vc || byKeyOrder(a, b));
        anchor = assign(rows, plan);
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
          rows.sort((a, b) => b.vc - a.vc || byKeyOrder(a, b));
          anchor = assign(rows, plan);
          break;
        }
      }
    }
    anchorList = rows.filter((r) => anchor.has(r.key));

    // 2-3. frozen baselines: the anchor's rates and team denominators, and D_k from its draft tiers. They depend
    //      on who is in the anchor and on the lines only, never on how the anchor was found, so a bootstrap
    //      replicate whose anchor has the same members gets exactly these (spec, Task 2 note 1).
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
    // the tiers: the anchor in counting-value order (from playing time, by counting SGP with the counting
    // denominators of the current tiers, until the order holds), then one all-category pass against the anchor's
    // rates sets the tiers of N (ties by key)
    const sgpWith = (r, Dk, cs = cats) => cs.reduce((a, c) => a + r.x[c] / Dk[c], 0);
    anchorList.sort((a, b) => vol(b.s) - vol(a.s) || byKeyOrder(a, b));
    if (countCats.length) {
      let Dc = spread(anchorList, countCats);
      for (let it = 0; it < 20; it++) {
        const next = [...anchorList].sort((a, b) => sgpWith(b, Dc, countCats) - sgpWith(a, Dc, countCats) || byKeyOrder(a, b));
        if (next.every((r, u) => r === anchorList[u])) break;
        anchorList = next; Dc = spread(anchorList, countCats);
      }
    }
    const D0 = spread(anchorList, cats);
    const D = spread([...anchorList].sort((a, b) => sgpWith(b, D0) - sgpWith(a, D0) || byKeyOrder(a, b)), cats);

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
        r.repl = base; r.sgpar = r.sgp - base; r.v = r.sgpar; r.replCat = rep.replCat[at]; r.replAt = at;
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
        rows.sort((a, b) => b.v - a.v || byKeyOrder(a, b));
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
      anchor: [...anchor], rostered: [...rostered], bench: [...bench], binding: rep.binding,
      sets: Object.fromEntries(Object.entries(rep.sets).map(([pos, s]) => [pos, { top: keys(s.top), wide: keys(s.wide) }])),
    };
    return { rows, D, rates, repl: rep.repl, perSgp, rosterN, startN, pool, anchorN: anchorList.length, members };
  }

  // ---------- missing time ----------
  // Days without a game that count as missing time: the injured-list minimums (10 days for hitters, 15 for
  // pitchers), so ordinary rest never counts. A roster spot left empty by an injury, a demotion, a late call-up
  // or an early end is filled by a replacement-level player at the position, so the player's line gets that
  // player's production for those days.
  const MISSING_DAYS = { h: 10, p: 15 };
  // a player's missing stretches in a..b, [from, to] day pairs: gaps between games longer than the limit, and
  // the stretch before his first game or after his last when longer than it
  function missingStretches(p, a, b) {
    const G = MISSING_DAYS[p.g], out = [];
    const j0 = lowerBound(p.days, a), j1 = lowerBound(p.days, b + 1);
    if (j1 <= j0) return out;
    let prev = a - 1;
    for (let j = j0; j < j1; j++) { const d = p.days[j]; if (d - prev - 1 > G) out.push([prev + 1, d - 1]); prev = d; }
    if (b - prev > G) out.push([prev + 1, b]);
    return out;
  }
  // the days of runs (a replicate's [from, to] runs of days, each counting w) that fall in those stretches
  function missingIn(stretches, runs, w) {
    let m = 0;
    for (const [x, y] of runs) for (const [s, e] of stretches) { const lo = Math.max(x, s), hi = Math.min(y, e); if (hi >= lo) m += hi - lo + 1; }
    return m * w;
  }

  // opt.stats(p): each player's line (a bootstrap replicate's) in place of days a..b, and opt.missing(p) his
  // missing days among them; opt.fill[g]: the replacement production to fill them with (a point valuation's
  // .fill), instead of finding it; opt.fixed[g], opt.perSgp[g]: as in valuePool.
  // With settings.fillMissing, each pool is valued twice: once on the actual lines, which finds the replacement
  // players at every position and their production per day present, then on lines with each player's missing
  // days filled at the position he is replaced at. Rows keep the actual line in .s (what the table shows); the
  // filled one is .sFill.
  function valuate(db, settings, a, b, opt = {}) {
    const out = {}, n = b - a + 1;
    for (const g of ["h", "p"]) {
      const cats = g === "h" ? settings.hitCats : settings.pitCats;
      const rows = [];
      for (const p of db.players) {
        if (p.g !== g) continue;
        const s = opt.stats ? opt.stats(p) : rangeStats(p, a, b);
        if (!s) continue;
        if (g === "h" && s[HI.PA] <= 0) continue;
        if (g === "p" && s[PI.G] <= 0) continue;
        rows.push({ key: p.key, id: p.id, name: p.name, team: p.team, elig: p.elig.length ? p.elig : [], g, s, p });
      }
      const vopt = { fixed: opt.fixed && opt.fixed[g], perSgp: opt.perSgp && opt.perSgp[g] };
      if (!cats.length) { out[g] = { rows: [], D: {}, rates: {}, repl: {}, perSgp: 0 }; continue; }
      if (settings.fillMissing === false) { out[g] = valuePool(rows, settings, g, cats, vopt); continue; }
      for (const r of rows) r.miss = opt.missing ? opt.missing(r.p) : missingStretches(r.p, a, b).reduce((m, [s, e]) => m + e - s + 1, 0);
      let fill = opt.fill && opt.fill[g];
      if (!fill) {
        // the replacement players on the actual lines, and their production per day present
        const first = valuePool(rows.map((r) => ({ key: r.key, elig: r.elig, g, s: r.s })), settings, g, cats, {});
        const byKey = new Map(rows.map((r) => [r.key, r]));
        const rate = {};
        for (const [pos, set] of Object.entries(first.members.sets)) {
          const v = new Float64Array(rows[0].s.length); let days = 0;
          for (const k of set.top) { const r = byKey.get(k); for (let q = 0; q < v.length; q++) v[q] += r.s[q]; days += n - r.miss; }
          if (days > 0) { for (let q = 0; q < v.length; q++) v[q] /= days; rate[pos] = v; }
        }
        fill = { rate, at: new Map(first.rows.map((r) => [r.key, r.replAt])) };
      }
      for (const r of rows) {
        r.sAct = r.s;
        const v = fill.rate[fill.at.get(r.key) || "_any"] || fill.rate._any;
        if (r.miss > 0 && v) { const s = Float64Array.from(r.s); for (let q = 0; q < s.length; q++) s[q] += v[q] * r.miss; r.s = s; }
      }
      out[g] = valuePool(rows, settings, g, cats, vopt);
      for (const r of out[g].rows) { r.sFill = r.s; r.s = r.sAct; delete r.sAct; delete r.p; }
      out[g].fill = fill;
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
  // A replicate's days: the stationary bootstrap (spec Task 3). From a random start, each next day follows on
  // with probability 1 - 1/L (wrapping from b to a) or jumps to a random day. m = n / lam^2 days are drawn and
  // each counts n / m, so the volume stays the frame's and only the noise scales by lam. Returned as runs of
  // consecutive days, which cost one cumulative-sum lookup each.
  function stationaryRuns(a, b, L, lam, rand) {
    const n = b - a + 1, m = Math.max(1, Math.round(n / (lam * lam))), p = 1 / L, runs = [];
    let cur = Math.floor(rand() * n), start = cur, len = 0;
    for (let j = 0; j < m; j++) {
      len++;
      const jump = rand() < p, next = jump ? Math.floor(rand() * n) : (cur + 1) % n;
      if (jump || next === 0) { runs.push([a + start, a + start + len - 1]); start = next; len = 0; }
      cur = next;
    }
    if (len) runs.push([a + start, a + start + len - 1]);
    return { runs, w: n / m };
  }
  // The retrospective procedure (rostered-pool sampling spec, mode R), Tasks 2 to 7.
  // opt: reps (1000), conf (0.95), block (mean block length: 7 days, 3 for frames of 60 days or less), lam (1),
  // seed, keys (players to report; all by default), point (a valuate() of a..b already made).
  // Returns Map key -> { lo, hi } in dollars.
  function bootstrap(db, settings, a, b, opt = {}) {
    const R = opt.reps || 1000, conf = opt.conf || 0.95, n = b - a + 1, lam = opt.lam || 1;
    const L = opt.block || (n <= 60 ? 3 : 7);
    const rand = mulberry32(opt.seed == null ? 20260 + a * 1000 + b : opt.seed);
    const point = opt.point || valuate(db, settings, a, b);
    const pointOf = new Map();
    for (const g of ["h", "p"]) for (const r of point[g].rows) pointOf.set(r.key, r.dollars);
    const keys = opt.keys ? opt.keys.filter((k) => pointOf.has(k)) : [...pointOf.keys()];
    const draws = new Map(keys.map((k) => [k, new Float64Array(R).fill(NaN)]));
    const perSgp = { h: point.h.perSgp, p: point.p.perSgp };
    const fill = { h: point.h.fill, p: point.p.fill }, stretches = new Map(db.players.map((p) => [p.key, missingStretches(p, a, b)]));
    for (let i = 0; i < R; i++) {
      const { runs, w } = stationaryRuns(a, b, L, lam, rand);
      const stats = (p) => {
        let s = null;
        for (const [x, y] of runs) {
          const t = rangeStats(p, x, y);
          if (!t) continue;
          if (!s) s = t; else for (let q = 0; q < s.length; q++) s[q] += t[q];
        }
        if (s && w !== 1) for (let q = 0; q < s.length; q++) s[q] *= w;
        return s;
      };
      const missing = (p) => missingIn(stretches.get(p.key), runs, w);
      const rep = valuate(db, settings, a, b, { stats, missing, fill });
      const act = valuate(db, settings, a, b, { fixed: { h: rep.h.members, p: rep.p.members }, perSgp, fill });
      for (const g of ["h", "p"]) for (const r of act[g].rows) { const d = draws.get(r.key); if (d) d[i] = r.dollars; }
      if (opt.onReplicate) opt.onReplicate(i, rep, act); // diagnostics (validation checks)
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

  // ---------- the same bootstrap, fast (about 3 ms a full-season replicate instead of 40) ----------
  // bootstrap() above is the reference: it runs the general valuation twice per replicate. This computes the
  // same numbers (tools/player_rater/check_bootstrap.js compares them replicate by replicate) with:
  //  - typed arrays allocated once per pool and reused by every replicate;
  //  - running totals by day, laid out day by day, so a replicate line is two block reads per run of days, and
  //    only for the stats the categories read;
  //  - partial sorts: slot assignment and the bench read the top of a list, replacement only its best W;
  //  - candidates: selection (anchor, rostered pool, bench, replacement players) only considers players near the
  //    point pool by value, counting value or playing time (6 rosters deep), or deep enough at a position for its
  //    replacement set. Every player is still valued. With missing time filled, many part-timers sit near the
  //    replacement level, and 4 rosters missed some of them in 2026 (3 already did without filling).
  // Like the reference, each replicate's anchor loop starts from playing time: starting from the point solution
  // is faster but can settle on a different fixed point.
  //
  // Splitting across workers: opt.part = [i0, i1) values only replicates i0..i1-1 and returns their draws
  // ({ pools: [{ g, keys, pointDollars, dollars }] }) instead of intervals. Every part replays the one random
  // stream from the start (drawing days is cheap), so the parts' draws are exactly the single run's, and
  // bootstrapSummary(parts) gives exactly what bootstrap() gives.
  function bootstrapFast(db, settings, a, b, opt = {}) {
    const R = opt.reps || 1000, conf = opt.conf || 0.95, n = b - a + 1, lam = opt.lam || 1;
    const [i0, i1] = opt.part || [0, R];
    const L = opt.block || (n <= 60 ? 3 : 7);
    const rand = mulberry32(opt.seed == null ? 20260 + a * 1000 + b : opt.seed);
    const point = opt.point || valuate(db, settings, a, b);
    const dbByKey = new Map(db.players.map((p) => [p.key, p]));
    const pools = [];
    for (const g of ["h", "p"]) {
      const cats = g === "h" ? settings.hitCats : settings.pitCats;
      if (cats.length && point[g].rows.length) pools.push(fastPool(dbByKey, settings, g, cats, point[g], a, b, i1 - i0, opt.prune !== false, opt.depth || 6));
    }
    for (let i = 0; i < i1; i++) {
      const { runs, w } = stationaryRuns(a, b, L, lam, rand);
      if (i < i0) continue;
      for (const pl of pools) pl.replicate(runs, w, i - i0);
      if (opt.onReplicate) opt.onReplicate(i, Object.fromEntries(pools.map((pl) => [pl.g, pl.diag])));
    }
    const parts = [{ pools: pools.map((pl) => ({ g: pl.g, keys: pl.keys, pointDollars: pl.pointDollars, dollars: pl.dollars })) }];
    return opt.part ? parts[0] : bootstrapSummary(parts, conf);
  }
  // intervals from the draws of one or more parts (in replicate order): point + quantile - median. The three
  // quantiles come from selection (the two order statistics each interpolates between), not a full sort.
  function bootstrapSummary(parts, conf = 0.95) {
    const out = new Map();
    parts[0].pools.forEach((pool0, k) => {
      const P = pool0.keys.length, R = parts.reduce((s, pt) => s + pt.pools[k].dollars.length / P, 0), col = new Float32Array(R);
      // value at fraction f: col[lo] + (col[lo + 1] - col[lo]) * t over the sorted column, by selection
      const select = (r) => {
        let lo = 0, hi = R - 1;
        while (hi > lo) {
          const pv = col[(lo + hi) >> 1];
          let i = lo, j = hi;
          while (i <= j) {
            while (col[i] < pv) i++;
            while (col[j] > pv) j--;
            if (i <= j) { const t = col[i]; col[i] = col[j]; col[j] = t; i++; j--; }
          }
          if (r <= j) hi = j; else if (r >= i) lo = i; else return col[r];
        }
        return col[r];
      };
      const q = (f) => {
        const x = (R - 1) * f, lo = Math.floor(x), a = select(lo);
        if (lo + 1 >= R || x === lo) return a;
        let b = Infinity; for (let i = lo + 1; i < R; i++) if (col[i] < b) b = col[i]; // everything past lo is >= a
        return a + (b - a) * (x - lo);
      };
      for (let p = 0; p < P; p++) {
        let u = 0;
        for (const pt of parts) { const d = pt.pools[k].dollars, r = d.length / P; for (let i = 0; i < r; i++) col[u++] = d[i * P + p]; }
        const med = q(0.5), lo = q((1 - conf) / 2), hi = q((1 + conf) / 2), v = pool0.pointDollars[p];
        out.set(pool0.keys[p], { lo: v + lo - med, hi: v + hi - med });
      }
    });
    return out;
  }

  function fastPool(dbByKey, settings, g, cats, pt, a, b, R, prune, depth) {
    const T = settings.teams, W = settings.replW, n = b - a + 1;
    const plan = slotPlan(settings, g);
    const posKeys = Object.keys(plan.pos), npos = posKeys.length, posCap = posKeys.map((k) => plan.pos[k]);
    const nflex = plan.flex.length, flexCap = plan.flex.map((f) => f[1]);
    const startN = posCap.reduce((x, y) => x + y, 0) + flexCap.reduce((x, y) => x + y, 0);
    const rosterN = startN + plan.bench, nBench = plan.bench;
    const K = g === "h" ? HK.length : PK.length, actIdx = g === "h" ? HI.PA : PI.G;
    // categories: counting parts are summed into x directly; rate parts need the anchor's rate first
    const nc = cats.length, cntParts = [], rateParts = [];
    cats.forEach((cat, c) => {
      const d = CATS[cat];
      for (const pn of d.kind === "sum" ? d.parts : [cat]) {
        const pd = CATS[pn], sign = pd.sign || 1;
        if (pd.kind === "rate") rateParts.push({ c, sign, num: pd.num, den: pd.den });
        else cntParts.push({ c, sign, f: pd.f });
      }
    });
    const nr = rateParts.length;
    // the stats those functions read (probed once), plus activity and playing time: the only ones summed
    const used = new Set([actIdx, ...(g === "h" ? [HI.PA] : [PI.OUTS, PI.SV, PI.HLD])]);
    { const probe = new Proxy([], { get: (t, k) => { if (/^\d+$/.test(k)) used.add(+k); return 1; } });
      for (const pp of cntParts) pp.f(probe); for (const rp of rateParts) { rp.num(probe); rp.den(probe); } }
    const usedK = Int32Array.from([...used].sort((x, y) => x - y));
    const countC = cats.map((cat, c) => (CATS[cat].kind === "count" ? c : -1)).filter((c) => c >= 0);
    const allC = cats.map((_, c) => c);

    // players: the point valuation's rows (everyone with playing time in the frame)
    const rows = pt.rows, P = rows.length, keys = rows.map((r) => r.key);
    const posOf = rows.map((r) => Int8Array.from(r.elig.map((e) => posKeys.indexOf(e)).filter((x) => x >= 0)));
    const flexOK = new Uint8Array(P * nflex);
    rows.forEach((r, i) => plan.flex.forEach(([, , allowed], f) => { flexOK[i * nflex + f] = !allowed || r.elig.some((e) => allowed.includes(e)) ? 1 : 0; }));
    const XA0 = new Float64Array(P * nc), RNA = new Float64Array(P * nr), RDA = new Float64Array(P * nr);
    rows.forEach((r, i) => {
      const s = r.sFill || r.s; // the line valued: filled for missing time
      for (const pp of cntParts) XA0[i * nc + pp.c] += pp.sign * pp.f(s);
      rateParts.forEach((rp, q) => { RNA[i * nr + q] = rp.num(s); RDA[i * nr + q] = rp.den(s); });
    });
    const pointDollars = Float64Array.from(rows, (r) => r.dollars);

    // candidates for selection
    let cand;
    if (!prune) cand = rows.map((_, i) => i);
    else {
      const M = depth * rosterN + 3 * T, keep = new Uint8Array(P);
      const top = (val, m, ok) => rows.map((_, i) => i).filter((i) => !ok || ok(i)).sort((x, y) => val(y) - val(x)).slice(0, m).forEach((i) => { keep[i] = 1; });
      const volOf = (r) => (g === "h" ? r.s[HI.PA] : r.s[PI.OUTS] + 3 * r.s[PI.SV] + 3 * r.s[PI.HLD]);
      top((i) => rows[i].sgp, M); top((i) => rows[i].vc, M); top((i) => volOf(rows[i]), M);
      posKeys.forEach((_, p) => {
        const m = posCap[p] + 3 * T, ok = (i) => posOf[i].includes(p);
        top((i) => rows[i].sgp, m, ok); top((i) => rows[i].vc, m, ok);
      });
      rows.forEach((r, i) => { if (r.slot) keep[i] = 1; });
      cand = rows.map((_, i) => i).filter((i) => keep[i]);
    }
    const C = cand.length, isCand = new Int32Array(P).fill(-1);
    cand.forEach((i, j) => { isCand[i] = j; });
    const nonCand = rows.map((_, i) => i).filter((i) => isCand[i] < 0);

    // running totals over the frame by day, laid out day by day (all candidates' used stats for a day sit
    // together), so a run of days reads two contiguous blocks; the other players only the activity stat
    const U = usedK.length, CU = C * U, NC = nonCand.length;
    const cum = new Float32Array((n + 1) * CU), cumAct = new Float32Array((n + 1) * NC);
    const fill = (p, put) => {
      const j0 = lowerBound(p.days, a), k = p.k;
      for (let t = 0; t <= n; t++) { const j1 = lowerBound(p.days, a + t); put(t, (q) => p.c[j1 * k + q] - p.c[j0 * k + q]); }
    };
    cand.forEach((i, j) => fill(dbByKey.get(keys[i]), (t, v) => { const o = t * CU + j * U; for (let u = 0; u < U; u++) cum[o + u] = v(usedK[u]); }));
    nonCand.forEach((i, m) => fill(dbByKey.get(keys[i]), (t, v) => { cumAct[t * NC + m] = v(actIdx); }));
    const acc = new Float32Array(CU), accN = new Float32Array(NC); // whole-number sums: exact in single precision
    // missing time: each candidate's missing days by day (running totals, day by day like cum), and the
    // replacement production per day he is filled with (the point valuation's, as the reference uses)
    const fillPt = pt.fill, cumMiss = fillPt ? new Float32Array((n + 1) * C) : null, accM = fillPt ? new Float32Array(C) : null;
    const rateC = fillPt ? cand.map((i) => fillPt.rate[fillPt.at.get(keys[i]) || "_any"] || fillPt.rate._any || null) : null;
    if (fillPt) cand.forEach((i, j) => {
      const st = missingStretches(dbByKey.get(keys[i]), a, b);
      let m = 0, u = 0;
      for (let t = 0; t <= n; t++) {
        cumMiss[t * C + j] = m;
        const d = a + t;
        while (u < st.length && st[u][1] < d) u++;
        if (t < n && u < st.length && st[u][0] <= d) m++;
      }
    });

    const cposOf = cand.map((i) => posOf[i]), cflex = new Uint8Array(C * nflex);
    cand.forEach((i, j) => { for (let f = 0; f < nflex; f++) cflex[j * nflex + f] = flexOK[i * nflex + f]; });

    // working arrays
    const S = new Float64Array(C * K), views = cand.map((_, j) => S.subarray(j * K, (j + 1) * K));
    const act = new Uint8Array(C), XR = new Float64Array(C * nc), RNR = new Float64Array(C * nr), RDR = new Float64Array(C * nr);
    const offs = new Int32Array(npos), eligLeft = new Int32Array(npos), cap = new Int32Array(npos), fcap = new Int32Array(nflex);
    const aslot = new Int16Array(C), rslot = new Int16Array(C), bench = new Uint8Array(C), bench2 = new Uint8Array(C);
    const vc = new Float64Array(C), sc = new Float64Array(C), sgp = new Float64Array(C), v = new Float64Array(C);
    const lev = new Float64Array(npos), binding = new Uint8Array(npos), flexElig = new Uint8Array(npos);
    const XA = new Float64Array(P * nc), sgpA = new Float64Array(P), rate = new Float64Array(nr), tden = new Float64Array(nr);
    const dollars = new Float32Array(R * P), diag = { keys, sgpar: new Float64Array(P), rostered: new Uint8Array(P), starter: new Uint8Array(P), rpOnly: 0 };
    const perSgp = pt.perSgp, minBid = settings.minBid;
    let prevMem = new Uint8Array(C), prev2Mem = new Uint8Array(C), curMem = new Uint8Array(C);

    // ties broken by key, as the reference breaks them
    const dbIdx = new Map(); { let u = 0; for (const k of dbByKey.keys()) dbIdx.set(k, u++); }
    const dbOrdC = Int32Array.from(cand, (i) => dbIdx.get(keys[i]));
    const keyRankP = new Int32Array(P); keys.map((k, i) => [k, i]).sort((x, y) => (x[0] < y[0] ? -1 : 1)).forEach(([, i], r) => { keyRankP[i] = r; });
    const keyRankC = Int32Array.from(cand, (i) => keyRankP[i]);
    const byDesc = (key) => (x, y) => key[y] - key[x] || keyRankC[x] - keyRankC[y];
    const byKeyC = (key) => (x, y) => key[y] - key[x] || keyRankC[x] - keyRankC[y];
    const byKeyP = (key) => (x, y) => key[y] - key[x] || keyRankP[x] - keyRankP[y];
    // the r-th smallest of the first m values of arr (quickselect; reorders arr)
    function nth(arr, m, r) {
      let lo = 0, hi = m - 1;
      while (hi > lo) {
        const pv = arr[(lo + hi) >> 1];
        let i = lo, j = hi;
        while (i <= j) {
          while (arr[i] < pv) i++;
          while (arr[j] > pv) j--;
          if (i <= j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; i++; j--; }
        }
        if (r <= j) hi = j; else if (r >= i) lo = i; else return arr[r];
      }
      return arr[r];
    }
    // the k best of idxs by key, sorted by cmp (more when keys tie at the cut)
    const keyBuf = new Float64Array(C);
    function topSorted(idxs, key, k, cmp) {
      if (idxs.length <= k) return idxs.slice().sort(cmp);
      const m = idxs.length;
      for (let u = 0; u < m; u++) keyBuf[u] = key[idxs[u]];
      const cut = nth(keyBuf, m, m - k), sel = [];
      for (const j of idxs) if (key[j] >= cut) sel.push(j);
      return sel.sort(cmp);
    }
    // the active players in value order, as far as slots and bench read: starters, then nBench more
    const activeCount = new Int32Array(npos);
    function slotsAndBench(active, key, slot, benchMask) {
      const cmp = byDesc(key);
      let ord = topSorted(active, key, startN + nBench + 40, cmp);
      for (let pass = 0; pass < 2; pass++) {
        const left = assignTo(ord, slot);
        let k = 0;
        if (benchMask) { benchMask.fill(0); for (const j of ord) { if (slot[j] >= 0) continue; if (k >= nBench) break; benchMask[j] = 1; k++; } }
        if ((left === 0 && (!benchMask || k >= nBench)) || ord.length === active.length) return ord;
        ord = active.slice().sort(cmp); // the prefix ran out: sort them all
      }
      return ord;
    }
    // greedy slots (engine assign): least-slack position first, then flex. `list` in value order (a prefix of
    // the active players: eligLeft counts every active player and the others with playing time).
    function assignTo(list, slot) {
      slot.fill(-1);
      for (let p = 0; p < npos; p++) { cap[p] = posCap[p]; eligLeft[p] = offs[p] + activeCount[p]; }
      for (let f = 0; f < nflex; f++) fcap[f] = flexCap[f];
      let left = startN;
      for (const j of list) {
        if (left <= 0) break;
        let best = -1, bestSlack = Infinity;
        for (const p of cposOf[j]) if (cap[p] > 0) { const sl = eligLeft[p] - cap[p]; if (sl < bestSlack) { bestSlack = sl; best = p; } }
        for (const p of cposOf[j]) eligLeft[p]--;
        if (best >= 0) { cap[best]--; slot[j] = best; left--; continue; }
        for (let f = 0; f < nflex; f++) if (fcap[f] > 0 && cflex[j * nflex + f]) { fcap[f]--; slot[j] = npos + f; left--; break; }
      }
      return left;
    }
    // tier-stratified spread -> D for the categories in cs; `list` indexes rows of X (stride nc)
    function spread(list, X, cs, D) {
      const tiers = Math.floor(list.length / T);
      for (const c of cs) {
        let vsum = 0;
        for (let t = 0; t < tiers; t++) {
          let m = 0; for (let u = t * T; u < t * T + T; u++) m += X[list[u] * nc + c]; m /= T;
          let ss = 0; for (let u = t * T; u < t * T + T; u++) { const d = X[list[u] * nc + c] - m; ss += d * d; }
          vsum += ss / (T - 1);
        }
        const sigma = Math.sqrt(vsum);
        D[c] = sigma > 0 ? (2 * Math.sqrt(Math.PI) * sigma) / (T - 1) : Infinity;
      }
    }
    // replacement levels from starters `slot`, `benchMask`, scored by `score` over active candidates.
    // Fills lev/binding and returns the general level; with `sets`, records each level's players.
    const tops = Array.from({ length: npos + 1 }, () => []);
    function replacement(slot, benchMask, score, sets) {
      flexElig.fill(0);
      for (let j = 0; j < C; j++) if (slot[j] >= npos) for (const p of cposOf[j]) flexElig[p] = 1;
      for (let p = 0; p < npos; p++) binding[p] = flexElig[p] ? 0 : 1;
      for (const t of tops) t.length = 0;
      const cmp = byDesc(score);
      const put = (t, j) => {
        if (t.length === W && cmp(j, t[W - 1]) >= 0) return;
        let u = t.length < W ? t.length : W - 1;
        while (u > 0 && cmp(j, t[u - 1]) < 0) { t[u] = t[u - 1]; u--; }
        t[u] = j;
      };
      for (let j = 0; j < C; j++) {
        if (!act[j] || slot[j] >= 0 || benchMask[j]) continue;
        put(tops[npos], j);
        for (const p of cposOf[j]) if (binding[p]) put(tops[p], j);
      }
      const meanTop = (arr) => { let s = 0; for (const j of arr) s += score[j]; return arr.length ? s / arr.length : 0; };
      const any = meanTop(tops[npos]);
      if (sets) sets._any = tops[npos].slice();
      for (let p = 0; p < npos; p++) {
        if (binding[p]) { lev[p] = meanTop(tops[p]); if (sets) sets[p] = tops[p].slice(); } else lev[p] = any;
      }
      return any;
    }
    const levelOf = (pos, any) => { let base = any; for (const p of pos) if (lev[p] < base) base = lev[p]; return base; };
    const sameMem = (x, y) => { for (let j = 0; j < C; j++) if (x[j] !== y[j]) return false; return true; };

    // the anchor's tiers (valuePool steps 2-3): from playing-time order, by full value with the denominators of
    // the current tiers, until the order holds. `list` indexes rows of X; fills D.
    const Dc = new Float64Array(nc), D = new Float64Array(nc), sgpT = new Float64Array(Math.max(P, C));
    function tiers(list, X, volKey, keyRank) {
      const cmp = (x, y) => sgpT[y] - sgpT[x] || keyRank[x] - keyRank[y];
      let order = list.slice().sort((x, y) => volKey[y] - volKey[x] || keyRank[x] - keyRank[y]);
      if (countC.length) {
        spread(order, X, countC, Dc);
        for (let it = 0; it < 20; it++) {
          for (const j of order) { let s = 0; for (const c of countC) s += X[j * nc + c] / Dc[c]; sgpT[j] = s; }
          const next = order.slice().sort(cmp);
          let same = true; for (let u = 0; u < next.length; u++) if (next[u] !== order[u]) { same = false; break; }
          if (same) break;
          order = next; spread(order, X, countC, Dc);
        }
      }
      spread(order, X, allC, D);
      for (const j of order) { let s = 0; for (const c of allC) s += X[j * nc + c] / D[c]; sgpT[j] = s; }
      spread(order.slice().sort(cmp), X, allC, D);
    }
    const volC = new Float64Array(C), volP = Float64Array.from(rows, (r) => { const s = r.sFill || r.s; return g === "h" ? s[HI.PA] : s[PI.OUTS] + 3 * s[PI.SV] + 3 * s[PI.HLD]; });

    function replicate(runs, w, i) {
      // replicate lines
      acc.fill(0); accN.fill(0); if (fillPt) accM.fill(0);
      for (const [x, y] of runs) {
        const o0 = (x - a) * CU, o1 = (y - a + 1) * CU;
        for (let z = 0; z < CU; z++) acc[z] += cum[o1 + z] - cum[o0 + z];
        const p0 = (x - a) * NC, p1 = (y - a + 1) * NC;
        for (let z = 0; z < NC; z++) accN[z] += cumAct[p1 + z] - cumAct[p0 + z];
        if (fillPt) { const m0 = (x - a) * C, m1 = (y - a + 1) * C; for (let z = 0; z < C; z++) accM[z] += cumMiss[m1 + z] - cumMiss[m0 + z]; }
      }
      for (let j = 0; j < C; j++) {
        const o = j * K, oa = j * U;
        for (let u = 0; u < U; u++) S[o + usedK[u]] = acc[oa + u] * w;
        act[j] = S[o + actIdx] > 0 ? 1 : 0;
        if (fillPt && act[j] && rateC[j] && accM[j] > 0) { const v = rateC[j], m = accM[j] * w; for (const q of usedK) S[o + q] += v[q] * m; }
      }
      offs.fill(0);
      for (let m = 0; m < NC; m++) if (accN[m] > 0) for (const p of posOf[nonCand[m]]) offs[p]++;
      XR.fill(0);
      for (let j = 0; j < C; j++) {
        if (!act[j]) continue;
        const s = views[j];
        for (const pp of cntParts) XR[j * nc + pp.c] += pp.sign * pp.f(s);
        for (let q = 0; q < nr; q++) { RNR[j * nr + q] = rateParts[q].num(s); RDR[j * nr + q] = rateParts[q].den(s); }
      }
      const active = []; for (let j = 0; j < C; j++) if (act[j]) active.push(j);
      activeCount.fill(0); for (const j of active) for (const p of cposOf[j]) activeCount[p]++;

      // --- selection on the replicate lines (method D) ---
      // 1. anchor: counting-value fixed point from playing time; a 2-cycle averages the two states
      const volS = (j) => (g === "h" ? S[j * K + HI.PA] : S[j * K + PI.OUTS] + 3 * S[j * K + PI.SV] + 3 * S[j * K + PI.HLD]);
      for (let j = 0; j < C; j++) vc[j] = volS(j);
      prevMem.fill(2); prev2Mem.fill(2);
      let prevDc = null;
      for (let it = 0; it < 12; it++) {
        const ord = slotsAndBench(active, vc, aslot, bench2);
        for (let j = 0; j < C; j++) curMem[j] = aslot[j] >= 0 ? 1 : 0;
        if (!countC.length || sameMem(curMem, prevMem)) break;
        const cycle = sameMem(curMem, prev2Mem);
        const members = ord.filter((j) => aslot[j] >= 0);
        spread(members, XR, countC, Dc);
        if (cycle && prevDc) for (const c of countC) Dc[c] = (Dc[c] + prevDc[c]) / 2;
        prevDc = Float64Array.from(Dc);
        for (const j of active) { let s = 0; for (const c of countC) s += XR[j * nc + c] / Dc[c]; sc[j] = s; }
        const any = replacement(aslot, bench2, sc, null);
        for (const j of active) vc[j] = sc[j] - levelOf(cposOf[j], any);
        const t = prev2Mem; prev2Mem = prevMem; prevMem = curMem; curMem = t;
        if (cycle) { slotsAndBench(active, vc, aslot, null); break; }
      }
      const anchorMembers = active.filter((j) => aslot[j] >= 0);
      // 2-3. rates, tiers and denominators from the anchor
      rate.fill(0); tden.fill(0);
      for (const j of anchorMembers) for (let q = 0; q < nr; q++) { rate[q] += RNR[j * nr + q]; tden[q] += RDR[j * nr + q]; }
      for (let q = 0; q < nr; q++) { rate[q] = tden[q] > 0 ? rate[q] / tden[q] : 0; tden[q] /= T; }
      for (const j of active) for (let q = 0; q < nr; q++) if (tden[q] > 0) XR[j * nc + rateParts[q].c] += rateParts[q].sign * (RNR[j * nr + q] - rate[q] * RDR[j * nr + q]) / tden[q];
      for (const j of active) volC[j] = volS(j);
      tiers(anchorMembers, XR, volC, keyRankC);
      for (const j of active) { let s = 0; for (const c of allC) s += XR[j * nc + c] / D[c]; sgp[j] = s; v[j] = s; }
      // 5. rostered pool and replacement players
      const sets = {};
      prevMem.fill(2);
      let haveSets = false;
      for (let it = 0; it < 10; it++) {
        slotsAndBench(active, v, rslot, bench);
        for (let j = 0; j < C; j++) curMem[j] = rslot[j] >= 0 ? 2 : bench[j];
        if (haveSets && sameMem(curMem, prevMem)) break;
        { const t = prevMem; prevMem = curMem; curMem = t; }
        for (const k in sets) delete sets[k];
        const any = replacement(rslot, bench, sgp, sets);
        haveSets = true;
        for (const j of active) v[j] = sgp[j] - levelOf(cposOf[j], any);
      }
      const bindR = Uint8Array.from(binding);
      // pool composition (diagnostics)
      diag.rostered.fill(0); diag.starter.fill(0); diag.rpOnly = 0;
      for (let j = 0; j < C; j++) {
        if (rslot[j] >= 0 || bench[j]) diag.rostered[cand[j]] = 1;
        if (rslot[j] >= 0) { diag.starter[cand[j]] = 1; const e = rows[cand[j]].elig; if (g === "p" && e.includes("RP") && !e.includes("SP")) diag.rpOnly++; }
      }

      // --- mode R: actual lines against this replicate's anchor and replacement players ---
      actualSgp(anchorMembers);
      const meanA = (arr) => { let s = 0; for (const j of arr) s += sgpA[cand[j]]; return arr.length ? s / arr.length : 0; };
      const any = meanA(sets._any);
      for (let p = 0; p < npos; p++) lev[p] = bindR[p] ? meanA(sets[p]) : any;
      const o = i * P;
      for (let ip = 0; ip < P; ip++) {
        const sgpar = sgpA[ip] - levelOf(posOf[ip], any);
        diag.sgpar[ip] = sgpar;
        dollars[o + ip] = minBid + sgpar * perSgp;
      }
    }
    // every player's SGP (into sgpA) from his actual line against an anchor's members
    function actualSgp(anchorMembers) {
      const members = anchorMembers.map((j) => cand[j]);
      rate.fill(0); tden.fill(0);
      for (const ip of members) for (let q = 0; q < nr; q++) { rate[q] += RNA[ip * nr + q]; tden[q] += RDA[ip * nr + q]; }
      for (let q = 0; q < nr; q++) { rate[q] = tden[q] > 0 ? rate[q] / tden[q] : 0; tden[q] /= T; }
      XA.set(XA0);
      for (let ip = 0; ip < P; ip++) for (let q = 0; q < nr; q++) if (tden[q] > 0) XA[ip * nc + rateParts[q].c] += rateParts[q].sign * (RNA[ip * nr + q] - rate[q] * RDA[ip * nr + q]) / tden[q];
      tiers(members, XA, volP, keyRankP);
      for (let ip = 0; ip < P; ip++) { let s = 0; for (const c of allC) s += XA[ip * nc + c] / D[c]; sgpA[ip] = s; }
    }
    return { g, P, keys, pointDollars, dollars, diag, replicate, candidates: C, players: P, U };
  }

  const api = { HK, PK, HI, PI, CATS, YAHOO_DEFAULT, MISSING_DAYS, prepare, rangeStats, missingStretches, valuate, bootstrap: bootstrapFast, bootstrapSummary, bootstrapRef: bootstrap, tb };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RaterEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
