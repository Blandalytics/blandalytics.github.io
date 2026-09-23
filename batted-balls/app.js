// The Batted Ball Charts page: season, hitter (or team) and comparison controls
// over the chart in chart.js. The data is two JSON files per visit from the
// bucket -- the seasons built and one season's batted balls with its league
// grid -- produced by tools/batted_balls/build_data.py.

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $("form"), season: $("season"), teamWide: $("team_wide"), player: $("player"),
    playerLabel: $("player_label"), suggest: $("suggest"), team: $("team"), teamLabel: $("team_label"),
    status: $("status"), out: $("out"), fig: $("fig"), note: $("note"), dlPng: $("dl_png"),
    through: $("through"),
  };
  const vsInputs = () => [...document.querySelectorAll('input[name="vs"]')];
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const setRadio = (name, value) => { const r = document.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; };

  // The data lives in the bucket; ?data=<base> reads a local build instead
  // (python tools/batted_balls/build_data.py --out batted-balls/data, then ?data=data/).
  const params = new URLSearchParams(location.search);
  const DATA = new URL(params.get("data") || "https://data.blandalytics.com/", location.href).href;
  const DEFAULT_PLAYER = "Isaac Paredes";  // the app's default

  let index = null;             // { seasons: { "2026": {...} } }
  const seasons = new Map();    // season -> its file, once fetched
  let current = null;           // { season, id|team, vs } of the chart shown
  let chosen = null;            // the picked hitter, for the suggestion field

  function status(msg, kind = "") {
    el.status.textContent = msg;
    el.status.className = "status " + kind;
  }

  async function fetchJson(path) {
    const r = await fetch(DATA + path, { cache: "default" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }

  async function loadSeason(year) {
    if (!seasons.has(year)) seasons.set(year, fetchJson(`batted-balls/${year}.json`).catch((e) => { seasons.delete(year); throw e; }));
    return seasons.get(year);
  }

  const seasonList = () => Object.keys(index.seasons).map(Number).sort((a, b) => b - a);
  const hasPrior = (year) => Boolean(index.seasons[String(year - 1)]);

  // ---- the hitter field ------------------------------------------------------------
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  let hitters = [];  // this season's players, with folded names for matching

  function setHitters(data) {
    hitters = data.players.map((p) => ({ ...p, full: fold(p.name), last: fold(p.name.split(" ").slice(1).join(" ") || p.name) }));
  }

  // Prefix of the full name first, then of the surname, then any substring; nothing
  // typed lists everyone by batted balls, so the regulars come first.
  function suggestions(query) {
    const q = fold(query);
    if (!q) return hitters.slice().sort((a, b) => b.bbe.length - a.bbe.length || a.name.localeCompare(b.name));
    const scored = [];
    for (const h of hitters) {
      let score;
      if (h.full.startsWith(q)) score = 0;
      else if (h.last.startsWith(q)) score = 1;
      else if (h.full.includes(q) || String(h.id).startsWith(q)) score = 2;
      else continue;
      scored.push([score, h]);
    }
    scored.sort((a, b) => a[0] - b[0] || b[1].bbe.length - a[1].bbe.length);
    return scored.map((x) => x[1]);
  }

  let active = -1, shown = [];
  function showSuggestions() {
    shown = suggestions(el.player.value);
    active = -1;
    el.suggest.replaceChildren(...shown.map((h, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      const name = document.createElement("span"); name.textContent = h.name;
      const meta = document.createElement("small"); meta.textContent = `${h.team} · ${h.bbe.length} BBE`;
      li.append(name, meta);
      return li;
    }));
    el.suggest.hidden = !shown.length;
    el.player.setAttribute("aria-expanded", shown.length ? "true" : "false");
  }
  function hideSuggestions() {
    el.suggest.hidden = true;
    el.player.setAttribute("aria-expanded", "false");
    shown = []; active = -1;
  }
  function setActive(i) {
    active = i;
    [...el.suggest.children].forEach((li, k) => li.classList.toggle("active", k === i));
    if (i >= 0) el.suggest.children[i].scrollIntoView({ block: "nearest" });
  }
  function pick(h) {
    chosen = h;
    el.player.value = h.name;
    hideSuggestions();
    show();
  }
  // Clicking into the field clears it so the list opens on everyone; leaving it
  // empty puts the picked name back.
  let committed = true;
  function startSearch() {
    if (committed && el.player.value) { el.player.value = ""; committed = false; }
    showSuggestions();
  }

  // ---- the chart -----------------------------------------------------------------------

  function selection() {
    const year = Number(el.season.value);
    const teamWide = el.teamWide.checked;
    return {
      season: year,
      team: teamWide ? el.team.value : null,
      id: teamWide ? null : chosen?.id ?? null,
      vs: teamWide || !hasPrior(year) ? "league" : radio("vs"),
    };
  }

  function hash(sel) {
    const who = sel.team || sel.id;
    return `#${sel.season}-${who}` + (sel.vs === "self" ? "-self" : "");
  }

  function parseHash() {
    // (-continuous / -discrete are accepted from older links and ignored)
    const m = /^#(\d{4})-([A-Za-z0-9]+)((?:-(?:continuous|discrete|self|league))*)$/.exec(location.hash);
    if (!m) return null;
    return { season: Number(m[1]), who: m[2], vs: m[3].split("-").includes("self") ? "self" : "league" };
  }

  let drawing = 0;
  async function show() {
    const sel = selection();
    if (!sel.team && sel.id == null) return;
    const ticket = ++drawing;
    status("drawing…");
    try {
      const data = await loadSeason(sel.season);
      let hitter, name, hand;
      if (sel.team) {
        hitter = data.players.flatMap((p) => p.team === sel.team ? p.bbe : []);
        name = sel.team; hand = "R";
      } else {
        const p = data.players.find((x) => x.id === sel.id);
        if (!p) { status("that hitter has no batted balls this season", "warn"); return; }
        hitter = p.bbe; name = p.name; hand = p.stand;
      }
      let prior = null;
      if (sel.vs === "self") {
        const before = await loadSeason(sel.season - 1);
        const p = before.players.find((x) => x.id === sel.id);
        if (!p) { status(`No data on ${name} for ${sel.season - 1}`, "warn"); el.out.hidden = true; return; }
        prior = p.bbe;
      }
      if (ticket !== drawing) return;
      const result = BattedBalls.compute({ hitter, league: data.league, prior });
      if (!result) { status(`not enough batted balls to draw a density (${hitter.length})`, "warn"); el.out.hidden = true; return; }
      // the hitter is the title; what the chart shows goes in the subtitle, as on
      // the Swing Profiles figure
      const opts = {
        hand, signed: Boolean(prior),
        title: name,
        subtitle: prior
          ? `Batted Ball Difference, ${sel.season} compared to ${sel.season - 1}`
          : `${sel.season} Batted Ball Profile, compared to the rest of MLB`,
      };
      await BattedBalls.render(el.fig, result, opts);
      if (ticket !== drawing) return;
      current = { ...sel, name };
      el.out.hidden = false;
      const n = hitter.length, m = prior ? prior.length : null;
      el.note.textContent = prior
        ? `${n} batted balls in ${sel.season}, ${m} in ${sel.season - 1}. Percentages are ${sel.season} minus ${sel.season - 1}.`
        : `${n} batted balls${sel.team ? ` by ${sel.team} hitters` : ""}, regular season, through ${data.through}. The league grid is every MLB batted ball in ${sel.season}.`;
      history.replaceState(null, "", hash(sel));
      status("");
    } catch (e) {
      console.error(e);
      status(`could not draw: ${e.message}`, "err");
    }
  }

  // ---- controls -----------------------------------------------------------------------
  function syncControls() {
    const teamWide = el.teamWide.checked;
    el.playerLabel.hidden = teamWide;
    el.teamLabel.hidden = !teamWide;
    // a team chart is always against the league, as in the app
    const prior = hasPrior(Number(el.season.value));
    vsInputs().forEach((r) => { r.disabled = teamWide || (!prior && r.value === "self"); });
    if (teamWide || !prior) setRadio("vs", "league");
  }

  async function switchSeason(year, keep = true) {
    status("loading the season…");
    const data = await loadSeason(year);
    setHitters(data);
    el.team.replaceChildren(...data.teams.map((t) => new Option(t, t)));
    if (keep && current?.team && data.teams.includes(current.team)) el.team.value = current.team;
    else if (!keep || !el.team.value) el.team.value = data.teams.includes("CLE") ? "CLE" : data.teams[0];
    const same = keep && chosen ? hitters.find((h) => h.id === chosen.id) : null;
    chosen = same || hitters.find((h) => h.name === DEFAULT_PLAYER) || suggestions("")[0] || null;
    el.player.value = chosen ? chosen.name : "";
    committed = true;
    el.through.textContent = `Through ${data.through}`;
    syncControls();
    status("");
  }

  async function init() {
    status("loading…");
    index = await fetchJson("batted-balls/index.json");
    const years = seasonList();
    el.season.replaceChildren(...years.map((y) => new Option(String(y), String(y))));
    const link = parseHash();
    const year = link && index.seasons[String(link.season)] ? link.season : years[0];
    el.season.value = String(year);
    await switchSeason(year, false);
    if (link) {
      const data = await loadSeason(year);
      if (/^\d+$/.test(link.who)) {
        const h = hitters.find((x) => x.id === Number(link.who));
        if (h) { chosen = h; el.player.value = h.name; el.teamWide.checked = false; }
      } else if (data.teams.includes(link.who)) {
        el.teamWide.checked = true; el.team.value = link.who;
      }
      setRadio("vs", link.vs);
      syncControls();
    }
    show();
  }

  el.season.addEventListener("change", async () => { await switchSeason(Number(el.season.value)); show(); });
  el.teamWide.addEventListener("change", () => { syncControls(); show(); });
  el.team.addEventListener("change", show);
  vsInputs().forEach((r) => r.addEventListener("change", show));
  el.form.addEventListener("submit", (e) => { e.preventDefault(); if (shown.length) pick(shown[Math.max(active, 0)]); });

  el.player.addEventListener("input", () => { committed = false; showSuggestions(); });
  el.player.addEventListener("focus", startSearch);
  el.player.addEventListener("click", () => { if (el.suggest.hidden) startSearch(); });
  el.player.addEventListener("blur", () => setTimeout(() => {
    hideSuggestions();
    if (!el.player.value.trim() && chosen) { el.player.value = chosen.name; committed = true; }
  }, 150));
  el.player.addEventListener("keydown", (e) => {
    if (el.suggest.hidden) {
      if (e.key === "ArrowDown") { e.preventDefault(); showSuggestions(); if (shown.length) setActive(0); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % shown.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + shown.length) % shown.length); }
    else if (e.key === "Enter") { e.preventDefault(); pick(shown[Math.max(active, 0)]); }
    else if (e.key === "Escape") hideSuggestions();
  });
  el.suggest.addEventListener("pointerdown", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    e.preventDefault();
    pick(shown[Number(li.dataset.index)]);
  });
  el.suggest.addEventListener("pointermove", (e) => {
    const li = e.target.closest("li");
    if (li) setActive(Number(li.dataset.index));
  });

  el.dlPng.addEventListener("click", () => {
    if (!current) return;
    const who = (current.name || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const name = `${who}_${current.season}_batted_balls${current.vs === "self" ? `_vs_${current.season - 1}` : ""}.png`;
    el.fig.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  });

  window.addEventListener("hashchange", () => {
    const link = parseHash();
    if (!link || (current && hash(current) === location.hash)) return;
    init();
  });

  init().catch((e) => { console.error(e); status(`could not load: ${e.message}`, "err"); });
})();
