// Promotion Timelines: the promotion model of the projections repository (src/model/promotion.py: a
// discrete-time hazard over seasons and windows, calibrated on the backtest), one row per prospect:
// P(first MLB day) in each of the next five seasons and later, and the first season by window.

import { esc, link, load } from '../projection-drilldown/data.js?v=1';

const $ = (s) => document.querySelector(s);
const state = { r: 'h', sort: 0, dir: -1, shown: 80, q: '', org: '' };
const YEAR_COLORS = ['#F1C647', '#E3A33D', '#C9823A', '#A66638', '#7E5236', '#5C4636'];
const WIN_COLORS = ['#6CB4FF', '#00D4FF', '#7BD88F', '#FFD166', '#FF8A80'];
let DATA;
let META;

init().catch((e) => {
  $('#t').innerHTML = `<tr><td class="foot">The data did not load (${esc(e.message)}).</td></tr>`;
});

async function init() {
  [DATA, META] = await Promise.all([load('promotion.json'), load('meta.json')]);
  $('#to-dd').href = link('../projection-drilldown/');
  $('#to-risk').href = link('../playing-time-risk/');
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      state.r = b.dataset.r;
      state.shown = 80;
      render();
    });
  }
  $('#q').addEventListener('input', (e) => ((state.q = e.target.value.trim()), render()));
  $('#org').addEventListener('change', (e) => ((state.org = e.target.value), render()));
  $('#more').addEventListener('click', () => ((state.shown += 80), render()));
  render();
}

const pct = (x) => (x == null ? '' : `${Math.round(100 * x)}%`);

function render() {
  const r = state.r;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.r === r));
  const ys = DATA.seasons;
  const wins = Object.values(META.windows);
  const all = DATA.rows[r] ?? [];
  const sel = $('#org');
  if (sel.dataset.r !== r) {
    const orgs = [...new Set(all.map((x) => x.org).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">All organizations</option>` + orgs.map((o) => `<option>${esc(o)}</option>`).join('');
    sel.dataset.r = r;
    state.org = '';
  }
  $('#legend').innerHTML =
    ys.map((y, i) => `<span><i style="background:${YEAR_COLORS[i]}"></i>${y}</span>`).join('') +
    `<span><i style="background:${YEAR_COLORS[ys.length]}"></i>later</span>` +
    `<span style="margin-left:12px">${ys[0]} windows:</span>` +
    wins.map((w, i) => `<span><i style="background:${WIN_COLORS[i]}"></i>${esc(w)}</span>`).join('');
  const norm = (t) => (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let rows = all;
  if (state.q) rows = rows.filter((x) => norm(x.n).includes(norm(state.q)));
  if (state.org) rows = rows.filter((x) => x.org === state.org);
  const key = (x) => {
    if (state.sort === 'n' || state.sort === 'org' || state.sort === 'lvl') return x[state.sort] ?? '';
    if (state.sort === 'age' || state.sort === 'fv') return x[state.sort] ?? -Infinity;
    if (state.sort === 'top') return x.top ?? Infinity;
    return x.p[state.sort] ?? 0; // a season's probability
  };
  rows = [...rows].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return typeof x === 'string' ? state.dir * x.localeCompare(y) : state.dir * (x - y);
  });
  const th = (k, l) => `<th data-k="${k}" aria-sort="${state.sort === k ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(l)}</th>`;
  const head =
    `<thead><tr>${th('n', 'Prospect')}${th('org', 'Org')}${th('age', 'Age')}${th('lvl', 'Level')}${th('fv', 'FV')}${th('top', 'Top 100')}` +
    `<th>40-man</th>${th(0, `By ${ys[0]}`)}<th>Arrival by season</th><th>${ys[0]} by window</th></tr></thead>`;
  const body = rows
    .slice(0, state.shown)
    .map((x) => {
      const seg = x.p
        .map((p, i) => (p > 0.005 ? `<div title="${i < ys.length ? ys[i] : 'later'}: ${pct(p)}" style="width:${(100 * p).toFixed(1)}%;background:${YEAR_COLORS[i]}"></div>` : ''))
        .join('');
      const w0 = x.w.reduce((s, v) => s + (v ?? 0), 0) || 1;
      const wseg = x.w
        .map((p, i) => (p > 0.005 ? `<div title="${esc(wins[i])}: ${pct(p)}" style="width:${((100 * p) / w0).toFixed(1)}%;background:${WIN_COLORS[i]}"></div>` : ''))
        .join('');
      return (
        `<tr><td>${esc(x.n ?? '')}</td><td>${esc(x.org ?? '')}</td><td class="n">${x.age != null ? Math.floor(x.age) : ''}</td>` +
        `<td>${esc(x.lvl ?? '')}</td><td class="n">${x.fv ?? ''}</td><td class="n">${x.top ?? ''}</td><td>${x.on40 ? 'yes' : ''}</td>` +
        `<td class="n">${pct(x.p[0])}</td><td><div class="bars">${seg}</div></td><td><div class="bars small">${x.p[0] > 0.02 ? wseg : ''}</div></td></tr>`
      );
    })
    .join('');
  $('#t').innerHTML = head + `<tbody>${body}</tbody>`;
  for (const h of $('#t').querySelectorAll('th[data-k]')) {
    h.addEventListener('click', () => {
      const k = /^\d+$/.test(h.dataset.k) ? Number(h.dataset.k) : h.dataset.k;
      state.dir = state.sort === k ? -state.dir : ['n', 'org', 'lvl', 'top'].includes(k) ? 1 : -1;
      state.sort = k;
      render();
    });
  }
  $('#more').hidden = rows.length <= state.shown;
  const asOf = all[0]?.as_of ?? '';
  $('#foot').innerHTML =
    `${rows.length.toLocaleString()} ${r === 'h' ? 'hitters' : 'pitchers'}, as of ${esc(asOf)}. The bar's gap to the right edge: no debut within five seasons. ` +
    `The window bar splits the ${ys[0]} chance. Rookie-eligible players, 34 or younger, not yet in the majors this season.`;
}
