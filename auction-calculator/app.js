// The MLB Auction Calculator page: settings in the sidebar, the priced player table
// beside it. The model is calc.js; the default projections are two CSVs in the bucket, and the
// positions come from a third, last season's games by position.

import * as C from "./calc.js?v=19";
import * as R from "./risk.js?v=2";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The projections live in the bucket; ?data=<base> reads them from somewhere else
const params = new URLSearchParams(location.search);
const DATA = new URL(params.get("data") || "https://data.blandalytics.com/projections/", location.href).href;
const FILES = { h: "hitters_auction_ev.csv", p: "pitchers_auction_ev.csv" };
const ELIG_FILE = "position_eligibility.csv";   // last season's games by position
// The risk files (each player's simulation draws, for the risk-aware $) sit beside the projections,
// one per side and basis; ?riskdata=<base> reads them from somewhere else (a local folder's server)
const RISK_DATA = new URL(params.get("riskdata") || DATA, location.href).href.replace(/\/?$/, "/");
const RISK_FILES = { h: FILES.h.replace("_auction", "_risk").replace(/\.csv$/, ".bin"), p: FILES.p.replace("_auction", "_risk").replace(/\.csv$/, ".bin") };
const RISK_BASIS = FILES.h.includes("_ev") ? "ev" : "healthy";
const STORE = "auction-calculator:v1";
const VIEW_STORE = "auction-calculator:view";
const IMPACT_STORE = "auction-calculator:impact";
// Pitcher List's staff rankings: the rank columns are in the projections, the lists (each one's
// date, article and credit weights) beside them
const PL_FILE = "pl_lists.json";
const PL_NAMES = { H: "Hitters", SP: "SP", "RP-SV": "SV", "RP-HD": "HD", "RP-SVHD": "SV+HD" };
const SLOT_IDS = Object.keys(C.SLOT_TYPES).map((t) => "slot_" + t);
const PSLOT_IDS = Object.keys(C.PITCHER_SLOT_TYPES).map((t) => "pslot_" + t);
const NUM_INPUTS = ["bench", "teams", "min_bid", "budget", "span", "curve", "weeks", "phi", "pt_cv", ...SLOT_IDS, ...PSLOT_IDS];
// The eligibility thresholds: hitter starts and games at a position, SP starts, RP relief games.
// A blank one skips that test
const ELIG_INPUTS = ["elig_gs", "elig_g", "elig_sp", "elig_rp"];
// The checkboxes and selects saved with the settings
const CHECKS = ["min_bench", "include_fa", "fill_pt", "specialists", "split_auto"];
const SELECTS = ["pool", "format", "lock", "twoway"];
const slotsOf = (types, prefix) => Object.fromEntries(Object.keys(types).map((t) => [t, Number($(prefix + t).value)]));
const total = (slots) => Object.values(slots).reduce((a, b) => a + b, 0);

const defaults = { h: null, p: null };   // the bucket's projections, parsed
const uploads = { h: null, p: null };    // { name, table } from the file inputs
let loadError = null;
let eligibility = null, eligError = null;   // the bucket's eligibility file, parsed
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
  // revalidated every load (a 304 when unchanged), so a new upload shows on the next one
  const get = async (file, what) => {
    const r = await fetch(DATA + file, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
    return C.readProjections(await r.text());
  };
  // without the eligibility file, positions are the projections' own
  const elig = get(ELIG_FILE, "eligibility").then((e) => { eligibility = e; }, (e) => { eligError = e.message || String(e); });
  try {
    [defaults.h, defaults.p] = await Promise.all([get(FILES.h, "hitters"), get(FILES.p, "pitchers")]);
  } catch (e) {
    loadError = e.message || String(e);
    $("proj").open = true;   // the uploads are the way on from here
  }
  await elig;
  showEligibility();
  renderSources();
  update();
}

// The risk files load only once the risk-aware $ is switched on
const risk = { state: "idle", files: null, error: null };
async function loadRisk() {
  if (risk.state !== "idle") return;
  risk.state = "loading";
  try {
    const [h, p] = await Promise.all(["h", "p"].map(async (k) => {
      const r = await fetch(RISK_DATA + RISK_FILES[k], { cache: "default" });
      if (!r.ok) throw new Error(`${RISK_FILES[k]}: HTTP ${r.status}`);
      const file = R.parseRiskFile(await r.arrayBuffer());
      if (file.side !== k || file.head.basis !== RISK_BASIS) throw new Error(`${RISK_FILES[k]} is for ${file.side}, basis ${file.head.basis}`);
      return file;
    }));
    risk.files = { h, p };
    risk.state = "ready";
  } catch (e) {
    risk.state = "error";
    risk.error = e.message || String(e);
  }
  update();
}

// The lists load only once the ranks are switched on
const pl = { state: "idle", lists: null, error: null };
async function loadPL() {
  if (pl.state !== "idle") return;
  pl.state = "loading";
  try {
    const r = await fetch(DATA + PL_FILE, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${PL_FILE}: HTTP ${r.status}`);
    pl.lists = await r.json();
    pl.state = "ready";
  } catch (e) {
    pl.state = "error";
    pl.error = e.message || String(e);
  }
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
      el.innerHTML = `Default projections · ${int(defaults[k].n)} players`;
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
    <td><button type="button" data-i="${i}" data-tip="Remove" aria-label="Remove ${esc(cat)}">×</button></td></tr>`).join("");
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

// The categories format (and its weeks, and the specialist correction) only apply to categories
function showFormat() {
  const cats = style() === "Categories";
  $("cats_ui").hidden = !cats;
  $("points_ui").hidden = cats;
  $("format_field").hidden = !cats;
  $("weeks_field").hidden = !cats || $("format").value === "roto";
  $("spec_field").hidden = !cats || $("format").value !== "roto";
}
document.querySelectorAll('input[name="style"]').forEach((r) => r.addEventListener("change", () => {
  showFormat();
  options = { h: [], p: [] };   // re-render the controls for the other style
  manualSplit = defaultSplit();  // as the script does: its split resets with the league type
  showSplit();
  changed();
}));
$("format").addEventListener("change", showFormat);

// ---- the hitter split --------------------------------------------------------------------

// The script's default: 65% to hitters in categories, 50% in points
const defaultSplit = () => (style() === "Categories" ? "65" : "50");
let manualSplit = "65";   // the typed split, kept while the box shows the values' own
const autoSplit = () => $("split_auto").checked;
// Typed, or the values' own split in the box (read-only) once they're priced
function showSplit() {
  $("split").readOnly = autoSplit();
  if (!autoSplit()) $("split").value = manualSplit;
  else $("split").value = result ? (100 * result.split.hitters).toFixed(1) : "";
}
$("split").addEventListener("input", () => { if (!autoSplit()) manualSplit = $("split").value; });
$("split_auto").addEventListener("change", showSplit);

// ---- position eligibility ----------------------------------------------------------------

const eligSeason = () => (eligibility && eligibility.data.Season ? eligibility.data.Season.find(Number.isFinite) ?? null : null);
// The thresholds as the inputs have them: a blank one skips its test (and an invalid one too,
// though readSettings stops the pricing over it)
function eligRules() {
  const v = (id) => ($(id).value === "" || !$(id).checkValidity() ? null : Number($(id).value));
  return { gs: v("elig_gs"), g: v("elig_g"), sp: v("elig_sp"), rp: v("elig_rp") };
}
const eligOf = () => (eligibility ? { table: eligibility, rules: eligRules() } : null);
// The legend says whose games the positions come from
function showEligibility() {
  $("elig_hint").textContent = eligibility ? `from ${eligSeason() ?? "last season's"} games` : eligError ? "the projections' positions" : "";
}

// ---- settings ----------------------------------------------------------------------

function readSettings() {
  const bad = [...NUM_INPUTS, ...(autoSplit() ? [] : ["split"])].filter((id) => !$(id).checkValidity() || $(id).value === "")
    .concat(ELIG_INPUTS.filter((id) => !$(id).checkValidity()));
  if (bad.length) {
    const names = bad.map((id) => {
      const b = $(id).closest("label").querySelector("b").textContent;
      return id.includes("slot_") ? `the ${b} slots` : id.startsWith("elig_") ? `the ${b} eligibility threshold` : b;
    });
    return { error: `Check ${names.join(", ")}: ${bad.map((id) => $(id).validationMessage).filter(Boolean)[0] || "a number is needed"}` };
  }
  const n = (id) => Number($(id).value);
  const slots = slotsOf(C.SLOT_TYPES, "slot_"), pitcherSlots = slotsOf(C.PITCHER_SLOT_TYPES, "pslot_");
  if (total(slots) < 4 || total(slots) > 30) return { error: `A lineup needs 4 to 30 hitter slots; this one has ${total(slots)}.` };
  if (total(pitcherSlots) < 4 || total(pitcherSlots) > 20) return { error: `A staff needs 4 to 20 pitcher slots; this one has ${total(pitcherSlots)}.` };
  const s = {
    slots, pitcherSlots, hitters: total(slots), pitchers: total(pitcherSlots), bench: n("bench"), span: n("span"),
    minimizeBench: $("min_bench").checked, style: style(), teams: n("teams"), minBid: n("min_bid"),
    budget: n("budget"), pool: $("pool").value, includeFa: $("include_fa").checked,
    format: $("format").value, weeks: n("weeks"), phi: n("phi"), ptCV: n("pt_cv"), lock: $("lock").value, twoWay: $("twoway").value,
    fillPT: $("fill_pt").checked, specialists: $("specialists").checked, curve: n("curve"),
    hitterShare: autoSplit() ? null : n("split") / 100,
    hitterCats: cats.h, pitcherCats: cats.p, hitterPoints: points.h, pitcherPoints: points.p,
  };
  // one dollar over the min bid for every priced spot, and the min bid for a minimized bench
  const minBudget = (s.minBid + 1) * (s.hitters + s.pitchers + (s.minimizeBench ? 0 : s.bench)) + (s.minimizeBench ? s.minBid * s.bench : 0);
  if (s.budget < minBudget) {
    return { error: `Team budget must be at least $${minBudget}: one dollar over the min bid for every ${s.minimizeBench ? "lineup spot, and the min bid for every bench spot" : "roster spot"}.` };
  }
  return s;
}

// ---- the risk-aware $ ------------------------------------------------------------------------

const RISK_INPUTS = ["risk_payout", "risk_playoffs", "risk_txn", "risk_il"];
const riskOn = () => $("risk_on").checked;
function showRisk() {
  $("risk_fields").hidden = !riskOn();
  $("risk_playoffs_field").hidden = $("risk_payout").value !== "playoffs";
}
$("risk_on").addEventListener("change", showRisk);
$("risk_payout").addEventListener("change", showRisk);

// Read only while the risk-aware $ is on, so its settings never stop the calculator's own values
function readRiskSettings(teams) {
  const n = (id) => Number($(id).value);
  const whole = (id, lo, hi) => $(id).value !== "" && Number.isInteger(n(id)) && n(id) >= lo && n(id) <= hi;
  if (!whole("risk_il", 0, 10)) return { error: "IL slots must be a whole number from 0 to 10" };
  const payout = $("risk_payout").value;
  if (payout === "playoffs" && !whole("risk_playoffs", 1, teams - 1)) return { error: `Playoff teams must be a whole number from 1 to ${teams - 1}` };
  return { payout, playoffTeams: n("risk_playoffs"), transactions: $("risk_txn").value, ilSlots: n("risk_il") };
}

// ---- Pitcher List ranks ----------------------------------------------------------------------

const plOn = () => $("pl_on").checked;
const plStrength = () => Number($("pl_strength").value);
function showPL() {
  $("pl_fields").hidden = !plOn();
  const v = plStrength();
  $("pl_strength_out").textContent = v === 0 ? "None" : v === 1 ? "Fitted" : v === 2 ? "Full" : v < 1 ? `${Math.round(v * 100)}% of fitted` : `fitted + ${Math.round((v - 1) * 100)}% to full`;
}
$("pl_on").addEventListener("change", showPL);
$("pl_strength").addEventListener("input", showPL);
// The lists in this league's credit, each with its article and date
function showPLSources() {
  if (!result || !result.ranks || !pl.lists) { $("pl_src").textContent = ""; return; }
  const used = ["H", "SP", ...Object.keys(result.ranks.relievers)].filter((k) => pl.lists.lists[k]);
  $("pl_src").innerHTML = "Ranks from Pitcher List: " + used.map((k) => {
    const e = pl.lists.lists[k];
    const when = C.listOff(e) ? "rank shown, no credit" : C.listTiming(e) === "in" ? "in-season weights" : "preseason weights";
    // only an https link: esc() doesn't stop a javascript: URL
    const name = esc(e.title || PL_NAMES[k]);
    const link = /^https:\/\//i.test(e.url || "") ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${name}</a>` : name;
    return `${link} (${esc(PL_NAMES[k])}, ${esc(e.date)}; ${when})`;
  }).join("; ") + ".";
}

function save() {
  const form = { style: style(), cats, points, split: manualSplit };
  for (const id of [...NUM_INPUTS, ...ELIG_INPUTS, ...SELECTS]) form[id] = $(id).value;
  for (const id of CHECKS) form[id] = $(id).checked;
  form.risk = { on: riskOn(), ...Object.fromEntries(RISK_INPUTS.map((id) => [id, $(id).value])) };
  form.pl = { on: plOn(), strength: $("pl_strength").value };
  try { localStorage.setItem(STORE, JSON.stringify(form)); } catch { /* private mode */ }
}

function restore() {
  let form;
  try { form = JSON.parse(localStorage.getItem(STORE)); } catch { return; }
  if (!form) return;
  for (const id of [...NUM_INPUTS, ...ELIG_INPUTS]) if (form[id] !== undefined) $(id).value = form[id];
  if (form.twoway === "daily" || form.twoway === "weekly") form.twoway = "oneslot";   // one slot now switches at the lineup lock
  for (const id of SELECTS) if (form[id] && [...$(id).options].some((o) => o.value === form[id])) $(id).value = form[id];
  for (const id of CHECKS) if (typeof form[id] === "boolean") $(id).checked = form[id];
  const r = document.querySelector(`input[name="style"][value="${form.style}"]`);
  if (r) r.checked = true;
  if (form.cats?.h && form.cats?.p) cats = form.cats;
  if (Array.isArray(form.points?.h) && Array.isArray(form.points?.p)) points = form.points;
  manualSplit = typeof form.split === "string" ? form.split : defaultSplit();
  if (form.pl && typeof form.pl === "object") {
    $("pl_on").checked = form.pl.on === true;
    if (typeof form.pl.strength === "string" && Number.isFinite(Number(form.pl.strength))) $("pl_strength").value = form.pl.strength;
  }
  if (form.risk && typeof form.risk === "object") {
    $("risk_on").checked = form.risk.on === true;
    for (const id of RISK_INPUTS) {
      const v = form.risk[id];
      if (typeof v !== "string") continue;
      if ($(id).tagName === "SELECT" ? [...$(id).options].some((o) => o.value === v) : true) $(id).value = v;
    }
  }
}

// ---- lineup slots ---------------------------------------------------------------------------

function showSlotTotals() {
  const count = (ids) => ids.reduce((a, id) => a + (Number($(id).value) || 0), 0);
  $("slot_total").textContent = `${count(SLOT_IDS)} per team`;
  $("pslot_total").textContent = `${count(PSLOT_IDS)} per team`;
}
$("slots_ui").addEventListener("input", showSlotTotals);
$("pslots_ui").addEventListener("input", showSlotTotals);

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
  showSlotTotals();
  changed();
});

// The select follows the settings: a format whose teams and slots they match, or Custom
function showPreset() {
  const n = (id) => Number($(id).value);
  const match = Object.keys(PRESETS).find((k) => {
    const p = PRESETS[k];
    return n("teams") === p.teams && presetInputs(p).every(([id, v]) => n(id) === v);
  });
  $("preset").value = match || "custom";
}

// ---- the settings panel ------------------------------------------------------------------

// Folds to a rail beside the table (a bar over it on a phone), so the table gets the room;
// remembered between visits. A phone's first visit starts folded: open, the settings run
// ~2,300px before the table.
const PANEL_STORE = "auction-calculator:panel";
function showPanel(open) {
  document.querySelector(".layout").classList.toggle("collapsed", !open);
  $("setbody").hidden = !open;
  $("settoggle").setAttribute("aria-expanded", String(open));
  $("settoggle").dataset.tip = open ? "Hide the settings" : "Show the settings";
  if (result) freezeOffset();   // the name column can change width with the table's
}
$("settoggle").addEventListener("click", () => {
  const open = $("setbody").hidden;
  showPanel(open);
  try { localStorage.setItem(PANEL_STORE, open ? "open" : "closed"); } catch { /* private mode */ }
});
{
  let saved = null;
  try { saved = localStorage.getItem(PANEL_STORE); } catch { /* private mode */ }
  if (saved === "closed" || (saved === null && matchMedia("(max-width:640px)").matches)) showPanel(false);
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
  const H = C.prepHitters(raw("h"), $("pool").value, $("include_fa").checked, eligOf());
  const P = C.prepPitchers(raw("p"), $("pool").value, $("include_fa").checked, eligOf());
  syncOptions(H, P);   // first, so the scoring controls are there even while a setting is invalid

  const s = readSettings();
  if (s.error) return fail(s.error);

  if (s.style === "Categories" && (!cats.h.length || !cats.p.length)) return fail("Pick at least one hitter and one pitcher category.");
  if (s.style === "Points") {
    if (!points.h.length || !points.p.length) return fail("Score at least one hitter and one pitcher category.");
    if ([...points.h, ...points.p].some(([, v]) => !Number.isFinite(v))) return fail("Every scored category needs a point value.");
  }

  // The risk-aware $ (off by default): the calculator keeps its workings for it, and risk.js prices
  // each player's simulation draws in them. With it off, nothing here changes the values
  const rs = riskOn() ? readRiskSettings(s.teams) : null;
  const ownData = !uploads.h && !uploads.p;
  const useRisk = !!rs && !rs.error && ownData && risk.state === "ready";
  // The Pitcher List credit (off by default): the league priced again with each ranked player's
  // projected stats moved toward his rank's value
  const hasRanks = Object.values(C.RANK_COLS).some((c) => C.isNumeric(H, c) || C.isNumeric(P, c));
  const usePL = plOn() && pl.state === "ready" && hasRanks;
  const s1 = useRisk ? { ...s, debug: true } : s;
  result = usePL ? C.rankCredit(H, P, s1, pl.lists, plStrength()) : C.auctionValues(H, P, s1);
  result.settings = s;
  const noTeams = (t) => t.data.Team.every((x) => x === null);
  const warnings = [];
  if (s.pool !== "All" && (noTeams(raw("h")) || noTeams(raw("p")))) {
    warnings.push("Projections without a Team column can't be filtered to AL/NL-Only; that side is priced over every player.");
  }
  if (!result.converged) warnings.push("The values didn't settle in 20 passes; these use the mean of the last two.");
  if (eligError) warnings.push(`The position eligibility file didn't load (${eligError}), so positions are the projections' own.`);
  if (plOn()) {
    if (pl.state === "idle" || pl.state === "loading") { warnings.push("Loading the Pitcher List ranks…"); loadPL(); }
    else if (pl.state === "error") warnings.push(`The Pitcher List ranks didn't load (${pl.error}).`);
    else if (!hasRanks) warnings.push("These projections have no Pitcher List rank columns, so the values are the projections' own.");
    else if (useRisk) warnings.push("The risk-aware $ prices the projections' own draws, without the Pitcher List credit.");
  }
  showPLSources();
  if (useRisk) {
    try {
      result.risk = R.applyRisk(C, result, H, P, s, risk.files, rs);
      warnings.push(...result.risk.warnings);
      if (s.style === "Points") warnings.push("Points leagues: the risk-aware $ has the option value only (the payout's value of variance needs the categories' team totals).");
    } catch (e) {
      result.risk = null;
      warnings.push(`The risk-aware $ failed: ${e.message || e}`);
    }
    delete result.debug;
  } else if (rs) {
    if (rs.error) warnings.push(`Risk: ${rs.error}.`);
    else if (!ownData) warnings.push("The risk-aware $ needs the default projections: its draws come from their simulation.");
    else if (risk.state === "error") warnings.push(`The risk files didn't load (${risk.error}).`);
    else { warnings.push("Loading the risk files…"); loadRisk(); }
  }
  status(warnings.join(" "), "warn");
  if (autoSplit()) showSplit();
  showLock();
  $("download").disabled = false;
  render();
}

// The lineup lock's tooltip: what it does in this league, after the general note
const LOCK_TIP = $("lock_tip").dataset.tip;
function showLock() {
  const L = result.lock;
  let tip = LOCK_TIP;
  if (L) {
    const spots = `a typical team rosters ${L.nSP} SPs for ${L.S} SP spots`;
    const bind = `they fill up in ${Math.round(100 * L.pBind)}% of lock windows`;
    const shares = L.kappa ? L.kappa.filter((k) => k < 1) : [];
    tip += `. In this league ${spots}; ${bind}, ` + (shares.length
      ? `so SPs keep ${Math.round(100 * Math.min(...shares))}–${Math.round(100 * Math.max(...shares))}% of their value above replacement`
      : `${L.depth < 1 ? "with no SPs on the bench" : "under the 5% where it starts to matter"}, so values don't change`);
  }
  $("lock_tip").dataset.tip = tip;
  $("lock_tip").setAttribute("aria-label", tip);
}

// A row's stats and stat dollars on one side: its own, or a two-way player's pitching. With
// Roster impact on, the stats are his line with the time he doesn't play filled at replacement
const impact = () => $("impact").checked && !$("impact").disabled && view() === "stats";
const lineOf = (r) => (impact() && r.full ? r.full : r.stats);
const statsOf = (p, side) => (p.type === side ? lineOf(p) : side === "p" && p.twoWay ? lineOf(p.twoWay) : null);
const stat$Of = (p, side) => (!p.breakdown ? null : p.type === side ? p.breakdown.stats : side === "p" ? p.breakdown.pstats || null : null);
// What a row's position tooltip says: the games his positions come from, where he's priced, a
// locked SP's share, a two-way player's use
const pct = (x) => `${Math.round(100 * x)}%`;
const gamesText = (e) => e.games.map((x) => `${x.pos} ${x.g} G${x.gs ? `, ${x.gs} GS` : ""}`).join(" · ");
function eligTip(e, side) {
  if (!e) return `No ${eligSeason() ?? "last season's"} games ${side === "p" ? "pitching" : "in the field or at DH"}: positions from the projections`;
  return e.most ? `Short of every threshold in ${e.season ?? "last season's"} games, so where he played most${e.pos === "UT" ? ", UT for DH" : ""} (${gamesText(e)})`
    : `Eligible from ${e.season ?? "last season's"} games (${gamesText(e)})`;
}
function posTip(p) {
  const tips = [];
  if (eligibility) {
    tips.push(eligTip(p.elig, p.type));
    if (p.twoWay) { const t = eligTip(p.twoWay.elig, "p"); tips.push(`As a pitcher, ${t[0].toLowerCase()}${t.slice(1)}`); }
  }
  if (p.valuedAt) tips.push(`Priced at ${p.valuedAt}`);
  if (p.lockShare < 1) tips.push(`${p.lockTier[0].toUpperCase()}${p.lockTier.slice(1)}-tier SP under this lineup lock: keeps ${pct(p.lockShare)} of his value above replacement`);
  const t = p.twoWay;
  if (t && t.mode === "simultaneous") tips.push("Two-way, simultaneous: in a hitter and a pitcher spot at once; his hitting and pitching dollars added");
  if (t && t.mode === "oneslot") {
    const at = { daily: "each day", split: "each Monday and Friday", weekly: "each week" }[t.lock] || "each day";
    tips.push(t.pitch < 0.005 ? `Two-way, one slot switched ${at}: his starts are never worth more than the hitting they'd cost (his pitching at the pitchers' price), so he only hits`
      : t.lock === "daily" ? `Two-way, one slot switched each day: pitches his ${Math.round(t.starts)} starts and hits the other days (${pct(t.hit)} of his hitting), his pitching at the pitchers' price`
        : `Two-way, one slot switched ${at}: ${pct(t.hit)} of his hitting and ${pct(t.pitch)} of his pitching, taking each lineup as whichever is worth more, his pitching at the pitchers' price`);
  }
  return tips.join(". ");
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
const VALUE_COL = { key: "value", label: "Auction $", frozen: true, get: (p) => p.value, cell: (p) => money(p.value), cls: (p) => "val" + (p.value < result.settings.minBid ? " neg" : "") };
// The risk-aware $ and its move from the Auction $ (with the Risk setting on)
const riskValue = (p) => (p.risk ? p.risk.value : NaN);
const sgp = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
function riskTip(p) {
  const r = p.risk;
  if (!r) return "";
  if (!r.draws) return `No simulation draws: his calculator value, priced with the others' risk-aware values (${money(r.value)})`;
  const parts = [`value ${r.mu.toFixed(2)}`, `option ${sgp(r.option)} (a bust dropped after ${Math.round(100 * r.lambda)}% of the season)`];
  if (Math.abs(r.payout) >= 0.005) parts.push(`payout ${sgp(r.payout)} (season SD ${r.sd.toFixed(2)})`);
  if (r.il >= 0.005) parts.push(`IL ${sgp(-r.il)}`);
  return `Risk-aware ${money(r.value)} against ${money(p.value)}. In SGP above replacement: ${parts.join(", ")}`
    + `${r.drafted ? "" : ". Not on a drafted roster at these values"}`;
}
const RISK_COL = {
  key: "risk", label: "Risk $", get: riskValue, cell: (p) => money(riskValue(p)), cls: (p) => "risk" + (riskValue(p) < result.settings.minBid ? " neg" : ""), tip: riskTip,
  title: "The risk-aware dollars: each player's value plus the option to drop him for a free agent if he busts, plus what his variance is worth for the payout, less an IL cost, priced over the same roster spots and budget. A beta",
};
// The rank and the dollars the Pitcher List credit moved (Auction $ less the value without it)
const plRanks = (p) => (p.pl ? p.pl.ranks : []);
const PL_RANK_COL = {
  key: "plrank", label: "PL rank", text: true, cls: "l muted",
  get: (p) => (plRanks(p).length ? `${plRanks(p)[0].list}:${String(plRanks(p)[0].rank).padStart(4, "0")}` : "~"),
  cell: (p) => esc(plRanks(p).map((r) => `${PL_NAMES[r.list]} ${r.rank}`).join(" · ")),
  tip: (p) => plRanks(p).map((r) => {
    const e = pl.lists && pl.lists.lists[r.list];
    const what = r.unit === "$" ? `value at that rank ${money(r.implied)}, his ${money(r.own)}` : `${r.unit} at that rank ${fmt(r.unit, r.implied)}, his ${fmt(r.unit, r.own)}`;
    return `${PL_NAMES[r.list]} #${r.rank}${e ? ` (Pitcher List, ${e.date})` : ""}: ${what}; credit weight ${r.w.toFixed(2)}`;
  }).join(". "),
  title: "Pitcher List's staff rank, by list (hover for its date and the value at that rank)",
};
const PL_CREDIT_COL = {
  key: "plcredit", label: "PL ±", get: (p) => (p.pl ? p.pl.credit : NaN), cell: (p) => (p.pl ? signed(p.pl.credit) : ""), cls: (p) => (p.pl ? signCls(p.pl.credit) : ""),
  tip: (p) => (p.pl ? `${money(p.pl.base)} without the ranks, ${money(p.value)} with them`
    + (plRanks(p).length ? "" : " (unranked: every drafted player gives back the side's average credit, so the budget is spent once)") : ""),
  title: "What the Pitcher List credit moved: Auction $ less the value without the ranks",
};
const RISK_MOVE_COL = {
  key: "riskmove", label: "Risk ±", get: (p) => riskValue(p) - p.value, cell: (p) => signed(riskValue(p) - p.value), cls: (p) => signCls(riskValue(p) - p.value),
  title: "Risk $ less Auction $",
};

// ---- the value breakdown -------------------------------------------------------------------

const view = () => document.querySelector('input[name="view"]:checked').value;
const signed = (v) => (Number.isNaN(v) ? "" : Math.abs(v) < 0.005 ? "$0.00" : (v > 0 ? "+" : "") + money(v));
const signCls = (v) => (Number.isNaN(v) ? "" : Math.abs(v) < 0.005 ? "nil" : v > 0 ? "up" : "down");
const part = (key, label, title, get, extra = {}) => ({ key, label, title, get, cell: (p) => signed(get(p)), cls: (p) => signCls(get(p)), ...extra });

// Min bid + baseline + position + playing time + each stat + specialist (+ the no-roster-spot
// hold-down) = the player's dollars
function breakdownColumns() {
  const b = (p) => p.breakdown;
  const any = (key) => result.players.some((p) => b(p) && Math.abs(b(p)[key]) >= 0.005);
  const base = [
    part("b:min", "Min bid", "Every drafted player's floor", (p) => (b(p) ? b(p).minBid : NaN)),
    part("b:base", "Baseline", "Less the last drafted player's value over replacement. On a dollar curve above 1, each part is at the player's own dollars per SGP, so stars' parts are larger",
      (p) => (b(p) ? b(p).baseline : NaN)),
    part("b:pos", "Position", "His position's premium over his side's deepest position", (p) => (b(p) ? b(p).position : NaN)),
  ];
  if (any("fill")) base.push(part("b:fill", "Playing time", "What his team gets from replacement production in the time he doesn't play", (p) => (b(p) ? b(p).fill : NaN)));
  if (any("specialist")) base.push(part("b:spec", "Specialist", "Roto: a category far above replacement buys standings points on a curve, not a line", (p) => (b(p) ? b(p).specialist : NaN)));
  if (any("lock")) base.push(part("b:lock", "Lineup lock", "What a binding lineup lock takes from an SP: he keeps his tier's share of his value above replacement", (p) => (b(p) ? b(p).lock : NaN)));
  if (any("twoWay")) base.push(part("b:tw", "Two-way", "A two-way player's pitching in a one-spot league, less the hitting he gives up for it, at the pitchers' price", (p) => (b(p) ? b(p).twoWay : NaN)));
  if (any("pl")) base.push(part("b:pl", "Pitcher List", "The Pitcher List credit: a share of the gap to his rank's value, less the side's average credit for drafted players", (p) => (b(p) ? b(p).pl ?? 0 : NaN)));
  if (any("other")) base.push(part("b:other", "No spot", "Held under the min bid: no legal roster has room for him", (p) => (b(p) ? b(p).other : NaN)));
  base.forEach((c, i) => Object.assign(c, { group: "v", first: i === 0 }));
  const unit = (side, cat) => (result.weights[side].find((w) => w.cat === cat) || {}).unit;
  const stat = (type, cat, i) => part(`$${type}:${cat}`, cat,
    `What his ${cat} adds over his side's deepest replacement, in his own playing time`
      + (unit(type, cat) && unit(type, cat) !== cat && unit(type, cat) !== "points" ? ` (as ${unit(type, cat)} against the drafted pool's rate)` : ""),
    (p) => (stat$Of(p, type) ? stat$Of(p, type)[cat] : NaN), { group: type + "$", first: i === 0 });
  return [...base, ...result.valueCols.h.map((c, i) => stat("h", c, i)), ...result.valueCols.p.map((c, i) => stat("p", c, i))];
}
const GROUPS = { h: "Hitting", p: "Pitching", v: "Value", h$: "Hitting $", p$: "Pitching $" };
const groupLabel = (g) => GROUPS[g] + (impact() && (g === "h" || g === "p") ? " · roster impact" : "");
// The playing-time cell's note under Roster impact: how much of it is replacement
const filledTip = (s, cat) => (s && s.filled > 0.05 ? `Includes ${fmt(cat, s.filled)} ${cat} of replacement production` : "");

function columns() {
  // The dollars sit by the name, so they're on screen on a phone too
  const info = [INFO[0], INFO[1], VALUE_COL, ...(result.ranks ? [PL_CREDIT_COL, PL_RANK_COL] : []), ...(result.risk ? [RISK_COL, RISK_MOVE_COL] : []), INFO[2], INFO[3], SLOT_COL,
    ...(result.settings.style === "Points" ? [POINTS_COL] : [])];
  const stat = (type, cat, first) => ({
    key: `${type}:${cat}`, label: cat, group: type, first,
    get: (p) => (statsOf(p, type) ? statsOf(p, type)[cat] : NaN), cell: (p) => (statsOf(p, type) ? fmt(cat, statsOf(p, type)[cat]) : ""),
    ...(result.valueCols[type].includes(cat) ? heatOf(type, cat) : {}),
    ...(first && impact() ? { tip: (p) => filledTip(statsOf(p, type), cat) } : {}),
  });
  if (view() === "value" && result.valueCols) return [...info, ...breakdownColumns()];
  return [
    ...info,
    ...result.hitterCols.map((c, i) => stat("h", c, i === 0)),
    ...result.pitcherCols.map((c, i) => stat("p", c, i === 0)),
  ];
}

// ---- stat shading -------------------------------------------------------------------------

// A scored stat's cells are shaded by what it adds to the player's dollars, on the column's own
// scale: nothing at or below its drafted players' median, the Auction $ green at their top 5%
// and above. The text keeps 4.5:1 on every shade: the ink while it can, then the page's dark
// ground, and pure white or black in the band where neither reaches it
const HEAT = { base: [21, 27, 35], top: [123, 216, 143] };   // --surface, --good
const INKS = [[227, 233, 241], [13, 17, 23]], EDGES = [[255, 255, 255], [0, 0, 0]];   // --ink, --ground
const lum = (c) => c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function heatStyle(v, lo, hi) {
  if (!(hi > lo) || !Number.isFinite(v) || v <= lo) return "";
  const t = Math.min(1, (v - lo) / (hi - lo));
  const bg = HEAT.base.map((b, i) => Math.round(b + (HEAT.top[i] - b) * t));
  const ink = INKS.find((c) => ratio(c, bg) >= 4.5) || EDGES.reduce((a, c) => (ratio(c, bg) > ratio(a, bg) ? c : a));
  return `background:rgb(${bg.join(",")});color:rgb(${ink.join(",")})`;
}
function heatOf(type, cat) {
  const $of = (p) => (stat$Of(p, type) ? stat$Of(p, type)[cat] : NaN);
  result.heat ??= {};
  const key = type + ":" + cat;
  if (!(key in result.heat)) {
    const v = result.players.filter((p) => p.drafted).map($of).filter(Number.isFinite).sort((a, b) => a - b);
    const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
    result.heat[key] = v.length ? [at(0.5), at(0.95)] : [0, 0];
  }
  const [lo, hi] = result.heat[key];
  return {
    title: `Shaded by what ${cat} adds to a player's dollars: none at the drafted players' median, full at their top 5%`,
    style: (p) => heatStyle($of(p), lo, hi),
    tip: (p) => (Number.isFinite($of(p)) ? `${cat}: ${$of(p) < 0 ? "costs" : "adds"} ${money(Math.abs($of(p)))}` : ""),
  };
}

const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function matchesPos(p, pos) {
  if (!pos) return true;
  if (pos === "h" || pos === "p") return p.type === pos || (pos === "p" && !!p.twoWay);
  const parts = p.pos.split(/[,/ ]+/);
  if (pos === "OF") return parts.some((x) => ["OF", "LF", "CF", "RF"].includes(x));
  return parts.includes(pos);
}

function render() {
  $("impact").disabled = view() !== "stats" || !result.players.some((p) => p.full);
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

  renderScarcity();

  // The group row: a cell spanning each run of columns in one group
  const runs = [];
  for (const c of cols) {
    const last = runs[runs.length - 1];
    if (last && last.group === c.group) last.n++;
    else runs.push({ group: c.group, n: 1 });
  }
  const head = `<thead><tr>${runs.map((r) => (r.group ? `<th colspan="${r.n}" class="gp">${groupLabel(r.group)}</th>` : `<th colspan="${r.n}"></th>`)).join("")}</tr><tr>`
    + cols.map((c) => {
      const cls = [c.text ? "l" : "", c.key === "name" ? "name" : "", c.frozen ? "frz" : "", c.first ? "gp" : ""].filter(Boolean).join(" ");
      const aria = c.key === sort.key ? ` aria-sort="${sort.dir < 0 ? "descending" : "ascending"}"` : "";
      return `<th data-key="${esc(c.key)}"${cls ? ` class="${cls}"` : ""}${aria}${c.title ? ` data-tip="${esc(c.title)}"` : ""} scope="col">${esc(c.label)}</th>`;
    }).join("") + `</tr></thead>`;
  const rowHtml = (p) => `<tr class="${p.type}">` + cols.map((c) => {
    const cls = [typeof c.cls === "function" ? c.cls(p) : c.cls, c.frozen ? "frz" : "", c.first ? "gp" : ""].filter(Boolean).join(" ");
    const title = c.tip ? c.tip(p) : c.key === "name" ? p.name : c.key === "pos" ? posTip(p)
      : c.key === "value" && !p.drafted ? "Not on a drafted roster" : "";
    const style = c.style ? c.style(p) : "";
    return `<td${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""}${title ? ` data-tip="${esc(title)}"` : ""}>${c.cell(p)}</td>`;
  }).join("") + `</tr>`;
  // enough rows to fill the box down to where it's scrolled, then more as it scrolls
  const box = $("tbl");
  const rowH = $("table").tBodies[0]?.rows[0]?.offsetHeight || 30;
  const n = Math.max(ROW_CHUNK, Math.ceil((box.scrollTop + box.clientHeight) / rowH) + ROW_CHUNK);
  shown = { rows, html: rowHtml, n: Math.min(n, rows.length) };
  const body = rows.length
    ? rows.slice(0, shown.n).map(rowHtml).join("")
    : `<tr><td class="empty l" colspan="${cols.length}">No players match.</td></tr>`;
  $("table").innerHTML = head + `<tbody>${body}</tbody>`;
  $("heatkey").hidden = view() === "value";
  box.hidden = false;
  freezeOffset();
}

// The table draws its rows a chunk at a time: all ~2,300 at once was a 1.5MB rebuild (44,000
// elements) on every setting and search keystroke, seconds on a phone. Sorting, filtering and the
// CSV still cover every player; scrolling the box near its end adds the next chunk.
const ROW_CHUNK = 100;
let shown = null;
function moreRows() {
  if (!shown || shown.n >= shown.rows.length) return;
  const box = $("tbl");
  if (box.scrollTop + box.clientHeight < box.scrollHeight - 800) return;
  const next = shown.rows.slice(shown.n, shown.n + ROW_CHUNK);
  shown.n += next.length;
  $("table").tBodies[0].insertAdjacentHTML("beforeend", next.map(shown.html).join(""));
  freezeOffset();   // a longer name further down can widen the frozen name column
}
$("tbl").addEventListener("scroll", moreRows, { passive: true });

// Each position's premium over its side's deepest one, scarcest first, as the data has it
function renderScarcity() {
  const el = $("scarcity");
  const chips = (side) => result.positions.filter((p) => p.side === side).map((p) =>
    `<span class="prem${p.premium >= 0.005 ? " up" : ""}" data-tip="${p.slots} slots · replacement ${p.level.toFixed(2)} · last starter ${p.worst.toFixed(2)}"><b>${esc(p.slot)}</b>${p.premium >= 0.005 ? "+" + money(p.premium) : "$0"}</span>`).join("");
  el.innerHTML = `<span data-tip="What a player is worth over the same player at his side's deepest position, from this league's best lineups">Position premium</span>`
    + `<span class="side">Hitters</span>${chips("h")}<span class="side">Pitchers</span>${chips("p")}`;
  el.hidden = false;
}

// The frozen dollars column sits just right of the frozen name column, however wide that is
function freezeOffset() {
  const name = $("table").querySelector("thead th.name");
  if (name) $("table").style.setProperty("--name-w", `${name.getBoundingClientRect().width}px`);
}
window.addEventListener("resize", freezeOffset);

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
$("impact").addEventListener("change", () => {
  try { localStorage.setItem(IMPACT_STORE, $("impact").checked ? "1" : ""); } catch { /* private mode */ }
  if (result) render();
});
try { $("impact").checked = localStorage.getItem(IMPACT_STORE) === "1"; } catch { /* private mode */ }
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
  const name = (c, side) => (byValue ? c + " $" : c) + (both.has(c) ? "_" + side : "");
  const extra = byValue ? breakdownColumns().filter((c) => c.group === "v") : [];
  const withRisk = !!result.risk;
  const withPL = !!result.ranks;
  const head = ["Rank", "Name", "Team", "Y! Pos", "Slot", ...(settings.style === "Points" ? ["Points"] : []), "Value", ...(withPL ? ["PL rank", "PL $"] : []), ...(withRisk ? ["Risk $"] : []),
    ...extra.map((c) => c.label), ...hitterCols.map((c) => name(c, "h")), ...pitcherCols.map((c) => name(c, "p"))];
  const num = (v, d) => (v === undefined || Number.isNaN(v) ? "" : d === undefined ? String(v) : v.toFixed(d));
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const sideValue = (p, side, c) => (byValue ? (stat$Of(p, side) ? num(stat$Of(p, side)[c], 2) : "") : statsOf(p, side) ? num(statsOf(p, side)[c]) : "");
  const lines = [head.map(cell).join(",")];
  for (const p of players) {
    lines.push([num(p.rank), p.name, p.team, p.pos, p.slot ?? "", ...(settings.style === "Points" ? [num(p.points, 2)] : []), num(p.value, 2),
      ...(withPL ? [plRanks(p).map((r) => `${PL_NAMES[r.list]} ${r.rank}`).join(" / "), p.pl ? num(p.pl.credit, 2) : ""] : []),
      ...(withRisk ? [num(riskValue(p), 2)] : []),
      ...extra.map((c) => num(c.get(p), 2)),
      ...hitterCols.map((c) => sideValue(p, "h", c)),
      ...pitcherCols.map((c) => sideValue(p, "p", c))].map((v) => cell(String(v))).join(","));
  }
  const a = document.createElement("a");
  // UTF-8 with a byte-order mark: without one, Excel reads a CSV in the system code page and
  // turns José Ramírez into JosÃ© RamÃ­rez
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" }));
  a.download = "auction_values.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---- tooltips ------------------------------------------------------------------------------

// One floating box for everything with data-tip: on hover (after a beat, except the ⓘ
// buttons, which are there to be read), on keyboard focus, or on a tap of an ⓘ. One opened by
// a tap or the keyboard stays until a tap elsewhere, Esc or a scroll
const tipBox = $("tip");
let tipFor = null, tipTimer = 0, tipPinned = false, pointer = "mouse";
function showTip(el, pinned = false) {
  clearTimeout(tipTimer);
  tipFor = el;
  tipPinned = pinned;
  tipBox.textContent = el.dataset.tip;
  tipBox.hidden = false;
  const r = el.getBoundingClientRect(), w = tipBox.offsetWidth, h = tipBox.offsetHeight;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - 8 - w);
  const y = r.bottom + 6 + h > innerHeight - 8 ? r.top - 6 - h : r.bottom + 6;
  tipBox.style.left = `${x}px`;
  tipBox.style.top = `${Math.max(8, y)}px`;
}
function hideTip() {
  clearTimeout(tipTimer);
  tipFor = null;
  tipPinned = false;
  tipBox.hidden = true;
}
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el === tipFor || (tipPinned && !el)) return;
  hideTip();
  if (!el || (el.matches("td.name") && el.scrollWidth <= el.clientWidth)) return;   // a name only when it's cut off
  tipTimer = setTimeout(() => showTip(el), el.matches("button.tip") ? 0 : 400);
});
document.addEventListener("pointerdown", (e) => { pointer = e.pointerType; });
document.addEventListener("focusin", (e) => { if (e.target.matches("button.tip")) showTip(e.target, true); });
document.addEventListener("focusout", (e) => { if (e.target === tipFor) hideTip(); });
document.addEventListener("click", (e) => {
  const el = e.target.closest("button.tip");
  if (el) showTip(el, pointer !== "mouse");   // a mouse's tip goes when the mouse does
  else hideTip();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
addEventListener("scroll", hideTip, true);
// a screen reader reads the small print as the button's name
document.querySelectorAll("button.tip").forEach((b) => b.setAttribute("aria-label", b.dataset.tip));

restore();
showSplit();
showFormat();
showRisk();
showPL();
showSlotTotals();
showPreset();
renderSources();
loadDefaults();
