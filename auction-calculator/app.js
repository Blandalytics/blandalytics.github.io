// The MLB Auction Calculator page: settings in the sidebar, the priced player table
// beside it. The model is calc.js; the default projections are two CSVs in the bucket.

import * as C from "./calc.js?v=7";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The projections live in the bucket; ?data=<base> reads them from somewhere else
const params = new URLSearchParams(location.search);
const DATA = new URL(params.get("data") || "https://data.blandalytics.com/projections/", location.href).href;
const FILES = { h: "hitters_auction_ev.csv", p: "pitchers_auction_ev.csv" };
const STORE = "auction-calculator:v1";
const VIEW_STORE = "auction-calculator:view";
const SLOT_IDS = Object.keys(C.SLOT_TYPES).map((t) => "slot_" + t);
const PSLOT_IDS = Object.keys(C.PITCHER_SLOT_TYPES).map((t) => "pslot_" + t);
const NUM_INPUTS = ["hitters", "pitchers", "catchers", "bench", "teams", "min_bid", "budget", "split", "span", ...SLOT_IDS, ...PSLOT_IDS];
const SCRIPT_ONLY = new Set(["hitters", "pitchers", "catchers"]);
const SLOTS_ONLY = (id) => id.includes("slot_") || id === "span";
const bySlots = () => $("pos_mode").value === "slots";
// The inputs the position adjustment in use reads
const activeInputs = () => NUM_INPUTS.filter((id) => (bySlots() ? !SCRIPT_ONLY.has(id) : !SLOTS_ONLY(id)));
const slotsOf = (types, prefix) => Object.fromEntries(Object.keys(types).map((t) => [t, Number($(prefix + t).value)]));
const total = (slots) => Object.values(slots).reduce((a, b) => a + b, 0);

const defaults = { h: null, p: null };   // the bucket's projections, parsed
const uploads = { h: null, p: null };    // { name, table } from the file inputs
let loadError = null;
let cats = { h: [...C.DEFAULT_HITTER_CATS], p: [...C.DEFAULT_PITCHER_CATS] };
let points = { h: C.DEFAULT_HITTER_POINTS.map((r) => r.slice()), p: C.DEFAULT_PITCHER_POINTS.map((r) => r.slice()) };
let options = { h: [], p: [] };          // the categories the current projections can score
let result = null;
let sort = { key: "value", dir: -1 };

const style = () => document.querySelector('input[name="style"]:checked').value;

// ---- formatting ----------------------------------------------------------------

const THREE = new Set(["AVG", "OBP", "ISO", "SLG", "OPS", "wOBA", "BB%", "K%", "K-BB%"]);
const TWO = new Set(["ERA", "WHIP", "K/9", "BB/9", "HR/9", "K/BB"]);
const WHOLE = new Set(["PA", "AB", "TBF", "G", "GS"]);
function fmt(cat, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  if (THREE.has(cat)) return v.toFixed(Math.abs(v) >= 2 ? 1 : 3);   // 13.6 when a file wrote '13.6%'
  if (TWO.has(cat)) return v.toFixed(2);
  return v.toFixed(WHOLE.has(cat) ? 0 : 1);
}
const money = (v) => Number.isNaN(v) ? "" : (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2);
const rank = (r) => Number.isNaN(r) ? "" : Number.isInteger(r) ? String(r) : r.toFixed(1);
const int = (v) => v.toLocaleString("en-US");

function status(msg, kind = "") {
  $("status").textContent = msg;
  $("status").className = "status " + kind;
  $("status").hidden = !msg;
}

// ---- projections -----------------------------------------------------------------

async function loadDefaults() {
  try {
    const [h, p] = await Promise.all(["h", "p"].map(async (k) => {
      const r = await fetch(DATA + FILES[k], { cache: "default" });
      if (!r.ok) throw new Error(`${FILES[k]}: HTTP ${r.status}`);
      return C.readProjections(await r.text());
    }));
    defaults.h = h; defaults.p = p;
  } catch (e) {
    loadError = e.message || String(e);
  }
  renderSources();
  update();
}

// Excel on Windows saves CSVs as cp1252, not UTF-8
async function readFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

for (const k of ["h", "p"]) {
  $("up_" + k).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      uploads[k] = { name: file.name, table: C.readProjections(await readFile(file)) };
    } catch (err) {
      uploads[k] = null;
      e.target.value = "";
      status(`Could not read ${file.name}: ${err.message}`, "err");
      renderSources();
      return;
    }
    renderSources();
    update();
  });
}

function renderSources() {
  for (const k of ["h", "p"]) {
    const el = $("src_" + k);
    const up = uploads[k];
    if (up) {
      el.innerHTML = `<b>${esc(up.name)}</b> · ${int(up.table.n)} players · <button type="button" class="link" data-default="${k}">use the default</button>`;
    } else if (defaults[k]) {
      el.innerHTML = `Default: <a href="${esc(DATA + FILES[k])}">${FILES[k]}</a> · ${int(defaults[k].n)} players`;
    } else {
      el.textContent = loadError ? "The default projections didn't load." : "Loading the default…";
    }
  }
  document.querySelectorAll("[data-default]").forEach((b) => b.onclick = () => {
    const k = b.dataset.default;
    uploads[k] = null;
    $("up_" + k).value = "";
    renderSources();
    update();
  });
}

const raw = (k) => (uploads[k] ? uploads[k].table : defaults[k]);

// ---- scoring controls ------------------------------------------------------------

function renderChips(k) {
  $("cats_" + k).innerHTML = options[k].map((c) =>
    `<button type="button" data-cat="${esc(c)}" aria-pressed="${cats[k].includes(c)}">${esc(c)}</button>`).join("");
}
for (const k of ["h", "p"]) {
  $("cats_" + k).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat]");
    if (!b) return;
    const c = b.dataset.cat;
    const on = !cats[k].includes(c);
    cats[k] = on ? [...cats[k], c] : cats[k].filter((x) => x !== c);
    cats[k].sort((a, b2) => options[k].indexOf(a) - options[k].indexOf(b2));
    b.setAttribute("aria-pressed", String(on));
    changed();
  });
}

function renderPoints(k) {
  $("pts_" + k).innerHTML = points[k].map(([cat, pts], i) => `<tr>
    <td><select data-i="${i}" aria-label="Category">${options[k].map((c) => `<option${c === cat ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></td>
    <td><input type="number" data-i="${i}" step="0.05" min="-1000" max="1000" value="${pts}" aria-label="Points for ${esc(cat)}" required></td>
    <td><button type="button" data-i="${i}" title="Remove" aria-label="Remove ${esc(cat)}">×</button></td></tr>`).join("");
}
for (const k of ["h", "p"]) {
  const body = $("pts_" + k);
  body.addEventListener("change", (e) => {
    if (e.target.tagName !== "SELECT") return;
    points[k][+e.target.dataset.i][0] = e.target.value;
    changed();
  });
  body.addEventListener("input", (e) => {
    if (e.target.tagName !== "INPUT") return;
    points[k][+e.target.dataset.i][1] = e.target.value === "" ? NaN : Number(e.target.value);
    changed();
  });
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    points[k].splice(+b.dataset.i, 1);
    renderPoints(k);
    changed();
  });
}
document.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
  const k = b.dataset.add;
  const used = new Set(points[k].map(([c]) => c));
  const cat = options[k].find((c) => !used.has(c)) || options[k][0];
  if (!cat) return;
  points[k].push([cat, 0]);
  renderPoints(k);
  changed();
});

// Offer what the projections can score; keep the picks they still can
function syncOptions(H, P) {
  const isCats = style() === "Categories";
  const next = isCats
    ? { h: C.availableStats(C.HITTER_CATS, H), p: C.availableStats(C.PITCHER_CATS, P) }
    : { h: C.availableStats(C.HITTER_POINT_CATS, H), p: C.availableStats(C.PITCHER_POINT_CATS, P) };
  for (const k of ["h", "p"]) {
    const same = next[k].join() === options[k].join();
    options[k] = next[k];
    if (isCats) {
      const kept = cats[k].filter((c) => options[k].includes(c));
      const dflt = (k === "h" ? C.DEFAULT_HITTER_CATS : C.DEFAULT_PITCHER_CATS).filter((c) => options[k].includes(c));
      if (kept.length !== cats[k].length) cats[k] = kept.length ? kept : dflt;
      if (!same || $("cats_" + k).childElementCount !== options[k].length) renderChips(k);
    } else {
      const kept = points[k].filter(([c]) => options[k].includes(c));
      if (kept.length !== points[k].length || !same || !$("pts_" + k).childElementCount) {
        points[k] = kept;
        renderPoints(k);
      }
    }
  }
}

// Streamlit resets the split to its default when the league type changes
document.querySelectorAll('input[name="style"]').forEach((r) => r.addEventListener("change", () => {
  $("split").value = style() === "Categories" ? 65 : 50;
  $("cats_ui").hidden = style() !== "Categories";
  $("points_ui").hidden = style() === "Categories";
  options = { h: [], p: [] };   // re-render the controls for the other style
  changed();
}));

// ---- settings ----------------------------------------------------------------------

function readSettings() {
  const bad = activeInputs().filter((id) => !$(id).checkValidity() || $(id).value === "");
  if (bad.length) {
    const names = bad.map((id) => (id.includes("slot_") ? "the " : "") + $(id).closest("label").querySelector("b").textContent + (id.includes("slot_") ? " slots" : ""));
    return { error: `Check ${names.join(", ")}: ${bad.map((id) => $(id).validationMessage).filter(Boolean)[0] || "a number is needed"}` };
  }
  const n = (id) => Number($(id).value);
  const slots = slotsOf(C.SLOT_TYPES, "slot_"), pitcherSlots = slotsOf(C.PITCHER_SLOT_TYPES, "pslot_");
  if (bySlots() && (total(slots) < 4 || total(slots) > 30)) return { error: `A lineup needs 4 to 30 hitter slots; this one has ${total(slots)}.` };
  if (bySlots() && (total(pitcherSlots) < 4 || total(pitcherSlots) > 20)) return { error: `A staff needs 4 to 20 pitcher slots; this one has ${total(pitcherSlots)}.` };
  const s = {
    positions: $("pos_mode").value, slots, pitcherSlots,
    hitters: bySlots() ? total(slots) : n("hitters"), pitchers: bySlots() ? total(pitcherSlots) : n("pitchers"),
    catchers: bySlots() ? slots.C : n("catchers"), bench: n("bench"), span: bySlots() ? n("span") : 0,
    minimizeBench: $("min_bench").checked, style: style(), teams: n("teams"), minBid: n("min_bid"),
    budget: n("budget"), hitterSplit: n("split") / 100, pool: $("pool").value, includeFa: $("include_fa").checked,
    hitterCats: cats.h, pitcherCats: cats.p, hitterPoints: points.h, pitcherPoints: points.p,
  };
  const minBudget = (s.minBid + 1) * (s.hitters + s.pitchers + (s.minimizeBench ? 0 : s.bench));
  if (s.budget < minBudget) return { error: `Team budget must be at least $${minBudget}: one dollar over the min bid for every roster spot.` };
  return s;
}

function save() {
  const form = { style: style(), pos_mode: $("pos_mode").value, pool: $("pool").value, min_bench: $("min_bench").checked, include_fa: $("include_fa").checked, cats, points };
  for (const id of NUM_INPUTS) form[id] = $(id).value;
  try { localStorage.setItem(STORE, JSON.stringify(form)); } catch { /* private mode */ }
}

function restore() {
  let form;
  try { form = JSON.parse(localStorage.getItem(STORE)); } catch { return; }
  if (!form) return;
  for (const id of NUM_INPUTS) if (form[id] !== undefined) $(id).value = form[id];
  if (form.pool) $("pool").value = form.pool;
  if (form.pos_mode === "slots" || form.pos_mode === "catchers") $("pos_mode").value = form.pos_mode;
  if (typeof form.min_bench === "boolean") $("min_bench").checked = form.min_bench;
  if (typeof form.include_fa === "boolean") $("include_fa").checked = form.include_fa;
  const r = document.querySelector(`input[name="style"][value="${form.style}"]`);
  if (r) r.checked = true;
  $("cats_ui").hidden = style() !== "Categories";
  $("points_ui").hidden = style() === "Categories";
  if (form.cats?.h && form.cats?.p) cats = form.cats;
  if (Array.isArray(form.points?.h) && Array.isArray(form.points?.p)) points = form.points;
}

// ---- position adjustment ---------------------------------------------------------------

function showPositionMode() {
  for (const id of ["slots_ui", "pslots_ui", "span_field"]) $(id).hidden = !bySlots();
  for (const id of ["hitters_field", "pitchers_field", "catchers_field"]) $(id).hidden = bySlots();
  $("pos_mode_hint").textContent = bySlots()
    ? "Each position's replacement level comes from the league's best lineups"
    : "The script's replacement: catchers against catchers, every other hitter in one pool, every pitcher in another";
  const count = (ids) => ids.reduce((a, id) => a + (Number($(id).value) || 0), 0);
  $("slot_total").textContent = `${count(SLOT_IDS)} per team`;
  $("pslot_total").textContent = `${count(PSLOT_IDS)} per team`;
}
$("pos_mode").addEventListener("change", showPositionMode);
$("slots_ui").addEventListener("input", showPositionMode);
$("pslots_ui").addEventListener("input", showPositionMode);

// ---- league formats ------------------------------------------------------------------------

// Each site's default league: teams, hitter slots and pitcher slots.
// Yahoo and ESPN are from their own help pages; CBS and Fantrax from third-party write-ups.
const PRESETS = {
  yahoo: { teams: 12, slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 2 }, pslots: { SP: 2, RP: 2, P: 4 } },
  espn: { teams: 10, slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, pslots: { P: 9 } },
  cbs: { teams: 12, slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 1 }, pslots: { SP: 5, RP: 2 } },
  fantrax: { teams: 12, slots: { C: 2, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, pslots: { P: 9 } },
  nfbc: { teams: 15, slots: { C: 2, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, pslots: { P: 9 } },
};
// Every slot input and the value a format gives it
const presetInputs = (preset) => [
  ...Object.keys(C.SLOT_TYPES).map((t) => ["slot_" + t, preset.slots[t] ?? 0]),
  ...Object.keys(C.PITCHER_SLOT_TYPES).map((t) => ["pslot_" + t, preset.pslots[t] ?? 0]),
];

$("preset").addEventListener("change", () => {
  const preset = PRESETS[$("preset").value];
  if (!preset) return;   // Custom: keep what's there
  $("teams").value = preset.teams;
  for (const [id, v] of presetInputs(preset)) $(id).value = v;
  $("pos_mode").value = "slots";
  showPositionMode();
  changed();
});

// The select follows the settings: a format whose teams and slots they match, or Custom
function showPreset() {
  const n = (id) => Number($(id).value);
  const match = bySlots() && Object.keys(PRESETS).find((k) => {
    const p = PRESETS[k];
    return n("teams") === p.teams && presetInputs(p).every(([id, v]) => n(id) === v);
  });
  $("preset").value = match || "custom";
}

$("reset").onclick = () => {
  try { localStorage.removeItem(STORE); } catch { /* private mode */ }
  location.reload();
};

let timer = 0;
function changed() {
  clearTimeout(timer);
  timer = setTimeout(() => { save(); update(); }, 120);
}
// The points table, the file inputs, the league type and the format have their own handlers
$("settings").addEventListener("input", (e) => {
  if (e.target.id !== "preset") showPreset();
  if (!e.target.closest(".points") && e.target.type !== "file" && e.target.name !== "style" && e.target.id !== "preset") changed();
});

// ---- pricing ---------------------------------------------------------------------------

function fail(msg) {
  result = null;
  status(msg, "err");
  $("tbl").hidden = true;
  $("summary").hidden = true;
  $("scarcity").hidden = true;
  $("download").disabled = true;
}

function update() {
  if (!raw("h") || !raw("p")) {
    if (loadError) fail(`Couldn't load the default projections (${loadError}). Upload hitter and pitcher CSVs to price your own.`);
    return;
  }
  const missing = C.missingColumns(raw("h"), raw("p"));
  if (missing.length) return fail(`The projections are missing required columns: ${missing.join(", ")}`);
  const H = C.prepHitters(raw("h"), $("pool").value, $("include_fa").checked);
  const P = C.prepPitchers(raw("p"), $("pool").value, $("include_fa").checked);
  syncOptions(H, P);   // first, so the scoring controls are there even while a setting is invalid

  const s = readSettings();
  if (s.error) return fail(s.error);

  if (s.style === "Categories" && (!cats.h.length || !cats.p.length)) return fail("Pick at least one hitter and one pitcher category.");
  if (s.style === "Points") {
    if (!points.h.length || !points.p.length) return fail("Score at least one hitter and one pitcher category.");
    if ([...points.h, ...points.p].some(([, v]) => !Number.isFinite(v))) return fail("Every scored category needs a point value.");
  }

  result = C.auctionValues(H, P, s);
  result.settings = s;
  const noTeams = (t) => t.data.Team.every((x) => x === null);
  status(s.pool !== "All" && (noTeams(raw("h")) || noTeams(raw("p")))
    ? "Projections without a Team column can't be filtered to AL/NL-Only; that side is priced over every player." : "",
  "warn");
  $("download").disabled = false;
  render();
}

// ---- the table ---------------------------------------------------------------------------

const INFO = [
  { key: "rank", label: "Rank", get: (p) => p.rank, cell: (p) => rank(p.rank), cls: "muted" },
  { key: "name", label: "Name", get: (p) => p.name, cell: (p) => esc(p.name), cls: "l name", text: true },
  { key: "team", label: "Team", get: (p) => p.team, cell: (p) => esc(p.team), cls: "l muted", text: true },
  { key: "pos", label: "Pos", get: (p) => p.pos, cell: (p) => esc(p.pos), cls: "l muted", text: true },
];
// The slot a hitter fills in the league's best lineups (blank: not a starter)
const SLOT_COL = { key: "slot", label: "Slot", get: (p) => p.slot ?? "", cell: (p) => esc(p.slot ?? ""), cls: "l muted", text: true };
const POINTS_COL = { key: "points", label: "Points", get: (p) => p.points, cell: (p) => fmt("", p.points) };
const VALUE_COL = { key: "value", label: "Auction $", get: (p) => p.value, cell: (p) => money(p.value), cls: (p) => "val" + (p.value < result.settings.minBid ? " neg" : "") };

// ---- the value breakdown -------------------------------------------------------------------

const view = () => document.querySelector('input[name="view"]:checked').value;
const signed = (v) => (Number.isNaN(v) ? "" : Math.abs(v) < 0.005 ? "$0.00" : (v > 0 ? "+" : "") + money(v));
const signCls = (v) => (Number.isNaN(v) ? "" : Math.abs(v) < 0.005 ? "nil" : v > 0 ? "up" : "down");
const part = (key, label, title, get, extra = {}) => ({ key, label, title, get, cell: (p) => signed(get(p)), cls: (p) => signCls(get(p)), ...extra });

// Min bid + baseline + position + each stat (+ the no-roster-spot hold-down) = the player's dollars
function breakdownColumns() {
  const b = (p) => p.breakdown;
  const base = [
    part("b:min", "Min bid", "Every drafted player's floor", (p) => (b(p) ? b(p).minBid : NaN)),
    part("b:base", "Baseline", result.settings.style === "Points"
      ? "Less the points of his side's replacement level, at its dollars per point"
      : "What a player with average stats at his side's deepest position is worth over the min bid", (p) => (b(p) ? b(p).replacement : NaN)),
    part("b:pos", "Position", "His position's premium over his side's deepest position", (p) => (b(p) ? b(p).position : NaN)),
  ];
  if (result.players.some((p) => b(p) && b(p).other)) {
    base.push(part("b:other", "No spot", "Held under the min bid: no legal roster has room for him", (p) => (b(p) ? b(p).other : NaN)));
  }
  base.forEach((c, i) => Object.assign(c, { group: "v", first: i === 0 }));
  const stat = (type, cat, i) => part(`$${type}:${cat}`, cat,
    `What his ${cat} adds to his dollars${result.settings.style === "Points" ? " (points × his dollars per point)" : ", against the average"}`,
    (p) => (p.type === type && b(p) ? b(p).stats[cat] : NaN), { group: type + "$", first: i === 0 });
  return [...base, ...result.valueCols.h.map((c, i) => stat("h", c, i)), ...result.valueCols.p.map((c, i) => stat("p", c, i))];
}
const GROUPS = { h: "Hitting", p: "Pitching", v: "Value", h$: "Hitting $", p$: "Pitching $" };

function columns() {
  // The dollars sit by the name, so they're on screen on a phone too
  const info = [INFO[0], INFO[1], VALUE_COL, INFO[2], INFO[3], ...(result.positions ? [SLOT_COL] : []),
    ...(result.settings.style === "Points" ? [POINTS_COL] : [])];
  const stat = (type, cat, first) => ({
    key: `${type}:${cat}`, label: cat, group: type, first,
    get: (p) => (p.type === type ? p.stats[cat] : NaN), cell: (p) => (p.type === type ? fmt(cat, p.stats[cat]) : ""),
  });
  if (view() === "value" && result.valueCols) return [...info, ...breakdownColumns()];
  return [
    ...info,
    ...result.hitterCols.map((c, i) => stat("h", c, i === 0)),
    ...result.pitcherCols.map((c, i) => stat("p", c, i === 0)),
  ];
}

const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function matchesPos(p, pos) {
  if (!pos) return true;
  if (pos === "h" || pos === "p") return p.type === pos;
  const parts = p.pos.split(/[,/ ]+/);
  if (pos === "OF") return parts.some((x) => ["OF", "LF", "CF", "RF"].includes(x));
  return parts.includes(pos);
}

function render() {
  const cols = columns();
  const col = cols.find((c) => c.key === sort.key) || (sort = { key: "value", dir: -1 }, VALUE_COL);
  const q = fold($("search").value.trim());
  const pos = $("pos").value;
  const rows = result.players.filter((p) => matchesPos(p, pos) && (!q || fold(p.name).includes(q) || fold(p.team) === q));
  rows.sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    if (col.text) return sort.dir * String(x).localeCompare(String(y));
    const xn = Number.isNaN(x), yn = Number.isNaN(y);
    if (xn || yn) return xn - yn;   // blanks last either way
    return sort.dir * (x - y) || a.rank - b.rank;
  });

  const s = result.settings;
  const drafted = result.players.filter((p) => p.drafted);
  const spent = drafted.reduce((a, p) => a + p.value, 0);
  const spots = s.hitters + s.pitchers + (s.minimizeBench ? 0 : s.bench);
  $("summary").innerHTML = `<b>${int(result.players.length)}</b> players priced · <b>${int(drafted.length)}</b> drafted at $${s.minBid}+ `
    + `(${s.teams} teams × ${spots} ${s.minimizeBench ? "lineup" : "roster"} spots) for <b>$${int(Math.round(spent))}</b> (${s.teams} × $${int(s.budget)})`
    + `${rows.length !== result.players.length ? ` · showing <b>${int(rows.length)}</b>` : ""}`;
  $("summary").hidden = false;
  renderScarcity();

  // The group row: a cell spanning each run of columns in one group
  const runs = [];
  for (const c of cols) {
    const last = runs[runs.length - 1];
    if (last && last.group === c.group) last.n++;
    else runs.push({ group: c.group, n: 1 });
  }
  const head = `<thead><tr>${runs.map((r) => (r.group ? `<th colspan="${r.n}" class="gp">${GROUPS[r.group]}</th>` : `<th colspan="${r.n}"></th>`)).join("")}</tr><tr>`
    + cols.map((c) => {
      const cls = [c.text ? "l" : "", c.key === "name" ? "name" : "", c.first ? "gp" : ""].filter(Boolean).join(" ");
      const aria = c.key === sort.key ? ` aria-sort="${sort.dir < 0 ? "descending" : "ascending"}"` : "";
      return `<th data-key="${esc(c.key)}"${cls ? ` class="${cls}"` : ""}${aria}${c.title ? ` title="${esc(c.title)}"` : ""} scope="col">${esc(c.label)}</th>`;
    }).join("") + `</tr></thead>`;
  const body = rows.length
    ? rows.map((p) => `<tr class="${p.type}">` + cols.map((c) => {
      const cls = [typeof c.cls === "function" ? c.cls(p) : c.cls, c.first ? "gp" : ""].filter(Boolean).join(" ");
      const title = c.key === "name" ? p.name : c.key === "pos" && p.valuedAt ? `Priced at ${p.valuedAt}`
        : c.key === "value" && !p.drafted ? "Not on a drafted roster" : "";
      return `<td${cls ? ` class="${cls}"` : ""}${title ? ` title="${esc(title)}"` : ""}>${c.cell(p)}</td>`;
    }).join("") + `</tr>`).join("")
    : `<tr><td class="empty l" colspan="${cols.length}">No players match.</td></tr>`;
  $("table").innerHTML = head + `<tbody>${body}</tbody>`;
  $("tbl").hidden = false;
}

// Each position's premium over its side's deepest one, scarcest first, as the data has it
function renderScarcity() {
  const el = $("scarcity");
  if (!result.positions) { el.hidden = true; return; }
  const chips = (side) => result.positions.filter((p) => p.side === side).map((p) =>
    `<span class="prem${p.premium >= 0.005 ? " up" : ""}" title="${p.slots} slots · replacement ${p.level.toFixed(2)} · last starter ${p.worst.toFixed(2)}"><b>${esc(p.slot)}</b>${p.premium >= 0.005 ? "+" + money(p.premium) : "$0"}</span>`).join("");
  el.innerHTML = `<span title="What a player is worth over the same player at his side's deepest position, from this league's best lineups">Position premium</span>`
    + `<span class="side">Hitters</span>${chips("h")}<span class="side">Pitchers</span>${chips("p")}`;
  el.hidden = false;
}

$("table").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-key]");
  if (!th || !result) return;
  const key = th.dataset.key;
  const col = columns().find((c) => c.key === key);
  if (sort.key === key) sort.dir = -sort.dir;
  else sort = { key, dir: col.text || key === "rank" ? 1 : -1 };
  render();
});
let searchTimer = 0;
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => result && render(), 100); });
$("pos").addEventListener("change", () => result && render());
document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener("change", () => {
  try { localStorage.setItem(VIEW_STORE, view()); } catch { /* private mode */ }
  if (result) render();
}));
try {
  const saved = localStorage.getItem(VIEW_STORE);
  const r = saved && document.querySelector(`input[name="view"][value="${saved}"]`);
  if (r) r.checked = true;
} catch { /* private mode */ }

// ---- download ------------------------------------------------------------------------------

// The script's CSV: every player by value, a stat both sides score suffixed _h / _p. In the value
// breakdown it carries the breakdown instead of the stats, each stat as "<stat> $"
$("download").onclick = () => {
  if (!result) return;
  const { players, settings } = result;
  const byValue = view() === "value" && result.valueCols;
  const hitterCols = byValue ? result.valueCols.h : result.hitterCols;
  const pitcherCols = byValue ? result.valueCols.p : result.pitcherCols;
  const both = new Set(hitterCols.filter((c) => pitcherCols.includes(c)));
  const slots = !!result.positions;
  const name = (c, side) => (byValue ? c + " $" : c) + (both.has(c) ? "_" + side : "");
  const extra = byValue ? breakdownColumns().filter((c) => c.group === "v") : [];
  const head = ["Rank", "Name", "Team", "Y! Pos", ...(slots ? ["Slot"] : []), ...(settings.style === "Points" ? ["Points"] : []), "Value",
    ...extra.map((c) => c.label), ...hitterCols.map((c) => name(c, "h")), ...pitcherCols.map((c) => name(c, "p"))];
  const num = (v, d) => (v === undefined || Number.isNaN(v) ? "" : d === undefined ? String(v) : v.toFixed(d));
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const sideValue = (p, side, c) => (p.type !== side ? "" : byValue ? num(p.breakdown ? p.breakdown.stats[c] : NaN, 2) : num(p.stats[c]));
  const lines = [head.map(cell).join(",")];
  for (const p of players) {
    lines.push([num(p.rank), p.name, p.team, p.pos, ...(slots ? [p.slot ?? ""] : []), ...(settings.style === "Points" ? [num(p.points, 2)] : []), num(p.value, 2),
      ...extra.map((c) => num(c.get(p), 2)),
      ...hitterCols.map((c) => sideValue(p, "h", c)),
      ...pitcherCols.map((c) => sideValue(p, "p", c))].map((v) => cell(String(v))).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = "auction_values.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

restore();
showPositionMode();
showPreset();
renderSources();
loadDefaults();
