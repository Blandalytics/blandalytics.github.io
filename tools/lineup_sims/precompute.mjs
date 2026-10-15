// Simulate every team's lineups once, with the page's own engine, and store the
// results in the data file so the page can compare a lineup against all 30 teams
// without simulating them on every visit.
//
//   node tools/lineup_sims/precompute.mjs 2026 [games=100000]
//
// Also prints how closely the simulated lineups reproduce the actual 2026 numbers.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prepare, rates, simulate, summarize, tilt } from "../../lineup-sims/sim.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const season = process.argv[2] ?? "2026";
const games = Number(process.argv[3] ?? 100000);
const path = join(repo, "lineup-sims", "data", `${season}.json`);
const data = JSON.parse(readFileSync(path, "utf8"));
const model = prepare(data);
const w = data.weights;
const counts = Object.fromEntries(data.players.map((p) => [p[0], p[3]]));

const round = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.round(v * 10000) / 10000]));
function run(lineup, seed, g = games) {
  const r = simulate(model, lineup, g, seed);
  return { ...round(summarize(r.totals, w)), runDist: r.runDist.map((x) => Math.round((x / g) * 1e5) / 1e5),
    spotPA: r.spotPA.map((x) => Math.round((x / g) * 1000) / 1000) };
}

const t0 = Date.now();
const sims = { games, engine: "sim.js", mlb: run(data.mlb.spots.map((s) => rates(s.counts)), 1), teams: {} };
data.teams.forEach((t, i) => {
  sims.teams[t.abbr] = {
    spots: run(t.spots.map((s) => rates(s.counts)), 100 + i),
    most_used: run(t.most_used.orders[0].ids.map((id) => rates(counts[id])), 200 + i),
  };
});
// contact vs power: all nine MLB-average spots moved together along the axis, every
// point on the same seed so the curve's shape isn't noise; 4x the games, since the
// differences are small
const T = data.tradeoff;
const tgames = games * 4;
const thetas = [];
for (let th = -T.range; th <= T.range + 1e-9; th += 0.5) thetas.push(Math.round(th * 10) / 10);
sims.tradeoff = { games: tgames, points: thetas.map((theta) => {
  const { runDist, spotPA, ...s } = run(data.mlb.spots.map((sp) => rates(tilt(sp.counts, T.per_sd, theta))), 777, tgames);
  return { theta, ...s };
}) };
const secs = (Date.now() - t0) / 1000;
data.sims = sims;
writeFileSync(path, JSON.stringify(data));

// calibration: simulated by-spot lineups against what the teams actually did
const keys = ["R", "H", "HR", "K", "BB", "AVG", "OBP", "SLG", "wOBA", "PA27"];
const fmt = (x, k) => (["AVG", "OBP", "SLG", "wOBA"].includes(k) ? x.toFixed(3) : x.toFixed(2));
console.log(`${data.teams.length * 2 + 1} lineups x ${games.toLocaleString()} games, ${thetas.length} contact-power points x ${tgames.toLocaleString()}, in ${secs.toFixed(1)}s`);
console.log("contact-power, all spots:", sims.tradeoff.points.map((p) => `${p.theta}: R ${p.R.toFixed(3)} wOBA ${p.wOBA.toFixed(3)}`).join(" | "));
console.log("MLB   sim   ", keys.map((k) => `${k} ${fmt(sims.mlb[k], k)}`).join("  "));
console.log("MLB   actual", keys.map((k) => `${k} ${fmt(data.mlb.actual[k], k)}`).join("  "));
const diffs = Object.fromEntries(keys.map((k) => [k, []]));
for (const t of data.teams) {
  for (const k of keys) diffs[k].push(sims.teams[t.abbr].spots[k] - t.actual[k]);
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const corr = (k) => {
  const xs = data.teams.map((t) => sims.teams[t.abbr].spots[k]), ys = data.teams.map((t) => t.actual[k]);
  const mx = mean(xs), my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  return cov / Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)) * mean(ys.map((y) => (y - my) ** 2)));
};
console.log("teams, sim - actual (mean / mean abs / correlation):");
for (const k of keys) {
  console.log(`  ${k.padEnd(5)} ${fmt(mean(diffs[k]), k).padStart(7)} ${fmt(mean(diffs[k].map(Math.abs)), k).padStart(7)}  r=${corr(k).toFixed(3)}`);
}
