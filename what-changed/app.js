// What Changed: each day's change to the rest-of-season projections (the projections repository's
// src/change.py), player by player: the auction value before and after, and the change split by cause.
// change/index.json lists the dates; change/<date>.json holds one day (src/site_export.change_json).

import { esc, fmtDelta, fmtValue, link, load } from '../projection-drilldown/data.js?v=1';

const $ = (s) => document.querySelector(s);
const q0 = new URLSearchParams(location.search);
const state = { r: q0.get('r') === 'p' ? 'p' : 'h', b: q0.get('b') === 'hb' ? 'hb' : 'ev', mat: true, low: false, q: '', team: '', pos: '',
  sort: 'abs', dir: -1, shown: 80, open: new Set() }; // prettier-ignore
// the causes, in the order of src/change.CAUSES, with their colours
const COLOR = {
  schedule: '#5C6B80',
  performance: '#F1C647',
  park: '#7BD88F',
  environment: '#6CB4FF',
  role: '#FF8A80',
  interaction: '#B4BECC',
};
const STAT_FMT = { AVG: ['rate', 3], OBP: ['rate', 3], ERA: ['rate', 2], WHIP: ['rate', 2], $: ['money', 2] };
let D;
let INDEX;

init().catch((e) => {
  $('#t').innerHTML = `<tr><td class="foot">The data did not load (${esc(e.message)}).</td></tr>`;
});

async function init() {
  INDEX = await load('change/index.json');
  const date = INDEX.dates.includes(q0.get('date')) ? q0.get('date') : INDEX.latest;
  $('#date').innerHTML = INDEX.dates.map((d) => `<option${d === date ? ' selected' : ''}>${esc(d)}</option>`).join('');
  $('#date').addEventListener('change', (e) => show(e.target.value));
  $('#to-dd').href = link('../projection-drilldown/');
  $('#to-risk').href = link('../playing-time-risk/');
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      if (b.dataset.r) state.r = b.dataset.r;
      if (b.dataset.b) state.b = b.dataset.b;
      state.shown = 80;
      render();
    });
  }
  $('#q').addEventListener('input', (e) => ((state.q = e.target.value.trim()), render()));
  $('#pos').addEventListener('input', (e) => ((state.pos = e.target.value.trim().toUpperCase()), render()));
  $('#team').addEventListener('change', (e) => ((state.team = e.target.value), render()));
  $('#mat').addEventListener('change', (e) => ((state.mat = e.target.checked), render()));
  $('#low').addEventListener('change', (e) => ((state.low = e.target.checked), render()));
  $('#more').addEventListener('click', () => ((state.shown += 80), render()));
  await show(date);
}

async function show(date) {
  D = await load(`change/${date}.json`);
  state.open.clear();
  $('#sub').textContent =
    `The rest-of-season projections of ${date} against ${D.base}: how much each player's auction value moved, and why. ` +
    `Select a row for the stats and the reasons in words.`;
  const b = $('#banner');
  b.hidden = !D.model_update;
  b.textContent = D.model_update ? `The model changed between ${D.base} and ${date}: part of each change is the model update.` : '';
  const q = new URLSearchParams(location.search);
  q.set('date', date);
  history.replaceState(null, '', `?${q}`);
  render();
}

const norm = (t) => (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const money = (v) => fmtValue(v, 'money', 1);

function bar(parts, scale) {
  // a diverging bar: the negative causes stack left of the centre, the positive ones right
  let neg = 50;
  let pos = 50;
  const segs = [];
  for (const [c, v] of Object.entries(parts)) {
    const w = Math.min(50, (50 * Math.abs(v)) / scale);
    if (w < 0.2) continue;
    const left = v < 0 ? (neg -= w) : pos;
    if (v >= 0) pos += w;
    segs.push(`<i title="${esc(D.causes[c] ?? c)}: ${fmtDelta(v, 'money', 2)}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%;background:${COLOR[c] ?? '#999'}"></i>`);
  }
  return `<div class="div">${segs.join('')}<b></b></div>`;
}

function detail(x) {
  const stats = Object.keys(x.s);
  const causes = Object.keys(D.causes).filter((c) => stats.some((s) => x.s[s][c] != null));
  const head = `<tr><th>Stat</th>${causes.map((c) => `<th>${esc(D.causes[c])}</th>`).join('')}</tr>`;
  const body = stats
    .map((s) => {
      const [kind, dp] = STAT_FMT[s] ?? ['count', 1];
      return `<tr><td>${esc(s)}</td>${causes.map((c) => `<td class="n">${x.s[s][c] != null ? fmtDelta(x.s[s][c], kind, dp) : ''}</td>`).join('')}</tr>`;
    })
    .join('');
  return (
    `<p class="txt">${esc(x.txt)}</p>` +
    (stats.length ? `<table class="stats">${head}${body}</table>` : '') +
    `<p class="sub">The stats on the expected-value basis.</p>`
  );
}

function render() {
  const { r, b } = state;
  for (const btn of document.querySelectorAll('.seg button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.r ? btn.dataset.r === r : btn.dataset.b === b));
  }
  const all = (D.rows[r] ?? []).filter((x) => x[b]);
  const sel = $('#team');
  const key = `${r}:${D.date}`;
  if (sel.dataset.k !== key) {
    const teams = [...new Set(all.map((x) => x.t))].sort();
    sel.innerHTML = `<option value="">All teams</option>` + teams.map((t) => `<option>${esc(t)}</option>`).join('');
    sel.dataset.k = key;
    state.team = '';
  }
  $('#legend').innerHTML = Object.entries(D.causes)
    .map(([c, l]) => `<span><i style="background:${COLOR[c] ?? '#999'}"></i>${esc(l)}</span>`)
    .join('');
  let rows = all;
  if (state.mat) rows = rows.filter((x) => x[b][3] === 1);
  // players worth under $1 before and after (below replacement) only on request
  if (!state.low) rows = rows.filter((x) => Math.max(x[b][0] ?? -1e9, x[b][1] ?? -1e9) >= 1);
  if (state.q) rows = rows.filter((x) => norm(x.n).includes(norm(state.q)));
  if (state.team) rows = rows.filter((x) => x.t === state.team);
  if (state.pos) rows = rows.filter((x) => (x.pos ?? '').toUpperCase().split(/[,/ ]+/).includes(state.pos));
  const val = (x) => {
    const v = x[b];
    if (state.sort === 'abs') return Math.abs(v[5] ?? v[2] ?? 0);
    if (state.sort === 'n') return x.n;
    return { before: v[0], after: v[1], change: v[2], news: v[5] }[state.sort] ?? 0;
  };
  rows = [...rows].sort((p, q) => {
    const [x, y] = [val(p), val(q)];
    return typeof x === 'string' ? state.dir * x.localeCompare(y) : state.dir * ((x ?? -1e9) - (y ?? -1e9));
  });
  const shown = rows.slice(0, state.shown);
  const scale = Math.max(0.5, ...shown.map((x) => Object.values(x[b][4]).reduce((s, v) => s + Math.abs(v), 0)));
  const th = (c, l) => `<th data-c="${c}" aria-sort="${state.sort === c ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(l)}</th>`;
  const head =
    `<thead><tr>${th('n', 'Player')}${th('before', '$ before')}${th('after', '$ after')}${th('change', 'Change')}` +
    `${th('news', 'News')}${th('abs', 'By cause')}</tr></thead>`;
  const body = shown
    .map((x) => {
      const [before, after, ch, , parts, news] = x[b];
      const cls = ch > 0 ? 'up' : ch < 0 ? 'down' : '';
      const ncls = news > 0 ? 'up' : news < 0 ? 'down' : '';
      const open = state.open.has(x.id);
      return (
        `<tr class="row" data-id="${esc(x.id)}" aria-expanded="${open}"><td>${esc(x.n)}<div class="sub">${esc(x.t)} · ${esc(x.pos ?? '')}</div></td>` +
        `<td class="n">${money(before)}</td><td class="n">${money(after)}</td><td class="n ${cls}">${fmtDelta(ch, 'money', 2)}</td>` +
        `<td class="n ${ncls}">${fmtDelta(news ?? ch, 'money', 2)}</td>` +
        `<td>${bar(parts, scale)}</td></tr>` +
        (open ? `<tr class="detail"><td colspan="6">${detail(x)}</td></tr>` : '')
      );
    })
    .join('');
  $('#t').innerHTML = head + `<tbody>${body}</tbody>`;
  for (const h of $('#t').querySelectorAll('th[data-c]')) {
    h.addEventListener('click', () => {
      const c = h.dataset.c;
      state.dir = state.sort === c ? -state.dir : c === 'n' ? 1 : -1;
      state.sort = c;
      render();
    });
  }
  for (const tr of $('#t').querySelectorAll('tr.row')) {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      if (state.open.has(id)) state.open.delete(id);
      else state.open.add(id);
      render();
    });
  }
  $('#more').hidden = rows.length <= state.shown;
  const nMat = all.filter((x) => x[b][3] === 1).length;
  $('#foot').innerHTML =
    `${rows.length.toLocaleString()} of ${all.length.toLocaleString()} ${r === 'h' ? 'hitters' : 'pitchers'} with a change of $0.05 or more; ` +
    `${nMat.toLocaleString()} material. ` +
    (D.floor
      ? 'A change is material when it is larger than the change the model makes on a day with no new data (the 95th percentile of a placebo refit, by $ tier). '
      : 'No noise floor is measured yet: every change counts as material. ') +
    `$ is the rest-of-season auction value in each day's calculator frame (${b === 'ev' ? 'expected playing time' : 'a healthy season'}). ` +
    `News: the change without the days played (every rest-of-season line shrinks as the season goes on); the material flag and the order use it. ` +
    `"Days played and the league frame": the earlier projection carried to this date, against itself. ` +
    `The schedule left: ${(100 * D.frac.base).toFixed(1)}% on ${esc(D.base)}, ${(100 * D.frac.new).toFixed(1)}% on ${esc(D.date)}.`;
}
