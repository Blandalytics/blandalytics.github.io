// Game Sim: two lineups, each against the other team's pitching, played as MLB games
// (game-sim.js), with the box score averaged over every game. Lineups, pitchers and matchups
// are built as the Lineup Sim (app.js) builds them: each player's 2026 rates, log5 against the
// pitcher, platoon splits, Small samples, and a starter who goes until the modeled hook (or his
// average start, or opens a bullpen day), then his team's bullpen. Stolen bases go by who's on
// base, who's pitching and who's catching (data/<season>-steal.json, pipeline/steal_model.py). The
// game is played in a ballpark, with the park-factors project's factors (data/<season>-parks.json).
// sim.js is the Lineup Sim's engine: when its ?v= changes there (app.js), change it here too, or the
// two pages load two copies of it
import { CATS, bullpenOf, cumulative, facing, hitterOf, pitcherOf, prepare } from "./sim.js?v=8";
import { BAT, HIST_BINS, HIST_NP_WIDTH, PIT, prepareSteal, simulateGames } from "./game-sim.js?v=5";
import { BULLPEN_LEAD, PARK_N, homeField, parkAdjust as adjustForPark } from "./park.js?v=3";
import { boxscoreUrl, bullpenDay, checkSchedule, completedGames, latestGame, lineupKind, parseGame, pkOf, scheduleUrl, seasonUrl } from "./game-load.js?v=8";
import { teamColors } from "./team-colors.js?v=2";

const SEASON = 2026;
const SEED = 2026;
const $ = (id) => document.getElementById(id);
const C = Object.fromEntries(CATS.map((c, i) => [c, i]));
const nB = BAT.length, nP = PIT.length;
const Bi = Object.fromEntries(BAT.map((k, i) => [k, i])), Pi = Object.fromEntries(PIT.map((k, i) => [k, i]));

let data, model, league;
let hookData = null;        // data/<season>-hook.json: the hook model and pitches per plate appearance
const entries = new Map();  // hitters and lineup spots: "p<id>", "s<team>-<spot>"
const pitchers = new Map(); // "P<id>", and "PRHP" / "PLHP" for an MLB-average arm

// the two teams; SIDES[0] bats first (away)
const SIDES = [
  { k: "a", where: "Away", team: "CLE", kind: "recent", lineup: [], edited: false, sp: null, plan: "hook", c: 8 },
  { k: "h", where: "Home", team: "DET", kind: "recent", lineup: [], edited: false, sp: null, plan: "hook", c: 8 },
];

// ---------- formatting ----------
const fmtRate = (x) => (Number.isFinite(x) ? x.toFixed(3).replace(/^0/, "") : "—");
const pct = (x) => (100 * x).toFixed(1) + "%";
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const lastName = (n) => n.split(" ").filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w)).pop();
// a pitcher's surname whole ("Woods Richardson", "De Los Santos"): the name less the first name, any
// middle initial and any suffix; an MLB-average arm keeps its label
const surname = (n) => (/^MLB-average /.test(n) ? n
  : n.split(" ").slice(1).filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV|[A-Z]\.)$/.test(w)).join(" ") || n);
const fmtIP = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
const countOf = (c) => (c ? c.reduce((a, x) => a + x, 0) : 0);
const handOf = (e) => ({ L: "LHP", R: "RHP" })[e.throws] ?? "P";
const startOutsOf = (e) => Math.round(e.startOuts / e.gs);
const cellsTotal = (cells) => Object.values(cells).reduce((t, c) => t.map((x, i) => x + c[i]), CATS.map(() => 0));

function wobaOf(counts) {
  const w = data.weights, n = countOf(counts);
  return (w.wBB * counts[C.BB] + w.wHBP * counts[C.HBP] + w.w1B * counts[C["1B"]] + w.w2B * counts[C["2B"]]
    + w.w3B * counts[C["3B"]] + w.wHR * counts[C.HR]) / n;
}

// ---------- data ----------
function buildEntries() {
  const nameOf = new Map();
  for (const [id, name, team, counts, pa, cells, bats] of data.players) {
    nameOf.set(id, name);
    const side = { L: "bats L", R: "bats R", S: "switch" }[bats];
    entries.set(`p${id}`, { id: `p${id}`, kind: "player", name, team, counts, pa, cells, bats,
      sub: [team, side, `${pa} PA`].filter(Boolean).join(" · "), search: fold(name) });
  }
  const spotsOf = (abbr, label, short, spots) => spots.forEach((s, i) => {
    const pa = countOf(s.counts);
    const who = abbr === "MLB" ? "every MLB hitter in this spot"
      : s.top.map(([pid, n]) => `${lastName(nameOf.get(pid) ?? String(pid))} ${Math.round((100 * n) / pa)}%`).join(", ");
    // in the box score: the spot's two main hitters
    const lead = abbr === "MLB" ? `MLB ${ordinal(i + 1)} spot` : s.top.slice(0, 2).map(([pid]) => lastName(nameOf.get(pid) ?? String(pid))).join(" / ");
    entries.set(`s${abbr}-${i + 1}`, { id: `s${abbr}-${i + 1}`, kind: "spot", name: `${label} · ${ordinal(i + 1)} spot`, spot: `${ordinal(i + 1)} spot`, lead,
      team: abbr, counts: s.counts, cells: s.cells, pa, sub: who, search: fold(`${label} ${short} ${abbr} ${i + 1} spot`) });
  });
  spotsOf("MLB", "MLB", "mlb league average", data.mlb.spots);
  for (const t of data.teams) spotsOf(t.abbr, t.short, `${t.name} ${t.abbr}`, t.spots);
  const scaled = (c) => { const t = countOf(c); return c.map((x) => x / t); };
  const totals = data.mlb.spots.reduce((acc, s) => acc.map((x, i) => x + s.counts[i]), CATS.map(() => 0));
  league = { all: scaled(totals), cells: Object.fromEntries(Object.entries(data.pitching.cells).map(([k, c]) => [k, scaled(c)])) };
  for (const [id, name, team, throws, counts, bf, gs, startOuts, cells, bulk] of data.pitchers) {
    pitchers.set(`P${id}`, { id: `P${id}`, mlbam: id, name, team, throws, counts, cells, pa: bf, gs, startOuts, bulk, search: fold(`${name} ${team}`) });
  }
  // an MLB-average right- or left-hander: every 2026 pitcher of that hand pooled
  for (const hand of ["R", "L"]) {
    const cells = { L: data.pitching.cells[hand + "L"], R: data.pitching.cells[hand + "R"] };
    const counts = cells.L.map((x, i) => x + cells.R[i]);
    const own = data.pitchers.filter((r) => r[3] === hand);
    pitchers.set(`P${hand}HP`, { id: `P${hand}HP`, mlbam: `${hand}HP`, generic: true, name: `MLB-average ${hand}HP`, team: "MLB", throws: hand,
      counts, cells, pa: countOf(counts), gs: own.reduce((t, r) => t + r[6], 0), startOuts: own.reduce((t, r) => t + r[7], 0), bulk: 0,
      search: fold(`mlb average ${hand}hp ${hand === "R" ? "right handed righty" : "left handed lefty"} pitcher`) });
  }
}
const teamOf = (abbr) => data.teams.find((t) => t.abbr === abbr);
const teamName = (abbr) => (abbr === "MLB" ? "MLB" : teamOf(abbr).short);
const teamAbbr = (s) => (SIDES[0].team === SIDES[1].team ? s.where : s.team);

async function loadHookData() {
  const r = await fetch(new URL(`data/${SEASON}-hook.json?v=1`, import.meta.url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const t = d.trees;
  const probs = (c) => { const n = countOf(c); return c.map((x) => x / n); };
  d.trees = { feat: Int32Array.from(t.feat), thr: Float64Array.from(t.thr), dl: Uint8Array.from(t.dl), miss: Uint8Array.from(t.miss),
    left: Int32Array.from(t.left), right: Int32Array.from(t.right), leaf: Float64Array.from(t.leaf), roots: Int32Array.from(t.roots) };
  d.pitchCums = CATS.map((c) => cumulative(probs(d.pitches[c])));
  hookData = d;
}
// the hook model's before-the-game values for a starter: a typical start of his (an MLB-average
// arm: the league's), at normal rest, as app.js hookOf()
function hookOf(e) {
  const H = hookData, own = !e.generic && H.pitchers[e.mlbam];
  const x = new Float64Array(H.features.length).fill(NaN);
  const set = (k, v) => { x[H.features.indexOf(k)] = v; };
  for (const [k, v] of Object.entries(H.defaults)) set(k, v);
  set("team_start_outs", (own && H.teams[own[4]]) || H.league.team_start_outs);
  ["max3", "max5", "mean3", "starts_season"].forEach((k, i) => set(k, own ? own[i] : H.league[k]));
  return { trees: H.trees, features: H.features, x };
}

// ---------- stolen bases ----------
// Each runner with the next base open may try for it before a plate appearance, at odds from a
// model of 2026's (pipeline/steal_model.py): the runner's, the pitcher's (his hand's in it) and
// the catcher's effects on trying, and on making it, as logits. A lineup spot, a bullpen, an
// MLB-average starter come pooled; a player the model never saw is a typical one (0). The catcher
// is one of the team's nine (s.c, the slot): a 2026 catcher as himself, a lineup spot as the
// team's catchers who batted there, pooled. Loaded at boot; without it, the league running game as
// the Lineup Sim has it.
let stealData = null, stealHere = null;
async function loadStealData() {
  const r = await fetch(new URL(`data/${SEASON}-steal.json?v=1`, import.meta.url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  stealData = await r.json();
}
const stealOn = () => !!stealData && $("steals").value === "model";

// data/<season>-lineups.json (tools/lineup_sims/recent_lineups.py): each team's starting nine in its latest 2026
// game against a right-handed and against a left-handed starter. A team's default lineup ("recent") is
// the one against the hand of the other team's starter, and follows it when that starter changes.
let lineupData = null;
async function loadLineupData() {
  const r = await fetch(new URL(`data/${SEASON}-lineups.json?v=1`, import.meta.url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  lineupData = await r.json();
}
const otherSide = (s) => SIDES[s === SIDES[0] ? 1 : 0];
const handFaced = (s) => otherSide(s).sp?.throws === "L" ? "L" : "R";
const recentOf = (s) => lineupData?.teams[s.team]?.[handFaced(s)] ?? null;
const CATCH_SHARE = 0.05; // a spot catches if 5% of its team's catching was done from it
// What slot i does behind the plate: [attempt, success, how much] (a catcher's: his opportunities
// caught; a spot's: its share of the team's), or null if it didn't catch in 2026.
function catchOf(s, i) {
  const e = entries.get(s.lineup[i]);
  if (e.kind === "spot") {
    const c = stealData.cspots[e.id.slice(1)];
    return c && c[2] >= CATCH_SHARE ? c : null;
  }
  const c = stealData.catchers[e.id.slice(1)];
  return c ? [c[0], c[1], 1 + c[4]] : null;
}
const catchingSlots = (s) => s.lineup.map((_, i) => i).filter((i) => catchOf(s, i));
// the slot that catches most: a catcher in the order (the one who caught most), else the spot the team's catchers batted in most
function defaultCatcher(s) {
  const slots = catchingSlots(s);
  return slots.length ? slots.reduce((a, i) => (catchOf(s, i)[2] > catchOf(s, a)[2] ? i : a)) : 8;
}
// the slot must be one that catches, while the lineup has one
function checkCatcher(s) {
  const slots = catchingSlots(s);
  if (!(s.c >= 0 && s.c < 9) || (slots.length && !slots.includes(s.c))) s.c = defaultCatcher(s);
}
const catcherSteal = (s) => catchOf(s, s.c)?.slice(0, 2) ?? stealData.catcher_avg;
const catcherName = (s) => {
  const e = entries.get(s.lineup[s.c]);
  return e.kind === "spot" && e.team === s.team ? `${s.team === "MLB" ? "MLB's" : `${teamName(s.team)}'`} ${e.spot}` : e.name;
};
const runnerSteal = (e) => (e.kind === "spot" ? stealData.spots[e.id.slice(1)] : stealData.runners[e.id.slice(1)]) ?? [0, 0];
const armSteal = (e) => (e.generic ? stealData.starter_avg[e.throws] : stealData.pitchers[e.mlbam] ?? stealData.hand[e.throws] ?? [0, 0]);
const penSteal = (s) => stealData.pens[s.team] ?? stealData.pens.MLB;
const times = (x) => `×${Math.exp(x).toFixed(2)}`;

// the catcher box: the slots that caught in 2026 (all nine when none did)
function fillCatchers(s) {
  checkCatcher(s);
  const sel = $(`${s.k}_c`), slots = catchingSlots(s);
  sel.replaceChildren(...(slots.length ? slots : s.lineup.map((_, i) => i)).map((i) => {
    const e = entries.get(s.lineup[i]), c = catchOf(s, i);
    const label = e.kind === "spot" ? `${e.name}${c ? ` (${Math.round(100 * c[2])}%)` : ""}` : e.name;
    return new Option(`${i + 1}. ${label}`, i);
  }));
  sel.value = String(s.c);
}

// ---------- the ballpark ----------
// data/<season>-parks.json (pipeline/park_factors.py, from blandalytics.com/park-factors/): each
// park's factors for K, BB, HBP, 1B, 2B, 3B and HR (100: the season's average park; all batters, not
// by hand), for the season and each week, and each team's environment (half its games at home, half
// on the road). Every plate appearance of the game, both teams', is in the park: park.js divides a
// matchup by the hitter's and the pitcher's environments and multiplies by the park's factors.
// park.at: a park's index, "avg" (MLB's average park, players' home parks taken out) or "none"
// (2026 rates as they are). park.auto: it follows the home team.
let parkData = null;
const park = { at: "none", auto: true, week: -1 };
async function loadParkData() {
  const r = await fetch(new URL(`data/${SEASON}-parks.json?v=1`, import.meta.url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  parkData = await r.json();
}
// the home team's park (most games), or MLB's average park
function homePark() {
  const i = parkData.parks.findIndex((p) => p.team === SIDES[1].team);
  return i < 0 ? "avg" : i;
}
const ONES = new Array(PARK_N).fill(1);
// the park's factors as ratios: for the season, or the week picked (the league's calendar in it)
function parkFactors() {
  if (typeof park.at !== "number") return ONES; // MLB's average park (or none)
  const p = parkData.parks[park.at];
  return park.week >= 0 ? p.weeks[park.week].slice(0, PARK_N).map((x) => x / 1000) : p.f.map((x) => x / 100);
}
const envOf = (team) => (parkData.env[team] ? parkData.env[team].map((x) => x / 100) : ONES);
const parkAdjust = (q, hTeam, pTeam) => (!parkData || park.at === "none" ? q : adjustForPark(q, parkFactors(), envOf(hTeam), envOf(pTeam)));
// Home field (park.js homeField()): the home team's batters strike out less, walk more and hit more on
// contact, the road team's the reverse. Not at a neutral site: a park that's another club's or no
// club's home. MLB's average park and No park are the home team's.
const homeEdge = () => !parkData || typeof park.at !== "number" || parkData.parks[park.at].team === SIDES[1].team;
const parkName = () => (park.at === "none" ? null : park.at === "avg" ? "MLB's average park" : parkData.parks[park.at].name);
const slugOf = (n) => fold(n).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function fillPark() {
  const sel = $("park"), wk = $("park_week");
  if (!parkData) return;
  if (park.auto) park.at = homePark();
  if (!sel.options.length) {
    const home = document.createElement("optgroup");
    home.label = `Home parks, ${SEASON}`;
    parkData.parks.map((p, i) => [p, i]).filter(([p]) => p.team).sort((a, b) => a[0].name.localeCompare(b[0].name))
      .forEach(([p, i]) => home.append(new Option(`${p.name} (${p.team})`, i)));
    const neutral = document.createElement("optgroup");
    neutral.label = "Neutral sites";
    parkData.parks.forEach((p, i) => { if (!p.team) neutral.append(new Option(p.name, i)); });
    sel.append(new Option("MLB's average park", "avg"), home, neutral, new Option(`No park: ${SEASON} rates as they are`, "none"));
    wk.append(new Option(`${SEASON} season`, -1), ...parkData.weeks.map((w, i) => new Option(w[2], i)));
  }
  sel.value = String(park.at);
  wk.disabled = typeof park.at !== "number";
  if (wk.disabled) park.week = -1;
  wk.value = String(park.week);
  const f = parkFactors(), p = typeof park.at === "number" ? parkData.parks[park.at] : null;
  const r = p ? (park.week >= 0 ? p.weeks[park.week][PARK_N] : p.R * 10) / 1000 : 1;
  const chg = (x) => `${x >= 1 ? "+" : "−"}${Math.abs(100 * (x - 1)).toFixed(0)}%`;
  $("park_note").textContent = park.at === "none" ? "Each player's 2026 rates as they are, home park and all"
    : park.at === "avg" ? "Every player's home park taken out, in an average park"
    : `Runs ${chg(r)}, HR ${chg(f[6])}, 2B ${chg(f[4])}, 3B ${chg(f[5])}, K ${chg(f[0])}`
      + `${park.week >= 0 ? " that week (with the league's calendar)" : ""}; each player's home park taken out first`;
  const home = SIDES[1].team;
  if (!homeEdge()) $("park_note").textContent += p.team && home !== "MLB" ? `. Not the ${teamName(home)}' park, so no home-field edge` : ". A neutral site: no home-field edge";
}

// ---------- a real game, by gamePk ----------
// Any completed 2026 regular-season game, from MLB's Stats API: game-load.js reads the schedule and
// box score into a matchup (both teams, their starting nines in order, the starting pitchers, each
// team's catcher, the ballpark and the week); here it's fetched and put on the page, with He pitches
// set from what each starter did (bullpenDay); the Sim settings stay as they were. A game is fetched
// only on Load (or Enter), Random Game, or once
// as the page opens when the link asks for one: blandalytics.com/game-sim/<gamePk> (or the older
// /lineup-sims/<gamePk>) lands here as /game-sim/#gp=<gamePk> (the site's 404.html sends it), and so
// does /game-sim/#<gamePk>.
const FETCH_MS = 8000;
// a Stats API reply, or a plain reason it isn't one: no answer within FETCH_MS, a network failure,
// a status other than 200, or a body that isn't JSON
async function getJSON(url) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), FETCH_MS);
  let r;
  try {
    r = await fetch(url, { signal: ctl.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `the MLB Stats API didn't answer within ${FETCH_MS / 1000} seconds` : "the MLB Stats API couldn't be reached");
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`the MLB Stats API answered ${r.status}`);
  try {
    return await r.json();
  } catch {
    throw new Error("the MLB Stats API's reply wasn't readable");
  }
}
async function loadGame(pk) {
  const ctx = { season: SEASON, teams: data.teams, hasHitter: (id) => entries.has(`p${id}`), hasPitcher: (id) => pitchers.has(`P${id}`),
    parks: parkData ? parkData.parks.map((x) => x.name) : [], weeks: parkData ? parkData.weeks : [] };
  const sched = await getJSON(scheduleUrl(pk));
  checkSchedule(pk, sched, SEASON, data.teams); // whether it's a game that loads, before the larger box score is asked for
  return parseGame(pk, sched, await getJSON(boxscoreUrl(pk)), ctx);
}
// A loaded game's final score ([away, home]), kept while the matchup is still that game: the same
// teams, nines in the same order and starters (the Sim settings, the park and He pitches can change).
let realGame = null;
const gameKey = () => JSON.stringify(SIDES.map((s) => [s.team, s.lineup, s.sp?.id]));
const realFinal = () => (realGame && realGame.key === gameKey() ? realGame.final : null);
// and what each side actually did in it ([away, home], game-load.js observed), for the box score's hover charts
const realLines = () => (realGame && realGame.key === gameKey() ? realGame.observed : null);
function applyGame(G) {
  [["away", SIDES[0]], ["home", SIDES[1]]].forEach(([where, s]) => {
    const x = G.sides[where];
    Object.assign(s, { team: x.team, lineup: x.lineup, edited: true, sp: pitchers.get(x.sp) });
    // He pitches, from the game: a bullpen day if the starter opened one, else the modeled hook
    // (renderSide steps down to what he can do: a pitcher with no 2026 starts has no hook)
    s.plan = bullpenDay(x.spOuts, s.sp.gs, s.sp.startOuts) ? "bullpen" : "hook";
    s.c = x.c;
    if (stealData) checkCatcher(s);
  });
  if (parkData) {
    Object.assign(park, G.park >= 0 ? { at: G.park, auto: false } : { at: "none", auto: true });
    if (park.auto) park.at = homePark();
    park.week = G.week;
  }
  realGame = G.final ? { final: G.final, observed: [G.sides.away.observed, G.sides.home.observed], key: gameKey() } : null;
  SIDES.forEach(renderSide);
  fillPark();
  run();
  const day = new Date(`${G.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const a = G.sides.away, h = G.sides.home;
  $("gpk_note").classList.toggle("warn", G.missing.length > 0);
  const wk = parkData && G.week >= 0 ? parkData.weeks[G.week][2] : null;
  const spOf = (t, x) => `${x.spName}${SIDES[t].plan === "bullpen" ? " (opener)" : ""}`;
  $("gpk_note").textContent = `${a.short} at ${h.short}, ${day}, ${G.venue}${G.kind === "regular" ? "" : ` (${G.type})`}: `
    + `both starting nines and starters (${spOf(0, a)}, ${spOf(1, h)})`
    + (G.park < 0 && parkData ? `; ${G.venue} has no ${SEASON} park factors, so ${parkName() ?? "no park"}` : "")
    + (G.kind === "postseason" && wk ? `, with the regular season's last week (${wk})` : "")
    + (G.missing.length ? `. Not in the ${SEASON} data, so replaced: ${G.missing.join(", ")}.` : ".");
  // the game's short link (the site's 404.html turns it into /game-sim/#gp=)
  const link = document.createElement("a");
  link.href = `/game-sim/${G.pk}`;
  link.textContent = `${location.host}/game-sim/${G.pk}`;
  $("gpk_note").append(" Link: ", link);
}
// Load and Random Game wait for each other
function loading(on) {
  $("gpk_go").disabled = on;
  $("gpk_rand").disabled = on;
}
async function onLoadGame() {
  const pk = pkOf($("gpk").value), note = $("gpk_note");
  note.classList.remove("warn", "err");
  if (!pk) {
    note.textContent = "Enter a gamePk: the 6- or 7-digit game number in a Baseball Savant or MLB Gameday link (or the link itself).";
    note.classList.add("err");
    return;
  }
  loading(true);
  note.textContent = `loading game ${pk}…`;
  try {
    applyGame(await loadGame(pk));
  } catch (e) {
    // the matchup on screen stays as it was
    note.textContent = `Couldn't load it: ${e.message}.`;
    note.classList.add("err");
  } finally {
    loading(false);
  }
}
// The season's schedule (seasonUrl), asked for once and kept for the page's life: the latest game on a
// plain visit, then Random Game's list. A failed ask is forgotten, so the next one tries again.
let seasonReply = null;
const seasonSchedule = () => (seasonReply ??= getJSON(seasonUrl(SEASON)).catch((e) => { seasonReply = null; throw e; }));
// Random Game: any game that loads, all equally likely; the pick goes in the box and loads like a typed one.
let seasonGames = null;
async function onRandomGame() {
  const note = $("gpk_note");
  note.classList.remove("warn", "err");
  if (!seasonGames) {
    loading(true);
    note.textContent = `finding the ${SEASON} games…`;
    try {
      const pks = completedGames(await seasonSchedule());
      if (!pks.length) throw new Error(`the MLB Stats API lists no completed ${SEASON} games`);
      seasonGames = pks;
    } catch (e) {
      note.textContent = `Couldn't pick a game: ${e.message}.`;
      note.classList.add("err");
      return;
    } finally {
      loading(false);
    }
  }
  $("gpk").value = seasonGames[Math.floor(Math.random() * seasonGames.length)];
  await onLoadGame();
}
// A plain visit (no hash: no matchup or game named) opens on the season's most recent game, loaded as
// Load loads it. The default matchup runs meanwhile; if the schedule or the game can't be had, it stays,
// with a note saying so.
async function loadLatest() {
  const note = $("gpk_note");
  loading(true);
  note.textContent = "finding the latest game…";
  let pk = null;
  try {
    pk = latestGame(await seasonSchedule());
  } catch {
    // the note below
  } finally {
    loading(false);
  }
  if (!pk) {
    note.textContent = `Couldn't find the latest ${SEASON} game, so this is the default matchup. Load a game or pick a Random Game.`;
    return;
  }
  $("gpk").value = pk;
  await onLoadGame();
}

// ---------- a team: lineup, starter, plan ----------
// the team's most-used starter (most 2026 starts); an MLB-average RHP for MLB
function defaultStarter(abbr) {
  if (abbr === "MLB") return pitchers.get("PRHP");
  const arms = [...pitchers.values()].filter((e) => !e.generic && e.team === abbr && e.gs > 0).sort((a, b) => b.gs - a.gs);
  return arms[0] ?? pitchers.get("PRHP");
}
function loadPreset(s) {
  const r = s.kind === "recent" ? recentOf(s) : null;
  if (s.kind === "recent" && !r) s.kind = "spots"; // MLB, or no lineup data
  s.lineup = Array.from({ length: 9 }, (_, i) => (r && entries.has(`p${r.ids[i]}`) ? `p${r.ids[i]}` : `s${s.team}-${i + 1}`));
  s.edited = false;
}
// After the starter a side faces changes (that starter, or the other team): a side whose lineup is its
// most recent, untouched, takes the one against the new starter's hand; either way its panel is redrawn
// (the Lineup menu names the hand)
function followHand(s) {
  if (s.kind === "recent" && !s.edited) {
    const was = s.lineup.join();
    loadPreset(s);
    if (stealData && s.lineup.join() !== was) s.c = defaultCatcher(s);
  }
  renderSide(s);
}
// When the starter gives way to the bullpen: "hook" (the hook model), or outs into the game. Nine
// innings goes to the bullpen in extra innings. Starts and the hook need 2026 starts.
function fromOf(s) {
  const e = s.sp, m = s.plan;
  if (m === "hook" && e.gs && hookData) return "hook";
  if (m === "start" && e.gs) return startOutsOf(e);
  if (m === "bullpen") return data.pitching.opener.outs;
  return 27;
}
const penCells = (s) => data.pitching.teams[s.team] ?? data.pitching.relief_cells;
const penName = (s) => (data.pitching.teams[s.team] ? `${teamOf(s.team).short} bullpen` : "MLB bullpen");

// a hitter or spot as facing() takes it (sim.js), Small samples for players
const specOf = (e) => hitterOf(e.counts, e.cells, { mode: $("platoon").value, league, regress: e.kind === "player" ? Number($("regress").value) : 0, bats: e.bats });

// a team's pitching as game-sim.js takes it: each stage with the other team's nine against it
function pitchingOf(s, other) {
  const mode = $("platoon").value, regress = Number($("regress").value);
  const es = other.lineup.map((id) => entries.get(id)), hs = es.map(specOf);
  // each hitter against this stretch of pitching, in this park (pTeam: the pitching's team, for its environment)
  // the batting nine at home (+1), on the road (-1), or at a neutral site (0)
  const sign = homeEdge() ? (other === SIDES[1] ? 1 : -1) : 0;
  // lead: a BULLPEN_LEAD row, the bullpen's shift for one score (park.js), on top of home field
  const vs = (pitching, pTeam, lead) => hs.map((h, i) => {
    const q = homeField(parkAdjust(facing(h, pitching), es[i].team, pTeam), sign);
    return cumulative(lead ? homeField(q, 1, lead) : q);
  });
  const sp = pitcherOf(s.sp.counts, s.sp.cells, s.sp.throws, { mode, league, regress: s.sp.generic ? 0 : regress });
  const cells = penCells(s);
  const pen = bullpenOf(cellsTotal(cells), cells, { mode, league });
  const from = fromOf(s);
  const t = { stages: [{ from: 0, vs: vs(sp, s.sp.generic ? "MLB" : s.sp.team) }, { from, vs: vs(pen, s.team), vsLead: BULLPEN_LEAD.map((m) => vs(pen, s.team, m)), pen: true }],
    hook: from === "hook" ? hookOf(s.sp) : null };
  if (stealOn()) {
    t.stages[0].steal = armSteal(s.sp);
    t.stages[1].steal = penSteal(s);
    t.runners = Float64Array.from(s.lineup.flatMap((id) => runnerSteal(entries.get(id))));
    t.catcher = catcherSteal(s);
  }
  return t;
}

// ---------- the team panels ----------
function sideHTML(s) {
  const k = s.k;
  return `<div class="side" id="${k}_side">
    <h3><span class="where">${s.where}</span> <span id="${k}_title"></span></h3>
    <div class="loader">
      <label><b>Team</b><select id="${k}_team"></select></label>
      <label><b>Lineup</b><select id="${k}_kind">
        <option value="recent">Most recent vs RHP</option>
        <option value="spots">Lineup spots</option>
      </select></label>
      <div class="field">
        <label for="${k}_sp"><b>Starting pitcher</b></label>
        <div class="suggest pick">
          <input id="${k}_sp" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false"
            aria-controls="${k}_sp_sug" placeholder="Search 2026 pitchers, RHP, LHP">
          <ul id="${k}_sp_sug" class="suggest-list" role="listbox" hidden></ul>
        </div>
      </div>
      <label><b>He pitches</b><select id="${k}_plan">
        <option value="hook">Modeled hook</option>
        <option value="start">Average start</option>
        <option value="bullpen">Bullpen day</option>
        <option value="game">Nine innings</option>
      </select></label>
      <label class="catcher"><b>Catcher</b><select id="${k}_c"></select></label>
      <p id="${k}_cnote" class="note cnote catcher"></p>
    </div>
    <p id="${k}_note" class="note"></p>
    <table class="lineup">
      <thead><tr><th scope="col">#</th><th scope="col">Hitter</th><th scope="col">wOBA</th><th scope="col"><span class="opt">Order</span></th></tr></thead>
      <tbody id="${k}_slots"></tbody>
    </table>
  </div>`;
}

function fillTeams(sel) {
  sel.add(new Option("MLB", "MLB"));
  for (const lg of ["American", "National"]) {
    const g = document.createElement("optgroup");
    g.label = `${lg} League`;
    data.teams.filter((t) => t.league === lg).sort((a, b) => a.name.localeCompare(b.name)).forEach((t) => g.append(new Option(t.name, t.abbr)));
    sel.append(g);
  }
}

// The two teams' colors (team-colors.js), as --t-away and --t-home on el: on the page for the Matchup
// card, as the teams are picked; on the Who wins and Box score cards, for the teams their numbers are of.
function paintTeams(el, sides) {
  const css = getComputedStyle(document.documentElement), v = (x) => css.getPropertyValue(x).trim();
  teamColors(sides.map((s) => s.team), v("--surface"), [v("--s-away"), v("--s-home")])
    .forEach((c, t) => el.style.setProperty(t ? "--t-home" : "--t-away", c));
}
function renderSide(s) {
  const k = s.k;
  paintTeams(document.documentElement, SIDES);
  $(`${k}_team`).value = s.team;
  const rec = $(`${k}_kind`).querySelector("[value=recent]"), r = recentOf(s);
  rec.disabled = !r;
  rec.textContent = `Most recent vs ${handFaced(s)}HP`;
  $(`${k}_kind`).title = s.kind === "recent" && r
    ? `${teamName(s.team)}' starting nine on ${new Date(`${r.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })} against ${teamName(r.opp)}' ${pitchers.get(`P${r.sp}`)?.name ?? "starter"}, their latest ${SEASON} game against a ${handFaced(s) === "L" ? "left" : "right"}-hander`
    : "";
  $(`${k}_kind`).value = s.kind;
  $(`${k}_title`).textContent = teamName(s.team);
  $(`${k}_sp`).value = s.sp.name;
  const sel = $(`${k}_plan`), opt = (v) => sel.querySelector(`[value=${v}]`);
  opt("start").disabled = !s.sp.gs;
  opt("hook").disabled = !s.sp.gs || !hookData;
  opt("start").textContent = s.sp.gs ? `Average start (${fmtIP(startOutsOf(s.sp))} IP)` : "Average start";
  opt("bullpen").textContent = `Bullpen day (${fmtIP(data.pitching.opener.outs)} IP)`;
  if (opt(s.plan).disabled) s.plan = opt("start").disabled ? "bullpen" : "start";
  sel.value = s.plan;
  // his 2026 line, then who follows him
  const e = s.sp, n = countOf(e.counts);
  const who = e.generic ? `Every 2026 ${handOf(e)} pooled` : `${e.team} · ${handOf(e)} · ${e.gs} GS`;
  const after = s.plan === "game" ? `the ${penName(s)} in extra innings` : `the ${penName(s)}`;
  $(`${k}_note`).textContent = `${who} · K ${pct(e.counts[C.K] / n)} · BB ${pct(e.counts[C.BB] / n)} · ${fmtRate(wobaOf(e.counts))} wOBA against`
    + `\nThen ${after}`;
  if (stealData) {
    fillCatchers(s);
    // what he does to the running game, against an MLB-average catcher
    const c = catcherSteal(s), avg = stealData.catcher_avg, e = entries.get(s.lineup[s.c]);
    const vs = `against an average catcher, runners go ${times(c[0] - avg[0])} as often, steal odds ${times(c[1] - avg[1])}`;
    $(`${k}_cnote`).textContent = !catchOf(s, s.c) ? "No 2026 catcher in this lineup: this one catches like an MLB-average catcher"
      : e.kind === "spot" ? `${e.team === "MLB" ? "MLB" : teamName(e.team)} catchers who batted ${ordinal(Number(e.id.split("-")[1]))} (${Math.round(100 * catchOf(s, s.c)[2])}% of the catching), pooled: ${vs}`
      : vs[0].toUpperCase() + vs.slice(1);
  }
  document.querySelectorAll(`#${k}_side .catcher`).forEach((x) => { x.hidden = !stealOn(); });
  renderLineup(s);
}

function renderLineup(s) {
  const body = $(`${s.k}_slots`);
  body.replaceChildren();
  s.lineup.forEach((id, i) => {
    const e = entries.get(id);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="spot">${i + 1}</td>
      <td class="who"><div class="suggest">
        <input type="text" size="1" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-controls="${s.k}_sug_${i}" aria-label="${s.where} hitter batting ${ordinal(i + 1)}">
        <ul id="${s.k}_sug_${i}" class="suggest-list" role="listbox" hidden></ul></div>
        <span class="who-sub"></span></td>
      <td class="stat num woba"></td>
      <td class="move"><button type="button" aria-label="Move up">↑</button> <button type="button" aria-label="Move down">↓</button></td>`;
    const input = tr.querySelector("input");
    input.value = e.name;
    tr.querySelector(".who-sub").textContent = e.sub;
    const w = tr.querySelector(".woba");
    w.textContent = fmtRate(wobaOf(e.counts));
    if (e.kind === "player" && e.pa < 100) {
      w.classList.add("small");
      w.title = "Small sample: Sim Settings can add MLB-average PA";
    }
    const [upB, downB] = tr.querySelectorAll(".move button");
    upB.disabled = i === 0;
    downB.disabled = i === 8;
    upB.addEventListener("click", () => swap(s, i, i - 1));
    downB.addEventListener("click", () => swap(s, i, i + 1));
    wireSuggest(input, tr.querySelector("ul"), {
      find: (q) => {
        const { players, spots } = matches(q);
        return [["2026 hitters", players], ["Lineup spots", spots]];
      },
      choose: (x) => {
        s.lineup[i] = x.id;
        s.edited = true;
        renderSide(s); // the catcher box changes with the nine
        run();
      },
      current: () => entries.get(s.lineup[i]).name,
    });
    body.append(tr);
  });
}

function swap(s, i, j) {
  [s.lineup[i], s.lineup[j]] = [s.lineup[j], s.lineup[i]];
  // the catcher moves with his slot
  if (s.c === i) s.c = j;
  else if (s.c === j) s.c = i;
  s.edited = true;
  renderSide(s);
  run();
  $(`${s.k}_slots`).rows[j]?.querySelectorAll(".move button")[j < i ? 0 : 1]?.focus();
}

function matches(q) {
  const f = fold(q.trim());
  if (!f) return { players: [], spots: [] };
  const words = f.split(/\s+/);
  const players = [], spots = [];
  for (const e of entries.values()) {
    if (!words.every((w) => e.search.includes(w))) continue;
    (e.kind === "player" ? players : spots).push(e);
  }
  const starts = (e) => (e.search.split(" ").some((w) => w.startsWith(words[0])) ? 0 : 1);
  players.sort((a, b) => starts(a) - starts(b) || b.pa - a.pa);
  return { players: players.slice(0, 25), spots: spots.slice(0, 18) };
}

// the starter box: this team's starters by 2026 starts and MLB-average arms; typing searches every 2026 pitcher
function findStarters(s) {
  return (q) => {
    const f = fold(q.trim());
    if (!f) {
      const own = s.team === "MLB" ? [] : [...pitchers.values()].filter((e) => !e.generic && e.team === s.team && e.gs > 0)
        .sort((a, b) => b.gs - a.gs).slice(0, 12);
      return [[`${teamName(s.team)} starters`, own], ["MLB average", [pitchers.get("PRHP"), pitchers.get("PLHP")]]];
    }
    const words = f.split(/\s+/);
    const list = [...pitchers.values()].filter((e) => words.every((w) => e.search.includes(w)));
    const starts = (e) => (e.search.split(" ").some((w) => w.startsWith(words[0])) ? 0 : 1);
    list.sort((a, b) => starts(a) - starts(b) || b.gs - a.gs || b.pa - a.pa);
    return [["2026 pitchers", list.slice(0, 25)]];
  };
}
const smallOf = (e) => (e.kind === "player" ? `${e.team} · ${e.pa} PA · ${fmtRate(wobaOf(e.counts))}`
  : e.kind === "spot" ? `${e.pa.toLocaleString()} PA · ${fmtRate(wobaOf(e.counts))}`
  : e.generic ? `Every 2026 ${handOf(e)}`
  : `${e.team} · ${e.gs ? `${e.gs} GS, ${fmtIP(startOutsOf(e))} IP avg` : `${e.pa} BF`} · ${fmtRate(wobaOf(e.counts))}`);

// A search box with a list of suggestions (as app.js's): find(query) gives [heading, entries]
// sections, choose(entry) takes one, current() is what the box shows when it isn't being typed in.
// With browse, focusing the box lists find("") before anything is typed.
function wireSuggest(input, list, { find, choose: take, current, browse = false, small = smallOf }) {
  let items = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const choose = (e) => {
    close();
    take(e);
  };
  const paint = () => {
    list.querySelectorAll("li[role=option]").forEach((li, i) => {
      li.classList.toggle("active", i === active);
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      if (i === active) li.scrollIntoView({ block: "nearest" });
    });
  };
  const open = () => {
    const sections = find(browse && input.value === current() ? "" : input.value);
    items = sections.flatMap(([, arr]) => arr);
    list.replaceChildren();
    for (const [title, arr] of sections) {
      if (!arr.length) continue;
      const h = document.createElement("li");
      h.className = "head";
      h.setAttribute("role", "presentation");
      h.textContent = title;
      list.append(h);
      for (const e of arr) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        const name = document.createElement("span");
        name.textContent = e.name;
        const cap = document.createElement("small");
        cap.textContent = small(e);
        li.append(name, cap);
        li.addEventListener("pointerdown", (ev) => { ev.preventDefault(); choose(e); });
        list.append(li);
      }
    }
    list.hidden = !items.length;
    input.setAttribute("aria-expanded", items.length ? "true" : "false");
    active = items.length ? 0 : -1;
    paint();
  };
  input.addEventListener("focus", () => {
    input.select();
    if (browse) open();
  });
  input.addEventListener("focus", () => {
    if (matchMedia("(pointer: coarse)").matches) setTimeout(() => input.scrollIntoView({ block: "start" }), 300);
  });
  input.addEventListener("input", open);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (list.hidden) open();
      if (!items.length) return;
      ev.preventDefault();
      active = (active + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (ev.key === "Enter") {
      if (!list.hidden && items[active]) { ev.preventDefault(); choose(items[active]); }
    } else if (ev.key === "Escape") {
      close();
      input.value = current();
    }
  });
  input.addEventListener("blur", () => { close(); input.value = current(); });
}

// ---------- simulation ----------
// Games go to a module worker (game-worker.js); a newer request replaces a busy one. Where module
// workers fail to start, games run on this thread.
let job = null, jobs = 0, worker = null, last = null;
let useWorker = typeof Worker !== "undefined";

function startWorker() {
  const w = new Worker(new URL("./game-worker.js?v=5", import.meta.url), { type: "module" });
  w.postMessage({ type: "init", tables: { running: data.running, advance: data.advance }, steal: stealData });
  w.onmessage = ({ data: msg }) => {
    if (job && msg.id === job.id) finish(job, msg.res, msg.ms);
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    w.terminate();
    worker = null;
    useWorker = false;
    if (job) runHere(job);
  };
  return w;
}

let runTimer = 0;
function run() {
  clearTimeout(runTimer);
  runTimer = setTimeout(go, 60);
}
function go() {
  const teams = [pitchingOf(SIDES[0], SIDES[1]), pitchingOf(SIDES[1], SIDES[0])];
  const games = Number($("games").value);
  const busy = job != null;
  job = { id: ++jobs, teams, games, steal: stealOn(), park: parkName(), home: homeEdge(), final: realFinal(), observed: realLines(), week: park.week >= 0 ? parkData.weeks[park.week][2] : null, sides: SIDES.map((s) => ({ ...s, lineup: [...s.lineup], from: fromOf(s) })) };
  $("status").textContent = "simulating…";
  $("status").classList.remove("err");
  $("out").style.opacity = $("box").style.opacity = last ? ".55" : "";
  writeHash();
  const pitches = hookData?.pitchCums ?? null;
  if (!useWorker) return runHere(job);
  if (busy && worker) {
    worker.terminate();
    worker = null;
  }
  try {
    worker ??= startWorker();
  } catch {
    useWorker = false;
    return runHere(job);
  }
  worker.postMessage({ id: job.id, teams, games, seed: SEED, pitches, useSteal: job.steal });
}
function runHere(j) {
  setTimeout(() => {
    if (job !== j) return;
    const t0 = performance.now();
    if (j.steal) stealHere ??= prepareSteal(stealData);
    const res = simulateGames(model, j.teams, j.games, SEED, hookData?.pitchCums ?? null, j.steal ? stealHere : null);
    finish(j, res, performance.now() - t0);
  }, 30);
}
function finish(j, res, ms) {
  job = null;
  last = { res, sides: j.sides, games: j.games, ms, steal: j.steal, park: j.park, week: j.week, home: j.home, final: j.final, observed: j.observed };
  $("out").hidden = $("box").hidden = false;
  $("out").style.opacity = $("box").style.opacity = "";
  $("status").textContent = res.capped ? `${res.capped.toLocaleString()} innings were called off at 60 plate appearances; adding MLB-average PA under Sim Settings fixes that.` : "";
  $("status").classList.toggle("err", res.capped > 0);
  renderResults();
  renderBox();
}

// ---------- results ----------
const per = (x) => x / last.games;
const f2 = (x) => x.toFixed(2);
const f1 = (x) => x.toFixed(1); // the box score's counts: one decimal (its rates keep their own)

function renderResults() {
  const { res, sides, games } = last;
  const name = (t) => teamName(sides[t].team), abbr = (t) => teamAbbr(sides[t]);
  const runs = res.line.map((l) => l.reduce((a, x) => a + x, 0));
  const hits = res.bat.map((b) => { let s = 0; for (let i = 0; i < 9; i++) s += b[i * nB + Bi.H]; return s; });
  // who wins, in the colors of the teams these results are for
  paintTeams($("out"), sides);
  const kpis = $("kpis");
  kpis.replaceChildren();
  const kpi = (label, big, small, color) => {
    const d = document.createElement("div");
    d.className = "kpi";
    d.innerHTML = `<span></span><b class="num"></b><small></small>`;
    d.querySelector("span").textContent = label;
    d.querySelector("b").textContent = big;
    if (color) d.querySelector("b").style.color = color;
    d.querySelector("small").textContent = small;
    kpis.append(d);
  };
  const same = sides[0].team === sides[1].team;
  kpi(`${same ? "Away" : name(0)} win`, pct(res.wins[0] / games), `${f2(per(runs[0]))} runs a game`, "var(--t-away)");
  kpi(`${same ? "Home" : name(1)} win`, pct(res.wins[1] / games), `${f2(per(runs[1]))} runs a game`, "var(--t-home)");
  const bar = $("winbar");
  bar.children[0].style.width = `${(100 * res.wins[0]) / games}%`;
  bar.children[1].style.width = `${(100 * res.wins[1]) / games}%`;
  bar.setAttribute("aria-label", `${name(0)} win ${pct(res.wins[0] / games)}, ${name(1)} ${pct(res.wins[1] / games)}`);
  // the line score, per game
  const head = $("line_head"), body = $("line_body");
  head.innerHTML = `<th scope="col">Team</th>${Array.from({ length: 9 }, (_, i) => `<th scope="col">${i + 1}</th>`).join("")}`
    + `<th scope="col" title="Every extra inning together">10+</th><th scope="col" class="sum">R</th><th scope="col" class="sum">H</th><th scope="col" class="sum" title="Runners left on base">LOB</th>`;
  body.replaceChildren();
  for (let t = 0; t < 2; t++) {
    const tr = document.createElement("tr");
    const cells = res.line[t].map((x, i) => {
      // the bottom of the 9th is played only when the home team isn't ahead
      const title = t === 1 && i === 8 ? ` title="Played in ${pct(res.bottom9 / games)} of games; 0 when not played"` : "";
      return `<td class="num"${title}>${f2(per(x))}</td>`;
    }).join("");
    tr.innerHTML = `<th scope="row"><i class="dot" style="background:var(--t-${t ? "home" : "away"})"></i>${abbr(t)}</th>${cells}`
      + `<td class="num sum">${f2(per(runs[t]))}</td><td class="num sum">${f2(per(hits[t]))}</td><td class="num sum">${f2(per(res.lob[t]))}</td>`;
    body.append(tr);
  }
  // the most common final scores
  const N = 31, top = [];
  res.scoreDist.forEach((n, i) => { if (n) top.push([n, Math.floor(i / N), i % N]); });
  top.sort((a, b) => b[0] - a[0]);
  $("scores").replaceChildren(...top.slice(0, 6).map(([n, a, h]) => {
    const li = document.createElement("li");
    const w = a > h ? 0 : 1;
    li.innerHTML = `<b></b> <span></span>`;
    li.querySelector("b").textContent = w ? `${abbr(1)} ${h}, ${abbr(0)} ${a}` : `${abbr(0)} ${a}, ${abbr(1)} ${h}`;
    li.querySelector("span").textContent = pct(n / games);
    return li;
  }));
  renderScoreGrid();
  $("games_note").textContent = `${games.toLocaleString()} games${last.ms ? ` in ${(last.ms / 1000).toFixed(1)} s` : ""}`
    + `${last.park ? ` at ${last.park}${last.week ? `, ${last.week}` : ""}` : ", no park adjustment"}. The away team bats first; ${last.home ? "the home team bats last, with the home-field edge" : "a neutral site, so no home-field edge beyond batting last"}.`;
}

// ---------- every final score, as a grid ----------
// One square per final score (res.scoreDist: how many games ended at each away x home score), home
// runs across and away runs up. Brighter is likelier: the ramp runs from the card's own color at
// SG_FADE of games through brand-cyan to white at the likeliest score, so the faintest squares melt into the
// card; a score under SG_FLOOR has no square (the card shows through). Every square carries its share. Both axes run to the most runs either team scored in a score that has a square (the grid
// square, so the tie line is its diagonal); the squares past it would all be empty. The diagonal squares are ties,
// which no game ends on (a tie called at 40 innings aside): the dotted line runs through them, the away
// team's wins above it and the home team's below.
const SG_FLOOR = 0.005, SG_FADE = 0.0045;
// sparse to dense, after the card's color: brand-cyan halfway, white (base-white) at the likeliest score
const SG_RAMP = [[85, 232, 255], [255, 255, 255]];
// the squares' corners and the final score's amber outline and keyline, in proportion to the square: these
// px at a square of `at` px (the page's at full width, with 0 to 9 runs a side), wherever the grid is drawn
const SG_SHAPE = { at: 406 / 10, radius: 2, final: 3.5, key: 1 };
let sgView = null; // what's drawn, for the hover readout
function renderScoreGrid() {
  const { res, sides, games } = last, N = 31;
  $("sg_tip").hidden = true; // a redraw moves the squares under it
  if ($("out").hidden) return; // drawn when there are results to show
  const same = sides[0].team === sides[1].team, ab = (t) => teamAbbr(sides[t]), nm = (t) => (same ? sides[t].where : teamName(sides[t].team));
  const runs = (r) => String(r);
  // the axes: to the most runs by either team in a score of SG_FLOOR or more of games
  let M = 1;
  res.scoreDist.forEach((n, i) => { if (n >= SG_FLOOR * games) M = Math.max(M, Math.floor(i / N), i % N); });
  // a real game's final score is always in view (the sim's scores stop at 30)
  const fin = last.final ? last.final.map((r) => Math.min(r, N - 1)) : null;
  if (fin) M = Math.max(M, ...fin);
  const n1 = M + 1;
  // D[a * n1 + h]: games at each score in view
  const D = new Float64Array(n1 * n1);
  for (let a = 0; a < n1; a++) for (let h = 0; h < n1; h++) D[a * n1 + h] = res.scoreDist[a * N + h];
  const outCss = getComputedStyle($("out"));
  sgView = { D, n1, M, games, ab, nm, runs, fin, max: Math.max(...D), away: outCss.getPropertyValue("--t-away").trim(), home: outCss.getPropertyValue("--t-home").trim() };
  drawScoreGrid(null);
  // the likeliest scores, for screen readers
  const top = [];
  D.forEach((n, i) => { if (n) top.push([n, Math.floor(i / n1), i % n1]); });
  top.sort((a, b) => b[0] - a[0]);
  const say = ([n, a, h]) => `${ab(0)} ${runs(a)}, ${ab(1)} ${runs(h)} (${pct(n / games)})`;
  $("sg").setAttribute("aria-label", `Every simulated final score, ${nm(1)} runs across and ${nm(0)} runs up, each to ${M}; the likeliest: ${top.slice(0, 3).map(say).join("; ")}`);
  $("sg_note").textContent = `Each square is one final score, ${nm(1)} runs across and ${nm(0)} runs up; brighter is likelier, and the number is its share of games (%); scores under ${SG_FLOOR * 100}% have no square. `
    + `Above the dotted line the ${nm(0)} won, below it the ${nm(1)}; no game ends tied. `
    + (fin ? `The square outlined in amber is how the game actually ended (${ab(0)} ${last.final[0]}, ${ab(1)} ${last.final[1]}). ` : "")
    + "Hover or tap a square for its share.";
}
// The grid, on the page's canvas, with the square at `hot` ([away, home]) ringed
function drawScoreGrid(hot) {
  const k = sgView, cv = $("sg"), css = getComputedStyle(document.documentElement), v = (x) => css.getPropertyValue(x).trim(), dpr = window.devicePixelRatio || 1;
  const S = Math.min(460, $("sg_wrap").clientWidth || 460), m = { l: 44, r: 10, t: 10, b: 44 }, P = S - m.l - m.r, H = P + m.t + m.b;
  cv.width = Math.round(S * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.height = `${H}px`;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, H);
  const c = P / k.n1;
  paintScoreGrid(ctx, { l: m.l, t: m.t, P }, {
    bg: v("--surface"), ink: v("--ink"), ground: v("--ground"), tick: v("--muted"),
    label: c >= 15 ? `600 ${c >= 30 ? 11 : c >= 22 ? 10 : 8.5}px "DM Sans", system-ui, sans-serif` : null, gap: 1,
    tickFont: `11.5px "DM Sans", system-ui, sans-serif`, tickGap: 6,
    titleFont: `12.5px "DM Sans", system-ui, sans-serif`, dot: 4, xTitleY: H - 12, yTitleX: 13,
    tie: { width: 1.75, dash: [2, 4] }, ring: 1.5, amber: v("--brand-brand-amber") || TILE.amber,
  }, hot);
  Object.assign(k, { m, c, P });
}

// a share of games as a percent: one decimal, or as many as its first digit that isn't 0 needs (0.03,
// 0.004); none at all is 0
const shareText = (n, games) => {
  const x = (100 * n) / games;
  return !n ? "0" : x >= 0.1 ? x.toFixed(1) : x.toFixed(Math.min(4, -Math.floor(Math.log10(x))));
};
// The grid in a box ({ l, t, P }: left, top, side) with a look (colors, fonts, spacing): the page's
// canvas and the share image both draw it here. The ramp starts at the look's background at SG_FADE.
function paintScoreGrid(ctx, box, L, hot) {
  const k = sgView, { D, n1, M, games } = k, { l, t, P } = box, c = P / n1, z = c / SG_SHAPE.at;
  const hex = (h) => [1, 3, 5].map((j) => parseInt(h.slice(j, j + 2), 16));
  const lum = (rgb) => { const [r, g, b] = rgb.map((x) => ((x /= 255) <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  const cx = (h) => l + (h + 0.5) * c, cy = (a) => t + (M - a + 0.5) * c; // a square's center
  const R = SG_SHAPE.radius * z;
  const square = (h, a, inset, r = R, begin = true) => {
    const x = l + h * c + inset, y = t + (M - a) * c + inset, w = c - 2 * inset;
    if (begin) ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, w, Math.max(0, r)); else ctx.rect(x, y, w, w);
  };
  // a band `width` wide just inside the edge at `inset` (corner radius r), its inner corners concentric
  // (r - width), so it lies flush on the square with no gaps at the corners, as a stroke's wouldn't
  const band = (h, a, inset, width, r, color) => {
    square(h, a, inset, r);
    square(h, a, inset + width, r - width, false);
    ctx.fillStyle = color; ctx.fill("evenodd");
  };
  const ramp = [hex(L.bg), ...SG_RAMP], lo = SG_FADE * games;
  // a score's square color (null under the floor: no square), and whichever of ink and ground reads on it
  const fillOf = (n) => {
    if (!n || n < SG_FLOOR * games) return null;
    const f = k.max > lo ? Math.min(1, (n - lo) / (k.max - lo)) : 1, u = f * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(u)), w = u - i;
    return ramp[i].map((x, j) => Math.round(x + (ramp[i + 1][j] - x) * w));
  };
  const inkOn = (rgb) => (rgb && contrast(lum(hex(L.ground)), lum(rgb)) > contrast(lum(hex(L.ink)), lum(rgb)) ? L.ground : L.ink);
  if (L.label) ctx.font = L.label;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let a = 0; a < n1; a++) for (let h = 0; h < n1; h++) {
    const n = D[a * n1 + h], rgb = fillOf(n);
    if (!rgb) continue; // under the floor: no square
    square(h, a, L.gap); // the background between squares
    ctx.fillStyle = `rgb(${rgb.join(",")})`;
    ctx.fill();
    if (L.label) {
      ctx.fillStyle = inkOn(rgb);
      ctx.fillText((100 * n / games).toFixed(1), cx(h), cy(a) + 0.5);
    }
  }
  // a real game's final score: its share even without a square (to the first digit that isn't 0), outlined
  // in amber with a keyline of the card's color just inside, so the outline reads on the cyan and white
  // squares too (amber is about as light as both)
  if (k.fin) {
    const [fa, fh] = k.fin, n = D[fa * n1 + fh], F = SG_SHAPE.final * z, K = SG_SHAPE.key * z;
    if (L.label && !fillOf(n)) {
      ctx.font = L.label;
      ctx.fillStyle = L.ink;
      ctx.fillText(shareText(n, games), cx(fh), cy(fa) + 0.5);
    }
    band(fh, fa, L.gap, F, R, L.amber);
    band(fh, fa, L.gap + F, K, R - F, L.bg);
  }
  // the tie line, dotted, through the diagonal squares
  ctx.save();
  ctx.setLineDash(L.tie.dash); ctx.lineCap = "round"; ctx.lineWidth = L.tie.width; ctx.strokeStyle = L.ink; ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.moveTo(l, t + P); ctx.lineTo(l + P, t); ctx.stroke();
  ctx.restore();
  if (hot) {
    square(hot[1], hot[0], L.gap / 2);
    ctx.lineWidth = L.ring; ctx.strokeStyle = inkOn(fillOf(D[hot[0] * n1 + hot[1]])); ctx.stroke();
  }
  // ticks: every run (every other one past 10)
  ctx.font = L.tickFont;
  ctx.fillStyle = L.tick;
  for (let r = 0; r <= M; r += M > 10 ? 2 : 1) {
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(k.runs(r), cx(r), t + P + L.tickGap);
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(k.runs(r), l - L.tickGap, cy(r));
  }
  // axis titles, each with its team's color mark
  const title = (text, color, x, y, rot) => {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.font = L.titleFont; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width;
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(-w / 2 - L.dot * 2.25, 0, L.dot, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = L.ink; ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  title(`${k.nm(1)} Runs (Home)`, k.home, l + P / 2, L.xTitleY, 0);
  title(`${k.nm(0)} Runs (Away)`, k.away, L.yTitleX, t + P / 2, -Math.PI / 2);
}

// ---------- the score grid as an image ----------
// The grid above as a 900 x 900 image in the site's share-image style (the Lineup Sim's: the PLPD
// card-bg, a brand-cyan title, blue-200 subtitles, text-nav ticks, the wordmark top right), to copy or download with the Share image
// button (shared/share-image.js): the matchup and starters, each side's win share, the grid, what a
// square is, and how many games.
const TILE = { W: 900, bg: "#292c42", cyan: "#55e8ff", sub: "#98b3de", axis: "#cbd7fd", amber: "#ffc277" };
let logoImg = null;
const loadLogo = () => logoImg || (logoImg = new Promise((res, rej) => {
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = rej;
  im.src = new URL("logo.png", import.meta.url).href;
}));
const scoreGridFile = () => {
  const s = last?.sides;
  return s ? `game_sim_simulated_scores_${teamAbbr(s[0]).toLowerCase()}_at_${teamAbbr(s[1]).toLowerCase()}.png` : "game_sim_simulated_scores.png";
};
// shrink a line's font until it fits
function fitFont(g, text, weight, size, family, width) {
  for (; size > 11; size--) {
    g.font = `${weight} ${size}px ${family}`;
    if (g.measureText(text).width <= width) break;
  }
}
async function scoreGridBlob() {
  const k = sgView, { res, sides, games } = last;
  await Promise.all(['700 36px "DM Sans"', '400 21px "DM Sans"', '700 21px "DM Sans"', '400 18px "DM Sans"', '400 16px "DM Sans"', '600 17px "DM Sans"',
    '400 17px "Work Sans"'].map((f) => document.fonts.load(f)));
  const logo = await loadLogo();
  const { W } = TILE;
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  const g = cv.getContext("2d");
  g.fillStyle = TILE.bg;
  g.fillRect(0, 0, W, W);
  // title, wordmark, the matchup and the win shares
  g.font = '700 36px "DM Sans"';
  g.fillStyle = TILE.cyan;
  g.fillText("Simulated Scores", 48, 64);
  g.drawImage(logo, W - 32 - 236, 27, 236, (236 * logo.naturalHeight) / logo.naturalWidth);
  // the starters by surname; the first line stops short of the wordmark beside it
  const who = (t) => `${k.nm(t)} (${surname(sides[t].sp.name)})`;
  const lines = [`${who(0)} at ${who(1)}`, `${k.ab(0)} ${pct(res.wins[0] / games)} - ${pct(res.wins[1] / games)} ${k.ab(1)}`];
  g.fillStyle = TILE.sub;
  lines.forEach((line, i) => {
    fitFont(g, line, 400, 21, '"DM Sans"', i ? W - 96 : W - 32 - 236 - 24 - 48);
    g.fillText(line, 48, 100 + 28 * i);
  });
  // a real game's final score, laid out as the win shares are, the winner's side in bold amber (the
  // outline's color); a game called tied has none
  if (last.final) {
    const [fa, fh] = last.final, won = fa > fh ? 0 : fh > fa ? 1 : -1;
    let x = 48;
    for (const [text, bold] of [[`${k.ab(0)} ${fa}`, won === 0], [" - ", false], [`${fh} ${k.ab(1)}`, won === 1]]) {
      g.font = `${bold ? 700 : 400} 21px "DM Sans"`;
      g.fillStyle = bold ? TILE.amber : TILE.sub;
      g.fillText(text, x, 156);
      x += g.measureText(text).width;
    }
  }
  // the grid, square, centered under the subtitle
  const P = 540, l = 200, t = 182, c = P / k.n1;
  paintScoreGrid(g, { l, t, P }, {
    bg: TILE.bg, ink: "#ffffff", ground: "#13152a", tick: TILE.axis,
    label: `600 ${Math.max(13, Math.min(20, Math.round(c * 0.3)))}px "DM Sans"`, gap: 2,
    tickFont: '400 17px "Work Sans"', tickGap: 12,
    titleFont: '400 18px "DM Sans"', dot: 6, xTitleY: t + P + 62, yTitleX: l - 62,
    tie: { width: 2.5, dash: [3, 7] }, ring: 0, amber: TILE.amber,
  }, null);
  // the footer: what a square is, and how many games
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.fillStyle = TILE.sub;
  const what = `Each square is a final score and its share of games (%).${last.final ? " The square outlined in amber is how the game ended." : ""}`;
  const where = `${games.toLocaleString()} simulated games`;
  fitFont(g, what, 400, 16, '"DM Sans"', W - 96);
  g.fillText(what, 48, 836);
  fitFont(g, where, 400, 16, '"DM Sans"', W - 96);
  g.fillText(where, 48, 862);
  return new Promise((r) => cv.toBlob(r, "image/png"));
}

function sgHover(ev) {
  const t = $("sg_tip"), k = sgView;
  if (!k || !k.c) return;
  const r = $("sg").getBoundingClientRect();
  const h = Math.floor((ev.clientX - r.left - k.m.l) / k.c), a = k.M - Math.floor((ev.clientY - r.top - k.m.t) / k.c);
  // the tie line's squares get no readout and no ring, unless the real game ended there (called, tied)
  const final = k.fin && k.fin[0] === a && k.fin[1] === h, tie = a === h;
  if (h < 0 || a < 0 || h > k.M || a > k.M || (tie && !final)) {
    if (!t.hidden) drawScoreGrid(null);
    t.hidden = true;
    return;
  }
  const n = k.D[a * k.n1 + h];
  t.innerHTML = "<b></b><small></small>";
  t.querySelector("b").textContent = `${k.ab(0)} ${k.runs(a)}, ${k.ab(1)} ${k.runs(h)}`;
  t.querySelector("small").textContent = (!n ? "no games ended here" : n / k.games < 0.0005 ? `${n} of ${k.games.toLocaleString()} games` : `${pct(n / k.games)} of games`)
    + (final ? (tie ? " · the final score (called tied)" : " · the final score") : "");
  t.style.left = `${k.m.l + (h + 0.5) * k.c}px`;
  t.style.top = `${k.m.t + (k.M - a) * k.c}px`;
  t.hidden = false;
  drawScoreGrid([a, h]);
}

// ---------- a box-score count's spread, on hover ----------
// Each count in the box score (not the rates, nor W, L, SV and QS, already shares of games) has its games
// by value (game-sim.js res.hist): a bar for each value's share of games, labeled, the values whose share
// is under HIST_MIN left out (and those beyond them at either end).
const HIST_MIN = 0.02;
const STAT_NAME = { PA: "Plate appearances", AB: "At bats", R: "Runs", H: "Hits", "2B": "Doubles", "3B": "Triples", HR: "Home runs",
  TB: "Total bases", RBI: "RBI", BB: "Walks", HBP: "Hit by pitch", K: "Strikeouts", SB: "Stolen bases", CS: "Caught stealing",
  OUTS: "Innings pitched", BF: "Batters faced", ER: "Earned runs", NP: "Pitches" };
const histCells = new WeakMap(); // a box-score cell -> { who, stat, mean, counts, width }
const regHist = (td, cell) => { histCells.set(td, cell); td.classList.add("hist"); };
// the bars to draw: [{ label, p }] from the first value with HIST_MIN of the games to the last (null: under it)
// A loaded real game's value (`seen`) gets its bar whatever its share, marked `seen`.
function histBars({ stat, counts, width, seen }) {
  const n = counts.reduce((a, x) => a + x, 0), keep = (i) => counts[i] / n >= HIST_MIN;
  const top = counts.length - 1, at = Number.isInteger(seen) ? Math.min(top, Math.floor(seen / width)) : -1;
  let lo = 0, hi = top;
  while (lo < hi && !keep(lo)) lo++;
  while (hi > lo && !keep(hi)) hi--;
  if (at >= 0) { lo = Math.min(lo, at); hi = Math.max(hi, at); }
  const bars = [];
  for (let i = lo; i <= hi; i++) {
    const label = width > 1 ? (i === top ? `${i * width}+` : `${i * width}–${i * width + width - 1}`)
      : stat === "OUTS" ? fmtIP(i) + (i === top ? "+" : "") : `${i}${i === top ? "+" : ""}`;
    bars.push({ label, p: keep(i) || i === at ? counts[i] / n : null, seen: i === at });
  }
  return bars;
}
// the chart, as an SVG in the page's colors: % of games up, the values across, each bar labeled
function histSVG(cell, maxW) {
  const bars = histBars(cell), n = bars.length, top = Math.max(...bars.map((b) => b.p ?? 0));
  // a slot per value, narrower on a phone: under 24px, every other value is labeled and shares are whole percents
  // (a few values get wider slots, so the chart and its axis title keep a usable width)
  const slot = Math.max(15, Math.min(Math.max(40, 180 / n), (maxW - 52) / n)), W = Math.round(40 + n * slot + 12), H = 172, tight = slot < 24;
  const L = 40, T = 14, B = H - 38, x0 = (i) => L + i * slot, y = (p) => B - (p / ymax) * (B - T);
  const step = [0.02, 0.05, 0.1, 0.2, 0.25].find((st) => top / st <= 4) ?? 0.5, ymax = Math.ceil(top / step) * step;
  // shares: one decimal under 10% where there's room (a share under 1%, the real game's, always gets one; none at all is 0%)
  const wide = slot >= 30, lab = (p) => (!p ? "0%" : 100 * p >= 9.95 || (!wide && p >= 0.01) ? `${Math.round(100 * p)}%` : `${(100 * p).toFixed(1)}%`);
  const xs = cell.width > 1 || tight ? 9.5 : 11, bs = tight ? 8.5 : 10;
  let g = "";
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    g += `<line x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" stroke="var(--rule)"/>`
      + `<text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10.5" fill="var(--muted)">${Math.round(100 * v)}%</text>`;
  }
  bars.forEach((b, i) => {
    const cx = x0(i) + slot / 2, bw = slot * 0.62;
    if (b.p != null) {
      // a bar at least 3px tall, so even the real game's rare value shows
      const yt = Math.min(y(b.p), B - 3);
      g += `<path d="M${cx - bw / 2},${B} V${yt + 3} q0,-3 3,-3 H${cx + bw / 2 - 3} q3,0 3,3 V${B} Z" fill="var(--brand-brand-cyan)"/>`;
      // the real game's value: outlined in amber just outside the bar, on the card, where amber reads
      if (b.seen) g += `<rect x="${cx - bw / 2 - 2.5}" y="${yt - 2.5}" width="${bw + 5}" height="${B - yt + 2.5}" rx="4" fill="none" stroke="var(--brand-brand-amber)" stroke-width="2"/>`;
      g += `<text x="${cx}" y="${yt - (b.seen ? 7 : 4)}" text-anchor="middle" font-size="${bs}" fill="var(--ink)">${lab(b.p)}</text>`;
    }
    if (!tight || i % 2 === 0) g += `<text x="${cx}" y="${B + 14}" text-anchor="middle" font-size="${xs}" fill="var(--muted)">${b.label}</text>`;
  });
  const unit = cell.stat === "OUTS" ? "Innings" : cell.width > 1 ? "Pitches (by tens)" : STAT_NAME[cell.stat] ?? cell.stat;
  g += `<text x="${L + (n * slot) / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${unit} in a game</text>`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${unit} in a game, share of games">${g}</svg>`;
}
function showHist(td) {
  const cell = histCells.get(td), tip = $("bx_tip");
  if (!cell || !last?.res?.hist) return hideHist();
  const box = $("box").getBoundingClientRect(), r = td.getBoundingClientRect();
  const maxW = Math.min(520, box.width - 24);
  const avg = cell.stat === "OUTS" ? `${fmtIP(Math.round(cell.mean))} IP a game` : `${f1(cell.mean)} a game`;
  tip.innerHTML = `<b></b><small></small>${histSVG(cell, maxW - 26)}<small>Share of games; under ${100 * HIST_MIN}% left out</small>`
    + (Number.isInteger(cell.seen) ? `<small class="seen">Outlined in amber: this game's ${cell.stat === "OUTS" ? `${fmtIP(cell.seen)} IP` : cell.seen}</small>` : "");
  tip.querySelector("b").textContent = `${cell.who} · ${STAT_NAME[cell.stat] ?? cell.stat}`;
  tip.querySelector("small").textContent = avg;
  tip.hidden = false;
  // above the cell, or below it if there's no room; kept inside the card
  const w = tip.offsetWidth, h = tip.offsetHeight, cx = r.left + r.width / 2 - box.left;
  tip.style.left = `${Math.max(12 + w / 2, Math.min(box.width - 12 - w / 2, cx))}px`;
  const below = r.top - h - 10 < 0;
  tip.classList.toggle("below", below);
  tip.style.top = `${(below ? r.bottom : r.top) - box.top}px`;
  histOn = td;
}
let histOn = null;
function hideHist() {
  $("bx_tip").hidden = true;
  histOn = null;
}

// the box score: every hitter's and pitcher's line, per game
function renderBox() {
  const { res, sides } = last;
  hideHist();
  const box = $("box_teams");
  box.replaceChildren();
  paintTeams($("box"), sides);
  sides.forEach((s, t) => {
    const sec = document.createElement("div");
    sec.className = "section box-team";
    const h = document.createElement("h3");
    h.innerHTML = `<i class="dot" style="background:var(--t-${t ? "home" : "away"})"></i>`;
    h.append(`${teamName(s.team)} `, Object.assign(document.createElement("span"), { className: "where", textContent: s.where }));
    sec.append(h, battingTable(res.bat[t], s, t), pitchingTable(res.pit[t], s, res.wins[t], res.wins[1 - t], t));
    if (last.steal) {
      // the catcher's running game: steals and runners caught against him, per game
      const [sb, cs] = res.caught[t], p = document.createElement("p");
      p.className = "note catch-line";
      p.textContent = `Catcher: ${catcherName(s)} · ${f1(per(sb))} SB and ${f1(per(cs))} CS against a game`
        + (sb + cs ? ` (${pct(cs / (sb + cs))} caught)` : "");
      sec.append(p);
    }
    box.append(sec);
  });
}

const RATE = (b) => {
  const g = (k) => b[Bi[k]];
  const one = g("H") - g("2B") - g("3B") - g("HR");
  return { AVG: g("H") / g("AB"), OBP: (g("H") + g("BB") + g("HBP")) / (g("AB") + g("BB") + g("HBP") + g("SF")),
    SLG: (one + 2 * g("2B") + 3 * g("3B") + 4 * g("HR")) / g("AB") };
};
const BAT_COLS = () => ["PA", "AB", "R", "H", "2B", "3B", "HR", "TB", "RBI", "BB", "HBP", "K", ...(last.steal ? ["SB", "CS"] : [])];

function battingTable(arr, s, t) {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const table = document.createElement("table");
  table.className = "box";
  table.innerHTML = `<caption class="sr-only">${teamName(s.team)} batting, per game</caption>
    <thead><tr><th scope="col">Batter</th>${BAT_COLS().map((k) => `<th scope="col">${k}</th>`).join("")}
    <th scope="col" class="rate">AVG</th><th scope="col">OBP</th><th scope="col">SLG</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector("tbody");
  const total = new Float64Array(nB);
  // spread(k): that count's games by value (res.hist), for its chart on hover, titled `who`; seen: a loaded
  // game's real line for the row ({ stat: count }), marked on the chart
  const seenB = last.observed?.[t];
  const row = (spot, name, sub, b, cls = "", spread = null, who = name, seen = null) => {
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    const r = RATE(b);
    tr.innerHTML = `<td class="who"><span class="nm"><b class="sp">${spot}</b></span><span class="who-sub"></span></td>`
      + BAT_COLS().map((k) => `<td class="num">${f1(per(b[Bi[k]]))}</td>`).join("")
      + `<td class="num rate">${fmtRate(r.AVG)}</td><td class="num">${fmtRate(r.OBP)}</td><td class="num">${fmtRate(r.SLG)}</td>`;
    if (spread) BAT_COLS().forEach((k, j) => regHist(tr.cells[1 + j], { who, stat: k, mean: per(b[Bi[k]]), counts: spread(k), width: 1, seen: seen?.[k] }));
    tr.querySelector(".nm").append(name);
    tr.querySelector(".who-sub").textContent = sub;
    tr.querySelector(".who-sub").hidden = !sub;
    body.append(tr);
  };
  s.lineup.forEach((id, i) => {
    const e = entries.get(id), b = arr.slice(i * nB, (i + 1) * nB);
    b.forEach((x, k) => { total[k] += x; });
    // a spot goes by its main hitters, with the spot and its hitters' shares under them
    const other = e.team !== s.team && e.team !== "MLB" ? `${teamName(e.team)} ` : "";
    const name = e.kind === "spot" ? `${other ? `${teamName(e.team)}: ` : ""}${e.lead}` : e.name;
    row(i + 1, name, e.kind === "spot" && e.team !== "MLB" ? `${other}${e.spot}: ${e.sub}` : "", b, "",
      (k) => last.res.hist.bat[t].subarray((i * nB + Bi[k]) * HIST_BINS, (i * nB + Bi[k] + 1) * HIST_BINS), name, seenB?.bat[i]);
  });
  row("", "Totals", "", total, "total", (k) => last.res.hist.batTot[t].subarray(Bi[k] * HIST_BINS, (Bi[k] + 1) * HIST_BINS), teamName(s.team), seenB?.batTot);
  wrap.append(table);
  return wrap;
}

function pitchingTable(arr, s, won, lost, t) {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const table = document.createElement("table");
  table.className = "box pitching";
  const np = !!hookData;
  table.innerHTML = `<caption class="sr-only">${teamName(s.team)} pitching, per game</caption>
    <thead><tr><th scope="col">Pitcher</th><th scope="col" title="Innings per game, to the nearest out (5.1 is 5⅓)">IP</th>
    ${["H", "R", "ER", "BB", "K", "HR", "BF"].map((k) => `<th scope="col">${k}</th>`).join("")}${np ? `<th scope="col" title="Pitches">NP</th>` : ""}
    <th scope="col" class="rate">ERA</th><th scope="col">WHIP</th><th scope="col" title="Share of games with the win">W</th>
    <th scope="col" title="Share of games with the loss">L</th><th scope="col" title="Share of games with the save">SV</th>
    <th scope="col" title="Quality starts: share of games the starter went 6+ innings with 3 or fewer earned runs">QS</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector("tbody");
  const G = last.games;
  // qs: the starter's quality-start share, shown on his row and the totals (a bullpen has none)
  // spread(k): that count's games by value (res.hist), for its chart on hover; the rates and W, L, SV and
  // QS (already shares of games) have none
  const row = (name, sub, p, cls = "", decisions = null, qs = true, spread = null, who = name, seen = null) => {
    const g = (k) => p[Pi[k]];
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    const ip = g("OUTS") / 3;
    const [w, l, sv] = decisions ?? [g("W"), g("L"), g("SV")];
    tr.innerHTML = `<td class="who"><span class="nm"></span><span class="who-sub"></span></td><td class="num">${fmtIP(Math.round(per(g("OUTS"))))}</td>`
      + ["H", "R", "ER", "BB", "K", "HR", "BF"].map((k) => `<td class="num">${f1(per(g(k)))}</td>`).join("")
      + (np ? `<td class="num">${per(g("NP")).toFixed(1)}</td>` : "")
      + `<td class="num rate">${ip ? ((9 * g("ER")) / ip).toFixed(2) : "—"}</td><td class="num">${ip ? ((g("BB") + g("H")) / ip).toFixed(2) : "—"}</td>`
      + `<td class="num">${pct(w / G)}</td><td class="num">${pct(l / G)}</td><td class="num">${pct(sv / G)}</td>`
      + `<td class="num">${qs ? pct(g("QS") / G) : "—"}</td>`;
    if (spread) ["OUTS", "H", "R", "ER", "BB", "K", "HR", "BF", ...(np ? ["NP"] : [])].forEach((k, j) =>
      regHist(tr.cells[1 + j], { who, stat: k, mean: per(g(k)), counts: spread(k), width: k === "NP" ? HIST_NP_WIDTH : 1, seen: seen?.[k] }));
    tr.querySelector(".nm").textContent = name;
    tr.querySelector(".who-sub").textContent = sub;
    tr.querySelector(".who-sub").hidden = !sub;
    body.append(tr);
  };
  const H = last.res.hist, cut = (a, i) => a.subarray(i * HIST_BINS, (i + 1) * HIST_BINS);
  const sp = arr.slice(0, nP), pen = arr.slice(nP, 2 * nP);
  const how = { hook: "until the modeled hook", game: "nine innings", bullpen: "opener" }[s.plan] ?? `average start, ${fmtIP(s.from)} IP`;
  const seen = last.observed?.[t];
  row(s.sp.name, `Starter · ${how}`, sp, "", null, true, (k) => cut(H.pit[t], Pi[k]), s.sp.name, seen?.sp);
  row(penName(s), `In ${pct(pen[Pi.G] / G)} of games`, pen, "", null, false, (k) => cut(H.pit[t], nP + Pi[k]), penName(s), seen?.pen);
  const total = sp.map((x, i) => x + pen[i]);
  row("Totals", "", total, "total", [won, lost, total[Pi.SV]], true, (k) => cut(H.pitTot[t], Pi[k]), `${teamName(s.team)} pitchers`, seen?.pitTot);
  wrap.append(table);
  return wrap;
}

// ---------- the link ----------
function writeHash() {
  const p = new URLSearchParams();
  for (const s of SIDES) {
    p.set(s.k, [s.team, s.kind, s.sp.mlbam, s.plan, s.c].join("."));
    if (s.edited) p.set(`${s.k}l`, s.lineup.join(","));
  }
  p.set("g", $("games").value);
  p.set("r", $("regress").value);
  if ($("platoon").value !== "own") p.set("pl", $("platoon").value);
  if ($("steals").value !== "model") p.set("st", $("steals").value);
  if (parkData && !park.auto) p.set("pk", typeof park.at === "number" ? slugOf(parkData.parks[park.at].name) : park.at);
  if (parkData && park.week >= 0) p.set("wk", String(park.week + 1));
  history.replaceState(null, "", `#${p}`);
}
let linkedGame = null; // a gamePk the link asked for (gp=, or the hash alone), loaded once the page is set up
let plainVisit = false; // no hash at all: the page opens on the latest game
function readHash() {
  plainVisit = location.hash.length <= 1;
  const p = new URLSearchParams(location.hash.slice(1));
  const gp = p.get("gp") ?? location.hash.slice(1);
  linkedGame = /^\d{6,7}$/.test(gp) ? Number(gp) : null;
  for (const [key, sel] of [["g", "games"], ["r", "regress"], ["pl", "platoon"], ["st", "steals"]]) {
    const v = p.get(key);
    if (v && [...$(sel).options].some((o) => o.value === v)) $(sel).value = v;
  }
  for (const s of SIDES) {
    const [team, kind, sp, plan, c] = (p.get(s.k) ?? "").split(".");
    if (team && (team === "MLB" || teamOf(team))) s.team = team;
    s.kind = lineupKind(kind) ?? s.kind;
    loadPreset(s);
    s.sp = pitchers.get(`P${sp}`) ?? defaultStarter(s.team);
    if (["hook", "start", "bullpen", "game"].includes(plan)) s.plan = plan;
    const ids = (p.get(`${s.k}l`) ?? "").split(",");
    if (ids.length === 9 && ids.every((id) => entries.has(id))) {
      s.lineup = ids;
      s.edited = true;
    }
    s.c = /^[0-8]$/.test(c ?? "") ? Number(c) : -1;
    if (stealData) checkCatcher(s);
  }
  // a default lineup faces the other team's starter, now that both are read
  for (const s of SIDES) {
    if (s.kind !== "recent" || s.edited) continue;
    loadPreset(s);
    if (stealData) checkCatcher(s);
  }
  if (parkData) {
    const pk = p.get("pk"), i = parkData.parks.findIndex((x) => slugOf(x.name) === pk);
    if (pk === "avg" || pk === "none" || i >= 0) Object.assign(park, { at: i >= 0 ? i : pk, auto: false });
    const wk = Number(p.get("wk"));
    if (Number.isInteger(wk) && wk >= 1 && wk <= parkData.weeks.length) park.week = wk - 1;
  }
}

// ---------- boot ----------
async function boot() {
  const hookFile = loadHookData().catch(() => null);
  const stealFile = loadStealData().catch(() => null);
  const lineupFile = loadLineupData().catch(() => null);
  const parkFile = loadParkData().catch(() => null);
  try {
    const r = await fetch(new URL(`data/${SEASON}.json?v=5`, import.meta.url));
    if (!r.ok) throw new Error(`data ${r.status}`);
    data = await r.json();
  } catch (e) {
    $("status").textContent = `Couldn't load the ${SEASON} data (${e.message}).`;
    $("status").classList.add("err");
    return;
  }
  await hookFile;
  await stealFile;
  await lineupFile;
  await parkFile;
  $("park_row").hidden = !parkData;
  if (!stealData) {
    $("steals").value = "league";
    $("steals").disabled = true;
  }
  model = prepare(data);
  buildEntries();
  $("sides").innerHTML = SIDES.map(sideHTML).join("");
  readHash();
  const P = data.pitching;
  $("opener_n").textContent = `${fmtIP(P.opener.outs)} IP, the median of ${P.opener.games} ${SEASON} openers`;
  if (!hookData) $("hook_missing").hidden = false;
  for (const s of SIDES) {
    const k = s.k;
    fillTeams($(`${k}_team`));
    $(`${k}_team`).addEventListener("change", () => {
      s.team = $(`${k}_team`).value;
      if (s.k === "h") fillPark(); // an automatic park follows the home team
      s.sp = defaultStarter(s.team);
      loadPreset(s);
      if (stealData) s.c = defaultCatcher(s);
      renderSide(s);
      followHand(otherSide(s)); // a new starter for the other team to face
      run();
    });
    $(`${k}_kind`).addEventListener("change", () => {
      s.kind = $(`${k}_kind`).value;
      loadPreset(s);
      if (stealData) s.c = defaultCatcher(s);
      renderSide(s);
      run();
    });
    $(`${k}_plan`).addEventListener("change", () => {
      s.plan = $(`${k}_plan`).value;
      renderSide(s);
      run();
    });
    $(`${k}_c`).addEventListener("change", () => {
      s.c = Number($(`${k}_c`).value);
      renderSide(s);
      run();
    });
    wireSuggest($(`${k}_sp`), $(`${k}_sp_sug`), { find: findStarters(s), current: () => s.sp.name, browse: true,
      choose: (e) => {
        s.sp = e;
        renderSide(s);
        followHand(otherSide(s));
        run();
      } });
    renderSide(s);
  }
  $("gpk_go").addEventListener("click", onLoadGame);
  // the Matchup card folds from its heading; Swap goes with what it folds away
  $("matchup_fold").addEventListener("click", () => {
    const open = $("matchup_fold").getAttribute("aria-expanded") !== "true";
    $("matchup_fold").setAttribute("aria-expanded", String(open));
    $("matchup_body").hidden = !open;
    $("swap").hidden = !open;
  });
  // the score grid's readout: hover, or a tap on touch (a tap elsewhere puts it away)
  const sgOff = () => { if (!$("sg_tip").hidden) { $("sg_tip").hidden = true; if (sgView) drawScoreGrid(null); } };
  $("sg").addEventListener("pointermove", sgHover);
  $("sg").addEventListener("pointerdown", sgHover);
  $("sg").addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") sgOff(); });
  $("sg").addEventListener("pointercancel", sgOff); // a swipe that scrolls the page instead
  // a box-score count's chart: hover, or a tap on touch (a tap elsewhere, or scrolling a table, puts it away)
  $("box_teams").addEventListener("pointerover", (ev) => {
    const td = ev.target.closest("td.hist");
    if (td && td !== histOn) showHist(td);
  });
  $("box_teams").addEventListener("pointerout", (ev) => {
    if (ev.pointerType === "mouse" && histOn && !ev.relatedTarget?.closest?.("td.hist")) hideHist();
  });
  document.addEventListener("pointerdown", (ev) => { if (histOn && !ev.target.closest?.("td.hist")) hideHist(); });
  $("box_teams").addEventListener("scroll", () => { if (histOn) hideHist(); }, true);
  document.addEventListener("pointerdown", (ev) => { if (ev.target !== $("sg")) sgOff(); });
  let sgTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(sgTimer); sgTimer = setTimeout(() => last && renderScoreGrid(), 120); });
  // the score grid's Share image button (shared/share-image.js)
  if (window.ShareImage) ShareImage.image($("sg_share"), scoreGridBlob, scoreGridFile);
  else $("sg_share").hidden = true;
  $("gpk_rand").addEventListener("click", onRandomGame);
  $("gpk").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); if (!$("gpk_go").disabled) onLoadGame(); } });
  $("swap").addEventListener("click", () => {
    const keep = ["team", "kind", "lineup", "edited", "sp", "plan", "c"];
    const a = Object.fromEntries(keep.map((x) => [x, SIDES[0][x]]));
    for (const x of keep) {
      SIDES[0][x] = SIDES[1][x];
      SIDES[1][x] = a[x];
    }
    SIDES.forEach(renderSide);
    SIDES.forEach(followHand); // each now faces the other starter
    fillPark();
    run();
  });
  for (const id of ["games", "regress", "platoon"]) $(id).addEventListener("change", run);
  fillPark();
  $("park").addEventListener("change", () => {
    const v = $("park").value;
    Object.assign(park, { at: v === "avg" || v === "none" ? v : Number(v), auto: false });
    fillPark();
    run();
  });
  $("park_week").addEventListener("change", () => {
    park.week = Number($("park_week").value);
    fillPark();
    run();
  });
  $("steals").addEventListener("change", () => {
    SIDES.forEach(renderSide);
    run();
  });
  if (linkedGame) {
    $("gpk").value = linkedGame;
    onLoadGame(); // its run replaces this one before the worker starts
  } else if (plainVisit) loadLatest(); // the default matchup runs until the game is in
  run();
}

boot();
