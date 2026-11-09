// Values the season to date at every date (for the Value Through the Season chart) and each
// period in `segs` (the halves and months the one-player chart labels), off the main thread.
// One job per worker: the page terminates it and starts a new one when the season or settings change.
importScripts("engine.js?v=10");
const E = self.RaterEngine;

onmessage = (e) => {
  const { raw, settings, from, segs } = e.data;
  const db = E.prepare(raw);
  const N = raw.ndays;
  const keys = db.players.map((p) => p.key);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const trend = new Float32Array(keys.length * N).fill(NaN);
  const put = (out, v, d, stride) => {
    for (const g of ["h", "p"]) for (const r of v[g].rows) out[idx.get(r.key) * stride + d] = r.dollars;
  };
  // the period values first: they are few, and the one-player labels wait on them
  const seg = segs.map(([a, b]) => {
    const out = new Float32Array(keys.length).fill(NaN);
    put(out, E.valuate(db, settings, a, b), 0, 1);
    return out;
  });
  postMessage({ type: "segs", keys, seg });
  let last = Date.now();
  for (let d = from; d < N; d++) {
    put(trend, E.valuate(db, settings, 0, d), d, N);
    if (Date.now() - last > 400 && d < N - 1) {
      last = Date.now();
      postMessage({ type: "partial", done: d, trend: trend.slice() });
    }
  }
  postMessage({ type: "done", trend }, [trend.buffer]);
};
