// Runs the simulation off the page's main thread (app.js starts it), so a 100,000-game
// run doesn't freeze the page on a phone. The page sends the season's baserunning tables
// once ("init"), then one lineup per run. A run can't be stopped partway; when the page
// wants a newer one it replaces the whole worker.
import { prepare, simulate } from "./sim.js?v=2";

let model = null;

self.onmessage = ({ data: msg }) => {
  if (msg.type === "init") {
    model = prepare(msg.tables);
    return;
  }
  const t0 = performance.now();
  const res = simulate(model, msg.lineup, msg.games, msg.seed);
  self.postMessage({ id: msg.id, res, ms: performance.now() - t0 });
};
