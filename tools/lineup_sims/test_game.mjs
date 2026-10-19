// Checks on the Game Sim's engine (lineup-sims/game-sim.js) against the built data files.
//   node tools/lineup_sims/test_game.mjs 2026
// Each team here is a team's lineup spots against the other's spots-average pitching (a fixed
// start, then its bullpen); the checks are the game's bookkeeping and the rules, not its numbers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATS, bullpenOf, cumulative, facing, hitterOf, pitcherOf, prepare, simulate } from "../../lineup-sims/sim.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const season = process.argv[2] ?? "2026";
const dataDir = join(repo, "lineup-sims", "data");
const engineFile = join(repo, "lineup-sims", "game-sim.js");
const data = JSON.parse(readFileSync(join(dataDir, `${season}.json`), "utf8"));
const SD = JSON.parse(readFileSync(join(dataDir, `${season}-steal.json`), "utf8"));
// game-sim.js imports sim.js with the page's ?v=; this file imports it plain, so the engine is loaded by URL
const { BAT, PIT, prepareSteal, simulateGames } = await import(pathToFileURL(engineFile).href);

let failed = 0, passed = 0;
const check = (ok, what) => {
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${what}`); }
};

const model = prepare(data), steal = prepareSteal(SD);
const scaled = (c) => { const t = c.reduce((a, x) => a + x, 0); return c.map((x) => x / t); };
const totals = data.mlb.spots.reduce((acc, s) => acc.map((x, i) => x + s.counts[i]), CATS.map(() => 0));
const league = { all: scaled(totals), cells: Object.fromEntries(Object.entries(data.pitching.cells).map(([k, c]) => [k, scaled(c)])) };
const mode = "own";
const spotsOf = (abbr) => (abbr === "MLB" ? data.mlb.spots : data.teams.find((t) => t.abbr === abbr).spots);
const hitters = (abbr) => spotsOf(abbr).map((s) => hitterOf(s.counts, s.cells, { mode, league }));
const cellsTotal = (cells) => Object.values(cells).reduce((t, c) => t.map((x, i) => x + c[i]), CATS.map(() => 0));
const arm = pitcherOf(data.pitching.cells.RL.map((x, i) => x + data.pitching.cells.RR[i]), { L: data.pitching.cells.RL, R: data.pitching.cells.RR }, "R", { mode, league });
const pen = (abbr) => { const c = data.pitching.teams[abbr] ?? data.pitching.relief_cells; return bullpenOf(cellsTotal(c), c, { mode, league }); };
const vs = (opp, pitching) => hitters(opp).map((h) => cumulative(facing(h, pitching)));
// team `abbr` pitching to `opp`'s spots, and its own spots running
const team = (abbr, opp, withSteal = false) => ({
  stages: [{ from: 0, vs: vs(opp, arm), steal: SD.starter_avg.R }, { from: 16, vs: vs(opp, pen(abbr)), pen: true, steal: SD.pens[abbr] ?? SD.pens.MLB }],
  hook: null,
  ...(withSteal && { runners: Float64Array.from(Array.from({ length: 9 }, (_, i) => SD.spots[`${abbr}-${i + 1}`] ?? [0, 0]).flat()), catcher: SD.catcher_avg }),
});
const sum = (arr, n, cols, k) => { let s = 0; for (let i = 0; i < n; i++) s += arr[i * cols + k]; return s; };
const nB = BAT.length, nP = PIT.length, Bi = (k) => BAT.indexOf(k), Pi = (k) => PIT.indexOf(k);
const G = 20000;

function bookkeeping(res, teams, label) {
  for (let t = 0; t < 2; t++) {
    const bat = res.bat[t], opp = res.pit[1 - t], nS = teams[1 - t].stages.length;
    for (const [b, p] of [["R", "R"], ["H", "H"], ["PA", "BF"], ["BB", "BB"], ["HBP", "HBP"], ["K", "K"], ["HR", "HR"], ["SB", "SB"], ["CS", "CS"]]) {
      check(sum(bat, 9, nB, Bi(b)) === sum(opp, nS, nP, Pi(p)), `${label}: team ${t} batting ${b} = pitching ${p}`);
    }
    check(sum(bat, 9, nB, Bi("R")) === res.line[t].reduce((a, x) => a + x, 0), `${label}: team ${t} runs = line score`);
    check(sum(opp, nS, nP, Pi("ER")) <= sum(opp, nS, nP, Pi("R")), `${label}: ER <= R`);
    check(res.caught[1 - t][0] === sum(bat, 9, nB, Bi("SB")) && res.caught[1 - t][1] === sum(bat, 9, nB, Bi("CS")), `${label}: catcher SB/CS = runners'`);
    check(res.pit[t][Pi("QS")] <= res.games && res.pit[t].slice(nP).every((x, i) => i % nP !== Pi("QS") || x === 0), `${label}: QS only for starters`);
  }
  const W = res.pit.flatMap((p) => p.filter((_, i) => i % nP === Pi("W"))).reduce((a, x) => a + x, 0);
  const L = res.pit.flatMap((p) => p.filter((_, i) => i % nP === Pi("L"))).reduce((a, x) => a + x, 0);
  check(W === res.games - res.ties && L === res.games - res.ties, `${label}: one W and one L a decided game (${W}, ${L})`);
  check(res.wins[0] + res.wins[1] + res.ties === res.games, `${label}: wins + ties = games`);
  check(res.walkoffs <= res.bottom9 + res.extras, `${label}: walk-offs only from the bottom of the 9th on`);
  // no final score is a tie unless the game was called
  let tied = 0;
  for (let a = 0; a < 31; a++) tied += res.scoreDist[a * 31 + a];
  check(tied === res.ties, `${label}: tied final scores = called games`);
  check(res.innings >= 8.5 * res.games, `${label}: games last 8.5+ innings on average`);
}

// 1. the game is the Lineup Sim's game: the away team's innings 1-9 score what simulate() scores
{
  const teams = [team("CLE", "DET"), team("DET", "CLE")];
  const res = simulateGames(model, teams, G, 2026);
  bookkeeping(res, teams, "no steals");
  const lone = simulate(model, teams[1].stages[0].vs, G, 7, [{ from: 16, lineup: teams[1].stages[1].vs }]);
  const a = res.line[0].slice(0, 9).reduce((x, y) => x + y, 0) / G, b = lone.totals.R / G;
  check(Math.abs(a - b) < 0.06, `away innings 1-9 ${a.toFixed(3)} vs simulate() ${b.toFixed(3)}`);
  // same seed, same games; another seed, other games
  const again = simulateGames(model, teams, G, 2026);
  check(JSON.stringify(again) === JSON.stringify(res), "same seed, same result");
  check(JSON.stringify(simulateGames(model, teams, G, 2027).line) !== JSON.stringify(res.line), "another seed, another result");
  check(res.extras > 0.05 * G && res.extras < 0.16 * G, `extra innings ${(100 * res.extras / G).toFixed(1)}% of games`);
  check(res.bottom9 > 0.4 * G && res.bottom9 < 0.75 * G, `bottom of the 9th played in ${(100 * res.bottom9 / G).toFixed(1)}%`);
}

// 2. stolen bases: everyone pooled at MLB average steals about as 2026 did, and the running game
// split by attempts leaves runs where they were
{
  const mk = (s) => [
    { ...team("MLB", "MLB", s), runners: Float64Array.from(Array.from({ length: 9 }, (_, i) => SD.spots[`MLB-${i + 1}`]).flat()), catcher: SD.catcher_avg },
    { ...team("MLB", "MLB", s), runners: Float64Array.from(Array.from({ length: 9 }, (_, i) => SD.spots[`MLB-${i + 1}`]).flat()), catcher: SD.catcher_avg },
  ].map((t) => ({ ...t, stages: t.stages.map((st, i) => ({ ...st, pen: i > 0, steal: i ? SD.pens.MLB : SD.starter_avg.R })) }));
  const off = simulateGames(model, mk(false), G, 2026);
  const on = simulateGames(model, mk(true), G, 2026, null, steal);
  bookkeeping(on, mk(true), "steals");
  const runs = (res) => (res.line[0].reduce((a, x) => a + x, 0) + res.line[1].reduce((a, x) => a + x, 0)) / (2 * G);
  check(Math.abs(runs(on) - runs(off)) < 0.06, `runs with steals ${runs(on).toFixed(3)} vs the league running game ${runs(off).toFixed(3)}`);
  const per = (k) => (sum(on.bat[0], 9, nB, Bi(k)) + sum(on.bat[1], 9, nB, Bi(k))) / (2 * G);
  const sb = per("SB") / (SD.actual.SB / SD.actual.team_games), cs = per("CS") / (SD.actual.CS / SD.actual.team_games);
  check(Math.abs(sb - 1) < 0.15, `SB a team game ${per("SB").toFixed(3)}, ${(100 * (sb - 1)).toFixed(1)}% off ${season}'s`);
  check(Math.abs(cs - 1) < 0.15, `CS a team game ${per("CS").toFixed(3)}, ${(100 * (cs - 1)).toFixed(1)}% off ${season}'s`);
  check(off.caught.every(([a, b]) => a === 0 && b === 0), "no SB or CS counted without the steal model");
  // a catcher who stops the running game stops it
  const weak = [...Object.values(SD.catchers)].filter((c) => c[4] > 1000).sort((a, b) => b[0] - a[0])[0];
  const strong = [...Object.values(SD.catchers)].filter((c) => c[4] > 1000).sort((a, b) => a[0] - b[0])[0];
  const against = (c) => { const t = mk(true); t[1] = { ...t[1], catcher: [c[0], c[1]] }; return simulateGames(model, t, G, 2026, null, steal).caught[1]; };
  const [w, s] = [against(weak), against(strong)];
  check(w[0] + w[1] > s[0] + s[1], `more attempts against ${weak[2]} (${w[0] + w[1]}) than ${strong[2]} (${s[0] + s[1]})`);
}

// 3. the engine draws only from its seeded generator
const src = readFileSync(engineFile, "utf8");
check(!/Math\.random/.test(src), "no Math.random in game-sim.js");

console.log(`${passed} checks passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
