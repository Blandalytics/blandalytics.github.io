// Checks of the risk-aware value (auction-calculator/risk.js; risk-aware-valuation-parameters.md):
//   1. the specification's section 7 checks: E[max(V, r)] and Var[max(V, r)] for μ = 0.5, σ = 3, r = 0
//      (1.463, 3.686) by the normal formula and by integration over normal draws; the CE probability
//      gains for M = 60, S = 8, H = 66, μ = 1 and σ = 1, 3, 5 (exact .0409 / .0526 / .0714, formula
//      .0394 / .0535 / .0818), and that σ = 5 > 0.4·S takes the exact one;
//   2. parity with the section 9 reference code, run in Python (scipy), on a grid of inputs;
//   3. with the projections: risk.js values every player's own projection line exactly as calc.js
//      does (SGP above replacement, and $) in many leagues, and the risk-aware $ spends exactly the
//      calculator's dollars on its drafted players;
//   4. the calculator's output is the same with risk.js's hook (debug) on or off, and, with
//      --baseline <calc.js>, the same as that calc.js's;
//   5. the risk files: they parse, match the CSVs' players, and carry their playing time;
//   6. the end-to-end run in the page's default league: the objective, the 15 largest moves between
//      the risk-aware $ and the calculator's $, and Δ by $ tier; then other payouts and settings;
//   7. the models (PLAN rows 13-14): "draws" gives risk.js before them exactly (with --old <that
//      risk.js>), with the placeholder tables and with a premium table; "upgrade" against "draws":
//      c² by side, k, the floor at the replacement, and the drafted pitchers and closers.
//   Part 1 also checks the model "upgrade"'s math: the option on m = mean + k (V − mean) against the
//   normal formula at k·σ; Var_eff's invariance in k when no draw is under the floor; rPosAt.
//
//   node risk_checks.mjs                                    (1 and 2 only)
//   node risk_checks.mjs hitters_auction_ev.csv pitchers_auction_ev.csv hitters_risk_ev.bin pitchers_risk_ev.bin
//        [--ref risk_reference.py] [--baseline old/calc.js] [--old old/risk.js] [--csv out.csv] [--python python]
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as C from "../../auction-calculator/calc.js";
import * as R from "../../auction-calculator/risk.js";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const refPath = opt("--ref"), baseline = opt("--baseline"), oldRisk = opt("--old"), csvOut = opt("--csv"), python = opt("--python") || process.env.PYTHON || "python";
const [hcsv, pcsv, hbin, pbin] = argv;

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const f4 = (x) => x.toFixed(4), f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);
const money = (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2);
const signed = (v) => (v >= 0 ? "+" : "−") + "$" + Math.abs(v).toFixed(2);

// ---- 1. the specification's section 7 -------------------------------------------------------------
console.log("1. The specification's section 7");
{
  const ev = R.optionValue(0.5, 3, 0), vr = R.truncatedVariance(0.5, 3, 0);
  check(Math.abs(ev - 1.463) < 5e-4, `E[max(V, r)], μ 0.5, σ 3, r 0: normal formula ${f4(ev)} (spec 1.463)`);
  check(Math.abs(vr - 3.686) < 5e-4, `Var[max(V, r)], same: normal formula ${f4(vr)} (spec 3.686)`);
  for (const n of [10000, 50]) {
    const v = Float64Array.from({ length: n }, (_, j) => 0.5 + 3 * R.PhiInv((j + 0.5) / n));
    const m = R.drawMoments(v, 0);
    const tol = n >= 10000 ? [2e-3, 1e-2] : [0.05, 0.4];
    check(Math.abs(m.option - ev) < tol[0] && Math.abs(m.optVar - vr) < tol[1],
      `the same over ${n} stratified normal draws (as the risk file's draws): ${f4(m.option)} and ${f4(m.optVar)}`);
  }
  const [M, S, H, mu] = [60, 8, 66, 1];
  for (const [sigma, wantExact, wantFormula] of [[1, 0.0409, 0.0394], [3, 0.0526, 0.0535], [5, 0.0714, 0.0818]]) {
    const exact = R.exactProbGain(mu, sigma ** 2, M, S, H);
    const formula = R.linearProbGain(R.certaintyEquivalent(mu, sigma ** 2, M, S, H), M, S, H);
    const usesExact = sigma > 0.4 * S;
    check(Math.abs(exact - wantExact) < 5e-5 && Math.abs(formula - wantFormula) < 5e-5,
      `CE gain, M 60, S 8, H 66, μ 1, σ ${sigma}: exact ${f4(exact)} (spec ${wantExact}), formula ${f4(formula)} (spec ${wantFormula}); ${usesExact ? "σ > 0.4·S: the exact one" : "the formula"}`);
    // the exact branch's certain value gives exactly the exact gain
    const c = R.exactCertainty(mu, sigma ** 2, M, S, H);
    const back = R.Phi((M + c - H) / S) - R.Phi((M - H) / S);
    check(Math.abs(back - exact) < 1e-12, `   its certain equivalent ${f4(c)} SGP gives the same gain (${back.toExponential(3)})`);
  }
  // the model "upgrade": the option on what the team knows at λ, m = mean + k (V − mean), is the
  // option of a normal of SD k·σ; with no draw under the floor Var_eff does not depend on k
  for (const k of [1, 0.502, 0.403]) {
    const n = 10000, v = Float64Array.from({ length: n }, (_, j) => 0.5 + 3 * R.PhiInv((j + 0.5) / n));
    const m = R.drawMoments(v.map((x) => 0.5 + k * (x - 0.5)), 0);
    check(Math.abs(m.option - R.optionValue(0.5, 3 * k, 0)) < 2e-3 && Math.abs(m.optVar - R.truncatedVariance(0.5, 3 * k, 0)) < 1e-2,
      `k ${k}: E[max(m, 0)] and Var[max(m, 0)] over the draws ${f4(m.option)}, ${f4(m.optVar)}; normal at k·σ ${f4(R.optionValue(0.5, 3 * k, 0))}, ${f4(R.truncatedVariance(0.5, 3 * k, 0))}`);
    const lo = R.drawMoments(v.map((x) => 0.5 + k * (x - 0.5)), -1e9), all = R.drawMoments(v, -1e9);
    const varEff = lo.optVar + (1 - k * k) * all.var;   // every draw kept: P(m ≥ r) = 1
    check(Math.abs(varEff - all.var) < 1e-9 * all.var, `   no draw under the floor: Var[max(m, r)] + (1 − k²) Var[V] = Var[V] (${f4(varEff)} = ${f4(all.var)})`);
  }
  {
    const tab = { SP: { 10: [0, 1, 2, 3, 4, 5, 6], 12: [-0.1, 1.0, 0.4, 0.5, 0.3, 0, 0] } };
    const atMonths = R.MONTH_SHARE.every((sh, m) => Math.abs(R.rPosAt("SP", 12, sh, tab) - R.rPos("SP", 12, m, tab)) < 1e-12);
    const mid = R.rPosAt("SP", 12, (R.MONTH_SHARE[1] + R.MONTH_SHARE[2]) / 2, tab), beyond = R.rPosAt("SP", 12, 0.99, tab);
    check(atMonths && Math.abs(mid - 0.7) < 1e-12 && beyond === 0 && R.rPosAt("C", 12, 0.3, tab) === 0 && Math.abs(R.rPosAt("SP", 11, R.MONTH_SHARE[2], tab) - 1.2) < 1e-12,
      `rPosAt: the table's months at MONTH_SHARE, linear between (${f3(mid)} halfway between months 1 and 2), the last month beyond, 0 off the table, linear in league size`);
  }
  check(Math.abs(R.Phi(-5) - 2.866515718791939e-7) < 1e-20 && Math.abs(R.Phi(1.96) - 0.9750021048517795) < 1e-15
    && Math.abs(R.PhiInv(0.975) - 1.959963984540054) < 1e-12, "Φ and Φ⁻¹ to double precision");
}

// ---- 2. parity with the reference code ---------------------------------------------------------
console.log("2. Parity with the section 9 reference code (Python)");
{
  const grid = [];
  for (const mu of [-3, -0.5, 0, 0.5, 2, 6]) for (const sigma of [0.5, 1, 3, 5]) for (const r of [-1, 0, 0.5]) {
    grid.push({ fn: "option_value", args: [mu, sigma, r] }, { fn: "truncated_variance", args: [mu, sigma, r] });
    for (const lam of [0, 0.125, 0.25, 1]) grid.push({ fn: "effective_value", args: [mu, sigma, r, lam] });
    for (const [M, S, H] of [[60, 8, 66], [65, 10.9, 83.5], [70, 12, 60]]) {
      grid.push({ fn: "risk_adjusted_surplus", args: [mu, sigma, r, 0.25, 1.5, M, S, H, 0.3] });
      grid.push({ fn: "exact_prob_gain", args: [mu, sigma ** 2, M, S, H] }, { fn: "certainty_equivalent", args: [mu, sigma ** 2, M, S, H] });
    }
  }
  const js = {
    option_value: R.optionValue, truncated_variance: R.truncatedVariance, effective_value: R.effectiveValue,
    certainty_equivalent: R.certaintyEquivalent, risk_adjusted_surplus: R.riskAdjustedSurplus, exact_prob_gain: R.exactProbGain,
  };
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const src of [null, refPath].filter((x, j) => j === 0 || x)) {
    const run = spawnSync(python, ["-I", here + "risk_ref.py", ...(src ? [src] : [])], { input: JSON.stringify(grid), encoding: "utf8" });
    if (run.status !== 0) { check(false, `python ${src || "risk_ref.py"} failed: ${(run.stderr || run.error || "").toString().slice(-300)}`); continue; }
    const py = JSON.parse(run.stdout);
    let worst = 0, at = null;
    grid.forEach((g, j) => { const d = Math.abs(js[g.fn](...g.args) - py[j]); if (d > worst) { worst = d; at = g; } });
    check(worst < 1e-9, `${grid.length} values against ${src ? src.split(/[\\/]/).pop() + " (" + src + ")" : "risk_ref.py's copy"}: max |diff| ${worst.toExponential(2)}${at ? ` (${at.fn})` : ""}`);
  }
}

if (!hcsv || !pcsv) {
  console.log(fails ? `FAIL: ${fails} failing` : "OK (parts 1-2; give the CSVs and the risk files for the rest)");
  process.exit(fails ? 1 : 0);
}

// ---- the projections ---------------------------------------------------------------------------
const raw = { h: C.readProjections(readFileSync(hcsv, "utf8")), p: C.readProjections(readFileSync(pcsv, "utf8")) };
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const FORMATS = {
  Yahoo: [12, { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 0, MI: 0, OF: 3, UT: 2 }, { SP: 2, RP: 2, P: 4 }],
  ESPN: [10, { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, { P: 9 }],
  NFBC: [15, { C: 2, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, { P: 9 }],
};
// the page's defaults (index.html, app.js): Yahoo, $260, 5 bench minimized, span 3, curve 1.05, 65% to hitters
const PAGE = {
  teams: 12, slots: FORMATS.Yahoo[1], pitcherSlots: FORMATS.Yahoo[2], hitters: 10, pitchers: 8, bench: 5, minimizeBench: true, span: 3,
  style: "Categories", format: "roto", weeks: 23, minBid: 1, budget: 260, pool: "All", includeFa: true, phi: 1, ptCV: 0.15, lock: "daily",
  twoWay: "split", fillPT: true, specialists: true, curve: 1.05, hitterShare: 0.65,
  hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS, hitterPoints: C.DEFAULT_HITTER_POINTS, pitcherPoints: C.DEFAULT_PITCHER_POINTS,
};
const PTS = { style: "Points" };
const VARIANTS = [
  {}, { curve: 1, hitterShare: null }, { span: 0 }, { bench: 7, minimizeBench: false }, { minBid: 0 }, PTS, { pool: "AL-Only" },
  { hitterCats: ["R", "HR", "RBI", "SB", "OBP", "K%", "OPS", "wOBA", "TB"], pitcherCats: ["K/BB", "W+QS", "ERA", "WHIP", "SV+H", "K-BB%", "HR/9"] },
  { format: "h2h" }, { format: "allplay", weeks: 20 }, { fillPT: false }, { specialists: false }, { lock: "weekly" }, { lock: "weekly", fillPT: false },
  { twoWay: "simultaneous" }, { twoWay: "oneslot" }, { twoWay: "oneslot", lock: "split" },
];
const leagues = [];
for (const [name, [teams, slots, pitcherSlots]] of Object.entries(FORMATS)) for (const v of VARIANTS) {
  leagues.push({ name, v, s: { ...PAGE, teams, slots, pitcherSlots, hitters: sum(slots), pitchers: sum(pitcherSlots), ...v } });
}
const prep = (s) => ({ H: C.prepHitters(raw.h, s.pool, s.includeFa), P: C.prepPitchers(raw.p, s.pool, s.includeFa) });
const files = hbin && pbin ? { h: R.parseRiskFile(readFileSync(hbin)), p: R.parseRiskFile(readFileSync(pbin)) } : null;

// ---- 3. risk.js prices a line as calc.js does ------------------------------------------------------
console.log("3. risk.js values each projection line as calc.js does");
{
  let worstV = 0, worst$ = 0, worstBudget = 0, lines = 0, where = "";
  for (const { name, v, s } of leagues) {
    const { H, P } = prep(s);
    const res = C.auctionValues(H, P, { ...s, debug: true });
    const dbg = res.debug;
    for (const side of ["h", "p"]) {
      const T = side === "h" ? H : P, d = dbg[side], pr = dbg.pricing[side];
      const cats = s.style === "Points"
        ? [...new Map((side === "h" ? s.hitterPoints : s.pitcherPoints).filter(([c]) => c)).entries()].map(([cat, pts]) => C.categorySpec(T, side, cat, pts))
        : (side === "h" ? s.hitterCats : s.pitcherCats).map((cat) => C.categorySpec(T, side, cat));
      const rowOf = Int32Array.from({ length: T.n }, (_, i) => i);
      const ctx = { N: s.teams, roles: C.rolesOf(T, side), specialists: s.specialists && s.format === "roto" && s.style !== "Points" };
      const V = R.lineValues(C, d, side, cats, T, rowOf, ctx);
      for (let i = 0; i < T.n; i++) {
        if (!Number.isFinite(d.sgpar[i]) || (d.twAdj && d.twAdj[i] !== 0)) continue;
        const e = Math.abs(V[i] - d.sgpar[i]);
        if (e > worstV) { worstV = e; where = `${name} ${JSON.stringify(v)} ${side} row ${i}`; }
        lines++;
      }
      // calc.js's drafted players, pricing and dollars, rebuilt from its values as risk.js prices CE
      const again = R.priceValues(C, dbg.pricing, side, d.sgpar, s.minBid);
      if (!again.slot.every((t, i) => t === pr.slot[i])) { worst$ = Infinity; where = `${name} ${JSON.stringify(v)} ${side}: drafted players`; }
      worst$ = Math.max(worst$, ...["base", "k", "perSGP", "flat"].map((key) => Math.abs(again.pricing[key] - pr[key])));
      const byId = new Map(res.players.filter((p) => p.type === side && !p.twoWay).map((p) => [p.name + "|" + p.mlbamid, p]));
      for (let i = 0; i < T.n; i++) {
        const p = byId.get(T.data.Name[i] + "|" + T.data.MLBAMID[i]);
        if (!p || !Number.isFinite(p.value)) continue;
        worst$ = Math.max(worst$, Math.abs(again.value[i] - p.value));
      }
    }
    if (files && s.pool === "All") {
      // the risk-aware $ spends what the calculator spends, on exactly as many roster spots (both models)
      for (const model of Object.keys(R.RISK_MODELS)) {
        R.applyRisk(C, res, H, P, s, files, { model });
        const a = res.players.filter((p) => p.drafted).reduce((t, p) => t + p.value, 0);
        const mine = res.players.filter((p) => p.risk && p.risk.drafted), b = mine.reduce((t, p) => t + p.risk.value, 0);
        const minOk = res.players.every((p) => !p.risk || !Number.isFinite(p.risk.value) || (p.risk.drafted ? p.risk.value >= s.minBid - 1e-9 : p.risk.value < s.minBid));
        worstBudget = Math.max(worstBudget, minOk && res.players.every((p) => p.risk) ? Math.abs(a - b) : Infinity);
      }
    }
  }
  check(worstV < 1e-9, `${lines} projection lines in ${leagues.length} leagues: SGP above replacement, max |risk.js − calc.js| ${worstV.toExponential(2)}${worstV ? ` (${where})` : ""}`);
  check(worst$ < 1e-9, `the same leagues: the drafted players, the pricing and the $ rebuilt from the values, max |diff| ${worst$.toExponential(2)}${worst$ > 1e-9 ? ` (${where})` : ""}`);
  if (files) check(worstBudget < 1e-6, `the risk-aware $: its drafted players at the min bid or more, the rest under it, spending the calculator's dollars (${leagues.filter((l) => l.s.pool === "All").length} leagues, models ${Object.keys(R.RISK_MODELS).join(" and ")}): max |diff| $${worstBudget.toExponential(2)}`);
}

// ---- 4. the calculator's output does not change -------------------------------------------------
console.log("4. The calculator's output with risk off");
{
  const clean = (r) => { const out = { ...r }; delete out.debug; return JSON.stringify(out, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)); };
  let same = 0;
  for (const { s } of leagues) {
    const { H, P } = prep(s);
    if (clean(C.auctionValues(H, P, s)) === clean(C.auctionValues(H, P, { ...s, debug: true }))) same++;
  }
  check(same === leagues.length, `debug on and off: the same output in ${same} of ${leagues.length} leagues`);
  if (baseline) {
    const B = await import(pathToFileURL(baseline).href);
    const rawB = { h: B.readProjections(readFileSync(hcsv, "utf8")), p: B.readProjections(readFileSync(pcsv, "utf8")) };
    let eq = 0;
    for (const { s } of leagues) {
      const now = C.auctionValues(C.prepHitters(raw.h, s.pool, s.includeFa), C.prepPitchers(raw.p, s.pool, s.includeFa), s);
      const then = B.auctionValues(B.prepHitters(rawB.h, s.pool, s.includeFa), B.prepPitchers(rawB.p, s.pool, s.includeFa), s);
      if (clean(now) === clean(then)) eq++;
    }
    check(eq === leagues.length, `against ${baseline}: the same output in ${eq} of ${leagues.length} leagues`);
  }
}

if (!files) {
  console.log(fails ? `FAIL: ${fails} failing` : "OK (parts 1-4; give the risk files for the rest)");
  process.exit(fails ? 1 : 0);
}

// ---- 5. the risk files ----------------------------------------------------------------------------
console.log("5. The risk files");
const { H: H0, P: P0 } = prep(PAGE);
for (const side of ["h", "p"]) {
  const f = files[side], T = side === "h" ? H0 : P0, col = side === "h" ? "PA" : "IP";
  const rows = new Map();
  T.data.MLBAMID.forEach((id, i) => { if (Number.isFinite(id) && !rows.has(id)) rows.set(id, i); });
  let matched = 0, ptDraws = 0, ptCsv = 0;
  for (let m = 0; m < f.players; m++) {
    const i = rows.get(f.ids[m]);
    if (i === undefined) continue;
    matched++;
    let s = 0;
    for (let n = 0; n < f.draws; n++) s += f.stats[col][m * f.draws + n];
    ptDraws += s / f.draws; ptCsv += T.data[col][i];
  }
  check(f.head.side === side && matched === f.players,
    `${side === "h" ? "hitters" : "pitchers"}: ${f.players} players × ${f.draws} draws (${f.head.basis} basis, ${f.head.season}), ${f.head.stats.length} stats; ${matched} in the CSV (which has ${T.n}); mean ${col} of the draws / the CSV's ${f3(ptDraws / ptCsv)}`);
}

// ---- 6. end to end ----------------------------------------------------------------------------------
console.log("6. End to end: the page's default league (Yahoo 12 teams, 5x5 roto, $260, curve 1.05, 65% to hitters), risk defaults");
const run = (s, rs) => {
  const { H, P } = prep(s);
  const res = C.auctionValues(H, P, { ...s, debug: true });
  const summary = R.applyRisk(C, res, H, P, s, files, rs);
  return { res, summary };
};
const describe = (summary) => {
  const o = summary.objective;
  return o ? `${o.format}, ${o.payout === "winner" ? "winner take all" : `top ${o.place} of ${o.N}`}: M ${f2(o.M)}, S ${f2(o.S)}, H ${f2(o.H)} ${o.unit}, z ${f3(o.z)} (${o.sims} simulated seasons)` : "points: no objective";
};
const { res, summary } = run(PAGE, {});
console.log(`   objective: ${describe(summary)}`);
console.log(`   IL: ${f2(summary.il.load)} players a team on extended lost time, ${summary.il.slots} IL slots: all taken ${(100 * summary.il.pFull).toFixed(0)}% of the time; transactions ${summary.transactions.key} (λ + ${f3(summary.transactions.lag)})`);
console.log(`   draws for ${summary.sides.h.matched} hitters and ${summary.sides.p.matched} pitchers; risk.js ${summary.ms} ms`);
for (const side of ["h", "p"]) {
  const ps = res.players.filter((p) => p.type === side && p.risk);
  const into = ps.filter((p) => p.risk.drafted && !p.drafted), out = ps.filter((p) => !p.risk.drafted && p.drafted);
  console.log(`   ${side === "h" ? "hitters" : "pitchers"}: ${into.length} enter the drafted players under the risk-aware $ and ${out.length} leave`
    + (into.length ? ` (in: ${into.slice(0, 6).map((p) => p.name).join(", ")}${into.length > 6 ? ", ..." : ""}; out: ${out.slice(0, 6).map((p) => p.name).join(", ")}${out.length > 6 ? ", ..." : ""})` : ""));
}
const priced = res.players.filter((p) => p.risk && p.risk.draws);
check(priced.every((p) => p.risk.delta >= -1e-12 && Number.isFinite(p.risk.value)), `every player with draws: Δ ≥ 0 and a finite risk-aware $ (${priced.length})`);
check(summary.objective.z < 0, "winner take all: z < 0, so variance has value");
// the 15 largest moves among the players worth something either way
const pool = res.players.filter((p) => p.risk && Number.isFinite(p.risk.value) && (p.drafted || p.risk.value >= PAGE.minBid));
const moves = [...pool].sort((a, b) => Math.abs(b.risk.value - b.value) - Math.abs(a.risk.value - a.value)).slice(0, 15);
console.log("   the 15 largest moves (risk-aware $ − calculator $), with the SGP behind them");
console.log("     name                     pos       $        risk $    move     Δ      (1−λ)Δ  payout  IL      SD(V)");
for (const p of moves) {
  const r = p.risk;
  console.log(`     ${p.name.padEnd(24)} ${p.pos.padEnd(8)} ${money(p.value).padStart(8)} ${money(r.value).padStart(8)} ${signed(r.value - p.value).padStart(8)}  ${f3(r.delta ?? 0).padStart(6)} ${f3(r.option ?? 0).padStart(6)} ${f3(r.payout ?? 0).padStart(6)} ${f3(r.il ?? 0).padStart(6)} ${f2(r.sd ?? 0).padStart(6)}`);
}
// Δ by tier
const tierOf = (v) => R.SPREAD_CUTS.filter((c) => v >= c).length;
const q = (arr, x) => { const v = [...arr].sort((a, b) => a - b); const at = (v.length - 1) * x, lo = Math.floor(at), hi = Math.ceil(at); return v[lo] + (v[hi] - v[lo]) * (at - lo); };
console.log("   Δ = E[max(V, r)] − E[V] by the calculator's $ tier (SGP; $ at each side's $/SGP), and the moves");
console.log("     side tier     n     mean Δ  median  p90     mean (1−λ)Δ $  mean payout $  mean IL $  mean move $  drafted");
const tierRows = [];
for (const side of ["h", "p"]) {
  const perSGP = res.perSGP[side];
  for (let t = 0; t < R.TIER_NAMES.length; t++) {
    const ps = priced.filter((p) => p.type === side && tierOf(p.value) === t);
    if (!ps.length) continue;
    const mean = (f) => ps.reduce((a, p) => a + f(p), 0) / ps.length;
    const row = {
      side, tier: R.TIER_NAMES[t], n: ps.length, delta: mean((p) => p.risk.delta), med: q(ps.map((p) => p.risk.delta), 0.5), p90: q(ps.map((p) => p.risk.delta), 0.9),
      opt$: mean((p) => p.risk.option) * perSGP, pay$: mean((p) => p.risk.payout) * perSGP, il$: mean((p) => p.risk.il) * perSGP,
      move: mean((p) => p.risk.value - p.value), drafted: ps.filter((p) => p.drafted).length,
    };
    tierRows.push(row);
    console.log(`     ${side}    ${row.tier.padEnd(7)} ${String(row.n).padStart(5)}  ${f3(row.delta).padStart(6)}  ${f3(row.med).padStart(6)}  ${f3(row.p90).padStart(6)}  ${signed(row.opt$).padStart(12)}  ${signed(row.pay$).padStart(12)}  ${signed(-row.il$).padStart(9)}  ${signed(row.move).padStart(10)}  ${row.drafted}`);
  }
}
// R1's finding, in the same frame: the draws' mean $ against the calculator's $ (default league of run_calc.mjs: curve 1)
{
  const s = { ...PAGE, curve: 1 };
  const { res: r1 } = run(s, {});
  console.log("   R1's check in risk.js (the run_calc.mjs league, curve 1): the 50 draws' mean $ − the calculator's $, by tier");
  for (const side of ["h", "p"]) {
    const perSGP = r1.perSGP[side];
    const parts = R.TIER_NAMES.map((name, t) => {
      const ps = r1.players.filter((p) => p.type === side && p.risk && p.risk.draws && tierOf(p.value) === t);
      return ps.length ? `${name} ${signed(ps.reduce((a, p) => a + (p.risk.mean - p.risk.mu) * perSGP, 0) / ps.length)}` : null;
    }).filter(Boolean);
    console.log(`     ${side}: ${parts.join(", ")}`);
  }
}
// other payouts and settings
console.log("   other settings (mean |move| of the drafted players, and the objective)");
for (const [label, s, rs] of [
  ["H2H each category, top 4 of 12", { ...PAGE, format: "h2h" }, { payout: "playoffs", playoffTeams: 4 }],
  ["H2H each category, winner", { ...PAGE, format: "h2h" }, { payout: "winner" }],
  ["H2H all-play, top 6 of 12", { ...PAGE, format: "allplay" }, { payout: "playoffs", playoffTeams: 6 }],
  ["roto, top 4 of 12", PAGE, { payout: "playoffs", playoffTeams: 4 }],
  ["roto, weekly waivers", PAGE, { transactions: "weekly" }],
  ["roto, limited moves", PAGE, { transactions: "limited" }],
  ["roto, no IL slots", PAGE, { ilSlots: 0 }],
  ["roto, λ = 1 (no option)", PAGE, { lambda: { h: { time: 1, role: 1, skill: 1 }, p: { time: 1, role: 1, skill: 1 } } }],
  ["points", { ...PAGE, style: "Points" }, {}],
]) {
  const { res: r, summary: sm } = run(s, rs);
  const dr = r.players.filter((p) => p.drafted && p.risk);
  const mv = dr.reduce((a, p) => a + Math.abs(p.risk.value - p.value), 0) / dr.length;
  const top = [...dr].sort((a, b) => Math.abs(b.risk.value - b.value) - Math.abs(a.risk.value - a.value))[0];
  console.log(`     ${label.padEnd(32)} mean |move| $${f2(mv)}; largest ${top.name} ${signed(top.risk.value - top.value)}; ${describe(sm)}; IL taken ${(100 * sm.il.pFull).toFixed(0)}%; ${sm.ms} ms`);
  if (label.startsWith("roto, λ = 1")) check(dr.every((p) => !p.risk.draws || Math.abs(p.risk.option) < 1e-12), "λ = 1: no option value");
}

// ---- 7. the models ------------------------------------------------------------------------------
console.log('7. The models: "draws" (the default; risk.js before PLAN rows 13-14), "fixes" and "upgrade"');
{
  // a premium table in R4's shape (about its 12-team values), so that the floor and its month matter
  const PREM = {};
  for (const [slot, row] of Object.entries({ C: [-0.1, 0.1, 0.1, 0.1, 0, -0.1, -0.1], "1B": [-0.2, 0.2, 0, 0, 0, -0.1, -0.1], "2B": [-0.1, 0.4, 0.1, 0.2, 0, 0, 0],
    "3B": [-0.1, 0.2, 0.1, 0.3, 0.1, 0, 0], SS: [-0.2, 0.2, 0, 0.2, -0.2, -0.2, -0.2], OF: [-0.1, 0.6, 0.7, 0.7, 0.7, 0.4, 0.4], UT: [-0.1, 0.7, 0.8, 0.7, 0.7, 0.4, 0.4],
    SP: [-0.1, 1.0, 0.4, 0.5, 0.3, 0, 0], RP: [-0.1, 1.3, 0.7, 0.5, 0.5, 0.4, 0.4], P: [-0.1, 1.4, 0.9, 0.7, 0.7, 0.2, 0.2] })) PREM[slot] = { 10: row, 12: row, 15: row };
  const LAM = { h: { time: 0.27, role: 0.41, skill: 0.41 }, p: { time: 0.18, role: 0.17, skill: 0.18 } };
  const KEYS = ["value", "ce", "eff", "varEff", "delta", "option", "lambda", "r", "il", "bid"];
  if (oldRisk) {
    const O = await import(pathToFileURL(oldRisk).href);
    const filesO = { h: O.parseRiskFile(readFileSync(hbin)), p: O.parseRiskFile(readFileSync(pbin)) };
    let worst = 0, n = 0, where = "";
    const all = leagues.filter((l) => l.s.pool === "All");
    for (const { name, v, s } of all) {
      for (const extra of [{}, { premium: PREM, lambda: LAM }, { premium: PREM, month: 2, transactions: "weekly" }]) {
        const { H, P } = prep(s);
        const a = C.auctionValues(H, P, { ...s, debug: true }), b = C.auctionValues(H, P, { ...s, debug: true });
        R.applyRisk(C, a, H, P, s, files, { model: "draws", ...extra });
        O.applyRisk(C, b, H, P, s, filesO, extra);
        a.players.forEach((p, i) => {
          const x = p.risk, y = b.players[i].risk;
          if (!x || !y) { if (x !== y) { worst = Infinity; where = `${name} ${p.name}: risk on one side only`; } return; }
          for (const key of KEYS) {
            const xa = x[key], ya = y[key];
            const same = xa === ya || (Number.isNaN(xa) && Number.isNaN(ya));
            const d = same ? 0 : Math.abs(xa - ya);
            if (!(d <= worst)) { worst = Number.isNaN(d) ? Infinity : d; where = `${name} ${JSON.stringify(v)} ${JSON.stringify(Object.keys(extra))} ${p.name} ${key}`; }
          }
          n++;
        });
      }
    }
    check(worst === 0, `model "draws" against ${oldRisk.split(/[\\/]/).pop()} (${oldRisk}): ${n} players in ${all.length} leagues × 3 risk settings, max |diff| ${worst.toExponential(2)}${worst ? ` (${where})` : ""}`);
  } else console.log('   (give --old <risk.js before rows 13-14> for the parity of the model "draws")');
  const sideRows = [];
  for (const [label, s] of [["roto", PAGE], ["h2h", { ...PAGE, format: "h2h" }]]) {
    for (const model of ["draws", "upgrade"]) {
      const { res: r, summary: sm } = run(s, { model, premium: PREM, lambda: LAM, ...(label === "h2h" ? { payout: "playoffs", playoffTeams: 6 } : {}) });
      const dp = r.players.filter((p) => p.type === "p" && p.risk && p.risk.drafted);
      const closers = dp.filter((p) => p.risk.role === "RP" && p.value >= 5).length, sp = dp.filter((p) => p.risk.role === "SP").length;
      const sp515 = r.players.filter((p) => p.type === "p" && p.risk && p.risk.role === "SP" && p.value >= 5 && p.value < 15);
      const cl = r.players.filter((p) => p.type === "p" && p.risk && p.risk.role === "RP" && p.value >= 15 && p.value < 30);
      const mv = (ps) => (ps.length ? ps.reduce((a, p) => a + p.risk.value - p.value, 0) / ps.length : NaN);
      sideRows.push({ label, model, sm, dp: dp.length, sp, closers, sp515: mv(sp515), cl: mv(cl) });
      console.log(`   ${label.padEnd(4)} ${model.padEnd(8)} c² h ${f3(sm.model.teamC2.h)} p ${f3(sm.model.teamC2.p)}; k ${sm.model.infoK ? `h ${sm.model.infoK.h} p ${sm.model.infoK.p}` : "1"}; floor at the ${sm.model.floorAt}; `
        + `drafted pitchers ${dp.length} (SP ${sp}, RP $5+ ${closers}); risk $ − $: SP $5-15 ${signed(mv(sp515))}, RP $15-30 ${signed(mv(cl))}`);
    }
  }
  const rotoU = sideRows.find((x) => x.label === "roto" && x.model === "upgrade"), h2hU = sideRows.find((x) => x.label === "h2h" && x.model === "upgrade");
  check(rotoU.sm.model.teamC2.p < 1 && rotoU.sm.model.teamC2.h < 1 && h2hU.sm.model.teamC2.p === 1 && h2hU.sm.model.teamC2.h === 1,
    "c² < 1 for both sides in roto (the draws carry more luck than calc.js's ν), and 1 outside roto");
  // the floor at the replacement is read later in the season than month 0
  const { res: rr } = run(PAGE, { model: "upgrade", premium: PREM, lambda: LAM });
  const ps = rr.players.filter((p) => p.type === "p" && p.risk && p.risk.draws && p.valuedAt);
  check(ps.every((p) => p.risk.r > R.rPos(p.valuedAt, 12, 0, PREM) - 1e-12), `the floor at the replacement is above the month-0 floor for all ${ps.length} pitchers with draws and a slot`);
  const { res: r0 } = run(PAGE, { model: "upgrade" });
  check(r0.players.every((p) => !p.risk || !p.risk.draws || p.risk.r === 0), "with the placeholder premium (empty), r = 0 at any month");
}

if (csvOut) {
  const head = ["Name", "Team", "Y! Pos", "Type", "Drafted", "Value", "Risk $", "Move", "mu SGP", "draws mean SGP", "SD SGP", "Delta SGP", "lambda", "(1-lambda)Delta SGP", "IL SGP", "payout SGP", "CE SGP", "exact"];
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const num = (v, d = 4) => (v === undefined || v === null || Number.isNaN(v) ? "" : Number(v).toFixed(d));
  const lines = [head.join(",")];
  for (const p of res.players.filter((x) => x.risk)) {
    const r = p.risk;
    lines.push([p.name, p.team, p.pos, p.type, p.drafted ? 1 : 0, num(p.value, 2), num(r.value, 2), num(r.value - p.value, 2), num(r.mu), num(r.mean), num(r.sd), num(r.delta),
      num(r.lambda), num(r.option), num(r.il), num(r.payout), num(r.ce), r.exact ? 1 : 0].map((v) => cell(String(v))).join(","));
  }
  writeFileSync(csvOut, "﻿" + lines.join("\n") + "\n", "utf8");
  console.log(`   wrote ${csvOut}`);
}

console.log(fails ? `FAIL: ${fails} failing` : "OK");
process.exit(fails ? 1 : 0);
