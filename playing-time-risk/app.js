// Playing-Time Risk: the playing-time part of the factor ledger (src/ledger.py, the PT sticks of the
// missed-time component model), one row per player: PA or batters faced lost per cause against a full
// season (capacity), and the auction value of his playing time against a regular's (the calculator's
// full-time target for his role).

import { CAUSES, esc, fmtDelta, link, load } from '../projection-drilldown/data.js?v=1';

const $ = (s) => document.querySelector(s);
const state = { r: 'h', sort: 'usd', dir: 1, shown: 60, q: '', team: '', pos: '' };
let DATA;
let META;

const COLS = [
  ['n', 'Player'],
  ['t', 'Team'],
  ['pos', 'Pos'],
  ['age', 'Age'],
  ['pt', 'Expected'],
  ['healthy', 'Healthy'],
  ['cap', 'Capacity'],
  ['lost', 'Lost, by cause'],
  ['risk', 'Injury risk'],
  ['usd', '$ cost'],
];

init().catch((e) => {
  $('#t').innerHTML = `<tr><td class="foot">The data did not load (${esc(e.message)}).</td></tr>`;
});

async function init() {
  [DATA, META] = await Promise.all([load('pt_risk.json'), load('meta.json')]);
  $('#to-dd').href = link('../projection-drilldown/');
  $('#to-promo').href = link('../promotion-timelines/');
  const q = new URLSearchParams(location.search);
  if (q.get('r') === 'p') state.r = 'p';
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      state.r = b.dataset.r;
      state.shown = 60;
      render();
    });
  }
  $('#q').addEventListener('input', (e) => ((state.q = e.target.value.trim().toLowerCase()), render()));
  $('#pos').addEventListener('input', (e) => ((state.pos = e.target.value.trim().toUpperCase()), render()));
  $('#team').addEventListener('change', (e) => ((state.team = e.target.value), render()));
  $('#more').addEventListener('click', () => ((state.shown += 60), render()));
  render();
}

function causesOf(r) {
  return Object.keys(CAUSES).filter((c) => DATA.rows[r].some((x) => x[c] != null));
}

function render() {
  const r = state.r;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.r === r));
  const unit = DATA.unit[r];
  const causes = causesOf(r);
  // the team list of this role
  const teams = [...new Set(DATA.rows[r].map((x) => x.t))].sort();
  const sel = $('#team');
  if (sel.dataset.r !== r) {
    sel.innerHTML = `<option value="">All teams</option>` + teams.map((t) => `<option>${esc(t)}</option>`).join('');
    sel.dataset.r = r;
    state.team = '';
  }
  $('#legend').innerHTML = causes.map((c) => `<span><i style="background:${CAUSES[c][1]}"></i>${esc(CAUSES[c][0])}</span>`).join('');
  const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let rows = DATA.rows[r].map((x) => ({ ...x, lost: causes.reduce((s, c) => s + (x[c] ?? 0), 0) }));
  if (state.q) rows = rows.filter((x) => norm(x.n).includes(norm(state.q)));
  if (state.team) rows = rows.filter((x) => x.t === state.team);
  if (state.pos) rows = rows.filter((x) => (x.pos ?? '').toUpperCase().split(/[,/ ]+/).includes(state.pos));
  const k = state.sort;
  rows.sort((a, b) => {
    const [x, y] = [a[k], b[k]];
    if (typeof x === 'string' || typeof y === 'string') return state.dir * String(x ?? '').localeCompare(String(y ?? ''));
    return state.dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
  const maxCap = Math.max(...DATA.rows[r].map((x) => x.cap ?? 0), 1);
  const head = `<thead><tr>${COLS.map(([c, l]) => {
    const s = c === state.sort ? (state.dir > 0 ? 'ascending' : 'descending') : 'none';
    const lab = ['pt', 'healthy', 'cap'].includes(c) ? `${l} ${unit}` : l;
    return `<th data-c="${c}" aria-sort="${s}">${esc(lab)}</th>`;
  }).join('')}</tr></thead>`;
  const body = rows
    .slice(0, state.shown)
    .map((x) => {
      const segs = causes
        .filter((c) => x[c] > 0)
        .map((c) => `<div title="${esc(CAUSES[c][0])}: ${x[c].toFixed(0)} ${unit}" style="width:${((100 * x[c]) / maxCap).toFixed(2)}%;background:${CAUSES[c][1]}"></div>`)
        .join('');
      const href = link('../projection-drilldown/', { p: `${r}:${x.id}`, s: r === 'h' ? 'PA' : 'IP' });
      return (
        `<tr><td><a href="${href}">${esc(x.n)}</a></td><td>${esc(x.t)}</td><td>${esc(x.pos ?? '')}</td>` +
        `<td class="n">${x.age != null ? Math.floor(x.age) : ''}</td><td class="n">${x.pt ?? ''}</td><td class="n">${x.healthy ?? ''}</td>` +
        `<td class="n">${x.cap ?? ''}</td><td><div class="bars" title="${x.lost.toFixed(0)} ${unit} lost">${segs}</div></td>` +
        `<td class="n">${x.risk != null ? `${(100 * x.risk).toFixed(0)}%` : ''}</td><td class="n">${x.usd != null ? fmtDelta(x.usd, 'money', 1) : ''}</td></tr>`
      );
    })
    .join('');
  $('#t').innerHTML = head + `<tbody>${body}</tbody>`;
  for (const th of $('#t').querySelectorAll('th')) {
    th.addEventListener('click', () => {
      const c = th.dataset.c;
      state.dir = state.sort === c ? -state.dir : ['n', 't', 'pos', 'usd'].includes(c) ? 1 : -1;
      state.sort = c;
      render();
    });
  }
  $('#more').hidden = rows.length <= state.shown;
  $('#foot').innerHTML =
    `${rows.length.toLocaleString()} ${r === 'h' ? 'hitters' : 'pitchers'}. Expected: the projection's playing time with the injury risk; ` +
    `healthy: a healthy season in his role; capacity: a full season. Injury risk: 1 − expected / healthy. ` +
    `$ cost: the auction value of his expected playing time against a regular's, the calculator's full-time target for his role; ` +
    `below it, the calculator fills the missing time with replacement-level production. ` +
    `Data of ${esc(META.generated.replace('T', ' '))}${META.tag ? ' (test runs)' : ''}; the missed-time component model.`;
}
