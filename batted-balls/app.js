// The Batted Ball Charts page: season, hitter (or team), a switch hitter's side, view
// and comparison controls over the chart in chart.js. The data is two JSON files per visit from
// the bucket -- the seasons built and one season's batted balls with its league
// grid -- produced by tools/batted_balls/build_data.py, and a third, the 3D xwOBA
// model's surface, the first time the xwOBA view is shown.

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $("form"), season: $("season"), teamWide: $("team_wide"), player: $("player"),
    playerLabel: $("player_label"), suggest: $("suggest"), team: $("team"), teamLabel: $("team_label"),
    status: $("status"), out: $("out"), fig: $("fig"), note: $("note"), copyPng: $("copy_png"),
    through: $("through"), views: $("views"), bats: $("bats"),
  };
  const vsInputs = () => [...document.querySelectorAll('input[name="vs"]')];
  const viewInputs = () => [...document.querySelectorAll('input[name="view"]')];
  const sideInputs = () => [...document.querySelectorAll('input[name="side"]')];
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const setRadio = (name, value) => { const r = document.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; };

  // The data lives in the bucket; ?data=<base> reads a local build instead
  // (python tools/batted_balls/build_data.py --out batted-balls/data, then ?data=data/).
  const params = new URLSearchParams(location.search);
  const DATA = new URL(params.get("data") || "https://data.blandalytics.com/", location.href).href;
  const DEFAULT_PLAYER = "Isaac Paredes";  // the app's default

  let index = null;             // { seasons: { "2026": {...} } }
  const seasons = new Map();    // season -> its file, once fetched
  let surface = null;           // the xwOBA surface's file, once fetched
  let current = null;           // { season, id|team, view, vs } of the chart shown
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

  async function loadSurface() {
    if (!surface) surface = fetchJson("batted-balls/xwoba.json").catch((e) => { surface = null; throw e; });
    return surface;
  }

  // Teams by their full names wherever the page shows one (the files, and links, use the
  // codes): Cleveland and Oakland as they were called that season
  const TEAMS = {
    ATH: "Athletics", ATL: "Atlanta Braves", AZ: "Arizona Diamondbacks", BAL: "Baltimore Orioles",
    BOS: "Boston Red Sox", CHC: "Chicago Cubs", CIN: "Cincinnati Reds", CLE: "Cleveland Guardians",
    COL: "Colorado Rockies", CWS: "Chicago White Sox", DET: "Detroit Tigers", HOU: "Houston Astros",
    KC: "Kansas City Royals", LAA: "Los Angeles Angels", LAD: "Los Angeles Dodgers", MIA: "Miami Marlins",
    MIL: "Milwaukee Brewers", MIN: "Minnesota Twins", NYM: "New York Mets", NYY: "New York Yankees",
    OAK: "Oakland Athletics", PHI: "Philadelphia Phillies", PIT: "Pittsburgh Pirates", SD: "San Diego Padres",
    SEA: "Seattle Mariners", SF: "San Francisco Giants", STL: "St. Louis Cardinals", TB: "Tampa Bay Rays",
    TEX: "Texas Rangers", TOR: "Toronto Blue Jays", WSH: "Washington Nationals",
  };
  const teamName = (code, season) => (code === "CLE" && season < 2022 ? "Cleveland Indians" : TEAMS[code] || code);
  // the Athletics' code changed with the move (OAK to 2024, ATH from 2025)
  const SAME_TEAM = { OAK: "ATH", ATH: "OAK" };

  const seasonList = () => Object.keys(index.seasons).map(Number).sort((a, b) => b - a);
  const hasPrior = (year) => Boolean(index.seasons[String(year - 1)]);
  // xwOBA needs bat speed on every ball, which the seasons from 2024 have (the index
  // marks them); the seasons before have no xwOBA views at all
  const hasXwoba = (year) => Boolean(index.seasons[String(year)]?.xwoba);
  const fmtXw = (v) => (v < 1 ? v.toFixed(3).slice(1) : v.toFixed(3));
  const fmtMargin = (v) => (v >= 0 ? "+" : "-") + fmtXw(Math.abs(v));

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

  // The field behaves as Model Drilldown's pitcher field does: clicking in after a pick
  // clears it and lists everyone; Enter takes the highlighted row, or the best match for
  // what's typed (or says there is none); a season change with the list open refreshes it.
  let active = -1, shown = [];
  function showSuggestions() {
    shown = suggestions(el.player.value).slice(0, 400);
    active = -1;
    el.suggest.replaceChildren(...shown.map((h, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      const name = document.createElement("span"); name.textContent = h.name;
      const meta = document.createElement("small"); meta.textContent = `${teamName(h.team, Number(el.season.value))} · ${h.bbe.length} BBE`;
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
    committed = true;
    hideSuggestions();
    syncControls();
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

  // The xwOBA and value views have no comparison: one draws the hitter's own
  // surface, the other is already measured against MLB.
  function selection() {
    const year = Number(el.season.value);
    const teamWide = el.teamWide.checked;
    const view = hasXwoba(year) ? radio("view") : "balls";
    return {
      season: year,
      team: teamWide ? el.team.value : null,
      id: teamWide ? null : chosen?.id ?? null,
      view,
      vs: teamWide || view !== "balls" || !hasPrior(year) ? "league" : radio("vs"),
      side: !teamWide && isSwitch(chosen) ? radio("side") || chosen.stand : null,
    };
  }

  function hash(sel) {
    const who = sel.team || sel.id;
    return `#${sel.season}-${who}` + (sel.side ? `-${SIDE_NAME[sel.side].toLowerCase()}` : "")
      + (sel.vs === "self" ? "-self" : "") + (sel.view !== "balls" ? `-${sel.view}` : "");
  }

  function parseHash() {
    // (-continuous / -discrete are accepted from older links and ignored)
    const m = /^#(\d{4})-([A-Za-z0-9]+)((?:-(?:continuous|discrete|self|league|xwoba|value|left|right))*)$/.exec(location.hash);
    if (!m) return null;
    const flags = m[3].split("-");
    return {
      season: Number(m[1]),
      who: m[2],
      vs: flags.includes("self") ? "self" : "league",
      view: flags.includes("xwoba") ? "xwoba" : flags.includes("value") ? "value" : "balls",
      side: flags.includes("left") ? "L" : flags.includes("right") ? "R" : null,
    };
  }

  // A switch hitter's file carries the side each ball was hit from (`sides`, a letter a
  // ball), and their chart is drawn for one side at a time; anyone else's balls are all
  // from their usual side, `stand`. Spray is measured from the pull side of the side
  // batted from, so either side's balls sit against the same league grid.
  const SIDE_NAME = { L: "Left", R: "Right" }, HITTER = { L: "LHH", R: "RHH" };
  const isSwitch = (p) => Boolean(p?.sides);
  function sideBalls(p, side) {
    if (!side) return p.bbe;
    if (p.sides) return p.bbe.filter((_, i) => p.sides[i] === side);
    return p.stand === side ? p.bbe : [];
  }
  // " (LHH)" after the chart's name in the subtitle, and "LHH" before "batted balls" in
  // the note
  const battingTitle = (sel) => (sel.side ? ` (${HITTER[sel.side]})` : "");
  const ballsNote = (n, sel) => (sel.team ? `${n} batted balls by ${teamName(sel.team, sel.season)} hitters`
    : `${n} ${sel.side ? `${HITTER[sel.side]} ` : ""}batted balls`);
  const drawKey = (sel, season = sel.season) => `${season}:${sel.team || sel.id}${sel.side || ""}`;

  // Every ball hit for a team: a hitter's stints say which of their balls (in date
  // order) were hit for which team, so a traded hitter's count for each club only while
  // they were on it. A file built before stints counts a hitter for their last team.
  function teamBalls(data, team) {
    const out = [];
    for (const p of data.players) {
      let i = 0;
      for (const [t, n] of p.stints || [[p.team, p.bbe.length]]) {
        if (t === team) out.push(...p.bbe.slice(i, i + n));
        i += n;
      }
    }
    return out;
  }

  // Backing pixels per chart pixel for the on-screen canvas: its displayed width at the
  // screen's pixel ratio (the figure is at most 820 CSS px wide), never more than the 2 the
  // Copy PNG uses. A 1x laptop draws ~820 px wide instead of 2780.
  function screenScale() {
    const css = Math.min(820, el.fig.clientWidth || document.querySelector("main").clientWidth || 820);
    return Math.min(2, (css * (window.devicePixelRatio || 1)) / BattedBalls.W);
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
        hitter = teamBalls(data, sel.team);
        name = teamName(sel.team, sel.season); hand = "R";
      } else {
        const p = data.players.find((x) => x.id === sel.id);
        if (!p) { status("that hitter has no batted balls this season", "warn"); return; }
        hitter = sideBalls(p, sel.side); name = p.name; hand = sel.side || p.stand;
      }
      if (sel.view === "xwoba") return await showXwoba(sel, data, hitter, name, hand, ticket);
      if (sel.view === "value") return await showValue(sel, data, hitter, name, hand, ticket);
      let prior = null;
      if (sel.vs === "self") {
        const before = await loadSeason(sel.season - 1);
        const p = before.players.find((x) => x.id === sel.id);
        prior = p ? sideBalls(p, sel.side) : [];
        if (!prior.length) {
          status(`No data on ${name}${battingTitle(sel)} for ${sel.season - 1}`, "warn");
          el.out.hidden = true; return;
        }
      }
      if (ticket !== drawing) return;
      const result = BattedBalls.compute({
        hitter, league: data.league, prior,
        key: drawKey(sel), priorKey: prior ? drawKey(sel, sel.season - 1) : null,
      });
      if (!result) { status(`not enough batted balls to draw a density (${hitter.length})`, "warn"); el.out.hidden = true; return; }
      // the hitter is the title; what the chart shows goes in the subtitle, as on
      // the Swing Profiles figure
      const opts = {
        hand, view: "balls", signed: Boolean(prior),
        title: name,
        subtitle: prior
          ? `Batted Ball Difference${battingTitle(sel)}\n${sel.season} compared to ${sel.season - 1}`
          : `${sel.season} Batted Ball Profile${battingTitle(sel)}\nCompared to the rest of MLB`,
      };
      if (!(await drawn(result, opts, sel, name, ticket))) return;
      const n = hitter.length, m = prior ? prior.length : null;
      el.note.textContent = prior
        ? `${ballsNote(n, sel)} in ${sel.season}, ${m} in ${sel.season - 1}. Percentages are ${sel.season} minus ${sel.season - 1}.`
        : `${ballsNote(n, sel)}, regular season, through ${data.through}. The league grid is every MLB batted ball in ${sel.season}.`;
      history.replaceState(null, "", hash(sel));
      status("");
    } catch (e) {
      console.error(e);
      status(`could not draw: ${e.message}`, "err");
    }
  }

  // Render, unless a newer drawing has started; true when this one is on screen.
  async function drawn(result, opts, sel, name, ticket) {
    const scale = screenScale();
    await BattedBalls.render(el.fig, result, opts, scale);
    if (ticket !== drawing) return false;
    current = { ...sel, name, result, opts, scale };
    el.out.hidden = false;
    return true;
  }

  // The xwOBA view: the model's surface at the average bat speed of the balls drawn,
  // and the model's xwOBA of those balls by zone.
  async function showXwoba(sel, data, hitter, name, hand, ticket) {
    const surf = await loadSurface();
    if (ticket !== drawing) return;
    const result = BattedBalls.computeXwoba({ balls: hitter, surface: surf });
    if (!result) { status("no tracked swings among these batted balls", "warn"); el.out.hidden = true; return; }
    const mph = `${result.batSpeed.toFixed(1)} mph`;
    const opts = {
      hand, view: "xwoba",
      title: name,
      subtitle: `${sel.season} xwOBA${battingTitle(sel)}\n${mph} Bat Speed ➔ ${fmtXw(result.xwoba)} xwOBA`,
    };
    if (!(await drawn(result, opts, sel, name, ticket))) return;
    const lg = data.xwoba;
    el.note.textContent = `${ballsNote(hitter.length, sel)}, regular season, through ${data.through}; `
      + `${result.tracked} with a tracked swing (bunts and untracked swings have no xwOBA). `
      + `The surface is the model's xwOBA at a ${mph} swing, the average on these balls; `
      + `the boxes and the figures along the axes are the model's xwOBA of the balls hit into each zone, each at its own bat speed. `
      + `MLB in ${sel.season}: ${lg.bat_speed.toFixed(1)} mph, ${fmtXw(lg.xwoba)} xwOBA on contact.`;
    history.replaceState(null, "", hash(sel));
    status("");
  }

  // The value view: the hitter's batted balls weighted by xwOBA against MLB's off swings
  // as fast as theirs, weighted the same way. MLB's balls are every tracked ball in the
  // season file, gathered once per season.
  const leagueBalls = new WeakMap();
  function trackedBalls(data) {
    if (!leagueBalls.has(data)) leagueBalls.set(data, data.players.flatMap((p) => p.bbe.filter(BattedBalls.tracked)));
    return leagueBalls.get(data);
  }

  async function showValue(sel, data, hitter, name, hand, ticket) {
    const result = BattedBalls.computeValue({ balls: hitter, league: trackedBalls(data), key: drawKey(sel) });
    if (!result) { status(`not enough tracked swings to draw a density (${hitter.length} batted balls)`, "warn"); el.out.hidden = true; return; }
    const mph = `${result.batSpeed.toFixed(1)} mph`;
    const opts = {
      hand, view: "value",
      title: name,
      subtitle: `${sel.season} Batted Ball Directional Value${battingTitle(sel)}\n${fmtMargin(result.total)} xwOBA vs Comparable Bat Speeds`,
    };
    if (!(await drawn(result, opts, sel, name, ticket))) return;
    el.note.textContent = `${ballsNote(hitter.length, sel)}, regular season, through ${data.through}; `
      + `${result.tracked} with a tracked swing (bunts and untracked swings have no xwOBA), averaging ${mph}. `
      + `Each is weighted by its xwOBA and set against MLB's batted balls off swings as fast as its own, weighted the same way and spread with the same kernels: `
      + `red is where these balls get more xwOBA than MLB's hitters get swinging that hard, blue where MLB's get more. `
      + `The boxes and the figures along the axes are each zone's part of the ${fmtMargin(result.total)}: `
      + `${fmtXw(result.hitterXwoba)} xwOBA on contact against MLB's ${fmtXw(result.leagueXwoba)} at the same bat speeds.`;
    history.replaceState(null, "", hash(sel));
    status("");
  }

  // ---- controls -----------------------------------------------------------------------
  function syncControls() {
    const year = Number(el.season.value);
    const teamWide = el.teamWide.checked;
    el.playerLabel.hidden = teamWide;
    el.teamLabel.hidden = !teamWide;
    // a season without bat speed has only the batted-ball chart, so no view switch
    const tracked = hasXwoba(year);
    el.views.hidden = !tracked;
    if (!tracked) setRadio("view", "balls");
    // a team chart is always against the league, as in the app; the xwOBA views have
    // no comparison
    const xw = radio("view") !== "balls";
    const prior = hasPrior(year);
    vsInputs().forEach((r) => { r.disabled = teamWide || xw || (!prior && r.value === "self"); });
    if (teamWide || xw || !prior) setRadio("vs", "league");
    // a switch hitter's chart is for one side, the one they bat from most until another
    // is picked; the pick holds from one switch hitter to the next
    el.bats.hidden = teamWide || !isSwitch(chosen);
    if (el.bats.hidden) sideInputs().forEach((r) => { r.checked = false; });
    else if (!radio("side")) setRadio("side", chosen.stand);
  }

  async function switchSeason(year, keep = true) {
    status("loading the season…");
    const data = await loadSeason(year);
    setHitters(data);
    el.team.replaceChildren(...data.teams.map((t) => new Option(teamName(t, year), t))
      .sort((a, b) => a.text.localeCompare(b.text)));
    const was = keep && current?.team ? [current.team, SAME_TEAM[current.team]].find((t) => data.teams.includes(t)) : null;
    if (was) el.team.value = was;
    else if (!keep || !el.team.value) el.team.value = data.teams.includes("CLE") ? "CLE" : data.teams[0];
    const same = keep && chosen ? hitters.find((h) => h.id === chosen.id) : null;
    chosen = same || hitters.find((h) => h.name === DEFAULT_PLAYER) || suggestions("")[0] || null;
    if (el.suggest.hidden) {
      el.player.value = chosen ? chosen.name : "";
      committed = true;
    } else showSuggestions();
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
      setRadio("vs", link.vs); setRadio("view", link.view);
      sideInputs().forEach((r) => { r.checked = r.value === link.side; });
      syncControls();
    }
    show();
  }

  el.season.addEventListener("change", async () => { await switchSeason(Number(el.season.value)); show(); });
  el.teamWide.addEventListener("change", () => { syncControls(); show(); });
  el.team.addEventListener("change", show);
  vsInputs().forEach((r) => r.addEventListener("change", show));
  sideInputs().forEach((r) => r.addEventListener("change", show));
  viewInputs().forEach((r) => r.addEventListener("change", () => { syncControls(); show(); }));
  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    hideSuggestions();
    const hit = suggestions(el.player.value)[0];
    if (!hit) { status("no hitter by that name this season", "warn"); return; }
    pick(hit);
  });

  el.player.addEventListener("input", () => { committed = false; showSuggestions(); });
  el.player.addEventListener("focus", startSearch);
  el.player.addEventListener("click", startSearch);
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
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(shown[active]); }
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

  // Copy PNG puts the figure on the clipboard, drawn fresh at 2x whatever the screen
  // needed. The ClipboardItem is made inside the click with the image still to come, as
  // Safari requires; a browser that can't copy an image gets the file to save instead.
  function pngName(shot) {
    const who = (shot.name || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const what = { xwoba: "xwoba", value: "batted_ball_value" }[shot.view] || "batted_balls";
    const side = shot.side ? `_${HITTER[shot.side]}` : "";
    return `${who}_${shot.season}_${what}${side}${shot.vs === "self" ? `_vs_${shot.season - 1}` : ""}.png`;
  }
  function savePng(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  let copiedTimer = null;
  el.copyPng.addEventListener("click", async () => {
    if (!current) return;
    const shot = current, png = document.createElement("canvas");
    const blob = BattedBalls.render(png, shot.result, shot.opts, 2)
      .then(() => new Promise((resolve) => png.toBlob(resolve, "image/png")));
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("no image clipboard");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      el.copyPng.textContent = "Copied";
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { el.copyPng.textContent = "Copy PNG"; }, 1500);
    } catch (e) {
      console.warn("copy failed, saving instead:", e);
      savePng(await blob, pngName(shot));
    }
  });

  // A wider window or a move to a sharper screen: redraw the chart just drawn (no
  // recomputing) once the canvas would otherwise be stretched.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!current || el.out.hidden) return;
      const scale = screenScale();
      if (scale > current.scale * 1.15) {
        current.scale = scale;
        BattedBalls.render(el.fig, current.result, current.opts, scale);
      }
    }, 200);
  });

  window.addEventListener("hashchange", () => {
    const link = parseHash();
    if (!link || (current && hash(current) === location.hash)) return;
    init();
  });

  init().catch((e) => { console.error(e); status(`could not load: ${e.message}`, "err"); });
})();
