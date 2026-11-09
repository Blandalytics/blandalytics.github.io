// 95% intervals for the Value Through the Season chart. For each date it is sent, a bootstrap of the season
// to that date (engine.js bootstrap, retrospective Mode R) gives every player's interval. The page runs a few
// of these side by side and hands out the dates; one job set per worker, terminated when it is done or the
// season or settings change.
importScripts("engine.js?v=6");
const E = self.RaterEngine;
let db = null, settings = null;

onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") { db = E.prepare(m.raw); settings = m.settings; return; }
  const ci = E.bootstrap(db, settings, 0, m.day, { reps: m.reps });
  const n = db.players.length, lo = new Float32Array(n).fill(NaN), hi = new Float32Array(n).fill(NaN);
  db.players.forEach((p, i) => { const c = ci.get(p.key); if (c) { lo[i] = c.lo; hi[i] = c.hi; } });
  postMessage({ day: m.day, lo, hi }, [lo.buffer, hi.buffer]);
};
