// Player Rater: auction values for what players did, for any season since 2015, any date range and
// the viewer's league settings. Data: data.blandalytics.com/player-rater/<season>.json (daily lines),
// valued by engine.js; trend-worker.js values every date of the season for the chart.
(function () {
  "use strict";
  const E = window.RaterEngine;
  const DATA = "https://data.blandalytics.com/player-rater/";
  const TREND_START = 6; // the first week is too thin to value
  const MAX_SERIES = 4;
  const COLORS = ["var(--brand-brand-cyan)", "var(--pitch-four-seamer)", "var(--pitch-slider)", "var(--pitch-curveball)"];
  const GAP_DAYS = 30; // a longer break between games (or before the season's end) fades the line
  const QUIET_OPACITY = 0.25; // the faded stretch: 75% transparent
  const BAND_OPACITY = 0.16; // a 95% interval's shading, in its line's colour
  const PAGE = 25;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const HIT_CATS = ["R", "HR", "RBI", "SB", "AVG", "OBP", "SLG", "OPS", "H", "TB", "BBh", "SOh", "NSB"];
  const PIT_CATS = ["W", "SV", "K", "ERA", "WHIP", "L", "NSV", "HLD", "SVH", "QS", "IP", "K9"];
  const SLOTS = [["C", 3], ["1B", 3], ["2B", 3], ["3B", 3], ["SS", 3], ["OF", 9], ["CI", 4], ["MI", 4], ["Util", 6], ["SP", 9], ["RP", 9], ["P", 12], ["BN", 15]];
  const HPOS = ["C", "1B", "2B", "3B", "SS", "OF", "Util"];
  const PPOS = ["SP", "RP"];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const NB = " ";

  // ---------- formatting ----------
  const money = (v) => (v < 0 ? "−$" + Math.abs(v).toFixed(0) : "$" + v.toFixed(0));
  const money1 = (v) => (v < 0 ? "−$" + Math.abs(v).toFixed(1) : "$" + v.toFixed(1));
  const signed = (v, d) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
  const rate = (v, dec) => (isFinite(v) ? (dec === 3 ? v.toFixed(3).replace(/^(-?)0(?=\.)/, "$1") : v.toFixed(dec)) : "—");
  const ipStr = (outs) => Math.floor(outs / 3) + "." + (outs % 3);
  function rawStat(cat, s) {
    const d = E.CATS[cat];
    if (d.kind === "count") return d.f(s);
    if (d.kind === "rate") { const den = d.den(s); return den > 0 ? d.num(s) / den : NaN; }
    return d.parts.reduce((a, p) => a + rawStat(p, s), 0);
  }
  function fmtStat(cat, v) {
    if (cat === "IP") return ipStr(Math.round(v * 3));
    const d = E.CATS[cat];
    return d.kind === "count" ? String(Math.round(v)) : rate(v, d.dec);
  }

  // ---------- storage (per-viewer convenience only) ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* unavailable */ } },
  };
  function loadSettings() {
    const s = Object.assign(clone(E.YAHOO_DEFAULT), store.get("player-rater.settings") || {});
    s.slots = Object.assign(clone(E.YAHOO_DEFAULT.slots), s.slots || {});
    s.hitCats = (s.hitCats || []).filter((c) => HIT_CATS.includes(c));
    s.pitCats = (s.pitCats || []).filter((c) => PIT_CATS.includes(c));
    return validate(s) ? clone(E.YAHOO_DEFAULT) : s;
  }
  function validate(s) {
    if (!s.hitCats.length || !s.pitCats.length) return "Pick at least one hitting and one pitching category.";
    const hs = ["C", "1B", "2B", "3B", "SS", "OF", "CI", "MI", "Util"].reduce((a, k) => a + s.slots[k], 0);
    const ps = ["SP", "RP", "P"].reduce((a, k) => a + s.slots[k], 0);
    if (!hs || !ps) return "Add at least one hitter spot and one pitcher spot.";
    return null;
  }

  // ---------- state ----------
  let settings = loadSettings();
  const state = {
    seasons: [], season: null, raw: null, db: null, start: 0, N: 0,
    segs: [], halves: null, presets: [],
    a: 0, b: 0, preset: "season",
    group: "h", pos: "All", q: "", mode: "stats", sort: { key: "dollars", dir: -1 }, page: 0,
    chart: [], result: null, rows: [],
  };
  let trend = null; // { keys: Map(key -> index), vals: Float32Array (index * N + day), done, upto, seg: [Float32Array] }
  let worker = null;
  // 95% intervals: bootstraps of the season to date, every CI.step days and at the season's last day; the band
  // between those dates is interpolated as an offset from the line, so it follows the line's shape. At the
  // default settings they come precomputed from R2 (tools/player_rater/bootstrap_ci.js, the same engine and
  // seeds); `method` names the engine's numbers, and a file with another method or season build is not used.
  const CI = { reps: 1000, first: 13, step: 14, maxWorkers: 6, method: "retro-mode-r-1" };
  let ci = null; // { days: [day], got: Map(day -> { lo, hi } by trend index), done, failed, workers }

  // ---------- dates ----------
  const dayOfUTC = (ms) => Math.round((ms - state.start) / 864e5);
  const dayOf = (iso) => { const [y, m, d] = iso.split("-").map(Number); return dayOfUTC(Date.UTC(y, m - 1, d)); };
  const isoOf = (day) => new Date(state.start + day * 864e5).toISOString().slice(0, 10);
  const dateOf = (day) => new Date(state.start + day * 864e5);
  const fmtDay = (day) => { const d = dateOf(day); return MON[d.getUTCMonth()] + NB + d.getUTCDate(); };

  // months of the season, a short first or last month folded into its neighbour (Mar into Apr, Oct into Sep)
  function monthSegs() {
    const out = [];
    for (let d = 0; d < state.N;) {
      const t = dateOf(d), m = t.getUTCMonth(), y = t.getUTCFullYear();
      const b = Math.min(state.N - 1, dayOfUTC(Date.UTC(y, m + 1, 1)) - 1);
      out.push({ m, months: [m], a: d, b, first: dayOfUTC(Date.UTC(y, m, 1)) });
      d = b + 1;
    }
    if (out.length > 1 && out[0].b - out[0].a < 14) { const f = out.shift(); out[0].a = f.a; out[0].months.unshift(f.m); }
    if (out.length > 1 && out[out.length - 1].b - out[out.length - 1].a < 14) { const l = out.pop(); out[out.length - 1].b = l.b; out[out.length - 1].months.push(l.m); }
    return out.map((s) => ({ ...s, label: s.months.map((m) => MONTH[m]).join(" / "), short: MON[s.m].toUpperCase(), tick: Math.max(0, s.first), mid: (s.a + s.b) / 2 }));
  }
  // the 1st of each month within the season
  function monthFirsts() {
    const out = [], t = dateOf(0);
    for (let y = t.getUTCFullYear(), m = t.getUTCMonth(); ; m++) {
      const d = dayOfUTC(Date.UTC(y, m, 1));
      if (d > state.N - 1) return out;
      if (d >= 0) out.push(d);
    }
  }

  // ---------- loading ----------
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status + " " + url);
    return r.json();
  }
  async function boot() {
    try {
      const idx = await getJSON(DATA + "index.json?v=" + Math.floor(Date.now() / 36e5));
      state.seasons = idx.seasons;
    } catch (e) {
      $("meta").textContent = "The season list did not load. Reload the page to try again.";
      return;
    }
    const h = parseHash();
    const latest = state.seasons[state.seasons.length - 1].season;
    renderSeasonSwitch();
    await loadSeason(state.seasons.some((s) => s.season === h.season) ? h.season : latest, h);
  }
  async function loadSeason(season, h) {
    const info = state.seasons.find((s) => s.season === season);
    state.season = season;
    renderSeasonSwitch();
    $("meta").textContent = `Loading ${season}`;
    let raw;
    try { raw = await getJSON(`${DATA}${season}.json?v=${encodeURIComponent(info.built)}`); }
    catch (e) { $("meta").textContent = `The ${season} data did not load. Reload the page to try again.`; return; }
    if (state.season !== season) return; // another season was picked meanwhile
    state.raw = raw;
    state.db = E.prepare(raw);
    state.N = raw.ndays;
    state.start = Date.parse(raw.start + "T00:00:00Z");
    state.segs = monthSegs();
    state.firsts = monthFirsts();
    const h1 = raw.half1End && dayOf(raw.half1End), h2 = raw.half2Start && dayOf(raw.half2Start);
    // halves split at the All-Star break (2020 had none: its API "halves" are back to back)
    state.halves = h1 > TREND_START && h2 > h1 + 1 && h2 < state.N - 1 ? { h1, h2 } : null;
    buildPresets();
    $("meta").textContent = `${season} regular season, ${fmtDay(0)} – ${fmtDay(state.N - 1)}`;
    for (const id of ["d-start", "d-end"]) { $(id).min = isoOf(0); $(id).max = isoOf(state.N - 1); }
    const p = h && state.presets.find((x) => x.key === h.p);
    if (h && h.from && h.to) setRange(dayOf(h.from), dayOf(h.to), null, true);
    else if (p) setRange(p.a, p.b, p.key, true);
    else setRange(0, state.N - 1, "season", true);
    // keep the charted players that played this season; else chart the season's top hitter
    const want = (h && h.c) || state.chart;
    const have = new Set(state.db.players.map((x) => x.key));
    state.chart = want.filter((k) => have.has(k)).slice(0, MAX_SERIES);
    if (!state.chart.length) {
      const top = E.valuate(state.db, settings, 0, state.N - 1).h.rows.sort((x, y) => y.dollars - x.dollars)[0];
      if (top) state.chart = [top.key];
    }
    recompute();
    startTrend();
  }

  // ---------- URL hash: #2026&p=m6&c=660271h,694819p (or &from=2026-06-01&to=2026-06-30) ----------
  function parseHash() {
    const out = {};
    for (const part of location.hash.replace(/^#/, "").split("&")) {
      if (/^\d{4}$/.test(part)) out.season = Number(part);
      const [k, v] = part.split("=");
      if (k === "p") out.p = v;
      if (k === "c" && v) out.c = v.split(",").filter((x) => /^\d+[hp]$/.test(x));
      if ((k === "from" || k === "to") && /^\d{4}-\d\d-\d\d$/.test(v || "")) out[k] = v;
    }
    return out;
  }
  function writeHash() {
    let h = "#" + state.season;
    if (state.preset === "custom") h += `&from=${isoOf(state.a)}&to=${isoOf(state.b)}`;
    else if (state.preset !== "season") h += "&p=" + state.preset;
    if (state.chart.length) h += "&c=" + state.chart.join(",");
    if (h !== location.hash) history.replaceState(null, "", h);
  }

  // ---------- season switch ----------
  function renderSeasonSwitch() {
    const box = $("seasons"), sel = $("season");
    if (!box.children.length) {
      for (const s of state.seasons) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "plpd-chip"; b.textContent = s.season; b.dataset.season = s.season;
        b.addEventListener("click", () => { if (s.season !== state.season) loadSeason(s.season); });
        box.appendChild(b);
        sel.add(new Option(String(s.season), String(s.season)));
      }
    }
    for (const b of box.children) b.setAttribute("aria-pressed", String(Number(b.dataset.season) === state.season));
    if (state.season) sel.value = String(state.season);
  }
  $("season").addEventListener("change", (e) => loadSeason(Number(e.target.value)));

  // ---------- period ----------
  function buildPresets() {
    const N = state.N, P = [{ key: "season", label: "Full season", a: 0, b: N - 1 }];
    state.segs.forEach((s, i) => P.push({ key: "m" + i, label: s.label, a: s.a, b: s.b }));
    if (state.halves) {
      P.push({ key: "h1", label: `First half (to ${fmtDay(state.halves.h1)})`, a: 0, b: state.halves.h1 });
      P.push({ key: "h2", label: `Second half (from ${fmtDay(state.halves.h2)})`, a: state.halves.h2, b: N - 1 });
    }
    for (const n of [30, 14, 7]) if (N > n) P.push({ key: "l" + n, label: `Final ${n} days`, a: N - n, b: N - 1 });
    P.push({ key: "custom", label: "Custom range", a: 0, b: N - 1 });
    state.presets = P;
    $("preset").replaceChildren(...P.map((p) => new Option(p.label, p.key)));
  }
  function setRange(a, b, key, quiet) {
    a = Math.max(0, Math.min(state.N - 1, a)); b = Math.max(0, Math.min(state.N - 1, b));
    if (b < a) [a, b] = [b, a];
    if (!key) { const m = state.presets.find((p) => p.key !== "custom" && p.a === a && p.b === b); key = m ? m.key : "custom"; }
    state.a = a; state.b = b; state.preset = key;
    $("d-start").value = isoOf(a); $("d-end").value = isoOf(b); $("preset").value = key;
    if (!quiet) recompute();
  }
  $("preset").addEventListener("change", (e) => {
    const p = state.presets.find((x) => x.key === e.target.value);
    if (p && p.key !== "custom") setRange(p.a, p.b, p.key);
  });
  for (const id of ["d-start", "d-end"]) $(id).addEventListener("change", () => {
    if ($("d-start").value && $("d-end").value) setRange(dayOf($("d-start").value), dayOf($("d-end").value), null);
  });

  // ---------- league settings ----------
  const catChip = (c, g) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "plpd-chip"; b.textContent = E.CATS[c].label; b.dataset.cat = c; b.dataset.g = g;
    b.addEventListener("click", () => b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")));
    return b;
  };
  $("cats-h").append(...HIT_CATS.map((c) => catChip(c, "h")));
  $("cats-p").append(...PIT_CATS.map((c) => catChip(c, "p")));
  const form = { slots: {} };
  for (const [k, max] of SLOTS) {
    const id = "slot-" + k, aria = k === "BN" ? "Bench spots" : k + " spots";
    const w = document.createElement("div");
    w.className = "stepper";
    w.innerHTML = `<label for="${id}">${k}</label><div class="ctl">` +
      `<button type="button" data-step="-1" aria-label="Fewer ${aria}"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>` +
      `<output id="${id}" aria-label="${aria}"></output>` +
      `<button type="button" data-step="1" aria-label="More ${aria}"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8M5 1v8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`;
    const out = w.querySelector("output"), [minus, plus] = w.querySelectorAll("button");
    const set = (v) => { v = Math.max(0, Math.min(max, v)); form.slots[k] = v; out.textContent = v; minus.disabled = v <= 0; plus.disabled = v >= max; benchNote(); };
    minus.addEventListener("click", () => set(form.slots[k] - 1));
    plus.addEventListener("click", () => set(form.slots[k] + 1));
    form.slots[k] = 0; form[k] = set;
    $("slots").appendChild(w);
  }
  function benchNote() {
    const bn = form.slots.BN || 0, bh = Math.round(bn * E.YAHOO_DEFAULT.benchHitterShare);
    $("settings-msg").className = "";
    $("settings-msg").textContent = bn ? `${bn} bench spot${bn === 1 ? "" : "s"}: ${bh} hitter${bh === 1 ? "" : "s"}, ${bn - bh} pitcher${bn - bh === 1 ? "" : "s"}` : "No bench spots";
  }
  function fillForm() {
    $("s-teams").value = settings.teams; $("s-budget").value = settings.budget;
    $("s-hshare").value = Math.round(settings.hitterShare * 100); $("s-minbid").value = settings.minBid;
    for (const [k] of SLOTS) form[k](k === "BN" ? settings.bench : settings.slots[k] || 0);
    document.querySelectorAll("[data-cat]").forEach((b) => b.setAttribute("aria-pressed",
      String((b.dataset.g === "h" ? settings.hitCats : settings.pitCats).includes(b.dataset.cat))));
  }
  function readForm() {
    const n = (id, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number($(id).value) || 0)));
    const s = clone(settings);
    s.teams = n("s-teams", 4, 20); s.budget = n("s-budget", 50, 1000);
    s.hitterShare = n("s-hshare", 10, 90) / 100; s.minBid = n("s-minbid", 0, 5);
    for (const [k] of SLOTS) if (k !== "BN") s.slots[k] = form.slots[k];
    s.bench = form.slots.BN; s.benchHitterShare = E.YAHOO_DEFAULT.benchHitterShare;
    const on = (g) => [...document.querySelectorAll(`[data-g="${g}"][aria-pressed="true"]`)].map((b) => b.dataset.cat);
    s.hitCats = on("h"); s.pitCats = on("p");
    return s;
  }
  $("toggle-settings").addEventListener("click", () => {
    const el = $("settings"), open = el.hidden;
    el.hidden = !open; $("toggle-settings").setAttribute("aria-expanded", String(open));
    if (open) fillForm();
  });
  $("apply-settings").addEventListener("click", () => {
    const s = readForm(), err = validate(s);
    if (err) { $("settings-msg").textContent = err; $("settings-msg").className = "err"; return; }
    const isDefault = JSON.stringify(s) === JSON.stringify(E.YAHOO_DEFAULT);
    settings = s; store.set("player-rater.settings", isDefault ? null : s);
    $("settings-msg").className = ""; $("settings-msg").textContent = "Settings applied";
    onSettingsChanged();
  });
  $("reset-settings").addEventListener("click", () => {
    settings = clone(E.YAHOO_DEFAULT); store.set("player-rater.settings", null);
    fillForm(); $("settings-msg").textContent = "Yahoo default restored";
    onSettingsChanged();
  });
  function renderLeague() {
    const nh = settings.hitCats.length, np = settings.pitCats.length;
    $("league-line").textContent = `${settings.teams} teams, $${settings.budget}, ${nh}×${np}`;
    $("league-cats").textContent = settings.hitCats.map((c) => E.CATS[c].label).join(",") + " / " + settings.pitCats.map((c) => E.CATS[c].label).join(",");
  }
  function onSettingsChanged() { renderLeague(); recompute(); startTrend(); }

  // ---------- valuation ----------
  function recompute() {
    if (!state.db) return;
    state.result = E.valuate(state.db, settings, state.a, state.b);
    state.page = 0;
    for (const g of ["h", "p"]) state.result[g].rows.sort((x, y) => y.dollars - x.dollars).forEach((r, i) => { r.rank = i + 1; });
    renderLeague(); renderPrices(); renderChips(); renderTable(); renderChart(); writeHash();
  }

  // ---------- what a standings point costs ----------
  function renderPrices() {
    const box = $("prices"); box.replaceChildren();
    for (const g of ["h", "p"]) {
      const pr = state.result[g];
      const cats = g === "h" ? settings.hitCats : settings.pitCats;
      const card = document.createElement("div"); card.className = "card price";
      const den = cats.map((c) => {
        const D = pr.D[c], kind = E.CATS[c].kind;
        let t = !isFinite(D) ? "—" : kind === "count" ? D.toFixed(1) : D.toFixed(D < 0.01 ? 4 : 3).replace(/^0(?=\.)/, "");
        return `<div><dt>${esc(E.CATS[c].label)}</dt><dd>${esc(t)}</dd></div>`;
      }).join("");
      card.innerHTML = `<h3>${g === "h" ? "Hitters" : "Pitchers"}<span>$${pr.perSgp.toFixed(2)} per point</span></h3><dl>${den}</dl>`;
      box.appendChild(card);
    }
  }

  // ---------- table ----------
  const POS = { h: ["All", ...HPOS], p: ["All", ...PPOS], all: ["All"] };
  function renderChips() {
    const box = $("pos-chips"); box.replaceChildren();
    for (const p of POS[state.group]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "plpd-chip plpd-chip--amber"; b.textContent = p;
      b.setAttribute("aria-pressed", String(state.pos === p));
      b.addEventListener("click", () => { state.pos = p; state.page = 0; renderChips(); renderTable(); });
      box.appendChild(b);
    }
  }
  document.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
    state.group = b.dataset.group; state.pos = "All"; state.page = 0;
    if (!["dollars", "sgp", "rank", "vol", "name", "slot"].includes(state.sort.key)) state.sort = { key: "dollars", dir: -1 };
    document.querySelectorAll("[data-group]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    renderChips(); renderTable();
  }));
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderTable();
  }));
  $("search").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); state.page = 0; renderTable(); });
  $("prev").addEventListener("click", () => { state.page--; renderTable(); });
  $("next").addEventListener("click", () => { state.page++; renderTable(); });

  const posList = (r) => (r.g === "h" ? (r.elig.length ? r.elig.join(", ") : "Util") : r.elig.join(", "));
  function columns() {
    const g = state.group;
    const cols = [
      { key: "rank", label: "#", cls: "pin pin0 rk", get: (r) => r.dr, fmt: (r) => r.dr, csv: (r) => r.dr },
      { key: "name", label: "Player", cls: "pin pin1 l player", get: (r) => r.name, fmt: (r) => `<b>${esc(r.name)}</b><span>${esc((r.team || "—") + " | " + posList(r))}</span>` },
      { key: "dollars", label: "$", cls: "usd", get: (r) => r.dollars, fmt: (r) => money1(r.dollars), csv: (r) => r.dollars.toFixed(1) },
      { key: "slot", label: "Slot", cls: "c", get: (r) => r.slot || "~", fmt: (r) => r.slot || "—", csv: (r) => r.slot || "" },
      { key: "sgp", label: "SGP", get: (r) => r.sgpar, fmt: (r) => signed(r.sgpar, 1), csv: (r) => r.sgpar.toFixed(2) },
    ];
    if (g === "h") cols.push({ key: "vol", label: "PA", cls: "div", get: (r) => r.s[E.HI.PA], fmt: (r) => r.s[E.HI.PA] });
    else if (g === "p") cols.push({ key: "vol", label: "IP", cls: "div", get: (r) => r.s[E.PI.OUTS], fmt: (r) => ipStr(r.s[E.PI.OUTS]) });
    else cols.push({ key: "vol", label: "PA / IP", cls: "div", get: (r) => (r.g === "h" ? r.s[E.HI.PA] : r.s[E.PI.OUTS] / 3), fmt: (r) => (r.g === "h" ? r.s[E.HI.PA] + " PA" : ipStr(r.s[E.PI.OUTS]) + " IP") });
    if (g !== "all") {
      for (const c of g === "h" ? settings.hitCats : settings.pitCats) {
        if (state.mode === "stats") cols.push({ key: "c_" + c, label: E.CATS[c].label, get: (r) => { const v = rawStat(c, r.s); return isFinite(v) ? v : -Infinity; }, fmt: (r) => fmtStat(c, rawStat(c, r.s)) });
        else cols.push({ key: "c_" + c, label: E.CATS[c].label, get: (r) => r.sgpCat[c], fmt: (r) => signed(r.sgpCat[c], 2) });
      }
    }
    return cols;
  }
  function tableRows() {
    let rows = state.group === "all" ? [...state.result.h.rows, ...state.result.p.rows] : [...state.result[state.group].rows];
    // the rank shown: within hitters or pitchers, or across both under All
    if (state.group === "all") rows.sort((x, y) => y.dollars - x.dollars).forEach((r, i) => { r.dr = i + 1; });
    else rows.forEach((r) => { r.dr = r.rank; });
    if (state.pos !== "All") rows = rows.filter((r) => (state.pos === "Util" ? r.g === "h" && !r.elig.length : r.elig.includes(state.pos)));
    if (state.q) rows = rows.filter((r) => r.name.toLowerCase().includes(state.q) || (r.team || "").toLowerCase() === state.q);
    return rows;
  }
  function renderTable() {
    if (!state.result) return;
    const cols = columns();
    const rows = tableRows();
    const sc = cols.find((c) => c.key === state.sort.key) || cols[2];
    rows.sort((x, y) => { const a = sc.get(x), b = sc.get(y); return (a < b ? -1 : a > b ? 1 : 0) * state.sort.dir || x.dr - y.dr; });
    state.rows = rows; state.cols = cols;
    const tr = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c.label; th.className = c.cls ? c.cls.replace(/\b(rk|player|usd)\b/g, "") : "";
      th.scope = "col"; th.tabIndex = 0;
      if (c.key === sc.key) th.setAttribute("aria-sort", state.sort.dir < 0 ? "descending" : "ascending");
      const go = () => {
        const asc = ["name", "rank", "slot"].includes(c.key);
        state.sort = { key: c.key, dir: c.key === state.sort.key ? -state.sort.dir : asc ? 1 : -1 };
        state.page = 0; renderTable();
      };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      tr.appendChild(th);
    }
    $("thead").replaceChildren(tr);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.max(0, Math.min(pages - 1, state.page));
    const slice = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
    const html = [];
    for (const r of slice) {
      const on = state.chart.includes(r.key);
      html.push(`<tr data-key="${esc(r.key)}"${on ? ' class="on"' : ""} tabindex="0" aria-label="${esc(r.name)}, ${on ? "charted; press to remove from" : "press to add to"} the chart">`);
      for (const c of cols) {
        const v = c.fmt(r);
        const zero = c.key === "slot" && !r.slot;
        html.push(`<td class="${(c.cls || "") + (zero ? " zero" : "")}">${c.key === "name" ? v : esc(v)}</td>`);
      }
      html.push("</tr>");
    }
    $("tbody").innerHTML = html.join("");
    const from = rows.length ? state.page * PAGE + 1 : 0, to = state.page * PAGE + slice.length;
    $("pager-sum").innerHTML = rows.length ? `Showing <b>${from}–${to}</b> of <b>${rows.length}</b>` : "No players match";
    $("prev").disabled = state.page <= 0; $("next").disabled = state.page >= pages - 1;
  }
  function toggleChart(key) {
    const i = state.chart.indexOf(key);
    if (i >= 0) state.chart.splice(i, 1);
    else { if (state.chart.length >= MAX_SERIES) state.chart.shift(); state.chart.push(key); }
    renderTable(); renderChart(); writeHash();
  }
  $("tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-key]"); if (tr) toggleChart(tr.dataset.key); });
  $("tbody").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-key]"); if (!tr) return;
    e.preventDefault(); const k = tr.dataset.key; toggleChart(k);
    const again = $("tbody").querySelector(`tr[data-key="${CSS.escape(k)}"]`); if (again) again.focus();
  });
  $("export").addEventListener("click", () => {
    const cols = state.cols.filter((c) => c.key !== "name");
    const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    const head = ["Rank", "Player", "Team", "Positions", ...cols.slice(1).map((c) => c.label)];
    const lines = [head.map(q).join(",")];
    for (const r of state.rows) lines.push([r.dr, r.name, r.team || "", posList(r), ...cols.slice(1).map((c) => (c.csv ? c.csv(r) : c.fmt(r)))].map((v) => q(String(v).replace("−", "-"))).join(","));
    const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv" });
    const a = document.createElement("a");
    const group = { h: "hitters", p: "pitchers", all: "all" }[state.group];
    a.href = URL.createObjectURL(blob); a.download = `player-rater-${state.season}-${group}-${isoOf(state.a)}-to-${isoOf(state.b)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- trend: the season to date at every date, in a worker ----------
  function startTrend() {
    if (worker) worker.terminate();
    stopCI();
    trend = null;
    const segs = state.segs.map((s) => [s.a, s.b]);
    if (state.halves) segs.push([0, state.halves.h1], [state.halves.h2, state.N - 1]);
    const mine = new Worker("trend-worker.js?v=7");
    worker = mine;
    mine.onmessage = (e) => {
      if (worker !== mine) return;
      const m = e.data;
      if (m.type === "segs") {
        trend = { keys: new Map(m.keys.map((k, i) => [k, i])), seg: m.seg, vals: null, upto: TREND_START - 1, done: false };
      } else if (m.type === "partial") {
        trend.vals = m.trend; trend.upto = m.done;
      } else if (m.type === "done") {
        trend.vals = m.trend; trend.upto = state.N - 1; trend.done = true; worker = null; mine.terminate();
        startCI();
      }
      renderChart();
    };
    mine.onerror = () => { $("chart-status").textContent = "The chart could not be computed in this browser."; };
    mine.postMessage({ raw: state.raw, settings, from: TREND_START, segs });
    renderChart();
  }

  // ---------- 95% intervals: precomputed at the defaults, else a few workers taking the next date in turn ----------
  function stopCI() {
    if (ci) for (const w of ci.workers) w.terminate();
    ci = null;
  }
  // the same settings, whatever order their keys were saved in
  const canon = (o) => (Array.isArray(o) ? "[" + o.map(canon).join() + "]" : o && typeof o === "object"
    ? "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join() + "}" : JSON.stringify(o));
  async function startCI() {
    stopCI();
    const last = state.N - 1, days = [last];
    for (let d = CI.first; d < last; d += CI.step) days.push(d);
    days.sort((a, b) => (a === last ? -1 : b === last ? 1 : b - a)); // the season total first, then back from the end
    const mine = { days, got: new Map(), done: false, failed: false, workers: [] };
    ci = mine;
    if (canon(settings) === canon(E.YAHOO_DEFAULT)) {
      try {
        const f = await getJSON(`${DATA}ci/${state.season}.json?v=${encodeURIComponent(state.raw.built + "-" + CI.method)}`);
        if (ci !== mine) return;
        if (f.method === CI.method && f.built === state.raw.built) {
          const n = trend.keys.size;
          f.days.forEach((d, u) => {
            const lo = new Float32Array(n).fill(NaN), hi = new Float32Array(n).fill(NaN);
            f.keys.forEach((k, p) => { const i = trend.keys.get(k); if (i != null && f.lo[u][p] != null) { lo[i] = f.lo[u][p] / 10; hi[i] = f.hi[u][p] / 10; } });
            mine.got.set(d, { lo, hi });
          });
          mine.days = f.days; mine.done = true; renderChart();
          return;
        }
      } catch (e) { /* not published for this season: compute them */ }
      if (ci !== mine) return;
    }
    // every worker takes a share of each date's replicates, so each date finishes about n times sooner; the
    // shares are merged in replicate order, which gives exactly the single-run (and precomputed) result
    const n = Math.max(1, Math.min(CI.maxWorkers, (navigator.hardwareConcurrency || 2) - 1));
    const queue = [], parts = new Map();
    for (const day of days) for (let c = 0; c < n; c++) queue.push({ day, chunk: c, part: [Math.round((c * CI.reps) / n), Math.round(((c + 1) * CI.reps) / n)] });
    let paint = 0;
    const next = (w) => {
      if (queue.length) { w.postMessage(Object.assign({ type: "part", reps: CI.reps }, queue.shift())); return; }
      w.terminate(); mine.workers = mine.workers.filter((x) => x !== w);
      if (!mine.workers.length) { mine.done = true; renderChart(); }
    };
    for (let i = 0; i < n; i++) {
      const w = new Worker("ci-worker.js?v=3");
      mine.workers.push(w);
      w.onmessage = (e) => {
        if (ci !== mine) return;
        const m = e.data;
        if (m.type === "summary") {
          const nk = trend.keys.size, lo = new Float32Array(nk).fill(NaN), hi = new Float32Array(nk).fill(NaN);
          m.keys.forEach((k, u) => { const ix = trend.keys.get(k); if (ix != null) { lo[ix] = m.lo[u]; hi[ix] = m.hi[u]; } });
          mine.got.set(m.day, { lo, hi });
          // repaint at most every 300 ms while dates come in
          if (Date.now() - paint > 300) { paint = Date.now(); renderChart(); }
          next(w);
          return;
        }
        if (!parts.has(m.day)) parts.set(m.day, []);
        const got = parts.get(m.day);
        got[m.chunk] = { pools: m.pools };
        if (got.filter(Boolean).length === n) {
          // the worker that brought the last share merges the date before taking more work
          parts.delete(m.day);
          w.postMessage({ type: "summary", day: m.day, parts: got }, got.flatMap((p) => p.pools.flatMap((x) => [x.pointDollars.buffer, x.dollars.buffer])));
          return;
        }
        next(w);
      };
      w.onerror = () => {
        if (ci !== mine) return;
        for (const x of mine.workers) x.terminate();
        mine.workers = []; mine.failed = true; mine.done = true; renderChart();
      };
      w.postMessage({ type: "init", raw: state.raw, settings });
      next(w);
    }
  }
  // a player's band over the days its computed dates span: the interval's offsets from the raw line at those
  // dates, interpolated between them and added to `line` (the raw line, or the share image's filtered one)
  function band(key, raw, line) {
    if (!ci || !trend || !raw) return null;
    const i = trend.keys.get(key);
    if (i == null) return null;
    const pts = [];
    for (const [d, c] of ci.got) {
      const lo = c.lo[i], hi = c.hi[i], v = raw[d];
      if (d <= trend.upto && !isNaN(lo) && !isNaN(hi) && !isNaN(v)) pts.push([d, lo - v, hi - v]);
    }
    if (pts.length < 2) return null;
    pts.sort((a, b) => a[0] - b[0]);
    const from = pts[0][0], to = pts[pts.length - 1][0];
    const lo = new Float32Array(state.N).fill(NaN), hi = new Float32Array(state.N).fill(NaN);
    let j = 0;
    for (let d = from; d <= to; d++) {
      while (j < pts.length - 2 && d > pts[j + 1][0]) j++;
      const [a, la, ha] = pts[j], [b, lb, hb] = pts[j + 1], t = (d - a) / (b - a), v = line[d];
      if (isNaN(v)) continue;
      lo[d] = v + la + (lb - la) * t; hi[d] = v + ha + (hb - ha) * t;
    }
    return { from, to, lo, hi };
  }
  // the band as one closed outline: along the top, back along the bottom
  function bandPts(b) {
    const top = [], bot = [];
    for (let d = b.from; d <= b.to; d++) if (!isNaN(b.lo[d])) { top.push([d, b.hi[d]]); bot.push([d, b.lo[d]]); }
    return top.concat(bot.reverse());
  }
  const series = (key) => {
    if (!trend || !trend.vals) return null;
    const i = trend.keys.get(key);
    return i == null ? null : trend.vals.subarray(i * state.N, (i + 1) * state.N);
  };
  function valueAt(arr, day) { for (let d = Math.min(day, state.N - 1); d >= TREND_START; d--) if (!isNaN(arr[d])) return arr[d]; return NaN; }
  function segValue(key, i) {
    if (!trend) return NaN;
    const k = trend.keys.get(key);
    return k == null ? NaN : trend.seg[i][k];
  }
  // stretches to fade: a break of more than GAP_DAYS between games, and the end of the season when the
  // player's last game came more than GAP_DAYS before it
  function quietSpans(key) {
    const p = state.db.players.find((x) => x.key === key);
    if (!p || !p.days.length) return [];
    const out = [], d = p.days;
    for (let i = 1; i < d.length; i++) if (d[i] - d[i - 1] > GAP_DAYS) out.push([d[i - 1], d[i]]);
    const last = d[d.length - 1];
    if (state.N - 1 - last > GAP_DAYS) out.push([last, state.N - 1]);
    return out;
  }

  // a player's line as runs of points, each run solid or faded (q) for a quiet span
  function lineRuns(key, arr) {
    const quiet = quietSpans(key), runs = [];
    let cur = null, prev = null;
    for (let d = TREND_START; d <= trend.upto; d++) {
      const v = arr[d]; if (isNaN(v)) continue;
      if (prev) {
        const q = quiet.some(([a, b]) => prev[0] >= a && d <= b);
        if (!cur || cur.q !== q) { cur = { q, pts: [prev] }; runs.push(cur); }
        cur.pts.push([d, v]);
      }
      prev = [d, v];
    }
    return runs;
  }
  function yScale(ser) {
    let lo = 0, hi = 10;
    for (const s of ser) if (s.arr) for (let d = TREND_START; d <= trend.upto; d++) { const v = s.arr[d]; if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    for (const s of ser) if (s.band) for (let d = s.band.from; d <= s.band.to; d++) if (!isNaN(s.band.lo[d])) { lo = Math.min(lo, s.band.lo[d]); hi = Math.max(hi, s.band.hi[d]); }
    const st = niceStep(hi - lo);
    return { lo: Math.floor(lo / st) * st, hi: Math.ceil(hi / st) * st, st };
  }

  // ---------- chart ----------
  const svgNS = "http://www.w3.org/2000/svg";
  let geo = null;
  function player(key) {
    for (const g of ["h", "p"]) { const r = state.result[g].rows.find((x) => x.key === key); if (r) return r; }
    const p = state.db.players.find((x) => x.key === key);
    return p ? { key, name: p.name, team: p.team, g: p.g, id: p.id } : { key, name: key };
  }
  const twoWay = (r) => state.db.players.some((x) => x.id === r.id && x.g !== r.g);
  const nameTag = (r) => r.name + (twoWay(r) ? (r.g === "p" ? " (P)" : " (H)") : "");
  function niceStep(span) { const raw = span / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / mag; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag; }
  function renderLegend() {
    const box = $("legend"); box.replaceChildren();
    if (!state.chart.length) { const s = document.createElement("span"); s.className = "empty"; s.textContent = "Pick players in the table to chart them"; box.appendChild(s); return; }
    state.chart.forEach((key, i) => {
      const r = player(key), arr = series(key), v = arr ? valueAt(arr, Math.max(state.b, TREND_START)) : NaN;
      const item = document.createElement("span"); item.className = "legend-item";
      item.innerHTML = `<span class="key" style="background:${COLORS[i]}"></span><span>${esc(nameTag(r))}</span>` +
        `<span class="v">${isNaN(v) ? "" : money1(v)}</span>` +
        `<button type="button" aria-label="Remove ${esc(r.name)}"><svg width="16" height="16" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" aria-hidden="true"><path d="M14 14l20 20M34 14L14 34"/></svg></button>`;
      item.querySelector("button").addEventListener("click", () => toggleChart(key));
      box.appendChild(item);
    });
  }
  function renderChart() {
    if (!state.result) return;
    renderLegend();
    const svg = $("chart"); svg.replaceChildren();
    const phone = matchMedia("(max-width: 700px)").matches;
    const one = state.chart.length === 1;
    const W = Math.max(300, $("chart-box").clientWidth);
    const m = { l: phone ? 64 : 72, r: phone ? 8 : 16, t: one ? 74 : 14 };
    const x0 = 0, x1 = state.N - 1;
    const X = (d) => m.l + ((d - x0) / (x1 - x0)) * (W - m.l - m.r);
    // the month text: every other month drops a row when neighbours would touch (a phone's width)
    const monthX = state.segs.map((s) => X(one ? s.mid : s.tick));
    const stagger = monthX.some((x, i) => i && x - monthX[i - 1] < (one ? 66 : 50));
    const row = one ? 58 : 28, drop = (i) => (stagger && i % 2 ? row : 0);
    m.b = (one ? 78 : 42) + (stagger ? row : 0);
    const H = (phone ? 238 : 318) + (one ? 134 : 0) + (stagger ? row : 0);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H);
    const ser = state.chart.map((k, i) => { const arr = series(k); return { key: k, color: COLORS[i], arr, r: player(k), band: band(k, arr, arr) }; });
    const { lo, hi, st } = yScale(ser);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const el = (tag, attrs, text) => { const e = document.createElementNS(svgNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
    const base = H - m.b;
    // the selected period
    if (state.preset !== "season") el("rect", { x: X(state.a), y: m.t, width: Math.max(2, X(state.b) - X(state.a)), height: base - m.t, fill: "var(--brand-cyan-soft)" });
    for (let v = lo; v <= hi + 1e-9; v += st) {
      el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: Math.abs(v) < 1e-9 ? "var(--chart-center-line)" : "var(--chart-grid)" });
      el("text", { x: m.l - 8, y: Y(v) + 7, "text-anchor": "end" }, money(v));
    }
    el("line", { x1: m.l, x2: W - m.r, y1: base, y2: base, stroke: "var(--chart-muted)" });
    // a tick and label on the first of each month (the season's first month at its first day);
    // one player: ticks on every 1st, each month's label and value centred between its first
    // and last game days
    if (one) state.firsts.forEach((d) => { const x = X(d); el("line", { x1: x, x2: x, y1: base, y2: base + 6, stroke: "var(--chart-muted)" }); });
    state.segs.forEach((s, i) => {
      const x = monthX[i], y = base + drop(i);
      if (!one) el("line", { x1: x, x2: x, y1: base, y2: base + 6, stroke: "var(--chart-muted)" });
      const txt = [el("text", { x, y: y + 34, "text-anchor": "middle" }, s.short)];
      if (one) { const v = segValue(state.chart[0], i); txt.push(el("text", { x, y: y + 62, "text-anchor": "middle", class: "val" }, isNaN(v) ? "" : money1(v))); }
      // kept inside the chart's edges (the last month's value on a phone)
      let lo = Infinity, hi = -Infinity;
      try { for (const t of txt) { const b = t.getBBox(); if (b.width) { lo = Math.min(lo, b.x); hi = Math.max(hi, b.x + b.width); } } } catch (e) { /* not laid out */ }
      const dx = hi > W ? W - hi : lo < 0 ? -lo : 0;
      if (dx) for (const t of txt) t.setAttribute("x", x + dx);
    });
    // one player: the All-Star break and each half's value above the chart
    if (one && state.halves) {
      const xs = X((state.halves.h1 + state.halves.h2) / 2);
      el("line", { x1: xs, x2: xs, y1: m.t - 4, y2: base, stroke: "var(--chart-muted)", "stroke-dasharray": "4 4" });
      const k = state.segs.length;
      [["1st Half", X(state.halves.h1 / 2), segValue(state.chart[0], k)], ["2nd Half", X((state.halves.h2 + x1) / 2), segValue(state.chart[0], k + 1)]].forEach(([label, x, v]) => {
        el("text", { x, y: m.t - 44, "text-anchor": "middle", class: "half" }, label);
        el("text", { x, y: m.t - 16, "text-anchor": "middle", class: "val" }, isNaN(v) ? "" : money1(v));
      });
    }
    // the 95% bands under all the lines, then the lines: faded through each long break and after an early last game
    for (const s of ser) {
      if (!s.band) continue;
      el("path", { d: bandPts(s.band).map(([d, v], i) => (i ? "L" : "M") + X(d).toFixed(1) + " " + Y(v).toFixed(1)).join("") + "Z",
        fill: s.color, "fill-opacity": BAND_OPACITY, stroke: "none" });
    }
    for (const s of ser) {
      if (!s.arr) continue;
      for (const run of lineRuns(s.key, s.arr)) {
        el("path", { d: run.pts.map(([d, v], i) => (i ? "L" : "M") + X(d).toFixed(1) + " " + Y(v).toFixed(1)).join(""), fill: "none", stroke: s.color,
          "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-opacity": run.q ? QUIET_OPACITY : 1 });
      }
    }
    const cross = el("line", { x1: 0, x2: 0, y1: m.t, y2: base, stroke: "var(--chart-axis)", "stroke-width": 1, visibility: "hidden" });
    geo = { X, m, W, x0, x1, ser, cross };
    // the share image waits for the intervals too, so it never shows a half-drawn band
    $("share").disabled = !ser.length || !trend || !trend.done || !ci || !ci.done;
    const st2 = $("chart-status");
    if (!trend || !trend.done) st2.textContent = `Valuing every date of the ${state.season} season${trend && trend.vals ? ", " + Math.round(((trend.upto - TREND_START + 1) / (state.N - TREND_START)) * 100) + "%" : ""}`;
    else if (ci && ci.failed) st2.textContent = "The 95% intervals could not be computed in this browser.";
    else if (ci && !ci.done && !ci.workers.length) st2.textContent = "Loading 95% intervals";
    else if (ci && !ci.done) st2.textContent = `Estimating 95% intervals, ${Math.round((ci.got.size / ci.days.length) * 100)}%`;
    else st2.textContent = "";
  }
  function showTip(day) {
    if (!geo || !geo.ser.length || !trend || !trend.vals) return;
    day = Math.max(TREND_START, Math.min(trend.upto, day));
    const x = geo.X(day);
    geo.cross.setAttribute("x1", x); geo.cross.setAttribute("x2", x); geo.cross.setAttribute("visibility", "visible");
    const tip = $("tip");
    const rows = geo.ser.map((s) => ({ s, v: s.arr ? s.arr[day] : NaN })).sort((a, b) => (isNaN(b.v) ? -1e9 : b.v) - (isNaN(a.v) ? -1e9 : a.v));
    const range = (s) => (s.band && day >= s.band.from && day <= s.band.to && !isNaN(s.band.lo[day])
      ? `<span class="ci">${money1(s.band.lo[day])} to ${money1(s.band.hi[day])}</span>` : "");
    tip.innerHTML = `<div class="d">Season to date through ${fmtDay(day)}</div>` + rows.map(({ s, v }) =>
      `<div class="row"><i style="background:${s.color}"></i><span>${esc(nameTag(s.r))}</span><b>${isNaN(v) ? "—" : money1(v)}</b>${range(s)}</div>`).join("") +
      (geo.ser.some((s) => s.band) ? `<div class="note">95% interval after each value</div>` : "");
    tip.hidden = false;
    const scale = $("chart-box").clientWidth / geo.W;
    let left = x * scale + 14;
    if (left + tip.offsetWidth > $("chart-box").clientWidth) left = x * scale - tip.offsetWidth - 14;
    tip.style.left = Math.max(0, left) + "px"; tip.style.top = (geo.m.t + 4) + "px";
  }
  function hideTip() { $("tip").hidden = true; if (geo) geo.cross.setAttribute("visibility", "hidden"); }
  let kbDay = null;
  $("chart").addEventListener("pointermove", (e) => {
    if (!geo) return;
    const rect = $("chart").getBoundingClientRect(), px = ((e.clientX - rect.left) / rect.width) * geo.W;
    showTip(Math.round(geo.x0 + ((px - geo.m.l) / (geo.W - geo.m.l - geo.m.r)) * (geo.x1 - geo.x0)));
  });
  $("chart").addEventListener("pointerleave", hideTip);
  $("chart").addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault(); kbDay = (kbDay ?? Math.max(state.b, TREND_START)) + (e.key === "ArrowRight" ? 1 : -1);
      kbDay = Math.max(TREND_START, Math.min(state.N - 1, kbDay)); showTip(kbDay);
    } else if (e.key === "Escape") hideTip();
  });
  $("chart").addEventListener("blur", hideTip);
  let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(renderChart, 120); });

  // ---------- share image: the chart as a 1600 x 1600 PNG with the Pitcher List Stats wordmark ----------
  const HEX = ["#55e8ff", "#ff839b", "#ce66ff", "#2a98ff"]; // brand-cyan, pitch-four-seamer, pitch-slider, pitch-curveball
  const IMG = { W: 1600, H: 1600, P: 64, bg: "#292c42", title: "#73efff", text: "#f0f1f5", white: "#ffffff", axis: "#cbd7fd",
    grid: "rgba(255,255,255,0.07)", zero: "rgba(255,255,255,0.26)", base: "rgba(196,205,236,0.85)", foot: "#c0c6dc", band: "rgba(85,232,255,0.07)",
    neg: "#ff839b", /* pitch-four-seamer */ pos: "#7ddf9a", /* green-300 */ frame: "rgba(85,232,255,0.667)" /* brand-brand-cyan at the season cards' 2/3 */ };
  let markImg = null;
  const loadMark = () => markImg || (markImg = new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej;
    im.src = "../pitcher-cards/PitcherList_Stats_watermark_with_logo.webp";
  }));
  const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const imageName = () => `player_rater_${state.season}_${state.chart.map((k) => slug(player(k).name)).join("_vs_")}.png`;
  function fit(g, text, w) {
    if (g.measureText(text).width <= w) return text;
    while (text.length > 1 && g.measureText(text + "…").width > w) text = text.slice(0, -1);
    return text + "…";
  }
  // The share image's lines go through a Kalman filter (forward only, so each point uses only the games
  // up to its date). A local-level model: the true value drifts day to day (variance Q), and each day's
  // season-to-date value measures it with noise that shrinks as the season's sample grows (R0 / days).
  const KALMAN = { Q: 0.3, R0: 150 };
  function kalman(arr) {
    const n = arr.length, out = new Float32Array(n).fill(NaN);
    let x = NaN, P = 0;
    for (let d = 0; d < n; d++) {
      const y = arr[d], R = KALMAN.R0 / (d + 1);
      if (isNaN(x)) { if (!isNaN(y)) { x = y; P = R; out[d] = x; } continue; }
      P += KALMAN.Q;
      if (!isNaN(y)) { const K = P / (P + R); x += K * (y - x); P *= 1 - K; out[d] = x; }
    }
    return out;
  }

  // one player's full-season dollars by category: his points in the category less the replacement
  // player's, at the pool's price per point. They sum to his dollars less the minimum bid.
  let fullCache = null;
  function fullSeason() {
    const sig = state.season + JSON.stringify(settings);
    if (!fullCache || fullCache.sig !== sig) fullCache = { sig, v: E.valuate(state.db, settings, 0, state.N - 1) };
    return fullCache.v;
  }
  function categoryDollars(key) {
    const v = fullSeason();
    for (const g of ["h", "p"]) {
      const r = v[g].rows.find((x) => x.key === key);
      if (r) return (g === "h" ? settings.hitCats : settings.pitCats).map((c) => ({ c, v: (r.sgpCat[c] - r.replCat[c]) * v[g].perSgp }));
    }
    return [];
  }
  // one player's full-season rank at a position, e.g. "SP6". The data has no primary position, so a
  // player eligible at several is ranked where he ranks best (ties: the first listed). A hitter with
  // no field position (DH only) is ranked among all hitters as Util.
  function positionRank(key) {
    const v = fullSeason();
    for (const g of ["h", "p"]) {
      const r = v[g].rows.find((x) => x.key === key);
      if (!r) continue;
      const poss = r.elig.length ? r.elig : ["Util"];
      let best = null;
      for (const pos of poss) {
        const n = 1 + v[g].rows.filter((x) => x.dollars > r.dollars && (pos === "Util" || x.elig.includes(pos))).length;
        if (!best || n < best.n) best = { pos, n };
      }
      return best.pos + best.n;
    }
    return "";
  }

  async function shareBlob() {
    await Promise.all(['700 78px "DM Sans"', '500 45px "DM Sans"', '500 36px "DM Sans"', '600 39px "DM Sans"', '600 36px "DM Sans"', '400 36px "Work Sans"',
      '600 36px "Work Sans"', '600 42px "Work Sans"'].map((f) => document.fonts.load(f)));
    const mark = await loadMark().catch(() => null);
    const { W, H, P } = IMG, one = state.chart.length === 1;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = IMG.bg; g.fillRect(0, 0, W, H);
    const ser = state.chart.map((k, i) => {
      const raw = series(k);
      const arr = raw && kalman(raw);
      return { key: k, color: HEX[i], raw, arr, r: player(k), band: band(k, raw, arr) };
    });
    const ink = (v, base) => (v < 0 ? IMG.neg : base); // every negative number on the image is pitch-four-seamer
    // a dollar value: negative in pitch-four-seamer, above zero (as shown, to a dime) in green-300
    const tone = (v) => (v < 0 ? IMG.neg : Math.round(v * 10) > 0 ? IMG.pos : IMG.text);
    // text in pieces, each [text, colour], from x (left aligned)
    const runs = (parts, x, y) => { for (const [t, c] of parts) { g.fillStyle = c; g.fillText(t, x, y); x += g.measureText(t).width; } return x; };
    // header, the wordmark top right. One player: their name over "Fantasy Value Through the Season: $X";
    // more: that title over their names
    const mw = 330;
    if (mark) g.drawImage(mark, W - P - mw, 44, mw, (mw * mark.naturalHeight) / mark.naturalWidth);
    const title = one ? nameTag(ser[0].r) : "Fantasy Value Through the Season";
    // the title at 78px, smaller only as far as it takes to clear the wordmark
    let ts = 78; g.font = `700 ${ts}px "DM Sans"`;
    while (ts > 44 && g.measureText(title).width > W - 2 * P - mw - 32) g.font = `700 ${--ts}px "DM Sans"`;
    g.fillStyle = IMG.title;
    g.fillText(fit(g, title, W - 2 * P - mw - 32), P, 118);
    // what the shading is, right-aligned on the subtitle's line; the subtitle keeps clear of it
    let noteW = 0;
    if (ser.some((s) => s.band)) {
      g.font = '400 36px "Work Sans"'; g.textAlign = "right"; g.fillStyle = IMG.foot;
      g.fillText("Shaded: 95% interval", W - P, 186);
      noteW = g.measureText("Shaded: 95% interval").width + 40; g.textAlign = "left";
    }
    g.font = '500 45px "DM Sans"';
    if (one) {
      const v = valueAt(ser[0].raw, state.N - 1);
      const pr = positionRank(ser[0].key);
      runs([["Fantasy Value Through the Season: ", IMG.text], [money1(v), tone(v)], [pr ? ` (${pr})` : "", IMG.white]], P, 186);
    } else { g.fillStyle = IMG.text; g.fillText(fit(g, ser.map((s) => nameTag(s.r)).join(", "), W - 2 * P - noteW), P, 186); }
    // the key, for two or more players, onto another row when the next one would run past the edge
    let ky = 252;
    if (!one) {
      let kx = P;
      g.font = '500 36px "DM Sans"'; g.textBaseline = "middle";
      for (const s of ser) {
        const v = valueAt(s.raw, state.N - 1), name = nameTag(s.r) + " ";
        const w = 60 + g.measureText(name).width + g.measureText(money1(v)).width;
        if (kx > P && kx + w > W - P) { kx = P; ky += 54; }
        g.fillStyle = s.color; g.fillRect(kx, ky - 4, 44, 8); kx += 60;
        kx = runs([[name, IMG.text], [money1(v), tone(v)]], kx, ky) + 48;
      }
      g.textBaseline = "alphabetic";
    }
    // the chart (one player: room under it for the month values and the category row)
    const L = P + 112, R = W - P, T = one ? 340 : ky + 64, B = H - (one ? 372 : 176);
    const X = (d) => L + (d / (state.N - 1)) * (R - L);
    const { lo, hi, st } = yScale(ser);
    const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (B - T);
    if (state.preset !== "season") { g.fillStyle = IMG.band; g.fillRect(X(state.a), T, Math.max(3, X(state.b) - X(state.a)), B - T); }
    g.font = '400 36px "Work Sans"'; g.textAlign = "right";
    for (let v = lo; v <= hi + 1e-9; v += st) {
      g.strokeStyle = Math.abs(v) < 1e-9 ? IMG.zero : IMG.grid; g.lineWidth = Math.abs(v) < 1e-9 ? 2 : 1.5;
      g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(R, Y(v)); g.stroke();
      g.fillStyle = ink(v, IMG.axis); g.fillText(money(v), L - 20, Y(v) + 12);
    }
    g.strokeStyle = IMG.base; g.lineWidth = 2;
    g.beginPath(); g.moveTo(L, B); g.lineTo(R, B); g.stroke();
    g.textAlign = "center";
    const tick = (x) => { g.strokeStyle = IMG.base; g.lineWidth = 2; g.beginPath(); g.moveTo(x, B); g.lineTo(x, B + 12); g.stroke(); };
    if (one) state.firsts.forEach((d) => tick(X(d)));
    state.segs.forEach((s, i) => {
      const x = X(one ? s.mid : s.tick);
      if (!one) tick(x);
      g.font = '400 36px "Work Sans"'; g.fillStyle = IMG.axis; g.fillText(s.short, x, B + 56);
      if (one) {
        const v = segValue(state.chart[0], i);
        g.font = '600 36px "Work Sans"'; g.fillStyle = tone(v); if (!isNaN(v)) g.fillText(money1(v), x, B + 104);
      }
    });
    if (one && state.halves) {
      const xs = X((state.halves.h1 + state.halves.h2) / 2), k = state.segs.length;
      g.strokeStyle = IMG.base; g.lineWidth = 2; g.setLineDash([8, 8]);
      g.beginPath(); g.moveTo(xs, T - 8); g.lineTo(xs, B); g.stroke(); g.setLineDash([]);
      [["1st Half", X(state.halves.h1 / 2), segValue(state.chart[0], k)], ["2nd Half", X((state.halves.h2 + state.N - 1) / 2), segValue(state.chart[0], k + 1)]].forEach(([label, x, v]) => {
        g.font = '600 39px "DM Sans"'; g.fillStyle = IMG.text; g.fillText(label, x, T - 70);
        g.font = '600 36px "Work Sans"'; g.fillStyle = tone(v); if (!isNaN(v)) g.fillText(money1(v), x, T - 22);
      });
    }
    // one player: a one-row table of the season's dollars from each category, spread evenly across,
    // framed like a season card's stat line: a rounded cyan border, cyan rules between
    if (one) {
      const cats = categoryDollars(state.chart[0]), top = B + 136, h = 140, w = W - 2 * P;
      g.strokeStyle = IMG.frame; g.lineWidth = 4; g.beginPath();
      if (g.roundRect) g.roundRect(P + 2, top + 2, w - 4, h - 4, 15); else g.rect(P + 2, top + 2, w - 4, h - 4);
      g.stroke();
      g.lineWidth = 3; g.lineCap = "butt";
      for (let i = 1; i < cats.length; i++) {
        const x = Math.round(P + (i * w) / cats.length);
        g.beginPath(); g.moveTo(x, top + 22); g.lineTo(x, top + h - 22); g.stroke();
      }
      cats.forEach(({ c, v }, i) => {
        const x = P + ((i + 0.5) * w) / cats.length;
        g.font = '600 36px "DM Sans"'; g.fillStyle = IMG.title; g.fillText(E.CATS[c].label, x, top + 54);
        g.font = '600 42px "Work Sans"'; g.fillStyle = tone(v); g.fillText(money1(v), x, top + 112);
      });
    }
    // the 95% bands, around the filtered lines, under all of them
    for (const s of ser) {
      if (!s.band) continue;
      g.globalAlpha = BAND_OPACITY; g.fillStyle = s.color; g.beginPath();
      bandPts(s.band).forEach(([d, v], i) => (i ? g.lineTo(X(d), Y(v)) : g.moveTo(X(d), Y(v))));
      g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
    g.lineJoin = "round"; g.lineCap = "round"; g.lineWidth = 5;
    for (const s of ser) {
      if (!s.arr) continue;
      for (const run of lineRuns(s.key, s.arr)) {
        g.globalAlpha = run.q ? QUIET_OPACITY : 1; g.strokeStyle = s.color;
        g.beginPath(); run.pts.forEach(([d, v], i) => (i ? g.lineTo(X(d), Y(v)) : g.moveTo(X(d), Y(v)))); g.stroke();
      }
    }
    g.globalAlpha = 1;
    // footer: the season, the league size and its categories
    g.textAlign = "left"; g.font = '400 36px "Work Sans"'; g.fillStyle = IMG.foot;
    const cats = settings.hitCats.map((c) => E.CATS[c].label).join(",") + " / " + settings.pitCats.map((c) => E.CATS[c].label).join(",");
    g.fillText(fit(g, `${state.season} regular season  |  ${settings.teams} teams  |  ${cats}`, W - 2 * P), P, H - 36);
    return new Promise((res) => cv.toBlob(res, "image/png"));
  }
  ShareImage.image($("share"), shareBlob, imageName);

  renderLeague();
  boot();
})();
