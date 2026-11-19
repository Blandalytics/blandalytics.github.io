// xMiss page: a pitcher's miss ellipses for a level and season, as the whole mix or one pitch type.
// Data: the bucket's xmiss/index.json (levels, seasons, the file for each level-season, every
// pitcher's pitch counts), read at an hourly ?v=, and one xmiss/<built>/<level>/<season>.json per
// level-season, read at the key the index names (a build folder is never overwritten), and, only
// while "Show pitches" is on, one pitcher file of dots under the prefix the index names.
// tools/xmiss/build.py writes them all. The URL hash holds the state:
// #<level>/<season>/<pitcher>/<view>[/dots], view "mix" or a pitch code (e.g. #mlb/2026/594798/SL/dots);
// #2026/594798/SL means MLB.
(function () {
  "use strict";
  // ?data=<url> swaps the bucket for a local build, on localhost only (testing a build before it ships)
  const LOCAL_DATA = location.hostname === "localhost" && new URLSearchParams(location.search).get("data");
  const BASE = LOCAL_DATA || "https://data.blandalytics.com/";
  const $ = (id) => document.getElementById(id);
  const pitcherQ = $("pitcherQ"), pitcherList = $("pitcherList"), seasonSel = $("season"), levelSel = $("level");
  const views = $("views"), status = $("status"), results = $("results"), fig = $("fig");
  const vals = $("vals"), mixTable = $("mix"), png = $("png"), dotsBox = $("dots"), dotsField = $("dotsField");
  const P = window.XmissPlot;

  let index = null;
  const fileCache = {};
  let state = { level: null, season: null, pitcher: null, view: "mix", dots: false };
  let shown = null;          // {p, season, view, league, level} on the chart now
  let drawSeq = 0;

  // ---- helpers --------------------------------------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const f2 = (v) => (v == null ? "–" : v.toFixed(2));
  const pctText = (v) => (v == null ? "–" : String(v));
  const levelName = (code) => (index.levels.find((l) => l.code === code) || { name: code }).name;
  const byId = {};
  function getJson(url) {
    return fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); });
  }
  // one pitcher's dots for a level-season, or null where the build has none
  function dotsFile(level, season, pitcher) {
    const entry = index.files[`${level}/${season}`];
    if (!entry || !entry.dots) return Promise.resolve(null);
    const url = `${BASE}${entry.dots}${pitcher}.json`;
    if (!(url in fileCache)) fileCache[url] = getJson(url).catch((e) => { delete fileCache[url]; throw e; });
    return fileCache[url];
  }
  function seasonFile(level, season) {
    const entry = index.files[`${level}/${season}`];
    if (!entry) return Promise.reject(new Error(`no ${level}/${season}`));
    if (!(entry.key in fileCache)) fileCache[entry.key] = getJson(BASE + entry.key).catch((e) => { delete fileCache[entry.key]; throw e; });
    return fileCache[entry.key];
  }
  // as on pitcher-cards/season.html: pick a level, then one of its seasons, then a pitcher from
  // those who pitched at that level that season
  const lsKey = (level, season) => `${level}/${season}`;
  function levelSeasons(code) {
    const lv = index.levels.find((l) => l.code === code);
    return lv ? lv.seasons.slice().sort((a, b) => b - a) : [];
  }
  function pitchersIn(level, season) {            // most pitches first
    const k = lsKey(level, season);
    return index.pitchers.filter((e) => e.n[k]).sort((a, b) => b.n[k] - a.n[k]);
  }

  // ---- URL state --------------------------------------------------------------------------------
  function writeHash() {
    const h = `#${state.level}/${state.season}/${state.pitcher}/${state.view}` + (state.dots && state.view !== "mix" ? "/dots" : "");
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }
  function readHash() {
    const parts = decodeURIComponent(location.hash.slice(1)).split("/").filter(Boolean);
    if (!parts.length) return null;
    if (/^\d{4}$/.test(parts[0])) parts.unshift("mlb");       // #2026/594798/FF
    const [level, season, pitcher, view, extra] = parts;
    return { level, season: +season || null, pitcher: +pitcher || null, view: view || "mix", dots: extra === "dots" };
  }

  // ---- controls -----------------------------------------------------------------------------------
  // Level lists every level with data; Season, that level's seasons. Changing either keeps the
  // pitcher when he pitched there too (else the one with the most pitches), and another level
  // keeps the season when it has it (else its latest)
  function fillSelects() {
    levelSel.innerHTML = index.levels.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join("");
    levelSel.value = state.level;
    levelSel.disabled = index.levels.length < 2;
    const seasons = levelSeasons(state.level);
    seasonSel.innerHTML = seasons.map((s) => `<option value="${s}">${s}</option>`).join("");
    seasonSel.value = String(state.season);
    seasonSel.disabled = seasons.length < 2;
  }
  levelSel.addEventListener("change", () => go({ level: levelSel.value }));
  seasonSel.addEventListener("change", () => go({ season: +seasonSel.value }));

  function fillViews(p) {
    const items = [["mix", "Whole mix", null]].concat(Object.keys(p.pitches).map((pt) => [pt, P.pitchName(pt), P.color(pt)]));
    views.innerHTML = items.map(([v, label, col]) =>
      `<button type="button" class="plpd-chip" data-view="${v}" aria-pressed="${v === state.view}">`
      + (col ? `<i class="dot" style="background:${col}"></i>` : "") + `${esc(label)}</button>`).join("");
  }
  // "Show pitches": off by default, per-pitch-type views only; it stays on across pitch types
  dotsBox.addEventListener("change", () => go({ dots: dotsBox.checked }));
  views.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-view]");
    if (b) go({ view: b.getAttribute("data-view") });
  });

  // ---- the chart, its numbers and table ------------------------------------------------------------
  function tile(label, value, note) {
    return `<div class="val"><span>${esc(label)}</span><b>${value}</b>${note ? `<i>${esc(note)}</i>` : ""}</div>`;
  }
  function fillVals(p, view, league) {
    const e = view === "mix" ? p.all : p.pitches[view];
    const pctv = view === "mix" ? p.pct : e.pct;
    const lg = view === "mix" ? null : league[view];
    // four tiles in both views: a pitch's league average rides in its xMiss tile
    const note = `${thousands(e.n)} pitches` + (lg ? ` (lg: ${f2(lg.xmiss)}")` : "");   // the chart's wording
    const out = [
      tile("xMiss", `${f2(e.xmiss)}"`, note),
      tile("Percentile", pctText(pctv), pctv == null ? (view === "mix" ? "under 500 pitches" : "under 100 thrown") : "100 = best command"),
      tile("1-SD ellipse", `${e.major.toFixed(1)}" × ${e.minor.toFixed(1)}"`, "long × short"),
      tile("Tilt", `${Math.round(e.angle)}°`, "from the arm side"),
    ];
    vals.innerHTML = out.join("");
  }
  function fillTable(p, view) {
    const head = "<thead><tr><th>Pitch</th><th>Usage</th><th>Pitches</th><th>xMiss</th><th>Pctl</th><th>1 SD</th><th>Tilt</th></tr></thead>";
    const row = (v, name, e, usage, pctv, col) =>
      `<tr data-view="${v}" class="${v === view ? "on" : ""} ${v === "mix" ? "whole" : ""}" tabindex="0">`
      + `<td class="pitch">${col ? `<i class="dot" style="background:${col}"></i>` : ""}${esc(name)}</td>`
      + `<td>${usage}</td><td>${thousands(e.n)}</td><td>${f2(e.xmiss)}</td><td>${pctText(pctv)}</td>`
      + `<td>${e.major.toFixed(1)}" × ${e.minor.toFixed(1)}"</td><td>${Math.round(e.angle)}°</td></tr>`;
    const body = [row("mix", "Whole mix", p.all, "100%", p.pct, null)].concat(Object.entries(p.pitches).map(([pt, e]) =>
      row(pt, P.pitchName(pt), e, `${Math.round(e.usage * 100)}%`, e.pct, P.color(pt))));
    mixTable.innerHTML = head + "<tbody>" + body.join("") + "</tbody>";
  }
  mixTable.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-view]");
    if (tr) go({ view: tr.getAttribute("data-view") });
  });
  mixTable.addEventListener("keydown", (ev) => {
    const tr = ev.target.closest("tr[data-view]");
    if (tr && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); go({ view: tr.getAttribute("data-view") }); }
  });

  function setStatus(text) { status.textContent = text; status.hidden = !text; }

  // ---- state changes ---------------------------------------------------------------------------------
  // go(): merge a change into the state, settle it against what the pitcher has, then draw
  function go(change) {
    state = Object.assign({}, state, change);
    if (!index.levels.some((l) => l.code === state.level)) state.level = index.levels[0].code;
    const seasons = levelSeasons(state.level);
    if (seasons.indexOf(state.season) < 0) state.season = seasons[0];
    listed = pitchersIn(state.level, state.season);
    if (!listed.some((x) => x.id === state.pitcher)) state.pitcher = listed.length ? listed[0].id : null;
    const e = byId[state.pitcher];
    fillSelects();
    if (!e) { setStatus(`No ${levelName(state.level)} ${state.season} pitchers.`); results.hidden = true; return; }
    showPicked(e);
    const seq = ++drawSeq;
    seasonFile(state.level, state.season).then((doc) => {
      if (seq !== drawSeq) return;
      const p = doc.pitchers[String(state.pitcher)];
      if (!p) { setStatus(`No ${levelName(state.level)} ${state.season} pitches for ${e.name}.`); results.hidden = true; return; }
      if (state.view !== "mix" && !p.pitches[state.view]) state.view = "mix";
      const entry = index.files[`${state.level}/${state.season}`] || {};
      const canDots = state.view !== "mix" && !!entry.dots;
      dotsField.hidden = !canDots;
      dotsBox.checked = canDots && state.dots;
      writeHash();
      fillViews(p);
      fillVals(p, state.view, doc.league);
      fillTable(p, state.view);
      const lv = index.levels.find((l) => l.code === state.level);
      setStatus(lv && lv.provisional
        ? `${lv.name}: provisional. The model was trained on MLB catchers, zones and parks.` : "");
      results.hidden = false;
      png.disabled = false;
      showBoard(doc);
      const want = canDots && state.dots;
      return (want ? dotsFile(state.level, state.season, state.pitcher) : Promise.resolve(null)).catch((err) => {
        console.error(err);
        setStatus("Couldn't load this pitcher's pitches.");
        return null;
      }).then((dfile) => {
        if (seq !== drawSeq) return;
        const dots = want && dfile && dfile.pitches ? dfile.pitches[state.view] || null : null;
        shown = { p, season: state.season, view: state.view, league: doc.league, level: state.level, dots };
        return P.draw(fig, { p, season: seasonLabel(), view: state.view, league: doc.league, dots });
      });
    }).catch((err) => {
      console.error(err);
      if (seq === drawSeq) setStatus("Couldn't load that season. Try again in a moment.");
    });
  }
  function seasonLabel() { return state.level === "mlb" ? String(state.season) : `${state.season} ${levelName(state.level)}`; }

  // ---- the leaderboard: pitcher-cards/season.html's grades table for this level-season. Every
  // pitcher with the minimum pitches, sorted by his whole-mix xMiss (best first) with each pitch
  // type's beside it; each cell coloured by its percentile within its column against MLB that
  // season (the pools the percentiles use: pitchers with 500+ pitches, pitch types thrown 100+
  // times), on the pitcher card's scale (cyan worst, white average, red best). Pitch types thrown
  // under 100 times are shown muted, uncoloured. A row opens that pitcher above.
  const board = $("board"), boardTable = $("boardTable"), boardMin = $("boardMin"), boardSum = $("boardSum");
  const BOARD_MIN = { mlb: 500 };                  // other levels: 200
  const QUAL_P = 500, QUAL_PT = 100;
  const ORDER = ["FF", "SI", "FC", "SL", "ST", "SV", "CU", "KC", "CS", "CH", "FS", "FO", "SC", "KN", "EP"];
  const SCALE = ["#55e8ff", "#adf6ff", "#FFFFFF", "#f7b8b9", "#f4707c"];   // card.js SCALE, worst -> best
  let boardKey = null, boardDoc = null, pools = null, refSeason = null, sortBy = "mix", sortAsc = true, rowShown = null;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function scaleColor(pct) {                       // 0..100, 100 = best command
    const t = Math.max(0, Math.min(1, pct / 100)) * (SCALE.length - 1), k = Math.min(Math.floor(t), SCALE.length - 2);
    const a = hex(SCALE[k]), b = hex(SCALE[k + 1]), f = t - k;
    return "#" + a.map((x, i) => Math.round(x + (b[i] - x) * f).toString(16).padStart(2, "0")).join("");
  }
  function poolsOf(ref) {                          // each column's MLB pool, ascending
    const out = { mix: [] };
    Object.values(ref.pitchers).forEach((p) => {
      if (p.n >= QUAL_P) out.mix.push(p.xmiss);
      Object.entries(p.pitches).forEach(([pt, e]) => { if (e.n >= QUAL_PT) (out[pt] = out[pt] || []).push(e.xmiss); });
    });
    Object.values(out).forEach((a) => a.sort((x, y) => x - y));
    return out;
  }
  function pctIn(pool, v) {                        // build.py's: the share of the pool with a larger xMiss
    if (!pool || !pool.length) return null;
    let lo = 0, hi = pool.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pool[m] <= v) lo = m + 1; else hi = m; }
    return 100 * (1 - lo / pool.length);
  }
  const defaultMin = () => BOARD_MIN[state.level] || 200;
  function minPitches() {
    const v = parseInt(boardMin.value, 10);
    return isFinite(v) && v >= 0 ? v : defaultMin();
  }
  function showBoard(doc) {
    const key = lsKey(state.level, state.season);
    if (key === boardKey) { markBoardRow(); return; }
    const levelChanged = !boardKey || boardKey.split("/")[0] !== state.level;
    boardKey = key;
    boardDoc = doc;
    if (levelChanged) { boardMin.value = ""; boardMin.placeholder = String(defaultMin()); }
    const mlb = levelSeasons("mlb");
    refSeason = mlb.indexOf(state.season) >= 0 ? state.season : mlb[0];
    (state.level === "mlb" ? Promise.resolve(doc) : seasonFile("mlb", refSeason)).then((ref) => {
      if (boardKey !== key) return;
      pools = poolsOf(ref);
      drawBoard();
    }).catch((err) => { console.error(err); pools = {}; if (boardKey === key) drawBoard(); });
  }
  const lastName = (name) => name.split(" ").slice(-1)[0].toLowerCase();
  function sortKey(r, col) {                       // null sorts last either way
    if (col === "who") return lastName(r.p.name) + " " + r.p.name;
    if (col === "n") return r.p.n;
    if (col === "mix") return r.p.xmiss;
    const e = r.p.pitches[col];
    return e ? e.xmiss : null;
  }
  function cell(v, n, pool, qual, cls) {
    if (v == null) return `<td class="${cls}"></td>`;
    const thin = n < qual, pct = thin ? null : pctIn(pool, v);
    const title = `${thousands(n)} pitches` + (thin ? `, under ${qual}: not ranked`
      : pct == null ? "" : `; ${P.ordinal(Math.round(pct))} percentile among MLB ${refSeason}`);
    const style = pct == null ? "" : ` style="color:${scaleColor(pct)}"`;
    return `<td class="${cls} x${thin ? " thin" : ""}"${style} title="${esc(title)}">${v.toFixed(2)}</td>`;
  }
  function drawBoard() {
    if (!boardDoc || !pools) return;
    const min = minPitches();
    const rows = Object.entries(boardDoc.pitchers).map(([id, p]) => ({ id: +id, p })).filter((r) => r.p.n >= min);
    if (!rows.length) {
      boardTable.innerHTML = "";
      boardSum.textContent = `No ${levelName(state.level)} ${state.season} pitchers with ${thousands(min)}+ pitches.`;
      board.hidden = false;
      return;
    }
    const thrown = {};
    rows.forEach((r) => Object.entries(r.p.pitches).forEach(([pt, e]) => { thrown[pt] = (thrown[pt] || 0) + e.n; }));
    const rank = (c) => (ORDER.indexOf(c) < 0 ? ORDER.length : ORDER.indexOf(c));
    const codes = Object.keys(thrown).sort((a, b) => rank(a) - rank(b) || thrown[b] - thrown[a]);
    const list = rows.map((r, i) => ({ r, i, k: sortKey(r, sortBy) })).sort((a, b) => {
      if (a.k === null || b.k === null) return (a.k === null) - (b.k === null) || a.i - b.i;
      const c = typeof a.k === "string" ? a.k.localeCompare(b.k) : a.k - b.k;
      return (sortAsc ? c : -c) || a.i - b.i;
    }).map((x) => x.r);
    const head = (col, label, cls, title) => {
      const sort = sortBy === col ? (sortAsc ? "ascending" : "descending") : "none";
      return `<th scope="col" class="${cls || ""}" aria-sort="${sort}"${title ? ` title="${esc(title)}"` : ""}>`
        + `<button type="button" data-sort="${col}">${label}</button></th>`;
    };
    const thead = "<thead><tr>" + head("who", "Pitcher", "who") + head("n", "#", "", "Pitches")
      + head("mix", "Whole mix", "first", "Whole-mix xMiss, inches")
      + codes.map((c, i) => head(c, `<span style="color:${P.color(c)}">${esc(c)}</span>`, i ? "" : "first", `${P.pitchName(c)} xMiss, inches`)).join("")
      + "</tr></thead>";
    const body = list.map(({ id, p }) =>
      `<tr data-id="${id}"${id === state.pitcher ? ' class="on"' : ""}>`
      + `<td class="who"><a href="#${state.level}/${state.season}/${id}/mix" data-id="${id}">${esc(p.name)}</a>`
      + `<span class="meta">${esc(p.hand)}HP</span></td>`
      + `<td>${thousands(p.n)}</td>`
      + cell(p.xmiss, p.n, pools.mix, QUAL_P, "first")
      + codes.map((c, i) => { const e = p.pitches[c]; return e ? cell(e.xmiss, e.n, pools[c], QUAL_PT, i ? "" : "first") : `<td${i ? "" : ' class="first"'}></td>`; }).join("")
      + "</tr>").join("");
    const wrap = boardTable.parentNode, top = wrap.scrollTop, left = wrap.scrollLeft;
    boardTable.innerHTML = thead + "<tbody>" + body + "</tbody>";
    wrap.scrollTop = top; wrap.scrollLeft = left;
    boardSum.textContent = `${levelName(state.level)} ${state.season}: ${thousands(rows.length)} pitcher${rows.length === 1 ? "" : "s"} with `
      + `${thousands(min)}+ pitches. xMiss in inches, smaller is better. Colours rank each column against MLB ${refSeason}`
      + ` (pitchers with ${QUAL_P}+ pitches, pitch types thrown ${QUAL_PT}+ times): red is best, white average, blue worst.`;
    board.hidden = false;
    rowShown = null;
    markBoardRow();
  }
  // the pitcher on show: his row marked, and scrolled into the table's own box (never the page)
  function markBoardRow() {
    [].forEach.call(boardTable.querySelectorAll("tbody tr"), (tr) => tr.classList.toggle("on", +tr.getAttribute("data-id") === state.pitcher));
    const tr = boardTable.querySelector("tbody tr.on"), wrap = boardTable.parentNode;
    if (!tr || rowShown === state.pitcher) return;
    rowShown = state.pitcher;
    const headH = boardTable.tHead.offsetHeight, top = tr.offsetTop, bottom = top + tr.offsetHeight;
    if (top - headH < wrap.scrollTop) wrap.scrollTop = top - headH;
    else if (bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bottom - wrap.clientHeight;
  }
  boardTable.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-sort]");
    if (b) {
      const col = b.getAttribute("data-sort");
      if (sortBy === col) sortAsc = !sortAsc;
      else { sortBy = col; sortAsc = col !== "n"; }   // names A-Z, xMiss smallest first, pitches most first
      drawBoard();
      return;
    }
    // a plain click anywhere in a row opens that pitcher above; with a modifier the name's link
    // opens a new tab as usual, and a drag that selects text isn't a click
    const tr = ev.target.closest("tbody tr[data-id]");
    if (!tr || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (!ev.target.closest("a[data-id]") && String(window.getSelection && window.getSelection()).trim()) return;
    ev.preventDefault();
    go({ pitcher: +tr.getAttribute("data-id"), view: "mix" });
    const r = results.getBoundingClientRect();
    if (Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0) < r.height / 2) results.scrollIntoView({ behavior: "smooth" });
  });
  let minTimer = null;
  boardMin.addEventListener("input", () => { clearTimeout(minTimer); minTimer = setTimeout(drawBoard, 250); });

  // ---- the Pitcher box: season.html's name entry. Typing ranks full-name starts, then last-name
  // starts, then anything containing it or an MLBAM id starting with it, most pitches first
  // within each; arrows and Enter pick, Escape closes, and leaving it empty puts the pitcher on
  // stage back.
  let listed = [], suggested = [], active = -1, committed = false;
  function normalize(t) {
    return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  }
  function showPicked(e) {
    if (document.activeElement === pitcherQ && !committed) return;
    pitcherQ.value = e ? e.name : "";
    committed = true;
  }
  function suggestions(query) {
    const q = normalize(query);
    if (!q) return listed.slice();
    const scored = [];
    listed.forEach((e) => {
      const full = normalize(e.name), last = full.slice(full.lastIndexOf(" ") + 1);
      let score;
      if (full.indexOf(q) === 0) score = 0;
      else if (last.indexOf(q) === 0) score = 1;
      else if (full.indexOf(q) >= 0 || String(e.id).indexOf(q) === 0) score = 2;
      else return;
      scored.push([score, e]);
    });
    const k = lsKey(state.level, state.season);
    scored.sort((a, b) => a[0] - b[0] || b[1].n[k] - a[1].n[k]);
    return scored.map((x) => x[1]);
  }
  function showSuggestions() {
    suggested = suggestions(pitcherQ.value).slice(0, 400);
    active = -1;
    const k = lsKey(state.level, state.season);
    pitcherList.innerHTML = suggested.map((e, i) => {
      const on = e.id === state.pitcher ? ' aria-selected="true"' : "";
      return `<li role="option" data-index="${i}"${on}><span>${esc(e.name)}</span><small>`
        + `${esc((e.hand ? e.hand + "HP - " : "") + thousands(e.n[k]) + " pitches")}</small></li>`;
    }).join("");
    pitcherList.hidden = !suggested.length;
    pitcherQ.setAttribute("aria-expanded", suggested.length ? "true" : "false");
  }
  function hideSuggestions() {
    pitcherList.hidden = true;
    pitcherQ.setAttribute("aria-expanded", "false");
    suggested = []; active = -1;
  }
  function setActive(i) {
    active = i;
    [].forEach.call(pitcherList.children, (li, k) => li.classList.toggle("active", k === i));
    if (i >= 0) pitcherList.children[i].scrollIntoView({ block: "nearest" });
  }
  function startSearch() {
    if (committed) { pitcherQ.value = ""; committed = false; }
    showSuggestions();
  }
  function pickSuggested(e) {
    hideSuggestions();
    committed = true;
    pitcherQ.blur();
    go({ pitcher: e.id, view: "mix" });
  }
  pitcherQ.addEventListener("input", () => { committed = false; showSuggestions(); });
  pitcherQ.addEventListener("focus", startSearch);
  pitcherQ.addEventListener("click", () => { if (pitcherList.hidden) startSearch(); });
  pitcherQ.addEventListener("blur", () => {
    setTimeout(() => {
      hideSuggestions();
      if (!committed || !pitcherQ.value.trim()) { committed = false; showPicked(byId[state.pitcher]); }
    }, 150);
  });
  pitcherQ.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { hideSuggestions(); pitcherQ.blur(); return; }
    if (pitcherList.hidden) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); showSuggestions(); if (suggested.length) setActive(0); }
      return;
    }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setActive((active + 1) % suggested.length); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive((active - 1 + suggested.length) % suggested.length); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      if (active >= 0) pickSuggested(suggested[active]);
      else if (suggested.length === 1) pickSuggested(suggested[0]);
    }
  });
  pitcherList.addEventListener("pointerdown", (ev) => {
    const li = ev.target.closest("li");
    if (!li) return;
    ev.preventDefault();
    pickSuggested(suggested[+li.getAttribute("data-index")]);
  });
  pitcherList.addEventListener("pointermove", (ev) => {
    const li = ev.target.closest("li");
    if (li) setActive(+li.getAttribute("data-index"));
  });

  // ---- Share image (shared/share-image.js): the chart at 1600 x 1600 -----------------------------------
  let sharedName = "xMiss.png";
  ShareImage.image(png, () => {
    if (!shown) throw new Error("no chart");
    const s = shown;
    sharedName = `${s.p.name.replace(/[^A-Za-z0-9]+/g, "_")}_xMiss_${s.level}_${s.season}_${s.view}${s.dots ? "_pitches" : ""}.png`;
    const c = document.createElement("canvas");
    return P.draw(c, { p: s.p, season: seasonLabel(), view: s.view, league: s.league, dots: s.dots })
      .then((cv) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("no image"))), "image/png")));
  }, () => sharedName);

  // ---- start --------------------------------------------------------------------------------------------
  window.addEventListener("hashchange", () => {
    const h = readHash();
    if (h && index && (h.level !== state.level || h.season !== state.season || h.pitcher !== state.pitcher
        || h.view !== state.view || h.dots !== (state.dots && state.view !== "mix"))) {
      go({ level: h.level, season: h.season || state.season, pitcher: h.pitcher || state.pitcher, view: h.view, dots: h.dots });
    }
  });
  const hour = Math.floor(Date.now() / 3.6e6);
  getJson(`${BASE}xmiss/index.json?v=${hour}`).then((ix) => {
    index = ix;
    ix.pitchers.forEach((e) => { byId[e.id] = e; });
    pitcherQ.disabled = false;
    const h = readHash() || {};
    const d = ix.default;
    // a link names its level, season and pitcher; with none, the default (deGrom, MLB 2026)
    go({ level: h.level || d.level, season: h.season || d.season, pitcher: h.pitcher || d.pitcher,
         view: h.view || "mix", dots: !!h.dots });
  }).catch((err) => {
    console.error(err);
    setStatus("Couldn't load the xMiss data. Try reloading the page.");
  });
})();
