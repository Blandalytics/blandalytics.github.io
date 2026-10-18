import { CATS, bullpenOf, cumulative, facing, hitterOf, pitchChances, pitcherOf, prepare, simulate, summarize, tilt } from "./sim.js?v=8";
import { chainTables, expectedLines, expectedLinesMix, hookMix, lineupRuns, matchup, optimize } from "./markov.js?v=7";

const SEASON = 2026;
const SEED = 2026;
const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

// dir: 1 when more is better for the offense, -1 when less is
const STATS = [
  { k: "R", label: "Runs", dir: 1, rate: false },
  { k: "H", label: "Hits", dir: 1, rate: false },
  { k: "HR", label: "Home runs", dir: 1, rate: false },
  { k: "K", label: "Strikeouts", dir: -1, rate: false },
  { k: "BB", label: "Walks", dir: 1, rate: false },
  { k: "AVG", label: "AVG", dir: 1, rate: true },
  { k: "OBP", label: "OBP", dir: 1, rate: true },
  { k: "SLG", label: "SLG", dir: 1, rate: true },
  { k: "wOBA", label: "wOBA", dir: 1, rate: true },
];
const C = Object.fromEntries(CATS.map((c, i) => [c, i]));

let data, model, prior;     // prior: MLB-average outcome chances, for small samples and log5
const entries = new Map(); // id -> { id, kind, name, sub, team, counts, pa, search }
const pitchers = new Map(); // "P<id>" -> { id, mlbam, kind: "pitcher", name, team, throws, counts, cells, pa (BF), gs, startOuts, bulk, search }
let pitcher = null;        // the opposing pitcher; null is MLB-average pitching
let league = null;         // { all, cells }: MLB's outcome chances overall and in each platoon cell ("RL": LHB vs RHP)
const tilted = new Map();  // "sMLB-3@-1.5" -> that spot moved 1.5 SD toward contact
let lineup = [];
let mode = "spots";        // what was loaded: "spots", "most_used" or "tradeoff"
let edited = false;
let basis = "actual";
let last = null;
let sortKey = { k: "R", dir: -1 };

// ---------- formatting ----------
const fmtRate = (x) => x.toFixed(3).replace(/^0/, "");
const fmtStat = (s, x) => (s.rate ? fmtRate(x) : x.toFixed(2));
const fmtDiff = (s, d) => {
  const v = s.rate ? fmtRate(Math.abs(d)) : Math.abs(d).toFixed(2);
  return /[1-9]/.test(v) ? (d > 0 ? "+" : "−") + v : v;
};
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const pct = (x) => (100 * x).toFixed(1) + "%";
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const lastName = (n) => n.split(" ").filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w)).pop();

function wobaOf(counts) {
  const w = data.weights, n = counts.reduce((s, x) => s + x, 0);
  return (w.wBB * counts[C.BB] + w.wHBP * counts[C.HBP] + w.w1B * counts[C["1B"]] + w.w2B * counts[C["2B"]]
    + w.w3B * counts[C["3B"]] + w.wHR * counts[C.HR]) / n;
}

// wOBA on contact: the hits' weights over every ball in play, homers included (FanGraphs'
// AB − SO + SF; the counts' in-play outs already hold the sacrifice flies, and bunts are out)
function wobaconOf(counts) {
  const w = data.weights, hits = counts[C["1B"]] + counts[C["2B"]] + counts[C["3B"]] + counts[C.HR];
  const bip = hits + counts[C.GB] + counts[C.LD] + counts[C.FB] + counts[C.PU];
  return bip ? (w.w1B * counts[C["1B"]] + w.w2B * counts[C["2B"]] + w.w3B * counts[C["3B"]] + w.wHR * counts[C.HR]) / bip : 0;
}

// K%, BB%, AVG, SLG and wOBA of an outcome profile. At-bats need sacrifice flies, which
// the profile folds into fly-ball outs, so they're estimated at the league's rate.
function lineOf(counts) {
  const n = counts.reduce((s, x) => s + x, 0);
  const h = counts[C["1B"]] + counts[C["2B"]] + counts[C["3B"]] + counts[C.HR];
  const tb = counts[C["1B"]] + 2 * counts[C["2B"]] + 3 * counts[C["3B"]] + 4 * counts[C.HR];
  const ab = n - counts[C.BB] - counts[C.HBP] - data.tradeoff.sf_per_fb * counts[C.FB];
  return { K: counts[C.K] / n, BB: counts[C.BB] / n, AVG: h / ab, SLG: tb / ab, wOBA: wobaOf(counts) };
}

// ---------- contact vs power ----------
const tiltId = (base, theta) => `${base}@${(Math.round(theta * 10) / 10).toFixed(1)}`;
const fmtTheta = (t) => (Math.abs(t) < 0.05 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t).toFixed(1)}`);
const fmtStep = (t) => (t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t)}`); // whole steps, for axes and headers

// A lineup id is an entry id, or an MLB spot id with "@theta" for that spot moved along
// the contact-power axis.
function entryOf(id) {
  const at = id.indexOf("@");
  if (at < 0) return entries.get(id);
  if (!tilted.has(id)) {
    const base = entries.get(id.slice(0, at)), theta = Number(id.slice(at + 1));
    if (!base || !base.id.startsWith("sMLB-") || !Number.isFinite(theta) || Math.abs(theta) > data.tradeoff.range) return undefined;
    tilted.set(id, { ...base, id, base: base.id, theta, counts: tilt(base.counts, data.tradeoff.per_sd, theta) });
  }
  return tilted.get(id);
}

// A contact-power setting's color, for the sliders and the optimizer's chart: white at 0,
// blending toward the brand teal at the contact end and the brand amber at the power end
// (--contact and --power in index.html), all the way there at the end of the range.
let tiltEnds = null;
function tiltColor(theta) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  tiltEnds ??= ["--contact", "--power"].map((v) => rgb(getComputedStyle(document.documentElement).getPropertyValue(v).trim()));
  const f = Math.max(-1, Math.min(1, theta / data.tradeoff.range)), end = tiltEnds[f < 0 ? 0 : 1];
  return `rgb(${end.map((c) => Math.round(255 + (c - 255) * Math.abs(f))).join(", ")})`;
}
function tintRange(range, theta) {
  range.style.accentColor = tiltColor(theta);
}

const labelOf = (e) => (e.theta ? `${e.name}, ${e.theta < 0 ? "contact" : "power"} ${Math.abs(e.theta).toFixed(1)}` : e.name);

// ---------- the modeled hook ----------
// data/<season>-hook.json (pipeline/hook_model.py): the hook model's trees, pitches per plate
// appearance by outcome, and each 2026 starter's before-the-game values for a typical start of
// his. Loaded the first time "Modeled hook" is picked. A start goes in at normal rest, with no
// outings in the days before and not just back from the injured list.
let hookData = null;
async function loadHookData() {
  if (hookData) return;
  const r = await fetch(`data/${SEASON}-hook.json?v=1`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const t = d.trees;
  const probs = (c) => { const n = c.reduce((a, x) => a + x, 0); return c.map((x) => x / n); };
  // the parts of simulate()'s `hook` that are the same for every starter (a worker gets them once)
  d.fixed = { trees: { feat: Int32Array.from(t.feat), thr: Float64Array.from(t.thr), dl: Uint8Array.from(t.dl), miss: Uint8Array.from(t.miss),
    left: Int32Array.from(t.left), right: Int32Array.from(t.right), leaf: Float64Array.from(t.leaf), roots: Int32Array.from(t.roots) },
    features: d.features, pitches: CATS.map((c) => cumulative(probs(d.pitches[c]))), runsPerInning: d.runs_per_inning };
  const rows = Object.values(d.pitchers);
  d.avgPitches = rows.reduce((a, v) => a + v[5] * v[7], 0) / rows.reduce((a, v) => a + v[7], 0);
  hookData = d;
}
// what simulate() takes as `hook` for a starter: his typical start's values (an MLB-average RHP
// or LHP: the league's)
function hookOf(e) {
  const H = hookData, own = !e.generic && H.pitchers[e.mlbam];
  const x = new Float64Array(H.features.length).fill(NaN);
  const set = (k, v) => { x[H.features.indexOf(k)] = v; };
  for (const [k, v] of Object.entries(H.defaults)) set(k, v);
  set("team_start_outs", (own && H.teams[own[4]]) || H.league.team_start_outs);
  ["max3", "max5", "mean3", "starts_season"].forEach((k, i) => set(k, own ? own[i] : H.league[k]));
  return { ...H.fixed, x };
}
const hooked = (vs) => !!vs?.relief.some((r) => r.from === "hook");
// a run's own hook outs, as the exact numbers average over them
const hookMixOf = (res) => (res?.hook ? hookMix(res.hook.outs) : null);
// where a run's games took him out on average, in outs
const hookOuts = (h) => Math.round(h.outs.reduce((a, c, i) => a + c * i, 0) / h.games);
// the pitching with the hook at a set out, for the optimizer: where this lineup's games took him out on average
function hookFixed(vs) {
  if (!hooked(vs)) return vs;
  const h = last?.key === vsKey() ? last.res.hook : null;
  const at = h ? hookOuts(h) : startOutsOf(pitcher);
  return { ...vs, relief: vs.relief.map((r) => (r.from === "hook" ? { ...r, from: at } : r)) };
}

// ---------- the per-pitch model ----------
// "Per-PA (observed)", the default, draws each plate appearance from the hitter's and pitcher's
// 2026 rates (log5). "Per-Pitch (modeled)" builds it pitch by pitch, count by count (sim.js
// pitchChances()), from data/<season>-pitch.json (pipeline/pitch_model.py): the league's chances
// at each step and each player's ratios to them. That file loads the first time it's picked.
const MODELS = { pa: "Per-PA (observed)", pitch: "Per-Pitch (modeled)" };
let byPitch = false;
let wantPitch = false;      // the link asked for it (readHash), before the file is loaded
let pitchData = null;
async function loadPitchData() {
  if (pitchData) return;
  const r = await fetch(`data/${SEASON}-pitch.json?v=1`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  d.tables = Object.fromEntries(Object.entries(d.tables).map(([k, steps]) => [k, steps.map((t) => Float64Array.from(t))]));
  pitchData = d;
}
// A hitter's, spot's, pitcher's or bullpen's ratios as facing() takes them: overall, against the
// league in the cells he played in, and (with each player's own splits) in each cell he played in.
// No ratios at all is MLB average.
const NO_RATIOS = { all: null, gap: null, cells: null };
const pitchSide = (r, mode) => (r ? { all: r.a, gap: r.g, cells: mode === "own" && r.c ? r.c : null } : NO_RATIOS);

// ---------- the hypothetical pitcher (Scrub - Average - Ace) ----------
// data/<season>-quality.json (pipeline/quality_axis.py): each model's pitcher-quality axis, in
// standard deviations of 2026 pitchers' talent (wOBA allowed, net of luck; the ace end +). An
// MLB-average RHP or LHP moved along it ("quality"): with the per-PA model his rates, and each
// platoon cell's, move by quality times pa.per_sd; with the per-pitch model he's the ratios
// exp(s * pitch.slope), s set for each tenth so that the count chain's wOBA allowed is as many
// talent SDs from average. At 0 he's the MLB-average pitcher, unmoved.
let quality = null;
const hypos = new Map();    // "PRHP@1.5" -> the MLB-average RHP moved 1.5 toward the Ace end: "Hypothetical RHP (Ace 1.5)"
function hypothetical(hand, q) {
  const base = pitchers.get(`P${hand}HP`);
  if (!quality || Math.abs(q) < 0.05) return base;
  const id = `${base.id}@${q.toFixed(1)}`;
  if (!hypos.has(id)) {
    const move = (c) => tilt(c, quality.pa.per_sd, q).map((x) => x * countOf(c));
    hypos.set(id, { ...base, id, quality: Math.round(q * 10) / 10, name: `Hypothetical ${hand}HP (${q > 0 ? "Ace" : "Scrub"} ${Math.abs(q).toFixed(1)})`,
      counts: move(base.counts), cells: { L: move(base.cells.L), R: move(base.cells.R) } });
  }
  return hypos.get(id);
}
// his per-pitch ratios (null: MLB average)
function hypoRatios(e) {
  if (!e.quality) return null;
  const P = quality.pitch, s = P.steps[Math.round((e.quality + quality.range) * 10)];
  const a = P.slope.map((x) => Math.exp(s * x));
  return { a, g: a, c: null };
}
// a pitcher's name in short: his surname, or an MLB-average or hypothetical one's hand (and setting)
// a file name's piece: "RHP (Ace 1.5)" -> "rhp_ace_1_5"
const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const pShort = (name) => (/^(MLB-average|Hypothetical) /.test(name) ? name.replace(/^(MLB-average|Hypothetical) /, "") : lastName(name));

// ---------- data ----------
function buildEntries() {
  const nameOf = new Map();
  // pa: the plate appearances shown (official, with IBB and bunts); the rates use counts
  for (const [id, name, team, counts, pa, cells, bats] of data.players) {
    nameOf.set(id, name);
    const side = { L: "bats L", R: "bats R", S: "switch" }[bats];
    entries.set(`p${id}`, { id: `p${id}`, kind: "player", name, team, counts, pa, cells, bats,
      sub: [team, side].filter(Boolean).join(" · "), search: fold(name) });
  }
  const spotsOf = (abbr, label, short, spots) => spots.forEach((s, i) => {
    const pa = s.counts.reduce((a, x) => a + x, 0);
    const who = abbr === "MLB" ? ""
      : s.top.map(([pid, n]) => `${lastName(nameOf.get(pid) ?? String(pid))} ${Math.round((100 * n) / pa)}%`).join(", ");
    entries.set(`s${abbr}-${i + 1}`, { id: `s${abbr}-${i + 1}`, kind: "spot", name: `${label} · ${ordinal(i + 1)} spot`,
      team: abbr, counts: s.counts, cells: s.cells, pa, sub: who,
      search: fold(`${label} ${short} ${abbr} ${i + 1} spot`) });
  });
  spotsOf("MLB", "MLB", "mlb league average", data.mlb.spots);
  for (const t of data.teams) spotsOf(t.abbr, t.short, `${t.name} ${t.abbr}`, t.spots);
  const totals = data.mlb.spots.reduce((acc, s) => acc.map((x, i) => x + s.counts[i]), CATS.map(() => 0));
  const n = totals.reduce((s, x) => s + x, 0);
  prior = totals.map((x) => x / n);
  // bulk: his outings of 3+ innings (starts or relief), for the follower box
  for (const [id, name, team, throws, counts, bf, gs, startOuts, cells, bulk] of data.pitchers) {
    pitchers.set(`P${id}`, { id: `P${id}`, mlbam: id, kind: "pitcher", name, team, throws, counts, cells, pa: bf, gs, startOuts, bulk,
      search: fold(`${name} ${team}`) });
  }
  const scaled = (c) => { const t = c.reduce((a, x) => a + x, 0); return c.map((x) => x / t); };
  league = { all: prior, cells: Object.fromEntries(Object.entries(data.pitching.cells).map(([k, c]) => [k, scaled(c)])) };
  // an MLB-average right- or left-hander: every 2026 pitcher of that hand pooled
  for (const hand of ["R", "L"]) {
    const cells = { L: data.pitching.cells[hand + "L"], R: data.pitching.cells[hand + "R"] };
    const counts = cells.L.map((x, i) => x + cells.R[i]);
    const own = data.pitchers.filter((r) => r[3] === hand);
    pitchers.set(`P${hand}HP`, { id: `P${hand}HP`, mlbam: `${hand}HP`, kind: "pitcher", generic: true, name: `MLB-average ${hand}HP`,
      team: "MLB", throws: hand, counts, cells, pa: counts.reduce((a, x) => a + x, 0),
      gs: own.reduce((t, r) => t + r[6], 0), startOuts: own.reduce((t, r) => t + r[7], 0), bulk: 0,
      search: fold(`mlb average ${hand}hp ${hand === "R" ? "right handed righty" : "left handed lefty"} pitcher`) });
  }
}

function teamOf(abbr) {
  return data.teams.find((t) => t.abbr === abbr);
}

// ---------- lineup loading ----------
function fillTeams() {
  const sel = $("team");
  sel.add(new Option("MLB", "MLB"));
  for (const lg of ["American", "National"]) {
    const g = document.createElement("optgroup");
    g.label = `${lg} League`;
    data.teams.filter((t) => t.league === lg).sort((a, b) => a.name.localeCompare(b.name))
      .forEach((t) => g.append(new Option(t.name, t.abbr)));
    sel.append(g);
  }
}

function loadPreset() {
  const kindSel = $("kind");
  // contact vs power works on the MLB spots
  if (kindSel.value === "tradeoff") $("team").value = "MLB";
  const abbr = $("team").value;
  kindSel.querySelector("[value=most_used]").disabled = abbr === "MLB";
  if (abbr === "MLB" && kindSel.value === "most_used") kindSel.value = "spots";
  const kind = kindSel.value;
  mode = kind;
  if (kind === "tradeoff") {
    const theta = Number($("tilt_all").value);
    lineup = Array.from({ length: 9 }, (_, i) => tiltId(`sMLB-${i + 1}`, theta));
    // the differences are small; fewer games would bury them in noise
    if (Number($("games").value) < 50000) $("games").value = "50000";
  } else if (kind === "spots") {
    lineup = Array.from({ length: 9 }, (_, i) => `s${abbr}-${i + 1}`);
  } else {
    const t = teamOf(abbr), mu = t.most_used, o = mu.orders[0];
    lineup = o.ids.map((id) => `p${id}`);
    const when = new Date(o.last + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tie = mu.orders.length > 1 && mu.orders[1].uses === o.uses ? " (tied; the most recent of them)" : "";
    // on hover: how often they used it
    kindSel.title = `${t.short}' most-used order${tie}: started ${o.uses} of ${mu.games} games, last on ${when}. `
      + `They used ${mu.distinct} different orders.`;
  }
  if (kind !== "most_used") kindSel.title = "";
  edited = false;
  renderLineup();
  run();
}

// ---------- lineup table ----------
// columns after the hitter: [header, class, value(entry)]; contact vs power shows the
// stats the tradeoff moves, with wOBA last to show it holding still
// value(entry, c): c is the hitter's outcomes as shownOf() has them. wOBA (class woba) is
// the one in full white.
const COLS = {
  normal: [
    ["PA", "opt2", (e) => paShown(e).toLocaleString()],
    ["K%", "opt", (e, c) => pct(lineOf(c).K)],
    ["BB%", "opt", (e, c) => pct(lineOf(c).BB)],
    ["wOBAcon", "opt", (e, c) => fmtRate(wobaconOf(c))],
    ["wOBA", "woba", (e, c) => fmtRate(wobaOf(c))],
  ],
  tradeoff: [
    ["K%", "opt2", (e, c) => pct(lineOf(c).K)],
    ["BB%", "opt", (e, c) => pct(lineOf(c).BB)],
    ["AVG", "opt", (e, c) => fmtRate(lineOf(c).AVG)],
    ["SLG", "opt", (e, c) => fmtRate(lineOf(c).SLG)],
    ["wOBA", "woba", (e, c) => fmtRate(wobaOf(c))],
  ],
};
const cols = () => COLS[mode === "tradeoff" ? "tradeoff" : "normal"];

// With each player's own splits against a pitcher, the PA column counts plate
// appearances against his hand (the ones his rates there come from).
const splitHand = () => (pitcher && $("platoon").value === "own" ? (pitcher.throws === "L" ? "L" : "R") : null);
function paShown(e) {
  const h = splitHand(), b = e.base ? entries.get(e.base) : e;
  if (!h || !b.cells) return e.pa;
  return Object.entries(b.cells).reduce((t, [k, c]) => (k[0] === h ? t + c.reduce((a, x) => a + x, 0) : t), 0);
}

function renderLineup() {
  $("tradeoff_ctl").hidden = mode !== "tradeoff";
  const head = $("slots_head");
  head.replaceChildren();
  for (const [text, cls] of [["#", ""], ["Hitter", ""], ...cols().map(([h, c]) => [h, c]), ["Order", ""]]) {
    const th = document.createElement("th");
    th.scope = "col";
    if (text === "Order") {
      // the buttons stay on phones; only the header word goes
      const span = document.createElement("span");
      span.className = "opt";
      span.textContent = text;
      th.append(span);
    } else {
      th.textContent = text === "PA" && splitHand() ? `PA v ${splitHand()}HP` : text;
    }
    if (cls) th.className = cls;
    head.append(th);
  }
  const body = $("slots");
  body.replaceChildren();
  lineup.forEach((id, i) => {
    const e = entryOf(id);
    const tr = document.createElement("tr");
    const small = e.kind === "player" && paShown(e) < 100;
    tr.innerHTML = `<td class="spot">${i + 1}</td>
      <td class="who"><div class="suggest">
        <input type="text" size="1" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-controls="sug_${i}" aria-label="Hitter batting ${ordinal(i + 1)}">
        <ul id="sug_${i}" class="suggest-list" role="listbox" hidden></ul></div>
        <span class="who-sub"></span></td>
      ${cols().map(([, c]) => `<td class="stat num ${c}"></td>`).join("")}
      <td class="move"><button type="button" aria-label="Move up">↑</button> <button type="button" aria-label="Move down">↓</button></td>`;
    const input = tr.querySelector("input");
    input.value = e.name;
    tr.querySelector(".who-sub").textContent = e.sub;
    tr.querySelector(".who-sub").hidden = !e.sub;
    if (small && mode !== "tradeoff") {
      const pa = tr.querySelectorAll("td.stat")[0];
      pa.classList.add("small");
      pa.title = splitHand() ? `Small sample against ${splitHand()}HP: consider adding MLB-average PA below, or league-average platoon gaps`
        : "Small sample: consider adding MLB-average PA below";
    }
    if (e.theta != null) addTiltControl(tr, i);
    fillRow(tr, e);
    const [up, down] = tr.querySelectorAll(".move button");
    up.disabled = i === 0;
    down.disabled = i === 8;
    up.addEventListener("click", () => swap(i, i - 1));
    down.addEventListener("click", () => swap(i, i + 1));
    wireSuggest(input, tr.querySelector("ul"), {
      find: (q) => {
        const { players, spots } = matches(q);
        return [["2026 hitters", players], ["Lineup spots", spots]];
      },
      choose: (e) => {
        lineup[i] = mode === "tradeoff" && e.id.startsWith("sMLB-") ? tiltId(e.id, 0) : e.id;
        edited = true;
        renderLineup();
        run();
      },
      current: () => entryOf(lineup[i]).name,
    });
    body.append(tr);
  });
  renderOptimizer();
}

function fillRow(tr, e) {
  const cells = tr.querySelectorAll("td.stat"), c = shownOf(e);
  cols().forEach(([, , value], j) => { cells[j].textContent = value(e, c); });
  const line = tr.querySelector(".tilt-line");
  if (line) {
    const l = lineOf(c);
    // phones only (the columns are hidden there); wOBA keeps its own column
    line.textContent = `K ${pct(l.K)} · BB ${pct(l.BB)} · AVG ${fmtRate(l.AVG)} · SLG ${fmtRate(l.SLG)}`;
  }
}

// a Contact–Power slider under a tilted spot's name
function addTiltControl(tr, i) {
  const e = entryOf(lineup[i]);
  const box = document.createElement("div");
  box.className = "tilt";
  box.innerHTML = `<span>Contact</span><input type="range" step="0.1"><span>Power</span><output></output>`;
  const range = box.querySelector("input"), out = box.querySelector("output");
  range.min = -data.tradeoff.range;
  range.max = data.tradeoff.range;
  range.value = e.theta;
  tintRange(range, e.theta);
  range.setAttribute("aria-label", `Contact to power, ${ordinal(i + 1)} spot`);
  out.textContent = fmtTheta(e.theta);
  range.addEventListener("input", () => {
    setTilt(i, Number(range.value));
    scheduleRun();
  });
  const line = document.createElement("span");
  line.className = "tilt-line";
  tr.querySelector("td.who").append(box, line);
}

// move slot i to `theta`, updating its row in place (re-rendering would drop the drag)
function setTilt(i, theta) {
  const e = entryOf(lineup[i]);
  if (e?.theta == null) return;
  lineup[i] = tiltId(e.base, theta);
  const tr = $("slots").rows[i];
  const range = tr.querySelector(".tilt input");
  if (Number(range.value) !== theta) range.value = theta;
  tintRange(range, theta);
  tr.querySelector(".tilt output").textContent = fmtTheta(theta);
  fillRow(tr, entryOf(lineup[i]));
}

let runTimer = 0;
function scheduleRun() {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, 150);
}

function swap(i, j) {
  [lineup[i], lineup[j]] = [lineup[j], lineup[i]];
  edited = true;
  renderLineup();
  run();
  document.querySelectorAll("#slots tr")[j]?.querySelectorAll(".move button")[j < i ? 0 : 1]?.focus();
}

function matches(q) {
  const f = fold(q.trim());
  if (!f) return { players: [], spots: [] };
  const words = f.split(/\s+/);
  const hit = (e) => words.every((w) => e.search.includes(w));
  const players = [], spots = [];
  for (const e of entries.values()) {
    if (!hit(e)) continue;
    (e.kind === "player" ? players : spots).push(e);
  }
  const starts = (e) => (e.search.split(" ").some((w) => w.startsWith(words[0])) ? 0 : 1);
  players.sort((a, b) => starts(a) - starts(b) || b.pa - a.pa);
  return { players: players.slice(0, 25), spots: spots.slice(0, 18) };
}

// what a suggestion shows beside the name
const smallOf = (e) => (e.kind === "player" ? `${e.team} · ${e.pa} PA · ${fmtRate(wobaOf(e.counts))}`
  : e.kind === "pitcher" ? `${e.team} · ${e.pa} BF · ${fmtRate(wobaOf(e.counts))}`
  : `${e.pa.toLocaleString()} PA · ${fmtRate(wobaOf(e.counts))}`);

// A search box with a list of suggestions: find(query) gives [heading, entries] sections,
// choose(entry) takes one, current() is what the box shows when it isn't being typed in.
// With browse, focusing the box lists find("") before anything is typed; small(entry)
// is the caption beside each name.
function wireSuggest(input, list, { find, choose: take, current, browse = false, small = smallOf }) {
  let items = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const choose = (e) => {
    close();
    take(e);
  };
  const paint = () => {
    list.querySelectorAll("li[role=option]").forEach((li, i) => {
      li.classList.toggle("active", i === active);
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      if (i === active) li.scrollIntoView({ block: "nearest" });
    });
  };
  const open = () => {
    const sections = find(browse && input.value === current() ? "" : input.value);
    items = sections.flatMap(([, arr]) => arr);
    list.replaceChildren();
    const section = (title, arr) => {
      if (!arr.length) return;
      const h = document.createElement("li");
      h.className = "head";
      h.setAttribute("role", "presentation");
      h.textContent = title;
      list.append(h);
      for (const e of arr) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        const name = document.createElement("span");
        name.textContent = e.name;
        const cap = document.createElement("small");
        cap.textContent = small(e);
        li.append(name, cap);
        li.addEventListener("pointerdown", (ev) => { ev.preventDefault(); choose(e); });
        list.append(li);
      }
    };
    for (const [title, arr] of sections) section(title, arr);
    list.hidden = !items.length;
    input.setAttribute("aria-expanded", items.length ? "true" : "false");
    active = items.length ? 0 : -1;
    paint();
  };
  input.addEventListener("focus", () => {
    input.select();
    if (browse) open();
  });
  // a phone's keyboard covers the bottom half, and the list opens below the box: bring the box to the top
  input.addEventListener("focus", () => {
    if (matchMedia("(pointer: coarse)").matches) setTimeout(() => input.scrollIntoView({ block: "start" }), 300);
  });
  input.addEventListener("input", open);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (list.hidden) open();
      if (!items.length) return;
      ev.preventDefault();
      active = (active + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (ev.key === "Enter") {
      if (!list.hidden && items[active]) { ev.preventDefault(); choose(items[active]); }
    } else if (ev.key === "Escape") {
      close();
      input.value = current();
    }
  });
  input.addEventListener("blur", () => { close(); input.value = current(); });
}

// ---------- the opposing pitcher ----------
// He starts, and "He pitches" says who takes over and when (outs into the game):
//   game       he pitches all nine innings
//   start      his average 2026 start, then his team's bullpen (start_mlb: MLB's bullpen)
//   bullpen    a bullpen day: he opens for a typical 2026 opener's outs, then his team's bullpen
//   follower   he opens, a follower (picked, or MLB-average bulk relief) pitches a typical
//              follower's outs, then his team's bullpen
//   hook       he starts until the hook model takes him out (sim.js simulate()), then his
//              team's bullpen; the exact numbers average over where the simulation took him out
// An MLB-average RHP or LHP has MLB's bullpen. data.pitching has the typical outs, each
// team's relievers and the bulk relief.
let follower = null;       // the follower picked for "follower"; null is MLB-average bulk relief
const fmtIP = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
const startOutsOf = (e) => Math.round(e.startOuts / e.gs);
const penTeam = () => (pitcher && !pitcher.generic && data.pitching.teams[pitcher.team] ? pitcher.team : "MLB");
const cellsTotal = (cells) => Object.values(cells).reduce((t, c) => t.map((x, i) => x + c[i]), CATS.map(() => 0));
// [{ who: "pen" | "mlb" | "follower", from }], in order; empty for all nine innings
function planOf() {
  const m = pitcher ? $("p_hook").value : "game", op = data.pitching.opener.outs;
  if ((m === "start" || m === "start_mlb") && pitcher.gs) return [{ who: m === "start" ? "pen" : "mlb", from: startOutsOf(pitcher) }];
  if (m === "bullpen") return [{ who: "pen", from: op }];
  if (m === "follower") return [{ who: "follower", from: op }, { who: "pen", from: op + data.pitching.follower.outs }];
  if (m === "hook" && pitcher.gs) return [{ who: "pen", from: "hook" }];
  return [];
}
// The pitching in words: "Skubal for 6.0 innings, then the Tigers bullpen", "Skubal opening
// (1.0 IP), then Mize (4.1 IP), then the Tigers bullpen"; short: "Skubal + Mize + bullpen".
// With the modeled hook, hookAt (outs, once a run has them) is where he went out on average:
// "Skubal (Modeled Start: ~5.2IP), then the Tigers bullpen".
function planWords(full = false, hookAt = null) {
  if (!pitcher) return { words: "MLB-average pitching", short: "MLB-average pitching" };
  const who = full ? pitcher.name : pShort(pitcher.name), plan = planOf();
  const pen = (st) => (st.who === "mlb" || penTeam() === "MLB" ? "the MLB bullpen" : `the ${teamOf(penTeam()).short} bullpen`);
  if (!plan.length) return { words: `${who} for all nine innings`, short: who };
  if (plan[0].who === "follower") {
    const f = follower ? (full ? follower.name : lastName(follower.name)) : "MLB bulk relief";
    return { words: `${who} opening (${fmtIP(plan[0].from)} IP), then ${f} (${fmtIP(plan[1].from - plan[0].from)} IP), then ${pen(plan[1])}`,
      short: `${who} + ${follower ? lastName(follower.name) : "bulk"} + bullpen` };
  }
  if (plan[0].from === "hook") {
    const start = hookAt == null ? "until the modeled hook," : `(Modeled Start: ~${fmtIP(hookAt)}IP),`;
    return { words: `${who} ${start} then ${pen(plan[0])}`, short: `${who} + bullpen` };
  }
  return { words: $("p_hook").value === "bullpen" ? `${who} opening (${fmtIP(plan[0].from)} IP), then ${pen(plan[0])}`
    : `${who} for ${fmtIP(plan[0].from)} innings, then ${pen(plan[0])}`, short: `${who} + bullpen` };
}
const handOf = (e) => ({ L: "LHP", R: "RHP" })[e.throws] ?? "P";
const countOf = (c) => (c ? c.reduce((a, x) => a + x, 0) : 0);
// platoon splits only come into it once a pitcher (and so a hand) is picked
const platoonOf = () => (pitcher ? $("platoon").value : "off");

// What the matchups need (markov.js's `vs`): the starter's pitching, and each later stage's
// from the outs it takes over at, as facing() takes them (sim.js); null against MLB-average
// pitching. Small samples adds MLB-average batters faced to a pitcher as it adds PA to a hitter.
function vsOf() {
  if (!pitcher) return null;
  const mode = $("platoon").value, regress = Number($("regress").value);
  // with the per-pitch model, each stretch of pitching carries its ratios too (r: () => them)
  const withPitch = (pitching, r) => (byPitch ? pitching.map((c) => ({ ...c, pitch: pitchSide(r(), mode) })) : pitching);
  const arm = (e) => withPitch(pitcherOf(e.counts, e.cells, e.throws, { mode, league, regress: e.generic ? 0 : regress }),
    () => (e.generic ? hypoRatios(e) : pitchData.pitchers[e.mlbam]));
  const pen = (cells, key) => withPitch(bullpenOf(cellsTotal(cells), cells, { mode, league }), () => pitchData.pens[key]);
  const of = { pen: () => pen(penTeam() === "MLB" ? data.pitching.relief_cells : data.pitching.teams[penTeam()], penTeam()),
    mlb: () => pen(data.pitching.relief_cells, "MLB"), follower: () => (follower ? arm(follower) : pen(data.pitching.bulk.cells, "bulk")) };
  return { sp: arm(pitcher), relief: planOf().map((st) => ({ from: st.from, pitching: of[st.who]() })) };
}
// everything vsOf() depends on, and the model: results computed against one key don't fit another
const vsKey = () => (pitcher ? [pitcher.id, planOf().map((st) => `${st.who}@${st.from}`).join(","),
  $("p_hook").value === "follower" ? follower?.id ?? "bulk" : "", $("regress").value, $("platoon").value, byPitch ? "pitch" : "pa"].join("|")
  : byPitch ? "pitch" : "");

// A lineup entry as facing() takes it: its own outcome chances (Small samples applied to
// hitters), split by platoon cell once a pitcher is picked. A tilted MLB spot comes moved
// along the contact-power axis, or, with tilted false, as the spot is at 0. With the per-pitch
// model it carries its ratios (`pitch`) and its setting, which facing() applies to the chain's outcomes.
function specOf(e, tilted = true) {
  const b = e.base ? entries.get(e.base) : e;
  const h = hitterOf(b.counts, b.cells, { mode: platoonOf(), league, regress: b.kind === "player" ? Number($("regress").value) : 0, bats: b.bats });
  if (byPitch) {
    const r = (b.kind === "player" ? pitchData.hitters : pitchData.spots)[b.id.slice(1)];
    return { ...h, pitch: { tables: pitchData.tables, ...pitchSide(r, platoonOf()), theta: tilted ? e.theta ?? 0 : 0,
      perSd: data.tradeoff.per_sd } };
  }
  if (!tilted || !e.theta) return h;
  const mv = (x) => tilt(x, data.tradeoff.per_sd, e.theta);
  return { all: mv(h.all), parts: h.parts && Object.fromEntries(Object.entries(h.parts).map(([k, ps]) => [k, ps.map((q) => ({ ...q, b: mv(q.b) }))])) };
}

// a hitter's outcomes as the lineup table shows them: 2026 rates (the per-pitch model's, against
// MLB-average pitching), or against the pitcher (his own innings, not the bullpen's)
function shownOf(e, vs = vsOf()) {
  return vs || byPitch ? facing(specOf(e), vs?.sp ?? null) : e.counts;
}

function findPitchers(q) {
  const f = fold(q.trim());
  if (!f) return quality ? [["Hypothetical pitcher · Scrub to Ace", ["R", "L"].map((h) => pitchers.get(`P${h}HP`))]] : [];
  const words = f.split(/\s+/);
  const list = [...pitchers.values()].filter((e) => words.every((w) => e.search.includes(w)));
  const starts = (e) => (e.search.split(" ").some((w) => w.startsWith(words[0])) ? 0 : 1);
  list.sort((a, b) => starts(a) - starts(b) || b.pa - a.pa);
  return [["2026 pitchers", list.slice(0, 25)]];
}

// The follower box: the opener's team's bulk arms first (most outings of 3+ innings; all of
// MLB's for an MLB-average RHP or LHP), then any 2026 pitcher that matches.
function findFollowers(q) {
  const team = penTeam(), f = fold(q.trim()), words = f ? f.split(/\s+/) : [];
  const arms = [...pitchers.values()].filter((e) => !e.generic && e !== pitcher && e.bulk > 0 && (team === "MLB" || e.team === team)
    && words.every((w) => e.search.includes(w))).sort((a, b) => b.bulk - a.bulk).slice(0, f ? 10 : 25);
  const head = `${team === "MLB" ? "MLB" : teamOf(team).short} bulk arms · outings of 3+ IP`;
  if (!f) return [[head, arms]];
  return [[head, arms], ["2026 pitchers", (findPitchers(q)[0]?.[1] ?? []).filter((e) => !e.generic && e !== pitcher && !arms.includes(e))]];
}
const followerSmall = (e) => `${e.team} · ${e.bulk} of 3+ IP · ${fmtRate(wobaOf(e.counts))}`;

function setFollower(e) {
  follower = e;
  renderPitcher();
  run();
}

// the hypothetical pitcher's slider: him at `q`, the table's rates against him with it
function setQuality(q) {
  if (!pitcher?.generic) return;
  pitcher = hypothetical(pitcher.throws, q);
  renderPitcher();
  renderLineup();
}
// How it works: the quality axes in numbers
function fillQualityWords() {
  const per = (v) => ["K", "BB", "HR", "1B"].map((k) => `${v[C[k]] > 0 ? "+" : "−"}${Math.abs(100 * v[C[k]]).toFixed(1)} ${k}`).join(", ");
  const ends = (list) => list.map(([, name, score], i) => (i ? lastName(name) : `${lastName(name)} (${fmtTheta(score)})`)).join(", ");
  const w = quality.pa.woba, sd = quality.pa.sd, R = quality.range;
  $("q_n").textContent = quality.pa.pitchers.toLocaleString();
  $("q_obs").textContent = fmtRate(quality.pa.observed_sd).replace(/^0/, "");
  $("q_sd").textContent = fmtRate(sd).replace(/^0/, "");
  $("q_pa").textContent = per(quality.pa.per_sd);
  $("q_pitch").textContent = per(quality.pitch.per_sd);
  $("q_range").textContent = R.toFixed(1);
  $("q_ace").textContent = `a ${fmtRate(w - R * sd)} wOBA allowed, near ${ends(quality.ends.ace)}`;
  $("q_scrub").textContent = `${fmtRate(w + R * sd)}, near ${ends(quality.ends.scrub)}`;
}

function setPitcher(e) {
  pitcher = e;
  // a follower stays with an opener from his own team (or an MLB-average one)
  if (follower && (!e || follower === e || (!e.generic && e.team !== follower.team))) follower = null;
  // like for like: the teams' lineup spots against him too
  if (e && basis !== "sim") {
    basis = "sim";
    paintBasis();
  }
  renderPitcher();
  renderLineup();
  run();
}

// "He pitches" labels, longest first: the closed select shows the longest that fits its
// width, so a phone gets "As opener, with follower" where a wide screen gets the innings and
// the team ("As opener, with follower (1.0 + 4.1 IP), then Dodgers bullpen"). A folded card's select
// has no width; a ResizeObserver (boot) labels it again whenever its width changes, as when the
// card opens, and once fonts load.
let measure = null;
function fitHookLabels() {
  const sel = $("p_hook"), room = sel.clientWidth - 40; // its padding and arrow
  if (!data || room <= 0) return;
  const team = pitcher && penTeam() !== "MLB" ? teamOf(penTeam()).short : null, pen = `${team ?? "MLB"} bullpen`;
  const ip = pitcher?.gs ? ` (${fmtIP(startOutsOf(pitcher))} IP)` : "";
  const op = fmtIP(data.pitching.opener.outs), fo = fmtIP(data.pitching.follower.outs);
  // three levels of detail, every option at the same one: the most detailed at which they all fit
  const labels = {
    start: [`Average start${ip}, then ${pen}`, `Average start, then ${pen}`, `Average start, then ${team ? "team" : "MLB"} bullpen`],
    start_mlb: [`Average start${ip}, then MLB bullpen`, "Average start, then MLB bullpen", "Average start, then MLB bullpen"],
    bullpen: [`Bullpen day: opener (${op} IP), then ${pen}`, `Bullpen day: opener, then ${pen}`, "Bullpen day"],
    follower: [`As opener, with follower (${op} + ${fo} IP), then ${pen}`, `As opener, with follower, then ${pen}`, "As opener, with follower"],
    hook: [`Modeled hook, then ${pen}`, `Modeled hook, then ${pen}`, `Modeled hook, then ${team ? "team" : "MLB"} bullpen`],
  };
  measure ??= document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(sel);
  measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const lists = Object.values(labels);
  const level = [0, 1].find((k) => lists.every((list) => measure.measureText(list[k]).width <= room)) ?? 2;
  for (const [v, list] of Object.entries(labels)) sel.querySelector(`[value=${v}]`).textContent = list[level];
}

function renderPitcher() {
  $("p_in").value = pitcher ? pitcher.name : "";
  $("p_clear").hidden = !pitcher;
  // every pitcher can open; an average start needs starts, and "then MLB bullpen" a team bullpen to differ from
  const sel = $("p_hook"), opt = (v) => sel.querySelector(`[value=${v}]`);
  const team = pitcher && penTeam() !== "MLB" ? teamOf(penTeam()).short : null;
  sel.disabled = !pitcher;
  fitHookLabels();
  opt("start").disabled = opt("hook").disabled = !pitcher?.gs;
  opt("start_mlb").disabled = opt("start_mlb").hidden = !pitcher?.gs || !team;
  if (opt(sel.value).disabled) sel.value = sel.value === "start_mlb" && !opt("start").disabled ? "start" : "game";
  $("platoon").disabled = !pitcher;
  const following = !!pitcher && sel.value === "follower";
  $("f_field").hidden = !following;
  $("f_in").value = follower?.name ?? "";
  $("f_clear").hidden = !follower;
  // his 2026 line in numbers (and a picked follower's); the lineup table shows each hitter against him
  const note = $("p_note");
  note.classList.remove("warn");
  note.title = "";
  note.hidden = !pitcher;
  const hypo = !!pitcher?.generic && !!quality;
  $("quality_ctl").hidden = !hypo;
  if (hypo) {
    const q = pitcher.quality ?? 0;
    if (Number($("quality").value) !== q) $("quality").value = q;
    $("quality_out").textContent = fmtTheta(q);
  }
  if (!pitcher) return;
  const mode = $("platoon").value;
  const lineFor = (e) => {
    // a hypothetical pitcher: what the model makes of him against an MLB-average hitter (at Average
    // with the per-PA model, the MLB-average arm's own line, below)
    if (e.generic && quality && (e.quality || byPitch)) {
      const c = byPitch ? pitchChances(pitchData.tables.all, null, hypoRatios(e)?.a ?? null) : e.counts, l = lineOf(c), q = e.quality ?? 0;
      const sides = byPitch || mode === "off" ? "" : ` (${["L", "R"].map((s) => `${fmtRate(wobaOf(e.cells[s]))} v ${s}HB`).join(", ")})`;
      return [q ? `Every 2026 ${handOf(e)} pooled, ${Math.abs(q).toFixed(1)} SD toward ${q > 0 ? "Ace" : "Scrub"}` : `Every 2026 ${handOf(e)} pooled`,
        `${byPitch ? "Per-Pitch" : "Per-PA"}: K ${pct(l.K)}`, `BB ${pct(l.BB)}`, `HR ${pct(c[C.HR] / countOf(c))}`, `${fmtRate(l.wOBA)} wOBA against${sides}`].join(" · ");
    }
    const l = lineOf(e.counts);
    // his wOBA against each side, where he faced it
    const sides = ["L", "R"].filter((s) => countOf(e.cells?.[s])).map((s) => `${fmtRate(wobaOf(e.cells[s]))} v ${s}HB`);
    let text = [e.generic ? `Every 2026 ${handOf(e)} pooled` : `${e.team} · ${handOf(e)}`,
      `${e.pa.toLocaleString()} BF`, `K ${pct(l.K)}`, `BB ${pct(l.BB)}`,
      `${fmtRate(l.wOBA)} wOBA against${mode === "off" || !sides.length ? "" : ` (${sides.join(", ")})`}`].join(" · ");
    const thin = ["L", "R"].filter((s) => countOf(e.cells?.[s]) < 60);
    if (!e.generic && (e.pa < 100 || (mode === "own" && thin.length))) {
      text += e.pa >= 100 ? ` · small sample v ${thin.map((s) => `${s}HB`).join(" and ")}` : " · small sample";
      note.title = "Sim settings can add MLB-average plate appearances, or use league-average platoon gaps";
      note.classList.add("warn");
    }
    return text;
  };
  note.textContent = lineFor(pitcher) + (following && follower ? `\nFollower: ${lineFor(follower)}` : "");
}

// ---------- Oops! All Ohtanis! ----------
// Every lineup spot is Shohei Ohtani, and so is the pitcher. Turning it off puts back the
// lineup and pitching that were there; changing a hitter or the pitcher turns it off.
const OHTANI = 660271;
let ohtani = false, beforeOhtani = null;
const allOhtani = () => lineup.every((id) => id === `p${OHTANI}`) && pitcher?.mlbam === OHTANI;
function setOhtani(on) {
  if (on === ohtani) return;
  if (on) {
    beforeOhtani = { lineup: [...lineup], pitcher, mode, edited, basis, kind: $("kind").value, hook: $("p_hook").value };
    ohtani = true;
    // contact vs power works on MLB spots, not hitters
    if (mode === "tradeoff") mode = $("kind").value = "spots";
    lineup = Array(9).fill(`p${OHTANI}`);
    pitcher = pitchers.get(`P${OHTANI}`);
    $("p_hook").value = "game"; // he goes all nine; "He pitches" can still change it
    edited = false;
    basis = "sim"; // the teams' spots against him too
  } else {
    ohtani = false;
    const b = beforeOhtani;
    beforeOhtani = null;
    if (!b) {
      // turned on by a link: back to no pitcher and the preset the selects name
      pitcher = null;
      renderPitcher();
      loadPreset();
      return;
    }
    ({ mode, edited, basis } = b);
    lineup = b.lineup;
    pitcher = b.pitcher;
    $("kind").value = b.kind;
    $("p_hook").value = b.hook;
  }
  paintBasis();
  renderPitcher();
  renderLineup();
  run();
}

// ---------- simulation ----------
// Runs go to a module worker (sim-worker.js) so the page keeps responding while a long
// run works. A run can't be stopped partway, so a newer request replaces a busy worker.
// Where module workers fail to start, runs fall back to this thread, as before.
let job = null;        // the run whose result the page is waiting for
let jobs = 0;
// Against a pitcher, the comparisons are against him too: every team's lineup spots and
// MLB's (exact lines), the contact-power curve (exact), and MLB's spots simulated for the
// runs-per-game chart. They're worked out with the first run for each vsKey() and kept.
let versus = { key: "", ctx: null };
const REF_GAMES = 20000;
// This lineup against MLB-average pitching, simulated (REF_GAMES games) for the runs image's
// white curve. Only the image asks for it, so runs and slider moves never pay for it: it runs
// then, in a worker of its own (the run worker is left alone), and is kept per lineup and Small
// samples. A run with no pitcher picked is it already. base: { key, cums }, from run().
let baseRun = { key: "", dist: null, games: 0 };
function baseDist({ key, cums }) {
  if (baseRun.key === key) return Promise.resolve(baseRun);
  const keep = (dist) => (baseRun = { key, dist, games: REF_GAMES });
  const here = () => keep(simulate(model, cums, REF_GAMES, SEED).runDist);
  if (!useWorker) return Promise.resolve(here());
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(new URL("./sim-worker.js?v=11", import.meta.url), { type: "module" });
    } catch {
      return resolve(here());
    }
    w.onmessage = ({ data: msg }) => { w.terminate(); resolve(keep(msg.res.runDist)); };
    w.onerror = (ev) => { ev.preventDefault(); w.terminate(); resolve(here()); };
    w.postMessage({ type: "init", tables: { running: data.running, advance: data.advance } });
    w.postMessage({ id: 0, lineup: cums, relief: [], games: REF_GAMES, seed: SEED });
  });
}
// MLB's nine lineup spots in order, as they are (not moved along the contact-power axis)
const averageLineup = (ids) => ids.every((id, i) => id.replace("@0.0", "") === `sMLB-${i + 1}`);
let worker = null;
let useWorker = typeof Worker !== "undefined";
let workerHook = false;    // the run worker has the hook model's trees (sent once, the first job that needs them)

function startWorker() {
  const w = new Worker(new URL("./sim-worker.js?v=11", import.meta.url), { type: "module" });
  w.postMessage({ type: "init", tables: { running: data.running, advance: data.advance } });
  workerHook = false;
  w.onmessage = ({ data: msg }) => {
    if (job && msg.id === job.id) finish(job, msg.res, msg.ms, msg.ref, msg.lines);
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    w.terminate();
    worker = null;
    useWorker = false;
    if (job) runHere(job);
  };
  return w;
}

function run() {
  if (ohtani && !allOhtani()) {
    ohtani = false;
    beforeOhtani = null;
  }
  $("ohtani").checked = ohtani;
  renderSummary(); // every change to the lineup or the pitching comes through here
  const key = vsKey(), vs = vsOf();
  if (optJob && (lineup.join() !== optJob.ids.join() || key !== optJob.key)) {
    const what = optJob.byPitch !== byPitch ? "model" : key !== optJob.key ? "pitching" : "lineup";
    stopSearch(`Search stopped: the ${what} changed. Optimize again for this one.`);
  }
  const games = Number($("games").value);
  const specs = lineup.map((id) => specOf(entryOf(id)));
  const cums = specs.map((h) => cumulative(facing(h, vs?.sp ?? null)));
  const relief = (vs?.relief ?? []).map((r) => ({ from: r.from, lineup: specs.map((h) => cumulative(facing(h, r.pitching))) }));
  let ref = null, lines = null;
  // (the data file's comparisons are the per-PA model's, so with the per-pitch model they're
  // worked out here even against MLB-average pitching)
  if ((vs || byPitch) && versus.key !== key) {
    // each lineup's hitters matched against the starter and each relief stage here; the
    // worker only needs the chances
    const stages = vs?.relief ?? [];
    const spots = (abbr) => Array.from({ length: 9 }, (_, i) => specOf(entries.get(`s${abbr}-${i + 1}`)));
    const matched = (hs, theta = 0) => hs.map((h) => ({ sp: facing(h, vs?.sp ?? null, theta, data.tradeoff.per_sd),
      relief: stages.map((r) => facing(h, r.pitching, theta, data.tradeoff.per_sd)) }));
    const mlb = spots("MLB"), m0 = matched(mlb);
    ref = { lineup: m0.map((x) => cumulative(x.sp)), games: REF_GAMES,
      relief: stages.map((r, i) => ({ from: r.from, lineup: m0.map((x) => cumulative(x.relief[i])) })) };
    lines = { w: data.weights, from: stages.map((r) => r.from), lineups: [m0, ...data.teams.map((t) => matched(spots(t.abbr))),
      ...data.sims.tradeoff.points.map((pt) => matched(mlb, pt.theta))] };
  }
  // this lineup against MLB-average pitching, as baseDist() simulates it (with no pitcher, the run itself)
  const base = { key: `${lineup.join()}|${$("regress").value}|${byPitch ? "pitch" : "pa"}`,
    cums: vs ? specs.map((h) => cumulative(facing(h, null))) : cums };
  const busy = job != null;
  const hook = hooked(vs) ? hookOf(pitcher) : null;
  job = { id: ++jobs, cums, relief, games, ids: [...lineup], key, vs, name: pitcher?.name, ...planWords(), full: planWords(true).words, ref, lines, base,
    byPitch, hook };
  $("status").textContent = "simulating…";
  $("out").style.opacity = last ? ".55" : "";
  writeHash();
  if (!useWorker) return runHere(job);
  if (busy && worker) {
    worker.terminate();
    worker = null;
  }
  try {
    worker ??= startWorker();
  } catch {
    useWorker = false; // no module workers here
    return runHere(job);
  }
  if (hook && !workerHook) {
    worker.postMessage({ type: "hook", fixed: hookData.fixed });
    workerHook = true;
  }
  worker.postMessage({ id: job.id, lineup: cums, relief, games, seed: SEED, ref, lines, hookX: hook?.x ?? null });
}

function runHere(j) {
  // let the status paint before the (blocking) run
  setTimeout(() => {
    if (job !== j) return;
    const t0 = performance.now();
    const res = simulate(model, j.cums, j.games, SEED, j.relief, j.hook);
    const ms = performance.now() - t0;
    const refRes = j.ref && simulate(model, j.ref.lineup, j.ref.games, SEED, j.ref.relief, j.hook);
    chain ??= chainTables(model);
    // with the modeled hook, MLB's spots' games say where he goes out, for every comparison
    const lines = j.lines && (j.lines.from.includes("hook")
      ? expectedLinesMix(chain, j.lines.lineups, j.lines.from, j.lines.w, hookMix((refRes ?? res).hook.outs))
      : expectedLines(chain, j.lines.lineups, j.lines.from, j.lines.w));
    finish(j, res, ms, refRes?.runDist ?? null, lines);
  }, 30);
}

function finish(j, res, ms, ref, lines) {
  job = null;
  if (!j.vs) baseRun = { key: j.base.key, dist: res.runDist, games: j.games };
  if (lines) {
    const n = data.teams.length;
    versus = { key: j.key, ctx: { refDist: ref, mlb: lines[0], teams: Object.fromEntries(data.teams.map((t, i) => [t.abbr, lines[1 + i]])),
      tradeoff: data.sims.tradeoff.points.map((pt, i) => ({ theta: pt.theta, ...lines[1 + n + i] })) } };
  }
  // with the modeled hook, the words say where this run's games took him out (only the current job finishes,
  // so the pitching picked is still the job's)
  const at = res.hook ? hookOuts(res.hook) : null;
  last = { res, sum: summarize(res.totals, data.weights), games: j.games, lineup: j.ids, key: j.key, vs: j.vs, name: j.name,
    words: at == null ? j.words : planWords(false, at).words, short: j.short, full: at == null ? j.full : planWords(true, at).words,
    ctx: j.vs || j.byPitch ? versus.ctx : null,
    base: j.base, byPitch: j.byPitch };
  $("out").hidden = false;
  $("out").style.opacity = "";
  $("status").textContent = "";
  $("status").classList.toggle("err", res.capped > 0);
  if (res.capped) {
    $("status").textContent = `${res.capped.toLocaleString()} innings were called off at 60 plate appearances: this lineup almost never makes an out. `
      + "Adding MLB-average PA under Sim settings fixes that.";
  }
  renderResults();
}

// ---------- results ----------
function compareSet(k) {
  if (basis === "actual") {
    return { teams: data.teams.map((t) => ({ abbr: t.abbr, v: t.actual[k] })), mlb: data.mlb.actual[k] };
  }
  const ctx = last?.ctx;
  if (ctx) return { teams: data.teams.map((t) => ({ abbr: t.abbr, v: ctx.teams[t.abbr][k] })), mlb: ctx.mlb[k] };
  return { teams: data.teams.map((t) => ({ abbr: t.abbr, v: data.sims.teams[t.abbr].spots[k] })), mlb: data.sims.mlb[k] };
}

// the pitching a run or a search was against, in words (planWords() when it started)
const vsWords = (l) => l.words;

// a rank among the 30 teams, for words: 31 is behind every one of them
const placeOf = (r) => (r > 30 ? "behind all 30 teams" : `${ordinal(r)} of 30 teams`);

function rankOf(v, teams, dir) {
  return 1 + teams.filter((t) => (dir > 0 ? t.v > v : t.v < v)).length;
}

function renderResults() {
  const s = last.sum;
  const games = last.games;
  const dist = last.res.runDist;
  const mean = dist.reduce((a, n, r) => a + n * r, 0) / games;
  const sd = Math.sqrt(dist.reduce((a, n, r) => a + n * (r - mean) ** 2, 0) / games);
  const moe = (1.96 * sd) / Math.sqrt(games);

  // KPI row
  const r = compareSet("R"), w = compareSet("wOBA");
  const kpi = (label, value, small) => {
    const d = document.createElement("div");
    d.className = "kpi";
    const a = document.createElement("span"), b = document.createElement("b"), c = document.createElement("small");
    a.textContent = label; b.textContent = value; c.textContent = small;
    d.append(a, b, c);
    return d;
  };
  // this lineup against MLB-average pitching, exactly (for the KPI and the share image)
  const avg = last.vs ? exactRuns(last.lineup, null) : null;
  let second;
  if (last.vs) {
    // the pitcher's effect on this lineup, exactly: against him and against MLB-average pitching
    const d = exactRuns(last.lineup, last.vs, hookMixOf(last.res)) - avg;
    second = kpi("Against MLB-average pitching", avg.toFixed(2), `${last.short}: ${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} runs per 9 (exact)`);
  } else {
    second = kpi("Over 162 games", Math.round(s.R * 162).toLocaleString(), `MLB ${Math.round(r.mlb * 162).toLocaleString()}`);
  }
  // how long the modeled hook kept him in, against his 2026 starts
  const hk = last.res.hook, note = $("hook_note");
  note.hidden = !hk;
  if (hk && hookData) {
    const own = pitcher && !pitcher.generic && hookData.pitchers[pitcher.mlbam];
    const real = own ? `his 2026 starts averaged ${fmtIP(Math.round(own[6]))} and ${Math.round(own[5])}`
      : `2026 starts averaged ${fmtIP(Math.round(hookData.league.team_start_outs))} and ${Math.round(hookData.avgPitches)}`;
    note.textContent = `Modeled hook: ${last.short.replace(/ \+ bullpen$/, "")} went ${fmtIP(hookOuts(hk))} innings and ${Math.round(hk.pitches / hk.games)} pitches `
      + `on average, and pitched all nine in ${pct(hk.outs[27] / hk.games)} of these games; ${real}.`;
  }
  $("kpis").replaceChildren(
    kpi(last.vs ? `Runs per 9 vs ${last.short}` : "Runs per 9 innings", s.R.toFixed(2), `±${moe.toFixed(2)} (95%) · ${placeOf(rankOf(s.R, r.teams, 1))}`),
    second,
    kpi("wOBA", fmtRate(s.wOBA), `${placeOf(rankOf(s.wOBA, w.teams, 1)).replace(" teams", "")} · MLB ${fmtRate(w.mlb)}`),
  );

  // comparison rows
  const body = $("compare");
  body.replaceChildren();
  for (const st of STATS) {
    const { teams, mlb } = compareSet(st.k);
    const v = s[st.k], d = v - mlb;
    const good = d * st.dir > 0;
    const tr = document.createElement("tr");
    const cells = [st.label, fmtStat(st, v), fmtStat(st, mlb), fmtDiff(st, d), ordinal(rankOf(v, teams, st.dir))];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i > 0) td.classList.add("num");
      if (i === 1) td.classList.add("me");
      if (i === 3 && /[1-9]/.test(text)) td.classList.add("d", good ? "up" : "down");
      if (i === 4) td.classList.add("opt");
      tr.append(td);
    });
    const td = document.createElement("td");
    td.className = "strip opt";
    td.append(strip(st, v, mlb, teams));
    tr.append(td);
    // phones hide the strip column and show the strip on a row of its own under the stat
    const under = document.createElement("tr");
    under.className = "strip-row";
    under.innerHTML = `<td colspan="6"></td>`;
    under.firstChild.append(strip(st, v, mlb, teams));
    body.append(tr, under);
  }
  $("basis_sim").title = last.ctx ? `Each team's nine lineup spots against ${vsWords(last)}, worked out exactly`
    : `Each team's nine lineup spots run through the same simulation, ${data.sims.games.toLocaleString()} games each`;
  $("basis_sim").textContent = last.ctx ? `Teams' lineup spots vs ${last.short}` : "Teams' lineup spots, simulated";
  // the legend's names: "Avg Lineup" for MLB's lineup spots, "Avg Pitching" for MLB-average pitching
  $("runs_mlb_key").textContent = last.ctx ? `Avg Lineup vs ${last.vs ? last.short : "Avg Pitching"} (simulated)` : "Avg Lineup (simulated)";

  runsChart(dist, games, s.R, avg);
  renderTradeoff(moe);
  renderSpots();
  renderTeams();
  renderOptimizer();
}

function strip(st, v, mlb, teams) {
  const W = 300, H = 26, pad = 8;
  const vals = [v, mlb, ...teams.map((t) => t.v)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  lo -= span * 0.04; hi += span * 0.04;
  const x = (val) => pad + ((val - lo) / (hi - lo)) * (W - 2 * pad);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "strip");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${st.label}: this lineup ${fmtStat(st, v)}, MLB ${fmtStat(st, mlb)}, teams from ${fmtStat(st, Math.min(...teams.map((t) => t.v)))} to ${fmtStat(st, Math.max(...teams.map((t) => t.v)))}`);
  const el = (name, attrs) => {
    const n = document.createElementNS(SVG, name);
    for (const [k, a] of Object.entries(attrs)) n.setAttribute(k, a);
    svg.append(n);
    return n;
  };
  el("line", { x1: pad, x2: W - pad, y1: H / 2, y2: H / 2, stroke: "var(--rule)", "stroke-width": 1 });
  for (const t of teams) el("circle", { cx: x(t.v), cy: H / 2, r: 4, fill: "var(--s-team)", stroke: "var(--surface)", "stroke-width": 1.5 });
  el("rect", { x: x(mlb) - 1.5, y: H / 2 - 8, width: 3, height: 16, rx: 1, fill: "var(--s-mlb)" });
  el("circle", { cx: x(v), cy: H / 2, r: 6, fill: "var(--s-lineup)", stroke: "var(--surface)", "stroke-width": 2 });

  const points = [{ label: "This lineup", v, key: "var(--s-lineup)" }, { label: "MLB", v: mlb, key: "var(--s-mlb)" },
    ...teams.map((t) => ({ label: t.abbr, v: t.v, key: "var(--s-team)" }))];
  hover(svg, (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    // nearest by x; the two highlighted marks win ties so they're never buried under a team dot
    let best = null, bd = Infinity;
    for (const p of points) {
      const dd = Math.abs(x(p.v) - px) - (p.label.length > 3 ? 2 : 0);
      if (dd < bd) { bd = dd; best = p; }
    }
    const same = teams.filter((t) => Math.abs(x(t.v) - x(best.v)) < 1.5 && t.abbr !== best.label).map((t) => t.abbr);
    showTip(ev, [[best.key, fmtStat(st, best.v), best.label + (same.length && best.label.length <= 3 ? `, ${same.join(", ")}` : "")]]);
  });
  return svg;
}

// the model toggle; Small samples is the per-PA model's (the per-pitch one shrinks step by step)
function paintModel() {
  document.querySelectorAll("#model_toggle button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.model === "pitch") === byPitch)));
  $("regress").disabled = byPitch;
  $("regress").closest("label").title = byPitch ? "Per-PA only: the per-pitch model has small-sample shrinkage of its own, step by step"
    : "Applies to individual hitters and the opposing pitcher, not to lineup spots";
}
async function setModel(pitch) {
  if (pitch === byPitch) return;
  if (pitch) {
    $("status").classList.remove("err");
    $("status").textContent = "loading the per-pitch model…";
    try {
      await loadPitchData();
    } catch (e) {
      $("status").textContent = `Couldn't load the per-pitch model (${e.message}).`;
      $("status").classList.add("err");
      return;
    }
  }
  byPitch = pitch;
  paintModel();
  renderPitcher(); // a hypothetical pitcher's line is the model's
  renderLineup(); // the table's rates are the model's
  run();
}

function paintBasis() {
  document.querySelectorAll(".basis button[data-basis]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.basis === basis)));
}

function showTip(ev, rows, title) {
  const tip = $("tip");
  tip.replaceChildren();
  if (title) {
    const t = document.createElement("div");
    t.className = "k";
    t.textContent = title;
    tip.append(t);
  }
  for (const [key, value, label] of rows) {
    const d = document.createElement("div");
    const line = document.createElement("span");
    line.className = "line";
    line.style.background = key;
    const b = document.createElement("b");
    b.textContent = value;
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = " " + label;
    d.append(line, b, k);
    tip.append(d);
  }
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = ev.clientX + 14, top = ev.clientY - r.height - 10;
  if (left + r.width > innerWidth - 8) left = ev.clientX - r.width - 14;
  if (top < 8) top = ev.clientY + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { $("tip").hidden = true; }
// A finger doesn't hover: pointermove only fires on a drag, which scrolls instead, and
// pointerleave follows every lift. So a tap shows the tip, and it stays until the next
// tap elsewhere or a scroll.
let tapHide = null, tapEvent = null;
function hover(el, show, hide = hideTip) {
  el.addEventListener("pointermove", (ev) => { if (ev.pointerType !== "touch") show(ev); });
  el.addEventListener("pointerleave", (ev) => { if (ev.pointerType !== "touch") hide(); });
  el.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    if (tapHide && tapHide !== hide) tapHide();
    tapHide = hide;
    tapEvent = ev;
    show(ev);
  });
}
const tapAway = (ev) => {
  if (!tapHide || ev === tapEvent) return;
  tapHide();
  tapHide = null;
};
document.addEventListener("pointerdown", tapAway);
addEventListener("scroll", tapAway, { passive: true, capture: true });

// charts are drawn at the width they're shown at (text stays 11-12px on a phone) and
// redrawn when that changes
const chartWidth = (id) => Math.max(300, Math.round($(id).clientWidth || 640));
let resizeTimer = 0, drawnWidth = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (last && $("runs_chart").clientWidth !== drawnWidth) renderResults();
  }, 200);
});

// runs: runs per 9, the share image's headline; avg: this lineup against MLB-average pitching
// (with a pitcher picked), one of its smaller numbers
function runsChart(dist, games, runs, avg) {
  const MAX = 12; // last bucket is 12+
  const share = (arr, total) => {
    const out = arr.slice(0, MAX).map((n) => n / total);
    out.push(arr.slice(MAX).reduce((s, n) => s + n, 0) / total);
    return out;
  };
  const mine = share(dist, games);
  const mlb = last.ctx ? share(last.ctx.refDist, REF_GAMES) : share(data.sims.mlb.runDist, 1);
  // The image's colors mean one thing whatever's picked: teal is this lineup against the pitching
  // picked (runs per 9, the headline), amber MLB's lineup spots against that pitching, white this
  // lineup against MLB-average pitching. Teal is bars, amber and white curves over their share of
  // games by run total (every total, not 12+), and each has its number in the box in its color.
  // One that would repeat teal goes: amber when the lineup is MLB's spots as they are, white with
  // no pitcher picked.
  const average = averageLineup(last.lineup);
  const amber = average ? null : last.ctx ? Array.from(last.ctx.refDist, (c) => c / REF_GAMES) : Array.from(data.sims.mlb.runDist);
  // (white only once the image is made: MLB's spots as they are have it in data.sims.mlb already)
  const base = last.base;
  const white = !last.vs ? null : average && !last.byPitch ? async () => Array.from(data.sims.mlb.runDist)
    : async () => { const b = await baseDist(base); return Array.from(b.dist, (c) => c / b.games); };
  const subs = [...(average ? [] : [[last.vs ? `MLB vs ${pShort(last.name)}` : "MLB", last.ctx ? last.ctx.mlb.R : data.sims.mlb.R, "amber"]]),
    ...(last.vs ? [["Lineup vs MLB", avg, "white"]] : [])];
  // a team's lineup (its spots or its most-used order, edited or not) leads the subtitle with its abbreviation
  const team = $("team").value !== "MLB" && !ohtani && mode !== "tradeoff" ? $("team").value : null;
  runsShare = { mine, amber, white, R: runs, subs, games, ids: last.lineup,
    team, ohtani, vs: last.vs ? { name: last.name, full: last.full, short: last.short } : null, byPitch: !!last.byPitch };
  const W = chartWidth("runs_chart"), H = 230, L = 40, R = 8, T = 10, B = 34;
  drawnWidth = $("runs_chart").clientWidth;
  const n = mine.length, band = (W - L - R) / n, bw = Math.min(24, band * 0.62);
  const top = Math.max(...mine, ...mlb);
  const step = top > 0.16 ? 0.05 : 0.04;
  const yMax = Math.ceil(top / step) * step;
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Share of games by runs scored, this lineup against the simulated MLB lineup. Most common: ${mine.indexOf(Math.max(...mine))} runs.`);
  const el = (name, attrs, text) => {
    const e = document.createElementNS(SVG, name);
    for (const [k, a] of Object.entries(attrs)) e.setAttribute(k, a);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "var(--rule)", "stroke-width": 1 });
    el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 }, `${Math.round(v * 100)}%`);
  }
  const cx = (i) => L + band * i + band / 2;
  mine.forEach((v, i) => {
    const h = y(0) - y(v);
    if (h > 0.5) {
      const r = Math.min(4, h / 2, bw / 2);
      el("path", { d: `M${cx(i) - bw / 2},${y(0)} V${y(v) + r} Q${cx(i) - bw / 2},${y(v)} ${cx(i) - bw / 2 + r},${y(v)} H${cx(i) + bw / 2 - r} Q${cx(i) + bw / 2},${y(v)} ${cx(i) + bw / 2},${y(v) + r} V${y(0)} Z`, fill: "var(--s-lineup)" });
    }
    el("text", { x: cx(i), y: H - B + 16, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, i === MAX ? `${MAX}+` : String(i));
  });
  // MLB as a step line across each band
  let d = "";
  mlb.forEach((v, i) => {
    const x0 = L + band * i + 2, x1 = L + band * (i + 1) - 2;
    d += `M${x0},${y(v)} H${x1} `;
  });
  el("path", { d, stroke: "var(--s-mlb)", "stroke-width": 2, fill: "none", "stroke-linecap": "round" });
  el("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, "Runs");
  // hover: one band per run total
  mine.forEach((v, i) => {
    const hit = el("rect", { x: L + band * i, y: T, width: band, height: H - T - B, fill: "transparent" });
    hover(hit, (ev) => showTip(ev, [["var(--s-lineup)", pct(v), "this lineup"], ["var(--s-mlb)", pct(mlb[i]), "MLB"]],
      i === MAX ? `${MAX}+ runs` : `${i} run${i === 1 ? "" : "s"}`));
  });
  $("runs_chart").replaceChildren(svg);
}

function renderSpots() {
  const body = $("spots");
  body.replaceChildren();
  const g = last.games;
  last.lineup.forEach((id, i) => {
    const e = entryOf(id);
    const tr = document.createElement("tr");
    for (const [text, num] of [[String(i + 1)], [labelOf(e)], [(last.res.spotPA[i] / g).toFixed(2), 1],
      [(last.res.spotR[i] / g).toFixed(2), 1], [fmtRate(wobaOf(shownOf(e, last.vs))), 1]]) {
      const td = document.createElement("td");
      td.textContent = text;
      if (num) td.className = "num";
      tr.append(td);
    }
    body.append(tr);
  });
}

function renderTeams() {
  const head = $("teams_head");
  head.replaceChildren();
  const hr = document.createElement("tr");
  const th0 = document.createElement("th");
  th0.textContent = "Team";
  th0.scope = "col";
  hr.append(th0);
  for (const st of STATS) {
    const th = document.createElement("th");
    th.scope = "col";
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = st.k + (sortKey.k === st.k ? (sortKey.dir < 0 ? " ↓" : " ↑") : "");
    if (sortKey.k === st.k) th.setAttribute("aria-sort", sortKey.dir < 0 ? "descending" : "ascending");
    b.addEventListener("click", () => {
      sortKey = sortKey.k === st.k ? { k: st.k, dir: -sortKey.dir } : { k: st.k, dir: -1 };
      renderTeams();
    });
    th.append(b);
    hr.append(th);
  }
  head.append(hr);
  const rows = data.teams.map((t) => ({ label: t.name, short: t.short, cls: "", v: Object.fromEntries(STATS.map((st) => [st.k, compareSet(st.k).teams.find((x) => x.abbr === t.abbr).v])) }));
  rows.push({ label: "MLB", cls: "mlb", v: Object.fromEntries(STATS.map((st) => [st.k, compareSet(st.k).mlb])) });
  rows.push({ label: "This lineup", cls: "me", v: last.sum });
  rows.sort((a, b) => sortKey.dir * (a.v[sortKey.k] - b.v[sortKey.k]));
  const body = $("teams_body");
  body.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.cls) tr.className = r.cls;
    const td0 = document.createElement("td");
    td0.textContent = r.label;
    if (r.short) {
      // phones show "Cubs" for "Chicago Cubs", so the pinned column stays narrow
      td0.innerHTML = `<span class="long"></span><span class="short"></span>`;
      td0.firstChild.textContent = r.label;
      td0.lastChild.textContent = r.short;
    }
    tr.append(td0);
    for (const st of STATS) {
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = fmtStat(st, r.v[st.k]);
      tr.append(td);
    }
    body.append(tr);
  }
}

// ---------- contact vs power results ----------
function setMaster(theta) {
  $("tilt_all").value = theta;
  tintRange($("tilt_all"), theta);
  $("tilt_all_out").textContent = fmtTheta(theta);
}

// the axis in words, and the 2026 regulars furthest toward each end, for scale
function setupTradeoff() {
  const T = data.tradeoff;
  $("tilt_all").min = -T.range;
  $("tilt_all").max = T.range;
  $("tilt_share").textContent = `${Math.round(T.share * 100)}%`;
  $("tilt_range").textContent = String(T.range);
  const d = Object.fromEntries(CATS.map((c, i) => [c, T.per_sd[i] * 100]));
  const f = (x) => `${x > 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
  const bip = d.GB + d.LD + d.FB + d.PU;
  const ends = T.ends.map(([, name, score]) => `${lastName(name)} ${fmtTheta(score)}`);
  $("tilt_ends").textContent = "Per 100 PA, a step toward power is "
    + `K ${f(d.K)}, BB ${f(d.BB)}, HR ${f(d.HR)}, 1B ${f(d["1B"])}, 2B ${f(d["2B"])}, outs in play ${f(bip)}; toward contact, the reverse. `
    + `For scale, the most contact-heavy regulars sit at ${ends.slice(0, 3).join(", ")}; `
    + `the most power-heavy at ${ends.slice(-3).reverse().join(", ")}, so ±${T.range} is as far as regulars go toward the `
    + `${-T.ends[0][2] > T.ends[T.ends.length - 1][2] ? "power" : "contact"} end.`;
}

function renderTradeoff(moe) {
  const box = $("tradeoff_out");
  box.hidden = mode !== "tradeoff";
  if (box.hidden) return;
  const pts = last.ctx ? last.ctx.tradeoff : data.sims.tradeoff.points;
  const thetas = last.lineup.map((id) => entryOf(id)?.theta).filter((t) => t != null);
  const avg = thetas.length ? thetas.reduce((s, t) => s + t, 0) / thetas.length : null;
  // runs per nine with every spot at the contact end, at 0 and at the power end, in the sliders' colors
  const base = pts.find((p) => p.theta === 0), lo = pts[0], hi = pts[pts.length - 1];
  const dR = (p) => `${p.R >= base.R ? "+" : "−"}${Math.abs(p.R - base.R).toFixed(2)}`;
  $("tradeoff_ends").replaceChildren(...[[lo, `← All contact ${fmtTheta(lo.theta)}`], [base, "MLB spots 0"], [hi, `All power ${fmtTheta(hi.theta)} →`]]
    .map(([pt, label]) => {
      const d = document.createElement("div"), a = document.createElement("span"), b = document.createElement("b");
      a.textContent = label;
      b.textContent = pt.R.toFixed(2);
      b.style.color = tiltColor(pt.theta);
      d.append(a, b);
      if (pt !== base) {
        const c = document.createElement("small");
        c.textContent = dR(pt);
        d.append(c);
      }
      return d;
    }));
  tradeoffChart(pts, avg, last.sum.R, moe);
  // the saved and copied image is the curve alone
  tradeoffShare = { pts, vs: last.vs ? { name: last.name, words: last.words } : null, byPitch: !!last.byPitch };

  // table view of the curve at whole steps
  const cols = pts.filter((p) => Number.isInteger(p.theta) || Math.abs(p.theta) === data.tradeoff.range);
  const rows = [["Runs / 9", "R", 2], ["AVG", "AVG", 3], ["OBP", "OBP", 3], ["SLG", "SLG", 3], ["wOBA", "wOBA", 3],
    ["K / 9", "K", 2], ["BB / 9", "BB", 2], ["HR / 9", "HR", 2]];
  const table = $("tradeoff_table");
  table.replaceChildren();
  const thead = table.createTHead().insertRow();
  const corner = document.createElement("th");
  corner.textContent = "Contact ← → Power";
  thead.append(corner);
  for (const p of cols) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = p.theta === 0 ? "0 (MLB)" : fmtStep(p.theta);
    thead.append(th);
  }
  const tbody = table.createTBody();
  for (const [label, k, dp] of rows) {
    const tr = tbody.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = label;
    tr.append(th);
    for (const p of cols) {
      const td = tr.insertCell();
      td.className = "num";
      td.textContent = dp === 3 ? fmtRate(p[k]) : p[k].toFixed(2);
    }
  }
}

// the curve (runs per nine with every MLB spot at the same setting), and this lineup at
// its spots' average setting with its 95% range when it has MLB spots
function tradeoffChart(pts, avg, R, moe) {
  const W = chartWidth("tradeoff_chart"), H = 240, L = 44, Rt = 14, T = 22, B = 44;
  const range = data.tradeoff.range;
  const ys = pts.map((p) => p.R).concat(avg == null ? [] : [R - moe, R + moe]);
  const span = Math.max(...ys) - Math.min(...ys);
  const step = span > 0.45 ? 0.1 : 0.05;
  const y0 = Math.floor(Math.min(...ys) / step) * step, y1 = Math.ceil(Math.max(...ys) / step) * step;
  const x = (t) => L + ((t + range) / (2 * range)) * (W - L - Rt);
  const y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Runs per nine innings from the contact end to the power end at the same wOBA: "
    + pts.filter((p) => Number.isInteger(p.theta)).map((p) => `${fmtTheta(p.theta)} ${p.R.toFixed(2)}`).join(", "));
  const el = (name, attrs, text) => {
    const e = document.createElementNS(SVG, name);
    for (const [k, a] of Object.entries(attrs)) e.setAttribute(k, a);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (let v = y0; v <= y1 + 1e-9; v += step) {
    el("line", { x1: L, x2: W - Rt, y1: y(v), y2: y(v), stroke: "var(--rule)", "stroke-width": 1 });
    el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 }, v.toFixed(2));
  }
  el("line", { x1: x(0), x2: x(0), y1: T - 6, y2: H - B, stroke: "var(--faint)", "stroke-width": 1 });
  el("text", { x: x(0), y: T - 10, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, "MLB");
  for (let t = -Math.floor(range); t <= Math.floor(range); t++) {
    el("text", { x: x(t), y: H - B + 16, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, fmtStep(t));
  }
  el("text", { x: L, y: H - 6, fill: "var(--muted)", "font-size": 11 }, "← Contact");
  el("text", { x: W - Rt, y: H - 6, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 }, "Power →");
  el("text", { x: (L + W - Rt) / 2, y: H - 6, "text-anchor": "middle", fill: "var(--faint)", "font-size": 11 },
    W < 400 ? "SDs of 2026 hitters" : "standard deviations of 2026 hitters"); // a phone's chart has room for the short one
  el("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${x(p.theta)},${y(p.R)}`).join(" "), fill: "none",
    stroke: "var(--s-mlb)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
  if (avg != null) {
    el("line", { x1: x(avg), x2: x(avg), y1: y(R - moe), y2: y(R + moe), stroke: "var(--s-lineup)", "stroke-width": 2, "stroke-linecap": "round" });
    el("circle", { cx: x(avg), cy: y(R), r: 5, fill: "var(--s-lineup)", stroke: "var(--surface)", "stroke-width": 2 });
  }
  const cross = el("line", { x1: 0, x2: 0, y1: T, y2: H - B, stroke: "var(--muted)", "stroke-width": 1, visibility: "hidden" });
  const hit = el("rect", { x: L, y: T, width: W - L - Rt, height: H - T - B, fill: "transparent" });
  const hideCross = () => { cross.setAttribute("visibility", "hidden"); hideTip(); };
  hover(hit, (ev) => {
    const box = svg.getBoundingClientRect();
    const t = ((((ev.clientX - box.left) / box.width) * W - L) / (W - L - Rt)) * 2 * range - range;
    const p = pts.reduce((a, b) => (Math.abs(b.theta - t) < Math.abs(a.theta - t) ? b : a));
    cross.setAttribute("x1", x(p.theta));
    cross.setAttribute("x2", x(p.theta));
    cross.setAttribute("visibility", "visible");
    const rows = [["var(--s-mlb)", p.R.toFixed(2), "runs / 9"], ["transparent", `${fmtRate(p.AVG)} / ${fmtRate(p.SLG)}`, "AVG / SLG"],
      ["transparent", `${p.K.toFixed(1)} / ${p.BB.toFixed(1)}`, "K / BB per 9"], ["transparent", fmtRate(p.wOBA), "wOBA"]];
    if (avg != null && Math.abs(avg - p.theta) < 0.25) rows.splice(1, 0, ["var(--s-lineup)", `${R.toFixed(2)} ±${moe.toFixed(2)}`, "this lineup"]);
    showTip(ev, rows, p.theta === 0 ? "MLB spots" : `All spots ${fmtTheta(p.theta)}`);
  }, hideCross);
  $("tradeoff_chart").replaceChildren(svg);
}

// ---------- lineup optimizer ----------
// The optimizer judges lineups by exact expected runs (markov.js), not simulated ones:
// the differences it chases are hundredths of a run, which simulation noise would bury.
// It runs in its own worker, so a search and a simulation never cancel each other.
let chain = null;          // markov tables, for the exact runs of the lineup on screen
let optWorker = null;
let optJob = null;         // the search under way
let optJobs = 0;
let optDone = null;        // the last search: { before, after, result, ms } (lineup ids)
const locked = new Set();  // lineup slots (0-8) the search leaves alone

// exact expected runs per nine innings, against `vs` (by default the pitching now picked); with
// the modeled hook, averaged over `mix` ([{ p, at }]: where he went out, hookMix())
function exactRuns(ids, vs = vsOf(), mix = null) {
  chain ??= chainTables(model);
  const ms = ids.map((id) => matchup(chain, specOf(entryOf(id)), vs));
  if (!hooked(vs)) return lineupRuns(chain, ms);
  return (mix ?? [{ p: 1, at: startOutsOf(pitcher) }]).reduce((a, { p, at }) => a + p * lineupRuns(chain,
    ms.map((m) => ({ ...m, relief: m.relief.map((r) => (r.from === "hook" ? { ...r, from: at } : r)) }))), 0);
}

const shortName = (e) => (e.kind === "spot" && e.team === "MLB" ? `${e.name.split(" · ")[1].replace(" spot", "")}-spot hitter` : e.name);

function setupOptimizer() {
  const box = $("opt_locks");
  for (let i = 0; i < 9; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(i + 1);
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `Keep the ${ordinal(i + 1)} spot as it is`);
    b.addEventListener("click", () => {
      if (locked.has(i)) locked.delete(i); else locked.add(i);
      b.setAttribute("aria-pressed", String(locked.has(i)));
    });
    box.append(b);
  }
  $("opt_tilt").addEventListener("change", renderOptimizer);
  $("opt_go").addEventListener("click", startOptimize);
  $("opt_undo").addEventListener("click", () => {
    if (!optDone) return;
    lineup = [...optDone.before];
    optDone = null;
    renderLineup();
    run();
  });
}

// controls that depend on the lineup, the exact-runs line, and the last search's result
function renderOptimizer() {
  const canTilt = lineup.some((id) => entryOf(id).theta != null);
  // the contact-power controls only show for a lineup with movable MLB spots
  $("opt_tilt").disabled = !canTilt;
  $("opt_tilt_label").hidden = $("opt_mix").closest("label").hidden = !canTilt;
  $("opt_mix").disabled = !canTilt || !$("opt_tilt").checked;
  const thetas = lineup.map((id) => entryOf(id).theta).filter((t) => t != null);
  const avg = thetas.length ? thetas.reduce((x, t) => x + t, 0) / thetas.length : 0;
  $("opt_mix").options[0].textContent = `Keep the lineup's average setting (${fmtTheta(avg)})`;
  $("opt_go").disabled = optJob != null;
  const shown = optDone && optDone.after.join() === lineup.join() && optDone.key === vsKey();
  $("opt_out").hidden = !shown;
  $("opt_undo").hidden = !shown;
  if (shown) renderOptResult();
}

function startOptimize() {
  const canTilt = lineup.some((id) => entryOf(id).theta != null);
  const opts = { order: $("opt_order").checked, tilt: canTilt && $("opt_tilt").checked, mix: $("opt_mix").value,
    locked: [...locked], perSd: data.tradeoff.per_sd, range: data.tradeoff.range, vs: hookFixed(vsOf()) };
  if (!opts.order && !opts.tilt) {
    $("opt_status").textContent = "Pick batting order, contact–power settings or both to search.";
    return;
  }
  if (locked.size >= 8 && !opts.tilt) {
    $("opt_status").textContent = "With eight or nine spots kept as they are, there's no order left to search.";
    return;
  }
  const ids = [...lineup];
  const hitters = ids.map((id) => {
    const e = entryOf(id);
    return opts.tilt && e.theta != null ? { ...specOf(e, false), theta: e.theta } : specOf(e);
  });
  // the words of the run the search builds on (with the modeled hook, they say where it took him out)
  optJob = { id: ++optJobs, ids, opts, key: vsKey(), name: pitcher?.name, words: last?.key === vsKey() ? last.words : planWords().words, byPitch };
  $("opt_status").textContent = "searching…";
  renderOptimizer();
  const j = optJob;
  const here = () => setTimeout(() => {
    const t0 = performance.now();
    chain ??= chainTables(model);
    optFinish(j, optimize(chain, hitters, opts), performance.now() - t0);
  }, 30);
  if (!useWorker) return here();
  try {
    if (!optWorker) {
      optWorker = new Worker(new URL("./sim-worker.js?v=11", import.meta.url), { type: "module" });
      optWorker.postMessage({ type: "init", tables: { running: data.running, advance: data.advance } });
    }
  } catch {
    return here();
  }
  optWorker.onmessage = ({ data: msg }) => {
    if (msg.id !== j.id) return;
    if (msg.progress) $("opt_status").textContent = `searching… ${msg.progress.toLocaleString()} lineups so far`;
    else optFinish(j, msg.result, msg.ms);
  };
  optWorker.onerror = (ev) => {
    ev.preventDefault();
    optWorker.terminate();
    optWorker = null;
    here();
  };
  optWorker.postMessage({ type: "optimize", id: j.id, hitters, opts });
}

// Stop a search that's still running, not just ignore its answer: the worker would
// otherwise keep a core busy for a second or two. The next search starts a new one.
function stopSearch(note) {
  if (!optJob) return;
  optJob = null;
  if (optWorker) {
    optWorker.terminate();
    optWorker = null;
  }
  $("opt_status").textContent = note;
  renderOptimizer();
}

function optFinish(j, result, ms) {
  if (optJob !== j) return;
  optJob = null;
  if (lineup.join() !== j.ids.join() || vsKey() !== j.key) {
    // edited while the search ran; its answer is for a lineup that's gone
    $("opt_status").textContent = "The lineup or pitching changed during the search. Optimize again for this one.";
    renderOptimizer();
    return;
  }
  const after = result.slot.map((h) => {
    const e = entryOf(j.ids[h]);
    return result.theta[h] != null ? tiltId(e.base, result.theta[h]) : j.ids[h];
  });
  $("opt_status").textContent = "";
  optDone = { before: j.ids, after, result, opts: j.opts, key: j.key, name: j.name, words: j.words, byPitch: j.byPitch };
  if (after.join() !== lineup.join()) {
    lineup = [...after]; // a copy: edits to the lineup mustn't rewrite the search's record
    edited = true;
    renderLineup();
  }
  run();
}

function renderOptResult() {
  const { before, after, result } = optDone;
  const gain = result.after - result.before;
  const season = gain * 162;
  // the gain up front; against a pitcher it's runs in a game against him, otherwise over a season
  const same = before.join() === after.join();
  const vsText = optDone.name ? ` vs ${vsWords(optDone)}` : "";
  $("opt_gain").textContent = same ? "Already the best found" : `+${gain.toFixed(gain < 0.001 ? 4 : 3)}`;
  $("opt_gain").classList.toggle("flat", same);
  $("opt_gain_sub").textContent = same ? `${result.after.toFixed(3)} expected runs per 9${vsText}`
    : `expected runs per 9${vsText}: ${result.before.toFixed(3)} → ${result.after.toFixed(3)}`
      + (optDone.name ? "" : season < 0.5 ? " · under a run over 162 games" : ` · ≈${season.toFixed(1)} runs over 162 games`);
  // the order moves, one per hitter who moved; the chart below has the settings
  const baseOf = (id) => id.split("@")[0];
  const wasSlot = (s) => before.findIndex((id) => baseOf(id) === baseOf(after[s]));
  const reordered = after.map((_, s) => [s, wasSlot(s)]).filter(([s, b]) => b !== s);
  $("opt_moves").replaceChildren(...reordered.map(([s, b]) => {
    const li = document.createElement("li"), name = document.createElement("b"), move = document.createElement("span");
    name.textContent = shortName(entryOf(after[s]));
    move.textContent = ` ${ordinal(b + 1)} → ${ordinal(s + 1)}`;
    li.append(name, move);
    return li;
  }));
  $("opt_moves").hidden = !reordered.length;
  const tilted = after.some((id) => entryOf(id).theta != null);
  $("opt_chart_box").hidden = !tilted;
  if (tilted) settingsChart(before, after, wasSlot);
}

// the optimized setting of each slot's hitter (bar) against where that hitter was (tick)
function settingsChart(before, after, wasSlot) {
  optShare = { before, after, wasSlot, byPitch: !!optDone?.byPitch };
  const range = data.tradeoff.range;
  // G: room either side of the plot for a value label past a bar that reaches the end
  const W = chartWidth("opt_chart"), rowH = 26, L = Math.min(150, Math.round(W * 0.36)), G = 38, T = 6, B = 40;
  const H = T + 9 * rowH + B, room = Math.floor((L - 22) / 6.6); // characters that fit beside the bars
  const x = (t) => L + G + ((t + range) / (2 * range)) * (W - L - 2 * G);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Optimized contact–power setting by lineup spot: "
    + after.map((id, s) => `${ordinal(s + 1)} ${fmtTheta(entryOf(id).theta ?? 0)}`).join(", "));
  const el = (name, attrs, text) => {
    const e = document.createElementNS(SVG, name);
    for (const [k, a] of Object.entries(attrs)) e.setAttribute(k, a);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (let t = -Math.floor(range); t <= Math.floor(range); t++) {
    el("line", { x1: x(t), x2: x(t), y1: T, y2: T + 9 * rowH, stroke: t === 0 ? "var(--faint)" : "var(--rule)", "stroke-width": 1 });
    el("text", { x: x(t), y: T + 9 * rowH + 15, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, fmtStep(t));
  }
  el("text", { x: x(-range), y: H - 6, fill: "var(--muted)", "font-size": 11 }, "← Contact");
  el("text", { x: x(range), y: H - 6, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 }, "Power →");
  after.forEach((id, s) => {
    const e = entryOf(id), y = T + s * rowH + rowH / 2;
    const prev = entryOf(before[wasSlot(s)]);
    el("text", { x: 0, y: y + 4, fill: "var(--muted)", "font-size": 12 }, String(s + 1));
    // narrow: "4th spot" rather than a cut-off "4th-spot hitter"
    const name = shortName(e).length > room && e.kind === "spot" && e.team === "MLB" ? e.name.split(" · ")[1] : shortName(e);
    el("text", { x: 16, y: y + 4, fill: "var(--ink)", "font-size": 12 }, name.length > room ? name.slice(0, room - 1) + "…" : name);
    if (e.theta == null) {
      el("text", { x: x(0) + 6, y: y + 4, fill: "var(--faint)", "font-size": 11 }, "as is");
      return;
    }
    const t = e.theta, x0 = x(0), x1 = x(t), h = 12, r = Math.min(4, Math.abs(x1 - x0) / 2), color = tiltColor(t);
    if (Math.abs(x1 - x0) > 0.5) {
      const [a, b] = t > 0 ? [x0, x1] : [x1, x0];
      // rounded at the data end only, square at zero
      const d = t > 0
        ? `M${a},${y - h / 2} H${b - r} Q${b},${y - h / 2} ${b},${y - h / 2 + r} V${y + h / 2 - r} Q${b},${y + h / 2} ${b - r},${y + h / 2} H${a} Z`
        : `M${b},${y - h / 2} H${a + r} Q${a},${y - h / 2} ${a},${y - h / 2 + r} V${y + h / 2 - r} Q${a},${y + h / 2} ${a + r},${y + h / 2} H${b} Z`;
      el("path", { d, fill: color });
    }
    if (prev?.theta != null) el("rect", { x: x(prev.theta) - 1, y: y - 9, width: 2, height: 18, rx: 1, fill: "var(--muted)" });
    // the value just past the bar's end (toward contact, to its left), in the bar's color
    el("text", { x: t < 0 ? x1 - 5 : x1 + 5, y: y + 4, "text-anchor": t < 0 ? "end" : "start", fill: color, "font-size": 12,
      "font-family": "JetBrains Mono, monospace" }, fmtTheta(t));
    const hit = el("rect", { x: 0, y: y - rowH / 2, width: W, height: rowH, fill: "transparent" });
    hover(hit, (ev) => {
      const l = lineOf(e.counts);
      showTip(ev, [[color, fmtTheta(t), "optimized"], ["var(--muted)", fmtTheta(prev?.theta ?? 0), "before"],
        ["transparent", `${pct(l.K)} / ${pct(l.BB)}`, "K% / BB%"], ["transparent", `${fmtRate(l.AVG)} / ${fmtRate(l.SLG)}`, "AVG / SLG"],
        ["transparent", fmtRate(l.wOBA), "wOBA"]], `${ordinal(s + 1)}: ${shortName(e)}`);
    });
  });
  $("opt_chart").replaceChildren(svg);
}

// ---------- reset ----------
// Everything back to how the page first opens: the MLB lineup spots, every
// option at its default (as written in index.html), sliders at 0, no spots kept as
// they are, and no search result. The link (URL hash) follows.
function resetSettings() {
  const toDefault = (sel) => { sel.selectedIndex = Math.max(0, [...sel.options].findIndex((o) => o.defaultSelected)); };
  ["team", "kind", "games", "regress", "opt_mix", "p_hook", "platoon"].forEach((id) => toDefault($(id)));
  ["opt_order", "opt_tilt"].forEach((id) => { $(id).checked = $(id).defaultChecked; });
  pitcher = null;
  follower = null;
  ohtani = false;
  beforeOhtani = null;
  byPitch = false;
  paintModel();
  renderPitcher();
  basis = "actual";
  paintBasis();
  setMaster(0);
  locked.clear();
  document.querySelectorAll("#opt_locks button").forEach((b) => b.setAttribute("aria-pressed", "false"));
  stopSearch("");
  optDone = null;
  $("opt_status").textContent = "";
  sortKey = { k: "R", dir: -1 };
  $("teams_details").open = false;
  loadPreset();
}

// ---------- the optimizer chart as an image ----------
// The chart above as a 900 x 900 image in the site's share-image style (League Factors' and the
// homepage tiles': the Pitcher List Stats ground, a cyan title, the wordmark top right), to copy
// or download with the Share image button (shared/share-image.js).
const OPT_TILE = { W: 900, bg: "rgb(41,44,66)", cyan: "rgb(4,209,249)", sub: "#9aa0b8", axis: "#c0c4d3", grid: "#3a3e5a", zero: "#6d7290" };
let optShare = null;   // what the chart on screen shows: { before, after, wasSlot, byPitch }
let logoImg = null;
const loadLogo = () => logoImg || (logoImg = new Promise((res, rej) => {
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = rej;
  im.src = "logo.png";
}));
const optFileName = () => `lineup_sim_contact_power${optDone?.name ? `_vs_${slug(pShort(optDone.name))}` : ""}.png`;

async function optTileBlob() {
  const { before, after, wasSlot } = optShare;
  const { result } = optDone;
  await Promise.all(['700 36px "DM Sans"', '400 21px "DM Sans"', '400 18px "DM Sans"', '400 16px "DM Sans"',
    '600 19px "JetBrains Mono"'].map((f) => document.fonts.load(f)));
  const logo = await loadLogo();
  const { W } = OPT_TILE, range = data.tradeoff.range;
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  const g = cv.getContext("2d");
  g.fillStyle = OPT_TILE.bg;
  g.fillRect(0, 0, W, W);
  const fit = (text, weight, size, family, width) => fitFont(g, text, weight, size, family, width);
  // title, subtitle, wordmark
  g.font = '700 36px "DM Sans"';
  g.fillStyle = OPT_TILE.cyan;
  g.fillText("Optimized Lineup", 48, 64);
  g.font = '400 21px "DM Sans"';
  g.fillStyle = OPT_TILE.sub;
  g.fillText("Contact-Power balance, by lineup spot", 48, 100);
  g.drawImage(logo, W - 32 - 236, 27, 236, (236 * logo.naturalHeight) / logo.naturalWidth);
  const vs = optDone.name ? `vs ${vsWords(optDone)}` : "vs MLB-average pitching";
  const runs = `${result.before.toFixed(3)} → ${result.after.toFixed(3)} expected runs per 9 (+${(result.after - result.before).toFixed(3)})`;
  const ctx = `${vs} · ${runs}`;
  fit(ctx, 400, 18, '"DM Sans"', W - 96);
  g.fillStyle = OPT_TILE.axis;
  g.fillText(ctx, 48, 136);

  // the plot: nine rows, a bar from 0 to each spot's setting
  const T = 178, B = 718, rowH = (B - T) / 9, LABEL = 48, P0 = 326, P1 = W - 40, G = 62;
  const x = (t) => P0 + G + ((t + range) / (2 * range)) * (P1 - P0 - 2 * G);
  g.lineWidth = 1;
  g.textAlign = "center";
  g.font = '400 17px "DM Sans"';
  for (let t = -Math.floor(range); t <= Math.floor(range); t++) {
    g.strokeStyle = t === 0 ? OPT_TILE.zero : OPT_TILE.grid;
    g.lineWidth = t === 0 ? 2 : 1;
    g.beginPath(); g.moveTo(x(t), T - 6); g.lineTo(x(t), B); g.stroke();
    g.fillStyle = OPT_TILE.axis;
    g.fillText(fmtStep(t), x(t), B + 30);
  }
  g.textAlign = "left";
  g.font = '400 16px "DM Sans"';
  g.fillStyle = tiltColor(-range);
  g.fillText("← Contact", x(-range), B + 58);
  g.textAlign = "right";
  g.fillStyle = tiltColor(range);
  g.fillText("Power →", x(range), B + 58);
  g.textBaseline = "middle";
  after.forEach((id, s) => {
    const e = entryOf(id), y = T + s * rowH + rowH / 2, prev = entryOf(before[wasSlot(s)]);
    g.textAlign = "left";
    g.font = '400 18px "DM Sans"';
    g.fillStyle = OPT_TILE.sub;
    g.fillText(String(s + 1), LABEL, y);
    g.fillStyle = "#fff";
    let name = shortName(e);
    const room = P0 - LABEL - 34 - 12;
    if (g.measureText(name).width > room) {
      while (name.length > 1 && g.measureText(`${name}…`).width > room) name = name.slice(0, -1);
      name += "…";
    }
    g.fillText(name, LABEL + 30, y);
    if (e.theta == null) {
      g.fillStyle = OPT_TILE.sub;
      g.font = '400 16px "DM Sans"';
      g.fillText("as is", x(0) + 10, y);
      return;
    }
    const t = e.theta, x0 = x(0), x1 = x(t), h = 26, color = tiltColor(t);
    if (Math.abs(x1 - x0) > 0.5) {
      const r = Math.min(6, Math.abs(x1 - x0) / 2), [a, b] = t > 0 ? [x0, x1] : [x1, x0];
      g.fillStyle = color;
      g.beginPath();
      // rounded at the data end only, square at zero
      if (t > 0) {
        g.moveTo(a, y - h / 2); g.lineTo(b - r, y - h / 2); g.quadraticCurveTo(b, y - h / 2, b, y - h / 2 + r);
        g.lineTo(b, y + h / 2 - r); g.quadraticCurveTo(b, y + h / 2, b - r, y + h / 2); g.lineTo(a, y + h / 2);
      } else {
        g.moveTo(b, y - h / 2); g.lineTo(a + r, y - h / 2); g.quadraticCurveTo(a, y - h / 2, a, y - h / 2 + r);
        g.lineTo(a, y + h / 2 - r); g.quadraticCurveTo(a, y + h / 2, a + r, y + h / 2); g.lineTo(b, y + h / 2);
      }
      g.closePath();
      g.fill();
    }
    if (prev?.theta != null) {
      g.fillStyle = OPT_TILE.sub;
      g.fillRect(x(prev.theta) - 1.5, y - 19, 3, 38);
    }
    // the value just past the bar's end, in the bar's color
    g.font = '600 19px "JetBrains Mono"';
    g.fillStyle = color;
    g.textAlign = t < 0 ? "right" : "left";
    g.fillText(fmtTheta(t), t < 0 ? x1 - 10 : x1 + 10, y + 1);
  });

  tileFooter(g, optShare.byPitch);
  return new Promise((res) => cv.toBlob(res, "image/png"));
}

// shrink a line's font until it fits
function fitFont(g, text, weight, size, family, width) {
  for (; size > 11; size--) {
    g.font = `${weight} ${size}px ${family}`;
    if (g.measureText(text).width <= width) break;
  }
}

// both images' footer: what the spots are, the model (byPitch: the per-pitch one) and what one
// step is (per 100 PA, from data.tradeoff.per_sd, as the page's own axis note has it)
function tileFooter(g, byPitch) {
  const W = OPT_TILE.W;
  const d = Object.fromEntries(CATS.map((c, i) => [c, data.tradeoff.per_sd[i] * 100]));
  const f = (v) => `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
  const step = `A step toward Power is: K ${f(d.K)}, BB ${f(d.BB)}, HR ${f(d.HR)}, 1B ${f(d["1B"])}, 2B ${f(d["2B"])}, `
    + `outs in play ${f(d.GB + d.LD + d.FB + d.PU)}; toward Contact, the reverse`;
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.fillStyle = OPT_TILE.sub;
  const spots = `Lineup Spots are MLB-average wOBA for that spot. · ${MODELS[byPitch ? "pitch" : "pa"]}`;
  fitFont(g, spots, 400, 16, '"DM Sans"', W - 96);
  g.fillText(spots, 48, 836);
  fitFont(g, step, 400, 16, '"DM Sans"', W - 96);
  g.fillText(step, 48, 862);
}

// ---------- the contact-vs-power curve as an image ----------
// The curve above in the same style: runs per nine with every MLB spot moved together, the line
// on the sliders' teal-white-amber scale, with its ends and its middle labeled. The page's chart
// also marks this lineup; the image leaves it off.
let tradeoffShare = null;   // the curve the chart on screen shows: { pts, vs }
// The middle 95% of real starting lineups on this axis: 9,718 team-games of the 2025 and 2026 regular seasons, each
// hitter at his season's rates plus 200 PA of MLB average, a lineup at its nine's mean (the image shades it)
const LINEUP_BAND = [-0.41, 0.51];
const tradeoffFileName = () => `lineup_sim_contact_vs_power${tradeoffShare?.vs ? `_vs_${slug(pShort(tradeoffShare.vs.name))}` : ""}.png`;

async function tradeoffTileBlob() {
  const { pts, vs } = tradeoffShare;
  await Promise.all(['700 36px "DM Sans"', '400 21px "DM Sans"', '400 18px "DM Sans"', '400 16px "DM Sans"',
    '600 19px "JetBrains Mono"', '600 17px "JetBrains Mono"'].map((f) => document.fonts.load(f)));
  const logo = await loadLogo();
  const { W } = OPT_TILE, range = data.tradeoff.range;
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  const g = cv.getContext("2d");
  g.fillStyle = OPT_TILE.bg;
  g.fillRect(0, 0, W, W);
  // title, subtitle, wordmark
  g.font = '700 36px "DM Sans"';
  g.fillStyle = OPT_TILE.cyan;
  g.fillText("Contact vs Power", 48, 64);
  g.font = '400 21px "DM Sans"';
  g.fillStyle = OPT_TILE.sub;
  g.fillText(vs ? "Runs per 9" : "Runs per 9 at the same wOBA", 48, 100);
  g.drawImage(logo, W - 32 - 236, 27, 236, (236 * logo.naturalHeight) / logo.naturalWidth);
  const ctx = vs ? `vs ${vsWords(vs)}` : "vs MLB-average pitching";
  fitFont(g, ctx, 400, 18, '"DM Sans"', W - 96);
  g.fillStyle = OPT_TILE.axis;
  g.fillText(ctx, 48, 136);

  // the plot
  const L = 118, Rt = W - 48, T = 196, B = 708;
  const ys = pts.map((p) => p.R);
  const span = Math.max(...ys) - Math.min(...ys);
  const step = span > 0.45 ? 0.1 : 0.05;
  const y0 = Math.floor(Math.min(...ys) / step) * step, y1 = Math.ceil(Math.max(...ys) / step) * step;
  const x = (t) => L + ((t + range) / (2 * range)) * (Rt - L);
  const y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (B - T);
  // where real lineups sit, shaded under the gridlines
  const [b0, b1] = LINEUP_BAND;
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.fillRect(x(b0), T, x(b1) - x(b0), B - T);
  g.font = '400 17px "DM Sans"';
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let v = y0; v <= y1 + 1e-9; v += step) {
    g.strokeStyle = OPT_TILE.grid;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, y(v)); g.lineTo(Rt, y(v)); g.stroke();
    g.fillStyle = OPT_TILE.axis;
    g.fillText(v.toFixed(2), L - 14, y(v));
  }
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.strokeStyle = OPT_TILE.zero;
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(x(0), T - 10); g.lineTo(x(0), B); g.stroke();
  g.fillStyle = OPT_TILE.axis;
  g.fillText("MLB", x(0), T - 18);
  for (let t = -Math.floor(range); t <= Math.floor(range); t++) g.fillText(fmtStep(t), x(t), B + 30);
  g.font = '400 16px "DM Sans"';
  g.textAlign = "left";
  g.fillStyle = tiltColor(-range);
  g.fillText("← Contact", L, B + 58);
  g.textAlign = "right";
  g.fillStyle = tiltColor(range);
  g.fillText("Power →", Rt, B + 58);
  // the band's label, just outside its left edge: at the top, or at the bottom when the curve runs through the top
  // one (the curve's height between its points, across the label's width)
  const label = "95% of lineups", lx = x(b0) - 10, lw = g.measureText(label).width;
  const curveY = (t) => {
    const j = Math.max(1, pts.findIndex((p) => p.theta >= t)), a = pts[j - 1], b = pts[j];
    return y(a.R + ((t - a.theta) / (b.theta - a.theta)) * (b.R - a.R));
  };
  const clear = (ly) => Math.min(...Array.from({ length: 9 }, (_, i) => {
    const px = lx - lw + (i / 8) * lw;
    return Math.abs(curveY(((px - L) / (Rt - L)) * 2 * range - range) - ly);
  }));
  const [top, bottom] = [T + 22, B - 22];
  g.textBaseline = "middle";
  g.fillStyle = OPT_TILE.axis;
  g.fillText(label, lx, clear(top) >= 24 || clear(top) >= clear(bottom) ? top : bottom);
  g.textBaseline = "alphabetic";
  // the curve, colored by setting along the axis
  const grad = g.createLinearGradient(x(-range), 0, x(range), 0);
  grad.addColorStop(0, tiltColor(-range)); grad.addColorStop(0.5, "#fff"); grad.addColorStop(1, tiltColor(range));
  g.strokeStyle = grad;
  g.lineWidth = 6;
  g.lineJoin = g.lineCap = "round";
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.theta), y(p.R)) : g.moveTo(x(p.theta), y(p.R))));
  g.stroke();
  // its ends and its middle, labeled
  g.font = '600 17px "JetBrains Mono"';
  const lo = pts[0], hi = pts[pts.length - 1], mid = pts.find((p) => p.theta === 0);
  // the middle one centered above its point
  for (const [p, align, dx] of [[lo, "left", 10], [mid, "center", 0], [hi, "right", -10]]) {
    if (!p) continue;
    const color = tiltColor(p.theta), above = p.R >= (lo.R + hi.R) / 2 || p === mid;
    g.beginPath(); g.arc(x(p.theta), y(p.R), 7, 0, 2 * Math.PI);
    g.fillStyle = color; g.fill();
    g.lineWidth = 3; g.strokeStyle = OPT_TILE.bg; g.stroke();
    g.textAlign = align;
    g.fillStyle = color;
    g.fillText(p.R.toFixed(2), x(p.theta) + dx, y(p.R) + (above ? -18 : 32));
  }
  tileFooter(g, tradeoffShare.byPitch);
  return new Promise((res) => cv.toBlob(res, "image/png"));
}

// ---------- the runs-per-game chart as an image ----------
// The chart above in the same style: this lineup's share of games by runs scored (teal bars)
// against MLB's lineup spots facing the same pitching (an amber curve) and, with a pitcher picked,
// this lineup against MLB-average pitching (a white curve); the lineup down the left, the pitching
// as the subtitle, and runs per 9 with the comparisons' numbers in a box over the high-run end.
// mine: shares by run total, 12+ last; amber and white (async): shares by run total, every one
let runsShare = null;   // what the chart on screen shows: { mine, amber, white, R, subs: [[label, runs, color]], games, ids, team, ohtani, vs }
const runsFileName = () => `lineup_sim_runs_per_game${runsShare?.vs ? `_vs_${slug(pShort(runsShare.vs.name))}` : ""}.png`;

async function runsTileBlob() {
  const { mine, amber, white: whiteOf, R, subs, games, ids, team, ohtani: allOhtanis, vs, byPitch: pitchModel } = runsShare;
  const white = whiteOf ? await whiteOf() : null;
  await Promise.all(['700 36px "DM Sans"', '400 21px "DM Sans"', '400 18px "DM Sans"', '400 16px "DM Sans"', '600 15px "DM Sans"',
    '600 48px "JetBrains Mono"', '600 20px "JetBrains Mono"', '400 17px "JetBrains Mono"', '400 15px "DM Sans"'].map((f) => document.fonts.load(f)));
  const logo = await loadLogo();
  const { W } = OPT_TILE, n = mine.length;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const TEAL = css("--contact"), GOLD = css("--power"), WHITE = "#fff";
  const COLOR = { amber: GOLD, white: WHITE };
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  const g = cv.getContext("2d");
  g.fillStyle = OPT_TILE.bg;
  g.fillRect(0, 0, W, W);
  // title, the pitching as the subtitle, wordmark
  g.font = '700 36px "DM Sans"';
  g.fillStyle = OPT_TILE.cyan;
  g.fillText("Runs per Game", 48, 64);
  g.drawImage(logo, W - 32 - 236, 27, 236, (236 * logo.naturalHeight) / logo.naturalWidth);
  // the subtitle, led by a team lineup's abbreviation, breaks at its first comma, which the break replaces: "CLE vs.
  // Paul Skenes (Modeled Start: ~5.1IP)" / "Then the Pirates bullpen"; both lines in one size, the largest at which
  // each fits. In Oops! All Ohtanis! mode it's that, then "9 Ohtanis vs Shohei Ohtani for all nine innings"
  const sub = `${team ? `${team} ` : ""}vs. ${vs ? vs.full : "MLB-average pitching"}`, cut = sub.indexOf(", ");
  const subLines = allOhtanis ? ["Oops! All Ohtanis!", `9 Ohtanis vs ${vs?.full ?? "Shohei Ohtani"}`]
    : cut < 0 ? [sub] : [sub.slice(0, cut), sub[cut + 2].toUpperCase() + sub.slice(cut + 3)];
  let titleSize = 21;
  for (; titleSize > 12; titleSize--) {
    g.font = `400 ${titleSize}px "DM Sans"`;
    if (subLines.every((line) => g.measureText(line).width <= W - 96)) break;
  }
  g.fillStyle = OPT_TILE.sub;
  subLines.forEach((line, i) => g.fillText(line, 48, 100 + 28 * i));

  // the lineup, down the left ("1 - Shohei Ohtani"), level with the chart, each under a title
  // centered over it: "Lineup" over the names, "Distribution" over the chart
  const T = 196, B = 700, P0 = 362, P1 = W - 44, rowH = (B - T) / 9;
  g.font = '400 18px "DM Sans"';
  const rows = ids.map((id, i) => {
    const e = entryOf(id), spot = `${i + 1} - `, x = 48 + g.measureText(spot).width, room = P0 - x - 64;
    // MLB's spots read "Average 1st spot"; team spots and hitters by name
    const label = e.kind === "spot" && e.team === "MLB" ? `Average ${e.name.split(" · ")[1]}` : e.name;
    let name = e.theta != null ? `${label} ${fmtTheta(e.theta)}` : label;
    if (g.measureText(name).width > room) {
      while (name.length > 1 && g.measureText(`${name}…`).width > room) name = name.slice(0, -1);
      name += "…";
    }
    return { spot, x, name, end: x + g.measureText(name).width };
  });
  g.textBaseline = "middle";
  rows.forEach(({ spot, x, name }, i) => {
    const y = T + rowH * i + rowH / 2;
    g.fillStyle = OPT_TILE.sub;
    g.fillText(spot, 48, y);
    g.fillStyle = "#fff";
    g.fillText(name, x, y);
  });
  g.textBaseline = "alphabetic";
  g.textAlign = "center";
  g.font = '600 20px "DM Sans"';
  g.fillStyle = OPT_TILE.axis;
  g.fillText("Lineup", (48 + Math.max(...rows.map((r) => r.end))) / 2, T - 24);
  g.fillText("Distribution", (P0 + P1) / 2, T - 24);
  g.textAlign = "left";
  g.textBaseline = "middle"; // the gridlines' labels sit on their lines

  // the chart: gridlines and shares, teal bars, curves for the comparisons (white, then amber over it). Runs per 9 and the
  // smaller numbers stack in a rounded box over the last five columns, 8 to 12+ (the short high-run
  // end), a third of the y-axis tall, with the scale raised if the bars or curves there would reach it.
  const widthOf = (font, text) => { g.font = font; return g.measureText(text).width; };
  const band = (P1 - P0) / n, first = n - 5, pad = 12;
  const boxH = (B - T) / 3, boxW = band * 5;
  // the smaller numbers a row each, label left and value right, their type shrunk until the longest fits
  const rowW = (size) => Math.max(0, ...subs.map(([label, v]) =>
    widthOf(`400 ${size}px "DM Sans"`, label) + 10 + widthOf(`600 ${size + 4}px "JetBrains Mono"`, v.toFixed(2))));
  let subSize = 15;
  while (subSize > 11 && rowW(subSize) > boxW - 2 * pad) subSize--;
  // A curve is a Gaussian kernel density over the shares (0.6 runs wide, mirrored at the 0 column's
  // left edge so none of it falls below 0 runs), in share per run like the bars, sampled across the
  // columns. Over 12+ it shows games of about 12 runs, not 12 or more.
  const BW = 0.6, K = (u) => Math.exp(-0.5 * (u / BW) ** 2) / (BW * Math.sqrt(2 * Math.PI));
  const curve = (shares) => Array.from({ length: n * 20 + 1 }, (_, j) => {
    const x = -0.5 + j / 20;
    return [x, shares.reduce((t, sh, k) => t + sh * (K(x - k) + K(x + 1 + k)), 0)];
  });
  const curves = [[white, WHITE], [amber, GOLD]].filter(([sh]) => sh).map(([sh, color]) => ({ pts: curve(sh), color }));
  const reach = (from) => curves.flatMap((c) => c.pts.filter(([x]) => x >= from - 0.5).map(([, v]) => v));
  const high = Math.max(...mine.slice(first), ...reach(first));
  const top = Math.max(...mine, ...reach(0)), step = top > 0.16 ? 0.05 : 0.04;
  const yMax = Math.ceil(Math.max(top, high / (1 - (boxH + 12) / (B - T))) / step - 1e-9) * step;
  const y = (v) => T + (1 - v / yMax) * (B - T);
  const cx = (i) => P0 + band * i + band / 2;
  g.textAlign = "right";
  g.font = '400 16px "DM Sans"';
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    g.strokeStyle = OPT_TILE.grid;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(P0, y(v)); g.lineTo(P1, y(v)); g.stroke();
    g.fillStyle = OPT_TILE.axis;
    g.fillText(`${Math.round(v * 100)}%`, P0 - 12, y(v));
  }
  const bw = band * 0.62;
  g.fillStyle = TEAL;
  mine.forEach((v, i) => {
    const h = y(0) - y(v);
    if (h < 0.5) return;
    const r = Math.min(6, h / 2, bw / 2), x0 = cx(i) - bw / 2, x1 = cx(i) + bw / 2;
    g.beginPath();
    g.moveTo(x0, y(0)); g.lineTo(x0, y(v) + r); g.quadraticCurveTo(x0, y(v), x0 + r, y(v));
    g.lineTo(x1 - r, y(v)); g.quadraticCurveTo(x1, y(v), x1, y(v) + r); g.lineTo(x1, y(0));
    g.closePath();
    g.fill();
  });
  for (const { pts, color } of curves) {
    g.strokeStyle = color;
    g.lineWidth = 4;
    g.lineCap = g.lineJoin = "round";
    g.beginPath();
    pts.forEach(([x, v], j) => (j ? g.lineTo : g.moveTo).call(g, P0 + band * (x + 0.5), y(v)));
    g.stroke();
  }
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillStyle = OPT_TILE.axis;
  g.font = '400 17px "JetBrains Mono"';
  mine.forEach((_, i) => g.fillText(i === n - 1 ? `${i}+` : String(i), cx(i), B + 30));
  g.font = '400 16px "DM Sans"';
  g.fillText("Runs", (P0 + P1) / 2, B + 58);

  // the box: runs per 9 centered, then the smaller numbers, each number in its series' color
  const x0 = P0 + band * first, y0 = T, mid = x0 + boxW / 2, rad = 14;
  g.beginPath();
  g.moveTo(x0 + rad, y0);
  g.arcTo(x0 + boxW, y0, x0 + boxW, y0 + boxH, rad);
  g.arcTo(x0 + boxW, y0 + boxH, x0, y0 + boxH, rad);
  g.arcTo(x0, y0 + boxH, x0, y0, rad);
  g.arcTo(x0, y0, x0 + boxW, y0, rad);
  g.closePath();
  g.fillStyle = "rgb(49,53,79)";
  g.fill();
  g.strokeStyle = "#4b5075";
  g.lineWidth = 1.5;
  g.stroke();
  // with no smaller numbers, runs per 9 sits in the middle of the box
  const lift = subs.length ? 0 : (boxH - 88) / 2;
  g.textAlign = "center";
  g.font = '400 16px "DM Sans"';
  g.fillStyle = OPT_TILE.sub;
  g.fillText("Runs per 9", mid, y0 + 26 + lift);
  g.font = '600 48px "JetBrains Mono"';
  g.fillStyle = TEAL;
  g.fillText(R.toFixed(2), mid, y0 + 72 + lift);
  g.strokeStyle = "#4b5075";
  g.lineWidth = 1;
  if (subs.length) { g.beginPath(); g.moveTo(x0 + pad, y0 + 88); g.lineTo(x0 + boxW - pad, y0 + 88); g.stroke(); }
  const subH = (boxH - 88) / subs.length;
  subs.forEach(([label, v, color], k) => {
    const yb = y0 + 88 + subH * (k + 0.5) + 6;
    g.textAlign = "left";
    g.font = `400 ${subSize}px "DM Sans"`;
    g.fillStyle = OPT_TILE.sub;
    g.fillText(label, x0 + pad, yb);
    g.textAlign = "right";
    g.font = `600 ${subSize + 4}px "JetBrains Mono"`;
    g.fillStyle = COLOR[color];
    g.fillText(v.toFixed(2), x0 + boxW - pad, yb);
  });

  // the key, in the box's order, in one row spread evenly from the lineup's numbers to the chart's right
  // edge: when that's too tight, labels break before "vs" onto a second line, the widest first ("Avg
  // Lineup" / "vs Skenes + bullpen"), and only then does the type shrink
  const keys = [["bar", TEAL, vs ? `This lineup vs ${vs.short}` : "This lineup"],
    ...(amber ? [["line", GOLD, vs ? `Avg Lineup vs ${vs.short}` : "Avg Lineup"]] : []),
    ...(white ? [["line", WHITE, "This lineup vs Avg Pitching"]] : [])]
    .map(([kind, color, text]) => ({ kind, color, lines: [text], swatch: kind === "bar" ? 26 : 34 }));
  g.textAlign = "left";
  let keySize = 16;
  g.font = `400 ${keySize}px "DM Sans"`;
  const keyW = (k) => k.swatch + Math.max(...k.lines.map((l) => g.measureText(l).width));
  const K0 = 48, K1 = P1, keysW = () => keys.reduce((a, k) => a + keyW(k), 0);
  const keyRowW = () => keysW() + 30 * (keys.length - 1);
  while (keyRowW() > K1 - K0) {
    const k = keys.filter((k) => k.lines.length === 1 && k.lines[0].includes(" vs ")).sort((a, b) => keyW(b) - keyW(a))[0];
    if (!k) break;
    const i = k.lines[0].indexOf(" vs ");
    k.lines = [k.lines[0].slice(0, i), k.lines[0].slice(i + 1)];
  }
  while (keySize > 12 && keyRowW() > K1 - K0) g.font = `400 ${--keySize}px "DM Sans"`;
  // (labels too long even then run past the chart's edge rather than into each other)
  const gap = keys.length > 1 ? Math.max(12, (K1 - K0 - keysW()) / (keys.length - 1)) : 0;
  // the last line sits where the single row did; a one-line label beside two-line ones is centered on them
  const keyLh = keySize + 4, keyMid = keys.some((k) => k.lines.length > 1) ? 838 - keyLh / 2 : 838, cy = keyMid - keySize * 0.375;
  let kx = K0;
  for (const k of keys) {
    if (k.kind === "bar") {
      g.fillStyle = k.color;
      g.fillRect(kx, cy - 8, 16, 16);
    } else {
      g.strokeStyle = k.color;
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(kx + 2, cy); g.lineTo(kx + 22, cy); g.stroke();
    }
    g.fillStyle = OPT_TILE.sub;
    k.lines.forEach((l, i) => g.fillText(l, kx + k.swatch, keyMid + keyLh * (i - (k.lines.length - 1) / 2)));
    kx += keyW(k) + gap;
  }
  g.font = '400 16px "DM Sans"';
  g.fillText(`${games.toLocaleString()} simulated games · ${MODELS[pitchModel ? "pitch" : "pa"]}`, 48, 868);
  return new Promise((res) => cv.toBlob(res, "image/png"));
}

// ---------- URL state ----------
function writeHash() {
  const p = new URLSearchParams({ l: lineup.join(","), g: $("games").value, r: $("regress").value, b: basis,
    t: $("team").value, k: mode, e: edited ? "1" : "0", a: $("tilt_all").value });
  if (pitcher) {
    p.set("p", pitcher.mlbam);
    if ($("p_hook").value !== "game") p.set("h", $("p_hook").value);
    if ($("p_hook").value === "follower" && follower) p.set("f", follower.mlbam);
    if ($("platoon").value !== "own") p.set("pl", $("platoon").value);
    if (pitcher.quality) p.set("pq", pitcher.quality.toFixed(1));
  }
  if (ohtani) p.set("o", "1");
  if (byPitch) p.set("m", "pitch");
  history.replaceState(null, "", `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const R = data.tradeoff.range;
  // a link from when the sliders reached further keeps its spots, at the end of the range
  const ids = (p.get("l") ?? "").split(",").map((id) => {
    const at = id.indexOf("@"), t = Number(id.slice(at + 1));
    return at > 0 && Math.abs(t) > R ? tiltId(id.slice(0, at), Math.sign(t) * R) : id;
  });
  for (const [key, sel] of [["g", "games"], ["r", "regress"], ["t", "team"], ["k", "kind"]]) {
    const v = p.get(key);
    if (v && [...$(sel).options].some((o) => o.value === v)) $(sel).value = v;
  }
  if (p.get("b") === "sim") basis = "sim";
  pitcher = pitchers.get(`P${p.get("p")}`) ?? null;
  const pq = Number(p.get("pq"));
  if (pitcher?.generic && quality && pq) pitcher = hypothetical(pitcher.throws, Math.max(-quality.range, Math.min(quality.range, pq)));
  const h = p.get("h");
  if (pitcher && h && [...$("p_hook").options].some((o) => o.value === h)) $("p_hook").value = h;
  follower = pitchers.get(`P${p.get("f")}`) ?? null;
  const pl = p.get("pl");
  if (pl && [...$("platoon").options].some((o) => o.value === pl)) $("platoon").value = pl;
  wantPitch = p.get("m") === "pitch";
  const a = Number(p.get("a"));
  if (Number.isFinite(a)) setMaster(Math.max(-R, Math.min(R, a)));
  if (ids.length === 9 && ids.every((id) => entryOf(id))) {
    return { ids, edited: p.get("e") === "1", ohtani: p.get("o") === "1" };
  }
  return null;
}

// ---------- boot ----------
// ---------- the lineup card folds ----------
// The card folds to a summary (index.html's CSS does the folding), so the results lead; Edit
// lineup opens it, and Done folds it back. Phones open folded, wider screens open with the whole
// card (a script in index.html, before the first paint).
const surname = (n) => {
  const w = n.split(" ").filter((x) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(x));
  return w.length > 1 ? w.slice(1).join(" ") : n;
};
function setFolded(folded, scroll = false) {
  $("lineup_card").classList.toggle("folded", folded);
  $("lineup_toggle").textContent = folded ? "Edit lineup" : "Done";
  $("lineup_toggle").setAttribute("aria-expanded", String(!folded));
  // folding from the Done at its foot can leave the card's top above the screen
  if (scroll && $("lineup_card").getBoundingClientRect().top < 0) $("lineup_card").scrollIntoView({ block: "start" });
}
function renderSummary() {
  if (!lineup.length) return;
  const team = $("team").selectedOptions[0]?.text ?? "MLB";
  const what = ohtani ? "Oops! All Ohtanis!"
    : edited ? "Custom lineup"
    : mode === "tradeoff" ? "MLB spots (contact–power)"
    : mode === "most_used" ? `${team}: most-used order` : `${team}: lineup spots`;
  $("sum_what").textContent = `${what} vs ${planWords(true).words}`;
  // then the nine, unless they're a team's spots in order (all at one setting, for contact-power)
  const es = lineup.map(entryOf).filter(Boolean);
  let who = es.map((e, i) => {
    const name = e.kind !== "spot" ? surname(e.name)
      : e.team === "MLB" ? `${e.name.split(" · ")[1].replace(" spot", "")}-spot` : e.name.replace(" spot", "").replace(" · ", " ");
    // each one wraps whole: no-break spaces and hyphens inside it
    return `${i + 1} ${name}${e.theta != null ? ` ${fmtTheta(e.theta)}` : ""}`.replace(/ /g, "\u00a0").replace(/-/g, "\u2011");
  }).join("\u00a0· "); // the dot ends a line rather than starting one
  if (ohtani) who = "Ohtani ×9";
  else if (!edited && mode === "spots") who = "";
  else if (!edited && mode === "tradeoff") who = es[0]?.theta ? `All nine spots ${fmtTheta(es[0].theta)}` : "";
  $("sum_who").textContent = who;
  $("sum_who").hidden = !who;
}

async function boot() {
  // the hypothetical pitcher's axes, small; without them there's no quality slider
  const qualityFile = fetch(`data/${SEASON}-quality.json?v=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  try {
    const r = await fetch(`data/${SEASON}.json?v=5`);
    if (!r.ok) throw new Error(`data ${r.status}`);
    data = await r.json();
    quality = await qualityFile;
  } catch (e) {
    $("status").textContent = `Couldn't load the ${SEASON} data (${e.message}).`;
    $("status").classList.add("err");
    return;
  }
  model = prepare(data);
  buildEntries();
  fillTeams();
  const w = data.weights;
  $("weights").textContent = `uBB ${w.wBB.toFixed(3)}, HBP ${w.wHBP.toFixed(3)}, 1B ${w.w1B.toFixed(3)}, 2B ${w.w2B.toFixed(3)}, 3B ${w.w3B.toFixed(3)}, HR ${w.wHR.toFixed(3)}`;
  const fmtDay = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  $("data_range").textContent = `${fmtDay(data.range[0])} to ${fmtDay(data.range[1])}, regular season`;
  const sm = data.sims.mlb, am = data.mlb.actual;
  const gap = (100 * (sm.R - am.R)) / am.R;
  $("calibration").textContent = `As a check, MLB's pooled lineup spots simulate to ${sm.R.toFixed(2)} runs per nine innings against an actual ${am.R.toFixed(2)} `
    + `(${Math.abs(gap).toFixed(1)}% ${gap < 0 ? "low" : "high"}), and to a ${fmtRate(sm.AVG)}/${fmtRate(sm.OBP)}/${fmtRate(sm.SLG)} line against an actual `
    + `${fmtRate(am.AVG)}/${fmtRate(am.OBP)}/${fmtRate(am.SLG)}.`;
  const ex = exactRuns(Array.from({ length: 9 }, (_, i) => `sMLB-${i + 1}`), null);
  $("exact_check").textContent = `for MLB's lineup spots, ${ex.toFixed(3)} runs per nine innings exactly against `
    + `${sm.R.toFixed(3)} over ${data.sims.games.toLocaleString()} simulated games`;

  setupTradeoff();
  setupOptimizer();
  const rn = data.pitching.relief.reduce((s, x) => s + x, 0), ln = data.pitching.league.reduce((s, x) => s + x, 0);
  $("relief_k").textContent = `${pct(data.pitching.relief[C.K] / rn)} of hitters, against ${pct(data.pitching.league[C.K] / ln)} overall`;
  const rc = data.pitching.relief_cells, lc = data.pitching.cells;
  $("relief_l").textContent = pct((countOf(rc.LL) + countOf(rc.LR)) / rn);
  const P = data.pitching;
  $("opener_n").textContent = `${P.opener.games} games in ${SEASON}; the median opener recorded ${P.opener.outs} out${P.opener.outs === 1 ? "" : "s"} (${fmtIP(P.opener.outs)} IP)`;
  $("follower_n").textContent = `${P.follower.games} games; the median follower recorded ${P.follower.outs} outs (${fmtIP(P.follower.outs)} IP)`;
  $("bulk_n").textContent = `every ${SEASON} relief outing of three innings or more, ${P.bulk.outings} of them`;
  $("platoon_gap").textContent = `a ${fmtRate(wobaOf(lc.LL))} wOBA for left-handed batters against left-handers (${fmtRate(wobaOf(lc.RL))} against `
    + `right-handers) and ${fmtRate(wobaOf(lc.RR))} for right-handed batters against right-handers (${fmtRate(wobaOf(lc.LR))} against left-handers)`;
  const saved = readHash(); // before wiring controls: it sets their values, `basis` and `pitcher`
  if (wantPitch) {
    try {
      await loadPitchData();
      byPitch = true;
    } catch (e) {
      $("status").textContent = `Couldn't load the per-pitch model (${e.message}), so this is Per-PA.`;
    }
  }
  paintModel();
  document.querySelectorAll("#model_toggle button").forEach((b) => b.addEventListener("click", () => setModel(b.dataset.model === "pitch")));
  if ($("p_hook").value === "hook") {
    try {
      await loadHookData();
    } catch (e) {
      $("p_hook").value = "start";
      $("status").textContent = `Couldn't load the hook model (${e.message}), so this is his average start.`;
    }
  }
  renderPitcher();
  if (window.ResizeObserver) new ResizeObserver(() => fitHookLabels()).observe($("p_hook"));
  document.fonts?.ready.then(fitHookLabels); // measured in DM Sans, not a fallback
  paintBasis();
  document.querySelectorAll(".basis button[data-basis]").forEach((b) => {
    b.addEventListener("click", () => {
      basis = b.dataset.basis;
      paintBasis();
      writeHash();
      if (last) renderResults();
    });
  });
  // opening the box lists the hypothetical pitchers; picking the other hand keeps the setting
  wireSuggest($("p_in"), $("p_sug"), { find: findPitchers, current: () => pitcher?.name ?? "", browse: !!quality,
    choose: (e) => setPitcher(e.generic && pitcher?.generic ? hypothetical(e.throws, pitcher.quality ?? 0) : e),
    small: (e) => (e.generic ? `Every 2026 ${handOf(e)} · quality slider` : smallOf(e)) });
  if (quality) {
    $("quality").min = -quality.range;
    $("quality").max = quality.range;
    $("quality").addEventListener("input", () => {
      setQuality(Number($("quality").value));
      scheduleRun();
    });
    $("quality_reset").addEventListener("click", () => {
      setQuality(0);
      run();
    });
    fillQualityWords();
  }
  $("p_clear").addEventListener("click", () => {
    setPitcher(null);
    $("p_in").focus();
  });
  wireSuggest($("f_in"), $("f_sug"), { find: findFollowers, choose: setFollower, current: () => follower?.name ?? "",
    browse: true, small: followerSmall });
  $("f_clear").addEventListener("click", () => {
    setFollower(null);
    $("f_in").focus();
  });
  $("p_hook").addEventListener("change", async () => {
    if ($("p_hook").value === "hook" && !hookData) {
      $("status").classList.remove("err");
      $("status").textContent = "loading the hook model…";
      try {
        await loadHookData();
      } catch (e) {
        $("p_hook").value = "start";
        $("status").textContent = `Couldn't load the hook model (${e.message}).`;
        $("status").classList.add("err");
      }
    }
    renderPitcher();
    run();
  });
  $("platoon").addEventListener("change", () => {
    renderPitcher();
    renderLineup(); // the table's rates against him change with it
    run();
  });
  $("team").addEventListener("change", () => {
    // picking a team leaves contact vs power, which works on the MLB spots
    if ($("kind").value === "tradeoff" && $("team").value !== "MLB") $("kind").value = "spots";
    loadPreset();
  });
  $("kind").addEventListener("change", loadPreset);
  $("games").addEventListener("change", run);
  $("regress").addEventListener("change", () => {
    if (pitcher) renderLineup(); // the table's rates against him take in the setting
    run();
  });
  $("tilt_all").addEventListener("input", () => {
    const theta = Number($("tilt_all").value);
    setMaster(theta);
    lineup.forEach((_, i) => setTilt(i, theta));
    scheduleRun();
  });
  $("tilt_reset").addEventListener("click", () => {
    setMaster(0);
    lineup.forEach((_, i) => setTilt(i, 0));
    run();
  });
  $("reset_all").addEventListener("click", resetSettings);
  $("lineup_toggle").addEventListener("click", () => setFolded($("lineup_toggle").getAttribute("aria-expanded") === "true", true));
  $("lineup_done").addEventListener("click", () => {
    setFolded(true, true);
    $("lineup_toggle").focus({ preventScroll: true });
  });
  // the optimizer chart's Share image button (shared/share-image.js)
  if (window.ShareImage) {
    ShareImage.image($("opt_share"), optTileBlob, optFileName);
    ShareImage.image($("tradeoff_share"), tradeoffTileBlob, tradeoffFileName);
    ShareImage.image($("runs_share"), runsTileBlob, runsFileName);
  } else $("opt_share").hidden = $("tradeoff_share").hidden = $("runs_share").hidden = true;
  // another season's data might not have him both ways
  $("ohtani_box").hidden = !entries.has(`p${OHTANI}`) || !pitchers.has(`P${OHTANI}`);
  $("ohtani").addEventListener("change", () => setOhtani($("ohtani").checked));

  if (saved) {
    $("kind").querySelector("[value=most_used]").disabled = $("team").value === "MLB";
    lineup = saved.ids;
    edited = saved.edited;
    mode = $("kind").value;
    if (saved.ohtani && allOhtani()) {
      ohtani = true;
      renderLineup();
      run();
      return;
    }
    if (!edited && mode !== "tradeoff") { loadPreset(); return; }
    renderLineup();
    run();
  } else {
    loadPreset();
  }
}

boot();
