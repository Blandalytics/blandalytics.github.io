// NBA Shot Charts: the Streamlit app's arithmetic (Blandalytics/nba_shot_chart,
// nba_shot_chart.py) over the season files tools/nba_shot_charts/build_data.py writes.
// Pure functions, no DOM, so the numbers can be checked in Node against the app's pandas.
//
// The app spreads each player-game's FTA and FTM evenly over that game's shots, then sums
// per shot; summing whole games here gives the same totals without the spreading.

export const PTS_PER_SHOT = 1.09;
export const PTS_PER_FT = 0.78;
export const SEASON_SHOT_LIMIT = 200;   // a season chart marks the player's last 200 shots

/** The season file, indexed: shots by player, player-games by key, players by season points. */
export function prepare(data) {
  const s = data.shots;
  const n = s.p.length;
  const base = data.xfta.base, perZone = data.xfta.per_zone;
  const xfta = new Float64Array(n);
  const pts = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    xfta[i] = base + (s.zone[i] == null ? 0 : perZone[s.zone[i]]);
    pts[i] = s.made[i] ? s.value[i] : 0;
  }

  const players = data.players.map(([id, name], p) => ({ p, id, name, shots: [], games: [] }));
  for (let i = 0; i < n; i++) players[s.p[i]].shots.push(i);

  const games = data.games.map(([id, date], g) => ({ g, id, date }));
  const pg = data.player_games;
  const playerGames = new Map();
  for (let k = 0; k < pg.p.length; k++) {
    const rec = { p: pg.p[k], g: pg.g[k], team: pg.team[k], matchup: pg.matchup[k], fta: pg.fta[k], ftm: pg.ftm[k], shots: [] };
    playerGames.set(key(rec.p, rec.g), rec);
    players[rec.p].games.push(rec);
  }
  for (let i = 0; i < n; i++) playerGames.get(key(s.p[i], s.g[i])).shots.push(i);
  for (const pl of players) {
    pl.games.sort((a, b) => games[b.g].date.localeCompare(games[a.g].date) || b.g - a.g);
    pl.points = pl.games.reduce((t, r) => t + r.ftm, 0) + pl.shots.reduce((t, i) => t + pts[i], 0);
  }

  const lastDate = games.reduce((d, gm) => (gm.date > d ? gm.date : d), "");
  return {
    season: data.season, updated: data.updated, shots: s, xfta, pts, players, games, playerGames, lastDate,
    // the app's player list: most points first
    byPoints: players.filter((pl) => pl.shots.length).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)),
  };
}

const key = (p, g) => p * 100000 + g;

/** The app's default pick: the top scorer on the season's latest date, in that game. */
export function defaultPick(season) {
  let best = null;
  for (const rec of season.playerGames.values()) {
    if (season.games[rec.g].date !== season.lastDate) continue;
    const total = rec.ftm + rec.shots.reduce((t, i) => t + season.pts[i], 0);
    if (!best || total > best.total) best = { total, rec };
  }
  return best ? { player: best.rec.p, game: best.rec.g } : { player: season.byPoints[0].p, game: null };
}

/** shot_summary(): the chart's shots and the six-part points breakdown for one player-game
 *  (game = a game index) or the player's season (game = null). */
export function summary(season, p, game) {
  const pl = season.players[p];
  const recs = game == null ? pl.games : [season.playerGames.get(key(p, game))].filter(Boolean);
  const idx = recs.flatMap((r) => r.shots).sort((a, b) => a - b);
  const { shots: s, xfta, pts } = season;

  let xptsSum = 0, xptsN = 0, quality = 0, making = 0, fgPts = 0, xftaSum = 0;
  const xptsValues = [];
  for (const i of idx) {
    fgPts += pts[i];
    xftaSum += xfta[i];
    const xp = s.xpts[i];
    if (xp == null) continue;   // off the xFG grid: pandas skips the NaN in every sum and mean
    xptsSum += xp; xptsN += 1; xptsValues.push(xp);
    quality += xp - PTS_PER_SHOT;
    making += pts[i] - xp;
  }
  const fta = recs.reduce((t, r) => t + r.fta, 0);
  const ftm = recs.reduce((t, r) => t + r.ftm, 0);
  const n = idx.length;
  const parts = {
    volume: n * PTS_PER_SHOT,
    quality,
    making,
    xftaVolume: xftaSum * PTS_PER_FT,
    ftDrawing: (fta - xftaSum) * PTS_PER_FT,
    ftMaking: ftm - fta * PTS_PER_FT,
  };
  const marked = game == null ? idx.slice(-SEASON_SHOT_LIMIT) : idx;
  return {
    player: pl, game: game == null ? null : season.games[game], rec: game == null ? null : recs[0],
    n, fta, ftm, fgPts,
    expected: xptsN ? xptsSum / xptsN : NaN,   // xPts/Shot
    actual: n ? fgPts / n : NaN,               // Pts/Shot
    xptsValues,
    parts,
    shotPoints: parts.volume + parts.quality + parts.making,
    ftPoints: parts.xftaVolume + parts.ftDrawing + parts.ftMaking,
    marked: marked.map((i) => ({ x: s.x[i], y: s.y[i], made: s.made[i] === 1 })),
    limited: game == null && n >= SEASON_SHOT_LIMIT,
  };
}

/** The sums every leaderboard is built from, for one set of player-games. */
function tally(season, recs) {
  const { shots: s, xfta, pts } = season;
  let n = 0, fgPts = 0, quality = 0, making = 0, xn = 0, xftaSum = 0, fta = 0, ftm = 0;
  for (const r of recs) {
    fta += r.fta; ftm += r.ftm;
    for (const i of r.shots) {
      n += 1; fgPts += pts[i]; xftaSum += xfta[i];
      const xp = s.xpts[i];
      if (xp == null) continue;
      xn += 1; quality += xp - PTS_PER_SHOT; making += pts[i] - xp;
    }
  }
  return { games: recs.length, n, fgPts, quality, making, xn, xftaSum, fta, ftm };
}

/** Totals, as the app's leaderboards show them when "per shot" is off. */
function totals(t) {
  return {
    pts: t.fgPts + t.ftm, fga: t.n,
    vol: t.n * PTS_PER_SHOT, qual: t.quality, make: t.making, fgPts: t.fgPts,
    xfta: t.xftaSum * PTS_PER_FT, ftDraw: (t.fta - t.xftaSum) * PTS_PER_FT,
    ftMake: t.ftm - t.fta * PTS_PER_FT, ftPts: t.ftm,
  };
}

/** Per-shot means, as the app's leaderboards show them when "per shot" is on. Quality and
 *  making average over the shots on the xFG grid, as pandas' mean skips their NaNs. */
function perShot(t) {
  return {
    fga: t.n,
    pts: t.fgPts / t.n, vol: PTS_PER_SHOT,
    qual: t.xn ? t.quality / t.xn : NaN, make: t.xn ? t.making / t.xn : NaN,
    xfta: (t.xftaSum * PTS_PER_FT) / t.n, ftDraw: ((t.fta - t.xftaSum) * PTS_PER_FT) / t.n,
  };
}

/** Season Leaderboard rows: one per player. */
export function seasonBoard(season, { perShot: per = false, minShots = 1 } = {}) {
  const rows = [];
  for (const pl of season.byPoints) {
    const t = tally(season, pl.games);
    if (per && t.n < minShots) continue;
    rows.push({ player: pl, games: t.games, ...(per ? perShot(t) : totals(t)) });
  }
  return rows;
}

/** Game Leaderboard rows: one per player-game. */
export function gameBoard(season, { perShot: per = false, minShots = 1 } = {}) {
  const rows = [];
  for (const rec of season.playerGames.values()) {
    const t = tally(season, [rec]);
    if (per && t.n < minShots) continue;
    rows.push({ player: season.players[rec.p], game: season.games[rec.g], matchup: rec.matchup, ...(per ? perShot(t) : totals(t)) });
  }
  return rows;
}

/** plotly_chart(): each player's shot quality and shot making points added, for the players
 *  in the top quarter by shots, with the app's diagonal guides. */
export function valueAdded(season) {
  const all = season.byPoints.map((pl) => {
    const t = tally(season, pl.games);
    return { player: pl, shots: t.n, qual: t.quality, make: t.making, added: t.fgPts - t.n * PTS_PER_SHOT };
  });
  const threshold = quantile(all.map((r) => r.shots), 0.75);
  const rows = all.filter((r) => r.shots >= threshold);
  return { rows, threshold, guideStep: std(rows.map((r) => r.added)) / 2 };
}

/** pandas' Series.quantile (linear interpolation). */
export function quantile(values, q) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** pandas' Series.std (ddof 1). */
export function std(values) {
  const n = values.length;
  if (n < 2) return NaN;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1));
}

/** The colorbar's density: scipy's gaussian_kde with covariance_factor 0.1, its xPTS clipped
 *  to the colorbar's span, at `xs`. Returns heights scaled as the app draws them. */
export function density(values, lo, hi, xs) {
  const v = values.map((x) => Math.min(Math.max(x, lo), hi));
  const sd = std(v);
  if (!(v.length > 1) || !(sd > 0)) return null;
  const bw = sd * 0.1;
  const d = xs.map((x) => v.reduce((t, xi) => t + Math.exp(-0.5 * ((x - xi) / bw) ** 2), 0));
  const max = Math.max(...d);
  return d.map((y) => y / (max * 1.2) + 0.05);
}

/** load_league_minutes() + team_minutes(): a team's players by minutes over its last 3, 5 and
 *  10 games and the season, with each of the last five games' minutes. */
export function teamMinutes(minutes, teamId) {
  const r = minutes.rows;
  const dates = [];
  for (let i = 0; i < r.team.length; i++) if (r.team[i] === teamId) dates.push(r.date[i]);
  const recent = [...new Set(dates)].sort().reverse();    // the team's game dates, latest first
  const rank = new Map(recent.map((d, i) => [d, i + 1]));  // the app's dense team_game rank

  const people = new Map();
  for (let i = 0; i < r.team.length; i++) {
    if (r.team[i] !== teamId) continue;
    const name = minutes.players[r.player[i]];
    if (!people.has(name)) people.set(name, { name, games: new Map() });
    const g = people.get(name).games;
    g.set(r.date[i], (g.get(r.date[i]) ?? []).concat(r.min[i]));
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const rows = [...people.values()].map(({ name, games }) => {
    const within = (k) => [...games].filter(([d]) => rank.get(d) <= k).flatMap(([, m]) => m);
    return {
      name,
      last3: mean(within(3)), last5: mean(within(5)), last10: mean(within(10)),
      all: mean([...games.values()].flat()),
      days: recent.slice(0, 5).map((d) => mean(games.get(d) ?? [])),
    };
  });
  // sort_values(['Last 3','Last 5','Last 10','All'], ascending=False): NaN last at each level
  const cmp = (a, b) => (Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : b - a);
  rows.sort((a, b) => cmp(a.last3, b.last3) || cmp(a.last5, b.last5) || cmp(a.last10, b.last10) || cmp(a.all, b.all));
  return { dates: recent.slice(0, 5), rows };
}
