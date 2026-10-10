/**
 * Live pitcher cards, built by the poller from the feed it has just fetched.
 *
 * For each MLB game whose feed moved, every pitcher whose pitch count has changed since
 * his last build gets a fresh card dict (build.js), scored by the JS port of the pitch
 * models (scorer.js) and compared with his pack of past seasons. The picker draws it.
 * A game gets one last pass for every pitcher once it is final, and leaves the index
 * when the nightly build has written its permanent cards.
 *
 *   live/cards/<gamePk>-<pitcherId>.json   one card dict
 *   live/cards/index.json                  the games and pitchers, as a day manifest
 *                                          (cards/days/<date>.json) plus status, final
 *                                          and each pitcher's pitch count at his build
 *
 * Inputs the Python pipeline publishes to the bucket: cards/models/scorer.pack (the
 * models, see bundle.js), cards/pitchers/<id>.json (packs.py) and cards/arms/<year>.json.
 */

import { loadBundle } from "./bundle.js";
import { build } from "./build.js";
import { gameRows } from "./feed.js";
import { heightFeet } from "./groups.js";
import { score } from "./scorer.js";

export const INDEX = "live/cards/index.json";
const BUNDLE = "cards/models/scorer.pack";
const PERMANENT = "cards/index.json";
const DATA_URL = "https://data.blandalytics.com";
const CARD_CACHE = "public, max-age=60";
const INDEX_CACHE = "public, max-age=15";
const RECHECK_MS = 10 * 60_000; // how often a warm isolate looks for newer models
const MAX_PACKS = 400; // a full slate has fewer pitchers; the cap keeps memory in bounds

// what a warm isolate keeps between ticks
const cache = { bundle: null, etag: null, checked: 0, arms: new Map(), packs: new Map() };

async function getJson(env, key) {
  const obj = await env.BUCKET.get(key);
  return obj ? obj.json() : null;
}

/** The scorer bundle, reloaded when a newer one has been published. */
async function bundle(env, now) {
  if (cache.bundle && now - cache.checked < RECHECK_MS) return cache.bundle;
  cache.checked = now;
  const head = await env.BUCKET.head(BUNDLE);
  if (!head) throw new Error(`${BUNDLE} is missing: run tools/pitcher_card/export_scorer.py`);
  if (head.etag !== cache.etag) {
    const obj = await env.BUCKET.get(BUNDLE);
    cache.bundle = loadBundle(await obj.arrayBuffer());
    cache.etag = head.etag;
  }
  return cache.bundle;
}

/** The season's arm angles for a game type, falling back to the regular season's board
 * as fetch.arm_angles does when Savant has not published the round. */
async function arms(env, date, gameType) {
  const [y, m, d] = date.split("-").map(Number);
  const year = m < 3 || (m === 3 && d <= 25) ? y - 1 : y;
  if (!cache.arms.has(year)) cache.arms.set(year, (await getJson(env, `cards/arms/${year}.json`)) ?? {});
  const boards = cache.arms.get(year);
  return boards[gameType] ?? boards.R ?? {};
}

/** A pitcher's pack, kept for the day it was built for. */
async function pack(env, pid, date) {
  const have = cache.packs.get(pid);
  if (have && have.date === date) return have.pack;
  if (cache.packs.size >= MAX_PACKS) cache.packs.clear(); // an isolate lives a day at most
  const p = await getJson(env, `cards/pitchers/${pid}.json`);
  cache.packs.set(pid, { date, pack: p });
  return p;
}

/** The game's pitchers as the card lists them: both starters, then each bullpen. */
function pitcherOrder(feed) {
  const t = feed.liveData.boxscore.teams;
  const [home, away] = [t.home.pitchers, t.away.pitchers];
  return [...home.slice(0, 1), ...away.slice(0, 1), ...home.slice(1), ...away.slice(1)];
}

/** build_site.entry: what the picker needs to know about a card. */
function entry(pk, card, pitches) {
  return {
    id: card.pitcher_id,
    name: card.name,
    hand: card.hand,
    side: card.home ? "home" : "away",
    start: card.starter,
    grade: card.grades.game,
    line: card.line,
    years: card.comparisons.map((c) => c.year),
    file: `${DATA_URL}/live/cards/${pk}-${card.pitcher_id}.json`,
    pitches,
  };
}

export class LiveCards {
  constructor(env, now = Date.now()) {
    this.env = env;
    this.now = now;
    this.index = null;
    this.dirty = false;
  }

  /** Read the live index. If that fails the cards sit this poll out (writing an index
   * from nothing would drop every game in it); the poller carries on regardless. */
  async load() {
    try {
      this.index = (await getJson(this.env, INDEX)) ?? {};
      this.index.games ??= {};
    } catch (err) {
      console.log(`live card index unreadable, skipping the cards this poll: ${err.stack ?? err}`);
      this.index = null;
    }
  }

  /** Rebuild the cards a game needs after its feed moved; returns how many were written. */
  async game(feed) {
    if (!this.index) return 0;
    const pk = feed.gameData.game.pk;
    const rows = gameRows(feed);
    if (!rows.length) return 0;
    const counts = new Map();
    for (const r of rows) counts.set(r.pitcher, (counts.get(r.pitcher) ?? 0) + 1);
    const followed = this.index.games[pk];
    const final = feed.gameData.status.codedGameState === "F";
    const have = new Map((followed?.pitchers ?? []).map((p) => [p.id, p.pitches]));
    const lastPass = final && !followed?.final; // every pitcher once more when it ends
    const todo = pitcherOrder(feed).filter((pid) => counts.has(pid) && (lastPass || have.get(pid) !== counts.get(pid)));
    if (!todo.length && !lastPass) return 0;
    const n = await this.build(feed, rows, todo, counts);
    const game = this.index.games[pk];
    if (game) {
      game.status = feed.gameData.status.detailedState;
      game.final = final;
      this.dirty = true;
    }
    return n;
  }

  async build(feed, rows, todo, counts) {
    const pk = feed.gameData.game.pk;
    const date = feed.gameData.datetime.officialDate;
    const b = await bundle(this.env, this.now);
    const arm = await arms(this.env, date, feed.gameData.game.type);
    const heights = new Map(Object.values(feed.gameData.players).map((p) => [p.id, heightFeet(p.height)]));
    const values = score(rows, b, { heights, only: new Set(todo) });
    let n = 0;
    for (const pid of todo) {
      try {
        const card = build({
          feed, pitcherId: pid, rows: rows.filter((r) => r.pitcher === pid), values, scale: b.scale,
          xslg: b.xslg, arm: arm[pid] ?? {}, pack: await pack(this.env, pid, date),
        });
        await this.env.BUCKET.put(`live/cards/${pk}-${pid}.json`, JSON.stringify(card), {
          httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: CARD_CACHE },
        });
        this.add(pk, card, counts.get(pid));
        n += 1;
      } catch (err) {
        console.log(`card ${pk}-${pid} failed: ${err.stack ?? err}`);
      }
    }
    return n;
  }

  add(pk, card, pitches) {
    const home = card.home ? card.team : card.opp;
    const away = card.home ? card.opp : card.team;
    const game = (this.index.games[pk] ??= { date: card.date, home, away, pitchers: [] });
    game.pitchers = [...game.pitchers.filter((p) => p.id !== card.pitcher_id), entry(pk, card, pitches)];
    this.dirty = true;
  }

  /** Drop games that have left the schedule window or have their permanent cards, and
   * write the index if anything changed. */
  async finish(games) {
    if (!this.index) return;
    const keep = new Set(games.map((g) => String(g.gamePk)));
    const permanent = Object.keys((await getJson(this.env, PERMANENT))?.games ?? {});
    for (const pk of permanent) keep.delete(pk);
    for (const pk of Object.keys(this.index.games)) {
      if (!keep.has(pk)) {
        delete this.index.games[pk];
        this.dirty = true;
      }
    }
    if (!this.dirty) return;
    this.index.updated = new Date(this.now).toISOString();
    this.index.date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(this.now);
    await this.env.BUCKET.put(INDEX, JSON.stringify(this.index), {
      httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: INDEX_CACHE },
    });
  }
}
