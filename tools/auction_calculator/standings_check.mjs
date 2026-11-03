// The calculator's SGP denominators (D: one standings point's worth of each category, from the
// projections alone) against real standings: the procedure's Task 13.4 history check.
//
//   node standings_check.mjs hitters.csv pitchers.csv [position_eligibility.csv] [standings.csv] ['{"teams": 15, ...}']
//
// standings.csv, one row per team and season, as a site exports a league's final standings:
// Season, Team, then the categories' team totals (R, HR, RBI, SB, AVG, W, SV, K, ERA, WHIP; any of
// the calculator's), and AB and IP so the rate stats come out in the calculator's units (hits,
// earned runs, walks + hits). For each season and category the teams are ranked into roto points
// (N for the best, 1 for the worst, ties shared) and the category's total is regressed on its
// points: the slope is the units one standings point takes, the denominator the history gives
// (Todd Zola's regression, "SGP Values: Right for the Wrong Reasons"). The seasons' slopes are
// averaged; their spread across seasons says how far a single league's history can be trusted.
//
// Without a standings file it prints the calculator's denominators beside published ones from
// real 12-team mixed leagues, each relative to its own HR denominator (sources differ in scale:
// roster depth, season, years averaged; their relative sizes agree far better, Smart Fantasy
// Baseball's "How to Analyze SGP Denominators from Different Sources", 2016).
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";

const args = process.argv.slice(2);
const json = args.find((a) => a.startsWith("{"));
const files = args.filter((a) => !a.startsWith("{"));
const [hf, pf] = files;
const ef = files.find((f, i) => i >= 2 && /elig/i.test(f));
const sf = files.find((f, i) => i >= 2 && f !== ef);
const extra = json ? JSON.parse(json) : {};

const raw = { h: C.readProjections(readFileSync(hf, "utf8")), p: C.readProjections(readFileSync(pf, "utf8")) };
const elig = ef ? { table: C.readProjections(readFileSync(ef, "utf8")), rules: C.YAHOO_ELIGIBILITY } : null;
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const slots = extra.slots || { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 2 };
const pitcherSlots = extra.pitcherSlots || { SP: 2, RP: 2, P: 4 };
const s = {
  slots, pitcherSlots, hitters: sum(slots), pitchers: sum(pitcherSlots), bench: 5, minimizeBench: true, style: "Categories",
  format: "roto", weeks: 23, teams: 12, minBid: 1, budget: 260, span: 3, curve: 1.05, pool: "All", includeFa: true,
  hitterShare: 0.65, hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS, ...extra,
};
const H = C.prepHitters(raw.h, s.pool, s.includeFa, elig), P = C.prepPitchers(raw.p, s.pool, s.includeFa, elig);
const res = C.auctionValues(H, P, s);
const calcD = Object.fromEntries([...res.weights.h, ...res.weights.p].map((w) => [w.cat, w.D]));
const unit = Object.fromEntries([...res.weights.h, ...res.weights.p].map((w) => [w.cat, w.unit]));
const cats = [...s.hitterCats, ...s.pitcherCats];
// a rate stat's denominator in its own points too (BA), over a drafted team's AB
const teamAB = res.players.filter((p) => p.type === "h" && p.drafted).reduce((a, p) => a + (H.data.AB[p.row] || 0), 0) / s.teams;
console.log(`The calculator: ${s.teams} teams, ${s.hitters} hitters and ${s.pitchers} pitchers a team, ${s.format}`);

if (!sf) {
  // Published denominators from real 12-team mixed 5x5 leagues. Rate stats are in their own
  // points (BA), so they're left out of the relative comparison unless converted
  const PUBLISHED = [
    { source: "Razzball (2012), via Smart Fantasy Baseball, 2013", url: "https://www.smartfantasybaseball.com/2013/03/create-your-own-fantasy-baseball-rankings-part-5-understanding-standings-gain-points/",
      D: { HR: 10.4, AVG: 0.0024 } },
    { source: "Ottoneu 5x5 leagues (12 teams, 40-man rosters), the Ottoneu community", url: "https://community.ottoneu.com/t/stats-and-roster-questions-5x5/8627",
      D: { R: 27.25, HR: 10.57, RBI: 28.91, SB: 7.43, W: 4.48, SV: 8.55, K: 55.61 } },
  ];
  const fmt = (v) => (v === undefined ? "" : v.toFixed(v < 1 ? 4 : 1));
  console.log(`\n${"".padEnd(6)}${"calc D".padStart(9)}${"calc /HR".padStart(10)}  ${PUBLISHED.map((p, j) => `${("src" + (j + 1) + " D").padStart(9)}${("/HR").padStart(7)}`).join("  ")}`);
  for (const c of cats) {
    const rel = calcD.HR ? calcD[c] / calcD.HR : NaN;
    const cols = PUBLISHED.map((p) => (p.D[c] !== undefined ? `${fmt(p.D[c]).padStart(9)}${(p.D.HR ? (p.D[c] / p.D.HR).toFixed(2) : "").padStart(7)}` : "".padStart(16)));
    const own = c === "AVG" && unit[c] === "H" ? `   (calc in hits: ${(calcD[c] / teamAB).toFixed(4)} BA over a team's ${teamAB.toFixed(0)} AB)`
      : unit[c] !== c ? `   (calc in ${unit[c]})` : "";
    console.log(`${c.padEnd(6)}${fmt(calcD[c]).padStart(9)}${(c === "AVG" ? NaN : rel).toFixed(2).padStart(10)}  ${cols.join("  ")}${own}`);
  }
  PUBLISHED.forEach((p, j) => console.log(`src${j + 1}: ${p.source}, ${p.url}`));
  process.exit(0);
}

// The history: each season's slope of category total on roto points
const T = C.readProjections(readFileSync(sf, "utf8"));
const seasons = [...new Set(T.data.Season || [null])];
const INVERT = new Set(["ERA", "WHIP", "L", "BB", "H", "ER", "BS", "HR/9", "BB/9"]);
const toCalcUnits = (c, slope, rows) => {
  const mean = (col) => rows.reduce((a, i) => a + T.data[col][i], 0) / rows.length;
  if (["AVG", "OBP", "SLG", "OPS", "ISO"].includes(c) && "AB" in T.data) return slope * mean("AB");
  if (c === "ERA" && "IP" in T.data) return (slope * mean("IP")) / 9;
  if (c === "WHIP" && "IP" in T.data) return slope * mean("IP");
  return slope;
};
const bySeason = {};
for (const season of seasons) {
  const rows = [];
  for (let i = 0; i < T.n; i++) if (!T.data.Season || T.data.Season[i] === season) rows.push(i);
  const N = rows.length;
  for (const c of cats) {
    if (!(c in T.data)) continue;
    const v = rows.map((i) => T.data[c][i]);
    const sign = INVERT.has(c) ? -1 : 1;
    // roto points: N for the best, ties sharing their places' points
    const pts = v.map((x) => {
      const better = v.filter((y) => sign * y > sign * x).length, same = v.filter((y) => y === x).length;
      return N - better - (same - 1) / 2;
    });
    const mp = pts.reduce((a, b) => a + b, 0) / N, mv = v.reduce((a, b) => a + b, 0) / N;
    let sxy = 0, sxx = 0;
    for (let j = 0; j < N; j++) { sxy += (pts[j] - mp) * (v[j] - mv); sxx += (pts[j] - mp) ** 2; }
    (bySeason[c] ||= []).push(Math.abs(toCalcUnits(c, sxy / sxx, rows)));
  }
}
console.log(`\nHistory: ${seasons.length} season(s) of ${sf}`);
console.log(`${"".padEnd(6)}${"history D".padStart(11)}${"± SE".padStart(8)}${"calc D".padStart(9)}${"calc/hist".padStart(11)}`);
for (const c of cats) {
  const d = bySeason[c];
  if (!d) { console.log(`${c.padEnd(6)}${"(not in the file)".padStart(11)}`); continue; }
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const se = d.length > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1) / d.length) : NaN;
  console.log(`${c.padEnd(6)}${m.toFixed(2).padStart(11)}${(Number.isNaN(se) ? "" : se.toFixed(2)).padStart(8)}${calcD[c].toFixed(2).padStart(9)}${(calcD[c] / m).toFixed(2).padStart(11)}`);
}
