// NBA Shot Charts: the app's scoring summary figure (shot_summary() in nba_shot_chart.py),
// drawn on a canvas in the figure's own 1400 x 800 layout (the app's 14 x 8 in at 100 dpi),
// in PLPD colours: amber where a player added points, cyan where they gave some back, the
// xPTS court in the heat cell's blue-white-red.

import { SEASON_SHOT_LIMIT, density } from "./model.js?v=1";

export const W = 1400, H = 800;

const C = {
  bg: "#292c42", ink: "#f0f1f5", nav: "#cbd7fd", amber: "#ffc277", cyan: "#55e8ff", navy: "#13152a",
  line: "#000000", outline: "#ffffff",
};
const DISPLAY = '"DM Sans", system-ui, sans-serif';
const TEXT = '"Work Sans", system-ui, sans-serif';

// PLPD heat cell, coldest to hottest, read continuously over the app's CenteredNorm(1.09, 0.42)
const HEAT = ["#0066ff", "#5599ff", "#aaccff", "#ffffff", "#e2bcbe", "#c6797c", "#a9363b"].map(hex);
const NORM = { lo: 1.09 - 0.42, hi: 1.09 + 0.42 };
const BAR = { lo: 0.69, hi: 1.51 };   // the colorbar's span, cb.ax.set(xlim=(0.69, 1.51))

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function heat(v) {
  const t = Math.min(Math.max((v - NORM.lo) / (NORM.hi - NORM.lo), 0), 1) * (HEAT.length - 1);
  const i = Math.min(Math.floor(t), HEAT.length - 2), f = t - i;
  const [a, b] = [HEAT[i], HEAT[i + 1]];
  return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(",")})`;
}

// ---- layout ------------------------------------------------------------------------------

// the court: data x -250..250, y -53..400 (the app's xlim / ylim), hoop at (0, 0)
const COURT = { x0: 760, scale: 1.2, bottom: 752, xlim: [-250, 250], ylim: [-53, 400] };
COURT.w = (COURT.xlim[1] - COURT.xlim[0]) * COURT.scale;
COURT.h = (COURT.ylim[1] - COURT.ylim[0]) * COURT.scale;
COURT.top = COURT.bottom - COURT.h;
const cx = (x) => COURT.x0 + (x - COURT.xlim[0]) * COURT.scale;
const cy = (y) => COURT.bottom - (y - COURT.ylim[0]) * COURT.scale;

// the colorbar over the court, 94% of its width (shrink=0.94)
const CB = { x0: COURT.x0 + COURT.w * 0.03, w: COURT.w * 0.94, top: COURT.top - 36, h: 30 };
const cbx = (v) => CB.x0 + ((v - BAR.lo) / (BAR.hi - BAR.lo)) * CB.w;

// the waterfall: categories 0..5 across xlim (-0.6, 5.5), points 0..max * 1.25 up
const FALL = { x0: 70, x1: 700, top: 112, bottom: 752, xlim: [-0.6, 5.5] };
const fx = (x) => FALL.x0 + ((x - FALL.xlim[0]) / (FALL.xlim[1] - FALL.xlim[0])) * (FALL.x1 - FALL.x0);

// ---- drawing -----------------------------------------------------------------------------

/** Draw the figure for a summary() at `scale` canvas pixels per figure pixel. */
export function draw(canvas, sum, grid, { scale = 2, title } = {}) {
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  text(ctx, title, W * 0.51, 46, { font: `700 33px ${DISPLAY}`, align: "center" });
  court(ctx, sum, grid);
  colorbar(ctx, sum);
  waterfall(ctx, sum);
}

function text(ctx, s, x, y, { font = `400 17px ${TEXT}`, color = C.ink, align = "left", baseline = "middle" } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

function court(ctx, sum, grid) {
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
  ctx.restore();

  text(ctx, "@blandalytics", cx(242.5), cy(385), { font: `400 17px ${TEXT}`, align: "right" });
  if (sum.limited) {
    text(ctx, `Last ${SEASON_SHOT_LIMIT} shots`, cx(0), cy(-47.5), { font: `italic 300 14px ${TEXT}`, align: "center", baseline: "bottom" });
  }
}

// every line twice, as the app draws them: a white outline under a black line
function courtLines(ctx) {
  const yAdj = 52.5;
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
  const pairs = [
    // hoop, restricted area
    [arc(0, 0, 7.5, 0, 360), 4, 2],
    [arc(0, 0, 40, 0, 180), 4, 2],
    // three-point arc and corners
    [arc(0, 0, 237.5, 22, 158), 4, 2],
    [seg(-220, -yAdj, -220, 141 - yAdj), 4, 2],
    [seg(220, -yAdj, 220, 141 - yAdj), 4, 2],
    // free-throw lane and line
    [seg(-80, 190 - yAdj, 80, 190 - yAdj), 4, 2],
    [seg(-80, -yAdj, -80, 190 - yAdj), 4, 2],
    [seg(80, -yAdj, 80, 190 - yAdj), 4, 2],
  ];
  for (const [path, outer] of pairs) { ctx.strokeStyle = C.outline; ctx.lineWidth = outer; path(ctx); }
  for (const [path, , inner] of pairs) { ctx.strokeStyle = C.line; ctx.lineWidth = inner; path(ctx); }

  // the free-throw circle: a white ring, solid black on top, dashed black underneath
  ctx.strokeStyle = C.outline; ctx.lineWidth = 4; arc(0, 190 - yAdj, 60, 0, 360)(ctx);
  ctx.strokeStyle = C.line; ctx.lineWidth = 2;
  arc(0, 190 - yAdj, 60, 0, 180)(ctx);
  arc(0, 190 - yAdj, 60, 180, 360, true)(ctx);
  // the backboard: black under white
  ctx.strokeStyle = C.line; ctx.lineWidth = 4; seg(-30, 40 - yAdj, 30, 40 - yAdj)(ctx);
  ctx.strokeStyle = C.outline; ctx.lineWidth = 2; seg(-30, 40 - yAdj, 30, 40 - yAdj)(ctx);
  // baseline and sidelines, white
  ctx.lineWidth = 2;
  seg(-250, -yAdj, 250, -yAdj)(ctx);
  seg(-249, -yAdj, -249, 470)(ctx);
  seg(249, -yAdj, 249, 470)(ctx);
  ctx.setLineDash([]);
}

// misses as an open X (white under cyan), makes as an amber dot with a white edge
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
    ctx.globalAlpha = 0.75; ctx.strokeStyle = C.outline; ctx.lineWidth = 4.5; ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = C.cyan; ctx.lineWidth = 2; ctx.stroke();
  }
  for (const s of marked) {
    if (!s.made) continue;
    ctx.beginPath();
    ctx.arc(cx(s.x), cy(s.y), 7.5, 0, Math.PI * 2);
    ctx.fillStyle = C.amber; ctx.fill();
    ctx.strokeStyle = C.outline; ctx.lineWidth = 1.4; ctx.stroke();
  }
}

function colorbar(ctx, sum) {
  const { top, h } = CB;
  for (let px = 0; px < CB.w; px++) {
    ctx.fillStyle = heat(BAR.lo + ((px + 0.5) / CB.w) * (BAR.hi - BAR.lo));
    ctx.fillRect(CB.x0 + px, top, 1.5, h);
  }
  // the shots' xPTS distribution, as a shadow over the scale
  if (sum.xptsValues.length > 1) {
    const xs = Array.from({ length: 200 }, (_, i) => BAR.lo + (i / 199) * (BAR.hi - BAR.lo));
    const ys = density(sum.xptsValues, BAR.lo, BAR.hi, xs);
    if (ys) {
      ctx.beginPath();
      ctx.moveTo(cbx(xs[0]), top + h);
      xs.forEach((x, i) => ctx.lineTo(cbx(x), top + h - ys[i] * h));
      ctx.lineTo(cbx(xs[xs.length - 1]), top + h);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,.4)";
      ctx.fill();
    }
  }
  ctx.strokeStyle = C.outline; ctx.lineWidth = 2;
  ctx.strokeRect(CB.x0, top, CB.w, h);

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
  vline(actual, C.outline, 4.5);
  vline(actual, tone, 2.5);
  if (Math.abs(actual - expected) >= 0.025) {
    const x1 = cbx(clip(expected)), x2 = cbx(clip(up ? actual + 0.0025 : actual - 0.0025)), y = top + h / 2;
    arrow(ctx, x1, x2, y, "rgba(255,255,255,.75)", 7, 9);
    arrow(ctx, x1, x2, y, tone, 3.5, 6);
  }
  vline(expected, C.line, 2.5);

  const label = (v) => (Number.isFinite(v) ? v.toFixed(2) : "–");
  text(ctx, `xPts/Shot: ${label(expected)}`, COURT.x0 + COURT.w * 0.27, top - 46, { font: `500 25px ${DISPLAY}`, align: "center" });
  text(ctx, `Pts/Shot: ${label(actual)}`, COURT.x0 + COURT.w * 0.73, top - 46, { font: `500 25px ${DISPLAY}`, align: "center" });
}

function arrow(ctx, x1, x2, y, color, width, head) {
  const dir = Math.sign(x2 - x1) || 1;
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "butt";
  ctx.beginPath(); ctx.moveTo(x1 + dir * 2, y); ctx.lineTo(x2 - dir * head * 1.2, y); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y);
  ctx.lineTo(x2 - dir * head * 1.6, y - head);
  ctx.lineTo(x2 - dir * head * 1.6, y + head);
  ctx.closePath();
  ctx.fill();
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
    const tone = v >= 0 ? C.amber : C.cyan;
    const top = fy(cum[i]), bottom = fy(cum[i] - v);
    ctx.fillStyle = tone;
    ctx.fillRect(fx(i - 0.4), Math.min(top, bottom), fx(i + 0.4) - fx(i - 0.4), Math.max(Math.abs(bottom - top), 1));
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

// a value label: tone text in a white rounded box with a tone edge
function tag(ctx, s, x, y, tone, size) {
  ctx.font = `600 ${size}px ${TEXT}`;
  const w = ctx.measureText(s).width + 14, h = size + 10;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 6);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.strokeStyle = tone; ctx.lineWidth = 1.5; ctx.stroke();
  text(ctx, s, x, y + 0.5, { font: `600 ${size}px ${TEXT}`, align: "center", color: tone === C.amber ? "#8a5a12" : "#00708a" });
}

