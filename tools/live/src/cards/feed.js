/**
 * One game's pitches from the live feed, as the rows statfast builds from the same plays.
 *
 * The scorer and the card were written against statfast's frame, so the rows keep its
 * column names and its types: the measured values come back as float32 there (a Python
 * float that reads 95.3 is 95.30000305... in the frame), and the models were fed those,
 * so they are rounded through Math.fround here. A missing number is NaN, a missing
 * string null, as pandas has them. Only the columns the scorer and the card read are kept.
 *
 * statfast walks `allPlays` the same way: one row per play event that carries
 * `pitchData` (an intentional ball or a timer violation has none), the play's matchup
 * and result repeated on each, and the score before and after the play carried along.
 */

const f32 = (v) => (v === null || v === undefined || v === "" ? NaN : Math.fround(Number(v)));
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v));

/** statfast's _sides: (batting, fielding) from (away, home). */
function sides(top, away, home) {
  return top ? [away, home] : [home, away];
}

/** The play-level values every pitch of a plate appearance shares. */
function playHead(play, game, pre, post) {
  const mu = play.matchup ?? {};
  const ab = play.about ?? {};
  const res = play.result ?? {};
  const top = ab.isTopInning ?? ab.halfInning === "top";
  const [batScore, fieldScore] = sides(top, ...pre);
  const [postBat, postField] = sides(top, ...post);
  return {
    ...game,
    at_bat_index: num(ab.atBatIndex),
    inning: num(ab.inning),
    is_top_inning: top,
    pitcher: num(mu.pitcher?.id),
    p_throws: str(mu.pitchHand?.code),
    batter: num(mu.batter?.id),
    stand: str(mu.batSide?.code),
    events: str(res.eventType),
    event_desc: str(res.description),
    bat_score: batScore,
    field_score: fieldScore,
    post_bat_score: postBat,
    post_field_score: postField,
  };
}

/** One row per tracked pitch of a plate appearance. */
function* playRows(play, game, pre, post) {
  const head = playHead(play, game, pre, post);
  for (const e of play.playEvents ?? []) {
    const pit = e.pitchData;
    if (!pit) continue;
    const co = pit.coordinates ?? {};
    const br = pit.breaks ?? {};
    const hd = e.hitData ?? {};
    const det = e.details ?? {};
    const cnt = e.count ?? {};
    yield {
      ...head,
      pitch_number: num(e.pitchNumber),
      play_id: str(e.playId),
      pitch_type: str(det.type?.code),
      call_code: str(det.call?.code),
      det_code: str(det.code),
      balls: num(cnt.balls),
      strikes: num(cnt.strikes),
      release_speed: f32(pit.startSpeed),
      plate_time: f32(pit.plateTime),
      release_extension: f32(pit.extension),
      zone: num(pit.zone),
      sz_top: f32(pit.strikeZoneTop),
      sz_bot: f32(pit.strikeZoneBottom),
      plate_x: f32(co.pX),
      plate_z: f32(co.pZ),
      vx0: f32(co.vX0),
      vy0: f32(co.vY0),
      vz0: f32(co.vZ0),
      ax: f32(co.aX),
      ay: f32(co.aY),
      az: f32(co.aZ),
      release_pos_x: f32(co.x0),
      release_pos_y: f32(co.y0),
      release_pos_z: f32(co.z0),
      ivb: f32(br.breakVerticalInduced),
      hb: f32(br.breakHorizontal),
      release_spin_rate: f32(br.spinRate),
      spin_axis: f32(br.spinDirection),
      launch_speed: f32(hd.launchSpeed),
      launch_angle: f32(hd.launchAngle),
    };
  }
}

/**
 * Every tracked pitch in the feed, sorted as statfast sorts them (at-bat, then pitch).
 * The score a play starts from is the previous play's result: the API reports scores
 * after each play, so every play is walked to keep the running total right.
 */
export function gameRows(feed) {
  const gd = feed.gameData;
  const date = gd.datetime.officialDate;
  const game = {
    game_pk: gd.game.pk,
    game_date: date,
    season: Number(date.slice(0, 4)),
    game_type: gd.game.type,
    home_team: gd.teams.home.abbreviation ?? null,
    away_team: gd.teams.away.abbreviation ?? null,
  };
  const rows = [];
  let pre = [0, 0];
  for (const play of feed.liveData?.plays?.allPlays ?? []) {
    const res = play.result ?? {};
    const post = [res.awayScore ?? pre[0], res.homeScore ?? pre[1]];
    for (const row of playRows(play, game, pre, post)) rows.push(row);
    pre = post;
  }
  // stable, as pandas sorts with ignore_index after a concat in game order
  return rows
    .map((r, i) => [r, i])
    .sort((a, b) => a[0].at_bat_index - b[0].at_bat_index || a[0].pitch_number - b[0].pitch_number || a[1] - b[1])
    .map(([r]) => r);
}

/** The `fields` names the feed has to carry for gameRows (and the card) to work. */
export const ROW_FIELDS = [
  "gameData", "datetime", "officialDate", "game", "pk", "type", "teams", "away", "home", "abbreviation",
  "liveData", "plays", "allPlays", "about", "atBatIndex", "inning", "halfInning", "isTopInning",
  "matchup", "pitcher", "batter", "id", "pitchHand", "batSide", "code",
  "result", "eventType", "description", "awayScore", "homeScore",
  "playEvents", "pitchNumber", "playId", "details", "call", "count", "balls", "strikes",
  "pitchData", "startSpeed", "plateTime", "extension", "zone", "strikeZoneTop", "strikeZoneBottom",
  "coordinates", "pX", "pZ", "vX0", "vY0", "vZ0", "aX", "aY", "aZ", "x0", "y0", "z0",
  "breaks", "breakVerticalInduced", "breakHorizontal", "spinRate", "spinDirection",
  "hitData", "launchSpeed", "launchAngle",
];
