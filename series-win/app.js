// The Series Win page: season, the two seeds, series length and home games over
// the two figures in chart.js. Each season's runs come straight from MLB's
// standings (StatsAPI allows any origin), one request per season. A matchup is
// linkable as #<season>-<higher>-<lower>&games=<n>[&home=1], teams by abbreviation.

(() => {
  "use strict";

  const S = window.SeriesWin;
  const $ = (id) => document.getElementById(id);
  const el = {
    form: $("form"), season: $("season"), games: $("games"), home: $("home"), go: $("go"), status: $("status"),
    out: $("out"), figLength: $("fig_length"), figGames: $("fig_games"), stats: $("stats"), summary: $("summary"),
    dlLength: $("dl_png"), dlGames: $("dl_png_games"), swap: $("swap"),
  };

  // Team colours, by MLB team id (the script's team sheet)
  const COLORS = {
    108: "#BA0021", 109: "#A71930", 110: "#DF4601", 111: "#BD3039", 112: "#0E3386", 113: "#C6011F",
    114: "#00385D", 115: "#333366", 116: "#0C2340", 117: "#EB6E1F", 118: "#004687", 119: "#005A9C",
    120: "#AB0003", 121: "#FF5910", 133: "#003831", 134: "#FDB827", 135: "#2F241D", 136: "#005C5C",
    137: "#FD5A1E", 138: "#C41E3A", 139: "#8FBCE6", 140: "#003278", 141: "#134A8E", 142: "#002B5C",
    143: "#E81828", 144: "#CE1141", 145: "#27251F", 146: "#00A3E0", 147: "#003087", 158: "#12284B",
  };
  const FIRST_SEASON = 2000;
  // the figures are drawn in the Swing Profiles style; ?style=app draws the Streamlit app's
  const STYLE = new URLSearchParams(location.search).get("style") === "app" ? "app" : "swing";
  const FIG_W = STYLE === "swing" ? { length: 1600, games: 1600 } : { length: 1064, games: 970 };
  const THIS_YEAR = new Date().getFullYear();

  const status = (text, cls = "") => { el.status.textContent = text; el.status.className = `status ${cls}`.trim(); };
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  // ---- data --------------------------------------------------------------------------

  const seasons = new Map();  // season -> Promise of its teams, best xWin% first
  function loadSeason(year) {
    if (!seasons.has(year)) {
      const url = `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${year}&standingsTypes=regularSeason&hydrate=team`;
      seasons.set(year, fetch(url).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((d) => {
          const teams = d.records.flatMap((rec) => rec.teamRecords).filter((t) => t.gamesPlayed > 0).map((t) => {
            const rsg = t.runsScored / t.gamesPlayed, rag = t.runsAllowed / t.gamesPlayed;
            const name = t.team.clubName || t.team.teamName;
            return {
              id: t.team.id, name, full: t.team.name, code: t.team.abbreviation,
              color: COLORS[t.team.id] || "#8D96B3", wins: t.wins, losses: t.losses, updated: t.lastUpdated,
              rsg, rag, xwin: S.xWin(rsg, rag),
              keys: [fold(name), fold(t.team.name), fold(t.team.abbreviation), fold(t.team.teamName || ""), fold(t.team.shortName || "")],
            };
          });
          return teams.sort((a, b) => b.xwin - a.xwin);
        })
        .catch((e) => { seasons.delete(year); throw e; }));
    }
    return seasons.get(year);
  }

  let teams = [];     // the season in the controls
  let season = null;
  const byId = (id) => teams.find((t) => t.id === id) || null;
  const byCode = (code) => (code && teams.find((t) => t.code.toUpperCase() === code.toUpperCase())) || null;

  // Every team matching what has been typed -- a prefix of the club name first, then
  // of the abbreviation, city or full name, then any substring. Nothing typed lists
  // everyone, best xWin% first.
  function suggestions(query) {
    const q = fold(query);
    if (!q) return teams.slice();
    const scored = [];
    for (const t of teams) {
      let score;
      if (t.keys[0].startsWith(q)) score = 0;
      else if (t.keys.some((k) => k.startsWith(q))) score = 1;
      else if (t.keys.some((k) => k.includes(q))) score = 2;
      else continue;
      scored.push([score, t]);
    }
    scored.sort((a, b) => a[0] - b[0] || b[1].xwin - a[1].xwin);
    return scored.map((x) => x[1]);
  }
  const exactTeam = (query) => { const q = fold(query); return q ? teams.find((t) => t.keys.includes(q)) || null : null; };

  // ---- the two seed fields -----------------------------------------------------------
  //
  // As Swing Profiles' player field: once a matchup is drawn the field holds the team.
  // Clicking or tabbing into it clears it, so the list opens on every team and the
  // first keystroke starts a new search; leaving it empty puts the team back.

  function teamField(input, list) {
    const f = { team: null, committed: false, shown: [], active: -1 };
    f.set = (t) => { f.team = t; input.value = t ? t.name : ""; f.committed = Boolean(t); };
    function show() {
      f.shown = teams.length ? suggestions(input.value) : [];
      f.active = -1;
      list.replaceChildren(...f.shown.map((t, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.dataset.index = String(i);
        const name = document.createElement("span"); name.textContent = t.name;
        const sub = document.createElement("small"); sub.textContent = `${t.wins}-${t.losses} · ${pct(t.xwin)} xWin`;
        li.append(name, sub);
        return li;
      }));
      list.hidden = !f.shown.length;
      input.setAttribute("aria-expanded", f.shown.length ? "true" : "false");
    }
    f.hide = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); f.shown = []; f.active = -1; };
    function setActive(i) {
      f.active = i;
      [...list.children].forEach((li, k) => li.classList.toggle("active", k === i));
      if (i >= 0) list.children[i].scrollIntoView({ block: "nearest" });
    }
    function startSearch() {
      if (f.committed) { input.value = ""; f.committed = false; }
      show();
    }
    // a pick is unambiguous, so it draws straight away
    function pick(t) { f.hide(); f.set(t); run(); }
    // what the field names: the picked team, or whatever the text matches best
    f.resolve = () => (f.committed && f.team) || exactTeam(input.value) || (fold(input.value) ? suggestions(input.value)[0] : f.team) || null;

    input.addEventListener("input", () => { f.committed = false; show(); });
    input.addEventListener("focus", startSearch);
    input.addEventListener("click", startSearch);  // the field keeps focus after a pick
    input.addEventListener("blur", () => setTimeout(() => {
      f.hide();
      if (!input.value.trim() && f.team) f.set(f.team);
    }, 150));
    input.addEventListener("keydown", (e) => {
      if (list.hidden) {
        if (e.key === "ArrowDown") { e.preventDefault(); show(); if (f.shown.length) setActive(0); }
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((f.active + 1) % f.shown.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((f.active - 1 + f.shown.length) % f.shown.length); }
      else if (e.key === "Enter" && f.active >= 0) { e.preventDefault(); pick(f.shown[f.active]); }
      else if (e.key === "Escape") { f.hide(); }
    });
    // pointerdown rather than click, and prevented, so the input keeps focus and
    // its blur does not close the list before the pick registers.
    list.addEventListener("pointerdown", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      e.preventDefault();
      pick(f.shown[Number(li.dataset.index)]);
    });
    list.addEventListener("pointermove", (e) => {
      const li = e.target.closest("li");
      if (li) setActive(Number(li.dataset.index));
    });
    return f;
  }
  const higher = teamField($("higher"), $("suggest_higher"));
  const lower = teamField($("lower"), $("suggest_lower"));

  // ---- season ------------------------------------------------------------------------

  // Load a season into the controls. The same clubs carry over where they exist;
  // otherwise `pick` (abbreviations from a link), else the script's defaults: the
  // 2nd and 6th best teams by xWin%.
  async function setSeason(year, pick = {}) {
    el.go.disabled = true;
    status(`loading the ${year} standings…`);
    let list;
    try {
      list = await loadSeason(year);
    } catch (e) {
      console.error(e);
      status(`could not load the ${year} standings: ${e.message}`, "err");
      return false;
    }
    if (!list.length) { status(`no ${year} regular-season games yet`, "warn"); return false; }
    const prev = [higher.team, lower.team];
    teams = list; season = year;
    el.season.value = String(year);
    const find = (code, before, i) => byCode(code) || (before && byId(before.id)) || teams[Math.min(i, teams.length - 1)];
    higher.set(find(pick.higher, prev[0], 1));
    lower.set(find(pick.lower, prev[1], 5));
    const updated = teams.map((t) => t.updated).filter(Boolean).sort().pop();
    status(`${teams.length} teams · ${year} regular season` + (updated && year === THIS_YEAR ? `, through ${new Date(updated).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""));
    el.go.disabled = false;
    return true;
  }

  // ---- drawing -----------------------------------------------------------------------

  let drawn = null;  // what the figures show, for the downloads
  let drawing = 0;
  async function run() {
    const h = higher.resolve(), l = lower.resolve();
    if (!h || !l) { status(!h ? "type a team for the higher seed" : "type a team for the lower seed", "warn"); return; }
    higher.set(h); lower.set(l);
    const sel = { season, higher: h, lower: l, games: Number(el.games.value), allHome: el.home.value === "all" };
    const token = ++drawing;
    const p = h.id === l.id ? 0.5 : S.log5(h.xwin, l.xwin);
    const opts = { hfa: S.HFA, allHome: sel.allHome };
    const line = S.byLength(p, opts);
    const res = S.series(p, sel.games, opts);
    const figOpts = { higher: h, lower: l, p, allHome: sel.allHome, code: h.code, season };

    el.out.hidden = false;  // shown first, so the canvases have a width to size to
    const scale = (canvas, w) => Math.max(1, Math.min(2, (canvas.clientWidth || 800) * (window.devicePixelRatio || 1) / w));
    await Promise.all([
      S.render("length", el.figLength, line, figOpts, scale(el.figLength, FIG_W.length), STYLE),
      S.render("games", el.figGames, res, figOpts, scale(el.figGames, FIG_W.games), STYLE),
    ]);
    if (token !== drawing) return;

    // the likeliest single outcome: who, in how many
    let best = { p: -1 };
    for (let g = res.need; g <= sel.games; g++) {
      if (res.higher[g] > best.p) best = { p: res.higher[g], team: h, g };
      if (res.lower[g] > best.p) best = { p: res.lower[g], team: l, g };
    }
    const stats = [
      [`${h.name} xWin%`, pct(h.xwin), `${h.rsg.toFixed(2)} RS/G · ${h.rag.toFixed(2)} RA/G · ${h.wins}-${h.losses}`, h.color],
      [`${l.name} xWin%`, pct(l.xwin), `${l.rsg.toFixed(2)} RS/G · ${l.rag.toFixed(2)} RA/G · ${l.wins}-${l.losses}`, l.color],
      [`${h.name} win, best of ${sel.games}`, pct(res.win), `likeliest: ${best.team.name} in ${best.g} (${pct(best.p)})`, null],
    ];
    el.stats.replaceChildren(...stats.map(([label, value, sub, colour]) => {
      const div = document.createElement("div");
      div.className = "stat";
      const s = document.createElement("span");
      if (colour) { const i = document.createElement("i"); i.style.background = colour; s.append(i); }
      s.append(label);
      const b = document.createElement("b"); b.textContent = value;
      const sm = document.createElement("span"); sm.textContent = sub;
      div.append(s, b, sm);
      return div;
    }));
    el.summary.textContent = `The ${h.name} are expected to beat the ${l.name} ~${pct(p)} of the time at a neutral site, based on their regular season runs scored and allowed. Home Field Advantage is assumed to be worth ~${Math.round(S.HFA * 100)}%.`;
    drawn = { sel, line, res, figOpts };
    history.replaceState(null, "", hashOf(sel));
    status("");
  }

  // ---- the link ----------------------------------------------------------------------

  function parseHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return null;
    const [head, ...rest] = h.split("&");
    const [yr, hi, lo] = head.split("-");
    const q = new URLSearchParams(rest.join("&"));
    return { season: Number(yr) || null, higher: hi, lower: lo, games: Number(q.get("games")) || null, home: q.get("home") === "1" };
  }
  const hashOf = (sel) => `#${sel.season}-${sel.higher.code}-${sel.lower.code}&games=${sel.games}` + (sel.allHome ? "&home=1" : "");

  // ---- downloads: the figures at 2x (400 dpi) ------------------------------------------

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function download(which) {
    if (!drawn) return;
    const d = drawn, c = document.createElement("canvas");
    await S.render(which, c, which === "length" ? d.line : d.res, d.figOpts, 2, STYLE);
    const stem = `${d.sel.season}_${d.sel.higher.code}_${d.sel.lower.code}`.toLowerCase();
    const name = which === "length" ? `series_win_${stem}` : `series_outcomes_${stem}_bo${d.sel.games}`;
    c.toBlob((b) => save(b, `${name}${d.sel.allHome ? "_all_home" : ""}.png`), "image/png");
  }

  // ---- wiring ------------------------------------------------------------------------

  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    higher.hide(); lower.hide();
    run();
  });
  el.season.addEventListener("change", async () => {
    if (await setSeason(Number(el.season.value))) run();
    else if (season) el.season.value = String(season);
  });
  el.games.addEventListener("change", run);
  el.home.addEventListener("change", run);
  el.swap.addEventListener("click", () => {
    const h = higher.team;
    higher.set(lower.team); lower.set(h);
    run();
  });
  el.dlLength.addEventListener("click", () => download("length"));
  el.dlGames.addEventListener("click", () => download("games"));
  let resizeTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawn && run(), 150); });
  window.addEventListener("hashchange", () => {
    if (drawn && hashOf(drawn.sel) === location.hash) return;
    init();
  });

  async function init() {
    const link = parseHash() || {};
    if (link.games && link.games % 2 && link.games >= 3 && link.games <= S.MAX_LEN) el.games.value = String(link.games);
    el.home.value = link.home ? "all" : "split";
    const pick = { higher: link.higher, lower: link.lower };
    let year = link.season && link.season >= FIRST_SEASON && link.season <= THIS_YEAR ? link.season : THIS_YEAR;
    if (!(await setSeason(year, pick))) {
      // before opening day there are no games this year: open on the last season
      if (link.season || year !== THIS_YEAR) return;
      year = THIS_YEAR - 1;
      if (!(await setSeason(year, pick))) return;
    }
    run();
  }

  for (let y = THIS_YEAR; y >= FIRST_SEASON; y--) el.season.append(new Option(String(y), String(y)));
  for (let n = 3; n <= S.MAX_LEN; n += 2) el.games.append(new Option(String(n), String(n), n === 7, n === 7));
  init();
})();
