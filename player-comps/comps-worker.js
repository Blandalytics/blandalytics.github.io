'use strict';
// Web Worker: loads a role's columns once, then answers queries (spec section 3).
importScripts('comps-core.js?v=1', 'data-loader.js?v=1');

const cache = {};
let dataBase = 'data/'; // set by the page: local data/ or the R2 build folder

async function load(role) {
  if (cache[role]) return cache[role];
  const base = `${dataBase}${role}/`;
  const get = async (f) => { const r = await fetch(base + f); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r; };
  const D = await DataLoader.loadRole((f) => get(f).then((r) => r.arrayBuffer()), (f) => get(f).then((r) => r.json()));
  try { D.tuning = await get('tuning.json').then((r) => r.json()); } catch (e) { D.tuning = null; }
  cache[role] = D;
  return D;
}

function featureIndex(D) { return Object.fromEntries(D.manifest.features.map((f, i) => [f.id, i])); }

// Adds what the page shows: raw and z values of the selected features for the target and each comp, and each comp's
// next-season outcome in stat units.
function enrich(D, q, res) {
  const n = D.n, sel = res.diagnostics.selRate || [];
  const vals = (row) => sel.map((f) => ({ raw: D.raw[f * n + row], z: D.rate[f * n + row] }));
  const stat = q.stat || D.manifest.forecastStats[0].id;
  const o = D.outcomes[stat];
  const fi = featureIndex(D);
  const cur = fi[stat] !== undefined ? fi[stat] : -1;
  const rowInfo = (row) => ({
    row, playerId: D.playerId[row], name: D.names[D.playerId[row]] || String(D.playerId[row]), season: D.season[row],
    age: D.age[row], sample: D.sample[row], cat: D.manifest.categoricals.map((_, c) => D.cat[c * n + row]),
    statNow: cur >= 0 ? D.raw[cur * n + row] : NaN, statNext: o.outcomeRaw[row], statNextN: o.outcomeN[row],
  });
  const mixOf = (row) => (D.mix ? Array.from(D.mix.subarray(row * D.M, (row + 1) * D.M)) : null);
  return {
    target: { ...rowInfo(q.targetRow), values: vals(q.targetRow), mix: mixOf(q.targetRow) },
    comps: res.comps.map((c) => ({ ...c, ...rowInfo(c.row), values: vals(c.row), mix: mixOf(c.row) })),
    forecast: res.forecast, diagnostics: res.diagnostics, stat,
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      if (m.base) dataBase = m.base;
      const D = await load(m.role);
      self.postMessage({
        type: 'loaded', id: m.id, role: m.role, manifest: D.manifest, names: D.names, tuning: D.tuning,
        index: { playerId: D.playerId.slice(), season: D.season.slice(), age: D.age.slice(), sample: D.sample.slice(), cat: D.cat.slice() },
      });
    } else if (m.type === 'query') {
      const D = await load(m.role);
      const t0 = performance.now();
      const res = CompsCore.runQuery(D, m.q);
      const out = enrich(D, m.q, res);
      out.ms = performance.now() - t0;
      self.postMessage({ type: 'result', id: m.id, result: out });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
