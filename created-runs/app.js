// Created Runs Leaders: the hitters in data.json (tools/created_runs/build_data.py, from the Total
// Offensive Value project's off_val leaderboard) in one sortable table, every stat a heat cell.

const VISIBLE_ROWS = 20; // the table is this many rows tall and scrolls for the rest

// Columns after the name, by group. hl marks the group's headline column.
const COLS = [
  { key: "pa", label: "PA", group: "created", heat: false, digits: 0 },
  { key: "cr", label: "CR", group: "created", hl: true },
  { key: "cr600", label: "CR/600", group: "created" },
  { key: "bcr", label: "bCR", group: "batting", hl: true, divider: true },
  { key: "state", label: "Batted Ball Quality", group: "batting" },
  { key: "luck", label: "Hit Luck", group: "batting" },
  { key: "bb", label: "BB", group: "batting" },
  { key: "hbp", label: "HBP", group: "batting" },
  { key: "k", label: "K", group: "batting" },
  { key: "ctx", label: "State Context", group: "batting" },
  { key: "rcr", label: "rCR", group: "running", hl: true, divider: true },
  { key: "h2f", label: "Home-to-First", group: "running" },
  { key: "bsr", label: "BsR", group: "running" },
  { key: "sb", label: "SB", group: "running" },
  { key: "cspo", label: "CS+PO", group: "running" },
];

// The PLPD heat-cell stops, coldest to hottest, with base-white at zero
const COLD = ["#ffffff", "#aaccff", "#5599ff", "#0066ff"];
const HOT = ["#ffffff", "#e2bcbe", "#c6797c", "#a9363b"];
const DARK_TEXT = "#292c42"; // card-bg, the heat cell's text on its light fills
const LIGHT_TEXT = "#ffffff"; // base-white

const $ = (id) => document.getElementById(id);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function along(stops, t) {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const a = hex(stops[i]), b = hex(stops[i + 1]), f = x - i;
  return a.map((v, j) => Math.round(v + (b[j] - v) * f));
}
function heat(value, { min, max }) {
  if (value > 0 && max > 0) return along(HOT, value / max);
  if (value < 0 && min < 0) return along(COLD, value / min);
  return hex("#ffffff");
}
function textOn([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.4 ? DARK_TEXT : LIGHT_TEXT;
}
const fmt = (v, digits = 1) => {
  if (v === null || v === undefined) return "—";
  const s = Math.abs(v).toFixed(digits);
  return v < 0 && Number(s) !== 0 ? "−" + s : s;
};
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let DATA = null, PLAYERS = [];
// Every column ranks highest first on its first pick; a second pick ranks lowest first.
let sort = { key: "cr", dir: "desc" };

function ranked() {
  const pool = PLAYERS.filter((p) => p[sort.key] !== null);
  const sign = sort.dir === "desc" ? -1 : 1;
  pool.sort((a, b) => sign * (a[sort.key] - b[sort.key]) || b.cr - a.cr || a.name.localeCompare(b.name));
  return pool;
}

function renderHead() {
  $("col-head").innerHTML =
    '<th class="left sticky g-created" scope="col"><span class="label">Hitter</span></th>' +
    COLS.map((c) => {
      const cls = [`g-${c.group}`, c.heat === false ? "right" : "", c.hl ? "hl" : "", c.divider ? "div" : ""];
      const active = c.key === sort.key ? ` aria-sort="${sort.dir === "desc" ? "descending" : "ascending"}"` : "";
      return `<th class="${cls.join(" ").trim()}" scope="col"${active}>` +
        `<button type="button" data-key="${c.key}">${c.label}</button></th>`;
    }).join("");
}

function renderRows() {
  const list = ranked();
  $("rows").innerHTML = list.map((r) => {
    const cells = COLS.map((c) => {
      if (c.heat === false) return `<td class="plain">${fmt(r[c.key], c.digits)}</td>`;
      const cls = ["heat", c.hl ? "hl" : "", c.divider ? "div" : ""].join(" ").trim();
      if (r[c.key] === null) return `<td class="${cls} plain">${fmt(null)}</td>`;
      const rgb = heat(r[c.key], DATA.scale[c.key]);
      return `<td class="${cls}" style="background:rgb(${rgb});color:${textOn(rgb)}">${fmt(r[c.key])}</td>`;
    }).join("");
    return `<tr><td class="name sticky">${escape(r.name)}</td>${cells}</tr>`;
  }).join("");
  return list.length;
}

// The visible subtitle is fixed; the table's caption names the current ranking for screen readers.
function renderCaption(count) {
  const col = COLS.find((c) => c.key === sort.key);
  const order = sort.dir === "desc" ? "highest first" : "lowest first";
  $("caption").textContent = `${count} hitters with ${DATA.minPa}+ PA ranked by ${col.label}, ${order}, ${DATA.season}`;
}

// Size the scroll box to the two header rows plus VISIBLE_ROWS body rows, measured, so it holds
// exactly 20 hitters whatever the fonts render at.
function fitHeight() {
  const wrap = $("wrap"), head = wrap.querySelector("thead"), groupRow = head.rows[0];
  if (!groupRow) return;
  wrap.style.setProperty("--group-row-h", `${groupRow.getBoundingClientRect().height}px`);
  const rows = [...wrap.querySelectorAll("tbody tr")].slice(0, VISIBLE_ROWS);
  const body = rows.reduce((h, r) => h + r.getBoundingClientRect().height, 0);
  const border = wrap.offsetHeight - wrap.clientHeight; // the frame's 1px top and bottom
  wrap.style.maxHeight = `${head.getBoundingClientRect().height + body + border}px`;
}

function render() {
  renderHead();
  renderCaption(renderRows());
  fitHeight();
}

$("col-head").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-key]");
  if (!button || !DATA) return;
  const key = button.dataset.key;
  sort = key === sort.key ? { key, dir: sort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" };
  render();
  $("wrap").scrollTop = 0; // a new ranking starts from its first hitter
  document.querySelector(`#col-head button[data-key="${key}"]`).focus({ preventScroll: true });
});

async function boot() {
  try {
    const r = await fetch("data.json?v=2");
    if (!r.ok) throw new Error(`data ${r.status}`);
    DATA = await r.json();
  } catch (e) {
    $("status").textContent = `Couldn't load the leaderboard (${e.message}).`;
    $("status").hidden = false;
    return;
  }
  // rows arrive as arrays in DATA.keys order; turn them into objects once
  PLAYERS = DATA.rows.map((row) => Object.fromEntries(DATA.keys.map((k, i) => [k, row[i]])));
  document.querySelectorAll(".season").forEach((el) => (el.textContent = DATA.season));
  document.querySelectorAll(".min-pa").forEach((el) => (el.textContent = DATA.minPa));
  $("gl-count").textContent = DATA.players;
  render();
  // web fonts and window size change row heights, so fit the box again when either settles
  document.fonts?.ready.then(fitHeight);
  addEventListener("resize", fitHeight);
}
boot();
