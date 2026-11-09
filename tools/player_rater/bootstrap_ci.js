// Precomputes the Value Through the Season chart's 95% intervals at the default league settings, one file per
// season for R2 at player-rater/ci/<season>.json. It runs the page's own engine (player-rater/engine.js,
// bootstrap) with the page's dates, replicates and seeds, so the file holds exactly what a browser would
// compute; the page loads it when its settings are the defaults and computes in workers otherwise.
//
//   node bootstrap_ci.js --data out --out out/ci 2026 2025 ...   (seasons default to every out/<season>.json)
//
// The page uses a file only when its `method` matches app.js CI.method and its `built` matches the season
// file's: rebuild these after any engine change or season rebuild, and bump CI.method when the engine's
// numbers change.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const E = require(path.join(__dirname, "../../player-rater/engine.js"));

const METHOD = "retro-mode-r-1"; // = app.js CI.method
const CI = { reps: 1000, conf: 0.95, first: 13, step: 14 }; // = app.js CI (reps, first, step)

// the dates the page bootstraps: day 13, every 14 days after, and the season's last day
const gridDays = (N) => { const d = []; for (let x = CI.first; x < N - 1; x += CI.step) d.push(x); d.push(N - 1); return d; };

if (!isMainThread) {
  const { file } = workerData;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const db = E.prepare(raw);
  parentPort.on("message", (day) => {
    if (day == null) { process.exit(0); }
    const ci = E.bootstrap(db, E.YAHOO_DEFAULT, 0, day, { reps: CI.reps, conf: CI.conf });
    // dollars x 10, rounded, aligned to db.players; null where the player has no line yet
    const lo = db.players.map((p) => { const c = ci.get(p.key); return c ? Math.round(c.lo * 10) : null; });
    const hi = db.players.map((p) => { const c = ci.get(p.key); return c ? Math.round(c.hi * 10) : null; });
    parentPort.postMessage({ day, lo, hi });
  });
} else {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const dataDir = path.resolve(opt("--data", path.join(__dirname, "out")));
  const outDir = path.resolve(opt("--out", path.join(dataDir, "ci")));
  const threads = +opt("--threads", Math.max(1, os.cpus().length - 1));
  const seasons = args.length ? args : fs.readdirSync(dataDir).filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4));
  fs.mkdirSync(outDir, { recursive: true });

  (async () => {
    for (const season of seasons) {
      const file = path.join(dataDir, `${season}.json`);
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const db = E.prepare(raw);
      const days = gridDays(raw.ndays), got = new Map(), t0 = Date.now();
      const queue = [...days].sort((a, b) => b - a); // the long frames first
      await new Promise((resolve, reject) => {
        let live = 0;
        for (let i = 0; i < Math.min(threads, days.length); i++) {
          const w = new Worker(__filename, { workerData: { file } });
          live++;
          const next = () => w.postMessage(queue.length ? queue.shift() : null);
          w.on("message", (m) => { got.set(m.day, m); next(); });
          w.on("error", reject);
          w.on("exit", () => { if (--live === 0) resolve(); });
          next();
        }
      });
      const out = {
        season: +season, built: raw.built, method: METHOD, reps: CI.reps, conf: CI.conf, settings: E.YAHOO_DEFAULT,
        days, keys: db.players.map((p) => p.key),
        lo: days.map((d) => got.get(d).lo), hi: days.map((d) => got.get(d).hi),
      };
      const dest = path.join(outDir, `${season}.json`);
      fs.writeFileSync(dest, JSON.stringify(out));
      console.log(`${season}: ${days.length} dates x ${CI.reps} replicates in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
