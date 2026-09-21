// The page: pitcher search, season, game date and game controls over data.js, drawing with sankey.js.
//
// Two ways in, which meet in the middle:
//   - a pitcher (searched by name) lists their appearances in the chosen season; picking one draws it;
//   - a game date lists every pitcher who threw a tracked pitch that day; picking one draws it.
// With both set, the page goes straight to that pitcher's game on that date. A flow is linkable
// as #<pitcherId>-<YYYY-MM-DD>.

import * as data from './data.js?v=1';
import * as sankey from './sankey.js?v=10';

const $ = id => document.getElementById(id);
const q = $('q'), hits = $('hits'), seasonSel = $('season'), dateIn = $('date'), gameSel = $('game'), gameLabel = $('gameLabel');
const status = $('status'), empty = $('empty'), flow = $('flow'), controls = $('controls'), reset = $('reset'), png = $('png');

const state = { pitcher: null, date: null, log: [], dayList: [], loading: 0, meta: null };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDate(iso, year) {
  const d = new Date(iso + 'T12:00:00');
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + (year ? ', ' + d.getFullYear() : '');
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fill(sel, items, value) {     // items: [[value, label, disabled?], ...]
  sel.innerHTML = '';
  items.forEach(([v, label, off]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label; if (off) o.disabled = true;
    sel.appendChild(o);
  });
  if (value !== undefined) sel.value = value;
  sel.disabled = items.length === 0;
}
function showEmpty(text) {
  sankey.clear();
  state.meta = null; png.hidden = true;
  flow.hidden = true; controls.hidden = true;
  empty.textContent = text; empty.hidden = false;
  document.title = 'Sequencing Flow';
}

// ---- drawing a game ----------------------------------------------------------
function header(m) {
  $('name').textContent = m.pitcher;
  const live = m.live ? ` · <span class="live">${m.status && m.status !== 'Final' && m.status !== 'Game Over' ? 'In progress' : 'Live feed'}</span>` : '';
  $('matchup').innerHTML = `<b>${m.away} @ ${m.home}</b> · ${niceDate(m.date, true)} · vs ${m.opponent}${live}`;
  const L = m.line;
  const stats = [['IP', L.ip], ['H', L.h], ['BB', L.bb], ['K', L.k], ['Pitches', L.pitches], ['Strikes', L.strikes]];
  $('line').innerHTML = stats.map(([k, v]) => `<div class="stat"><span class="v">${v}</span><span class="k">${k}</span></div>`).join('');
  document.title = `${m.pitcher} · ${niceDate(m.date, true)} · Sequencing Flow`;
}
async function draw(date, pitcherId, gamePk) {
  const token = ++state.loading;
  empty.textContent = 'Loading…'; empty.hidden = false;
  try {
    const rows = await data.rowsFor(date);
    if (token !== state.loading) return;
    const f = data.flowFor(rows, pitcherId, gamePk);
    if (!f) {
      const who = state.pitcher ? state.pitcher.name : (state.dayList.find(x => x.id === pitcherId) || {}).name || 'that pitcher';
      showEmpty(data.isSettled(date)
        ? `No tracked pitches for ${who} on ${niceDate(date, true)}.`
        : `No data yet for ${who} on ${niceDate(date, true)} — the live feed doesn't have that game, and the data files reach ${niceDate(data.lastFinalized(), true)}.`);
      return;
    }
    header(f.meta);
    state.meta = f.meta;
    flow.hidden = false; controls.hidden = false; empty.hidden = true;
    await sankey.show(f);
    png.hidden = false;
    const hash = `#${pitcherId}-${date}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  } catch (e) {
    if (token !== state.loading) return;
    showEmpty('Could not load that game: ' + (e.message || e));
  }
}

// ---- the game list: a pitcher's season, or a day's pitchers ---------------------
function availability(date) {
  if (date > today()) return 'future';
  return data.isSettled(date) ? 'settled' : 'recent';
}
function fillFromLog(select) {
  gameLabel.textContent = 'Game';
  const items = state.log.map(g => {
    const a = availability(g.date);
    const where = (g.home ? 'vs ' : '@ ') + g.opp;
    const line = g.ip != null ? ` · ${g.ip} IP, ${g.k} K, ${g.pitches} P` : '';
    const tag = a === 'recent' ? ' · live feed' : '';
    return [`${state.pitcher.id}|${g.gamePk}|${g.date}`, `${niceDate(g.date)} · ${where}${g.start ? '' : ' (RP)'}${line}${tag}`, a === 'future'];
  });
  fill(gameSel, items, select);
  if (!items.length) gameSel.disabled = true;
}
function fillFromDay(select) {
  gameLabel.textContent = 'Pitcher that day';
  const items = state.dayList.map(p => {
    const where = (p.home ? 'vs ' : '@ ') + p.opp;
    return [`${p.id}|${p.gamePk}|${state.date}`, `${p.name} · ${p.team} ${where} · ${p.pitches} P${p.start ? ', SP' : ''}`];
  });
  fill(gameSel, items, select);
}
async function loadLog() {
  const p = state.pitcher, season = seasonSel.value;
  if (!p) return;
  status.textContent = 'Loading game log…';
  try { state.log = await data.gameLog(p.id, season); }
  catch (e) { state.log = []; }
  if (state.pitcher !== p || seasonSel.value !== season) return;
  setStatus();
  const want = state.date ? state.log.find(g => g.date === state.date) : null;
  const first = state.log.find(g => availability(g.date) !== 'future');
  fillFromLog(want ? `${p.id}|${want.gamePk}|${want.date}` : first ? `${p.id}|${first.gamePk}|${first.date}` : undefined);
  if (!state.log.length) {
    // nothing this season and no date asked for: fall back to their latest season that has games
    const opts = [...seasonSel.options].map(o => o.value);
    const next = opts[opts.indexOf(season) + 1];
    if (!state.date && next) { seasonSel.value = next; loadLog(); return; }
    showEmpty(`${p.name} has no MLB appearances in ${season}.`);
    return;
  }
  if (state.date && !want) {
    // both chosen, but the log doesn't show that date — try the day anyway (the log can lag)
    draw(state.date, p.id, null);
    return;
  }
  onGame();
}
async function loadDay() {
  const date = state.date;
  if (!date) return;
  status.textContent = 'Loading ' + niceDate(date, true) + '…';
  empty.textContent = 'Loading…'; empty.hidden = false;
  let rows = [];
  try { rows = await data.rowsFor(date); } catch (e) { rows = []; }
  if (state.date !== date || state.pitcher) return;
  setStatus();
  state.dayList = data.pitchersOn(rows);
  fillFromDay();
  if (!state.dayList.length) {
    showEmpty(availability(date) === 'future' ? 'That date hasn\'t happened yet.'
      : data.isSettled(date) ? `No tracked MLB games on ${niceDate(date, true)}.`
      : `No games from ${niceDate(date, true)} in the live feed yet; the data files reach ${niceDate(data.lastFinalized(), true)}.`);
    return;
  }
  onGame();
}
function onGame() {
  const v = gameSel.value;
  if (!v) { showEmpty('Nothing to show.'); return; }
  const [pid, pk, date] = v.split('|');
  draw(date, +pid, +pk);
}

// ---- pitcher search ----------------------------------------------------------------
let searchTimer = null, searchSeq = 0, hitList = [], hitIdx = -1;
function renderHits(list, msg) {
  hitList = list; hitIdx = -1;
  hits.innerHTML = '';
  if (msg) { const d = document.createElement('div'); d.className = 'none'; d.textContent = msg; hits.appendChild(d); }
  list.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${p.name}<span>${p.active ? 'active' : 'inactive'}</span>`;
    b.addEventListener('mousedown', ev => { ev.preventDefault(); choosePitcher(p); });
    hits.appendChild(b);
  });
  hits.hidden = !list.length && !msg;
}
function search() {
  const text = q.value.trim();
  if (text.length < 2) { renderHits([]); return; }
  const seq = ++searchSeq;
  data.searchPitchers(text).then(list => {
    if (seq !== searchSeq) return;
    renderHits(list.slice(0, 12), list.length ? null : 'No pitchers match.');
  }).catch(() => renderHits([], 'Search failed.'));
}
function choosePitcher(p) {
  state.pitcher = { id: p.id, name: p.name };
  q.value = p.name;
  renderHits([]);
  // a newly chosen pitcher opens on their most recent appearance, whatever date was showing
  state.date = null; dateIn.value = '';
  loadLog();
}
q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (state.pitcher && q.value.trim() !== state.pitcher.name) state.pitcher = null;
  searchTimer = setTimeout(search, 250);
});
q.addEventListener('focus', () => { if (hitList.length) hits.hidden = false; });
q.addEventListener('blur', () => { setTimeout(() => { hits.hidden = true; }, 150); });
q.addEventListener('keydown', ev => {
  if (hits.hidden || !hitList.length) { if (ev.key === 'Enter') { clearTimeout(searchTimer); search(); } return; }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    hitIdx = (hitIdx + (ev.key === 'ArrowDown' ? 1 : -1) + hitList.length) % hitList.length;
    [...hits.querySelectorAll('button')].forEach((b, i) => b.classList.toggle('active', i === hitIdx));
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    choosePitcher(hitList[hitIdx < 0 ? 0 : hitIdx]);
  } else if (ev.key === 'Escape') { hits.hidden = true; }
});

// ---- the other controls ------------------------------------------------------------
seasonSel.addEventListener('change', () => {
  if (state.date && state.date.slice(0, 4) !== seasonSel.value) { state.date = null; dateIn.value = ''; }
  if (state.pitcher) loadLog();
});
dateIn.addEventListener('change', () => {
  state.date = dateIn.value || null;
  if (!state.date) { if (state.pitcher) loadLog(); else showEmpty('Search a pitcher, or pick a game date.'); return; }
  if (state.date.slice(0, 4) !== seasonSel.value && [...seasonSel.options].some(o => o.value === state.date.slice(0, 4))) {
    seasonSel.value = state.date.slice(0, 4);
  }
  if (state.pitcher) loadLog(); else loadDay();
});
gameSel.addEventListener('change', onGame);
png.addEventListener('click', async () => {
  if (!state.meta) return;
  png.disabled = true;
  try { await sankey.savePng(state.meta); } catch (e) { console.error(e); }
  png.disabled = false;
});
reset.addEventListener('click', () => {
  state.pitcher = null; state.date = null; state.log = []; state.dayList = [];
  q.value = ''; dateIn.value = ''; fill(gameSel, []); gameLabel.textContent = 'Game';
  renderHits([]);
  history.replaceState(null, '', location.pathname);
  showEmpty('Search a pitcher, or pick a game date.');
});

function setStatus() {
  const last = data.lastFinalized();
  status.textContent = 'MLB · data files through ' + (last ? niceDate(last, true) : '?') + ' · live feed after';
}

// With nothing asked for, land on the most recent day that has finished games and show its
// longest outing: today's or yesterday's finished games from the live feed if there are any,
// else the last settled day in the data files.
function prevDay(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function defaultGame() {
  const last = data.lastFinalized();
  if (!last) return false;
  for (let d = today(), tries = 0; d >= last && tries < 10; d = prevDay(d), tries++) {
    status.textContent = 'Loading ' + niceDate(d, true) + '…';
    let rows = [];
    try { rows = await data.rowsFor(d); } catch (e) { rows = []; }
    if (state.pitcher || state.date) return true;      // the user got there first
    const finished = rows.filter(r => !r.live || r.status === 'Final' || r.status === 'Game Over');
    const list = data.pitchersOn(finished);              // sorted by pitch count, most first
    if (!list.length) continue;
    state.date = d; dateIn.value = d;
    if ([...seasonSel.options].some(o => o.value === d.slice(0, 4))) seasonSel.value = d.slice(0, 4);
    state.dayList = list;
    fillFromDay(`${list[0].id}|${list[0].gamePk}|${d}`);
    setStatus();
    onGame();
    return true;
  }
  return false;
}

// a #pitcherId-YYYY-MM-DD in the URL selects that flow directly
async function fromHash() {
  const m = /^#(\d+)-(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
  if (!m) return false;
  const id = +m[1], date = m[2];
  let p = null;
  try { p = await data.person(id); } catch (e) { p = null; }
  if (!p) return false;
  state.pitcher = p; q.value = p.name;
  state.date = date; dateIn.value = date;
  if ([...seasonSel.options].some(o => o.value === date.slice(0, 4))) seasonSel.value = date.slice(0, 4);
  loadLog();
  return true;
}
window.addEventListener('hashchange', fromHash);

// ---- boot ---------------------------------------------------------------------------
(async function boot() {
  try {
    await data.loadManifest();
  } catch (e) {
    status.textContent = 'Could not load the data manifest';
    showEmpty('The data files at data.blandalytics.com are not reachable right now.');
    return;
  }
  const first = data.firstDate() || '2020-01-01', now = today();
  const y0 = +first.slice(0, 4), y1 = +now.slice(0, 4);
  const years = []; for (let y = y1; y >= y0; y--) years.push([String(y), String(y)]);
  fill(seasonSel, years, String(y1));
  dateIn.min = first; dateIn.max = now;
  q.disabled = false; dateIn.disabled = false;
  setStatus();
  if (!(await fromHash()) && !(await defaultGame())) showEmpty('Search a pitcher, or pick a game date.');
})();
