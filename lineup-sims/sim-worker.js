// Runs the simulation and the lineup optimizer off the page's main thread (app.js starts
// it), so a 100,000-game run or a search doesn't freeze the page on a phone. The page
// sends the season's baserunning tables once ("init"), then one job per message: a
// lineup to simulate, or ("optimize") a lineup to improve. A job can't be stopped
// partway; when the page wants a newer one it replaces the whole worker.
//
// Against a pitcher, a simulation job can also carry what the page compares it with:
// `ref`, MLB's lineup spots to simulate against him too (for the runs-per-game chart),
// `base`, the lineup itself to simulate against MLB-average pitching (the runs image's
// white bars), and `lines`, lineups whose exact expected lines (markov.js) the page needs, each hitter
// already matched against the starter and each relief stage (a follower, the bullpen).
import { prepare, simulate } from "./sim.js?v=5";
import { chainTables, expectedLines, optimize } from "./markov.js?v=4";

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
  const res = simulate(model, msg.lineup, msg.games, msg.seed, msg.relief);
  const ms = performance.now() - t0;
  const ref = msg.ref ? simulate(model, msg.ref.lineup, msg.ref.games, msg.seed, msg.ref.relief).runDist : null;
  const base = msg.base ? simulate(model, msg.base.lineup, msg.base.games, msg.seed).runDist : null;
  const lines = msg.lines ? expectedLines((chain ??= chainTables(model)), msg.lines.lineups, msg.lines.from, msg.lines.w) : null;
  self.postMessage({ id: msg.id, res, ms, ref, base, lines });
};
