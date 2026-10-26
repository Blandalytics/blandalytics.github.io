// Game simulator: two lineups, each against the other team's pitching, played as MLB games.
// Built on sim.js: the same running-game and advancement tables, the same per-plate-appearance
// draws, and the same modeled hook. What a game adds:
//   * the away team bats first; from the 9th on, the bottom half isn't played when the home team
//     leads, and the game ends the moment the home team takes the lead in the bottom of the 9th
//     or later (a walk-off: only the runs needed to win count, unless it's a home run)
//   * from the 10th on, each half-inning starts with a runner on 2nd: the hitter before the one
//     leading off (an unearned run if he scores)
//   * a box score: each lineup slot's and each pitcher's line, the decisions (W, L, SV), and the
//     starter's quality starts (6+ innings, 3 or fewer earned runs charged to him)
//   * with `steal` (prepareSteal(), from data/<season>-steal.json), stolen bases by who's running,
//     pitching and catching: before each plate appearance, each runner with the next base open
//     (lead base first) tries for it at his odds; the first one who goes decides the running
//     phase from 2026's running phases with that attempt (double steals and throwing errors come
//     with it). Without an attempt, the running phase is drawn from 2026's without one (wild
//     pitches, balks, pickoffs, ...). Without `steal`, it's the league running game as sim.js has it.
//
// teams[0] is the away team, teams[1] the home team. Each is its pitching:
//   { stages: [{ from, vs, pen }], hook }
// stages[0] is the starter (from 0); each later stage takes over at the plate appearance that
// starts with `from` outs made by this team's pitchers (or, with from "hook", once the hook model
// takes the starter out). `vs` is the OTHER team's nine hitters against that stage, as cumulative
// outcome chances (CATS order). `pen` marks a pooled bullpen (it can take a win and a save in the
// same game: different relievers). A stage may also carry `vsLead`: `vs` for each of park.js's lead
// buckets (BULLPEN_LEAD, by leadBucket() of the pitching side's lead), drawn from by the score as each
// plate appearance begins (game.js gives one to the bullpen). `hook` is sim.js's hook (trees, features, x) for the starter,
// or null. `pitches` is each outcome's pitch count, cumulative by CATS (index 0 is one pitch).
// With `steal`, each team also carries `runners` (its own nine slots' [attempt, success] logit
// effects, flat), `catcher` ([attempt, success]), and each stage `steal` ([attempt, success],
// the pitcher's hand included).
// sim.js is the Lineup Sim's engine: when its ?v= changes there (app.js), change it here too, or the
// two pages load two copies of it
import { CATS, hookChance, rng } from "./sim.js?v=8";
import { leadBucket } from "./park.js?v=3";

const C = Object.fromEntries(CATS.map((c, i) => [c, i]));

// box-score columns, as the result's flat arrays hold them
export const BAT = ["PA", "AB", "R", "H", "2B", "3B", "HR", "RBI", "BB", "HBP", "K", "SF", "SB", "CS", "TB"];
export const PIT = ["G", "OUTS", "BF", "H", "R", "ER", "BB", "HBP", "K", "HR", "NP", "W", "L", "SV", "QS", "SB", "CS"];
const nB = BAT.length, nP = PIT.length;
const B = Object.fromEntries(BAT.map((k, i) => [k, i])), P = Object.fromEntries(PIT.map((k, i) => [k, i]));
// Each box-score count's spread over the games (res.hist): how many games it was 0, 1, 2, ... in one game,
// HIST_BINS buckets, the last holding that many and more; pitches (NP) in buckets of HIST_NP_WIDTH.
// bat[t]: slot x BAT x bucket; batTot[t]: the team's nine together, BAT x bucket; pit[t]: stage x PIT x
// bucket; pitTot[t]: the team's pitchers together, PIT x bucket.
export const HIST_BINS = 41, HIST_NP_WIDTH = 10;

// as sim.js: an inning this long is called off; and a game this long is called a tie
const MAX_INNING_PA = 60;
const MAX_INNINGS = 40;
// the starter's in-game features, as sim.js simulate() fills them (the order there)
const HOOK_IN_GAME = ["pc", "bf_so_far", "outs_so_far", "h_so_far", "hr_so_far", "bb_so_far", "k_so_far", "r_so_far", "tto_next",
  "inning", "outs_in_inn", "inning_end", "runners_after", "margin", "inn_pitches", "inn_runs", "inn_reached", "max_inn_pitches",
  "prev_inn_pitches", "last3_reached"];
const SCORES = 31; // final scores kept up to 30 runs a side

function pick(cum, r) {
  let i = 0;
  while (i < cum.length - 1 && r >= cum[i]) i++;
  return i;
}

// a table cell as sim.js builds them: codes as digit arrays (lead runner first) with cumulative
// chances, keeping only results possible with `outs` out
function cell(entries, outs) {
  const codes = [], weights = [];
  for (const [code, n] of entries) {
    const sf = code.endsWith("s");
    const digits = [...(sf ? code.slice(0, -1) : code)].map(Number);
    const o = digits.filter((d) => d === 0).length;
    if (outs + o > 3) continue;
    codes.push({ digits, sf, runs: digits.filter((d) => d === 4).length, outs: o });
    weights.push(n);
  }
  const total = weights.reduce((a, x) => a + x, 0);
  let acc = 0;
  return { codes, cum: Float64Array.from(weights, (x) => (acc += x) / total), n: total };
}
const TGT = ["2B", "3B", "H"];
const DIFF = 4;
// data/<season>-steal.json as simulateGames() takes it: attempt logits by bases, base and outs
// (NaN where there's no opportunity), the score's, success logits by base and outs, and the
// running-phase cells without an attempt (by bases and outs) and with one (by bases, base, result
// and outs). A cell with no 2026 plays is the attempt alone: the runner takes the base, or is out.
export function prepareSteal(d) {
  const att = new Float64Array(8 * 3 * 3).fill(NaN), suc = new Float64Array(9);
  for (const [k, v] of Object.entries(d.att.cells)) {
    const [mask, t, outs] = k.split(",");
    att[(Number(mask) * 3 + TGT.indexOf(t)) * 3 + Number(outs)] = v;
  }
  for (const [k, v] of Object.entries(d.suc.cells)) {
    const [t, outs] = k.split(",");
    suc[TGT.indexOf(t) * 3 + Number(outs)] = v;
  }
  const other = new Array(24).fill(null), after = new Array(8 * 3 * 2 * 3).fill(null);
  for (let mask = 1; mask < 8; mask++) {
    for (let outs = 0; outs < 3; outs++) {
      // with no 2026 plays at all, everyone stays (each runner's digit is his base)
      const e = d.other[`${mask},${outs}`];
      other[mask * 3 + outs] = cell(e?.length ? e : [[[3, 2, 1].filter((b) => mask >> (b - 1) & 1).join(""), 1]], outs);
      for (let base = 1; base <= 3; base++) {
        if (!(mask >> (base - 1) & 1) || (base < 3 && mask >> base & 1)) continue;
        for (const res of [0, 1]) {
          let e2 = d.after[`${mask},${TGT[base - 1]},${res}`];
          let c = e2?.length ? cell(e2, outs) : null;
          if (!c?.codes.length) {
            // the runner alone: lead runner first, he takes the next base (4: scores) or is out
            const code = [3, 2, 1].filter((b) => mask >> (b - 1) & 1).map((b) => (b === base ? (res ? b + 1 : 0) : b)).join("");
            c = cell([[code, 1]], outs);
          }
          after[((mask * 3 + base - 1) * 2 + res) * 3 + outs] = c;
        }
      }
    }
  }
  return { att, diff: Float64Array.from(d.att.diff), suc, other, after };
}
const logistic = (x) => 1 / (1 + Math.exp(-x));

export function simulateGames(model, teams, games, seed = 1, pitches = null, steal = null) {
  const rand = rng(seed);
  const { running, advance } = model;
  const nS = teams.map((t) => t.stages.length);
  const bat = [new Float64Array(9 * nB), new Float64Array(9 * nB)];
  const pit = nS.map((n) => new Float64Array(n * nP));
  const line = [new Float64Array(10), new Float64Array(10)]; // runs by inning, the 10th on together
  const wins = [0, 0], lob = [0, 0];
  const scoreDist = new Float64Array(SCORES * SCORES);
  const starterOuts = [new Float64Array(28), new Float64Array(28)];
  const caught = [[0, 0], [0, 0]]; // each team's catcher: SB and CS allowed
  let extras = 0, walkoffs = 0, ties = 0, innings = 0, bottom9 = 0, capped = 0;
  const NB = HIST_BINS, hist = { bat: [0, 1].map(() => new Uint32Array(9 * nB * NB)), batTot: [0, 1].map(() => new Uint32Array(nB * NB)),
    pit: nS.map((n) => new Uint32Array(n * nP * NB)), pitTot: [0, 1].map(() => new Uint32Array(nP * NB)) };
  // the counts as the game began (the arrays above run over all games), and one game's team totals
  const was = { bat: bat.map((x) => Float64Array.from(x)), pit: pit.map((x) => Float64Array.from(x)) };
  const gameB = new Float64Array(nB), gameP = new Float64Array(nP);
  const bucket = (n, w) => Math.min(NB - 1, Math.floor(n / w));
  const tally = () => {
    for (let t = 0; t < 2; t++) {
      gameB.fill(0);
      for (let i = 0; i < 9 * nB; i++) {
        const n = bat[t][i] - was.bat[t][i];
        was.bat[t][i] = bat[t][i];
        gameB[i % nB] += n;
        hist.bat[t][i * NB + bucket(n, 1)]++;
      }
      for (let k = 0; k < nB; k++) hist.batTot[t][k * NB + bucket(gameB[k], 1)]++;
      gameP.fill(0);
      for (let i = 0; i < nS[t] * nP; i++) {
        const n = pit[t][i] - was.pit[t][i], k = i % nP;
        was.pit[t][i] = pit[t][i];
        gameP[k] += n;
        hist.pit[t][i * NB + bucket(n, k === P.NP ? HIST_NP_WIDTH : 1)]++;
      }
      for (let k = 0; k < nP; k++) hist.pitTot[t][k * NB + bucket(gameP[k], k === P.NP ? HIST_NP_WIDTH : 1)]++;
    }
  };

  // the bases: who's on (lineup slot, -1 empty), the pitcher (stage) charged if he scores, and
  // whether he's the extra-innings runner
  const slot = [-1, -1, -1, -1], resp = [0, 0, 0, 0], ghost = [false, false, false, false];
  const lead = Array.from({ length: 4 }, () => ({ slot: 0, resp: 0, ghost: false }));

  // the hooked starters' games so far, as simulate() keeps them
  const S = teams.map((t) => {
    const hooks = !!t.hook && t.stages.some((s) => s.from === "hook");
    return { hooks, gone: !hooks, x: hooks ? Float64Array.from(t.hook.x) : null,
      F: hooks ? Object.fromEntries(HOOK_IN_GAME.map((k) => [k, t.hook.features.indexOf(k)])) : null,
      pc: 0, bf: 0, made: 0, h: 0, hr: 0, bb: 0, k: 0, runs: 0, innPitches: 0, innRuns: 0, innReached: 0, maxInn: 0, prevInn: 0, last3: [0, 0, 0] };
  });

  // per game
  const score = [0, 0], up = [0, 0], record = [0, 0], halfLead = [0, 0], halfStage = [0, 0];
  const gOuts = nS.map((n) => new Float64Array(n)), gER = nS.map((n) => new Float64Array(n)), seen = nS.map((n) => new Uint8Array(n));
  let goAhead = null; // the last time a team took the lead: { team, w: its pitcher of record, l: the other's pitcher charged }
  let b = 0, p = 1;   // batting, pitching

  const stageOf = (t, at) => {
    const st = teams[t].stages;
    let s = 0;
    for (let r = 1; r < st.length; r++) if (st[r].from === "hook" ? S[t].gone : at >= st[r].from) s = r;
    return s;
  };
  const scoreRun = (r) => {
    bat[b][r.slot * nB + B.R]++;
    pit[p][r.resp * nP + P.R]++;
    if (!r.ghost) {
      pit[p][r.resp * nP + P.ER]++;
      gER[p][r.resp]++;
    }
    score[b]++;
    if (score[b] === score[p] + 1) goAhead = { team: b, w: record[b], l: r.resp };
  };
  // move the runners (and the batter, when `batter` is a slot) by a drawn outcome; only the
  // first `limit` runs count (a walk-off). Returns the runs that count.
  const move = (o, batter, stage, limit) => {
    let n = 0;
    for (let base = 3; base >= 1; base--) {
      if (slot[base] < 0) continue;
      const r = lead[n++];
      r.slot = slot[base]; r.resp = resp[base]; r.ghost = ghost[base];
    }
    if (batter >= 0) {
      const r = lead[n++];
      r.slot = batter; r.resp = stage; r.ghost = false;
    }
    slot[1] = slot[2] = slot[3] = -1;
    let runs = 0;
    for (let i = 0; i < n; i++) {
      const d = o.digits[i], r = lead[i];
      if (d === 4) {
        if (runs < limit) { runs++; scoreRun(r); }
      } else if (d > 0) {
        slot[d] = r.slot; resp[d] = r.resp; ghost[d] = r.ghost;
      }
    }
    return runs;
  };
  const maskOf = () => (slot[1] >= 0 ? 1 : 0) | (slot[2] >= 0 ? 2 : 0) | (slot[3] >= 0 ? 4 : 0);
  // after one of the starter's plate appearances (or an inning ended on the bases): does he go?
  const boundary = (st, inning, outs, end) => {
    const { x, F } = st;
    x[F.pc] = st.pc; x[F.bf_so_far] = st.bf; x[F.outs_so_far] = st.made; x[F.h_so_far] = st.h; x[F.hr_so_far] = st.hr;
    x[F.bb_so_far] = st.bb; x[F.k_so_far] = st.k; x[F.r_so_far] = st.runs; x[F.tto_next] = Math.floor(st.bf / 9) + 1;
    x[F.inning] = inning + 1; x[F.outs_in_inn] = end ? 0 : outs; x[F.inning_end] = end ? 1 : 0;
    x[F.runners_after] = end ? 0 : (slot[1] >= 0) + (slot[2] >= 0) + (slot[3] >= 0);
    x[F.margin] = score[p] - score[b]; // his team's lead: here it's played
    x[F.inn_pitches] = st.innPitches; x[F.inn_runs] = st.innRuns; x[F.inn_reached] = st.innReached;
    x[F.max_inn_pitches] = st.maxInn; x[F.prev_inn_pitches] = st.prevInn; x[F.last3_reached] = st.last3[0] + st.last3[1] + st.last3[2];
    if (rand() < hookChance(teams[p].hook.trees, x)) st.gone = true;
  };

  // one half-inning; true when it ended the game (a walk-off)
  const half = (inning) => {
    const st = S[p], stages = teams[p].stages, mine = bat[b], arms = pit[p];
    let outs = 0, pas = 0;
    slot[1] = slot[2] = slot[3] = -1;
    if (st.hooks && !st.gone && inning > 0) {
      st.prevInn = st.innPitches;
      st.innPitches = st.innRuns = st.innReached = 0;
    }
    halfLead[p] = score[p] - score[b];
    halfStage[p] = stageOf(p, inning * 3);
    if (inning >= 9) {
      slot[2] = (up[b] + 8) % 9; resp[2] = halfStage[p]; ghost[2] = true;
    }
    const walkoff = b === 1 && inning >= 8;
    const runs0 = score[b];
    let ended = false;
    while (outs < 3) {
      if (++pas > MAX_INNING_PA) { capped++; break; }
      // who's pitching is settled as the plate appearance starts, before any running
      const s = stageOf(p, inning * 3 + outs);
      if (!seen[p][s]) { seen[p][s] = 1; arms[s * nP + P.G]++; }
      record[p] = s;
      const starter = st.hooks && !st.gone, before = score[b], outs0 = outs, A = s * nP;
      let mask = maskOf();
      if (mask) {
        let cr = running[mask * 3 + outs];
        if (steal) {
          // a steal? lead base first; the first runner who goes is the play
          const run = teams[b].runners, ps = teams[p].stages[s].steal, ct = teams[p].catcher;
          const d = steal.diff[Math.max(-DIFF, Math.min(DIFF, score[b] - score[p])) + DIFF];
          let base = 0, safe = 0;
          for (let x = 3; x >= 1; x--) {
            if (!(mask >> (x - 1) & 1) || (x < 3 && mask >> x & 1)) continue;
            const r = slot[x], a = steal.att[(mask * 3 + x - 1) * 3 + outs];
            if (Number.isNaN(a) || rand() >= logistic(a + d + run[2 * r] + ps[0] + ct[0])) continue;
            safe = rand() < logistic(steal.suc[(x - 1) * 3 + outs] + run[2 * r + 1] + ps[1] + ct[1]) ? 1 : 0;
            base = x;
            break;
          }
          if (base) {
            const r = slot[base], k = safe ? "SB" : "CS";
            mine[r * nB + B[k]]++;
            arms[A + P[k]]++;
            caught[p][safe ? 0 : 1]++;
            cr = steal.after[((mask * 3 + base - 1) * 2 + safe) * 3 + outs];
          } else cr = steal.other[mask * 3 + outs];
        }
        const o = cr.codes[pick(cr.cum, rand())];
        move(o, -1, s, walkoff ? score[p] - score[b] + 1 : 99);
        outs += o.outs;
        arms[A + P.OUTS] += o.outs;
        gOuts[p][s] += o.outs;
        if (walkoff && score[b] > score[p]) { ended = true; break; }
        if (outs >= 3) {
          // the inning ended on the bases; this hitter leads off the next
          if (starter) {
            st.made += outs - outs0; st.runs += score[b] - before; st.innRuns += score[b] - before;
            boundary(st, inning, outs, true);
          }
          break;
        }
        mask = maskOf();
      }
      const stage = teams[p].stages[s];
      const i = up[b], cat = pick((stage.vsLead ? stage.vsLead[leadBucket(score[p] - score[b])] : stage.vs)[i], rand());
      const ca = advance[(cat * 8 + mask) * 3 + outs];
      const o = ca.codes[pick(ca.cum, rand())];
      const runs = move(o, i, s, walkoff && cat !== C.HR ? score[p] - score[b] + 1 : 99);
      outs += o.outs;
      const n = pitches ? pick(pitches[cat], rand()) + 1 : 0;
      const H = i * nB;
      mine[H + B.PA]++;
      arms[A + P.BF]++;
      arms[A + P.OUTS] += o.outs;
      arms[A + P.NP] += n;
      gOuts[p][s] += o.outs;
      // no RBI on a ground-ball double play
      if (!(cat === C.GB && o.outs >= 2)) mine[H + B.RBI] += runs;
      let reached = true;
      switch (cat) {
        case C.BB: mine[H + B.BB]++; arms[A + P.BB]++; break;
        case C.HBP: mine[H + B.HBP]++; arms[A + P.HBP]++; break;
        case C.K: mine[H + B.K]++; mine[H + B.AB]++; arms[A + P.K]++; reached = false; break;
        case C["1B"]: mine[H + B.H]++; mine[H + B.TB]++; mine[H + B.AB]++; arms[A + P.H]++; break;
        case C["2B"]: mine[H + B.H]++; mine[H + B["2B"]]++; mine[H + B.TB] += 2; mine[H + B.AB]++; arms[A + P.H]++; break;
        case C["3B"]: mine[H + B.H]++; mine[H + B["3B"]]++; mine[H + B.TB] += 3; mine[H + B.AB]++; arms[A + P.H]++; break;
        case C.HR: mine[H + B.H]++; mine[H + B.HR]++; mine[H + B.TB] += 4; mine[H + B.AB]++; arms[A + P.H]++; arms[A + P.HR]++; break;
        default: if (o.sf) mine[H + B.SF]++; else mine[H + B.AB]++; reached = false;
      }
      up[b] = (i + 1) % 9;
      if (walkoff && score[b] > score[p]) { ended = true; break; }
      if (starter) {
        st.pc += n; st.innPitches += n; if (st.innPitches > st.maxInn) st.maxInn = st.innPitches;
        st.bf++; st.made += outs - outs0; st.runs += score[b] - before; st.innRuns += score[b] - before;
        if (cat === C.BB || cat === C.HBP) st.bb++;
        else if (cat === C.K) st.k++;
        else if (reached) { st.h++; if (cat === C.HR) st.hr++; }
        if (reached) st.innReached++;
        st.last3[st.bf % 3] = reached ? 1 : 0;
        boundary(st, inning, outs, outs >= 3);
      }
    }
    if (!ended) lob[b] += (slot[1] >= 0) + (slot[2] >= 0) + (slot[3] >= 0);
    line[b][Math.min(inning, 9)] += score[b] - runs0;
    return ended;
  };

  for (let g = 0; g < games; g++) {
    score[0] = score[1] = up[0] = up[1] = record[0] = record[1] = 0;
    goAhead = null;
    for (let t = 0; t < 2; t++) {
      gOuts[t].fill(0);
      gER[t].fill(0);
      seen[t].fill(0);
      const st = S[t];
      st.gone = !st.hooks;
      st.pc = st.bf = st.made = st.h = st.hr = st.bb = st.k = st.runs = st.innPitches = st.innRuns = st.innReached = st.maxInn = st.prevInn = 0;
      st.last3[0] = st.last3[1] = st.last3[2] = 0;
    }
    let inning = 0, walked = false, tie = false;
    for (;;) {
      b = 0; p = 1;
      half(inning);
      // from the 9th on, the home team leading after the top: no bottom half
      if (inning >= 8 && score[1] > score[0]) break;
      b = 1; p = 0;
      if (inning === 8) bottom9++;
      if (half(inning)) { walked = true; break; }
      if (inning >= 8 && score[0] !== score[1]) break;
      if (++inning >= MAX_INNINGS) { tie = true; inning--; break; }
    }
    innings += inning + 1;
    if (inning >= 9) extras++;
    if (walked) walkoffs++;
    for (let t = 0; t < 2; t++) {
      starterOuts[t][Math.min(gOuts[t][0], 27)]++;
      // a quality start: the starter goes six innings and is charged with three earned runs or fewer
      // (runners he left on who score after he's gone count against him)
      if (gOuts[t][0] >= 18 && gER[t][0] <= 3) pit[t][P.QS]++;
    }
    scoreDist[Math.min(score[0], SCORES - 1) * SCORES + Math.min(score[1], SCORES - 1)]++;
    if (tie) { ties++; tally(); continue; }
    // decisions: the winner's pitcher of record when it took the lead for good (a starter needs
    // five innings; short of that, the next pitcher), the loser's pitcher charged with that run,
    // and a save for the winner's last pitcher if he pitched all of its last inning with a lead of 1 to 3
    const w = score[0] > score[1] ? 0 : 1, l = 1 - w;
    wins[w]++;
    let ws = goAhead.w;
    if (ws === 0 && gOuts[w][0] < 15 && nS[w] > 1) ws = 1;
    pit[w][ws * nP + P.W]++;
    pit[l][goAhead.l * nP + P.L]++;
    const f = record[w];
    if (halfStage[w] === f && halfLead[w] >= 1 && halfLead[w] <= 3 && (f !== ws || teams[w].stages[f].pen)) pit[w][f * nP + P.SV]++;
    tally();
  }
  return { games, bat: bat.map((x) => Array.from(x)), pit: pit.map((x) => Array.from(x)), line: line.map((x) => Array.from(x)),
    wins, lob, caught, scoreDist: Array.from(scoreDist), starterOuts: starterOuts.map((x) => Array.from(x)),
    extras, walkoffs, ties, innings, bottom9, capped, hist };
}
