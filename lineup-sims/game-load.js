// Reading a real game for the Game Sim (game.js): MLB Stats API replies in, a matchup out. No
// imports and no network, so tools/lineup_sims/test_game.mjs checks it against a saved game.
//
// A game loads if it's an MLB game (both teams MLB clubs: a gamePk can be a minor-league game, and the
// schedule answers for it anyway), of the data's season, and completed (codedGameState "F": Final,
// and Completed Early; not Postponed "D" or Cancelled "C"). Regular season (gameType "R") takes the
// park's factors for the game's week, postseason (Wild Card "F", Division "D", League "L", World
// Series "W") the regular season's last week. Preseason games (spring training "S", exhibitions "E")
// don't load: their lineups are full of players who never played in the regular season, with no
// rates to simulate. Nor does the All-Star Game, which isn't between two clubs.
// From the box score: each team's starting nine in batting order (100 through 900; a substitute is
// 101, 102, ...), its starting pitcher (the first in its pitchers list) and its starting catcher
// (position C). A starting hitter the data doesn't have is replaced by his team's lineup spot, a
// starting pitcher by an MLB-average right-hander (a position player who started on the mound
// included), and each is named in `missing`.

export const STATS_API = "https://statsapi.mlb.com/api/v1";
// the gamePk is the only thing of the visitor's in either request
export const scheduleUrl = (pk) => `${STATS_API}/schedule?gamePk=${pk}&fields=dates,games,gamePk,season,gameType,officialDate,status,codedGameState,detailedState,venue,id,name,teams,away,home,team,score`;
export const boxscoreUrl = (pk) => `${STATS_API}/game/${pk}/boxscore?fields=teams,away,home,team,id,pitchers,players,person,fullName,position,abbreviation,battingOrder,stats,pitching,outs`;

// the season's MLB regular-season and postseason games, with each one's start time (for Random Game
// and the latest game: about 12 KB gzipped)
export const seasonUrl = (season) => `${STATS_API}/schedule?sportId=1&season=${season}&gameType=R,F,D,L,W&fields=dates,games,gamePk,gameType,gameDate,status,codedGameState`;

// a gamePk: 6 or 7 digits on their own, or in a Baseball Savant (gamePk=) or MLB Gameday (/<pk>/) link
export function pkOf(text) {
  const m = String(text).match(/(?:gamePk=|\/)(\d{6,7})(?!\d)|^\s*(\d{6,7})\s*$/);
  return m ? Number(m[1] ?? m[2]) : null;
}

const KIND = { R: "regular", F: "postseason", D: "postseason", L: "postseason", W: "postseason" };
export const GAME_TYPES = { R: "a regular-season game", S: "a spring training game", E: "an exhibition", F: "a Wild Card game",
  D: "a Division Series game", L: "a League Championship Series game", W: "a World Series game", A: "the All-Star Game" };
const ORD = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const malformed = () => new Error("the Stats API's reply wasn't a game this page can read");

// ctx: { season, teams: [{ id, abbr, short }] (the data's MLB clubs), hasHitter(id), hasPitcher(id), parks: [venue names], weeks: [[first "MM-DD", last, label]] }
// Returns { pk, date, venue, sides: { away, home }, park, week, missing, final }; final: the game's
// [away, home] runs (null if the schedule doesn't give both); each side is
// { team, short, lineup: [entry ids: "p<id>" or "s<team>-<spot>"], sp: "P<id>" or "PRHP", spName, spOuts: the outs he
// recorded in this game (null if the box score doesn't say), c: catcher slot or -1 }.
// The schedule's game, and its kind ("regular" or "postseason"), if it's one that loads
// (checked before the larger box score is asked for); otherwise throws the reason. teams: the data's
// MLB clubs ([{ id }]).
export function checkSchedule(pk, sched, season, teams) {
  if (!sched || typeof sched !== "object") throw malformed();
  // a postponed game made up later keeps its gamePk, and the schedule lists it on each date (Postponed,
  // then Final): the completed one is the game, else the latest
  const all = (sched.dates ?? []).flatMap((d) => d?.games ?? []).filter((x) => x?.gamePk === pk);
  if (!all.length) throw new Error(`there's no game ${pk}`);
  const g = all.find((x) => x.status?.codedGameState === "F") ?? all[all.length - 1];
  const club = (side) => teams.some((t) => t.id === g.teams?.[side]?.team?.id);
  const names = `${g.teams?.away?.team?.name ?? "?"} at ${g.teams?.home?.team?.name ?? "?"}`;
  if (g.gameType === "A") throw new Error(`game ${pk} is the All-Star Game, not two clubs`);
  if (g.gameType === "S" || g.gameType === "E") {
    throw new Error(`game ${pk} is ${GAME_TYPES[g.gameType]}; preseason games don't load, since many of their players never played in the regular season and have no ${season} rates to simulate`);
  }
  if (!club("away") && !club("home")) throw new Error(`game ${pk} isn't an MLB game (${names})`);
  if (!club("away") || !club("home")) throw new Error(`game ${pk} isn't between two MLB clubs (${names})`);
  if (g.season !== String(season)) throw new Error(`game ${pk} is from ${g.season}; only ${season} games load, since the players' rates are ${season}'s`);
  const kind = KIND[g.gameType];
  if (!kind) throw new Error(`game ${pk} isn't a regular-season, preseason or postseason game`);
  if (g.status?.codedGameState !== "F") throw new Error(`game ${pk} wasn't completed (${String(g.status?.detailedState ?? "no result").toLowerCase()})`);
  return { g, kind };
}

// Whether a game's starter opened a bullpen day: 6 outs or fewer in the game (the pipeline's opener
// cutoff), and not a regular starter, so one knocked out early isn't one: no 2026 starts, or starts
// that averaged 3 innings (9 outs) or less. outs: his outs in the game (null: unknown, so no);
// gs, startOuts: his 2026 starts and the outs in them. The Game Sim sets He pitches from it: a
// bullpen day (opener) if so, the modeled hook if not.
export function bullpenDay(outs, gs, startOuts) {
  return Number.isInteger(outs) && outs <= 6 && (!gs || startOuts / gs <= 9);
}

// The gamePks in a seasonUrl reply that load: completed regular-season and postseason games, each once
// (a postponed game made up later is listed on both dates), in order.
const finals = (sched) => {
  if (!sched || typeof sched !== "object") throw malformed();
  return (sched.dates ?? []).flatMap((d) => d?.games ?? []).filter((x) => KIND[x?.gameType] && x.status?.codedGameState === "F" && Number.isInteger(x.gamePk));
};
export function completedGames(sched) {
  return [...new Set(finals(sched).map((x) => x.gamePk))].sort((a, b) => a - b);
}

// A link's Lineup choice for a team (the kind in a=/h=): "recent" (its most recent nine against the
// other starter's hand, the default) or "spots"; links from before "recent" said "most_used" (the
// most-used order, now gone), which lands on the default. Anything else: null, the page's own default.
export const lineupKind = (v) => (v === "recent" || v === "spots" ? v : v === "most_used" ? "recent" : null);

// The most recent game in a seasonUrl reply that loads: the latest start (gameDate, an ISO time in UTC),
// not the highest gamePk (the postseason's are numbered ahead of the season's last days; a made-up game
// keeps its old one). null when there's none.
export function latestGame(sched) {
  let best = null;
  for (const x of finals(sched)) {
    const t = Date.parse(x.gameDate);
    if (Number.isFinite(t) && (!best || t > best.t || (t === best.t && x.gamePk > best.pk))) best = { t, pk: x.gamePk };
  }
  return best ? best.pk : null;
}

export function parseGame(pk, sched, box, ctx) {
  const { g, kind } = checkSchedule(pk, sched, ctx.season, ctx.teams);
  if (!box?.teams?.away?.players || !box?.teams?.home?.players || !g.officialDate || !g.venue?.name) throw malformed();
  const missing = [], sides = {};
  for (const where of ["away", "home"]) {
    const b = box.teams[where], t = ctx.teams.find((x) => x.id === b.team?.id);
    if (!t) throw new Error(`team ${b.team?.id} isn't in the ${ctx.season} data`);
    const starters = Object.values(b.players).filter((x) => x?.battingOrder && Number(x.battingOrder) % 100 === 0 && x.person?.id)
      .sort((x, y) => Number(x.battingOrder) - Number(y.battingOrder));
    if (starters.length !== 9) throw new Error(`the ${t.short}' starting lineup isn't complete in the box score`);
    const lineup = starters.map((x, i) => {
      if (ctx.hasHitter(x.person.id)) return `p${x.person.id}`;
      missing.push(`${x.person.fullName} (${t.short}' ${ORD(i + 1)} spot)`);
      return `s${t.abbr}-${i + 1}`;
    });
    const spId = b.pitchers?.[0];
    if (!spId) throw new Error(`the ${t.short}' starting pitcher isn't in the box score`);
    const spName = b.players[`ID${spId}`]?.person?.fullName ?? `pitcher ${spId}`;
    let sp = `P${spId}`;
    if (!ctx.hasPitcher(spId)) {
      missing.push(`${spName} (an MLB-average RHP)`);
      sp = "PRHP";
    }
    const outs = b.players[`ID${spId}`]?.stats?.pitching?.outs;
    sides[where] = { team: t.abbr, short: t.short, lineup, sp, spName, spOuts: Number.isInteger(outs) ? outs : null,
      c: starters.findIndex((x) => x.position?.abbreviation === "C") };
  }
  // the park by venue name (-1: none of the season's parks; the page uses the home team's); the week by
  // the game's date, or for the postseason the regular season's last
  const md = g.officialDate.slice(5);
  const week = kind === "postseason" ? ctx.weeks.length - 1 : ctx.weeks.findIndex((w) => w[0] <= md && md <= w[1]);
  const runs = [g.teams?.away?.score, g.teams?.home?.score];
  return { pk, date: g.officialDate, venue: g.venue.name, kind, type: GAME_TYPES[g.gameType], sides, missing,
    park: ctx.parks.findIndex((n) => fold(n) === fold(g.venue.name)), week, final: runs.every(Number.isInteger) ? runs : null };
}
