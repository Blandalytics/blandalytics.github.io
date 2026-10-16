import { CATS, bullpenOf, cumulative, facing, hitterOf, pitcherOf, prepare, simulate, summarize, tilt } from "./sim.js?v=4";
import { chainTables, expectedLines, lineupRuns, matchup, optimize } from "./markov.js?v=3";

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
const pitchers = new Map(); // "P<id>" -> { id, mlbam, kind: "pitcher", name, team, throws, counts, cells, pa (BF), gs, startOuts, search }
let pitcher = null;        // the opposing pitcher; null is MLB-average pitching
let league = null;         // { all, cells }: MLB's outcome chances overall and in each platoon cell ("RL": LHB vs RHP)
const tilted = new Map();  // "sMLB-3@-1.5" -> that spot moved 1.5 SD toward contact
let lineup = [];
let mode = "spots";        // what was loaded: "spots", "most_used" or "tradeoff"
let loadedNote = "";
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

// A contact-power slider takes its setting's color: white at 0, blending toward the brand
// teal at the contact end and the brand amber at the power end (--contact and --power in
// index.html), all the way there at the end of the range.
let tiltEnds = null;
function tintRange(range, theta) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  tiltEnds ??= ["--contact", "--power"].map((v) => rgb(getComputedStyle(document.documentElement).getPropertyValue(v).trim()));
  const f = Math.max(-1, Math.min(1, theta / data.tradeoff.range)), end = tiltEnds[f < 0 ? 0 : 1];
  range.style.accentColor = `rgb(${end.map((c) => Math.round(255 + (c - 255) * Math.abs(f))).join(", ")})`;
}

const labelOf = (e) => (e.theta ? `${e.name}, ${e.theta < 0 ? "contact" : "power"} ${Math.abs(e.theta).toFixed(1)}` : e.name);

// ---------- data ----------
function buildEntries() {
  const nameOf = new Map();
  // pa: the plate appearances shown (official, with IBB and bunts); the rates use counts
  for (const [id, name, team, counts, pa, cells, bats] of data.players) {
    nameOf.set(id, name);
    const side = { L: "bats L", R: "bats R", S: "switch" }[bats];
    entries.set(`p${id}`, { id: `p${id}`, kind: "player", name, team, counts, pa, cells, bats,
      sub: [team, side, `${pa.toLocaleString()} PA`].filter(Boolean).join(" · "), search: fold(name) });
  }
  const spotsOf = (abbr, label, short, spots) => spots.forEach((s, i) => {
    const pa = s.counts.reduce((a, x) => a + x, 0);
    const who = abbr === "MLB" ? "all 30 teams"
      : s.top.map(([pid, n]) => `${lastName(nameOf.get(pid) ?? String(pid))} ${Math.round((100 * n) / pa)}%`).join(", ");
    entries.set(`s${abbr}-${i + 1}`, { id: `s${abbr}-${i + 1}`, kind: "spot", name: `${label} · ${ordinal(i + 1)} spot`,
      team: abbr, counts: s.counts, cells: s.cells, pa, sub: `${pa.toLocaleString()} PA: ${who}`,
      search: fold(`${label} ${short} ${abbr} ${i + 1} spot`) });
  });
  spotsOf("MLB", "MLB", "mlb league average", data.mlb.spots);
  for (const t of data.teams) spotsOf(t.abbr, t.short, `${t.name} ${t.abbr}`, t.spots);
  const totals = data.mlb.spots.reduce((acc, s) => acc.map((x, i) => x + s.counts[i]), CATS.map(() => 0));
  const n = totals.reduce((s, x) => s + x, 0);
  prior = totals.map((x) => x / n);
  for (const [id, name, team, throws, counts, bf, gs, startOuts, cells] of data.pitchers) {
    pitchers.set(`P${id}`, { id: `P${id}`, mlbam: id, kind: "pitcher", name, team, throws, counts, cells, pa: bf, gs, startOuts,
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
      gs: own.reduce((t, r) => t + r[6], 0), startOuts: own.reduce((t, r) => t + r[7], 0),
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
    loadedNote = TRADEOFF_NOTE;
    // the differences are small; fewer games would bury them in noise
    if (Number($("games").value) < 50000) $("games").value = "50000";
  } else if (kind === "spots") {
    lineup = Array.from({ length: 9 }, (_, i) => `s${abbr}-${i + 1}`);
    const pa = lineup.reduce((s, id) => s + entryOf(id).pa, 0);
    loadedNote = abbr === "MLB"
      ? `Every MLB hitter, pooled by the lineup spot they batted in (${pa.toLocaleString()} PA).`
      : `Every ${teamOf(abbr).short} hitter, pooled by the lineup spot they batted in (${pa.toLocaleString()} PA).`;
  } else {
    const t = teamOf(abbr), mu = t.most_used, o = mu.orders[0];
    lineup = o.ids.map((id) => `p${id}`);
    const when = new Date(o.last + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tie = mu.orders.length > 1 && mu.orders[1].uses === o.uses ? " (tied; the most recent of them)" : "";
    loadedNote = `${t.short}' most-used order${tie}: started ${o.uses} of ${mu.games} games, last on ${when}. `
      + `They used ${mu.distinct} different orders.`;
  }
  edited = false;
  renderLineup();
  run();
}

// ---------- lineup table ----------
// columns after the hitter: [header, class, value(entry)]; contact vs power shows the
// stats the tradeoff moves, with wOBA last to show it holding still
// value(entry, c): c is the hitter's outcomes as shownOf() has them
const COLS = {
  normal: [
    ["PA", "opt2", (e) => paShown(e).toLocaleString()],
    ["K%", "opt", (e, c) => pct(lineOf(c).K)],
    ["BB%", "opt", (e, c) => pct(lineOf(c).BB)],
    ["wOBA", "", (e, c) => fmtRate(wobaOf(c))],
  ],
  tradeoff: [
    ["K%", "opt2", (e, c) => pct(lineOf(c).K)],
    ["BB%", "opt", (e, c) => pct(lineOf(c).BB)],
    ["AVG", "opt", (e, c) => fmtRate(lineOf(c).AVG)],
    ["SLG", "opt", (e, c) => fmtRate(lineOf(c).SLG)],
    ["wOBA", "", (e, c) => fmtRate(wobaOf(c))],
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
  $("loaded").textContent = !edited ? loadedNote : loadedNote ? `${loadedNote} Edited since.` : "Custom lineup.";
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
function wireSuggest(input, list, { find, choose: take, current }) {
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
    const sections = find(input.value);
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
        const small = document.createElement("small");
        small.textContent = smallOf(e);
        li.append(name, small);
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
  input.addEventListener("focus", () => input.select());
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
// He pitches until `hook` outs into the game (27: all nine innings), then the bullpen.
const hookOf = () => (pitcher && $("p_hook").value === "start" && pitcher.gs > 0 ? Math.round(pitcher.startOuts / pitcher.gs) : 27);
const fmtIP = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
const handOf = (e) => ({ L: "LHP", R: "RHP" })[e.throws] ?? "P";
const countOf = (c) => (c ? c.reduce((a, x) => a + x, 0) : 0);
// platoon splits only come into it once a pitcher (and so a hand) is picked
const platoonOf = () => (pitcher ? $("platoon").value : "off");

// What the matchups need (markov.js's `vs`): the starter's pitching and the bullpen's as
// facing() takes them (sim.js), or null against MLB-average pitching. Small samples adds
// MLB-average batters faced to the pitcher as it adds PA to a hitter.
function vsOf() {
  if (!pitcher) return null;
  const mode = $("platoon").value, hook = hookOf(), regress = pitcher.generic ? 0 : Number($("regress").value);
  return { sp: pitcherOf(pitcher.counts, pitcher.cells, pitcher.throws, { mode, league, regress }),
    pen: hook < 27 ? bullpenOf(data.pitching.relief, data.pitching.relief_cells, { mode, league }) : null, hook };
}
// everything vsOf() depends on: results computed against one key don't fit another
const vsKey = () => (pitcher ? `${pitcher.id}|${hookOf()}|${$("regress").value}|${$("platoon").value}` : "");

// A lineup entry as facing() takes it: its own outcome chances (Small samples applied to
// hitters), split by platoon cell once a pitcher is picked. A tilted MLB spot comes moved
// along the contact-power axis, or, with tilted false, as the spot is at 0.
function specOf(e, tilted = true) {
  const b = e.base ? entries.get(e.base) : e;
  const h = hitterOf(b.counts, b.cells, { mode: platoonOf(), league, regress: b.kind === "player" ? Number($("regress").value) : 0, bats: b.bats });
  if (!tilted || !e.theta) return h;
  const mv = (x) => tilt(x, data.tradeoff.per_sd, e.theta);
  return { all: mv(h.all), parts: h.parts && Object.fromEntries(Object.entries(h.parts).map(([k, ps]) => [k, ps.map((q) => ({ ...q, b: mv(q.b) }))])) };
}

// a hitter's outcomes as the lineup table shows them: 2026 rates, or against the
// pitcher (his own innings, not the bullpen's)
function shownOf(e, vs = vsOf()) {
  return vs ? facing(specOf(e), vs.sp) : e.counts;
}

function findPitchers(q) {
  const f = fold(q.trim());
  if (!f) return [];
  const words = f.split(/\s+/);
  const list = [...pitchers.values()].filter((e) => words.every((w) => e.search.includes(w)));
  const starts = (e) => (e.search.split(" ").some((w) => w.startsWith(words[0])) ? 0 : 1);
  list.sort((a, b) => starts(a) - starts(b) || b.pa - a.pa);
  return [["2026 pitchers", list.slice(0, 25)]];
}

function setPitcher(e) {
  pitcher = e;
  // like for like: the teams' lineup spots against him too
  if (e && basis !== "sim") {
    basis = "sim";
    paintBasis();
  }
  renderPitcher();
  renderLineup();
  run();
}

function renderPitcher() {
  $("p_in").value = pitcher ? pitcher.name : "";
  $("p_clear").hidden = !pitcher;
  const sel = $("p_hook"), start = sel.querySelector("[value=start]");
  sel.disabled = !pitcher;
  start.disabled = !pitcher?.gs;
  if (start.disabled && sel.value === "start") sel.value = "game";
  start.textContent = pitcher?.gs ? `His average start (${fmtIP(Math.round(pitcher.startOuts / pitcher.gs))} IP), then bullpen`
    : "His average start, then bullpen";
  $("platoon").disabled = !pitcher;
  const note = $("p_note");
  note.classList.remove("warn");
  if (!pitcher) {
    note.textContent = "Hitters bat at their own 2026 rates, which were against MLB-average pitching. "
      + "Pick a pitcher, or type RHP or LHP for an MLB-average right- or left-hander.";
    return;
  }
  const l = lineOf(pitcher.counts), e = pitcher, mode = $("platoon").value;
  // his wOBA against each side, where he faced it
  const sides = ["L", "R"].filter((s) => countOf(e.cells?.[s])).map((s) => `${fmtRate(wobaOf(e.cells[s]))} vs ${s}HB`);
  note.textContent = (e.generic
    ? `Every 2026 ${e.throws === "L" ? "left" : "right"}-hander pooled: ${e.pa.toLocaleString()} batters faced, K ${pct(l.K)}, BB ${pct(l.BB)}, `
      + `${fmtRate(l.wOBA)} wOBA against (${sides.join(", ")}); starts averaged ${fmtIP(Math.round(e.startOuts / e.gs))} innings. `
    : `${e.name} (${e.team}, ${handOf(e)}), 2026: ${e.pa.toLocaleString()} batters faced, K ${pct(l.K)}, BB ${pct(l.BB)}, `
      + `${fmtRate(l.AVG)} AVG and ${fmtRate(l.wOBA)} wOBA against${mode === "off" ? "" : ` (${sides.join(", ")})`}; `
      + (e.gs ? `${e.gs} start${e.gs === 1 ? "" : "s"} averaging ${fmtIP(Math.round(e.startOuts / e.gs))} innings. ` : "no starts. "))
    + `The table shows each hitter's rates against him (log5${mode === "own" ? ", with both players' platoon splits"
      : mode === "league" ? ", with league-average platoon gaps" : ""}).`;
  const thin = ["L", "R"].filter((s) => countOf(e.cells?.[s]) < 60);
  if (!e.generic && (e.pa < 100 || (mode === "own" && thin.length))) {
    note.textContent += e.pa >= 100 ? ` Small sample against ${thin.map((s) => `${s}HB`).join(" and ")}: consider adding MLB-average PA below, or league-average platoon gaps.`
      : " Small sample: consider adding MLB-average PA below.";
    note.classList.add("warn");
  }
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
let worker = null;
let useWorker = typeof Worker !== "undefined";

function startWorker() {
  const w = new Worker(new URL("./sim-worker.js?v=4", import.meta.url), { type: "module" });
  w.postMessage({ type: "init", tables: { running: data.running, advance: data.advance } });
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
  const key = vsKey(), vs = vsOf();
  if (optJob && (lineup.join() !== optJob.ids.join() || key !== optJob.key)) {
    stopSearch(`Search stopped: the ${key !== optJob.key ? "pitching" : "lineup"} changed. Optimize again for this one.`);
  }
  const games = Number($("games").value);
  const specs = lineup.map((id) => specOf(entryOf(id)));
  const cums = specs.map((h) => cumulative(facing(h, vs?.sp ?? null)));
  const pen = vs?.pen ? specs.map((h) => cumulative(facing(h, vs.pen))) : null;
  let ref = null, lines = null;
  if (vs && versus.key !== key) {
    // each lineup's hitters matched against the starter and the bullpen here; the worker
    // only needs the chances
    const spots = (abbr) => Array.from({ length: 9 }, (_, i) => specOf(entries.get(`s${abbr}-${i + 1}`)));
    const matched = (hs, theta = 0) => hs.map((h) => ({ sp: facing(h, vs.sp, theta, data.tradeoff.per_sd),
      pen: vs.pen ? facing(h, vs.pen, theta, data.tradeoff.per_sd) : null }));
    const mlb = spots("MLB"), m0 = matched(mlb);
    ref = { lineup: m0.map((x) => cumulative(x.sp)), pen: vs.pen ? m0.map((x) => cumulative(x.pen)) : null, games: REF_GAMES };
    lines = { w: data.weights, lineups: [m0, ...data.teams.map((t) => matched(spots(t.abbr))),
      ...data.sims.tradeoff.points.map((pt) => matched(mlb, pt.theta))] };
  }
  const busy = job != null;
  job = { id: ++jobs, cums, pen, hook: vs?.hook ?? 27, games, ids: [...lineup], key, vs, name: pitcher?.name, ref, lines };
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
  worker.postMessage({ id: job.id, lineup: cums, pen, hook: job.hook, games, seed: SEED, ref, lines });
}

function runHere(j) {
  // let the status paint before the (blocking) run
  setTimeout(() => {
    if (job !== j) return;
    const t0 = performance.now();
    const res = simulate(model, j.cums, j.games, SEED, j.pen, j.hook);
    const ms = performance.now() - t0;
    const ref = j.ref && simulate(model, j.ref.lineup, j.ref.games, SEED, j.ref.pen, j.hook).runDist;
    const lines = j.lines && expectedLines((chain ??= chainTables(model)), j.lines.lineups, j.hook, j.lines.w);
    finish(j, res, ms, ref, lines);
  }, 30);
}

function finish(j, res, ms, ref, lines) {
  job = null;
  if (lines) {
    const n = data.teams.length;
    versus = { key: j.key, ctx: { refDist: ref, mlb: lines[0], teams: Object.fromEntries(data.teams.map((t, i) => [t.abbr, lines[1 + i]])),
      tradeoff: data.sims.tradeoff.points.map((pt, i) => ({ theta: pt.theta, ...lines[1 + n + i] })) } };
  }
  last = { res, sum: summarize(res.totals, data.weights), games: j.games, lineup: j.ids, key: j.key, vs: j.vs, name: j.name,
    hook: j.hook, ctx: j.vs ? versus.ctx : null };
  $("out").hidden = false;
  $("out").style.opacity = "";
  $("status").textContent = `${j.games.toLocaleString()} games simulated in ${(ms / 1000).toFixed(2)} s.`;
  $("status").classList.toggle("err", res.capped > 0);
  if (res.capped) {
    $("status").textContent += ` ${res.capped.toLocaleString()} innings were called off at 60 plate appearances: this lineup almost never makes an out. `
      + "Adding MLB-average PA under Small samples fixes that.";
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

// "Skubal for 5.2 innings, then the bullpen" / "Skubal for all nine innings"
const vsWords = (l) => `${lastName(l.name)} for ${l.hook < 27 ? `${fmtIP(l.hook)} innings, then the bullpen` : "all nine innings"}`;

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
  let second;
  if (last.vs) {
    // the pitcher's effect on this lineup, exactly: against him and against MLB-average pitching
    const avg = exactRuns(last.lineup, null), d = exactRuns(last.lineup, last.vs) - avg;
    second = kpi("Against MLB-average pitching", avg.toFixed(2), `${lastName(last.name)}: ${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} runs per 9 (exact)`);
  } else {
    second = kpi("Over 162 games", Math.round(s.R * 162).toLocaleString(), `MLB ${Math.round(r.mlb * 162).toLocaleString()}`);
  }
  $("kpis").replaceChildren(
    kpi(last.vs ? `Runs per 9 vs ${lastName(last.name)}` : "Runs per 9 innings", s.R.toFixed(2), `±${moe.toFixed(2)} (95%) · ${placeOf(rankOf(s.R, r.teams, 1))}`),
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
  const rank = " Rank is where this lineup would place among the 30 teams; for strikeouts, fewer ranks higher.";
  $("basis_note").textContent = basis === "actual"
    ? "Teams and MLB: actual 2026 batting in innings 1–9, per 27 outs (unintentional walks; OBP without intentional walks)." + rank
      + (last.ctx ? ` That batting was against all the pitching they faced, not ${lastName(last.name)}.` : "")
    : last.ctx
      ? `Teams and MLB: each team's nine lineup spots (and MLB's) against ${vsWords(last)}, worked out exactly rather than simulated.` + rank
      : `Teams and MLB: each team's nine lineup spots (and MLB's), run through the same simulation, ${data.sims.games.toLocaleString()} games each.` + rank;
  $("basis_sim").textContent = last.ctx ? `Teams' lineup spots vs ${lastName(last.name)}` : "Teams' lineup spots, simulated";
  $("runs_mlb_key").textContent = last.ctx ? `MLB lineup spots vs ${lastName(last.name)} (simulated)` : "MLB lineup (simulated)";

  runsChart(dist, games);
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

function paintBasis() {
  document.querySelectorAll(".basis button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.basis === basis)));
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

function runsChart(dist, games) {
  const MAX = 13; // last bucket is 13+
  const share = (arr, total) => {
    const out = arr.slice(0, MAX).map((n) => n / total);
    out.push(arr.slice(MAX).reduce((s, n) => s + n, 0) / total);
    return out;
  };
  const mine = share(dist, games);
  const mlb = last.ctx ? share(last.ctx.refDist, REF_GAMES) : share(data.sims.mlb.runDist, 1);
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
  el("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 }, "runs in the game");
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
const TRADEOFF_NOTE = "MLB lineup spots, each movable along the contact–power axis while keeping its own wOBA.";

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
  $("tilt_axis").textContent = "Each step is one standard deviation of 2026 hitters with the same wOBA. Per 100 PA, a step toward power is "
    + `K ${f(d.K)}, BB ${f(d.BB)}, HR ${f(d.HR)}, 1B ${f(d["1B"])}, 2B ${f(d["2B"])}, outs in play ${f(bip)}; toward contact, the reverse. `
    + `wOBA doesn't move. For scale, the most contact-heavy regulars sit at ${ends.slice(0, 3).join(", ")}; `
    + `the most power-heavy at ${ends.slice(-3).reverse().join(", ")}. The sliders stop at ±${T.range}, as far as regulars go toward the `
    + `${-T.ends[0][2] > T.ends[T.ends.length - 1][2] ? "power" : "contact"} end.`;
}

function renderTradeoff(moe) {
  const box = $("tradeoff_out");
  box.hidden = mode !== "tradeoff";
  if (box.hidden) return;
  const pts = last.ctx ? last.ctx.tradeoff : data.sims.tradeoff.points;
  const thetas = last.lineup.map((id) => entryOf(id)?.theta).filter((t) => t != null);
  const avg = thetas.length ? thetas.reduce((s, t) => s + t, 0) / thetas.length : null;
  const base = pts.find((p) => p.theta === 0), lo = pts[0], hi = pts[pts.length - 1];
  const dR = (p) => `${p.R >= base.R ? "+" : "−"}${Math.abs(p.R - base.R).toFixed(2)}`;
  $("tradeoff_note").textContent = (last.ctx
    // log5 scales each outcome by the pitcher's rate, so the axis no longer holds wOBA still
    ? `Against ${vsWords(last)}, with every spot moved together, the contact end (${fmtTheta(lo.theta)}) scores ${dR(lo)} runs per nine innings `
      + `against the MLB spots as they are and the power end (${fmtTheta(hi.theta)}) ${dR(hi)}. Against a given pitcher, wOBA moves with the mix: `
      + `${fmtRate(lo.wOBA)} at the contact end, ${fmtRate(base.wOBA)} at 0, ${fmtRate(hi.wOBA)} at the power end. The curve is exact, not simulated.`
    : `With every spot moved together, the contact end (${fmtTheta(lo.theta)}) scores ${dR(lo)} runs per nine innings `
      + `against the MLB lineup and the power end (${fmtTheta(hi.theta)}) ${dR(hi)}, with wOBA at ${fmtRate(lo.wOBA)} to ${fmtRate(hi.wOBA)} throughout. `
      + `Each point is ${data.sims.tradeoff.games.toLocaleString()} games on the same random seed, which keeps the curve smooth.`)
    + (avg == null ? "" : thetas.length < 9 ? " This lineup is plotted at the average setting of its MLB spots."
      : " This lineup is plotted at its spots' average setting.");
  tradeoffChart(pts, avg, last.sum.R, moe);

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

// exact expected runs per nine innings, against `vs` (by default the pitching now picked)
function exactRuns(ids, vs = vsOf()) {
  chain ??= chainTables(model);
  return lineupRuns(chain, ids.map((id) => matchup(chain, specOf(entryOf(id)), vs)), vs?.hook ?? 27);
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
  $("opt_tilt").disabled = !canTilt;
  $("opt_tilt_label").classList.toggle("off", !canTilt);
  $("opt_mix").disabled = !canTilt || !$("opt_tilt").checked;
  const thetas = lineup.map((id) => entryOf(id).theta).filter((t) => t != null);
  const avg = thetas.length ? thetas.reduce((x, t) => x + t, 0) / thetas.length : 0;
  $("opt_mix").options[0].textContent = `Keep the lineup's average setting (${fmtTheta(avg)})`;
  $("opt_go").disabled = optJob != null;
  $("opt_hint").textContent = canTilt ? ""
    : "Contact–power settings apply to MLB spots: pick “MLB spots: contact vs power” under Lineup, or put an MLB spot in the lineup.";
  if (last && last.lineup.join() === lineup.join() && last.key === vsKey()) {
    const r = exactRuns(lineup);
    $("opt_now").textContent = `This lineup${pitcher ? ` against ${vsWords({ name: pitcher.name, hook: hookOf() })}` : ""}: `
      + `${r.toFixed(3)} expected runs per nine innings, exact. The simulation's ${last.sum.R.toFixed(2)} is the same quantity with sampling noise.`;
  }
  const shown = optDone && optDone.after.join() === lineup.join() && optDone.key === vsKey();
  $("opt_out").hidden = !shown;
  $("opt_undo").hidden = !shown;
  if (shown) renderOptResult();
}

function startOptimize() {
  const canTilt = lineup.some((id) => entryOf(id).theta != null);
  const opts = { order: $("opt_order").checked, tilt: canTilt && $("opt_tilt").checked, mix: $("opt_mix").value,
    locked: [...locked], perSd: data.tradeoff.per_sd, range: data.tradeoff.range, vs: vsOf() };
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
  optJob = { id: ++optJobs, ids, opts, key: vsKey(), name: pitcher?.name, hook: hookOf() };
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
      optWorker = new Worker(new URL("./sim-worker.js?v=4", import.meta.url), { type: "module" });
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
  $("opt_status").textContent = `Searched ${result.evals.toLocaleString()} lineups in ${(ms / 1000).toFixed(2)} s.`;
  optDone = { before: j.ids, after, result, opts: j.opts, key: j.key, name: j.name, hook: j.hook };
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
  const vsText = optDone.name ? ` against ${vsWords(optDone)}` : "";
  const parts = [before.join() === after.join()
    ? `The lineup was already as good as the search could find${vsText}: ${result.after.toFixed(3)} expected runs per nine innings.`
    : `Expected runs per nine innings${vsText}: ${result.before.toFixed(3)} → ${result.after.toFixed(3)} (+${gain.toFixed(gain < 0.001 ? 4 : 3)}), `
      // a game against him, not a season
      + (optDone.name ? (gain < 0.01 ? "under a hundredth of a run a game against him." : `about ${gain.toFixed(2)} more runs a game against him.`)
        : season < 0.5 ? "under a run over 162 games." : `about ${season.toFixed(1)} more runs over 162 games.`)];
  const baseOf = (id) => id.split("@")[0];
  const wasSlot = (s) => before.findIndex((id) => baseOf(id) === baseOf(after[s]));
  const reordered = after.map((_, s) => [s, wasSlot(s)]).filter(([s, b]) => b !== s);
  if (reordered.length) {
    parts.push("Order: " + reordered.map(([s, b]) => `${shortName(entryOf(after[s]))} from ${ordinal(b + 1)} to ${ordinal(s + 1)}`).join("; ") + ".");
  }
  // settings that moved, by where they ended up (the chart below has the values)
  const changed = after.map((id, s) => [s, entryOf(id).theta, entryOf(before[wasSlot(s)])?.theta])
    .filter(([, t, was]) => t != null && t !== was);
  if (changed.length) {
    const spots = (list) => list.map(([s]) => ordinal(s + 1)).join(", ");
    const power = changed.filter(([, t]) => t > 0), contact = changed.filter(([, t]) => t < 0), even = changed.filter(([, t]) => t === 0);
    const where = [power.length && `power at ${spots(power)}`, contact.length && `contact at ${spots(contact)}`,
      even.length && `0 at ${spots(even)}`].filter(Boolean).join("; ");
    parts.push(`Settings: ${changed.length} spot${changed.length === 1 ? "" : "s"} moved, now ${where}.`);
  }
  $("opt_summary").textContent = parts.join(" ");
  const tilted = after.some((id) => entryOf(id).theta != null);
  $("opt_chart_box").hidden = !tilted;
  if (tilted) settingsChart(before, after, wasSlot);
}

// the optimized setting of each slot's hitter (bar) against where that hitter was (tick)
function settingsChart(before, after, wasSlot) {
  const range = data.tradeoff.range;
  const W = chartWidth("opt_chart"), rowH = 26, L = Math.min(150, Math.round(W * 0.36)), Rt = 50, T = 6, B = 40;
  const H = T + 9 * rowH + B, room = Math.floor((L - 22) / 6.6); // characters that fit beside the bars
  const x = (t) => L + ((t + range) / (2 * range)) * (W - L - Rt);
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
  el("text", { x: L, y: H - 6, fill: "var(--muted)", "font-size": 11 }, "← Contact");
  el("text", { x: W - Rt, y: H - 6, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 }, "Power →");
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
    const t = e.theta, x0 = x(0), x1 = x(t), h = 12, r = Math.min(4, Math.abs(x1 - x0) / 2);
    if (Math.abs(x1 - x0) > 0.5) {
      const [a, b] = t > 0 ? [x0, x1] : [x1, x0];
      // rounded at the data end only, square at zero
      const d = t > 0
        ? `M${a},${y - h / 2} H${b - r} Q${b},${y - h / 2} ${b},${y - h / 2 + r} V${y + h / 2 - r} Q${b},${y + h / 2} ${b - r},${y + h / 2} H${a} Z`
        : `M${b},${y - h / 2} H${a + r} Q${a},${y - h / 2} ${a},${y - h / 2 + r} V${y + h / 2 - r} Q${a},${y + h / 2} ${a + r},${y + h / 2} H${b} Z`;
      el("path", { d, fill: "var(--s-lineup)" });
    }
    if (prev?.theta != null) el("rect", { x: x(prev.theta) - 1, y: y - 9, width: 2, height: 18, rx: 1, fill: "var(--muted)" });
    el("text", { x: W - Rt + 8, y: y + 4, fill: "var(--ink)", "font-size": 12, "font-family": "JetBrains Mono, monospace" }, fmtTheta(t));
    const hit = el("rect", { x: 0, y: y - rowH / 2, width: W, height: rowH, fill: "transparent" });
    hover(hit, (ev) => {
      const l = lineOf(e.counts);
      showTip(ev, [["var(--s-lineup)", fmtTheta(t), "optimized"], ["var(--muted)", fmtTheta(prev?.theta ?? 0), "before"],
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

// ---------- URL state ----------
function writeHash() {
  const p = new URLSearchParams({ l: lineup.join(","), g: $("games").value, r: $("regress").value, b: basis,
    t: $("team").value, k: mode, e: edited ? "1" : "0", a: $("tilt_all").value });
  if (pitcher) {
    p.set("p", pitcher.mlbam);
    if ($("p_hook").value === "start") p.set("h", "start");
    if ($("platoon").value !== "own") p.set("pl", $("platoon").value);
  }
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
  if (pitcher && p.get("h") === "start") $("p_hook").value = "start";
  const pl = p.get("pl");
  if (pl && [...$("platoon").options].some((o) => o.value === pl)) $("platoon").value = pl;
  const a = Number(p.get("a"));
  if (Number.isFinite(a)) setMaster(Math.max(-R, Math.min(R, a)));
  if (ids.length === 9 && ids.every((id) => entryOf(id))) {
    return { ids, edited: p.get("e") === "1" };
  }
  return null;
}

// ---------- boot ----------
async function boot() {
  try {
    const r = await fetch(`data/${SEASON}.json?v=4`);
    if (!r.ok) throw new Error(`data ${r.status}`);
    data = await r.json();
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
  $("platoon_gap").textContent = `a ${fmtRate(wobaOf(lc.LL))} wOBA for left-handed batters against left-handers (${fmtRate(wobaOf(lc.RL))} against `
    + `right-handers) and ${fmtRate(wobaOf(lc.RR))} for right-handed batters against right-handers (${fmtRate(wobaOf(lc.LR))} against left-handers)`;
  const saved = readHash(); // before wiring controls: it sets their values, `basis` and `pitcher`
  renderPitcher();
  paintBasis();
  document.querySelectorAll(".basis button").forEach((b) => {
    b.addEventListener("click", () => {
      basis = b.dataset.basis;
      paintBasis();
      writeHash();
      if (last) renderResults();
    });
  });
  wireSuggest($("p_in"), $("p_sug"), { find: findPitchers, choose: setPitcher, current: () => pitcher?.name ?? "" });
  $("p_clear").addEventListener("click", () => {
    setPitcher(null);
    $("p_in").focus();
  });
  $("p_hook").addEventListener("change", () => {
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

  if (saved) {
    $("kind").querySelector("[value=most_used]").disabled = $("team").value === "MLB";
    lineup = saved.ids;
    edited = saved.edited;
    mode = $("kind").value;
    if (!edited && mode !== "tradeoff") { loadPreset(); return; }
    loadedNote = mode === "tradeoff" ? TRADEOFF_NOTE : "";
    renderLineup();
    run();
  } else {
    loadPreset();
  }
}

boot();
