// Swing profiles in the browser: the pipeline from Blandalytics/swing_profiles, ported
// module for module so the numbers match the Python to floating-point noise.
//
//   savant_lookup.py      -> fetchBatTracking, resolvePlayer, displayName
//   swing_path_extract.py -> fetchCard, extractSwingCurve
//   swing_duration.py     -> imputeSwingDuration
//   swing_profile.py      -> addKinematics, getSwingProfile
//
// Everything is exposed on window.Swing. Both Savant endpoints send
// Access-Control-Allow-Origin: *, so the page fetches them directly.

(() => {
  "use strict";

  const MPH_TO_FPS = 5280.0 / 3600.0;
  const G_FPS2 = 32.174;

  // ---- savant_lookup ------------------------------------------------------

  const LEADERBOARD_URL = (year) =>
    "https://baseballsavant.mlb.com/leaderboard/bat-tracking?gameType=Regular" +
    "&groupBy=bat_side&minSwings=1&minGroupSwings=1" +
    `&seasonStart=${year}&seasonEnd=${year}&type=batter&csv=true`;

  const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const leaderboardCache = new Map();

  class SavantError extends Error {}
  class AmbiguousPlayerError extends SavantError {
    constructor(query, matches) {
      const listing = matches.map((r) => `${r.name} (id ${r.id}, bats ${r.bat_side})`).join("; ");
      const n = new Set(matches.map((r) => r.id)).size;
      super(`${n} players match "${query}": ${listing}. Pass the MLBAM id instead, or narrow it with handedness.`);
      this.query = query;
      this.matches = matches;
    }
  }
  class SwingPathError extends SavantError {}

  // RFC-4180-ish: quoted fields, doubled quotes, CRLF, and Savant's leading BOM.
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const header = rows[0];
    return rows.slice(1).filter((r) => r.length === header.length)
      .map((r) => Object.fromEntries(header.map((h, j) => [h, r[j]])));
  }

  // Turn the leaderboard's "Caminero, Junior" into "Junior Caminero".
  function displayName(leaderboardName) {
    const s = String(leaderboardName);
    const k = s.indexOf(",");
    if (k < 0) return s.trim();
    const last = s.slice(0, k).trim(), first = s.slice(k + 1).trim();
    return first ? `${first} ${last}` : last;
  }

  // Bat-tracking leaderboard for one season, one row per player and bat side.
  async function fetchBatTracking(year, { useCache = true } = {}) {
    year = Number(year);
    if (useCache && leaderboardCache.has(year)) return leaderboardCache.get(year);
    const resp = await fetch(LEADERBOARD_URL(year));
    if (!resp.ok) throw new SavantError(`bat-tracking leaderboard for ${year}: HTTP ${resp.status}`);
    const rows = parseCsv(await resp.text());
    if (!rows.length) return [];  // a season with no bat tracking yet: header only
    const required = ["id", "name", "bat_side", "avg_bat_speed", "swing_length"];
    const missing = required.filter((c) => !(c in rows[0]));
    if (missing.length) {
      throw new SavantError(`bat-tracking leaderboard for ${year} is missing ${JSON.stringify(missing)}; the endpoint's schema may have changed.`);
    }
    const lb = rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      bat_side: String(r.bat_side).toUpperCase(),
      swings_competitive: Number(r.swings_competitive),
      avg_bat_speed: Number(r.avg_bat_speed),
      swing_length: Number(r.swing_length),
    }));
    if (useCache) leaderboardCache.set(year, lb);
    return lb;
  }

  // Fold accents and punctuation so "Rodríguez, Julio" matches "julio rodriguez".
  function normalize(text) {
    return String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Every spelling of a "Last, First" leaderboard name we accept as a match.
  function nameKeys(leaderboardName) {
    const s = String(leaderboardName);
    const k = s.indexOf(",");
    const last = normalize(k < 0 ? s : s.slice(0, k));
    const first = k < 0 ? "" : normalize(s.slice(k + 1));
    if (!first) return last ? new Set([last]) : new Set();
    const bare = last.split(" ").filter((w) => !NAME_SUFFIXES.has(w)).join(" ");
    const keys = new Set([`${first} ${last}`, `${last} ${first}`, last]);
    if (bare && bare !== last) { keys.add(`${first} ${bare}`); keys.add(`${bare} ${first}`); keys.add(bare); }
    return keys;
  }

  // Resolve an MLBAM id or a player name to {mlbam_id, name, bat_side}. Ids pass
  // through untouched. A shared name is never resolved silently: it is an error
  // unless handedness settles it, and then a warning is attached to the result.
  function resolvePlayer(player, year, handedness, leaderboard) {
    handedness = handedness ? String(handedness).toUpperCase() : null;
    const text = String(player).trim();
    if (/^\d+$/.test(text)) return { mlbam_id: Number(text), name: null, bat_side: handedness, warning: null };

    const query = normalize(text);
    if (!query) throw new SavantError("empty player name");

    const hits = leaderboard.filter((r) => nameKeys(r.name).has(query));
    if (!hits.length) {
      throw new SavantError(`no player matching "${text}" in the ${year} bat-tracking leaderboard. Try "First Last", or pass the MLBAM id.`);
    }
    const ids = (rows) => new Set(rows.map((r) => r.id));
    const shared = ids(hits).size > 1;
    let narrowed = hits;
    if (handedness !== null) {
      const bySide = hits.filter((r) => r.bat_side === handedness);
      if (!bySide.length) {
        const sides = [...new Set(hits.map((r) => r.bat_side))].sort().join(", ");
        throw new SavantError(`${hits[0].name} has no ${handedness} bat side in ${year} (available: ${sides}).`);
      }
      narrowed = bySide;
    }
    if (ids(narrowed).size > 1) throw new AmbiguousPlayerError(text, narrowed);

    const row = narrowed[0];
    let warning = null;
    if (shared) {
      const others = hits.filter((r) => r.id !== row.id).map((r) => `id ${r.id} bats ${r.bat_side}`).join("; ");
      warning = `"${text}" is shared by ${ids(hits).size} players; resolved to id ${row.id} (bats ${row.bat_side}) by handedness. Others: ${others}`;
    }
    return { mlbam_id: row.id, name: row.name, bat_side: row.bat_side, warning };
  }

  // ---- swing_path_extract -------------------------------------------------

  const CARD_URL = (id, year, hand) =>
    "https://builds.mlbstatic.com/baseballsavant.mlb.com/swing-path/splendid-splinter/posterized/" +
    `${id}-${year}-${String(hand).toUpperCase()}.png`;

  const EXPECTED_SIZE = [1280, 720];

  // Search window for the bottom-left panel, in image pixels. The rows are for a
  // one-line player name; see axisBottom for why they move.
  const WIN_X0 = 5, WIN_X1 = 230, WIN_Y0 = 545, WIN_Y1 = 680;

  // Axis anchors, in image pixels.
  const X_START = 19.5;    // center of the first marker  -> swing_time 0.0
  const X_IMPACT = 208.5;  // center of the impact marker -> swing_time 1.0
  const Y_ZERO = 664.2;    // row of 0 mph, one-line name
  const PX_PER_MPH = 34.0 / 30.0;  // from the 30 / 60 / 90 gridlines

  // The chart's y axis: a vertical line at the right edge of the chart running
  // from 90 mph down to 0, whose bottom row is the zero line.
  const AXIS_X0 = 208, AXIS_X1 = 212;  // columns it occupies
  const AXIS_Y0 = 500, AXIS_Y1 = 716;  // rows to search
  const AXIS_BOTTOM = 664;             // its bottom row on a one-line-name card
  const AXIS_MIN_LEN = 90;             // px; the real line is ~103

  const MIN_TRACED_COLUMNS = 60;  // sanity floor; real cards trace 145-170 columns

  // A minimal PNG decoder: 8-bit greyscale, RGB and RGBA, not interlaced -- which
  // is what the cards are. Returns {width, height, data} with RGBA bytes, or null
  // for anything it does not handle (the caller then uses the browser's decoder).
  //
  // Browsers colour-manage the images they decode, and this PNG's cICP chunk
  // declares a BT.709 transfer curve, so a managed decode lands every pixel a
  // little darker than the bytes in the file -- the axis line drops from 288 to
  // 260 in R+G+B, against a threshold of 250. Chromium can be told not to convert
  // (createImageBitmap's colorSpaceConversion: "none"); WebKit cannot, and on an
  // iPhone the round trip through the display's colour space moves the values
  // further. Inflating the file ourselves hands every browser the same bytes PIL
  // gives the Python.
  async function decodePng(buf) {
    const b = new Uint8Array(buf);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (b.length < 8 || sig.some((v, i) => b[i] !== v) || typeof DecompressionStream === "undefined") return null;
    const dv = new DataView(buf);
    let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
    const idat = [];
    while (pos + 8 <= b.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      if (type === "IHDR") {
        width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
        depth = b[pos + 16]; ctype = b[pos + 17]; interlace = b[pos + 20];
      } else if (type === "IDAT") idat.push(b.subarray(pos + 8, pos + 8 + len));
      else if (type === "IEND") break;
      pos += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
    if (!width || !height || depth !== 8 || !channels || interlace !== 0 || !idat.length) return null;
    const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) return null;

    const data = new Uint8ClampedArray(width * height * 4);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const off = y * (stride + 1), filter = raw[off];
      for (let i = 0; i < stride; i++) {
        const x = raw[off + 1 + i];
        const a = i >= channels ? cur[i - channels] : 0, up = prev[i], c = i >= channels ? prev[i - channels] : 0;
        let v;
        if (filter === 0) v = x;
        else if (filter === 1) v = x + a;
        else if (filter === 2) v = x + up;
        else if (filter === 3) v = x + ((a + up) >> 1);
        else if (filter === 4) {
          const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
        } else return null;
        cur[i] = v;  // Uint8Array wraps mod 256
      }
      for (let px = 0, o = y * width * 4; px < width; px++, o += 4) {
        const k = px * channels;
        if (channels >= 3) { data[o] = cur[k]; data[o + 1] = cur[k + 1]; data[o + 2] = cur[k + 2]; data[o + 3] = channels === 4 ? cur[k + 3] : 255; }
        else { data[o] = data[o + 1] = data[o + 2] = cur[k]; data[o + 3] = channels === 2 ? cur[k + 1] : 255; }
      }
      [prev, cur] = [cur, prev];
    }
    return { width, height, data };
  }

  // Download the card as raw RGBA pixels -- the file's own bytes when decodePng
  // can read it, otherwise the browser's decode with colour management turned off
  // where the browser allows. The result answers getPixels(x, y, w, h) like
  // getImageData, and says which decoder produced it.
  async function fetchCard(mlbamId, year, handedness) {
    const url = CARD_URL(mlbamId, year, handedness);
    const missing = () => new SwingPathError(`No swing-path card for ${mlbamId}-${year}-${String(handedness).toUpperCase()}. Most hitters with fewer than ~100 competitive swings have none. Check the MLBAM id, season, and batting handedness.`);
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      // The CDN's 404 page carries no CORS header, so the browser reports a
      // missing card as a bare network failure rather than a status.
      if (e instanceof TypeError) throw missing();
      throw e;
    }
    if (resp.status === 404) throw missing();
    if (!resp.ok) throw new SwingPathError(`card ${mlbamId}-${year}-${handedness}: HTTP ${resp.status}`);
    const blob = await resp.blob();
    let raw = null;
    try { raw = await decodePng(await blob.arrayBuffer()); } catch (e) { raw = null; }
    if (raw) {
      const { width, height, data } = raw;
      const getPixels = (x, y, w, h) => {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) out.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
        return out;
      };
      return { width, height, url, blob, decoder: "png", getPixels };
    }
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
    const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return { width: canvas.width, height: canvas.height, url, blob, decoder: "browser", getPixels: (x, y, w, h) => ctx.getImageData(x, y, w, h).data };
  }

  // Row of the chart's zero line, found from the y axis drawn beside it.
  //
  // The left column's panels stack from the top, so a player name that wraps
  // onto two lines pushes the whole Bat Speed panel -- gauge, chart and all --
  // down by a line (24 px). The x positions and the y scale are unchanged; only
  // the vertical origin moves. Anchoring on the axis line itself, rather than on
  // fixed rows, keeps a two-line name from reading 20-odd mph low.
  //
  // A pixel is on the line when its R+G+B clears 250, as in the Python, which
  // reads the file's own bytes. When the browser decoded the card instead (see
  // decodePng) the levels are colour-managed and sit lower, so the bar is set
  // the same distance above the card's own background -- the strip's median --
  // as 250 sits above the background in the raw bytes (130).
  function axisBottom(card) {
    const w = AXIS_X1 - AXIS_X0, h = AXIS_Y1 - AXIS_Y0;
    const px = card.getPixels(AXIS_X0, AXIS_Y0, w, h);
    const sum = new Uint16Array(w * h);
    for (let i = 0; i < w * h; i++) sum[i] = px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
    const sorted = sum.slice().sort();
    const background = sorted[sorted.length >> 1];
    const bar = card.decoder === "png" ? 250 : background + 120;
    const bottoms = [];
    let longest = 0;
    for (let col = 0; col < w; col++) {
      let best = 0, run = 0, start = 0, bestStart = 0;
      for (let row = 0; row < h; row++) {
        if (sum[row * w + col] > bar) {
          if (run === 0) start = row;
          run += 1;
          if (run > best) { best = run; bestStart = start; }
        } else run = 0;
      }
      longest = Math.max(longest, best);
      if (best >= AXIS_MIN_LEN) bottoms.push(bestStart + best - 1 + AXIS_Y0);
    }
    if (!bottoms.length) {
      throw new SwingPathError(`Could not find the chart's y axis on the card (${card.decoder} decode, background ${background}, longest run ${longest} px). The template may have changed; the pixel anchors would need rechecking.`);
    }
    bottoms.sort((a, b) => a - b);
    const n = bottoms.length;  // numpy's median, truncated to an int
    return Math.trunc(n % 2 ? bottoms[(n - 1) / 2] : (bottoms[n / 2 - 1] + bottoms[n / 2]) / 2);
  }

  // Local linear regression over swing time; flattens pixel quantization.
  // Local *linear* rather than a plain kernel average: a kernel average is biased
  // at the ends of the range, which is exactly where the two values worth trusting
  // live (0 mph at the start, the printed bat speed at impact).
  function smoothCurve(t, v, bandwidth) {
    if (!bandwidth) return v.slice();
    const n = t.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
      for (let j = 0; j < n; j++) {
        const d = t[j] - t[i];
        const w = Math.exp(-0.5 * (d / bandwidth) ** 2);
        s0 += w; s1 += w * d; s2 += w * d * d; t0 += w * v[j]; t1 += w * d * v[j];
      }
      const denom = s0 * s2 - s1 * s1;
      // Fall back to the kernel average wherever the local fit is degenerate.
      out[i] = Math.abs(denom) > 1e-12 ? (s2 * t0 - s1 * t1) / denom : t0 / s0;
    }
    return out;
  }

  // numpy.interp: linear inside [xp[0], xp[-1]], clamped to the end values outside.
  function interp(x, xp, fp) {
    const n = xp.length;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
    const f = (x - xp[lo]) / (xp[hi] - xp[lo]);
    return fp[lo] + f * (fp[hi] - fp[lo]);
  }

  // numpy's round: half to even, at `decimals` places.
  function pyRound(x, decimals = 0) {
    const m = 10 ** decimals, y = x * m;
    const f = Math.floor(y), r = y - f;
    let n;
    if (r > 0.5) n = f + 1;
    else if (r < 0.5) n = f;
    else n = f % 2 === 0 ? f : f + 1;
    return n / m;
  }

  // numpy.linspace(0, 1, n)
  function linspace(a, b, n) {
    const step = (b - a) / (n - 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = a + i * step;
    out[n - 1] = b;
    return out;
  }

  // Digitize the bat-speed chart out of an already-loaded card. `nPoints` samples
  // on a uniform swing_time grid; `smooth` is the Gaussian bandwidth in swing-time
  // units (0 keeps the raw pixel trace). Returns {swing_time, bat_speed_mph}.
  function extractSwingCurve(card, nPoints = 101, smooth = 0.03) {
    if (card.width !== EXPECTED_SIZE[0] || card.height !== EXPECTED_SIZE[1]) {
      throw new SwingPathError(`Expected a ${EXPECTED_SIZE[0]}x${EXPECTED_SIZE[1]} card, got ${card.width}x${card.height}. The template may have changed; the pixel anchors would need rechecking.`);
    }
    const shift = axisBottom(card) - AXIS_BOTTOM;
    const y0 = WIN_Y0 + shift, y1 = Math.min(WIN_Y1 + shift, card.height);
    const w = WIN_X1 - WIN_X0, h = y1 - y0;
    const px = card.getPixels(WIN_X0, y0, w, h);

    // Boolean mask of the teal curve markers, then the mid-row of each column.
    const cols = [], mids = [];
    for (let col = 0; col < w; col++) {
      let first = -1, last = -1;
      for (let row = 0; row < h; row++) {
        const k = (row * w + col) * 4;
        const r = px[k], g = px[k + 1], b = px[k + 2];
        if (g > 80 && b > 80 && g - r > 35 && Math.abs(g - b) < 35) {
          if (first < 0) first = row;
          last = row;
        }
      }
      if (first >= 0) { cols.push(col); mids.push(0.5 * (first + last)); }
    }
    if (cols.length < MIN_TRACED_COLUMNS) {
      throw new SwingPathError(`Only traced ${cols.length} columns of the curve (expected >= ${MIN_TRACED_COLUMNS}). The card may be blank or the template changed.`);
    }

    const t = cols.map((c) => (c + WIN_X0 - X_START) / (X_IMPACT - X_START));
    let mph = mids.map((m) => (Y_ZERO + shift - (m + y0)) / PX_PER_MPH);
    mph = smoothCurve(t, mph, smooth);

    const grid = linspace(0.0, 1.0, nPoints);
    return {
      swing_time: grid,
      bat_speed_mph: grid.map((g) => pyRound(Math.max(0, interp(g, t, mph)), 3)),
      traced_columns: cols.length,
      axis_shift: shift,
      decoder: card.decoder,
    };
  }

  // ---- swing_duration -----------------------------------------------------

  const SPEED_CHECK_TOLERANCE = 2.0;  // mph

  // Time-average bat speed (mph) over the swing, by integrating the curve.
  // swing_time spans exactly 0 to 1, so the integral *is* the mean.
  function meanBatSpeed(curve) {
    const t = curve.swing_time, v = curve.bat_speed_mph;
    let s = 0;
    for (let i = 1; i < t.length; i++) s += 0.5 * (v[i] + v[i - 1]) * (t[i] - t[i - 1]);
    return s;
  }

  // The card plots bat speed against *normalized* time, so it carries no duration.
  // The leaderboard's swing_length (feet of barrel travel) supplies the scale:
  // s = T * mean(v)  =>  T = s / mean(v), with mean(v) integrated from the card.
  function imputeSwingDuration(mlbamId, year, handedness, curve, leaderboard) {
    handedness = String(handedness).toUpperCase();
    const row = leaderboard.find((r) => r.id === mlbamId && r.bat_side === handedness);
    if (!row) {
      throw new SwingPathError(`${mlbamId} (${handedness}) is not in the ${year} bat-tracking leaderboard. Check the id, season, and bat side.`);
    }
    const vMean = meanBatSpeed(curve);
    const impact = curve.bat_speed_mph[curve.bat_speed_mph.length - 1];
    if (vMean <= 0) throw new SwingPathError(`non-positive mean bat speed for ${mlbamId}`);
    const lengthFt = row.swing_length;
    return {
      mlbam_id: mlbamId, year, handedness,
      swing_length_ft: lengthFt,
      leaderboard_bat_speed_mph: row.avg_bat_speed,
      card_impact_mph: impact,
      mean_bat_speed_mph: vMean,
      shape_ratio: vMean / impact,
      duration_s: lengthFt / (vMean * MPH_TO_FPS),
      get duration_ms() { return this.duration_s * 1000; },
      speed_check_mph: impact - row.avg_bat_speed,
      speed_check_ok: Math.abs(impact - row.avg_bat_speed) <= SPEED_CHECK_TOLERANCE,
      name: row.name,
      swings_competitive: row.swings_competitive,
    };
  }

  // ---- swing_profile: Savitzky-Golay ---------------------------------------

  // Solve the small symmetric system (A^T A) x = b by Gaussian elimination.
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }

  // Least-squares polynomial of degree `order` through y[start .. start+window),
  // parameterized on centred offsets -h..h. scipy's interior filter is this fit's
  // derivative at offset 0; its mode="interp" edges are the same fit evaluated at
  // the other offsets, so one routine serves both.
  function fitWindow(y, start, window, order) {
    const h = (window - 1) / 2;
    const AtA = Array.from({ length: order + 1 }, () => new Array(order + 1).fill(0));
    const Atb = new Array(order + 1).fill(0);
    for (let k = 0; k < window; k++) {
      const x = k - h, yk = y[start + k];
      let xi = 1;
      const pow = [];
      for (let i = 0; i <= order; i++) { pow.push(xi); xi *= x; }
      for (let i = 0; i <= order; i++) {
        Atb[i] += pow[i] * yk;
        for (let j = 0; j <= order; j++) AtA[i][j] += pow[i] * pow[j];
      }
    }
    return solve(AtA, Atb);  // beta[i] multiplies offset^i
  }

  function polyDeriv(beta, deriv, x) {
    let s = 0;
    for (let i = deriv; i < beta.length; i++) {
      let c = 1;
      for (let k = 0; k < deriv; k++) c *= i - k;  // i! / (i-deriv)!
      s += c * beta[i] * x ** (i - deriv);
    }
    return s;
  }

  // scipy.signal.savgol_filter(y, window, order, deriv, delta) with mode="interp".
  function savgolFilter(y, window, order, deriv, delta) {
    const n = y.length, h = (window - 1) / 2, out = new Array(n);
    const scale = delta ** deriv;
    for (let i = h; i < n - h; i++) out[i] = polyDeriv(fitWindow(y, i - h, window, order), deriv, 0) / scale;
    const head = fitWindow(y, 0, window, order), tail = fitWindow(y, n - window, window, order);
    for (let i = 0; i < h; i++) out[i] = polyDeriv(head, deriv, i - h) / scale;
    for (let i = n - h; i < n; i++) out[i] = polyDeriv(tail, deriv, i - (n - window) - h) / scale;
    return out;
  }

  // numpy.gradient with uniform spacing: central differences, one-sided at the ends.
  function gradient(y, dt) {
    const n = y.length, out = new Array(n);
    out[0] = (y[1] - y[0]) / dt;
    out[n - 1] = (y[n - 1] - y[n - 2]) / dt;
    for (let i = 1; i < n - 1; i++) out[i] = (y[i + 1] - y[i - 1]) / (2 * dt);
    return out;
  }

  // Add the bat-speed derivatives to a swing-path curve. Both come from a
  // Savitzky-Golay filter, which fits a local polynomial rather than differencing
  // neighbours, so it does not amplify the digitizer's residual pixel noise. The
  // default window spans roughly five of the card's ~32 native markers. Jerk is the
  // exact analytic derivative of the same local fit, so the two cannot disagree.
  //
  // Without a duration the derivatives are in mph per unit swing time. With one
  // (seconds) the result also carries time_ms, accel_g and jerk_g_per_s.
  function addKinematics(curve, { smoothWindow = 15, polyorder = 3, swingDuration = null } = {}) {
    const t = curve.swing_time, v = curve.bat_speed_mph;
    if (t.length < 5) throw new Error(`need at least 5 samples to differentiate, got ${t.length}`);
    const dt = t[1] - t[0];
    for (let i = 2; i < t.length; i++) {
      const s = t[i] - t[i - 1];
      if (Math.abs(s - dt) > 1e-9 + 1e-6 * Math.abs(dt)) throw new Error("swing_time must be uniformly spaced");
    }
    let window = Math.min(smoothWindow, t.length % 2 ? t.length : t.length - 1);
    if (window % 2 === 0) window -= 1;
    let accel, jerk;
    if (window > polyorder) {
      accel = savgolFilter(v, window, polyorder, 1, dt);
      jerk = savgolFilter(v, window, polyorder, 2, dt);
    } else {  // too few samples to fit the local polynomial
      accel = gradient(v, dt);
      jerk = gradient(accel, dt);
    }
    const out = { ...curve, accel_mph_per_t: accel, jerk_mph_per_t2: jerk };
    if (swingDuration !== null) {
      if (!(swingDuration > 0)) throw new Error("swing_duration must be positive");
      out.time_s = t.map((x) => x * swingDuration);
      out.time_ms = out.time_s.map((x) => x * 1000);
      // mph per unit t -> ft/s per second; each further derivative divides by
      // another factor of the duration.
      out.accel_fps2 = accel.map((a) => (a * MPH_TO_FPS) / swingDuration);
      out.accel_g = out.accel_fps2.map((a) => a / G_FPS2);
      out.jerk_fps3 = jerk.map((j) => (j * MPH_TO_FPS) / swingDuration ** 2);
      out.jerk_g_per_s = out.jerk_fps3.map((j) => j / G_FPS2);
    }
    return out;
  }

  // Canonical figure name: swing_kinematics_{id}_{hand}.png. Handedness belongs in
  // the name: a switch hitter has a card per bat side under a single MLBAM id.
  function figureFilename(mlbamId, handedness, suffix = "", ext = "png") {
    const tag = suffix ? `_${suffix}` : "";
    return `swing_kinematics_${Number(mlbamId)}_${String(handedness).toUpperCase()}${tag}.${ext}`;
  }

  // Card image -> bat-speed curve -> imputed duration -> acceleration. `player` is
  // an MLBAM id or a name; `swingDuration` (seconds) overrides the imputation.
  async function getSwingProfile(player, year, handedness, {
    nPoints = 101, smooth = 0.03, smoothWindow = 15, swingDuration = null, leaderboard = null,
  } = {}) {
    year = Number(year);
    handedness = String(handedness).toUpperCase();
    const lb = leaderboard || (await fetchBatTracking(year));
    const ref = resolvePlayer(player, year, handedness, lb);
    const card = await fetchCard(ref.mlbam_id, year, handedness);
    const curve = extractSwingCurve(card, nPoints, smooth);
    const timing = imputeSwingDuration(ref.mlbam_id, year, handedness, curve, lb);
    const duration = swingDuration === null ? timing.duration_s : Number(swingDuration);
    const k = addKinematics(curve, { smoothWindow, swingDuration: duration });

    const name = ref.name || timing.name;
    const data = {
      MLBAMID: ref.mlbam_id,
      Name: name ? displayName(name) : null,
      Hand: handedness,
      Season: year,
      standardized_time: k.swing_time,
      swing_time: k.time_ms,
      swing_speed: k.bat_speed_mph,
      acceleration: k.accel_g,
      jerk: k.jerk_g_per_s,
    };
    const n = data.swing_speed.length;
    const argmax = (a) => a.reduce((b, x, i) => (x > a[b] ? i : b), 0);
    const argmin = (a) => a.reduce((b, x, i) => (x < a[b] ? i : b), 0);
    const peak = argmax(data.acceleration);
    return {
      mlbam_id: ref.mlbam_id,
      name,
      display_name: name ? displayName(name) : null,
      year,
      handedness,
      timing,
      data,
      card,
      warning: ref.warning,
      duration_s: duration,
      duration_ms: duration * 1000,
      impact_mph: data.swing_speed[n - 1],
      peak_accel_g: data.acceleration[peak],
      peak_accel_ms: data.swing_time[peak],
      peak_jerk: data.jerk[argmax(data.jerk)],
      min_jerk: data.jerk[argmin(data.jerk)],
      traced_columns: curve.traced_columns,
      filename: (suffix = "", ext = "png") => figureFilename(ref.mlbam_id, handedness, suffix, ext),
    };
  }

  // The OUTPUT_COLUMNS frame as CSV, one row per sample.
  function profileCsv(profile) {
    const d = profile.data;
    const cols = ["MLBAMID", "Name", "Hand", "Season", "standardized_time", "swing_time", "swing_speed", "acceleration", "jerk"];
    const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [cols.join(",")];
    for (let i = 0; i < d.swing_speed.length; i++) {
      lines.push([d.MLBAMID, q(d.Name ?? ""), d.Hand, d.Season,
        d.standardized_time[i], d.swing_time[i], d.swing_speed[i], d.acceleration[i], d.jerk[i]].join(","));
    }
    return lines.join("\n") + "\n";
  }

  window.Swing = {
    MPH_TO_FPS, G_FPS2, SPEED_CHECK_TOLERANCE,
    SavantError, AmbiguousPlayerError, SwingPathError,
    LEADERBOARD_URL, CARD_URL,
    parseCsv, displayName, fetchBatTracking, normalize, nameKeys, resolvePlayer,
    decodePng, fetchCard, extractSwingCurve, smoothCurve, interp, pyRound,
    meanBatSpeed, imputeSwingDuration,
    savgolFilter, addKinematics, figureFilename, getSwingProfile, profileCsv,
  };
})();
