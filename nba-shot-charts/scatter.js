// NBA Shot Charts: Shot Value Added, the app's plotly scatter (plotly_chart()) on a canvas.
// Shot making across, shot quality up; each dashed diagonal is one more standard deviation
// of points added, the solid one through the average.

const C = { bg: "#292c42", ink: "#f0f1f5", nav: "#cbd7fd", axis: "#cbd7fd", green: [44, 153, 44], purple: [182, 98, 210] };   // figure.js's green and purple
const DISPLAY = '"DM Sans", system-ui, sans-serif';
const TEXT = '"Work Sans", system-ui, sans-serif';

export const SW = 1100, SH = 760;
const M = { left: 86, right: 28, top: 24, bottom: 76 };

/** Draw valueAdded() rows; returns the points' canvas positions for hover. */
export function drawScatter(canvas, va, { scale = 2 } = {}) {
  canvas.width = SW * scale;
  canvas.height = SH * scale;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, SW, SH);
  const rows = va.rows;
  if (!rows.length) return [];

  const qual = rows.map((r) => r.qual), make = rows.map((r) => r.make), added = rows.map((r) => r.added);
  const topLim = Math.max(...qual, ...make) * 1.1;
  const bottomLim = Math.min(...qual, ...make) * 1.1;
  const axisLim = Math.max(topLim, bottomLim);
  const xr = [Math.min(...make) * 1.1, Math.max(...make) * 1.1];
  const yr = [Math.min(...qual) * 1.1, Math.max(...qual) * 1.1];
  const px = (x) => M.left + ((x - xr[0]) / (xr[1] - xr[0])) * (SW - M.left - M.right);
  const py = (y) => SH - M.bottom - ((y - yr[0]) / (yr[1] - yr[0])) * (SH - M.top - M.bottom);

  ctx.save();
  ctx.beginPath();
  ctx.rect(M.left, M.top, SW - M.left - M.right, SH - M.top - M.bottom);
  ctx.clip();
  const diagonal = (shift, stroke, dash) => {
    ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(px(-axisLim + shift), py(axisLim + shift));
    ctx.lineTo(px(axisLim + shift), py(-axisLim + shift));
    ctx.stroke();
  };
  for (const k of [-3, -2, -1, 1, 2, 3]) diagonal(k * va.guideStep, `rgba(255,255,255,${Math.abs(Math.abs(k) - 3) * 0.2 + 0.1})`, [8, 6]);
  diagonal(0, "#ffffff", []);
  ctx.setLineDash([]);

  // the app's colorscale: purple, white at zero points added, green
  const lo = Math.min(...added), hi = Math.max(...added);
  const white = hi > lo ? -lo / (hi - lo) : 0.5;
  const tone = (v) => {
    const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
    const [a, b, f] = t < white ? [C.purple, [255, 255, 255], t / white] : [[255, 255, 255], C.green, (t - white) / (1 - white)];
    return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * (Number.isFinite(f) ? f : 0))).join(",")})`;
  };
  const points = rows.map((r) => ({ row: r, x: px(r.make), y: py(r.qual) }));
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = tone(p.row.added); ctx.fill();
    ctx.strokeStyle = C.bg; ctx.lineWidth = 1; ctx.stroke();
  }
  // "Avg" at the origin
  ctx.font = `500 15px ${TEXT}`;
  const w = ctx.measureText("Avg").width + 14;
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#c7c7c7"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.rect(px(0) - w / 2, py(0) - 13, w, 26); ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000000"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("Avg", px(0), py(0) + 1);
  ctx.restore();

  axes(ctx, xr, yr, px, py);
  return points;
}

function axes(ctx, xr, yr, px, py) {
  ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(M.left, M.top); ctx.lineTo(M.left, SH - M.bottom); ctx.lineTo(SW - M.right, SH - M.bottom);
  ctx.stroke();
  ctx.fillStyle = C.nav; ctx.font = `400 14px ${TEXT}`;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const t of ticks(xr)) {
    ctx.beginPath(); ctx.moveTo(px(t), SH - M.bottom); ctx.lineTo(px(t), SH - M.bottom + 5); ctx.stroke();
    ctx.fillText(fmt(t), px(t), SH - M.bottom + 8);
  }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of ticks(yr)) {
    ctx.beginPath(); ctx.moveTo(M.left, py(t)); ctx.lineTo(M.left - 5, py(t)); ctx.stroke();
    ctx.fillText(fmt(t), M.left - 8, py(t));
  }
  ctx.fillStyle = C.ink; ctx.font = `600 17px ${DISPLAY}`;
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText("Shot Making Points Added", (M.left + SW - M.right) / 2, SH - 18);
  ctx.save();
  ctx.translate(24, (M.top + SH - M.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "middle";
  ctx.fillText("Shot Quality Points Added", 0, 0);
  ctx.restore();
}

function ticks([lo, hi]) {
  const raw = (hi - lo) / 7;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const fmt = (v) => (Math.abs(v) < 1e-9 ? "0" : Number.isInteger(v) ? String(v) : v.toFixed(1)).replace("-", "−");
