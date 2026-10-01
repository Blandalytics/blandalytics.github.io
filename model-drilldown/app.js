// The page: season, pitcher, pitch type, model and target; data.js reads the bucket's SHAP
// tables, charts.js draws the three figures, and morph.js carries each figure from one input
// to the next. A view is linkable as #<season>-<pitcher id>-<pitch type>&model=&target=&row=.

import {
  loadMeta, loadFeatures, loadUnits, loadFidelity, cardRows, rowValue, minImpact, targetName, targetGood,
  outcomeRows, outcomeValue, outcomeInput, OUTCOME_AXIS,
  MODELS, OUTCOMES, TARGET_NAMES, PITCH_NAMES, LABELS,
} from './data.js?v=7';
import {
  flowSvg, phoneFlowSvg, phoneCardSvg, flowSvgForExport, swarmSvg, sankeySvg, svgToPng,
  nearestPanelPoint, nearestSwarmPoint, sankeyLink,
  formats, pctile, ord, niceTicks, titleRight, C,
} from './charts.js?v=43';
import { morph } from './morph.js?v=1';

const DEFAULT = { season: 2026, pitcher: 694819, pt: 'FF' };  // Jacob Misiorowski's four-seamer
// 'outcomes' is the plus score split by outcome (the features split is the default)
const TARGETS = ['plus', 'outcomes', 'era', ...OUTCOMES.map((o) => `p_${o}`), 'wobacon'];
const RV = OUTCOMES.map((o) => `rv_${o}`);
const tableTarget = (t) => (t === 'outcomes' ? 'plus' : t);  // the row that holds its value

const $ = (id) => document.getElementById(id);
const el = {
  form: $('form'), season: $('season'), player: $('player'), suggest: $('suggest'), pt: $('pt'),
  model: $('model'), target: $('target'), status: $('status'),
  out: $('out'), flow: $('flow'), flowCard: $('flow-card'), stats: $('stats'), notes: $('notes'),
  vs: $('vs'), minN: $('minn'), all: $('all'),
  swarmCard: $('swarm-card'), swarm: $('swarm'), sankeyCard: $('sankey-card'), sankey: $('sankey'),
  tip: $('tip'), copyFlow: $('copy_flow'), copySwarm: $('copy_swarm'), copySankey: $('copy_sankey'), dlCsv: $('dl_csv'),
};

const state = { season: null, pitcher: null, pt: null, model: 'stuff', target: 'plus', row: null };
let meta = null;
let feats = null;   // the season's unit_features, indexed
let units = null;   // the season x model's units, indexed
let fidelity = [];
let view = null;    // what's drawn: ctx for the charts

const status = (text, cls = '') => { el.status.textContent = text; el.status.className = `status ${cls}`.trim(); };

// ---- controls -----------------------------------------------------------------------------

function fillTargets() {
  const keep = el.target.value || state.target;
  const menu = (t) => (t === 'plus' ? `${targetName(state.model, t)} (features)`
    : t === 'outcomes' ? `${targetName(state.model, t)} (outcomes)` : targetName(state.model, t));
  el.target.replaceChildren(...TARGETS.map((t) => new Option(menu(t), t)));
  el.target.value = keep;
}

function fillPitchTypes() {
  const p = feats && feats.byId.get(state.pitcher);
  el.pt.replaceChildren(...(p ? p.pts : []).map((u) => new Option(`${u.pt} · ${PITCH_NAMES[u.pt] || u.pt} (${u.n.toLocaleString()})`, u.pt)));
  el.pt.disabled = !p;
  if (p) el.pt.value = state.pt;
}

// ---- pitcher suggestions (Swing Profiles' combobox) -----------------------------------------

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
let shown = [];
let active = -1;
let committed = false;

function suggestions(query) {
  const q = normalize(query);
  const list = feats ? feats.pitchers : [];
  if (!q) return list;
  const scored = [];
  for (const p of list) {
    const full = (p._full ??= normalize(p.name));
    const last = (p._last ??= full.slice(full.lastIndexOf(' ') + 1));
    let score;
    if (full.startsWith(q)) score = 0;
    else if (last.startsWith(q)) score = 1;
    else if (full.includes(q) || String(p.id).startsWith(q)) score = 2;
    else continue;
    scored.push([score, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || b[1].n - a[1].n);
  return scored.map((x) => x[1]);
}

function showSuggestions() {
  shown = suggestions(el.player.value).slice(0, 400);
  active = -1;
  el.suggest.replaceChildren(...shown.map((p, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);
    const name = document.createElement('span'); name.textContent = p.name;
    const sm = document.createElement('small'); sm.textContent = `${p.hand}HP · ${p.pts.map((u) => u.pt).join(' ')}`;
    li.append(name, sm);
    return li;
  }));
  el.suggest.hidden = !shown.length;
  el.player.setAttribute('aria-expanded', shown.length ? 'true' : 'false');
}
function hideSuggestions() {
  el.suggest.hidden = true;
  el.player.setAttribute('aria-expanded', 'false');
  shown = [];
  active = -1;
}
function setActive(i) {
  active = i;
  [...el.suggest.children].forEach((li, k) => li.classList.toggle('active', k === i));
  if (i >= 0) el.suggest.children[i].scrollIntoView({ block: 'nearest' });
}
function setPlayer(name) { el.player.value = name; committed = true; }
function startSearch() {
  if (committed) { el.player.value = ''; committed = false; }
  showSuggestions();
}
function pick(p) {
  hideSuggestions();
  setPlayer(p.name);
  choosePitcher(p.id);
}

// ---- loading --------------------------------------------------------------------------------

async function loadSeason(season) {
  state.season = season;
  el.season.value = String(season);
  status(`loading the ${season} pitchers…`);
  feats = await loadFeatures(season);
  feats._season = season;
  units = null;
  if (!el.suggest.hidden) showSuggestions();
}

async function loadModel() {
  const want = [state.season, state.model];
  const size = state.model === 'stuff' ? '14' : '17';
  if (!units || units._for !== want.join('|')) {
    status(`loading the ${state.season} ${MODELS[state.model].title} SHAP tables (~${size} MB, once per season)…`);
    const u = await loadUnits(...want);
    if (state.season !== want[0] || state.model !== want[1]) return false;  // superseded
    units = u;
    units._for = want.join('|');
  }
  return true;
}

// the pitcher's pitch type this season: the one asked for, or their most thrown
function settlePitchType() {
  const p = feats.byId.get(state.pitcher);
  if (!p) return false;
  if (!p.pts.some((u) => u.pt === state.pt)) state.pt = p.pts[0].pt;
  return true;
}

async function choosePitcher(id) {
  state.pitcher = id;
  await draw();
}

// ---- drawing --------------------------------------------------------------------------------

let drawing = 0;
async function draw() {
  const ticket = ++drawing;
  try {
    meta ??= await loadMeta();
    if (!feats || feats._season !== state.season) await loadSeason(state.season);
    if (!settlePitchType()) {
      const who = view && view.info.pitcher === state.pitcher ? view.info.pitcher_name : 'That pitcher';
      status(`${who} has no ${state.season} pitches: pick another pitcher or season`, 'warn');
      return;
    }
    const p = feats.byId.get(state.pitcher);
    setPlayer(p.name);
    fillPitchTypes();
    if (!(await loadModel()) || ticket !== drawing) return;
    render();
    // the other model's tables for this season, ahead of a switch
    loadUnits(state.season, state.model === 'stuff' ? 'pitching' : 'stuff').catch(() => {});
  } catch (e) {
    console.error(e);
    status(e.message || String(e), 'err');
  }
}

function poolFor(info) {
  const minN = Number(el.minN.value);
  const vs = el.vs.value;
  const rows = units.byTarget.get(tableTarget(state.target)) || [];
  const pool = [];
  for (const u of rows) {
    const i = feats.byUnit.get(`${u.pitcher}|${u.pt}`);
    if (!i) continue;
    const me = u.pitcher === info.pitcher && u.pt === info.pt;
    if (!me) {
      if (i.n < minN) continue;
      if (vs === 'pt' && i.pt !== info.pt) continue;
      if (vs === 'group' && i.group !== info.group) continue;
    }
    pool.push({ unit: u, info: i });
  }
  const what = vs === 'pt' ? `${PITCH_NAMES[info.pt] || info.pt}s` : vs === 'group' ? `${info.group.toLowerCase()} pitches` : 'pitch types';
  return {
    pool,
    label: `vs ${(pool.length - 1).toLocaleString()} ${what}, ${state.season}${minN > 1 ? ` (${minN}+ pitches)` : ''}`,
    what: vs === 'all' ? 'all pitch types' : what,  // "… percentile for Sinkers"
  };
}

// The KPI box's colour: where the value sits among the season's established pitches, i.e.
// every pitcher x pitch type (any type) thrown at least a quarter as often as the season's
// most-thrown one. The 50th percentile is white, the top pure gold and the bottom pure teal
// (flipped where lower is better). Sorted values are kept per season x model x target.
const kpiDists = new Map();
function kpiShade(unit) {
  const key = `${state.season}|${state.model}|${state.target}`;
  if (!kpiDists.has(key)) {
    const floor = Math.max(...feats.rows.map((r) => r.n)) / 4;
    const vals = (units.byTarget.get(tableTarget(state.target)) || [])
      .filter((u) => (feats.byUnit.get(`${u.pitcher}|${u.pt}`)?.n ?? 0) >= floor)
      .map((u) => u.exact).sort((a, b) => a - b);
    kpiDists.set(key, { vals, floor });
  }
  const { vals, floor } = kpiDists.get(key);
  if (!vals.length) return { t: 0, floor, n: 0, pct: 50 };
  let below = 0, same = 0;
  for (const v of vals) { if (v < unit.exact) below++; else if (v === unit.exact) same++; }
  const p = (below + same / 2) / vals.length;
  return { t: targetGood(state.target) * (2 * p - 1), floor, n: vals.length, pct: Math.round(100 * p) };
}

// where the season's longest pitcher name ends at the title size, for the KPI box's place
function seasonTitleRight() {
  feats._titleRight ??= titleRight(feats.pitchers.map((p) => p.name));
  return feats._titleRight;
}

function render() {
  const info = feats.byUnit.get(`${state.pitcher}|${state.pt}`);
  const unit = units.byKey.get(`${state.pitcher}|${state.pt}|${tableTarget(state.target)}`);
  if (!info || !unit) { status('no SHAP values for that pitch type', 'warn'); return; }
  const byOutcome = state.target === 'outcomes';
  const rows = byOutcome ? outcomeRows(state.model, units, info)
    : cardRows(meta, state.model, unit, info, minImpact(state.target), el.all.checked);
  // the chosen row carries across inputs; while it's folded into Other, Other stands in for it
  // (state.row keeps the choice, so it comes back when the row does)
  let row = state.row;
  if (!rows.some((r) => r.k === row)) {
    const other = rows.find((r) => r.k === 'Other');
    const folded = other ? other.folded : [];
    row = row && folded.includes(row) ? 'Other' : rows[0].k;
    if (!state.row || !folded.includes(state.row)) state.row = row;
  }
  const arsenal = feats.byId.get(state.pitcher).pts.map((u) => ({ pt: u.pt, n: u.n, unit: units.byKey.get(`${state.pitcher}|${u.pt}|${tableTarget(state.target)}`) }));
  const { pool, label, what } = poolFor(info);
  const perTarget = new Map([...TARGETS, ...RV].map((t) => [t, units.byKey.get(`${state.pitcher}|${state.pt}|${t}`)]));
  view = { meta, model: state.model, target: state.target, season: state.season, info, unit, rows, arsenal, selected: row, pool, poolLabel: label, poolWhat: what, minN: Number(el.minN.value), titleRight: seasonTitleRight(), units: perTarget, kpi: kpiShade(unit) };
  // by outcome, the league charts read each row's run value and the unit's predicted rate
  if (byOutcome) {
    Object.assign(view, {
      byOutcome,
      rowValueOf: (k, p) => outcomeValue(k, units, p.info.pitcher, p.info.pt),
      rowInputOf: (k, p) => outcomeInput(k, units, p.info),
      axisOf: OUTCOME_AXIS,
    });
  }

  el.out.hidden = false;
  el.swarmCard.hidden = false;
  drawFlow();
  morph(el.swarm, swarmSvg(view));
  const sk = sankeySvg(view);
  el.sankeyCard.hidden = !sk;
  if (sk) morph(el.sankey, sk);
  renderStats();
  applyFocus();
  writeHash();
  status('');
}

// The drilldown: the square desktop figure, or on a phone (600 px or narrower) the one-line
// header and waterfall at the screen's own width, with the league card as its own panel.
const phoneQuery = window.matchMedia('(max-width: 600px)');
let drawnAs = null;  // 'desktop', or the phone width it was drawn at
function drawFlow() {
  if (phoneQuery.matches) {
    el.flowCard.hidden = false;
    const w = el.flow.clientWidth;
    drawnAs = w;
    morph(el.flow, phoneFlowSvg(view, w));
    const card = phoneCardSvg(view, w);
    if (card) morph(el.flowCard, card); else el.flowCard.replaceChildren();
  } else {
    drawnAs = 'desktop';
    el.flowCard.hidden = true;
    el.flowCard.replaceChildren();
    morph(el.flow, flowSvg(view));
  }
}
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!view) return;
    const now = phoneQuery.matches ? el.flow.clientWidth : 'desktop';
    if (now !== drawnAs) { drawFlow(); applyFocus(); }
  }, 120);
});

// ---- the numbers under the figure (Swing Profiles' stat tiles, each with its league KDE) ------

function kde(values, grid) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) || 1e-9;
  const bw = sd * n ** (-1 / 5);
  const norm = n * bw * Math.sqrt(2 * Math.PI);
  return grid.map((x) => values.reduce((a, v) => a + Math.exp(-0.5 * ((x - v) / bw) ** 2), 0) / norm);
}

function kdeSvg(values, x, color, fmt) {
  const W = 260, H = 66, top = 7, bottom = 16, left = 7, right = 7;
  const sorted = values.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.round((sorted.length - 1) * p)];
  const lo = Math.min(q(0.005), x), hi = Math.max(q(0.995), x);
  const N = 121;
  const grid = Array.from({ length: N }, (_, i) => lo + (i * (hi - lo)) / (N - 1));
  const dens = kde(values, grid);
  const dx = kde(values, [x])[0];
  const ymax = Math.max(...dens, dx);
  const sx = (v) => left + ((v - lo) / (hi - lo || 1)) * (W - left - right);
  const sy = (d) => top + (1 - d / ymax) * (H - top - bottom);
  const pts = grid.map((g, i) => `${sx(g).toFixed(1)},${sy(dens[i]).toFixed(1)}`);
  const upTo = grid.findIndex((g) => g > x);
  const below = (upTo < 0 ? pts : pts.slice(0, upTo)).concat([`${sx(x).toFixed(1)},${sy(dx).toFixed(1)}`]);
  const ticks = niceTicks(lo, hi, 4);
  let s = `<svg class="kde" viewBox="0 0 ${W} ${H}" role="img" aria-label="${ord(pctile(values, x))} percentile of ${values.length}">`;
  s += `<path class="below" fill="${color}" d="M${sx(lo).toFixed(1)},${sy(0).toFixed(1)} L${below.join(' L')} L${sx(x).toFixed(1)},${sy(0).toFixed(1)} Z"/>`;
  s += `<line class="base" x1="${left}" x2="${W - right}" y1="${sy(0)}" y2="${sy(0)}"/>`;
  for (const t of ticks) {
    s += `<line class="tick" x1="${sx(t)}" x2="${sx(t)}" y1="${sy(0)}" y2="${sy(0) + 3}"/>`;
    s += `<text x="${sx(t)}" y="${H - 3}" text-anchor="middle">${fmt(t)}</text>`;
  }
  s += `<path class="curve" stroke="${color}" d="M${pts.join(' L')}"/>`;
  s += `<line class="mark" stroke="${color}" x1="${sx(x)}" x2="${sx(x)}" y1="${sy(0)}" y2="${sy(dx)}"/>`;
  s += `<circle class="dot" fill="${color}" cx="${sx(x)}" cy="${sy(dx)}" r="5"/>`;
  return `${s}</svg>`;
}

function renderStats() {
  const { unit, info, rows, pool, target, model } = view;
  const f = formats(target);
  const good = targetGood(target);
  const label = targetName(model, target);
  const others = pool.filter((p) => !(p.info.pitcher === info.pitcher && p.info.pt === info.pt));
  // lift and drag come from the pitch's own traits: not Other, Pitch Group & Matchup or Handedness
  const feat = rows.filter((r) => !['Other', 'baseline', 'lefty'].includes(r.k));
  const lift = feat.filter((r) => good * r.v > 0).sort((a, b) => good * (b.v - a.v))[0];
  const drag = feat.filter((r) => good * r.v < 0).sort((a, b) => good * (a.v - b.v))[0];
  const tiles = [{
    k: null, head: label, value: f.v(unit.exact), sub: `${f.d(unit.exact - unit.league)} vs lg avg pitch; ${ord(pctile(others.map((p) => p.unit.exact), unit.exact))} percentile for ${view.poolWhat}`,
    values: others.map((p) => p.unit.exact), x: unit.exact, color: good * (unit.exact - unit.league) >= 0 ? C.gold : C.teal, fmt: f.tick,
  }];
  for (const [r, word, color] of [[lift, 'Biggest lift', C.gold], [drag, 'Biggest drag', C.teal]]) {
    if (!r) continue;
    const vals = others.map((p) => (view.rowValueOf ? view.rowValueOf(r.k, p) : rowValue(r.k, p.unit))).filter(Number.isFinite);
    const signed = (v) => (Math.abs(v) < 1e-9 ? '0' : `${v > 0 ? '+' : '−'}${f.tick(Math.abs(v))}`);
    tiles.push({ k: r.k, head: `${word}: ${r.label}`, value: `${f.d(r.v)} ${f.unit}`, sub: `${r.detail && !['Location', 'Count', 'leverage'].includes(r.k) ? `${r.detail}; ` : ''}${ord(pctile(vals, r.v))} percentile for ${view.poolWhat}`, values: vals, x: r.v, color, fmt: signed });
  }
  el.stats.innerHTML = tiles.map((t, i) => `<div class="stat${t.k ? ' fx' : ''}"${t.k ? ` data-k="${t.k}" tabindex="0" role="button"` : ''} data-i="${i}">
    <span>${esc(t.head)}</span><b>${esc(t.value)}</b><span>${esc(t.sub)}</span>
    ${t.values.length >= 5 ? kdeSvg(t.values, t.x, t.color, t.fmt) : ''}</div>`).join('');

  // the surrogate's fit for this unit's models, and its residual
  const fit = fidelity.filter((r) => r.model === model && r.target === target && r.group_model.startsWith(`${info.group} vs`));
  const notes = [];
  if (fit.length) {
    notes.push(`Proxy fit, R² on held-out pitchers: ${fit.map((r) => `${r.r2_heldout_pitchers.toFixed(3)} ${r.group_model.replace(`${info.group} vs `, 'vs ').replace(' Hand', '-handed')}`).join(', ')}. This unit's residual (in Other): ${f.d(unit.residual)} ${f.unit}.`);
  }
  if (info.n < 20) notes.push(`Only ${info.n} pitch${info.n === 1 ? '' : 'es'}: a small sample, so read the SHAP values loosely.`);
  el.notes.innerHTML = notes.map((n) => `<p class="note">${esc(n)}</p>`).join('');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---- focus: one row lit across every chart ----------------------------------------------------

let focus = null;
function setFocus(k) {
  if (k === focus) return;
  focus = k;
  applyFocus();
}
function applyFocus() {
  document.body.classList.toggle('focusing', !!focus);
  document.querySelectorAll('.fx.hot').forEach((e) => e.classList.remove('hot'));
  if (focus) document.querySelectorAll(`.fx[data-k="${CSS.escape(focus)}"]`).forEach((e) => e.classList.add('hot'));
}

// ---- tooltips -----------------------------------------------------------------------------

function showTip(html, ev) {
  el.tip.innerHTML = html;
  el.tip.hidden = false;
  const pad = 14, tw = el.tip.offsetWidth, th = el.tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + tw > window.innerWidth - 8) x = ev.clientX - pad - tw;
  if (y + th > window.innerHeight - 8) y = ev.clientY - pad - th;
  el.tip.style.left = `${Math.max(8, x)}px`;
  el.tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { el.tip.hidden = true; };

function svgPoint(svg, ev) {
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return [p.x, p.y];
}

function unitTip(p, value, me = false) {
  const f = formats(state.target);
  const r = view.rows.find((x) => x.k === value.k) || { label: LABELS[value.k] || value.k };
  return `<div class="name">${esc(p.pitcher_name)} · ${esc(p.pt)}</div>
    <div class="meta">${p.n.toLocaleString()} pitches · ${esc(r.label)} ${esc(f.d(value.v))} ${f.unit}</div>
    <div class="meta">${me ? 'This pitch' : 'Click to open'}</div>`;
}

// ---- wiring ---------------------------------------------------------------------------------

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  hideSuggestions();
  const hit = suggestions(el.player.value)[0];
  if (!hit) { status('no pitcher by that name this season', 'warn'); return; }
  pick(hit);
});
el.season.addEventListener('change', async () => { state.season = Number(el.season.value); await loadSeason(state.season); draw(); });
el.pt.addEventListener('change', () => { state.pt = el.pt.value; draw(); });
el.model.addEventListener('change', () => { state.model = el.model.value; fillTargets(); draw(); });
el.target.addEventListener('change', () => { state.target = el.target.value; draw(); });
for (const c of [el.vs, el.minN, el.all]) c.addEventListener('change', () => view && render());

el.player.addEventListener('input', () => { committed = false; showSuggestions(); });
el.player.addEventListener('focus', startSearch);
el.player.addEventListener('click', startSearch);
el.player.addEventListener('blur', () => setTimeout(() => {
  hideSuggestions();
  if (!el.player.value.trim() && view) setPlayer(view.info.pitcher_name);
}, 150));
el.player.addEventListener('keydown', (e) => {
  if (el.suggest.hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); showSuggestions(); if (shown.length) setActive(0); }
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % shown.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + shown.length) % shown.length); }
  else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(shown[active]); }
  else if (e.key === 'Escape') hideSuggestions();
});
el.suggest.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  pick(shown[Number(li.dataset.index)]);
});
el.suggest.addEventListener('pointermove', (e) => {
  const li = e.target.closest('li');
  if (li) setActive(Number(li.dataset.index));
});

// hovering any row-bearing element focuses its row; leaving the charts clears it
for (const host of [el.flow, el.swarm, el.sankey, el.stats]) {
  host.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-k]');
    setFocus(t ? t.dataset.k : null);
  });
  host.addEventListener('pointerleave', () => { setFocus(null); hideTip(); });
}

// flow: pick a pitch type or a row; the panel's dots open that pitcher
el.flow.addEventListener('click', (e) => {
  const pt = e.target.closest('[data-pt]');
  if (pt) { state.pt = pt.dataset.pt; el.pt.value = state.pt; draw(); return; }
  if (e.target.closest('.panel-hit')) {
    const p = nearestPanelPoint(...svgPoint(el.flow.querySelector('svg'), e));
    if (p && !p.me) { hideTip(); state.pt = p.pt; choosePitcher(p.id); }
    return;
  }
  const row = e.target.closest('.row');
  if (row && row.dataset.k !== state.row) { state.row = row.dataset.k; render(); }
});
el.flow.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[data-pt],.row');
  if (!t) return;
  e.preventDefault();
  t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
el.flow.addEventListener('pointermove', (e) => {
  const svg = el.flow.querySelector('svg');
  if (!svg || !view) return;
  const band = e.target.closest('[data-pt]');
  if (band) {
    const a = view.arsenal.find((x) => x.pt === band.dataset.pt);
    const f = formats(state.target);
    showTip(`<div class="name">${esc(PITCH_NAMES[a.pt] || a.pt)}</div><div class="meta">${a.n.toLocaleString()} pitches · ${esc(targetName(state.model, state.target))} ${a.unit ? esc(f.v(a.unit.exact)) : '–'}</div>`, e);
    return;
  }
  if (e.target.closest('.panel-hit')) {
    const p = nearestPanelPoint(...svgPoint(svg, e));
    if (p) { showTip(unitTip(p.info, { k: state.row, v: p.v }, p.me), e); return; }
  }
  const row = e.target.closest('.row');
  if (row && row.dataset.k === 'Other') {
    const r = view.rows.find((x) => x.k === 'Other');
    const f = formats(state.target);
    const parts = r.folded.map((k) => `${LABELS[k] || k} ${f.d(rowValue(k, view.unit))}`);
    const cal = Number.isFinite(view.unit.calibration) && view.unit.calibration ? [`calibration ${f.d(view.unit.calibration)}`] : [];
    showTip(`<div class="name">Other ${esc(f.d(r.v))}</div><div class="meta">${esc([...parts, `residual ${f.d(view.unit.residual)}`, ...cal].join(' · '))}</div>`, e);
    return;
  }
  hideTip();
});

el.flowCard.addEventListener('pointermove', (e) => {
  const svg = el.flowCard.querySelector('svg');
  if (!svg || !view || !e.target.closest('.panel-hit')) { hideTip(); return; }
  const p = nearestPanelPoint(...svgPoint(svg, e));
  if (p) showTip(unitTip(p.info, { k: state.row, v: p.v }, p.me), e); else hideTip();
});
el.flowCard.addEventListener('pointerleave', hideTip);
el.flowCard.addEventListener('click', (e) => {
  const svg = el.flowCard.querySelector('svg');
  if (!svg || !e.target.closest('.panel-hit')) return;
  const p = nearestPanelPoint(...svgPoint(svg, e));
  if (p && !p.me) { hideTip(); state.pt = p.pt; choosePitcher(p.id); }
});

el.swarm.addEventListener('pointermove', (e) => {
  const svg = el.swarm.querySelector('svg');
  if (!svg || !view) return;
  const q = nearestSwarmPoint(...svgPoint(svg, e));
  if (q) showTip(unitTip(q.p.info, { k: q.k, v: q.v }), e); else hideTip();
});
el.swarm.addEventListener('click', (e) => {
  const svg = el.swarm.querySelector('svg');
  const q = svg && nearestSwarmPoint(...svgPoint(svg, e));
  if (q) { hideTip(); state.pt = q.p.info.pt; choosePitcher(q.p.info.pitcher); return; }
  const row = e.target.closest('.srow');
  if (row) { state.row = row.dataset.k; render(); }
});

el.sankey.addEventListener('pointermove', (e) => {
  const link = e.target.closest('.link');
  if (link) {
    const l = sankeyLink(Number(link.dataset.i));
    const name = TARGET_NAMES[`p_${l.o}`];
    showTip(`<div class="name">${esc(l.label)}</div><div class="meta">${l.v < 0 ? `takes ${(-l.v).toFixed(2)} pp from ${esc(name)}` : `gives ${l.v.toFixed(2)} pp to ${esc(name)}`}</div>`, e);
    return;
  }
  hideTip();
});
el.sankey.addEventListener('click', (e) => {
  const t = e.target.closest('[data-k]');
  if (!t || !view) return;
  if (view.rows.some((r) => r.k === t.dataset.k)) { state.row = t.dataset.k; render(); }
});

// downloads
function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileStem = () => `${view.info.pitcher_name.toLowerCase().replace(/[^a-z]+/g, '_')}_${view.info.pt.toLowerCase()}_${state.season}_${state.model}_${state.target}`;
// Copy PNG, as Release Angles does: the ClipboardItem is made in the click itself, around the
// promise of the image, so the copy keeps the click's permission while the image is drawn
// (Safari insists on it). Where the clipboard is refused, the PNG downloads instead.
async function copyPng(getSvg, suffix, btn) {
  const svg = getSvg();
  if (!svg) return;
  const label = btn.textContent;
  const blob = svgToPng(svg);
  btn.disabled = true;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    btn.textContent = 'Copied';
  } catch (e) {
    console.error(e);
    save(await blob, `${fileStem()}_${suffix}.png`);
    btn.textContent = 'Downloaded (no clipboard here)';
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = label; }, 1600);
  }
}
// the drilldown's copy is always the square desktop figure (2400 x 2400), even on a phone
function desktopFlow() {
  const t = document.createElement('template');
  t.innerHTML = flowSvgForExport(view).trim();
  return t.content.firstElementChild;
}
el.copyFlow.addEventListener('click', () => view && copyPng(desktopFlow, 'waterfall', el.copyFlow));
el.copySwarm.addEventListener('click', () => copyPng(() => el.swarm.querySelector('svg'), 'beeswarm', el.copySwarm));
el.copySankey.addEventListener('click', () => copyPng(() => el.sankey.querySelector('svg'), 'outcomes', el.copySankey));
el.dlCsv.addEventListener('click', () => {
  const cols = Object.keys(view.unit);
  const lines = [cols.join(',')];
  for (const t of [...TARGETS.filter((x) => x !== 'outcomes'), ...RV]) {
    const u = view.units.get(t);
    if (u) lines.push(cols.map((c) => u[c]).join(','));
  }
  save(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }), `shap_${fileStem().replace(/_[a-z_]+$/, '')}.csv`);
});

// ---- the link hash ---------------------------------------------------------------------------

function writeHash() {
  const q = new URLSearchParams();
  if (state.model !== 'stuff') q.set('model', 'plv');  // the pitching tables, shown as PLV
  if (state.target !== 'plus') q.set('target', state.target);
  if (state.row) q.set('row', state.row);
  if (el.vs.value !== 'pt') q.set('vs', el.vs.value);
  const h = `#${state.season}-${state.pitcher}-${state.pt}${q.toString() ? `&${q}` : ''}`;
  if (location.hash !== h) history.replaceState(null, '', h);
  document.title = `${view.info.pitcher_name} · ${PITCH_NAMES[state.pt] || state.pt} · Model Drilldown`;
}

function readHash() {
  const m = /^#(\d{4})-(\d+)-([A-Z]{2})(?:&(.*))?$/.exec(location.hash);
  if (!m) return false;
  const q = new URLSearchParams(m[4] || '');
  state.season = Number(m[1]);
  state.pitcher = Number(m[2]);
  state.pt = m[3];
  state.model = ['plv', 'pitching'].includes(q.get('model')) ? 'pitching' : 'stuff';  // older links say pitching
  state.target = TARGETS.includes(q.get('target')) ? q.get('target') : 'plus';
  state.row = q.get('row') || null;
  if (['pt', 'group', 'all'].includes(q.get('vs'))) el.vs.value = q.get('vs');
  return true;
}

window.addEventListener('hashchange', () => {
  const before = `${state.season}-${state.pitcher}-${state.pt}-${state.model}-${state.target}-${state.row}`;
  if (!readHash()) return;
  if (before === `${state.season}-${state.pitcher}-${state.pt}-${state.model}-${state.target}-${state.row}`) return;
  el.model.value = state.model;
  fillTargets();
  el.target.value = state.target;
  draw();
});

// ---- start ----------------------------------------------------------------------------------

(async () => {
  try {
    meta = await loadMeta();
  } catch (e) {
    status(`could not reach the SHAP tables: ${e.message}`, 'err');
    return;
  }
  loadFidelity().then((f) => { fidelity = f; if (view) renderStats(); });
  const seasons = meta.seasons.slice().sort((a, b) => b - a);
  el.season.replaceChildren(...seasons.map((y) => new Option(String(y), String(y))));
  el.model.replaceChildren(...Object.entries(MODELS).map(([k, m]) => new Option(m.title, k)));
  if (!readHash()) Object.assign(state, DEFAULT, { season: seasons.includes(DEFAULT.season) ? DEFAULT.season : seasons[0] });
  el.season.value = String(state.season);
  el.model.value = state.model;
  fillTargets();
  el.target.value = state.target;
  [el.season, el.model, el.target, el.player].forEach((c) => { c.disabled = false; });
  // the figures measure their text in DM Sans (value chips, the KPI box), so let it load first
  if (document.fonts) await Promise.race([document.fonts.load('700 21px "DM Sans"'), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  await draw();
})();
