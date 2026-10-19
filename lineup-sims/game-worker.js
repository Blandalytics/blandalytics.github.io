// Plays the Game Sim's games (game-sim.js) off the page's main thread (game.js starts it). The
// page sends the season's baserunning tables and the steal model once ("init"), then one job per
// message: both teams' pitching, each stage with the other lineup's chances against it (and, with
// useSteal, each side's runners, pitchers and catcher). A job can't be stopped partway; when the
// page wants a newer one it replaces the whole worker.
import { prepare } from "./sim.js?v=8";
import { prepareSteal, simulateGames } from "./game-sim.js?v=1";

let model = null, steal = null;

self.onmessage = ({ data: msg }) => {
  if (msg.type === "init") {
    model = prepare(msg.tables);
    steal = msg.steal ? prepareSteal(msg.steal) : null;
    return;
  }
  const t0 = performance.now();
  const res = simulateGames(model, msg.teams, msg.games, msg.seed, msg.pitches, msg.useSteal ? steal : null);
  self.postMessage({ id: msg.id, res, ms: performance.now() - t0 });
};
