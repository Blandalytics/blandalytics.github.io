// The page: pick a season, a player and a bat side; Swing does the pipeline, SwingPlot
// draws it. A profile is linkable as #<mlbam id>-<season>-<L|R>.

(() => {
  "use strict";

  const FIRST_SEASON = 2024;  // bat tracking begins in 2024

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $("form"), season: $("season"), player: $("player"), hand: $("hand"), go: $("go"),
    players: $("players"), jerk: $("jerk"), status: $("status"),
    out: $("out"), fig: $("fig"), stats: $("stats"), notes: $("notes"),
    dlPng: $("dl_png"), dlCsv: $("dl_csv"), otherSide: $("other_side"),
    savantLink: $("savant_link"), cardLink: $("card_link"), cardImg: $("card_img"),
  };

  let leaderboard = null;   // rows for the selected season
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
      leaderboard = await Swing.fetchBatTracking(year);
    } catch (e) {
      status(`could not load the ${year} bat-tracking leaderboard: ${e.message}`, "err");
      return false;
    }
    // One datalist entry per player; a switch hitter is listed once, both sides
    // reachable through the Bats control.
    const names = new Map();
    for (const r of leaderboard) if (!names.has(r.id)) names.set(r.id, Swing.displayName(r.name));
    el.players.replaceChildren(...[...names.values()].sort((a, b) => a.localeCompare(b)).map((n) => {
      const o = document.createElement("option"); o.value = n; return o;
    }));
    if (!leaderboard.length) {
      status(`no bat-tracking data for ${year} yet`, "warn");
      return false;
    }
    status(`${names.size} hitters, ${leaderboard.length} player-sides · ${year}`);
    el.go.disabled = false;
    return true;
  }

  // ---- running the pipeline ----------------------------------------------

  // Bats on "Auto": the side with more competitive swings for that player.
  function pickSide(ref) {
    const rows = leaderboard.filter((r) => r.id === ref.mlbam_id);
    if (!rows.length) return ref.bat_side || "R";
    return rows.reduce((best, r) => (r.swings_competitive > best.swings_competitive ? r : best)).bat_side;
  }

  async function run(player, year, hand) {
    if (running) return;
    running = true;
    el.go.disabled = true;
    try {
      if (!leaderboard || Number(el.season.value) !== Number(year)) {
        el.season.value = String(year);
        if (!(await loadLeaderboard(year))) return;
      }
      const ref = Swing.resolvePlayer(player, year, hand || null, leaderboard);
      const side = hand || pickSide(ref);
      status(`fetching the ${year} card for ${ref.name ? Swing.displayName(ref.name) : ref.mlbam_id} (${side})…`);
      const p = await Swing.getSwingProfile(ref.mlbam_id, year, side, { leaderboard });
      profile = p;
      await render();
      const key = `${p.mlbam_id}-${p.year}-${p.handedness}`;
      history.replaceState(null, "", `#${key}`);
      el.player.value = p.display_name || String(p.mlbam_id);
      const sides = leaderboard.filter((r) => r.id === p.mlbam_id).map((r) => r.bat_side);
      const other = sides.find((s) => s !== p.handedness);
      el.otherSide.hidden = !other;
      if (other) {
        el.otherSide.textContent = `Other side (${other})`;
        el.otherSide.dataset.side = other;
      }
      status(p.warning ? p.warning : `${p.display_name || p.mlbam_id}, ${p.year} (${p.handedness}HB) · ${p.traced_columns} columns traced`, p.warning ? "warn" : "");
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
    const { peak, trough, warnings } = await SwingPlot.plotSwingKinematics(p, {
      canvas: el.fig, showJerk: el.jerk.checked,
    });
    el.out.hidden = false;

    const t = p.timing, d = p.data;
    const f = (x, n = 1) => x.toFixed(n);
    const signed = (x, n) => { const s = Math.abs(x).toFixed(n); return Number(s) === 0 ? s : (x < 0 ? "−" : "+") + s; };
    const stats = [
      ["Bat speed at impact", `${f(p.impact_mph)} mph`, `leaderboard ${f(t.leaderboard_bat_speed_mph, 2)} · ${signed(t.speed_check_mph, 2)}`, !t.speed_check_ok],
      ["Imputed swing duration", `${f(p.duration_ms, 0)} ms`, `${f(t.swing_length_ft, 2)} ft / ${f(t.mean_bat_speed_mph)} mph mean`],
      ["Peak acceleration", `${f(d.acceleration[peak])} g`, `at ${f(d.swing_time[peak], 0)} ms`],
      ["Mean / impact speed", f(t.shape_ratio, 3), "shape of the curve"],
    ];
    if (trough !== null) stats.push(["Let-off jerk", `${SwingPlot.fmtComma0(d.jerk[trough])} g/s`, `at ${f(d.swing_time[trough], 0)} ms`]);
    stats.push(["Competitive swings", String(t.swings_competitive), `${p.year} leaderboard`]);
    el.stats.replaceChildren(...stats.map(([label, value, sub, warn]) => {
      const div = document.createElement("div");
      div.className = warn ? "stat warn" : "stat";
      const s = document.createElement("span"); s.textContent = label;
      const b = document.createElement("b"); b.textContent = value;
      const sm = document.createElement("small"); sm.textContent = sub;
      div.append(s, b, sm);
      return div;
    }));

    const notes = [];
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
    const player = el.player.value.trim();
    if (!player) { status("type a player's name or MLBAM id", "warn"); return; }
    run(player, Number(el.season.value), el.hand.value);
  });
  el.season.addEventListener("change", () => loadLeaderboard(Number(el.season.value)));
  el.jerk.addEventListener("change", render);
  el.otherSide.addEventListener("click", () => {
    if (profile) run(String(profile.mlbam_id), profile.year, el.otherSide.dataset.side);
  });
  el.dlPng.addEventListener("click", () => {
    if (!profile) return;
    const suffix = el.jerk.checked ? "jerk" : "";
    el.fig.toBlob((b) => save(b, profile.filename(suffix)), "image/png");
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
    } else {
      await loadLeaderboard(Number(el.season.value));
    }
  })();
})();
