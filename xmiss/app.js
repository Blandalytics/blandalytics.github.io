// xMiss page: a pitcher's miss ellipses for a level and season, as the whole mix or one pitch type.
// Data: the bucket's xmiss/index.json (levels, seasons, the file for each level-season, every
// pitcher's pitch counts), read at an hourly ?v=, and one xmiss/<built>/<level>/<season>.json per
// level-season, read at the key the index names (a build folder is never overwritten).
// tools/xmiss/build.py writes both. The URL hash holds the state: #<level>/<season>/<pitcher>/<view>,
// view "mix" or a pitch code (e.g. #mlb/2026/594798/SL); #2026/594798/SL means MLB.
(function () {
  "use strict";
  const BASE = "https://data.blandalytics.com/";
  const $ = (id) => document.getElementById(id);
  const pitcherQ = $("pitcherQ"), pitcherList = $("pitcherList"), seasonSel = $("season");
  const views = $("views"), status = $("status"), results = $("results"), fig = $("fig");
  const vals = $("vals"), mixTable = $("mix"), png = $("png");
  const P = window.XmissPlot;

  let index = null, levelSel = null;
  const fileCache = {};
  let state = { level: null, season: null, pitcher: null, view: "mix" };
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
  function seasonFile(level, season) {
    const entry = index.files[`${level}/${season}`];
    if (!entry) return Promise.reject(new Error(`no ${level}/${season}`));
    if (!(entry.key in fileCache)) fileCache[entry.key] = getJson(BASE + entry.key).catch((e) => { delete fileCache[entry.key]; throw e; });
    return fileCache[entry.key];
  }
  // the level-seasons a pitcher has, newest first, MLB before the rest within a season
  function hisSeasons(e) {
    const order = index.levels.map((l) => l.code);
    return Object.keys(e.n).map((k) => { const [level, s] = k.split("/"); return { level, season: +s, n: e.n[k] }; })
      .sort((a, b) => b.season - a.season || order.indexOf(a.level) - order.indexOf(b.level));
  }
  function bestFor(e, level, season) {
    const his = hisSeasons(e);
    return his.find((x) => x.level === level && x.season === season) || his.find((x) => x.level === level)
      || his.find((x) => x.level === "mlb") || his[0];
  }

  // ---- URL state --------------------------------------------------------------------------------
  function writeHash() {
    const h = `#${state.level}/${state.season}/${state.pitcher}/${state.view}`;
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }
  function readHash() {
    const parts = decodeURIComponent(location.hash.slice(1)).split("/").filter(Boolean);
    if (!parts.length) return null;
    if (/^\d{4}$/.test(parts[0])) parts.unshift("mlb");       // #2026/594798/FF
    const [level, season, pitcher, view] = parts;
    return { level, season: +season || null, pitcher: +pitcher || null, view: view || "mix" };
  }

  // ---- controls -----------------------------------------------------------------------------------
  function buildLevelSelect() {
    // a Level field beside Season, only when the data has more than one level
    if (index.levels.length < 2) return;
    const field = document.createElement("div");
    field.className = "plpd-filter-field";
    field.innerHTML = '<label class="plpd-filter-field__label" for="level">Level</label><select id="level" class="plpd-filter-dropdown"></select>';
    seasonSel.parentElement.before(field);
    levelSel = $("level");
    levelSel.addEventListener("change", () => {
      const e = byId[state.pitcher];
      const pick = bestFor(e, levelSel.value, state.season);
      go({ level: pick.level, season: pick.season, view: state.view });
    });
  }
  function fillSelects(e) {
    const his = hisSeasons(e);
    if (levelSel) {
      const levels = index.levels.filter((l) => his.some((x) => x.level === l.code));
      levelSel.innerHTML = levels.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join("");
      levelSel.value = state.level;
      levelSel.disabled = levels.length < 2;
    }
    const seasons = his.filter((x) => x.level === state.level).map((x) => x.season);
    seasonSel.innerHTML = seasons.map((s) => `<option value="${s}">${s}</option>`).join("");
    seasonSel.value = String(state.season);
    seasonSel.disabled = seasons.length < 2;
  }
  seasonSel.addEventListener("change", () => go({ season: +seasonSel.value }));

  function fillViews(p) {
    const items = [["mix", "Whole mix", null]].concat(Object.keys(p.pitches).map((pt) => [pt, P.pitchName(pt), P.color(pt)]));
    views.innerHTML = items.map(([v, label, col]) =>
      `<button type="button" class="plpd-chip" data-view="${v}" aria-pressed="${v === state.view}">`
      + (col ? `<i class="dot" style="background:${col}"></i>` : "") + `${esc(label)}</button>`).join("");
  }
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
    const note = `${thousands(e.n)} pitches` + (lg ? ` · league ${f2(lg.xmiss)}"` : "");
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
    const e = byId[state.pitcher];
    if (!e) { setStatus("No xMiss data for that pitcher."); return; }
    const pick = bestFor(e, state.level, state.season);   // a season he lacks -> his nearest one
    state.level = pick.level;
    state.season = pick.season;
    showPicked(e);
    fillSelects(e);
    const seq = ++drawSeq;
    seasonFile(state.level, state.season).then((doc) => {
      if (seq !== drawSeq) return;
      const p = doc.pitchers[String(state.pitcher)];
      if (!p) { setStatus(`No ${levelName(state.level)} ${state.season} pitches for ${e.name}.`); results.hidden = true; return; }
      if (state.view !== "mix" && !p.pitches[state.view]) state.view = "mix";
      writeHash();
      fillViews(p);
      fillVals(p, state.view, doc.league);
      fillTable(p, state.view);
      const lv = index.levels.find((l) => l.code === state.level);
      setStatus(lv && lv.provisional
        ? `${lv.name}: provisional. The model was trained on MLB catchers, zones and parks.` : "");
      results.hidden = false;
      png.disabled = false;
      shown = { p, season: state.season, view: state.view, league: doc.league, level: state.level };
      return P.draw(fig, { p, season: seasonLabel(), view: state.view, league: doc.league });
    }).catch((err) => {
      console.error(err);
      if (seq === drawSeq) setStatus("Couldn't load that season. Try again in a moment.");
    });
  }
  function seasonLabel() { return state.level === "mlb" ? String(state.season) : `${state.season} ${levelName(state.level)}`; }

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
    scored.sort((a, b) => a[0] - b[0] || b[1].total - a[1].total);
    return scored.map((x) => x[1]);
  }
  function showSuggestions() {
    suggested = suggestions(pitcherQ.value).slice(0, 400);
    active = -1;
    pitcherList.innerHTML = suggested.map((e, i) => {
      const on = e.id === state.pitcher ? ' aria-selected="true"' : "";
      const latest = hisSeasons(e)[0];
      return `<li role="option" data-index="${i}"${on}><span>${esc(e.name)}</span><small>`
        + `${esc((e.hand ? e.hand + "HP · " : "") + (latest.level === "mlb" ? "" : levelName(latest.level) + " ") + latest.season)}</small></li>`;
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
    sharedName = `${s.p.name.replace(/[^A-Za-z0-9]+/g, "_")}_xMiss_${s.level}_${s.season}_${s.view}.png`;
    const c = document.createElement("canvas");
    return P.draw(c, { p: s.p, season: seasonLabel(), view: s.view, league: s.league })
      .then((cv) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("no image"))), "image/png")));
  }, () => sharedName);

  // ---- start --------------------------------------------------------------------------------------------
  window.addEventListener("hashchange", () => {
    const h = readHash();
    if (h && index && (h.level !== state.level || h.season !== state.season || h.pitcher !== state.pitcher || h.view !== state.view)) {
      go({ level: h.level, season: h.season || state.season, pitcher: h.pitcher || state.pitcher, view: h.view });
    }
  });
  const hour = Math.floor(Date.now() / 3.6e6);
  getJson(`${BASE}xmiss/index.json?v=${hour}`).then((ix) => {
    index = ix;
    ix.pitchers.forEach((e) => {
      e.total = Object.values(e.n).reduce((a, b) => a + b, 0);
      byId[e.id] = e;
    });
    listed = ix.pitchers.slice();
    buildLevelSelect();
    pitcherQ.disabled = false;
    const h = readHash() || {};
    const d = ix.default;
    const pitcher = byId[h.pitcher] ? h.pitcher : d.pitcher;
    go({ level: h.level || d.level, season: h.season || d.season, pitcher, view: h.view || "mix" });
  }).catch((err) => {
    console.error(err);
    setStatus("Couldn't load the xMiss data. Try reloading the page.");
  });
})();
