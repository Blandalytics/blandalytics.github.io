// Data access for the Sequencing Flow page. Everything runs in the browser:
//
//   - settled days come from the completed-games Parquet in the R2 bucket
//     (https://data.blandalytics.com/data/, see tools/data/README.md), read with
//     hyparquet over HTTP range requests so a day costs a few hundred KB even
//     out of a month or season file;
//   - days the files don't reach yet come from the live feed the Worker writes
//     (live/games/<gamePk>.json), while those objects exist;
//   - pitcher search and game logs come straight from the MLB Stats API, which
//     allows cross-origin requests.
//
// `buildFlow` turns either source's pitches into the node/link structure the
// chart draws (the same shape sequence_sankey.py produces).

import { parquetMetadataAsync, parquetQuery, asyncBufferFromUrl } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm';
import { compressors } from 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/+esm';

export const DATA_ROOT = 'https://data.blandalytics.com/';
const API = 'https://statsapi.mlb.com/api/v1';
const SPORT = 'mlb';

export const COLORS = {
  FF: '#FF6683', SI: '#F2B24B', FS: '#83D6FF', FC: '#C59C9C', SL: '#CE66FF', ST: '#FFAAF7',
  CU: '#339cff', KC: '#339cff', CS: '#2A98FF', SV: '#2A98FF', CH: '#6DE95D', KN: '#c7c7c7', SC: '#c7c7c7', UN: '#c7c7c7',
};
const PITCH_NAMES = {
  FF: 'Four-Seam Fastball', FA: 'Fastball', SI: 'Sinker', FC: 'Cutter', SL: 'Slider', ST: 'Sweeper',
  CU: 'Curveball', KC: 'Knuckle Curve', CS: 'Slow Curve', SV: 'Slurve', CH: 'Changeup', FS: 'Splitter',
  FO: 'Forkball', SC: 'Screwball', KN: 'Knuckleball', EP: 'Eephus', PO: 'Pitchout', UN: 'Unknown',
};
// How a plate appearance ended, in top-to-bottom order; ending nodes share one face and
// are told apart by outline color.
export const END_CATS = ['Strikeout', 'Batted Ball Out', 'Walk/HBP', 'Hit', 'Other'];
export const END_OUTLINES = {
  'Strikeout': '#65FF9C', 'Walk/HBP': '#FFC46A', 'Batted Ball Out': '#65BAFF', 'Hit': '#F4707C', 'Other': '#F4F1EA',
};
const BATTED_OUTS = new Set([
  'field_out', 'force_out', 'grounded_into_double_play', 'double_play', 'triple_play',
  'sac_fly', 'sac_bunt', 'sac_fly_double_play', 'sac_bunt_double_play', 'fielders_choice_out', 'fielders_choice',
]);
const HITS = new Set(['single', 'double', 'triple', 'home_run']);
const WALKS = new Set(['walk', 'intent_walk', 'hit_by_pitch']);
const STRIKE_CALLS = new Set(['C', 'S', 'F', 'T', 'W', 'L', 'M', 'O', 'Q', 'R', 'X', 'D', 'E', 'J', 'Z']);
const IN_PLAY_CALLS = new Set(['X', 'D', 'E', 'J', 'Z']);

export function endCategory(events) {
  const ev = (events || '').toLowerCase();
  if (ev.includes('strikeout')) return 'Strikeout';
  if (WALKS.has(ev)) return 'Walk/HBP';
  if (HITS.has(ev)) return 'Hit';
  if (BATTED_OUTS.has(ev)) return 'Batted Ball Out';
  return 'Other';
}
// Outs a plate appearance's result records, from its event code.
function outsFor(events) {
  const ev = (events || '').toLowerCase();
  if (ev.includes('triple_play')) return 3;
  if (ev.includes('double_play')) return 2;
  if (ev.includes('strikeout') || BATTED_OUTS.has(ev) || ev.startsWith('caught_stealing') || ev.startsWith('pickoff')) return 1;
  return 0;
}
// The live feed carries event codes only; the Parquet has the display name. Recover the
// familiar batted-ball names from the play description.
function eventName(code, description) {
  const d = (description || '').toLowerCase();
  if (code === 'field_out') {
    if (d.includes('grounds out') || d.includes('ground ball')) return 'Groundout';
    if (d.includes('flies out') || d.includes('fly ball')) return 'Flyout';
    if (d.includes('lines out') || d.includes('line drive')) return 'Lineout';
    if (d.includes('pops out') || d.includes('pop')) return 'Pop Out';
    if (d.includes('bunt')) return 'Bunt Groundout';
    return 'Field Out';
  }
  const fixed = {
    strikeout: 'Strikeout', strikeout_double_play: 'Strikeout Double Play', walk: 'Walk', intent_walk: 'Intent Walk',
    hit_by_pitch: 'Hit By Pitch', single: 'Single', double: 'Double', triple: 'Triple', home_run: 'Home Run',
    force_out: 'Forceout', grounded_into_double_play: 'Grounded Into DP', double_play: 'Double Play',
    sac_fly: 'Sac Fly', sac_bunt: 'Sac Bunt', fielders_choice_out: 'Fielders Choice Out', fielders_choice: 'Fielders Choice',
    field_error: 'Field Error', catcher_interf: 'Catcher Interference',
  };
  if (fixed[code]) return fixed[code];
  return (code || 'Unknown').split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------------------
// Manifest and the data files
// ---------------------------------------------------------------------------
let manifest = null;
export async function loadManifest() {
  if (manifest) return manifest;
  const r = await fetch(DATA_ROOT + 'data/manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('manifest ' + r.status);
  manifest = await r.json();
  return manifest;
}
export function lastFinalized() { return manifest?.last_finalized?.[SPORT] || null; }
export function firstDate() {
  let first = null;
  for (const u of Object.values(manifest?.units || {})) if (u.sport === SPORT && (!first || u.start < first)) first = u.start;
  return first;
}
// The finest file that covers a settled date: its day, else its month, else its season.
export function unitFor(date) {
  const units = manifest?.units || {};
  let best = null;
  for (const [key, u] of Object.entries(units)) {
    if (u.sport !== SPORT || date < u.start || date > u.end) continue;
    const rank = { day: 0, month: 1, season: 2 }[u.unit] ?? 3;
    if (!best || rank < best.rank) best = { key, rank, unit: u };
  }
  return best ? { key: best.key, url: DATA_ROOT + best.key, ...best.unit } : null;
}

const COLUMNS = [
  'game_pk', 'game_date', 'home_team', 'away_team', 'bat_team', 'field_team', 'at_bat_index', 'inning', 'half',
  'pitcher', 'pitcher_name', 'p_throws', 'batter', 'batter_name', 'stand', 'pitch_number', 'pitch_type', 'pitch_name',
  'events', 'event', 'is_strike', 'is_in_play', 'outs',
];
const files = new Map();   // url -> { file, metadata }
async function openFile(url) {
  if (files.has(url)) return files.get(url);
  const p = (async () => {
    const file = await asyncBufferFromUrl({ url });
    const metadata = await parquetMetadataAsync(file);
    return { file, metadata };
  })();
  files.set(url, p);
  return p;
}
const days = new Map();    // date -> rows
// Every tracked MLB pitch on a settled date, from the file that covers it.
export async function readDay(date) {
  if (days.has(date)) return days.get(date);
  const p = (async () => {
    const unit = unitFor(date);
    if (!unit) return [];
    const { file, metadata } = await openFile(unit.url);
    const d0 = new Date(date + 'T00:00:00Z'), d1 = new Date(d0.getTime() + 86400000);
    const rows = await parquetQuery({
      file, metadata, compressors, columns: COLUMNS,
      filter: { game_date: { $gte: d0, $lt: d1 } },
    });
    rows.forEach(r => { r.game_date = date; r.live = false; });
    return rows;
  })();
  days.set(date, p);
  return p;
}

// ---------------------------------------------------------------------------
// The live feed, for dates the files don't reach yet
// ---------------------------------------------------------------------------
async function schedule(date) {
  const r = await fetch(`${API}/schedule?sportId=1&date=${date}&fields=dates,games,gamePk,status,abstractGameState,detailedState`);
  if (!r.ok) throw new Error('schedule ' + r.status);
  const j = await r.json();
  return (j.dates?.[0]?.games || []).map(g => ({ gamePk: g.gamePk, state: g.status?.abstractGameState, detail: g.status?.detailedState }));
}
// A live game JSON, reshaped to the Parquet row layout so the rest of the page needs no second path.
function liveRows(g, date) {
  const plays = new Map(g.plays.map(p => [p.atBat, p]));
  return g.pitches.map(p => {
    const play = plays.get(p.atBat) || {};
    const top = p.half === 'top';
    return {
      game_pk: g.gamePk, game_date: date, live: true, status: g.status,
      home_team: g.home.abbr, away_team: g.away.abbr,
      bat_team: top ? g.away.abbr : g.home.abbr, field_team: top ? g.home.abbr : g.away.abbr,
      at_bat_index: p.atBat, inning: p.inning, half: p.half,
      pitcher: p.pitcher, pitcher_name: g.players[p.pitcher] || String(p.pitcher), p_throws: p.throws,
      batter: p.batter, batter_name: g.players[p.batter] || String(p.batter),
      pitch_number: p.n, pitch_type: p.type || 'UN', pitch_name: PITCH_NAMES[p.type] || p.type || 'Unknown',
      events: play.complete ? play.event : null,
      event: play.complete && play.event ? eventName(play.event, play.description) : null,
      is_strike: STRIKE_CALLS.has(p.call), is_in_play: IN_PLAY_CALLS.has(p.call), outs: p.outs,
    };
  });
}
export async function readLiveDay(date) {
  const key = 'live:' + date;
  if (days.has(key)) return days.get(key);
  const p = (async () => {
    const games = await schedule(date);
    const got = await Promise.all(games.map(async g => {
      try {
        const r = await fetch(`${DATA_ROOT}live/games/${g.gamePk}.json`, { cache: 'no-cache' });
        if (!r.ok) return [];
        return liveRows(await r.json(), date);
      } catch (e) { return []; }
    }));
    return got.flat();
  })();
  // a game in progress keeps changing, so only settled-looking results are kept
  days.set(key, p);
  p.then(rows => { if (rows.some(r => r.status && r.status !== 'Final' && r.status !== 'Game Over')) days.delete(key); });
  return p;
}
// Rows for a date from whichever source covers it.
export async function rowsFor(date) {
  const last = lastFinalized();
  if (last && date <= last) return readDay(date);
  return readLiveDay(date);
}
export function isSettled(date) { const last = lastFinalized(); return !!last && date <= last; }

// The pitchers who threw a tracked pitch on a date: one entry per pitcher per game.
export function pitchersOn(rows) {
  const by = new Map();
  rows.forEach(r => {
    const k = r.pitcher + '|' + r.game_pk;
    let e = by.get(k);
    if (!e) {
      e = { id: r.pitcher, name: r.pitcher_name, gamePk: r.game_pk, team: r.field_team, opp: r.bat_team,
            home: r.field_team === r.home_team, pitches: 0, firstAb: r.at_bat_index, live: r.live };
      by.set(k, e);
    }
    e.pitches += 1;
    if (r.at_bat_index < e.firstAb) e.firstAb = r.at_bat_index;
  });
  // the starter is whoever threw his team's first plate appearance in the field
  const firstAb = new Map();
  rows.forEach(r => {
    const k = r.game_pk + '|' + r.field_team;
    if (!firstAb.has(k) || r.at_bat_index < firstAb.get(k)) firstAb.set(k, r.at_bat_index);
  });
  const list = [...by.values()];
  list.forEach(e => { e.start = e.firstAb === firstAb.get(e.gamePk + '|' + e.team); });
  list.sort((a, b) => b.pitches - a.pitches || a.name.localeCompare(b.name));
  return list;
}

// ---------------------------------------------------------------------------
// Stats API: pitcher search and game logs
// ---------------------------------------------------------------------------
export async function searchPitchers(q) {
  const url = `${API}/people/search?names=${encodeURIComponent(q)}&sportIds=1&fields=people,id,fullName,active,primaryPosition,abbreviation`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('search ' + r.status);
  const j = await r.json();
  return (j.people || [])
    .filter(p => ['P', 'TWP'].includes(p.primaryPosition?.abbreviation))
    .sort((a, b) => (b.active === true) - (a.active === true) || a.fullName.localeCompare(b.fullName))
    .map(p => ({ id: p.id, name: p.fullName, active: !!p.active }));
}
let teamAbbr = null;
async function teams() {
  if (teamAbbr) return teamAbbr;
  try {
    const r = await fetch(`${API}/teams?sportId=1&fields=teams,id,abbreviation`);
    const j = await r.json();
    teamAbbr = Object.fromEntries((j.teams || []).map(t => [t.id, t.abbreviation]));
  } catch (e) { teamAbbr = {}; }
  return teamAbbr;
}
export async function person(id) {
  const r = await fetch(`${API}/people/${id}?fields=people,id,fullName`);
  if (!r.ok) throw new Error('person ' + r.status);
  const j = await r.json();
  return j.people?.[0] ? { id: j.people[0].id, name: j.people[0].fullName } : null;
}
// A pitcher's appearances in a season (regular season and postseason), newest first.
export async function gameLog(id, season) {
  const url = `${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R,F,D,L,W`
    + '&fields=stats,splits,date,gameType,isHome,game,gamePk,opponent,id,name,team,stat,inningsPitched,strikeOuts,baseOnBalls,hits,numberOfPitches,gamesStarted';
  const r = await fetch(url);
  if (!r.ok) throw new Error('gameLog ' + r.status);
  const j = await r.json();
  const splits = (j.stats || []).flatMap(s => s.splits || []);
  const abbr = await teams();
  const seen = new Set();
  return splits
    .map(s => ({
      date: s.date, gamePk: s.game?.gamePk, gameType: s.gameType, home: !!s.isHome,
      opp: abbr[s.opponent?.id] || s.opponent?.name || '', team: abbr[s.team?.id] || '',
      start: (s.stat?.gamesStarted || 0) > 0, ip: s.stat?.inningsPitched, k: s.stat?.strikeOuts,
      bb: s.stat?.baseOnBalls, h: s.stat?.hits, pitches: s.stat?.numberOfPitches,
    }))
    .filter(g => g.gamePk && !seen.has(g.gamePk) && seen.add(g.gamePk))
    .sort((a, b) => b.date.localeCompare(a.date) || b.gamePk - a.gamePk);
}

// ---------------------------------------------------------------------------
// From pitches to the chart's nodes and links (port of sequence_sankey.py)
// ---------------------------------------------------------------------------
// Outs a pitcher recorded, as how far the out count moved while he was on the mound. Pitch-level
// data cannot see every out as an event: a runner picked off or caught stealing during a plate
// appearance is an out on that play, but the batter's result is a flyout like any other. The
// `outs` on each pitch (the count before it) does see them.
export function outsRecorded(gameRows, pitcherId) {
  const rows = gameRows.slice().sort((a, b) => a.at_bat_index - b.at_bat_index || a.pitch_number - b.pitch_number);
  const halves = [];
  rows.forEach(r => {
    const h = halves[halves.length - 1];
    if (h && h.inning === r.inning && h.half === r.half) h.rows.push(r);
    else halves.push({ inning: r.inning, half: r.half, rows: [r] });
  });
  let outs = 0;
  halves.forEach((h, hi) => {
    // a later half-inning exists, so this one reached three outs; the last one may be unfinished
    const last = h.rows[h.rows.length - 1];
    const end = hi < halves.length - 1 ? 3 : (last.outs ?? 0) + outsFor(last.events);
    const stints = [];                                   // consecutive rows by the same pitcher
    h.rows.forEach(r => {
      const s = stints[stints.length - 1];
      if (!s || s.pitcher !== r.pitcher) stints.push({ pitcher: r.pitcher, at: r.outs ?? 0 });
    });
    stints.forEach((s, i) => {
      if (s.pitcher !== pitcherId) return;
      const to = i + 1 < stints.length ? stints[i + 1].at : end;
      outs += Math.max(0, to - s.at);
    });
  });
  return outs;
}

function gameLine(pas, pitches, recorded) {
  let outs = 0, hits = 0, bb = 0, k = 0, hr = 0;
  pas.forEach(p => {
    const ev = (p.events || '').toLowerCase();
    outs += outsFor(ev);          // only used when the out count is not available (a filtered split)
    if (HITS.has(ev)) hits += 1;
    if (ev === 'home_run') hr += 1;
    if (ev === 'walk' || ev === 'intent_walk') bb += 1;
    if (ev.includes('strikeout')) k += 1;
  });
  const strikes = pitches.filter(p => p.is_strike || p.is_in_play).length;
  if (typeof recorded === 'number') outs = recorded;
  return { ip: `${Math.floor(outs / 3)}.${outs % 3}`, pa: pas.length, h: hits, bb, k, hr, pitches: pitches.length, strikes };
}

export function buildFlow(rows, meta) {
  const pitches = rows.slice().sort((a, b) => a.at_bat_index - b.at_bat_index || a.pitch_number - b.pitch_number);
  pitches.forEach(p => { if (!p.pitch_type) p.pitch_type = 'UN'; });
  const typeCounts = new Map();
  pitches.forEach(p => typeCounts.set(p.pitch_type, (typeCounts.get(p.pitch_type) || 0) + 1));
  const palette = Object.keys(COLORS);
  // Top-to-bottom order within every column: most-used pitch type in the game first
  const order = [...typeCounts.keys()].sort((a, b) => typeCounts.get(b) - typeCounts.get(a)
    || (palette.indexOf(a) < 0 ? 99 : palette.indexOf(a)) - (palette.indexOf(b) < 0 ? 99 : palette.indexOf(b)));
  const names = new Map(pitches.map(p => [p.pitch_type, p.pitch_name || PITCH_NAMES[p.pitch_type] || p.pitch_type]));
  const maxN = Math.max(...pitches.map(p => p.pitch_number));

  // One record per plate appearance, with its full pitch sequence
  const byAb = new Map();
  pitches.forEach(p => { if (!byAb.has(p.at_bat_index)) byAb.set(p.at_bat_index, []); byAb.get(p.at_bat_index).push(p); });
  const pas = [...byAb.entries()].sort((a, b) => a[0] - b[0]).map(([ab, ps]) => {
    const last = ps[ps.length - 1];
    const events = last.events || '';
    return {
      id: ab, batter: ps[0].batter_name, inning: ps[0].inning, half: ps[0].half, events,
      result: last.event || (events ? eventName(events, '') : 'In progress'),
      cat: events ? endCategory(events) : 'Other', complete: !!events,
      seq: ps.map(p => p.pitch_type),
    };
  });

  const nodeCount = new Map(), nodeEnd = new Map(), endCount = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  pas.forEach(pa => pa.seq.forEach((t, i) => {
    const n = i + 1;
    inc(nodeCount, n + '|' + t);
    if (i + 1 === pa.seq.length) { inc(nodeEnd, n + '|' + t); inc(endCount, n + '|' + pa.cat); }
  }));

  // Node index: real nodes first (column-major, in usage order), then one END node per column
  const nodes = [], index = new Map();
  for (let n = 1; n <= maxN; n++) order.forEach(t => {
    const c = nodeCount.get(n + '|' + t);
    if (!c) return;
    index.set(n + '|' + t, nodes.length);
    nodes.push({ n, type: t, label: t, name: names.get(t), color: COLORS[t] || COLORS.UN, count: c, ended: nodeEnd.get(n + '|' + t) || 0 });
  });
  const endIndex = new Map();
  for (let n = 1; n <= maxN; n++) END_CATS.forEach(cat => {
    const c = endCount.get(n + '|' + cat);
    if (!c) return;
    endIndex.set(n + '|' + cat, nodes.length);
    nodes.push({ n, type: 'END', cat, label: cat, name: 'Plate appearance ends: ' + cat, color: 'surface', outline: END_OUTLINES[cat], count: c, ended: 0 });
  });

  // One link per pitch-to-pitch step of each plate appearance (value 1), so a whole PA can be
  // traced by its shared `pa` id. Terminal links run from the last pitch to that column's END node.
  const links = [];
  pas.forEach(pa => pa.seq.forEach((t, i) => {
    const n = i + 1;
    if (i + 1 < pa.seq.length) links.push({ source: index.get(n + '|' + t), target: index.get((n + 1) + '|' + pa.seq[i + 1]), pa: pa.id, step: i, type: t, terminal: false });
    else links.push({ source: index.get(n + '|' + t), target: endIndex.get(n + '|' + pa.cat), pa: pa.id, step: i, type: t, terminal: true });
  }));
  const rank = i => { const t = nodes[i]; return t.type === 'END' ? END_CATS.indexOf(t.cat) : order.indexOf(t.type); };
  links.sort((a, b) => nodes[a.source].n - nodes[b.source].n || rank(a.source) - rank(b.source)
    || (a.terminal - b.terminal) || rank(a.target) - rank(b.target) || a.pa - b.pa);

  const colTotal = {};
  nodeCount.forEach((c, k) => { const n = k.split('|')[0]; colTotal[n] = (colTotal[n] || 0) + c; });

  return {
    meta: { ...meta, line: gameLine(pas, pitches, meta.outs) },
    nodes, links, pas, max_n: maxN, col_total: colTotal,
    types: order.map(t => ({ code: t, name: names.get(t), color: COLORS[t] || COLORS.UN, count: typeCounts.get(t) })),
    order, end_cats: END_CATS, end_outlines: END_OUTLINES,
  };
}

// The flow for one pitcher's game: rows already narrowed to the date.
// `hand` is 'R' or 'L' to keep only the pitches thrown to batters of that side.
export function flowFor(rows, pitcherId, gamePk, hand) {
  const his = rows.filter(r => r.pitcher === pitcherId && (!gamePk || r.game_pk === gamePk));
  if (!his.length) return null;
  const mine = hand ? his.filter(r => r.stand === hand) : his;
  if (!mine.length) return null;
  const r0 = his[0];
  // Innings come from the out count over the whole game; a split by batter side falls back to
  // the outs its own plate appearances recorded.
  const game = rows.filter(r => r.game_pk === r0.game_pk);
  const outs = hand ? null : outsRecorded(game, pitcherId);
  const home = r0.field_team === r0.home_team;
  const meta = {
    pitcher: r0.pitcher_name, pitcherId, date: r0.game_date, gamePk: r0.game_pk,
    home: r0.home_team, away: r0.away_team, opponent: r0.bat_team, throws: r0.p_throws,
    home_text: home ? 'vs' : '@',     // the pitcher's side of the matchup
    outs,
    hand: hand || null,
    live: !!r0.live, status: r0.status || null,
  };
  return buildFlow(mine, meta);
}

/** Which batter sides this pitcher actually faced in a game: ['R', 'L'] in that order. */
export function handsFor(rows, pitcherId, gamePk) {
  const sides = new Set(rows.filter(r => r.pitcher === pitcherId && (!gamePk || r.game_pk === gamePk)).map(r => r.stand));
  return ['R', 'L'].filter(h => sides.has(h));
}
