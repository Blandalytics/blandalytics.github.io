// The data of the projection pages (Projection Drilldown, Playing-Time Risk, Promotion Timelines):
// JSON from the bucket's projections/site/<season>/ folder, written by the projections repository's
// src/site_export.py (schema version 1) from its factor ledger.
//
// ?data=<url> reads another copy, e.g. ?data=/_data/ under the projections repository's development
// server (python -m src.site_export --serve <this checkout>).

export const SEASON = 2027;
const LOCAL = new URLSearchParams(location.search).get('data');
export const SOURCE = LOCAL
  ? new URL(LOCAL.replace(/\/?$/, '/'), location.href).href
  : `https://data.blandalytics.com/projections/site/${SEASON}/`;
// The zone keeps objects for hours under their exact URL; an hourly key lets a republish through.
const STAMP = Math.floor(Date.now() / 3.6e6);
const cache = new Map();

export function load(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      fetch(`${SOURCE}${name}?v=${STAMP}`).then((r) => {
        if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
        return r.json();
      }),
    );
  }
  return cache.get(name);
}

// keep ?data= on the links between the pages
export function link(path, params = {}) {
  const q = new URLSearchParams(params);
  if (LOCAL) q.set('data', LOCAL);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ''}`;
}

const MINUS = '−';
const lead = (s) => s.replace(/^0\./, '.');

// a value in its stat's format: money $34.2, rates .267 / 2.80, percentages 25.8%, counts 23.0
export function fmtValue(v, kind, dp) {
  if (v == null || !Number.isFinite(v)) return '–';
  const sign = v < 0 ? MINUS : '';
  const a = Math.abs(v);
  if (kind === 'money') return `${sign}$${a.toFixed(dp)}`;
  if (kind === 'pct') return `${sign}${(100 * a).toFixed(dp)}%`;
  if (kind === 'rate' && dp === 3) return sign + lead(a.toFixed(3));
  return sign + a.toFixed(dp);
}

// a change: +$2.4, +1.9, +1.2 pts (percentages), +.012
export function fmtDelta(d, kind, dp) {
  if (d == null || !Number.isFinite(d)) return '–';
  const s = d > 0 ? '+' : d < 0 ? MINUS : '±';
  const a = Math.abs(d);
  if (kind === 'money') return `${s}$${a.toFixed(dp)}`;
  if (kind === 'pct') return `${s}${(100 * a).toFixed(dp)} pts`;
  if (kind === 'rate' && dp === 3) return s + lead(a.toFixed(3));
  return s + a.toFixed(dp);
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// the playing-time causes, in the ledger's names, with their colours (the leaderboard and the drilldown)
export const CAUSES = {
  absent: ['Whole season missed', '#8E7CC3'],
  inj: ['Injury', '#FF8A80'],
  pro: ['Minors before a call-up', '#6CB4FF'],
  perf_roster: ['Demotion or release', '#FFD166'],
  perf_bench: ['Bench for performance', '#F4A261'],
  perf_bullpen: ['Bullpen for performance', '#F4A261'],
  plat: ['Platoon sits', '#7BD88F'],
  list: ['Lists', '#B4BECC'],
  rest: ['Rest days', '#5C6B80'],
};
