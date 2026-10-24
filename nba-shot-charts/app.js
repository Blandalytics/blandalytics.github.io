// The NBA Shot Charts page: season, player and game pickers over the scoring chart, the two
// leaderboards, shot value added and team minutes. The data is tools/nba_shot_charts'
// JSON in R2 (nba/manifest.json, nba/<season>/{shots,minutes}.json, nba/xfg_grid.json),
// each season's files fetched under its manifest stamp so a morning's update shows at once.
// A chart is linkable as #<season>/<player id>/<game id | season>.

import { prepare, defaultPick, summary, seasonBoard, gameBoard, valueAdded, teamMinutes } from "./model.js?v=1";
import { draw, W as FIG_W } from "./figure.js?v=8";
import { drawScatter, SW } from "./scatter.js?v=4";

const params = new URLSearchParams(location.search);
const DATA = new URL(params.get("data") || "https://data.blandalytics.com/", location.href).href;
const $ = (id) => document.getElementById(id);
const el = {
  season: $("season"), player: $("player"), playerList: $("player_list"), game: $("game"), status: $("status"),
  seasonLabel: $("season_label"), through: $("through"), chartBox: $("chart_box"), fig: $("fig"), share: $("share_png"),
  sliders: $("sliders"), seasonMin: $("season_min"), gameMin: $("game_min"), seasonMinV: $("season_min_v"), gameMinV: $("game_min_v"),
  seasonBoard: $("season_board"), gameBoard: $("game_board"), seasonBoardDesc: $("season_board_desc"), gameBoardDesc: $("game_board_desc"),
  va: $("va"), vaBox: $("va_box"), vaTip: $("va_tip"), vaDesc: $("va_desc"), team: $("team"), allTeams: $("all_teams"), minutes: $("minutes"),
};
const viewChips = [...document.querySelectorAll("[data-view]")];
const modeChips = [...document.querySelectorAll("[data-mode]")];

// The app's team list and colours; its order is the divisions', five teams each
const TEAMS = [
  ["Boston Celtics", 1610612738, "#007a33"], ["Brooklyn Nets", 1610612751, "#000000"], ["New York Knicks", 1610612752, "#f58426"],
  ["Philadelphia 76ers", 1610612755, "#002b5c"], ["Toronto Raptors", 1610612761, "#ce1141"],
  ["Chicago Bulls", 1610612741, "#ce1141"], ["Cleveland Cavaliers", 1610612739, "#860038"], ["Detroit Pistons", 1610612765, "#c8102e"],
  ["Indiana Pacers", 1610612754, "#002d62"], ["Milwaukee Bucks", 1610612749, "#00471b"],
  ["Atlanta Hawks", 1610612737, "#e03a3e"], ["Charlotte Hornets", 1610612766, "#00788c"], ["Miami Heat", 1610612748, "#98002e"],
  ["Orlando Magic", 1610612753, "#0077c0"], ["Washington Wizards", 1610612764, "#002b5c"],
  ["Denver Nuggets", 1610612743, "#0e2240"], ["Minnesota Timberwolves", 1610612750, "#0c2340"], ["Oklahoma City Thunder", 1610612760, "#007ac1"],
  ["Portland Trail Blazers", 1610612757, "#e03a3e"], ["Utah Jazz", 1610612762, "#002b5c"],
  ["Golden State Warriors", 1610612744, "#1d428a"], ["LA Clippers", 1610612746, "#c8102e"], ["Los Angeles Lakers", 1610612747, "#552583"],
  ["Phoenix Suns", 1610612756, "#1d1160"], ["Sacramento Kings", 1610612758, "#5a2d81"],
  ["Dallas Mavericks", 1610612742, "#00538c"], ["Houston Rockets", 1610612745, "#ce1141"], ["Memphis Grizzlies", 1610612763, "#5d76a9"],
  ["New Orleans Pelicans", 1610612740, "#0c2340"], ["San Antonio Spurs", 1610612759, "#c4ced4"],
].map(([name, id, color]) => ({ name, id, color }));
const CONFERENCES = [["Eastern", ["Atlantic", "Central", "Southeast"]], ["Western", ["Northwest", "Pacific", "Southwest"]]];
const DEFAULT_TEAM = 1610612760;   // the app opens on the Thunder
const GAME_ROWS = 100;

const state = {
  manifest: null, season: null, data: null, grid: null, minutes: null,
  player: null, game: null, view: "game", mode: "total",
  sort: { season: { key: "pts", dir: -1 }, game: { key: "pts", dir: -1 } },
};
const cache = new Map();

// ---- helpers -----------------------------------------------------------------------------

const status = (text, cls = "") => {
  el.status.textContent = text;
  el.status.className = `plpd-status ${cls}`.trim();
  el.status.hidden = !text;
};
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const day = (iso) => new Date(`${iso}T12:00:00`);
const shortDate = (iso) => day(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const slashDate = (iso) => { const d = day(iso); return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; };
const num = (v, d = 1) => {
  if (!Number.isFinite(v)) return "";
  const s = v.toFixed(d);
  return (Number(s) === 0 ? s.replace("-", "") : s).replace(/^-/, "−");
};
const slug = (s) => fold(s).replace(/ /g, "-");

async function getJson(path) {
  const r = await fetch(DATA + path, { cache: "default" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ---- data --------------------------------------------------------------------------------

function loadSeason(entry) {
  const v = encodeURIComponent(entry.updated);
  if (!cache.has(entry.season)) {
    const p = getJson(`nba/${entry.season}/shots.json?v=${v}`).then(prepare);
    p.catch(() => cache.delete(entry.season));
    cache.set(entry.season, p);
  }
  return cache.get(entry.season);
}

function loadMinutes(entry) {
  const k = `${entry.season}:minutes`;
  if (!cache.has(k)) {
    const p = getJson(`nba/${entry.season}/minutes.json?v=${encodeURIComponent(entry.updated)}`);
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return cache.get(k);
}

// On screen a canvas is drawn at its displayed width times the device's pixel ratio, so its text
// is never shrunk by the browser (a fixed 2x canvas squeezed into ~950 px reads jagged); it is
// redrawn whenever its box changes width. Share image still draws its own canvas at 2x.
function screenScale(canvas, logicalWidth) {
  const shown = canvas.getBoundingClientRect().width || canvas.parentElement.clientWidth || logicalWidth;
  return Math.max(0.25, (shown * (window.devicePixelRatio || 1)) / logicalWidth);
}
const drawnAt = new Map();   // box -> the width it was last drawn for
const resized = new ResizeObserver((entries) => requestAnimationFrame(() => {
  if (!state.data) return;
  for (const { target } of entries) {
    const w = target.clientWidth;
    if (!w || drawnAt.get(target) === w) continue;
    if (target === el.chartBox) drawChart();
    else renderValueAdded();
  }
}));

// ---- the scoring chart -------------------------------------------------------------------

function title(sum) {
  const label = sum.game ? slashDate(sum.game.date) : state.season.season;
  return `Scoring Summary: ${sum.player.name} (${label})`;
}

function current() {
  return summary(state.data, state.player, state.view === "game" ? state.game : null);
}

function renderChart() {
  const pl = state.data.players[state.player];
  el.player.value = pl.name;
  el.game.innerHTML = pl.games.map((r) => {
    const g = state.data.games[r.g];
    return `<option value="${r.g}">${esc(shortDate(g.date))} · ${esc(r.matchup || g.id)}</option>`;
  }).join("");
  if (state.game == null || !pl.games.some((r) => r.g === state.game)) state.game = pl.games[0]?.g ?? null;
  el.game.value = String(state.game);
  el.game.disabled = state.view !== "game";
  el.game.closest(".game").hidden = state.view !== "game";
  viewChips.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));

  el.chartBox.hidden = false;
  el.share.hidden = false;
  drawChart();
  status("");
  writeHash();
}

function drawChart() {
  const sum = current();
  draw(el.fig, sum, state.grid, { scale: screenScale(el.fig, FIG_W), title: title(sum) });
  el.fig.setAttribute("aria-label", `${title(sum)}: ${Math.round(sum.fgPts + sum.ftm)} points on ${sum.n} shots`);
  drawnAt.set(el.chartBox, el.chartBox.clientWidth);
}

function writeHash() {
  const pl = state.data.players[state.player];
  const g = state.view === "game" ? state.data.games[state.game]?.id : "season";
  history.replaceState(null, "", `#${state.season.season}/${pl.id}/${g}`);
}

function readHash() {
  const [season, player, game] = decodeURIComponent(location.hash.slice(1)).split("/");
  return { season, player: Number(player), game };
}

ShareImage.image(el.share, () => {
  const c = document.createElement("canvas");
  const sum = current();
  draw(c, sum, state.grid, { scale: 2, title: title(sum) });
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("no image"))), "image/png"));
}, () => {
  const pl = state.data.players[state.player];
  const when = state.view === "game" ? state.data.games[state.game].date : state.season.season;
  return `nba-scoring-${slug(pl.name)}-${when}.png`;
});

// the player picker: a type-ahead over the season's players, most points first
let active = -1, matches = [];
function suggest() {
  const q = fold(el.player.value === state.data?.players[state.player]?.name ? "" : el.player.value);
  const list = state.data.byPoints;
  matches = !q ? list : [
    ...list.filter((p) => fold(p.name).startsWith(q)),
    ...list.filter((p) => !fold(p.name).startsWith(q) && fold(p.name).split(" ").some((w) => w.startsWith(q))),
    ...list.filter((p) => !fold(p.name).split(" ").some((w) => w.startsWith(q)) && fold(p.name).includes(q)),
  ];
  matches = matches.slice(0, 60);
  active = matches.length ? 0 : -1;
  el.playerList.innerHTML = matches.map((p, i) =>
    `<li role="option" id="pl_${i}" data-i="${i}"${i === active ? ' class="active" aria-selected="true"' : ""}>${esc(p.name)}<small>${Math.round(p.points).toLocaleString()} pts</small></li>`).join("")
    || `<li aria-disabled="true">No players match</li>`;
  el.playerList.hidden = false;
  el.player.setAttribute("aria-expanded", "true");
}
function closeList() {
  el.playerList.hidden = true;
  el.player.setAttribute("aria-expanded", "false");
  el.player.removeAttribute("aria-activedescendant");
}
function pick(p) {
  closeList();
  if (!p) return;
  state.player = p.p;
  state.game = p.games[0]?.g ?? null;
  renderChart();
}
function moveActive(step) {
  if (!matches.length) return;
  active = (active + step + matches.length) % matches.length;
  [...el.playerList.children].forEach((li, i) => {
    li.classList.toggle("active", i === active);
    li.setAttribute("aria-selected", String(i === active));
  });
  el.playerList.children[active].scrollIntoView({ block: "nearest" });
  el.player.setAttribute("aria-activedescendant", `pl_${active}`);
}
el.player.addEventListener("focus", () => { el.player.select(); suggest(); });
el.player.addEventListener("input", suggest);
el.player.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); if (el.playerList.hidden) suggest(); else moveActive(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
  else if (e.key === "Enter") { e.preventDefault(); pick(matches[active]); el.player.blur(); }
  else if (e.key === "Escape") { closeList(); el.player.value = state.data.players[state.player].name; el.player.blur(); }
});
el.player.addEventListener("blur", () => setTimeout(() => {
  closeList();
  if (state.data) el.player.value = state.data.players[state.player].name;
}, 120));
el.playerList.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  e.preventDefault();
  pick(matches[Number(li.dataset.i)]);
  el.player.blur();
});

el.game.addEventListener("change", () => { state.game = Number(el.game.value); renderChart(); });
viewChips.forEach((b) => b.addEventListener("click", () => {
  if (state.view === b.dataset.view || !state.data) return;
  state.view = b.dataset.view;
  renderChart();
}));

// ---- leaderboards ------------------------------------------------------------------------

const SEASON_COLS = {
  // [key, header, decimals]
  total: [["games", "G", 0], ["pts", "Pts", 0], ["fga", "FGA", 0], ["vol", "Vol Pts", 1], ["qual", "Qual Pts", 1],
    ["make", "Make Pts", 1], ["fgPts", "FG Pts", 0], ["xfta", "xFTA Pts", 1], ["ftDraw", "FT Draw Pts", 1],
    ["ftMake", "FT Make Pts", 1], ["ftPts", "FT Pts", 0]],
  per: [["fga", "FGA", 0], ["pts", "Pts", 2], ["qual", "Qual Pts", 2], ["make", "Make Pts", 2],
    ["xfta", "xFTA Pts", 2], ["ftDraw", "FT Draw Pts", 2]],
};
const GAME_COLS = {
  total: SEASON_COLS.total.slice(1),
  per: SEASON_COLS.per,
};

function board(rows, cols, which, nameCell) {
  const sort = state.sort[which];
  if (!cols.some(([k]) => k === sort.key) && sort.key !== "name") Object.assign(sort, { key: "pts", dir: -1 });
  const val = (r) => (sort.key === "name" ? r.player.name : r[sort.key]);
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    if (typeof x === "string") return x.localeCompare(y) * -sort.dir;
    const nx = Number.isNaN(x), ny = Number.isNaN(y);
    if (nx || ny) return nx - ny;
    return (x - y) * sort.dir || b.pts - a.pts;
  });
  const shown = which === "game" ? rows.slice(0, GAME_ROWS) : rows;
  const head = (k, label, cls = "") => {
    const sorted = sort.key === k ? ` aria-sort="${sort.dir < 0 ? "descending" : "ascending"}"` : "";
    return `<th scope="col" class="${cls}"${sorted}><button type="button" data-sort="${k}">${label}</button></th>`;
  };
  const cell = (r, [k, , d]) => `<td>${d === 0 ? Math.round(r[k]).toLocaleString() : num(r[k], d)}</td>`;
  return `<table class="plpd-table"><caption>${which === "game" ? "Game" : "Season"} leaderboard</caption>
    <thead><tr>${head("name", which === "game" ? "Player · Game" : "Player", "name left")}${cols.map(([k, l]) => head(k, l)).join("")}</tr></thead>
    <tbody>${shown.map((r) => `<tr><td class="name">${nameCell(r)}</td>${cols.map((c) => cell(r, c)).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderBoards() {
  const per = state.mode === "per";
  modeChips.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  el.sliders.hidden = !per;
  const seasonMin = Number(el.seasonMin.value), gameMin = Number(el.gameMin.value);
  el.seasonMinV.textContent = seasonMin;
  el.gameMinV.textContent = gameMin;
  for (const r of [el.seasonMin, el.gameMin]) r.style.setProperty("--plpd-range-pct", `${((r.value - r.min) / (r.max - r.min)) * 100}%`);

  const seasonRows = seasonBoard(state.data, { perShot: per, minShots: seasonMin });
  const gameRows = gameBoard(state.data, { perShot: per, minShots: gameMin });
  el.seasonBoardDesc.textContent = per
    ? `Points per shot for the ${seasonRows.length.toLocaleString()} players with at least ${seasonMin} shots. Volume is 1.09 on every shot, so it is left out.`
    : `All ${seasonRows.length.toLocaleString()} players with a shot this season.`;
  el.gameBoardDesc.textContent = per
    ? `Points per shot in games of at least ${gameMin} shots, the ${GAME_ROWS} best for the column sorted.`
    : `The season's ${GAME_ROWS} best games for the column sorted.`;

  el.seasonBoard.innerHTML = board(seasonRows, SEASON_COLS[state.mode], "season",
    (r) => `<button type="button" data-player="${r.player.p}">${esc(r.player.name)}</button>`);
  el.gameBoard.innerHTML = board(gameRows, GAME_COLS[state.mode], "game",
    (r) => `<button type="button" data-player="${r.player.p}" data-game="${r.game.g}">${esc(r.player.name)}</button><small>${esc(shortDate(r.game.date))} · ${esc(r.matchup)}</small>`);
}

function sliderBounds() {
  let seasonMax = 1, gameMax = 1;
  for (const pl of state.data.players) {
    seasonMax = Math.max(seasonMax, pl.shots.length);
    for (const r of pl.games) gameMax = Math.max(gameMax, r.shots.length);
  }
  el.seasonMin.max = seasonMax;
  el.gameMin.max = gameMax;
  el.seasonMin.value = Math.min(50, seasonMax);
  el.gameMin.value = Math.min(5, gameMax);
}

modeChips.forEach((b) => b.addEventListener("click", () => {
  if (state.mode === b.dataset.mode || !state.data) return;
  state.mode = b.dataset.mode;
  renderBoards();
}));
for (const r of [el.seasonMin, el.gameMin]) r.addEventListener("input", () => state.data && renderBoards());
for (const [box, which] of [[el.seasonBoard, "season"], [el.gameBoard, "game"]]) {
  box.addEventListener("click", (e) => {
    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const s = state.sort[which], k = sortBtn.dataset.sort;
      Object.assign(s, s.key === k ? { dir: -s.dir } : { key: k, dir: k === "name" ? 1 : -1 });
      renderBoards();
      box.querySelector(`[data-sort="${k}"]`)?.focus();
      return;
    }
    const row = e.target.closest("[data-player]");
    if (!row) return;
    state.player = Number(row.dataset.player);
    if (row.dataset.game) { state.view = "game"; state.game = Number(row.dataset.game); }
    else { state.view = "season"; }
    renderChart();
    el.chartBox.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// ---- shot value added --------------------------------------------------------------------

let vaPoints = [];
function renderValueAdded() {
  const va = valueAdded(state.data);
  vaPoints = drawScatter(el.va, va, { scale: screenScale(el.va, SW) });
  drawnAt.set(el.vaBox, el.vaBox.clientWidth);
  el.vaDesc.textContent = `Points added by the shots a player takes (quality, up) and by making them (across), for the ${va.rows.length} players with at least ${Math.ceil(va.threshold)} shots, the top quarter by volume. Each diagonal is a line of equal points added, the solid one through the league average; the dashed ones step out ${num(va.guideStep * 2, 1)} points (one standard deviation) at a time. Hover a player for the numbers.`;
}
el.va.addEventListener("pointermove", (e) => {
  const rect = el.va.getBoundingClientRect();
  const k = SW / rect.width;
  const x = (e.clientX - rect.left) * k, y = (e.clientY - rect.top) * k;
  let best = null, dist = 16 * 16;
  for (const p of vaPoints) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < dist) { dist = d; best = p; }
  }
  if (!best) { el.vaTip.hidden = true; el.va.style.cursor = ""; return; }
  const r = best.row;
  el.vaTip.innerHTML = `<b>${esc(r.player.name)}</b><span class="big">Points added: ${num(r.added)}</span><br>Shot making: ${num(r.make)}<br>Shot quality: ${num(r.qual)}<br>${r.shots.toLocaleString()} shots`;
  el.vaTip.hidden = false;
  el.va.style.cursor = "pointer";
  const left = best.x / k + 14, top = best.y / k + 14;
  el.vaTip.style.left = `${Math.min(left, rect.width - el.vaTip.offsetWidth - 8)}px`;
  el.vaTip.style.top = `${Math.min(top, rect.height - el.vaTip.offsetHeight - 8)}px`;
});
el.va.addEventListener("pointerleave", () => { el.vaTip.hidden = true; });
el.va.addEventListener("click", () => {
  if (el.vaTip.hidden) return;
  const name = el.vaTip.querySelector("b").textContent;
  const pl = state.data.players.find((p) => p.name === name);
  if (!pl) return;
  state.player = pl.p;
  state.view = "season";
  renderChart();
  el.chartBox.scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---- team minutes ------------------------------------------------------------------------

function minutesTable(teamId) {
  const { dates, rows } = teamMinutes(state.minutes, teamId);
  if (!rows.length) return `<p class="plpd-status">No games yet.</p>`;
  const cols = [["Last 3", "last3"], ["Last 5", "last5"], ["Last 10", "last10"], ["Season", "all"]];
  return `<div class="plpd-table-wrap"><table class="plpd-table"><thead><tr><th scope="col" class="name left"><span>Player</span></th>
    ${cols.map(([l]) => `<th scope="col"><span>${l}</span></th>`).join("")}${dates.map((d) => `<th scope="col"><span>${esc(shortDate(d))}</span></th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="name">${esc(r.name)}</td>${cols.map(([, k]) => `<td>${num(r[k])}</td>`).join("")}${r.days.map((m) => `<td>${num(m)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

const teamBlock = (t) => `<div class="team"><div class="plpd-mini"><h3 class="plpd-mini__title"><span class="swatch" style="background:${t.color}"></span>${esc(t.name)}</h3></div>${minutesTable(t.id)}</div>`;

function renderMinutes() {
  if (!state.minutes) return;
  if (!el.allTeams.checked) {
    el.minutes.innerHTML = teamBlock(TEAMS.find((t) => t.id === Number(el.team.value)));
    return;
  }
  el.minutes.innerHTML = `<div class="conferences">${CONFERENCES.map(([conf, divisions], c) => `<div class="conference"><h3>${conf} Conference</h3>
    ${divisions.map((div, d) => `<div class="plpd-mini"><h3 class="plpd-mini__title">${div}</h3></div>${TEAMS.slice((c * 3 + d) * 5, (c * 3 + d + 1) * 5).map(teamBlock).join("")}`).join("")}</div>`).join("")}</div>`;
}

el.team.innerHTML = TEAMS.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
el.team.value = String(DEFAULT_TEAM);
el.team.addEventListener("change", renderMinutes);
el.allTeams.addEventListener("change", () => { el.team.disabled = el.allTeams.checked; renderMinutes(); });

// ---- seasons -----------------------------------------------------------------------------

async function useSeason(entry, want = {}) {
  state.season = entry;
  el.seasonLabel.textContent = entry.season;
  el.through.textContent = entry.last_date ? ` - through ${shortDate(entry.last_date)}` : "";
  status(`Loading ${entry.season} shots…`);
  [el.season, el.player, el.game].forEach((c) => { c.disabled = true; });
  let data;
  try {
    data = await loadSeason(entry);
  } catch (e) {
    status(`Couldn't load ${entry.season}: ${e.message}`, "err");
    el.season.disabled = false;
    return;
  }
  if (state.season !== entry) return;   // another season was picked meanwhile
  state.data = data;
  const fallback = defaultPick(data);
  const wanted = data.players.find((p) => p.id === want.player && p.shots.length);
  state.player = wanted ? wanted.p : fallback.player;
  if (want.game === "season") { state.view = "season"; state.game = null; }
  else {
    const g = data.games.find((gm) => gm.id === want.game);
    state.view = "game";
    state.game = g && data.players[state.player].games.some((r) => r.g === g.g) ? g.g : (wanted ? null : fallback.game);
  }
  [el.season, el.player].forEach((c) => { c.disabled = false; });
  sliderBounds();
  renderChart();
  renderBoards();
  renderValueAdded();

  el.minutes.innerHTML = `<p class="plpd-status">Loading minutes…</p>`;
  state.minutes = null;
  try {
    const m = await loadMinutes(entry);
    if (state.season !== entry) return;
    state.minutes = m;
    renderMinutes();
  } catch (e) {
    el.minutes.innerHTML = `<p class="plpd-status err">Couldn't load minutes: ${esc(e.message)}</p>`;
  }
}

el.season.addEventListener("change", () => {
  const entry = state.manifest.seasons.find((s) => s.season === el.season.value);
  const pl = state.data?.players[state.player];
  useSeason(entry, { player: pl?.id });
});

async function start() {
  try {
    // a fresh query every ten minutes: the edge keeps a bare URL for hours
    const [manifest, grid] = await Promise.all([
      getJson(`nba/manifest.json?v=${Math.floor(Date.now() / 600000)}`),
      getJson("nba/xfg_grid.json?v=1"),
      document.fonts.load('700 33px "DM Sans"'), document.fonts.load('500 25px "DM Sans"'), document.fonts.load('400 17px "Work Sans"'),
    ]);
    if (!manifest.seasons?.length) throw new Error("no seasons yet");
    state.manifest = manifest;
    state.grid = grid;
  } catch (e) {
    status(`Couldn't load the NBA data: ${e.message}`, "err");
    return;
  }
  el.season.innerHTML = state.manifest.seasons.map((s) => `<option value="${s.season}">${s.season}</option>`).join("");
  const want = readHash();
  const entry = state.manifest.seasons.find((s) => s.season === want.season) || state.manifest.seasons[0];
  el.season.value = entry.season;
  useSeason(entry, want);
}

resized.observe(el.chartBox);
resized.observe(el.vaBox);
// a change of pixel ratio at the same CSS width (a window dragged to another screen, some zooms)
// redraws too; the query matches only the current ratio, so it re-arms after each change
(function watchRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener("change", () => {
    drawnAt.clear();
    if (state.data) { if (!el.chartBox.hidden) drawChart(); renderValueAdded(); }
    watchRatio();
  }, { once: true });
})();
start();
