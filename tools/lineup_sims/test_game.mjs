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
const parkFile = join(repo, "lineup-sims", "park.js");
const loadFile = join(repo, "lineup-sims", "game-load.js");
const fixtureFile = join(repo, "tools", "lineup_sims", "fixtures", "game_822778.json");
const colorsFile = join(repo, "lineup-sims", "team-colors.js"), pageFile = join(repo, "game-sim", "index.html");
const gameFile = join(repo, "lineup-sims", "game.js"), plpdFile = join(repo, "shared", "plpd.css");
const data = JSON.parse(readFileSync(join(dataDir, `${season}.json`), "utf8"));
const SD = JSON.parse(readFileSync(join(dataDir, `${season}-steal.json`), "utf8"));
const PD = JSON.parse(readFileSync(join(dataDir, `${season}-parks.json`), "utf8"));
// game-sim.js imports sim.js with the page's ?v=; this file imports it plain, so the engine is loaded by URL
const { BAT, PIT, prepareSteal, simulateGames } = await import(pathToFileURL(engineFile).href);
const { BULLPEN_LEAD, HOME_FIELD, PARK_N, homeField, leadBucket, parkAdjust } = await import(pathToFileURL(parkFile).href);
const { bullpenDay, checkSchedule, completedGames, latestGame, lineupKind, parseGame, pkOf, scheduleUrl, seasonUrl, boxscoreUrl } = await import(pathToFileURL(loadFile).href);

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

// 4. ballparks (park.js). The page's "No park" never calls parkAdjust, so it is today's numbers by construction.
// "MLB's average park" is all-1 park factors with each team's home-park environment divided out: for MLB's spots and
// average arms, whose environment is all 1s, that must be today's numbers exactly; for a real team it must not be.
{
  const ones = new Array(PARK_N).fill(1);
  const mlb = hitters("MLB");
  // the same chances, the same array, for every MLB spot against every stretch of pitching
  const same = mlb.every((h) => [arm, pen("MLB"), null].every((pp) => { const q = facing(h, pp); return parkAdjust(q, ones, ones, ones) === q; }));
  check(same, "all-1 park factors and all-1 environments (MLB's spots, average arms) leave every matchup's chances as they were");
  // ... and so the games: MLB's spots and arms (environment all 1s) at MLB's average park are today's games, to the last draw
  const inPark = (f) => (abbr, opp) => {
    const t = team(abbr, opp);
    const at = (pp) => hitters(opp).map((h) => cumulative(parkAdjust(facing(h, pp), f, ones, ones)));
    return { ...t, stages: [{ ...t.stages[0], vs: at(arm) }, { ...t.stages[1], vs: at(pen(abbr)) }] };
  };
  const today = simulateGames(model, [team("MLB", "MLB"), team("MLB", "MLB")], G, 2026);
  const neutral = simulateGames(model, [inPark(ones)("MLB", "MLB"), inPark(ones)("MLB", "MLB")], G, 2026);
  check(JSON.stringify(neutral) === JSON.stringify(today), "MLB's average park, for MLB's spots and arms (environment all 1s), reproduces today's games exactly");
  // a park whose factors are just the players' home-park environments takes nothing out and puts nothing in
  const env = PD.env.COL.map((x) => x / 100), envF = env.map((x, j) => x * ones[j]);
  const q0 = facing(mlb[0], arm);
  check(parkAdjust(q0, envF, env, ones) === q0, "a park equal to the hitter's own environment changes nothing");
  // for a real team the average park is not today: its hitters' home park comes out (a Rockies spot loses Coors)
  const qCol = facing(hitters("COL")[0], arm), avgCol = parkAdjust(qCol, ones, env, ones);
  check(avgCol !== qCol && Math.abs(avgCol[6] / qCol[6] - 1 / env[6]) < 1e-12 && Math.abs(avgCol[5] / qCol[5] - 1 / env[5]) < 1e-12,
    `a Rockies spot at MLB's average park has its home park taken out (HR ×${(1 / env[6]).toFixed(3)}, 3B ×${(1 / env[5]).toFixed(3)})`);
  // a real park: chances still add up to 1, and runs move about as the park's R factor says
  const factors = (name) => PD.parks.find((x) => x.name === name).f.map((x) => x / 100);
  const coors = factors("Coors Field"), tmo = factors("T-Mobile Park");
  const qc = parkAdjust(q0, coors, ones, ones);
  check(Math.abs(qc.reduce((a, x) => a + x, 0) - 1) < 1e-12 && Math.abs(qc[6] / q0[6] - coors[6]) < 1e-12, "Coors: chances add to 1, HR scaled by its factor");
  const runs = (res) => (res.line[0].reduce((a, x) => a + x, 0) + res.line[1].reduce((a, x) => a + x, 0)) / (2 * G);
  const atCoors = runs(simulateGames(model, [inPark(coors)("MLB", "MLB"), inPark(coors)("MLB", "MLB")], G, 2026)) / runs(today);
  const atTmo = runs(simulateGames(model, [inPark(tmo)("MLB", "MLB"), inPark(tmo)("MLB", "MLB")], G, 2026)) / runs(today);
  const R = (name) => PD.parks.find((x) => x.name === name).R / 100;
  check(Math.abs(atCoors - R("Coors Field")) < 0.08, `Coors runs ×${atCoors.toFixed(3)} against its R factor ${R("Coors Field")}`);
  check(Math.abs(atTmo - R("T-Mobile Park")) < 0.05, `T-Mobile runs ×${atTmo.toFixed(3)} against its R factor ${R("T-Mobile Park")}`);
}

// 4b. home field (park.js homeField()): after the park, home batters x m and road batters / m, K and BB per PA,
// hits per ball in play; the outs in play take the rest
{
  const ones = new Array(PARK_N).fill(1);
  const sum = (q) => q.reduce((a, x) => a + x, 0), H = (q) => q[3] + q[4] + q[5] + q[6], BIP = (q) => 1 - q[0] - q[1] - q[2];
  const q0 = facing(hitters("MLB")[3], arm), qh = homeField(q0, 1), qa = homeField(q0, -1);
  check(homeField(q0, 0) === q0, "no home field (a neutral site) leaves a matchup's chances as they were");
  const near = (x, y) => Math.abs(x - y) < 1e-12;
  check(near(sum(qh), 1) && near(sum(qa), 1) && qh.every((x) => x >= 0) && qa.every((x) => x >= 0), "home and road chances are valid distributions");
  check(near(qh[0] / qa[0], HOME_FIELD.K ** 2) && near(qh[1] / qa[1], HOME_FIELD.BB ** 2) && near(qh[2] / qa[2], 1),
    `home over road: K ×${(HOME_FIELD.K ** 2).toFixed(4)}, BB ×${(HOME_FIELD.BB ** 2).toFixed(4)}, HBP the same (each side half the gap)`);
  check(near((H(qh) / BIP(qh)) / (H(qa) / BIP(qa)), HOME_FIELD.HperBIP ** 2), `hits per ball in play ×${(HOME_FIELD.HperBIP ** 2).toFixed(4)} home over road`);
  check([3, 4, 5, 6].every((i) => near(qh[i] / H(qh), q0[i] / H(q0))) && [7, 8, 9, 10].every((i) => near(qh[i] / (BIP(qh) - H(qh)), q0[i] / (BIP(q0) - H(q0)))),
    "the mix of hits (1B to HR) and of outs in play (GB, LD, FB, PU) is kept");
  check(homeField(q0, 1, { K: 1, BB: 1, HBP: 1, HperBIP: 1 }).every((x, i) => near(x, q0[i])), "all-1 multipliers change nothing");
  // the worst cases, after the park: many matchups (seeded), the extreme parks, and extreme made-up chances
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const parks = PD.parks.map((x) => x.f.map((v) => v / 100));
  let ok = true, worst = 1;
  const valid = (q) => near(sum(q), 1) && q.every((x) => x >= 0 && x <= 1);
  for (let n = 0; n < 4000; n++) {
    const raw = Array.from({ length: 11 }, (_, i) => (i === 0 ? 3 * rnd() : rnd() ** 2)), t = sum(raw), q = raw.map((x) => x / t);
    const f = parks[n % parks.length].map((x) => x * (0.8 + 0.4 * rnd()));
    for (const sign of [1, -1]) {
      const r = homeField(parkAdjust(q, f, ones, ones), sign);
      ok &&= valid(r);
      worst = Math.min(worst, ...r);
    }
  }
  const extremes = [[0.9, 0.05, 0.01, 0.01, 0, 0, 0.03, 0, 0, 0, 0], [0.2, 0.2, 0.05, 0.25, 0.1, 0.05, 0.15, 0, 0, 0, 0],
    [0.3, 0.6, 0.1, 0, 0, 0, 0, 0, 0, 0, 0], [0.5, 0.1, 0, 0, 0, 0, 0, 0.2, 0.05, 0.1, 0.05], [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]];
  const coors = PD.parks.find((x) => x.name === "Coors Field").f.map((v) => v / 100);
  for (const q of extremes) for (const sign of [1, -1]) ok &&= valid(homeField(parkAdjust(q, coors, ones, ones), sign)) && valid(homeField(q, sign));
  check(ok, `after any park (Coors included) and either side, chances stay a valid distribution, extremes too (lowest ${worst.toExponential(2)})`);
  // whole games: MLB's spots and arms at MLB's average park, home field on against off
  const hf = (sign) => (abbr, opp) => {
    const t = team(abbr, opp);
    const at = (pp) => hitters(opp).map((h) => cumulative(homeField(facing(h, pp), sign)));
    return { ...t, stages: [{ ...t.stages[0], vs: at(arm) }, { ...t.stages[1], vs: at(pen(abbr)) }] };
  };
  const off = simulateGames(model, [team("MLB", "MLB"), team("MLB", "MLB")], G, 2026);
  const on = simulateGames(model, [hf(1)("MLB", "MLB"), hf(-1)("MLB", "MLB")], G, 2026);
  const share = (r) => r.wins[1] / G, gain = share(on) - share(off);
  check(gain > 0.01 && gain < 0.05, `home field adds ${(100 * gain).toFixed(1)} points to the home team's wins (${(100 * share(off)).toFixed(1)}% → ${(100 * share(on)).toFixed(1)}%)`);
  const k = (r, t) => { let x = 0; for (let i = 0; i < 9; i++) x += r.bat[t][i * BAT.length + BAT.indexOf("K")]; return x; };
  check(k(on, 1) < k(off, 1) && k(on, 0) > k(off, 0), "home batters strike out less with it, road batters more");
}

// 4c. the bullpen by the score (park.js BULLPEN_LEAD, a stage's vsLead in game-sim.js): the pitching side's lead
// picks the bullpen's chances as each plate appearance begins
{
  check([[-9, 0], [-5, 0], [-4, 1], [-3, 1], [-2, 2], [-1, 2], [0, 3], [1, 4], [2, 4], [3, 5], [4, 5], [5, 6], [12, 6]].every(([d, b]) => leadBucket(d) === b),
    "lead buckets: down 5+, 3-4, 1-2, tied, up 1-2, 3-4, 5+");
  check(BULLPEN_LEAD.length === 7 && BULLPEN_LEAD.every((m) => ["K", "BB", "HperBIP"].every((x) => m[x] > 0.8 && m[x] < 1.2) && m.HBP === 1),
    "seven rows of K, BB and hits-per-ball-in-play multipliers, each within 20% of 1");
  const K = BULLPEN_LEAD.map((m) => m.K);
  check(K[4] > 1 && K[5] > 1 && K[0] < 1 && K[1] < 1, "relievers holding a lead of 1-4 strike out more batters; down 3 or more, fewer");
  const lead = (abbr, opp, rows) => {
    const t = team(abbr, opp);
    return { ...t, stages: [t.stages[0], { ...t.stages[1], vsLead: rows.map((m) => hitters(opp).map((h) => cumulative(homeField(facing(h, pen(abbr)), 1, m)))) }] };
  };
  const one = { K: 1, BB: 1, HBP: 1, HperBIP: 1 }, ones = BULLPEN_LEAD.map(() => one);
  const flat = simulateGames(model, [team("NYY", "BOS"), team("BOS", "NYY")], G, 2026);
  const same = simulateGames(model, [lead("NYY", "BOS", ones), lead("BOS", "NYY", ones)], G, 2026);
  check(same.scoreDist.every((n, i) => n === flat.scoreDist[i]) && same.wins.every((w, i) => w === flat.wins[i]),
    "a vsLead of the bullpen's own chances plays exactly the games it plays without one (no extra draws)");
  const real = simulateGames(model, [lead("NYY", "BOS", BULLPEN_LEAD), lead("BOS", "NYY", BULLPEN_LEAD)], G, 2026);
  bookkeeping(real, [lead("NYY", "BOS", BULLPEN_LEAD), lead("BOS", "NYY", BULLPEN_LEAD)], "bullpen by the score");
  const N = 31, spread = (r) => { let s = 0, s2 = 0, n = 0; r.scoreDist.forEach((c, i) => { const m = (i % N) - Math.floor(i / N); s += c * m; s2 += c * m * m; n += c; }); return Math.sqrt(s2 / n - (s / n) ** 2); };
  const oneRun = (r) => { let x = 0; r.scoreDist.forEach((c, i) => { if (Math.abs((i % N) - Math.floor(i / N)) === 1) x += c; }); return x / G; };
  check(spread(real) > spread(flat) && oneRun(real) < oneRun(flat),
    `margins spread (sd ${spread(flat).toFixed(2)} → ${spread(real).toFixed(2)}) and one-run games fall (${(100 * oneRun(flat)).toFixed(1)}% → ${(100 * oneRun(real)).toFixed(1)}%)`);
}

// 5. a real game by gamePk (game-load.js), from a saved Stats API reply (fixtures/game_822778.json: BOS at TOR, 2026-08-11)
{
  const fx = JSON.parse(readFileSync(fixtureFile, "utf8")), pk = fx.pk;
  const hitterIds = new Set(data.players.map((r) => r[0])), pitcherIds = new Set(data.pitchers.map((r) => r[0]));
  const ctx = (over = {}) => ({ season: Number(season), teams: data.teams, hasHitter: (id) => hitterIds.has(id), hasPitcher: (id) => pitcherIds.has(id),
    parks: PD.parks.map((x) => x.name), weeks: PD.weeks, ...over });
  const copy = () => JSON.parse(JSON.stringify(fx));
  const G = parseGame(pk, fx.schedule, fx.boxscore, ctx());
  // the play-by-play cache's starting orders for this game (order codes 100-900), and its first pitchers
  check(G.sides.away.team === "BOS" && G.sides.home.team === "TOR", "teams by Stats API id");
  check(G.sides.away.lineup.join() === "p807799,p678882,p668939,p575929,p677800,p702332,p680776,p655316,p686765", "Red Sox starting nine, in batting order");
  check(G.sides.home.lineup.join() === "p807727,p703520,p665489,p543807,p672386,p676391,p665926,p664702,p664770", "Blue Jays starting nine, substitutes (401, ...) left out");
  check(G.sides.away.sp === "P663776" && G.sides.home.sp === "P656302", "starters: each side's first pitcher (Sandoval, Cease)");
  check(G.sides.away.c === 2 && G.sides.home.c === 4, "catchers: Rutschman batting 3rd, Kirk 5th");
  check(PD.parks[G.park]?.name === "Rogers Centre" && PD.weeks[G.week]?.[2] === "Aug 05 – Aug 11", "ballpark by venue name, week by date");
  check(G.missing.length === 0, "every starter is in the data");
  // a starter the data doesn't have: his team's spot for a hitter, an MLB-average RHP for a pitcher, each named
  const M = parseGame(pk, fx.schedule, fx.boxscore, ctx({ hasHitter: (id) => id !== 668939 && hitterIds.has(id), hasPitcher: (id) => id !== 656302 && pitcherIds.has(id) }));
  check(M.sides.away.lineup[2] === "sBOS-3" && M.sides.home.sp === "PRHP" && M.missing.length === 2
    && M.missing[0].startsWith("Adley Rutschman") && M.missing[1].startsWith("Dylan Cease"), `missing starters replaced and named: ${M.missing.join("; ")}`);
  // only completed MLB games of the season load; anything else is refused with its reason
  const refused = (edit, want) => {
    const f = copy();
    edit(f.schedule.dates[0].games[0]);
    try { parseGame(pk, f.schedule, f.boxscore, ctx()); return false; } catch (e) { return want.test(e.message); }
  };
  check(refused((g) => { g.season = "2025"; }, /from 2025/), "another season is refused");
  check(refused((g) => { g.gameType = "A"; }, /All-Star/), "the All-Star Game is refused");
  check(refused((g) => { g.teams.away.team.id = 999; g.teams.home.team.id = 998; }, /isn't an MLB game/), "a minor-league game is refused");
  check(refused((g) => { g.teams.away.team.id = 999; }, /two MLB clubs/), "a club against a non-MLB team is refused");
  // preseason games don't load: many of their players have no regular-season rates
  check(refused((g) => { g.gameType = "S"; }, /spring training game; preseason games don't load/), "spring training is refused");
  check(refused((g) => { g.gameType = "E"; }, /exhibition; preseason games don't load/), "an exhibition is refused");
  // postseason games load, with the park's factors for the regular season's last week
  const as = (edit) => { const f = copy(); edit(f.schedule.dates[0].games[0]); return parseGame(pk, f.schedule, f.boxscore, ctx()); };
  check(as((g) => { g.venue.name = "Somewhere Else"; }).park === -1, "a venue with no factors gives no park (the page uses the home team's)");
  const ws = as((g) => { g.gameType = "W"; g.officialDate = "2026-10-24"; });
  check(ws.kind === "postseason" && ws.week === PD.weeks.length - 1 && PD.parks[ws.park]?.name === "Rogers Centre", "World Series: its park, last regular-season week");
  check(["F", "D", "L"].every((t) => as((g) => { g.gameType = t; }).week === PD.weeks.length - 1), "Wild Card, Division and League series: last regular-season week");
  check(refused((g) => { g.status = { codedGameState: "D", detailedState: "Postponed" }; }, /wasn't completed \(postponed\)/), "a postponed game is refused");
  // a game postponed and made up later is on the schedule twice under one gamePk (as 849817 is): the completed one loads, on its makeup date
  const madeUp = (order) => {
    const f = copy(), fin = f.schedule.dates[0].games[0], post = JSON.parse(JSON.stringify(fin));
    post.status = { codedGameState: "D", detailedState: "Postponed" };
    fin.officialDate = "2026-08-12";
    const days = [{ date: "2026-08-11", games: [post] }, { date: "2026-08-12", games: [fin] }];
    f.schedule.dates = order === "postponed first" ? days : days.reverse();
    return parseGame(pk, f.schedule, f.boxscore, ctx());
  };
  check(["postponed first", "final first"].every((o) => { const m = madeUp(o); return m.date === "2026-08-12" && PD.weeks[m.week]?.[2] === "Aug 12 – Aug 18"; }),
    "a postponed game made up later loads, on its makeup date (either order)");
  check(refused((g) => { g.gamePk = 1; }, /no game/), "a gamePk the schedule doesn't have is refused");
  const throwsWith = (fn, want) => { try { fn(); return false; } catch (e) { return want.test(e.message); } };
  check(throwsWith(() => parseGame(pk, fx.schedule, { nope: 1 }, ctx()), /can read/), "a box score without teams is refused as unreadable");
  check(throwsWith(() => parseGame(pk, "<html>", fx.boxscore, ctx()), /can read|no game/), "a schedule that isn't JSON's shape is refused");
  const short = copy();
  delete short.boxscore.teams.away.players[Object.keys(short.boxscore.teams.away.players).find((k) => short.boxscore.teams.away.players[k].battingOrder === "900")];
  check(throwsWith(() => parseGame(pk, short.schedule, short.boxscore, ctx()), /starting lineup isn't complete/), "a starting nine short a hitter is refused");
  check(checkSchedule(pk, fx.schedule, Number(season), data.teams).g.venue.name === "Rogers Centre", "checkSchedule passes a completed game through");
  // the final score, for the score grid's outline: from the schedule's Final entry (the fixture has the API's own, BOS 3 at TOR 5)
  const unscored = copy();
  delete unscored.schedule.dates[0].games[0].teams.home.score;
  check(JSON.stringify(parseGame(pk, fx.schedule, fx.boxscore, ctx()).final) === "[3,5]" && parseGame(pk, unscored.schedule, unscored.boxscore, ctx()).final === null,
    "the final score comes back as [away, home] (BOS 3, TOR 5), or null without both");
  const madeUpScore = (order) => {
    const f = copy(), fin = f.schedule.dates[0].games[0], post = JSON.parse(JSON.stringify(fin));
    post.status = { codedGameState: "D", detailedState: "Postponed" };
    post.teams.away.score = post.teams.home.score = 0;
    const days = [{ date: "2026-08-11", games: [post] }, { date: "2026-08-12", games: [fin] }];
    f.schedule.dates = order === "postponed first" ? days : days.reverse();
    return parseGame(pk, f.schedule, f.boxscore, ctx()).final;
  };
  check(["postponed first", "final first"].every((o) => JSON.stringify(madeUpScore(o)) === "[3,5]"), "a made-up game's final score is the completed entry's (either order)");
  check(/[,&=]score(,|&|$)/.test(scheduleUrl(pk)), "the schedule request asks for the score");
  // He pitches, from the game: the starters' outs (the API's: 18 and 15), and who opened a bullpen day
  const G0 = parseGame(pk, fx.schedule, fx.boxscore, ctx());
  check(G0.sides.away.spOuts === 18 && G0.sides.home.spOuts === 15 && /[,&=]outs(,|&|$)/.test(boxscoreUrl(pk)), "each starter's outs in the game, from the box score");
  check(bullpenDay(3, 0, 0) && bullpenDay(6, 12, 60) && !bullpenDay(6, 32, 560) && !bullpenDay(7, 0, 0) && !bullpenDay(null, 0, 0),
    "a bullpen day: 6 outs or fewer and no 2026 starts or short ones (an opener), not a regular starter knocked out early");
  // 849816 then 849817, as the user found it: Shawn Armstrong opened (3 outs, no 2026 starts), Parker Messick started and
  // went 6 outs; loading each sets both sides' plan from this, so the second load turns the bullpen day back into the hook
  const arm = (id) => data.pitchers.find((r) => r[0] === id);
  const [armstrong, messick] = [arm(542888), arm(800048)];
  check(bullpenDay(3, armstrong[6], armstrong[7]) && !bullpenDay(6, messick[6], messick[7]), "849816's Armstrong opens a bullpen day; 849817's Messick (6 outs, a regular starter) gets the hook");
  // the gamePk is all that's sent
  check(pkOf("822778") === 822778 && pkOf(" 822778 ") === 822778 && pkOf("https://baseballsavant.mlb.com/gamefeed?date=8/11/2026&gamePk=822778") === 822778
    && pkOf("https://www.mlb.com/gameday/red-sox-vs-blue-jays/2026/08/11/822778/final/box") === 822778
    && pkOf("82277") === null && pkOf("2026") === null && pkOf("822778; drop") === null && pkOf("abc") === null, "gamePk from the number or a Savant/Gameday link only");
  check(scheduleUrl(pk).includes(`gamePk=${pk}&`) && boxscoreUrl(pk).includes(`/game/${pk}/boxscore?`), "requests built from the number");
  // Random Game's list: completed regular-season and postseason games, each once
  const sg = (gamePk, gameType, code) => ({ gamePk, gameType, status: { codedGameState: code } });
  const listed = completedGames({ dates: [
    { games: [sg(700003, "R", "F"), sg(700002, "R", "D"), sg(700001, "S", "F"), sg(700004, "E", "F")] },
    { games: [sg(700002, "R", "F"), sg(700005, "R", "C"), sg(700006, "A", "F"), sg(700007, "W", "F"), sg(700008, "L", "S")] },
    { games: [sg(700009, "F", "F"), sg(700010, "D", "F"), sg(700011, "L", "F"), sg(700012, "R", "I")] }] });
  check(JSON.stringify(listed) === JSON.stringify([700002, 700003, 700007, 700009, 700010, 700011]),
    "Random Game picks from completed regular-season and postseason games, a made-up game once");
  check(completedGames({}).length === 0 && throwsWith(() => completedGames("<html>"), /can read/), "an empty or unreadable season list");
  check(completedGames(fx.schedule).every((x) => checkSchedule(x, fx.schedule, Number(season), data.teams)), "every listed game passes checkSchedule");
  check(seasonUrl(season).includes(`sportId=1&season=${season}&gameType=R,F,D,L,W&`), "the season list asks for MLB's regular season and postseason");
  // the latest game, for a plain visit: the latest start among the games that load, not the highest gamePk
  check(seasonUrl(season).includes("gameDate"), "the season list has each game's start time");
  const at = (gamePk, gameType, code, gameDate) => ({ ...sg(gamePk, gameType, code), gameDate });
  const late = { dates: [
    { games: [at(849817, "L", "F", "2026-10-17T20:08:00Z"), at(849816, "L", "F", "2026-10-18T00:03:00Z")] },
    { games: [at(849815, "L", "F", "2026-10-19T23:08:00Z"), at(849820, "W", "S", "2026-10-21T00:08:00Z"), at(849830, "S", "F", "2026-10-20T00:00:00Z")] },
    { games: [at(776500, "R", "F", "2026-09-27T19:10:00Z"), at(849818, "L", "D", "2026-10-20T23:08:00Z")] }] };
  check(latestGame(late) === 849815, "the latest game is the latest start among final games (849815, ALCS Game 6), not the highest gamePk");
  check(latestGame({ dates: [{ games: [at(700001, "R", "F", "2026-05-01T17:05:00Z"), at(700002, "R", "F", "2026-05-01T17:05:00Z")] }] }) === 700002,
    "two games starting together: the higher gamePk");
  check(latestGame({}) === null && latestGame({ dates: [{ games: [at(700001, "R", "F", "not a time"), at(700002, "R", "S", "2026-05-01T17:05:00Z")] }] }) === null
    && throwsWith(() => latestGame("<html>"), /can read/), "no final game with a start time: none, and an unreadable reply throws");
}

// 3. Who wins in team colors: every pairing reads on the card and tells the two sides apart
{
  const { TEAM_HEX, MIN_CONTRAST, MIN_DE, contrast, deltaE, readable, teamColors } = await import(pathToFileURL(colorsFile).href);
  const page = readFileSync(pageFile, "utf8");
  const surface = page.match(/--surface:(#[0-9a-f]{6})/)[1], pair = page.match(/--s-away:(#[0-9a-f]{6}); --s-home:(#[0-9a-f]{6})/).slice(1);
  const clubs = data.teams.map((t) => t.abbr);
  check(clubs.every((t) => TEAM_HEX[t]), "every club in the data has colors");
  let bad = [], fell = [];
  for (const a of [...clubs, "MLB"]) for (const h of [...clubs, "MLB"]) {
    const c = teamColors([a, h], surface, pair);
    if (!(contrast(c[0], surface) >= MIN_CONTRAST && contrast(c[1], surface) >= MIN_CONTRAST && deltaE(c[0], c[1]) >= MIN_DE)) bad.push(`${a}-${h}`);
    if (a !== "MLB" && h !== "MLB" && !TEAM_HEX[a].some((x) => readable(x, surface) === c[0])) fell.push(`${a}-${h}`);
  }
  check(!bad.length, `every pairing (and MLB) readable on --surface and distinct${bad.length ? `: ${bad.slice(0, 8).join(" ")}` : ""}`);
  check(!fell.length, `no pairing of clubs falls back to the page's pair${fell.length ? `: ${fell.join(" ")}` : ""}`);
  const [ny, de] = teamColors(["NYY", "DET"], surface, pair), [nyy] = teamColors(["NYY", "BOS"], surface, pair);
  check(ny === nyy && deltaE(de, teamColors(["BOS", "DET"], surface, pair)[1]) >= MIN_DE, "two navy clubs: the home team takes its secondary");
  check(teamColors(["MLB", "MLB"], surface, pair).every((c, i) => c === readable(pair[i], surface)), "MLB against MLB takes the page's pair, readable");
  check(clubs.every((t) => teamColors(["MLB", t], surface, pair)[1] === readable(TEAM_HEX[t][0], surface)
    && teamColors([t, "MLB"], surface, pair)[0] === readable(TEAM_HEX[t][0], surface)), "against MLB every club keeps its primary");
  const [mlb] = teamColors(["MLB", "NYY"], surface, pair);
  check(mlb === readable(pair[1], surface), "MLB at the Yankees: MLB takes the page's orange, the Yankees their blue");
  check(teamColors(["MIA", "TB"], surface, pair)[0] === readable(TEAM_HEX.MIA[1], surface), "Marlins at Rays: the one pairing where the away team takes its secondary");
  check(deltaE(readable("#ec424f", surface), readable("#ff1f23", surface)) < MIN_DE && deltaE(...teamColors(["PHI", "WSH"], surface, pair)) >= MIN_DE, "Phillies red and Nationals red count as alike");

  // the score grid's final-score outline: amber (PLPD's, the share image's copy the same) reads on the card, and
  // the card-colored keyline inside it reads on the ramp's bright steps, where amber alone doesn't
  const js = readFileSync(gameFile, "utf8"), css = readFileSync(plpdFile, "utf8");
  const tile = js.match(/const TILE = \{[^}]*bg: "(#[0-9a-f]{6})"[^}]*amber: "(#[0-9a-f]{6})"/), amber = css.match(/--brand-brand-amber:(#[0-9a-f]{6})/)?.[1];
  const steps = JSON.parse(js.match(/const SG_RAMP = (\[\[[\d, \[\]]+\]\]);/)[1]).map((c) => `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`);
  check(tile && amber && tile[2] === amber && tile[1] === surface, "the outline's amber is PLPD's, and the share image's card is the page's");
  check(contrast(amber, surface) >= 3 && steps.every((s) => contrast(surface, s) >= 3),
    `amber reads on the card (${contrast(amber, surface).toFixed(1)}:1) and the keyline on every ramp step (${steps.map((s) => contrast(surface, s).toFixed(1)).join(", ")}:1)`);
  check(steps.some((s) => contrast(amber, s) < 3), "amber alone doesn't read on the bright squares (why the keyline is there)");
}

// 4d. default lineups (data/<season>-lineups.json, tools/lineup_sims/recent_lineups.py): each club's latest starting nine
// against a right-handed and a left-handed starter
{
  const LU = JSON.parse(readFileSync(join(dataDir, `${season}-lineups.json`), "utf8"));
  const clubs = data.teams.map((t) => t.abbr), hitterIds = new Set(data.players.map((p) => p[0])), teamIds = new Set(clubs);
  const all = clubs.flatMap((t) => ["R", "L"].map((h) => [t, h, LU.teams[t]?.[h]]));
  check(all.every(([, , e]) => e), "every club has a most recent lineup against each hand");
  check(all.every(([t, , e]) => e.ids.length === 9 && new Set(e.ids).size === 9 && e.ids.every((id) => hitterIds.has(id)) && teamIds.has(e.opp) && e.opp !== t),
    "each is nine different hitters in the data, against another club");
  check(all.every(([, , e]) => e.date <= LU.through && e.date.startsWith(String(season))), `each from ${season}, no later than the data (${LU.through})`);
  check(lineupKind("recent") === "recent" && lineupKind("spots") === "spots" && lineupKind("most_used") === "recent" && lineupKind("") === null && lineupKind("x") === null,
    "a link's Lineup: recent or spots as named; an older link's most_used lands on the default (recent); anything else, the page's default");
}

// 4. the engine draws only from its seeded generator
const src = readFileSync(engineFile, "utf8");
check(!/Math\.random/.test(src), "no Math.random in game-sim.js");

console.log(`${passed} checks passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
