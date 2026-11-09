// 95% intervals for the Value Through the Season chart, when they are not precomputed (league settings other
// than the defaults). The page splits each date's bootstrap replicates across a few of these workers; each
// values its share (engine.js bootstrap, `part`) and sends the draws back. When a date's shares are all in,
// one worker merges them (bootstrapSummary), which gives exactly the single-run result, so the page's main
// thread never does the sorting. Terminated when done or when the season or settings change.
importScripts("engine.js?v=10");
const E = self.RaterEngine;
let db = null, settings = null;
const points = new Map(); // day -> the point valuation, shared by that date's parts in this worker

onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") { db = E.prepare(m.raw); settings = m.settings; points.clear(); return; }
  if (m.type === "summary") {
    const ivl = E.bootstrapSummary(m.parts), keys = [...ivl.keys()];
    const lo = Float32Array.from(keys, (k) => ivl.get(k).lo), hi = Float32Array.from(keys, (k) => ivl.get(k).hi);
    postMessage({ type: "summary", day: m.day, keys, lo, hi }, [lo.buffer, hi.buffer]);
    return;
  }
  if (!points.has(m.day)) points.set(m.day, E.valuate(db, settings, 0, m.day));
  const part = E.bootstrap(db, settings, 0, m.day, { reps: m.reps, part: m.part, point: points.get(m.day) });
  const pools = part.pools.map((p) => ({ g: p.g, keys: p.keys, pointDollars: Float64Array.from(p.pointDollars), dollars: p.dollars }));
  postMessage({ type: "part", day: m.day, chunk: m.chunk, pools }, pools.flatMap((p) => [p.pointDollars.buffer, p.dollars.buffer]));
};
