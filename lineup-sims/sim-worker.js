// Runs the simulation and the lineup optimizer off the page's main thread (app.js starts
// it), so a 100,000-game run or a search doesn't freeze the page on a phone. The page
// sends the season's baserunning tables once ("init"), then one job per message: a
// lineup to simulate, or ("optimize") a lineup to improve. A job can't be stopped
// partway; when the page wants a newer one it replaces the whole worker.
import { prepare, simulate } from "./sim.js?v=2";
import { chainTables, optimize } from "./markov.js?v=1";

let model = null, chain = null;

self.onmessage = ({ data: msg }) => {
  if (msg.type === "init") {
    model = prepare(msg.tables);
    return;
  }
  const t0 = performance.now();
  if (msg.type === "optimize") {
    chain ??= chainTables(model);
    const result = optimize(chain, msg.hitters, msg.opts, (evals) => self.postMessage({ id: msg.id, progress: evals }));
    self.postMessage({ id: msg.id, result, ms: performance.now() - t0 });
    return;
  }
  const res = simulate(model, msg.lineup, msg.games, msg.seed);
  self.postMessage({ id: msg.id, res, ms: performance.now() - t0 });
};
