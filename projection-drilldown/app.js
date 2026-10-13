// Projection Drilldown: one player's projection, stat by stat, as a waterfall from a league-average
// player to his line (the factor ledger of the projections repository: src/ledger.py, exported by
// src/site_export.py). Rates are exact Shapley values over the factors; counting stats and $ come
// from simulations with each factor removed, and a last row holds the factors' interaction.

import { CAUSES, esc, fmtDelta, fmtValue, link, load } from './data.js?v=1';

const $ = (s) => document.querySelector(s);
const C = { gold: '#F1C647', teal: '#00D4FF', base: '#5A6380', grid: '#3A3E5A', ink: '#E3E9F1', muted: '#8A96A6', conn: '#B4BECC', accent: '#6CB4FF' };
const state = { entry: null, player: null, stat: null, basis: 'ev', open: false };
let META;
let INDEX;

// short names for the chart (the table and the tooltips carry the full ones)
const SHORT = {
  detail: 'Sim details (IBB, SF, chance)',
  residual: 'Interaction of the factors',
  talent: 'Talent',
  regression: 'Pull toward the average',
  environment: 'League environment',
  list: 'Lists',
  pt: 'Playing time',
  other: 'Other factors',
  usage: 'Usage when active',
  calibration: 'Playing-time calibration',
};
const label = (f) => META.factors[f]?.label ?? CAUSES[f]?.[0] ?? SHORT[f] ?? f;
const short = (f) => SHORT[f] ?? CAUSES[f]?.[0] ?? label(f);

init().catch((e) => {
  $('#player').innerHTML = `<p class="err">The projection data did not load (${esc(e.message)}).</p>`;
});

async function init() {
  [META, INDEX] = await Promise.all([load('meta.json'), load('index.json')]);
  const q = new URLSearchParams(location.search);
  state.basis = q.get('b') === 'healthy' ? 'healthy' : 'ev';
  state.stat = q.get('s');
  $('#to-risk').href = link('../playing-time-risk/');
  $('#to-promo').href = link('../promotion-timelines/');
  setupSearch();
  let resize;
  window.addEventListener('resize', () => {
    clearTimeout(resize);
    resize = setTimeout(() => state.player && renderWaterfall(), 120);
  });
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      state.basis = b.dataset.b;
      render();
    });
  }
  const want = q.get('p');
  await select(INDEX.find((x) => `${x.r}:${x.id}` === want) ?? INDEX[0]);
}

async function select(entry) {
  state.entry = entry;
  state.open = false;
  const team = await load(`team/${entry.t}.json`);
  state.player = team[`${entry.r}:${entry.id}`];
  const keys = META.stats[entry.r].map((s) => s.key);
  if (!keys.includes(state.stat)) state.stat = '$';
  render();
}

function statInfo() {
  return META.stats[state.entry.r].find((s) => s.key === state.stat);
}

function render() {
  const { entry, player } = state;
  if (!player) {
    $('#player').innerHTML = `<p class="err">No ledger for ${esc(entry.n)}.</p>`;
    return;
  }
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.b === state.basis));
  renderPlayer();
  renderTabs();
  renderWaterfall();
  renderBand();
  renderNotes();
  const q = new URLSearchParams(location.search);
  q.set('p', `${entry.r}:${entry.id}`);
  q.set('s', state.stat);
  q.set('b', state.basis);
  history.replaceState(null, '', `?${q}`);
  const m = META;
  const chk = m.check?.[entry.r === 'h' ? 'hitting' : 'pitching'];
  $('#foot').innerHTML =
    `Projections for ${m.season}, data of ${esc(m.generated.replace('T', ' '))}` +
    (m.tag ? ` (test runs ${esc(m.runs.hitting)} / ${esc(m.runs.pitching)})` : '') +
    `. Rates: exact Shapley values over the factors. Counting stats and $: simulations with each factor removed` +
    (chk ? `; the interaction row averages ${(100 * chk.residual_share_max).toFixed(1)}% of the change at most` : '') +
    `. $: the Auction Calculator's values (12 teams, 5x5), ${state.basis === 'ev' ? 'expected' : 'healthy-season'} playing time.`;
}

function renderPlayer() {
  const { entry, player, basis } = state;
  const stats = META.stats[entry.r];
  const pick = entry.r === 'h' ? ['$', 'PA', 'HR', 'R', 'RBI', 'SB', 'AVG'] : ['$', 'IP', 'K', 'W', 'SV', 'ERA', 'WHIP'];
  const kpis = pick
    .map((k) => {
      const s = stats.find((x) => x.key === k);
      const e = player.s[k]?.[basis];
      return e ? `<div class="kpi"><b>${fmtValue(e.v, s.kind, s.kind === 'pt' ? 0 : s.dp)}</b><span>${esc(k)}</span></div>` : '';
    })
    .join('');
  const sub = [entry.t === 'FA' ? 'Free agent' : entry.t, entry.pos, entry.age ? `age ${Math.floor(entry.age)}` : null]
    .filter(Boolean)
    .join(' · ');
  $('#player').innerHTML = `<div class="who"><div><h2>${esc(entry.n)}</h2><div class="sub">${esc(sub)} · ${
    entry.r === 'h' ? 'hitter' : 'pitcher'
  }</div></div><div class="kpis">${kpis}</div></div>`;
}

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = META.stats[state.entry.r]
    .filter((s) => state.player.s[s.key])
    .map((s) => `<button type="button" role="tab" data-s="${esc(s.key)}" aria-selected="${s.key === state.stat}" title="${esc(s.label)}">${esc(s.key)}</button>`)
    .join('');
  for (const b of el.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      state.stat = b.dataset.s;
      state.open = false;
      render();
    });
  }
}

// the waterfall's rows: the baseline, the factors (the playing-time causes inside one row; small
// factors folded into "Other"), the projection
function model() {
  const { player, stat, basis } = state;
  const e = player.s[stat]?.[basis];
  if (!e) return null;
  const s = statInfo();
  const [bk, base] = e.w[0];
  let items = e.w.slice(1).map(([f, d]) => ({ f, d }));
  const ptRow = items.find((x) => x.f === 'pt');
  const pt = player.pt?.[basis];
  if (ptRow && pt) {
    const causes = pt.w.slice(1).filter(([, a]) => a);
    const tot = causes.reduce((t, [, a]) => t + a, 0);
    ptRow.children = tot ? causes.map(([c, a]) => ({ f: c, d: (ptRow.d * a) / tot })) : [];
  }
  if (s.kind !== 'pt') {
    const big = Math.max(1e-12, ...items.map((x) => Math.abs(x.d)));
    const small = items.filter((x) => !x.children && Math.abs(x.d) < 0.025 * big);
    if (small.length >= 2) {
      items = items.filter((x) => !small.includes(x));
      items.push({ f: 'other', d: small.reduce((t, x) => t + x.d, 0), members: small });
    }
  }
  return { bk, base, items, value: e.v, s };
}

function baseLabel(bk, kind) {
  if (bk === 'capacity') return 'A full season (capacity)';
  return kind === 'rate' || kind === 'pct' ? 'League average' : 'League-average player, full season';
}

function renderWaterfall() {
  const m = model();
  const s = statInfo();
  $('#wf-title').textContent = `${s.label}: from the league average to the projection`;
  if (!m) {
    $('#wf').innerHTML = '<p class="foot">No ledger for this stat.</p>';
    $('#wf-table').innerHTML = '';
    return;
  }
  const dp = s.kind === 'pt' ? 0 : s.dp;
  // visible rows
  const rows = [];
  let cur = m.base;
  for (const it of m.items) {
    if (it.children && state.open) {
      rows.push({ f: it.f, head: true, d: it.d, toggle: true });
      for (const c of it.children) rows.push({ f: c.f, d: c.d, before: cur, after: (cur += c.d), child: true });
    } else {
      rows.push({ f: it.f, d: it.d, before: cur, after: (cur += it.d), toggle: Boolean(it.children), members: it.members });
    }
  }
  // drawn at the container's own width, so the text keeps its size (redrawn on a resize)
  const W = Math.max(320, Math.round($('#wf').clientWidth || 640));
  const LW = Math.round(Math.min(230, W * 0.36));
  const VW = 74;
  const RH = 28;
  const top = 8;
  const n = rows.length + 2;
  const H = top * 2 + RH * n;
  const signed = s.kind === 'rate' || s.kind === 'pct';
  const vals = [m.base, m.value, ...rows.filter((r) => !r.head).flatMap((r) => [r.before, r.after])];
  if (!signed) vals.push(0);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.04;
  lo -= signed ? pad : lo < 0 ? pad : 0;
  hi += pad;
  const x = (v) => LW + ((v - lo) / (hi - lo)) * (W - LW - VW);
  const origin = signed ? lo : 0;
  const parts = [`<svg class="wf" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.label)} waterfall" font-family="DM Sans, system-ui, sans-serif">`];
  // the zero line
  if (!signed && lo < 0) parts.push(`<line x1="${x(0)}" x2="${x(0)}" y1="${top}" y2="${H - top}" stroke="${C.grid}" />`);
  const text = (tx, ty, str, attrs = '') => `<text x="${tx}" y="${ty}" ${attrs}>${esc(str)}</text>`;
  const bar = (a, b, y, fill, extra = '') => {
    const [l, r] = a < b ? [a, b] : [b, a];
    return `<rect x="${x(l).toFixed(1)}" y="${y + 5}" width="${Math.max(1.5, x(r) - x(l)).toFixed(1)}" height="${RH - 10}" rx="3" fill="${fill}" ${extra}/>`;
  };
  let y = top;
  // the baseline
  parts.push(`<g><title>${esc(baseLabel(m.bk, s.kind))}</title>`);
  parts.push(text(8, y + RH / 2 + 4, m.bk === 'capacity' ? 'A full season' : 'League average', `font-size="13" fill="${C.ink}"`));
  parts.push('</g>');
  parts.push(bar(origin, m.base, y, C.base));
  parts.push(text(W - 6, y + RH / 2 + 4, fmtValue(m.base, s.kind, dp), `font-size="12.5" fill="${C.muted}" text-anchor="end" font-family="JetBrains Mono, monospace"`));
  let prevEnd = m.base;
  y += RH;
  for (const r of rows) {
    const name = (r.child ? '   ' : '') + (r.toggle ? (state.open ? '▾ ' : '▸ ') : '') + short(r.f);
    const tip = r.members ? r.members.map((mm) => `${label(mm.f)} ${fmtDelta(mm.d, s.kind, dp)}`).join('; ') : label(r.f);
    const g = r.toggle ? ' class="toggle" data-toggle="1"' : '';
    parts.push(`<g${g}><title>${esc(tip)}</title>`);
    parts.push(text(r.child ? 18 : 8, y + RH / 2 + 4, name, `font-size="13" fill="${r.child ? C.muted : C.ink}"`));
    if (!r.head) {
      parts.push(`<line x1="${x(prevEnd).toFixed(1)}" x2="${x(prevEnd).toFixed(1)}" y1="${y - RH + 5}" y2="${y + 5}" stroke="${C.conn}" stroke-opacity="0.45" stroke-dasharray="2 2"/>`);
      parts.push(bar(r.before, r.after, y, r.d >= 0 ? C.gold : C.teal));
      prevEnd = r.after;
    }
    parts.push(text(W - 6, y + RH / 2 + 4, fmtDelta(r.d, s.kind, dp), `font-size="12.5" fill="${r.d >= 0 ? C.gold : C.teal}" text-anchor="end" font-family="JetBrains Mono, monospace"`));
    parts.push('</g>');
    y += RH;
  }
  // the projection
  parts.push(text(8, y + RH / 2 + 4, 'Projection', `font-size="13" font-weight="700" fill="${C.ink}"`));
  parts.push(`<line x1="${x(prevEnd).toFixed(1)}" x2="${x(prevEnd).toFixed(1)}" y1="${y - RH + 5}" y2="${y + 5}" stroke="${C.conn}" stroke-opacity="0.45" stroke-dasharray="2 2"/>`);
  parts.push(bar(origin, m.value, y, 'none', `stroke="${C.accent}" stroke-width="1.5" stroke-dasharray="4 3"`));
  parts.push(text(W - 6, y + RH / 2 + 4, fmtValue(m.value, s.kind, dp), `font-size="13" font-weight="700" fill="${C.ink}" text-anchor="end" font-family="JetBrains Mono, monospace"`));
  parts.push('</svg>');
  $('#wf').innerHTML = parts.join('');
  for (const g of $('#wf').querySelectorAll('[data-toggle]')) {
    g.addEventListener('click', () => {
      state.open = !state.open;
      renderWaterfall();
    });
  }
  // the table: every row, with the folded ones
  const flat = [];
  let run = m.base;
  for (const it of m.items) {
    for (const r of it.children ?? it.members ?? [it]) flat.push([label(r.f), r.d, (run += r.d)]);
  }
  $('#wf-table').innerHTML =
    `<table><thead><tr><th>Factor</th><th class="n">Change</th><th class="n">Running</th></tr></thead><tbody>` +
    `<tr><td>${esc(baseLabel(m.bk, s.kind))}</td><td class="n"></td><td class="n">${fmtValue(m.base, s.kind, dp)}</td></tr>` +
    flat.map(([l, d, r]) => `<tr><td>${esc(l)}</td><td class="n">${fmtDelta(d, s.kind, dp)}</td><td class="n">${fmtValue(r, s.kind, dp)}</td></tr>`).join('') +
    `<tr><td><b>Projection</b></td><td class="n"></td><td class="n"><b>${fmtValue(m.value, s.kind, dp)}</b></td></tr></tbody></table>`;
}

function renderBand() {
  const { player, stat, basis } = state;
  const el = $('#band');
  const s = statInfo();
  const e = player.b?.[stat]?.[basis];
  if (!e) {
    const have = Object.keys(player.b ?? {}).join(', ');
    el.innerHTML = `<h3>The range</h3><p class="foot">The 10th–90th percentile range is in the data for ${esc(have || 'no stat')} of this player.</p>`;
    return;
  }
  const [p10, p50, p90, t, ptShare, l] = e;
  const v = player.s[stat]?.[basis]?.v;
  const dp = s.kind === 'money' ? 1 : 1;
  let lo = Math.min(p10, v ?? p10);
  let hi = Math.max(p90, v ?? p90);
  const pad = (hi - lo || 1) * 0.12;
  lo -= pad;
  hi += pad;
  const pos = (z) => `${(100 * (z - lo)) / (hi - lo)}%`;
  let html =
    `<h3>The range: 10th to 90th percentile</h3>` +
    `<div class="track"><div class="line"></div><div class="range" style="left:${pos(p10)};width:calc(${pos(p90)} - ${pos(p10)})"></div>` +
    `<div class="tick" style="left:${pos(p50)}" title="median"></div></div>` +
    `<div class="scale"><span>${fmtValue(p10, s.kind, dp)}</span><span>median ${fmtValue(p50, s.kind, dp)}</span><span>${fmtValue(p90, s.kind, dp)}</span></div>`;
  if (t != null) {
    const cols = [
      ['Talent', t, '#F1C647'],
      ['Playing time', ptShare, '#FF8A80'],
      ['Season luck', l, '#8A96A6'],
    ];
    html +=
      `<h3 style="margin-top:14px">Why the range is this wide</h3><div class="shares">` +
      cols.map(([, w, c]) => `<div style="width:${(100 * (w ?? 0)).toFixed(1)}%;background:${c}"></div>`).join('') +
      `</div><div class="legend">` +
      cols.map(([n, w, c]) => `<span><i style="background:${c}"></i>${n} ${Math.round(100 * (w ?? 0))}%</span>`).join('') +
      `</div>`;
  } else if (stat === '$') {
    html += `<p class="foot">Each simulated season priced in the calculator's frame.</p>`;
  }
  el.innerHTML = html;
}

// the plain sentences of the largest effects (the ledger's templates)
function renderNotes() {
  const m = model();
  const s = statInfo();
  if (!m) {
    $('#notes').innerHTML = '';
    return;
  }
  const dp = s.kind === 'pt' ? 0 : s.dp;
  const rows = m.items.flatMap((it) => it.children ?? it.members ?? [it]).filter((r) => META.factors[r.f]?.note && Math.abs(r.d) > 0);
  rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const opp = state.entry.r === 'h' ? 'pitchers' : 'batters';
  const statWord = s.kind === 'money' ? 'in auction value' : s.kind === 'pct' ? `of ${s.key}` : s.key;
  const fmtD = (d) => (s.kind === 'pct' ? fmtDelta(d, s.kind, dp).replace(' pts', ' points') : fmtDelta(d, s.kind, dp));
  $('#notes').innerHTML = rows
    .slice(0, 5)
    .map((r) => {
      const t = META.factors[r.f].note.replace('{d}', fmtD(r.d)).replace('{stat}', statWord).replace('{opp}', opp);
      return `<li>${esc(t.replace(/\s+\./g, '.'))}</li>`;
    })
    .join('');
}

function setupSearch() {
  const input = $('#q');
  const list = $('#hits');
  let hits = [];
  let sel = 0;
  const show = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      list.hidden = true;
      return;
    }
    const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    hits = INDEX.filter((x) => norm(x.n).includes(norm(q))).slice(0, 12);
    sel = 0;
    list.innerHTML = hits
      .map(
        (x, i) =>
          `<li role="option" data-i="${i}" aria-selected="${i === sel}"><span>${esc(x.n)}</span><small>${esc(x.t)} · ${
            x.r === 'h' ? 'H' : 'P'
          } · ${fmtValue(x.v.ev, 'money', 1)}</small></li>`,
      )
      .join('');
    list.hidden = !hits.length;
  };
  const choose = (i) => {
    if (!hits[i]) return;
    list.hidden = true;
    input.value = '';
    select(hits[i]);
  };
  input.addEventListener('input', show);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      sel = (sel + (ev.key === 'ArrowDown' ? 1 : hits.length - 1)) % Math.max(hits.length, 1);
      for (const li of list.children) li.setAttribute('aria-selected', String(Number(li.dataset.i) === sel));
      ev.preventDefault();
    } else if (ev.key === 'Enter') {
      choose(sel);
    } else if (ev.key === 'Escape') {
      list.hidden = true;
    }
  });
  list.addEventListener('mousedown', (ev) => {
    const li = ev.target.closest('li');
    if (li) choose(Number(li.dataset.i));
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));
}
