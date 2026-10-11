// The page: pick a season, a player and a bat side; Swing does the pipeline, SwingPlot
// draws it. A profile is linkable as #<mlbam id>-<season>-<L|R>.

(() => {
  "use strict";

  const FIRST_SEASON = 2024;  // bat tracking begins in 2024
  const DEFAULT_PLAYER = "Junior Caminero";  // shown on arrival, latest season, his main side

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $("form"), season: $("season"), player: $("player"), hand: $("hand"), go: $("go"),
    suggest: $("suggest"), status: $("status"),
    out: $("out"), fig: $("fig"), stats: $("stats"), notes: $("notes"),
    dlPng: $("dl_png"), dlCsv: $("dl_csv"), otherSide: $("other_side"),
    savantLink: $("savant_link"), cardLink: $("card_link"), cardImg: $("card_img"),
  };

  let leaderboard = null;   // rows for the selected season
  let distribution = null;  // the season's swing-profiles/data/<year>.json, or null
  let hitters = [];         // one entry per player, for the suggestion list
  let profile = null;       // the profile on screen
  let cardObjectUrl = null;
  let running = false;

  const status = (text, cls = "") => { el.status.textContent = text; el.status.className = `status ${cls}`.trim(); };

  // ---- season and leaderboard --------------------------------------------

  function fillSeasons() {
    const latest = new Date().getFullYear();
    for (let y = latest; y >= FIRST_SEASON; y--) {
      const o = document.createElement("option");
      o.value = o.textContent = String(y);
      el.season.appendChild(o);
    }
  }

  async function loadLeaderboard(year) {
    el.go.disabled = true;
    leaderboard = null;
    status(`loading the ${year} leaderboard…`);
    try {
      [leaderboard, distribution] = await Promise.all([Swing.fetchBatTracking(year), loadDistribution(year)]);
    } catch (e) {
      status(`could not load the ${year} bat-tracking leaderboard: ${e.message}`, "err");
      return false;
    }
    // One entry per player; a switch hitter is listed once, both sides reachable
    // through the Bats control (or the "Other side" button once one is drawn).
    const byId = new Map();
    for (const r of leaderboard) {
      const h = byId.get(r.id) || { id: r.id, name: Swing.displayName(r.name), keys: Swing.nameKeys(r.name), sides: [], sideSwings: {}, swings: 0 };
      h.sides.push(r.bat_side);
      h.sideSwings[r.bat_side] = r.swings_competitive || 0;
      h.swings += r.swings_competitive || 0;
      byId.set(r.id, h);
    }
    hitters = [...byId.values()].map((h) => {
      const k = h.name.lastIndexOf(" ");
      const sides = ["L", "R"].filter((x) => h.sides.includes(x));
      const main = sides.reduce((a, b) => (h.sideSwings[b] > h.sideSwings[a] ? b : a));
      return { ...h, sides, main, full: Swing.normalize(h.name), last: Swing.normalize(k < 0 ? h.name : h.name.slice(k + 1)) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    hideSuggestions();
    setSides(exactHitter(), el.hand.value);  // same hitter in a new season keeps the side
    if (!leaderboard.length) {
      status(`no bat-tracking data for ${year} yet`, "warn");
      return false;
    }
    status(`${hitters.length} hitters, ${leaderboard.length} player-sides · ${year}`);
    el.go.disabled = false;
    return true;
  }

  // ---- the season's distributions ----------------------------------------------

  // swing-profiles/data/<year>.json: the page's three numbers for every hitter
  // and bat side with a card that season, built nightly by
  // .github/workflows/swing-profiles.yml. Missing (not built yet) is fine.
  const distributionCache = new Map();
  async function loadDistribution(year) {
    if (distributionCache.has(year)) return distributionCache.get(year);
    let dist = null;
    try {
      const resp = await fetch(`data/${year}.json`);
      if (resp.ok) {
        const raw = await resp.json();
        const col = Object.fromEntries(raw.columns.map((c, i) => [c, i]));
        dist = { season: raw.season, built: raw.built, rows: raw.rows.map((r) => ({
          id: r[col.id], hand: r[col.hand], impact_mph: r[col.impact_mph], duration_ms: r[col.duration_ms], peak_accel_g: r[col.peak_accel_g],
        })) };
      }
    } catch (e) { dist = null; }
    distributionCache.set(year, dist);
    return dist;
  }

  // Gaussian KDE with Scott's bandwidth -- scipy's gaussian_kde default, which
  // swing_plot.plot_peak_time_kde uses too.
  function kde(values, grid) {
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const bw = sd * n ** (-1 / 5);
    const norm = n * bw * Math.sqrt(2 * Math.PI);
    return { bw, density: grid.map((x) => values.reduce((a, v) => a + Math.exp(-0.5 * ((x - v) / bw) ** 2), 0) / norm) };
  }

  // The KDE of one metric over everyone else that season, with this hitter's
  // value marked: a dashed drop line, a dot on the curve, and the area up to it
  // tinted so the eye reads how much of the league sits below. Colours are the
  // figure's own: bat speed in the velocity blue, acceleration in the gold, and
  // duration in the jerk white.
  function kdeSvg(values, x, color, decimals = 0) {
    const W = 260, H = 66, top = 7, bottom = 16, left = 7, right = 7;
    const dx = kde(values, [x]).density[0];  // the curve's height at this hitter
    // The curve spans the observed data and no further: the league's extremes,
    // or this hitter's own value where it lies beyond them.
    const lo = Math.min(Math.min(...values), x), hi = Math.max(Math.max(...values), x);
    const N = 121;
    const grid = Array.from({ length: N }, (_, i) => lo + (i * (hi - lo)) / (N - 1));
    const dens = kde(values, grid).density;
    const ymax = Math.max(...dens, dx);
    const sx = (v) => left + ((v - lo) / (hi - lo)) * (W - left - right);
    const sy = (d) => top + (1 - d / ymax) * (H - top - bottom);
    const pts = grid.map((g, i) => `${sx(g).toFixed(1)},${sy(dens[i]).toFixed(1)}`);
    const upTo = grid.findIndex((g) => g > x);
    const y0 = sy(0), yx = sy(dx);
    const belowPts = (upTo < 0 ? pts : pts.slice(0, upTo)).concat([`${sx(x).toFixed(1)},${yx.toFixed(1)}`]);
    const ticks = SwingPlot.tickValues(lo, hi, 5).ticks;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "kde");
    svg.setAttribute("role", "img");
    const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
    add("path", { class: "below", fill: color, d: `M${sx(lo).toFixed(1)},${y0.toFixed(1)} L${belowPts.join(" L")} L${sx(x).toFixed(1)},${y0.toFixed(1)} Z` });
    add("line", { class: "base", x1: left, x2: W - right, y1: y0, y2: y0 });
    for (const t of ticks) {
      add("line", { class: "tick", x1: sx(t), x2: sx(t), y1: y0, y2: y0 + 3 });
      add("text", { x: sx(t), y: H - 3, "text-anchor": "middle" }, t.toFixed(decimals));
    }
    add("path", { class: "curve", stroke: color, d: `M${pts.join(" L")}` });
    add("line", { class: "mark", stroke: color, x1: sx(x), x2: sx(x), y1: y0, y2: yx });
    add("circle", { class: "dot", fill: color, cx: sx(x), cy: yx, r: 5 });
    const pct = Math.round((100 * values.filter((v) => v < x).length) / values.length);
    svg.setAttribute("aria-label", `${pct}th percentile of ${values.length} hitters`);
    return svg;
  }

  // ---- the Bats control ------------------------------------------------------

  const hitterById = (id) => hitters.find((h) => h.id === Number(id)) || null;
  const exactHitter = () => { const q = Swing.normalize(el.player.value); return q ? hitters.find((h) => h.full === q) || null : null; };

  // Offer only the sides this hitter has on the season's leaderboard -- the only
  // ones a card can exist for. Until a hitter is known, both. `preferred` wins
  // when the hitter has it; otherwise the side they swing from most.
  let narrowedId = null;
  function setSides(h, preferred) {
    const sides = h ? h.sides : ["L", "R"];
    narrowedId = h ? h.id : null;
    el.hand.replaceChildren(...sides.map((x) => new Option(x === "L" ? "Left" : "Right", x)));
    el.hand.value = sides.includes(preferred) ? preferred : (h ? h.main : sides[0]);
    return el.hand.value;
  }

  // While typing or picking, a newly identified hitter starts on their main side
  // and the same hitter keeps the current choice. A link or a run passes its
  // side explicitly instead.
  const preferredFor = (h) => (!h || h.id === narrowedId ? el.hand.value : null);

  // ---- player suggestions --------------------------------------------------

  // Every hitter matching what has been typed -- a prefix of the full name first,
  // then of the surname, then any substring -- matched with the same accent- and
  // punctuation-folding the resolver uses. Nothing typed yet lists everyone, the
  // regulars first (most competitive swings, who are sure to have a card). The
  // list shows ten rows and scrolls through the rest.
  function suggestions(query) {
    const q = Swing.normalize(query);
    if (!q) return hitters.slice().sort((a, b) => b.swings - a.swings || a.name.localeCompare(b.name));
    const scored = [];
    for (const h of hitters) {
      let score;
      if (h.full.startsWith(q)) score = 0;
      else if (h.last.startsWith(q)) score = 1;
      else if (h.full.includes(q) || String(h.id).startsWith(q)) score = 2;
      else if ([...h.keys].some((k) => k.includes(q))) score = 3;
      else continue;
      scored.push([score, h]);
    }
    scored.sort((a, b) => a[0] - b[0] || b[1].swings - a[1].swings);
    return scored.map((x) => x[1]);
  }

  let active = -1;
  let shown = [];

  function showSuggestions() {
    shown = hitters.length ? suggestions(el.player.value) : [];
    active = -1;
    el.suggest.replaceChildren(...shown.map((h, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      const name = document.createElement("span"); name.textContent = h.name;
      const side = document.createElement("small");
      side.textContent = h.sides.length > 1 ? "switch" : `bats ${h.sides[0]}`;
      li.append(name, side);
      return li;
    }));
    el.suggest.hidden = !shown.length;
    el.player.setAttribute("aria-expanded", shown.length ? "true" : "false");
  }

  function hideSuggestions() {
    el.suggest.hidden = true;
    el.player.setAttribute("aria-expanded", "false");
    shown = [];
    active = -1;
  }

  function setActive(i) {
    active = i;
    [...el.suggest.children].forEach((li, k) => li.classList.toggle("active", k === i));
    if (i >= 0) el.suggest.children[i].scrollIntoView({ block: "nearest" });
  }

  // Once a profile is drawn the field holds its name. Clicking or tabbing into the
  // field then clears it, so the list opens on everyone and the first keystroke
  // starts a new search; the drawn profile stays. A click while mid-search (to move
  // the caret) leaves the text alone, and leaving the field empty puts the name back.
  let committed = false;
  function setPlayer(name) {
    el.player.value = name;
    committed = true;
  }
  function startSearch() {
    if (committed) { el.player.value = ""; committed = false; }
    showSuggestions();
  }

  // A pick is unambiguous, so it runs by id rather than back through the name match.
  function pick(h) {
    hideSuggestions();
    setPlayer(h.name);
    run(String(h.id), Number(el.season.value), setSides(h, preferredFor(h)));
  }

  // ---- running the pipeline ----------------------------------------------

  async function run(player, year, hand) {
    if (running) return;
    running = true;
    el.go.disabled = true;
    try {
      if (!leaderboard || Number(el.season.value) !== Number(year)) {
        el.season.value = String(year);
        if (!(await loadLeaderboard(year))) return;
      }
      let ref;
      try {
        ref = Swing.resolvePlayer(player, year, hand || null, leaderboard);
      } catch (e) {
        if (!hand || !(e instanceof Swing.SavantError) || e instanceof Swing.AmbiguousPlayerError) throw e;
        ref = Swing.resolvePlayer(player, year, null, leaderboard);
      }
      const side = setSides(hitterById(ref.mlbam_id), hand);
      status(`fetching the ${year} card for ${ref.name ? Swing.displayName(ref.name) : ref.mlbam_id} (${side})…`);
      const p = await Swing.getSwingProfile(ref.mlbam_id, year, side, { leaderboard });
      profile = p;
      await render();
      const key = `${p.mlbam_id}-${p.year}-${p.handedness}`;
      history.replaceState(null, "", `#${key}`);
      setPlayer(p.display_name || String(p.mlbam_id));
      setSides(hitterById(p.mlbam_id), p.handedness);
      const sides = leaderboard.filter((r) => r.id === p.mlbam_id).map((r) => r.bat_side);
      const other = sides.find((s) => s !== p.handedness);
      el.otherSide.hidden = !other;
      if (other) {
        el.otherSide.textContent = `Other side (${other})`;
        el.otherSide.dataset.side = other;
      }
      status(p.warning ? p.warning : ``, p.warning ? "warn" : "");
      // status(p.warning ? p.warning : `${p.display_name || p.mlbam_id}, ${p.year} (${p.handedness}HB)`, p.warning ? "warn" : "");
    } catch (e) {
      status(e.message || String(e), "err");
      if (!(e instanceof Swing.SavantError)) console.error(e);
    } finally {
      running = false;
      el.go.disabled = !leaderboard || !leaderboard.length;
    }
  }

  async function render() {
    if (!profile) return;
    const p = profile;
    const { peak, warnings } = await SwingPlot.plotSwingKinematics(p, { canvas: el.fig });
    el.out.hidden = false;

    const t = p.timing, d = p.data;
    const f = (x, n = 1) => x.toFixed(n);
    const signed = (x, n) => { const s = Math.abs(x).toFixed(n); return Number(s) === 0 ? s : (x < 0 ? "−" : "+") + s; };
    const theme = SwingPlot.THEMES.pitcherlist;
    // Everyone else that season -- this hitter's own row is left out.
    const others = distribution && distribution.rows.filter((r) => !(r.id === p.mlbam_id && r.hand === p.handedness));
    const stats = [
      ["Bat speed at contact", `${f(p.impact_mph)} mph`, `Statcast: ${f(t.leaderboard_bat_speed_mph, 2)} (${signed(t.speed_check_mph, 2)})`, !t.speed_check_ok, "impact_mph", p.impact_mph, theme.velocity],
      ["Imputed swing duration", `~${f(p.duration_ms, 0)} ms`, `${f(t.swing_length_ft, 2)} ft / ${f(t.mean_bat_speed_mph)} mph mean`, false, "duration_ms", p.duration_ms, theme.jerk],
      ["Peak acceleration", `~${f(d.acceleration[peak])} g`, `at ${f(d.swing_time[peak], 0)} ms`, false, "peak_accel_g", d.acceleration[peak], theme.accel],
    ];
    el.stats.replaceChildren(...stats.map(([label, value, sub, warn, key, x, color]) => {
      const div = document.createElement("div");
      div.className = warn ? "stat warn" : "stat";
      const s = document.createElement("span"); s.textContent = label;
      const b = document.createElement("b"); b.textContent = value;
      const sm = document.createElement("span"); sm.textContent = sub;
      div.append(s, b, sm);
      if (others && others.length >= 2) div.appendChild(kdeSvg(others.map((r) => r[key]), x, color));
      return div;
    }));

    const notes = [];
    if (!others) notes.push(`The ${p.year} league distributions haven't been built yet, so the charts under the numbers are missing.`);
    if (!t.speed_check_ok) {
      notes.push(`The card's impact speed and the leaderboard's average bat speed differ by ${f(Math.abs(t.speed_check_mph))} mph, more than the ${Swing.SPEED_CHECK_TOLERANCE} mph tolerance: the two sources may not describe the same swings, so the imputed duration is suspect.`);
    }
    notes.push(...warnings);
    el.notes.replaceChildren(...notes.map((n) => { const pEl = document.createElement("p"); pEl.className = "note"; pEl.textContent = n; return pEl; }));

    el.savantLink.href = `https://baseballsavant.mlb.com/savant-player/${p.mlbam_id}`;
    el.cardLink.href = p.card.url;
    if (cardObjectUrl) URL.revokeObjectURL(cardObjectUrl);
    cardObjectUrl = URL.createObjectURL(p.card.blob);
    el.cardImg.src = cardObjectUrl;
  }

  // ---- downloads ---------------------------------------------------------

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- wiring ------------------------------------------------------------

  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    hideSuggestions();
    const player = el.player.value.trim();
    if (!player) { status("type a player's name or MLBAM id", "warn"); return; }
    run(player, Number(el.season.value), el.hand.value);
  });
  el.season.addEventListener("change", () => loadLeaderboard(Number(el.season.value)));
  el.player.addEventListener("input", () => { committed = false; showSuggestions(); const h = exactHitter(); setSides(h, preferredFor(h)); });
  el.player.addEventListener("focus", startSearch);
  el.player.addEventListener("click", startSearch);  // the field keeps focus after a pick
  el.player.addEventListener("blur", () => setTimeout(() => {
    hideSuggestions();
    if (!el.player.value.trim() && profile) setPlayer(profile.display_name || String(profile.mlbam_id));
  }, 150));
  el.player.addEventListener("keydown", (e) => {
    if (el.suggest.hidden) {
      if (e.key === "ArrowDown") { e.preventDefault(); showSuggestions(); if (shown.length) setActive(0); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % shown.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + shown.length) % shown.length); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(shown[active]); }
    else if (e.key === "Escape") { hideSuggestions(); }
  });
  // pointerdown rather than click, and prevented, so the input keeps focus and
  // its blur does not close the list before the pick registers.
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
  el.otherSide.addEventListener("click", () => {
    if (profile) run(String(profile.mlbam_id), profile.year, el.otherSide.dataset.side);
  });
  el.dlPng.addEventListener("click", () => {
    if (!profile) return;
    el.fig.toBlob((b) => save(b, profile.filename()), "image/png");
  });
  el.dlCsv.addEventListener("click", () => {
    if (!profile) return;
    save(new Blob([Swing.profileCsv(profile)], { type: "text/csv" }), profile.filename("", "csv"));
  });

  function fromHash() {
    const m = /^#(\d+)-(\d{4})-([LR])$/i.exec(location.hash);
    return m ? { id: m[1], year: Number(m[2]), hand: m[3].toUpperCase() } : null;
  }
  window.addEventListener("hashchange", () => {
    const h = fromHash();
    if (h && !(profile && String(profile.mlbam_id) === h.id && profile.year === h.year && profile.handedness === h.hand)) {
      el.hand.value = h.hand;
      run(h.id, h.year, h.hand);
    }
  });

  (async () => {
    fillSeasons();
    const h = fromHash();
    if (h) {
      el.season.value = String(h.year);
      el.hand.value = h.hand;
      await run(h.id, h.year, h.hand);
      return;
    }
    // No link: the latest season with bat tracking, and the default hitter in it.
    for (const o of el.season.options) {
      el.season.value = o.value;
      if (await loadLeaderboard(Number(o.value))) break;
    }
    if (leaderboard && leaderboard.length) await run(DEFAULT_PLAYER, Number(el.season.value), "");
  })();
})();
