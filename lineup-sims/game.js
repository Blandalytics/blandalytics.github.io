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
import { BAT, PIT, prepareSteal, simulateGames } from "./game-sim.js?v=2";
import { PARK_N, parkAdjust as adjustForPark } from "./park.js?v=1";

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
  { k: "a", where: "Away", team: "CLE", kind: "spots", lineup: [], edited: false, sp: null, plan: "hook", c: 8 },
  { k: "h", where: "Home", team: "DET", kind: "spots", lineup: [], edited: false, sp: null, plan: "hook", c: 8 },
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
  const r = await fetch(`data/${SEASON}-hook.json?v=1`);
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
  const r = await fetch(`data/${SEASON}-steal.json?v=1`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  stealData = await r.json();
}
const stealOn = () => !!stealData && $("steals").value === "model";
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
  const r = await fetch(`data/${SEASON}-parks.json?v=1`);
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
}

// ---------- a real game, by gamePk ----------
// Any completed 2026 regular-season game, from MLB's Stats API (open to the browser): both teams,
// their starting nines in order, the starting pitchers, each team's catcher, the ballpark and the
// week. The rest (He pitches, Sim settings) stays as it was. A hitter or pitcher the 2026 data
// doesn't have (no counted plate appearances) is replaced, and the note says by what.
const STATS_API = "https://statsapi.mlb.com/api/v1";
const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the Stats API answered ${r.status}`);
  return r.json();
};
async function loadGame(pk) {
  const sched = await getJSON(`${STATS_API}/schedule?gamePk=${pk}&fields=dates,games,gamePk,season,gameType,officialDate,status,codedGameState,detailedState,venue,id,name,teams,away,home,team`);
  const g = sched.dates?.[0]?.games?.find((x) => x.gamePk === pk);
  if (!g) throw new Error(`there's no MLB game ${pk}`);
  const types = { S: "a spring training game", E: "an exhibition", A: "the All-Star Game", F: "a Wild Card game", D: "a Division Series game", L: "a League Championship Series game", W: "a World Series game" };
  if (g.season !== String(SEASON) || g.gameType !== "R") {
    throw new Error(`game ${pk} is ${g.gameType === "R" ? `from the ${g.season} season` : types[g.gameType] ?? `not a regular-season game`}; only completed ${SEASON} regular-season games load`);
  }
  if (g.status.codedGameState !== "F") throw new Error(`game ${pk} wasn't completed (${g.status.detailedState.toLowerCase()})`);
  const box = await getJSON(`${STATS_API}/game/${pk}/boxscore?fields=teams,away,home,team,id,pitchers,players,person,fullName,position,abbreviation,battingOrder`);
  const missing = [], sides = {};
  for (const where of ["away", "home"]) {
    const b = box.teams[where], t = data.teams.find((x) => x.id === b.team.id);
    if (!t) throw new Error(`team ${b.team.id} isn't in the ${SEASON} data`);
    // the starting nine: batting order 100, 200, ... 900 (a substitute is 101, 102, ...)
    const starters = Object.values(b.players).filter((x) => x.battingOrder && Number(x.battingOrder) % 100 === 0)
      .sort((x, y) => Number(x.battingOrder) - Number(y.battingOrder));
    if (starters.length !== 9) throw new Error(`the ${t.short}' starting lineup isn't complete in the box score`);
    const lineup = starters.map((x, i) => {
      if (entries.has(`p${x.person.id}`)) return `p${x.person.id}`;
      missing.push(`${x.person.fullName} (${t.short}' ${ordinal(i + 1)} spot)`);
      return `s${t.abbr}-${i + 1}`;
    });
    const spId = b.pitchers?.[0], spName = b.players[`ID${spId}`]?.person.fullName ?? "the starter";
    let sp = pitchers.get(`P${spId}`);
    if (!sp) {
      missing.push(`${spName} (MLB-average RHP)`);
      sp = pitchers.get("PRHP");
    }
    const c = starters.findIndex((x) => x.position?.abbreviation === "C");
    sides[where] = { team: t.abbr, lineup, sp, c, name: t.short };
  }
  // the ballpark by name, else the home team's; the week by the game's date
  const pi = parkData ? parkData.parks.findIndex((x) => fold(x.name) === fold(g.venue.name)) : -1;
  const md = g.officialDate.slice(5), wi = parkData ? parkData.weeks.findIndex((w) => w[0] <= md && md <= w[1]) : -1;
  return { pk, g, sides, park: pi, week: wi, missing };
}
function applyGame(G) {
  [["away", SIDES[0]], ["home", SIDES[1]]].forEach(([where, s]) => {
    const x = G.sides[where];
    Object.assign(s, { team: x.team, lineup: x.lineup, edited: true, sp: x.sp });
    s.c = x.c >= 0 ? x.c : -1;
    if (stealData) checkCatcher(s);
  });
  if (parkData) {
    Object.assign(park, G.park >= 0 ? { at: G.park, auto: false } : { at: "none", auto: true });
    if (park.auto) park.at = homePark();
    park.week = G.week;
  }
  SIDES.forEach(renderSide);
  fillPark();
  run();
  const day = new Date(`${G.g.officialDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const a = G.sides.away, h = G.sides.home;
  $("gpk_note").classList.toggle("warn", G.missing.length > 0);
  $("gpk_note").textContent = `${a.name} at ${h.name}, ${day}, ${G.g.venue.name}: both starting nines and starters (${a.sp.name}, ${h.sp.name})`
    + (G.park < 0 && parkData ? `; ${G.g.venue.name} has no 2026 park factors, so ${parkName() ?? "no park"}` : "")
    + (G.missing.length ? `. Not in the ${SEASON} data, so replaced: ${G.missing.join(", ")}.` : ".");
}
// a gamePk, or a link with one in it (Baseball Savant's gamefeed, MLB Gameday)
const pkOf = (text) => {
  const m = String(text).match(/(?:gamePk=|\/)(\d{6,7})(?!\d)|^\s*(\d{6,7})\s*$/);
  return m ? Number(m[1] ?? m[2]) : null;
};
async function onLoadGame() {
  const pk = pkOf($("gpk").value), note = $("gpk_note");
  note.classList.remove("warn", "err");
  if (!pk) {
    note.textContent = "Enter a gamePk: the 6-digit game number in a Baseball Savant or MLB Gameday link.";
    note.classList.add("err");
    return;
  }
  $("gpk_go").disabled = true;
  note.textContent = `loading game ${pk}…`;
  try {
    applyGame(await loadGame(pk));
  } catch (e) {
    note.textContent = `Couldn't load it: ${e.message}.`;
    note.classList.add("err");
  } finally {
    $("gpk_go").disabled = false;
  }
}

// ---------- a team: lineup, starter, plan ----------
// the team's most-used starter (most 2026 starts); an MLB-average RHP for MLB
function defaultStarter(abbr) {
  if (abbr === "MLB") return pitchers.get("PRHP");
  const arms = [...pitchers.values()].filter((e) => !e.generic && e.team === abbr && e.gs > 0).sort((a, b) => b.gs - a.gs);
  return arms[0] ?? pitchers.get("PRHP");
}
function loadPreset(s) {
  if (s.team === "MLB" && s.kind === "most_used") s.kind = "spots";
  if (s.kind === "most_used") s.lineup = teamOf(s.team).most_used.orders[0].ids.map((id) => `p${id}`);
  else s.lineup = Array.from({ length: 9 }, (_, i) => `s${s.team}-${i + 1}`);
  s.edited = false;
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
  const vs = (pitching, pTeam) => hs.map((h, i) => cumulative(parkAdjust(facing(h, pitching), es[i].team, pTeam)));
  const sp = pitcherOf(s.sp.counts, s.sp.cells, s.sp.throws, { mode, league, regress: s.sp.generic ? 0 : regress });
  const cells = penCells(s);
  const pen = bullpenOf(cellsTotal(cells), cells, { mode, league });
  const from = fromOf(s);
  const t = { stages: [{ from: 0, vs: vs(sp, s.sp.generic ? "MLB" : s.sp.team) }, { from, vs: vs(pen, s.team), pen: true }],
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
        <option value="spots">Lineup spots</option>
        <option value="most_used">Most-used batting order</option>
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
        <option value="bullpen">Bullpen day (opener)</option>
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

function renderSide(s) {
  const k = s.k;
  $(`${k}_team`).value = s.team;
  $(`${k}_kind`).querySelector("[value=most_used]").disabled = s.team === "MLB";
  $(`${k}_kind`).value = s.kind;
  $(`${k}_title`).textContent = teamName(s.team);
  $(`${k}_sp`).value = s.sp.name;
  const sel = $(`${k}_plan`), opt = (v) => sel.querySelector(`[value=${v}]`);
  opt("start").disabled = !s.sp.gs;
  opt("hook").disabled = !s.sp.gs || !hookData;
  opt("start").textContent = s.sp.gs ? `Average start (${fmtIP(startOutsOf(s.sp))} IP)` : "Average start";
  opt("bullpen").textContent = `Bullpen day (opener, ${fmtIP(data.pitching.opener.outs)} IP)`;
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
      w.title = "Small sample: Sim settings can add MLB-average PA";
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
  const w = new Worker(new URL("./game-worker.js?v=2", import.meta.url), { type: "module" });
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
  job = { id: ++jobs, teams, games, steal: stealOn(), park: parkName(), week: park.week >= 0 ? parkData.weeks[park.week][2] : null, sides: SIDES.map((s) => ({ ...s, lineup: [...s.lineup], from: fromOf(s) })) };
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
  last = { res, sides: j.sides, games: j.games, ms, steal: j.steal, park: j.park, week: j.week };
  $("out").hidden = $("box").hidden = false;
  $("out").style.opacity = $("box").style.opacity = "";
  $("status").textContent = res.capped ? `${res.capped.toLocaleString()} innings were called off at 60 plate appearances; adding MLB-average PA under Sim settings fixes that.` : "";
  $("status").classList.toggle("err", res.capped > 0);
  renderResults();
  renderBox();
}

// ---------- results ----------
const per = (x) => x / last.games;
const f2 = (x) => x.toFixed(2);

function renderResults() {
  const { res, sides, games } = last;
  const name = (t) => teamName(sides[t].team), abbr = (t) => teamAbbr(sides[t]);
  const runs = res.line.map((l) => l.reduce((a, x) => a + x, 0));
  const hits = res.bat.map((b) => { let s = 0; for (let i = 0; i < 9; i++) s += b[i * nB + Bi.H]; return s; });
  // who wins
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
  kpi(`${same ? "Away" : name(0)} win`, pct(res.wins[0] / games), `${f2(per(runs[0]))} runs a game`, "var(--s-away)");
  kpi(`${same ? "Home" : name(1)} win`, pct(res.wins[1] / games), `${f2(per(runs[1]))} runs a game`, "var(--s-home)");
  kpi("Extra innings", pct(res.extras / games), `Walk-offs ${pct(res.walkoffs / games)} · ${f2(per(res.innings))} innings a game`
    + (res.ties ? ` · ${res.ties} called at 40 innings` : ""));
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
    tr.innerHTML = `<th scope="row"><i class="dot" style="background:var(--s-${t ? "home" : "away"})"></i>${abbr(t)}</th>${cells}`
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
  $("games_note").textContent = `${games.toLocaleString()} games${last.ms ? ` in ${(last.ms / 1000).toFixed(1)} s` : ""}`
    + `${last.park ? ` at ${last.park}${last.week ? `, ${last.week}` : ""}` : ", no park adjustment"}. The away team bats first; no home-field edge beyond batting last.`;
}

// the box score: every hitter's and pitcher's line, per game
function renderBox() {
  const { res, sides } = last;
  const box = $("box_teams");
  box.replaceChildren();
  sides.forEach((s, t) => {
    const sec = document.createElement("div");
    sec.className = "section box-team";
    const h = document.createElement("h3");
    h.innerHTML = `<i class="dot" style="background:var(--s-${t ? "home" : "away"})"></i>`;
    h.append(`${teamName(s.team)} `, Object.assign(document.createElement("span"), { className: "where", textContent: s.where }));
    sec.append(h, battingTable(res.bat[t], s), pitchingTable(res.pit[t], s, res.wins[t], res.wins[1 - t]));
    if (last.steal) {
      // the catcher's running game: steals and runners caught against him, per game
      const [sb, cs] = res.caught[t], p = document.createElement("p");
      p.className = "note catch-line";
      p.textContent = `Catcher: ${catcherName(s)} · ${f2(per(sb))} SB and ${f2(per(cs))} CS against a game`
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
const BAT_COLS = () => ["PA", "AB", "R", "H", "2B", "3B", "HR", "RBI", "BB", "HBP", "K", ...(last.steal ? ["SB", "CS"] : [])];

function battingTable(arr, s) {
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const table = document.createElement("table");
  table.className = "box";
  table.innerHTML = `<caption class="sr-only">${teamName(s.team)} batting, per game</caption>
    <thead><tr><th scope="col">Batter</th>${BAT_COLS().map((k) => `<th scope="col">${k}</th>`).join("")}
    <th scope="col" class="rate">AVG</th><th scope="col">OBP</th><th scope="col">SLG</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector("tbody");
  const total = new Float64Array(nB);
  const row = (spot, name, sub, b, cls = "") => {
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    const r = RATE(b);
    tr.innerHTML = `<td class="who"><span class="nm"><b class="sp">${spot}</b></span><span class="who-sub"></span></td>`
      + BAT_COLS().map((k) => `<td class="num">${f2(per(b[Bi[k]]))}</td>`).join("")
      + `<td class="num rate">${fmtRate(r.AVG)}</td><td class="num">${fmtRate(r.OBP)}</td><td class="num">${fmtRate(r.SLG)}</td>`;
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
    row(i + 1, name, e.kind === "spot" && e.team !== "MLB" ? `${other}${e.spot}: ${e.sub}` : "", b);
  });
  row("", "Totals", "", total, "total");
  wrap.append(table);
  return wrap;
}

function pitchingTable(arr, s, won, lost) {
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
  const row = (name, sub, p, cls = "", decisions = null, qs = true) => {
    const g = (k) => p[Pi[k]];
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    const ip = g("OUTS") / 3;
    const [w, l, sv] = decisions ?? [g("W"), g("L"), g("SV")];
    tr.innerHTML = `<td class="who"><span class="nm"></span><span class="who-sub"></span></td><td class="num">${fmtIP(Math.round(per(g("OUTS"))))}</td>`
      + ["H", "R", "ER", "BB", "K", "HR", "BF"].map((k) => `<td class="num">${f2(per(g(k)))}</td>`).join("")
      + (np ? `<td class="num">${per(g("NP")).toFixed(1)}</td>` : "")
      + `<td class="num rate">${ip ? ((9 * g("ER")) / ip).toFixed(2) : "—"}</td><td class="num">${ip ? ((g("BB") + g("H")) / ip).toFixed(2) : "—"}</td>`
      + `<td class="num">${pct(w / G)}</td><td class="num">${pct(l / G)}</td><td class="num">${pct(sv / G)}</td>`
      + `<td class="num">${qs ? pct(g("QS") / G) : "—"}</td>`;
    tr.querySelector(".nm").textContent = name;
    tr.querySelector(".who-sub").textContent = sub;
    tr.querySelector(".who-sub").hidden = !sub;
    body.append(tr);
  };
  const sp = arr.slice(0, nP), pen = arr.slice(nP, 2 * nP);
  const how = { hook: "until the modeled hook", game: "nine innings", bullpen: "opener" }[s.plan] ?? `average start, ${fmtIP(s.from)} IP`;
  row(s.sp.name, `Starter · ${how}`, sp);
  row(penName(s), `In ${pct(pen[Pi.G] / G)} of games`, pen, "", null, false);
  const total = sp.map((x, i) => x + pen[i]);
  row("Totals", "", total, "total", [won, lost, total[Pi.SV]]);
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
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const [key, sel] of [["g", "games"], ["r", "regress"], ["pl", "platoon"], ["st", "steals"]]) {
    const v = p.get(key);
    if (v && [...$(sel).options].some((o) => o.value === v)) $(sel).value = v;
  }
  for (const s of SIDES) {
    const [team, kind, sp, plan, c] = (p.get(s.k) ?? "").split(".");
    if (team && (team === "MLB" || teamOf(team))) s.team = team;
    if (kind === "spots" || kind === "most_used") s.kind = kind;
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
  const parkFile = loadParkData().catch(() => null);
  try {
    const r = await fetch(`data/${SEASON}.json?v=5`);
    if (!r.ok) throw new Error(`data ${r.status}`);
    data = await r.json();
  } catch (e) {
    $("status").textContent = `Couldn't load the ${SEASON} data (${e.message}).`;
    $("status").classList.add("err");
    return;
  }
  await hookFile;
  await stealFile;
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
        run();
      } });
    renderSide(s);
  }
  $("gpk_go").addEventListener("click", onLoadGame);
  $("gpk").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); onLoadGame(); } });
  $("swap").addEventListener("click", () => {
    const keep = ["team", "kind", "lineup", "edited", "sp", "plan", "c"];
    const a = Object.fromEntries(keep.map((x) => [x, SIDES[0][x]]));
    for (const x of keep) {
      SIDES[0][x] = SIDES[1][x];
      SIDES[1][x] = a[x];
    }
    SIDES.forEach(renderSide);
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
  run();
}

boot();
