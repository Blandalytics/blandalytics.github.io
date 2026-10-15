// FanGraphs extract for the lineup simulator.
//
// FanGraphs answers scripts outside a real browser with a Cloudflare challenge, so
// this runs inside a fangraphs.com tab (signed in or not): paste it into the
// DevTools console. It saves fangraphs_<season>.json through a download; move that
// file to tools/lineup_sims/cache/fangraphs/<season>.json and run build.py. Set start/end to
// the season's regular-season dates (Stats API /api/v1/seasons/<season>?sportId=1).
//
// What it collects, all for one regular season:
//   guts        - the season's wOBA weights (Guts! constants)
//   teams       - per team: games with a tracked lineup, the number of distinct batting
//                 orders, and the `top` most-used orders (FanGraphs player ids, 1-9) with
//                 how many of those games came against a righty or lefty starter
//   fg_to_mlbam - FanGraphs id -> MLBAM id for every hitter in those orders (MLBAM
//                 ids join them to the Stats API play-by-play)
//   team_bat    - FanGraphs' team batting lines, to check the play-by-play totals

async function fangraphsExtract({ season = 2026, start = "2026-03-25", end = "2026-09-27", top = 3 } = {}) {
  const get = async (url) => {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  };
  const leaders = (extra) =>
    `/api/leaders/major-league/data?age=&pos=all&stats=bat&lg=all&qual=0&season=${season}&season1=${season}` +
    `&startdate=&enddate=&month=0&hand=&pageitems=5000&pagenum=1&ind=0&rost=0&players=&type=0` +
    `&postseason=&sortdir=default&sortstat=PA${extra}`;

  const guts = (await get(`/api/tools/guts/data?season=${season}&type=cn&teamid=0`))
    .find((g) => g.Season === season);

  // the team batting lines also name each FanGraphs team id (the lineup API doesn't)
  const team_bat = (await get(leaders("&team=0,ts"))).data.map((r) => ({
    teamid: r.teamid, team: r.TeamNameAbb, G: r.G, PA: r.PA, AB: r.AB, R: r.R, H: r.H, HR: r.HR, BB: r.BB,
    IBB: r.IBB, SO: r.SO, HBP: r.HBP, SF: r.SF, AVG: r.AVG, OBP: r.OBP, SLG: r.SLG, wOBA: r.wOBA,
  }));
  const abbOf = Object.fromEntries(team_bat.map((t) => [t.teamid, t.team]));

  const teams = [];
  const wanted = new Set();
  for (let teamid = 1; teamid <= 30; teamid++) {
    const [t] = await get(`/api/roster-resource/lineup-tracker/data?teamid=${teamid}&season=${season}`);
    const counts = new Map();
    let games = 0;
    for (const g of t.lineupData.lineupTracker) {
      const day = g.dataPlayers[0]?.gamedate?.slice(0, 10);
      if (!day || day < start || day > end) continue;
      const order = g.dataPlayers.filter((p) => p.BO >= 1 && p.BO <= 9).sort((a, b) => a.BO - b.BO);
      if (order.length !== 9 || new Set(order.map((p) => p.BO)).size !== 9) continue;
      games++;
      const key = order.map((p) => p.playerid).join(",");
      const c = counts.get(key) ?? { n: 0, R: 0, L: 0, last: "" };
      c.n++;
      if (g.gameList.oppPitchHand === "R") c.R++;
      if (g.gameList.oppPitchHand === "L") c.L++;
      if (day > c.last) c.last = day;
      counts.set(key, c);
    }
    // ties go to the order used most recently
    const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || (a[1].last < b[1].last ? 1 : -1));
    const orders = ranked.slice(0, top).map(([key, c]) => ({ ids: key.split(","), ...c }));
    orders.forEach((o) => o.ids.forEach((id) => wanted.add(id)));
    teams.push({ teamid, abb: abbOf[teamid], games, distinct: counts.size, orders });
  }

  const fg_to_mlbam = {};
  for (const r of (await get(leaders("&team=0"))).data) {
    const id = String(r.playerid);
    if (wanted.has(id)) fg_to_mlbam[id] = r.xMLBAMID;
  }
  const missing = [...wanted].filter((id) => !fg_to_mlbam[id]);
  if (missing.length) console.warn("no MLBAM id for FanGraphs ids", missing);

  // compact rows; build.py reads exactly this shape
  return {
    source: "fangraphs", season, start, end, extracted: new Date().toISOString(), guts,
    teams_cols: ["teamid", "abb", "games", "distinct", "orders: [uses, vs RHP, vs LHP, last used, FanGraphs ids 1-9]"],
    teams: teams.map((t) => [t.teamid, t.abb, t.games, t.distinct,
      t.orders.map((o) => [o.n, o.R, o.L, o.last, o.ids.join(" ")])]),
    fg_to_mlbam,
    team_bat_cols: ["teamid", "team", "PA", "AB", "R", "H", "HR", "BB", "IBB", "SO", "HBP", "SF", "wOBA"],
    team_bat: team_bat.map((t) => [t.teamid, t.team, t.PA, t.AB, t.R, t.H, t.HR, t.BB, t.IBB, t.SO, t.HBP, t.SF,
      Math.round(t.wOBA * 10000) / 10000]),
  };
}

// In the console: run, then save the result as a file.
if (typeof window !== "undefined" && !window.__lineupSimNoAutorun) {
  fangraphsExtract().then((out) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" }));
    a.download = `fangraphs_${out.season}.json`;
    a.click();
    console.log("lineup-sim extract", out);
  });
}
