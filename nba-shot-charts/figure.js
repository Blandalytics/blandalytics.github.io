// NBA Shot Charts: the app's scoring summary figure (shot_summary() in nba_shot_chart.py),
// drawn on an 800 x 1440 canvas with the app's two panels stacked: the court and its xPTS scale
// on top, the points waterfall under it. Amber where a player made shots and added points, cyan
// where they missed and gave some back, the xPTS court in seaborn's vlag.

import { SEASON_SHOT_LIMIT, density } from "./model.js?v=1";

export const W = 800, H = 1390;

const C = {
  bg: "#292c42", ink: "#f0f1f5", nav: "#cbd7fd",
  // PLPD's amber (made, points added) and cyan (missed, points given back), as Model Drilldown
  // uses them, each set to the luminance (0.234) with the same contrast against the background and
  // white (~3.7:1, ~3.4:1 against the scale's near-white midpoint)
  amber: "#c86e00", cyan: "#0092a9",
  line: "#000000", outline: "#ffffff",
  // the stat pills' slate: the mix of the background and white that is furthest from all three of
  // the background, the scale's deep red (#a9373b, the bar's end it hangs from) and white, ~2.5:1
  // from the red and white (the most one fill can be) and 5.4:1 from the background
  pill: "#a1a3ac",
};
const DISPLAY = '"DM Sans", system-ui, sans-serif';
const TEXT = '"Work Sans", system-ui, sans-serif';

// The app's cmap="vlag" over its CenteredNorm(1.09, 0.42): xfg_grid.json carries the 256 colours,
// looked up as matplotlib does (no blending between them)
const NORM = { lo: 1.09 - 0.42, hi: 1.09 + 0.42 };
const BAR = { lo: 0.69, hi: 1.51 };   // the colorbar's span, cb.ax.set(xlim=(0.69, 1.51))

// ...with its low half blended into the figure's background, all the way at the bottom, so the
// worst spots sink into the card; white at 1.09 and the red half stay vlag's
const faded = new WeakMap();
function colormap(cmap) {
  if (!faded.has(cmap)) {
    const bg = rgb(C.bg), half = cmap.length / 2;
    faded.set(cmap, cmap.map((hex, i) => {
      if (i >= half) return hex;
      const w = 1 - i / half;   // 1 at the bottom, 0 at the midpoint
      return `rgb(${rgb(hex).map((c, k) => Math.round(c + (bg[k] - c) * w)).join(",")})`;
    }));
  }
  const colors = faded.get(cmap);
  return (v) => {
    const t = (v - NORM.lo) / (NORM.hi - NORM.lo);
    return colors[Math.min(colors.length - 1, Math.max(0, Math.floor(t * colors.length)))];
  };
}

function rgb(color) {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return color.match(/\d+/g).slice(0, 3).map(Number);
}

// WCAG contrast between two colours
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = rgb(c).map((x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// ---- layout ------------------------------------------------------------------------------

// the court: data x -250..250, y -53..400 (the app's xlim / ylim), hoop at (0, 0)
const COURT = { x0: 40, scale: 1.44, top: 130, xlim: [-250, 250], ylim: [-53, 400] };
COURT.w = (COURT.xlim[1] - COURT.xlim[0]) * COURT.scale;
COURT.h = (COURT.ylim[1] - COURT.ylim[0]) * COURT.scale;
COURT.bottom = COURT.top + COURT.h;
const cx = (x) => COURT.x0 + (x - COURT.xlim[0]) * COURT.scale;
const cy = (y) => COURT.bottom - (y - COURT.ylim[0]) * COURT.scale;

// the colorbar sits on the court, its ends on the sidelines (x = ±249), so its outline runs into them
const CB = { x0: cx(-249), w: cx(249) - cx(-249), top: COURT.top - 30, h: 30 };
const cbx = (v) => CB.x0 + ((v - BAR.lo) / (BAR.hi - BAR.lo)) * CB.w;

// the waterfall under the court: categories 0..5 across xlim (-0.6, 5.5), points 0..max * 1.25 up
const FALL = { x0: 40, x1: 760, top: COURT.bottom + 52, bottom: H - 40, xlim: [-0.6, 5.5] };
const fx = (x) => FALL.x0 + ((x - FALL.xlim[0]) / (FALL.xlim[1] - FALL.xlim[0])) * (FALL.x1 - FALL.x0);

// ---- drawing -----------------------------------------------------------------------------

/** Draw the figure for a summary() at `scale` canvas pixels per figure pixel. */
export function draw(canvas, sum, grid, { scale = 2, title } = {}) {
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  // court line widths, held to at least 3 (black) and 7 (white) device pixels on a small canvas
  LINE.inner = Math.max(4, 3 / scale);
  LINE.outer = Math.max(8, 7 / scale);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  text(ctx, title, W / 2, 46, { font: `700 ${fit(ctx, title, 700, 33, W - 48)}px ${DISPLAY}`, align: "center" });
  const heat = colormap(grid.cmap);
  court(ctx, sum, grid, heat);
  colorbar(ctx, sum, heat);
  waterfall(ctx, sum);
}

// the largest size up to `max` at which `s` fits in `room`
function fit(ctx, s, weight, max, room) {
  ctx.font = `${weight} ${max}px ${DISPLAY}`;
  return Math.max(18, Math.floor(max * Math.min(1, room / ctx.measureText(s).width)));
}

function text(ctx, s, x, y, { font = `400 17px ${TEXT}`, color = C.ink, align = "left", baseline = "middle" } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

function court(ctx, sum, grid, heat) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(COURT.x0, COURT.top, COURT.w, COURT.h);
  ctx.clip();

  // the xPTS background: matplotlib's pointy-top hexagons, sx wide, 2*sy/3 centre to tip
  const hw = (grid.sx / 2) * COURT.scale, hh = (grid.sy / 3) * COURT.scale;
  for (let i = 0; i < grid.x.length; i++) {
    const x = cx(grid.x[i]), y = cy(grid.y[i]);
    ctx.beginPath();
    ctx.moveTo(x + hw, y + hh / 2);
    ctx.lineTo(x + hw, y - hh / 2);
    ctx.lineTo(x, y - hh);
    ctx.lineTo(x - hw, y - hh / 2);
    ctx.lineTo(x - hw, y + hh / 2);
    ctx.lineTo(x, y + hh);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle = heat(grid.xpts[i]);
    ctx.lineWidth = 0.75;
    ctx.fill();
    ctx.stroke();
  }

  courtLines(ctx);
  shots(ctx, sum.marked);
  rim(ctx);   // over the shots: the hoop and backboard always show
  ctx.restore();

  if (sum.limited) {
    text(ctx, `Last ${SEASON_SHOT_LIMIT} shots`, cx(0), cy(-47.5), { font: `italic 300 14px ${TEXT}`, align: "center", baseline: "bottom" });
  }
}

const LINE = { inner: 4, outer: 8 };

const Y_ADJ = 52.5;   // the baseline sits this far below the hoop
const arc = (x, y, r, t1, t2, dash) => (c) => {
  c.setLineDash(dash ? [6, 6] : []);
  c.beginPath();
  c.arc(cx(x), cy(y), r * COURT.scale, -t2 * Math.PI / 180, -t1 * Math.PI / 180);
  c.stroke();
};
const seg = (x1, y1, x2, y2) => (c) => {
  c.setLineDash([]);
  c.beginPath();
  c.moveTo(cx(x1), cy(y1));
  c.lineTo(cx(x2), cy(y2));
  c.stroke();
};

// the three-point line as one path, up a corner, round the arc and down the other, so it joins where
// they meet (the corner lines run to where the 23'9" arc reaches x = ±220)
const THREE_T = Math.acos(220 / 237.5), THREE_Y = 237.5 * Math.sin(THREE_T);
const threePoint = (c) => {
  c.setLineDash([]);
  c.beginPath();
  c.moveTo(cx(-220), cy(-Y_ADJ));
  c.lineTo(cx(-220), cy(THREE_Y));
  c.arc(cx(0), cy(0), 237.5 * COURT.scale, -(Math.PI - THREE_T), -THREE_T);
  c.lineTo(cx(220), cy(-Y_ADJ));
  c.stroke();
};
// the lane, its sides and the free-throw line, as one path with square corners
const lane = (c) => {
  c.setLineDash([]);
  c.beginPath();
  c.moveTo(cx(-80), cy(-Y_ADJ));
  c.lineTo(cx(-80), cy(190 - Y_ADJ));
  c.lineTo(cx(80), cy(190 - Y_ADJ));
  c.lineTo(cx(80), cy(-Y_ADJ));
  c.stroke();
};

// every line twice, as the app draws them: a white outline under a black line. Joined lines are
// one path with mitred corners, and open ends are square-capped in both passes, so the white
// shows evenly all round, ends and corners included.
function courtLines(ctx) {
  const yAdj = Y_ADJ;
  const paths = [arc(0, 0, 40, 0, 180), threePoint, lane];   // the restricted area, then the rest
  ctx.lineJoin = "miter"; ctx.lineCap = "square";
  for (const path of paths) { ctx.strokeStyle = C.outline; ctx.lineWidth = LINE.outer; path(ctx); }
  for (const path of paths) { ctx.strokeStyle = C.line; ctx.lineWidth = LINE.inner; path(ctx); }
  ctx.lineCap = "butt";

  // the free-throw circle: a white ring, solid black on top, dashed black underneath
  ctx.strokeStyle = C.outline; ctx.lineWidth = LINE.outer; arc(0, 190 - yAdj, 60, 0, 360)(ctx);
  ctx.strokeStyle = C.line; ctx.lineWidth = LINE.inner;
  arc(0, 190 - yAdj, 60, 0, 180)(ctx);
  arc(0, 190 - yAdj, 60, 180, 360, true)(ctx);
  // baseline and sidelines, white
  ctx.strokeStyle = C.outline; ctx.lineWidth = LINE.inner;
  seg(-250, -yAdj, 250, -yAdj)(ctx);
  seg(-249, -yAdj, -249, 470)(ctx);
  seg(249, -yAdj, 249, 470)(ctx);
  ctx.setLineDash([]);
}

// the hoop (black over white) and backboard (white over black), drawn last
function rim(ctx) {
  const board = seg(-30, 40 - Y_ADJ, 30, 40 - Y_ADJ), hoop = arc(0, 0, 7.5, 0, 360);
  ctx.strokeStyle = C.line; ctx.lineWidth = LINE.outer; board(ctx);
  ctx.strokeStyle = C.outline; ctx.lineWidth = LINE.inner; board(ctx);
  ctx.strokeStyle = C.outline; ctx.lineWidth = LINE.outer; hoop(ctx);
  ctx.strokeStyle = C.line; ctx.lineWidth = LINE.inner; hoop(ctx);
  ctx.setLineDash([]);
}

// misses as an open cyan X over an opaque white one, makes as an amber dot with a white edge
function shots(ctx, marked) {
  const xPath = (x, y, r) => {
    const t = r * 0.32;   // matplotlib's "X": a filled cross, drawn here by its outline
    ctx.beginPath();
    const pts = [[0, t], [r - t, r], [r, r - t], [t, 0], [r, -r + t], [r - t, -r], [0, -t], [-r + t, -r], [-r, -r + t], [-t, 0], [-r, r - t], [-r + t, r]];
    pts.forEach(([dx, dy], i) => (i ? ctx.lineTo(x + dx, y + dy) : ctx.moveTo(x + dx, y + dy)));
    ctx.closePath();
  };
  ctx.lineJoin = "miter";
  for (const s of marked) {
    if (s.made) continue;
    xPath(cx(s.x), cy(s.y), 8.5);
    ctx.strokeStyle = C.outline; ctx.lineWidth = 4.5; ctx.stroke();
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 2; ctx.stroke();
  }
  for (const s of marked) {
    if (!s.made) continue;
    ctx.beginPath();
    ctx.arc(cx(s.x), cy(s.y), 7.5, 0, Math.PI * 2);
    ctx.fillStyle = C.amber; ctx.fill();
    ctx.strokeStyle = C.outline; ctx.lineWidth = 1.4; ctx.stroke();
  }
}

function colorbar(ctx, sum, heat) {
  const { top, h } = CB;
  for (let px = 0; px < CB.w; px++) {
    ctx.fillStyle = heat(BAR.lo + ((px + 0.5) / CB.w) * (BAR.hi - BAR.lo));
    ctx.fillRect(CB.x0 + px, top, 1.5, h);
  }
  // the shots' xPTS distribution, in the background's colour at half strength
  if (sum.xptsValues.length > 1) {
    const xs = Array.from({ length: 200 }, (_, i) => BAR.lo + (i / 199) * (BAR.hi - BAR.lo));
    const ys = density(sum.xptsValues, BAR.lo, BAR.hi, xs);
    if (ys) {
      ctx.beginPath();
      ctx.moveTo(cbx(xs[0]), top + h);
      xs.forEach((x, i) => ctx.lineTo(cbx(x), top + h - ys[i] * h));
      ctx.lineTo(cbx(xs[xs.length - 1]), top + h);
      ctx.closePath();
      ctx.fillStyle = "rgba(41,44,66,.5)";   // C.bg at 50%
      ctx.fill();
      // a thin white edge along the curve (not along the bar's floor)
      ctx.beginPath();
      xs.forEach((x, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, cbx(x), top + h - ys[i] * h));
      ctx.strokeStyle = C.outline; ctx.lineWidth = 1; ctx.lineJoin = "round";
      ctx.stroke();
    }
  }
  // a white edge: 2 on the top and sides, half that along the bottom where it meets the court
  ctx.strokeStyle = C.outline; ctx.lineWidth = 2; ctx.lineJoin = "miter";
  ctx.beginPath();
  ctx.moveTo(CB.x0, top + h); ctx.lineTo(CB.x0, top); ctx.lineTo(CB.x0 + CB.w, top); ctx.lineTo(CB.x0 + CB.w, top + h);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(CB.x0, top + h); ctx.lineTo(CB.x0 + CB.w, top + h); ctx.stroke();

  // ticks along the top, as matplotlib places them
  for (let v = 0.7; v <= 1.5001; v += 0.1) {
    const x = cbx(v);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top - 5); ctx.stroke();
    text(ctx, v.toFixed(1), x, top - 8, { font: `400 14px ${TEXT}`, align: "center", baseline: "bottom", color: C.nav });
  }

  const { expected, actual } = sum;
  const clip = (v) => Math.min(Math.max(v, BAR.lo), BAR.hi);
  const up = actual - expected >= 0;
  const tone = up ? C.amber : C.cyan;
  const vline = (v, color, width) => {
    if (!Number.isFinite(v) || v < BAR.lo || v > BAR.hi) return;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(cbx(v), top); ctx.lineTo(cbx(v), top + h); ctx.stroke();
  };
  // the arrow from xPts/Shot to Pts/Shot: a white outline, then the line (white under its colour),
  // then the arrow's fill, so its point ends on the coloured line's near edge
  const ACTUAL_W = 2.5;
  const shaft = Math.abs(actual - expected) >= 0.025 && Number.isFinite(actual) && Number.isFinite(expected)
    ? arrowPath(cbx(clip(expected)), cbx(clip(actual)) - (up ? 1 : -1) * ACTUAL_W / 2, top + h / 2)
    : null;
  if (shaft) {
    ctx.lineJoin = "miter";
    ctx.strokeStyle = C.outline; ctx.lineWidth = 3;
    ctx.stroke(shaft);
  }
  vline(actual, C.outline, 4.5);
  vline(actual, tone, ACTUAL_W);
  if (shaft) {
    ctx.fillStyle = tone;
    ctx.fill(shaft);
  }
  vline(expected, C.bg, 2.5);   // xPts/Shot, in the background's colour

  // xPts/Shot and Pts/Shot in pills (Lineup Sim's stat box) hanging from the bar into the court's
  // empty top corners: a small label over the value in bold, in the scale's colour
  pill("xPts/Shot", expected, -1);
  pill("Pts/Shot", actual, 1);

  // A pill's borders are the ones it sits against, the sideline (side -1 left, 1 right) and the bar's
  // bottom edge, left uncovered; its own lines are only its two free edges (the bottom and the inner
  // side, as heavy as the bar's outline), with the one rounded corner between them
  function pill(name, v, side) {
    const edge = side < 0 ? CB.x0 : CB.x0 + CB.w, inner = edge - side * PILL.w;
    const y0 = top + h, y1 = y0 + PILL.h, r = PILL.r, s = LINE.inner / 2;
    const corner = (p) => { p.lineTo(inner + side * r, y1); p.arcTo(inner, y1, inner, y1 - r, r); };
    const fill = new Path2D();
    fill.moveTo(edge - side * s, y0 + 0.5);
    fill.lineTo(edge - side * s, y1);
    corner(fill);
    fill.lineTo(inner, y0 + 0.5);
    fill.closePath();
    ctx.fillStyle = C.pill;
    ctx.fill(fill);
    const lines = new Path2D();
    lines.moveTo(edge, y1);
    corner(lines);
    lines.lineTo(inner, y0);
    ctx.strokeStyle = C.outline; ctx.lineWidth = 2; ctx.lineJoin = "miter"; ctx.lineCap = "butt";
    ctx.stroke(lines);
    const mid = (edge + inner) / 2;
    text(ctx, name, mid, y0 + 24, { font: `500 16px ${DISPLAY}`, align: "center", color: C.bg });
    text(ctx, Number.isFinite(v) ? v.toFixed(2) : "–", mid, y0 + 58,
      { font: `700 36px ${DISPLAY}`, align: "center", color: valueColor(v) });
  }
  // the scale's colour at the value, clipped to the bar's span, or the background's where that colour
  // sits too close to the pill's (the mid blues and the pinks; the red, white and background ends clear it)
  function valueColor(v) {
    if (!Number.isFinite(v)) return C.bg;
    const c = heat(clip(v));
    return contrast(c, C.pill) >= 2.5 ? c : C.bg;
  }
}

const PILL = { w: 127, h: 84, r: 10 };

// one outline for the shaft and head, from x1 to the point at x2
function arrowPath(x1, x2, y) {
  const dir = Math.sign(x2 - x1) || 1;
  const half = 2.5, head = 7;
  const len = Math.min(13, Math.abs(x2 - x1) * 0.6);   // a short arrow keeps some shaft
  const neck = x2 - dir * len;
  const p = new Path2D();
  p.moveTo(x1, y - half);
  p.lineTo(neck, y - half);
  p.lineTo(neck, y - head);
  p.lineTo(x2, y);
  p.lineTo(neck, y + head);
  p.lineTo(neck, y + half);
  p.lineTo(x1, y + half);
  p.closePath();
  return p;
}

function waterfall(ctx, sum) {
  const p = sum.parts;
  const cats = [["Shot", "Volume"], ["Shot", "Quality"], ["Shot", "Making"], ["xFT", "Volume"], ["FT", "Drawing"], ["FT", "Making"]];
  const values = [p.volume, p.quality, p.making, p.xftaVolume, p.ftDrawing, p.ftMaking];
  const cum = [];
  values.reduce((t, v, i) => (cum[i] = t + v), 0);
  const max = Math.max(...cum);
  const ymax = max * 1.25;
  const fy = (v) => FALL.bottom - (v / ymax) * (FALL.bottom - FALL.top);
  const total = Math.round(values.reduce((a, b) => a + b, 0));

  // the two halves: shots, then free throws
  ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(fx(2.5), fy(0)); ctx.lineTo(fx(2.5), fy(ymax * 0.95)); ctx.stroke();

  values.forEach((v, i) => {
    const start = fy(cum[i] - v), end = fy(cum[i]);
    ctx.fillStyle = v >= 0 ? C.amber : C.cyan;
    ctx.fill(bar(fx(i - 0.4), fx(i + 0.4), start, end));
  });
  // dotted steps from each bar's top to the next
  ctx.strokeStyle = C.outline; ctx.lineWidth = 1.4; ctx.setLineDash([1.5, 1.5]);
  cum.forEach((c, i) => {
    ctx.beginPath(); ctx.moveTo(fx(i + 0.39), fy(c)); ctx.lineTo(fx(i + 0.61), fy(c)); ctx.stroke();
  });
  ctx.setLineDash([]);
  // the total, across
  ctx.strokeStyle = C.outline; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(fx(-0.48), fy(total)); ctx.lineTo(fx(5.5), fy(total)); ctx.stroke();

  values.forEach((v, i) => {
    const tone = v >= 0 ? C.amber : C.cyan;
    text(ctx, cats[i][0], fx(i), fy(max * 1.075) - 10, { font: `500 15px ${DISPLAY}`, align: "center" });
    text(ctx, cats[i][1], fx(i), fy(max * 1.075) + 10, { font: `500 15px ${DISPLAY}`, align: "center" });
    tag(ctx, `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`, fx(i), fy(cum[i]), tone, sum.game == null ? 14 : 17);
  });

  text(ctx, `${total} Points Scored`, fx(2.5), fy(max * 1.225), { font: `700 25px ${DISPLAY}`, align: "center" });
  text(ctx, `Pts via Shots: ${sum.shotPoints.toFixed(0)}`, fx(1), fy(max * 1.15), { font: `500 18px ${DISPLAY}`, align: "center" });
  text(ctx, `Pts via Free Throws: ${sum.ftPoints.toFixed(0)}`, fx(4), fy(max * 1.15), { font: `500 18px ${DISPLAY}`, align: "center" });
  text(ctx, "blandalytics.com", fx(4.1), FALL.bottom - 4, { font: `300 14px ${TEXT}`, align: "center", baseline: "bottom", color: C.nav });
}

// A waterfall bar as Model Drilldown draws them (charts.js bar()): square where it starts (the
// running total before it) and rounded where it ends, on top for a gain and underneath for a loss
const BAR_R = 9;
function bar(x0, x1, start, end) {
  if (Math.abs(end - start) < 1) end = start + (end < start ? -1 : 1);
  const r = Math.min(BAR_R, (x1 - x0) / 2, Math.abs(end - start));
  const d = end < start ? 1 : -1;   // from the end's edge back toward the start (canvas y runs down)
  const p = new Path2D();
  p.moveTo(x0, start);
  p.lineTo(x0, end + d * r);
  p.quadraticCurveTo(x0, end, x0 + r, end);
  p.lineTo(x1 - r, end);
  p.quadraticCurveTo(x1, end, x1, end + d * r);
  p.lineTo(x1, start);
  p.closePath();
  return p;
}

// a value label, as the app draws it: tone text in a white rounded box with a tone edge
function tag(ctx, s, x, y, tone, size) {
  ctx.font = `600 ${size}px ${TEXT}`;
  const w = ctx.measureText(s).width + 14, h = size + 10;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 6);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.strokeStyle = tone; ctx.lineWidth = 1.5; ctx.stroke();
  text(ctx, s, x, y + 0.5, { font: `600 ${size}px ${TEXT}`, align: "center", color: tone });
}

