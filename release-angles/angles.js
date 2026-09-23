// The Release Angles figure: release_angles.py (Blandalytics/baseball_snippets) ported to
// the browser. One ellipse per pitch type over horizontal against vertical release angle,
// and four encodings of the same chart -- the outlines alone, the number of pitch types
// overlapping, the share of the pitcher's pitches covering each spot, and the pitch
// concentration of each overlap segment -- plus the loop that cross-fades through them.
//
// `build(pitches, opts)` does the arithmetic the Python's build() does (the ellipses, the
// frame, the depth / share / segment maps, where the names go); `draw(canvas, model, dpi,
// weights)` paints one state or any blend of two onto a canvas at the Python figure's
// geometry (11.6 in square; 200 dpi for the stills, 80 for the GIF); `gif(model)` encodes
// the loop. Constants keep the Python's names so the two can be read side by side.

window.ReleaseAngles = (() => {
  "use strict";

  const FPS = 20, HOLD = 72, TRANS = 14, DPI_GIF = 80, DPI_PNG = 200;
  const STATES = 4;   // outline, count, share, concentration

  const NAMES = {
    FF: "Four-Seam", SI: "Sinker", CH: "Changeup", FS: "Splitter", SL: "Slider", ST: "Sweeper",
    CU: "Curveball", FC: "Cutter", KC: "Knuckle Curve", SV: "Slurve", FO: "Forkball",
    KN: "Knuckleball", EP: "Eephus", SC: "Screwball", CS: "Slow Curve", FA: "Fastball",
    FT: "Two-Seam", GY: "Gyroball", PO: "Pitchout",
  };
  const HUES = {
    FF: "#FF6683", SI: "#F2B24B", FS: "#83D6FF", FO: "#83D6FF", FC: "#C59C9C", SL: "#CE66FF",
    ST: "#FFAAF7", CU: "#339cff", CS: "#2A98FF", SV: "#2A98FF", CH: "#6DE95D", SC: "#6DE95D",
    KN: "#999999", UN: "#999999",
  };

  const FONT = '"DM Sans", "Segoe UI", "DejaVu Sans", sans-serif';
  // matplotlib asks for "semibold" and gets the Bold cut: the script registers 400 and 700
  const SEMIBOLD = 700;
  const WORDMARK_URL = "../pitcher-cards/PitcherList_Stats_watermark_with_logo.webp";
  const WATERMARK_W = 0.25;

  const SURFACE = "#262940", TITLE = "#72CBFD", RULE = "#4a4d63";
  const INK = "#ffffff", INK2 = INK, INK3 = INK;
  const RAMP_ENDS = ["#262940", "#ffffff"];

  const FRAME_PAD = [0.26, 0.20];
  const SIDE_PAD = 0.07, TOP_PAD = 0.04, BOT_PAD = 0.24;
  const GRIDC = "#3a3d55";

  const FIG_W = 11.6, FIG_ASPECT = 1.0;
  const L = 0.035, B = 0.052, W_FRAC = 0.93, TOP = 0.875;
  const RULE_Y = 0.888;
  const FOOT_Y = 0.016;
  const FIG_H = FIG_W / FIG_ASPECT;
  const AX_H = TOP - B;
  const AX_W = AX_H * FIG_H / FIG_W;
  const AX_L = (1 - AX_W) / 2;
  const AXES_RATIO = AX_W * FIG_W / (AX_H * FIG_H);
  const W_INK = 5.0, W_LAP = 8.0, W_OUT = 6.0, W_TET = 1.3;
  const LABEL_PT = 18;
  const LABEL_CLEAR = 1.13, LEADER_GAP = 0.28, LEADER_MIN = 0.30;
  const LADDER = [1.0, 1.9, 3.0, 4.4, 6.3, 8.8, 11.9];
  const GRID_N = 1100;
  const TITLES = [
    ["Release Angles", ""],
    ["Release Angle Overlap", "Number of Pitch Types"],
    ["Release Angle Overlap", "Weighted by Usage"],
    ["Release Angle Overlap", "Pitch Concentration"],
  ];
  const TAGS = ["type", "count", "share", "segment"];

  // ---- colour ---------------------------------------------------------------------------
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const M = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
  const WHITE = [0.95047, 1.0, 1.08883];
  function inv3(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const A = e * i - f * h, Bq = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * Bq + c * C;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
            [Bq / det, (a * i - c * g) / det, -(a * f - c * d) / det],
            [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  }
  const MINV = inv3(M);
  const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  function toLab(rgb) {
    const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const xyz = mul(M, lin).map((v, k) => v / WHITE[k]);
    const d = 6 / 29;
    const f = xyz.map((t) => (t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29));
    return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
  }
  function fromLab(lab) {
    const fy = (lab[0] + 16) / 116;
    const f = [fy + lab[1] / 500, fy, fy - lab[2] / 200];
    const d = 6 / 29;
    const xyz = f.map((t, k) => (t > d ? t ** 3 : 3 * d * d * (t - 4 / 29)) * WHITE[k]);
    return mul(MINV, xyz).map((c) => Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * Math.abs(c) ** (1 / 2.4) - 0.055)));
  }
  // lab_ramp(): 48 colours evenly spaced in L*a*b*
  function labRamp(c0, c1, n = 48) {
    const a = toLab(hexRgb(c0)), b = toLab(hexRgb(c1));
    return Array.from({ length: n }, (_, i) => { const t = n === 1 ? 0 : i / (n - 1); return fromLab(a.map((v, k) => v + t * (b[k] - v))); });
  }
  // LinearSegmentedColormap.from_list(): a 256-entry table, linear between the nodes
  function lut256(colors) {
    const n = colors.length, N = 256, out = [];
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      if (i === 0) { out.push(colors[0]); continue; }
      if (i === N - 1) { out.push(colors[n - 1]); continue; }
      const pos = x * (n - 1), k = Math.min(n - 2, Math.floor(pos)), t = pos - k;
      out.push(colors[k].map((v, c) => v + t * (colors[k + 1][c] - v)));
    }
    return out;
  }
  const LUT = lut256(labRamp(...RAMP_ENDS));
  // a colormap called on a normalised value: floor(v * N), clipped into the table
  const lutIndex = (v) => (Number.isNaN(v) ? 0 : Math.max(0, Math.min(255, Math.floor(v * 256))));
  const cmap = (v) => LUT[lutIndex(v)];
  const normalize = (lo, hi) => (v) => (hi === lo ? 0 : (v - lo) / (hi - lo));
  const css = (rgb, a = 1) => `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;

  // ---- geometry ---------------------------------------------------------------------------
  // group_ellipse() from ellipse_depth.py: the n_std covariance ellipse, or null if degenerate
  function groupEllipse(xs, ys, nStd = 1.0) {
    const x = [], y = [];
    for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { x.push(xs[i]); y.push(ys[i]); }
    const n = x.length;
    if (n < 3) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    sxx /= n - 1; syy /= n - 1; sxy /= n - 1;
    if (!(sxx > 0) || !(syy > 0)) return null;
    const r = sxy / Math.sqrt(sxx * syy);
    if (!Number.isFinite(r) || Math.abs(r) >= 1 - 1e-12) return null;
    return {
      mean: [mx, my],
      scale: [Math.sqrt(sxx) * nStd, Math.sqrt(syy) * nStd],
      radii: [Math.sqrt(1 + r), Math.sqrt(1 - r)],
      pearson: r,
    };
  }
  const area = (e) => Math.PI * e.scale[0] * e.scale[1] * e.radii[0] * e.radii[1];
  const bounds = (e) => [e.mean[0] - e.scale[0], e.mean[0] + e.scale[0], e.mean[1] - e.scale[1], e.mean[1] + e.scale[1]];
  const CA = Math.cos(-Math.PI / 4), SA = Math.sin(-Math.PI / 4);
  function contains(e, gx, gy) {
    const u = (gx - e.mean[0]) / e.scale[0], v = (gy - e.mean[1]) / e.scale[1];
    const p = u * CA - v * SA, q = u * SA + v * CA;
    return (p / e.radii[0]) ** 2 + (q / e.radii[1]) ** 2 <= 1.0;
  }
  // boundary(): the outline as n points, rotated 45 degrees then scaled
  function boundary(e, n = 361) {
    const a = Math.PI / 4, c = Math.cos(a), s = Math.sin(a), bx = new Float64Array(n), by = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / (n - 1);
      const px = e.radii[0] * Math.cos(t), py = e.radii[1] * Math.sin(t);
      bx[i] = (c * px - s * py) * e.scale[0] + e.mean[0];
      by[i] = (s * px + c * py) * e.scale[1] + e.mean[1];
    }
    return [bx, by];
  }
  function linspace(a, b, n) {
    const out = new Float64Array(n), step = (b - a) / (n - 1);
    for (let i = 0; i < n; i++) out[i] = a + i * step;
    if (n > 1) out[n - 1] = b;
    return out;
  }

  function niceTicks(lo, hi, most = 6) {
    let step = 10.0;
    for (const s of [0.5, 1.0, 2.0, 2.5, 5.0, 10.0]) { step = s; if ((hi - lo) / s <= most) break; }
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v + 0.0);
    return out;
  }
  function windowFor(x0, x1, y0, y1) {
    const dwMin = (x1 - x0) / (1 - 2 * SIDE_PAD);
    const dhMin = (y1 - y0) / (1 - TOP_PAD - BOT_PAD);
    const dw = Math.max(dwMin, AXES_RATIO * dhMin);
    const dh = dw / AXES_RATIO;
    const xc = (x0 + x1) / 2;
    return { XLIM: [xc - dw / 2, xc + dw / 2], YLIM: [y1 + TOP_PAD * dh - dh, y1 + TOP_PAD * dh], dw, dh };
  }
  function clusterBox(ells) {
    const b = Object.values(ells).map(bounds);
    return [Math.min(...b.map((v) => v[0])), Math.max(...b.map((v) => v[1])), Math.min(...b.map((v) => v[2])), Math.max(...b.map((v) => v[3]))];
  }
  function squareFrame(cx0, cx1, cy0, cy1) {
    const padx = FRAME_PAD[0] * (cx1 - cx0), pady = FRAME_PAD[1] * (cy1 - cy0);
    const x0 = cx0 - padx, x1 = cx1 + padx, y0 = cy0 - pady, y1 = cy1 + pady;
    const side = Math.max(x1 - x0, y1 - y0), xc = (x0 + x1) / 2, yc = (y0 + y1) / 2;
    return [xc - side / 2, xc + side / 2, yc - side / 2, yc + side / 2];
  }

  // fit_ellipses(): one per pitch type with enough pitches, busiest first
  function fitEllipses(pitches, nStd, minRows) {
    const counts = new Map();
    for (const p of pitches) counts.set(p.t, (counts.get(p.t) || 0) + 1);
    const types = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const ells = {}, order = [], skipped = [];
    for (const t of types) {
      const sub = pitches.filter((p) => p.t === t);
      const e = groupEllipse(sub.map((p) => p.x), sub.map((p) => p.y), nStd);
      if (!e || counts.get(t) < minRows) skipped.push(`${NAMES[t] || t} (${counts.get(t)})`);
      else { ells[t] = e; order.push(t); }
    }
    return { ells, order, skipped, counts };
  }

  // ---- text ---------------------------------------------------------------------------------
  // matplotlib 3.11's text layout (Text._get_layout): every line box is at least the font's
  // typographic ascender and descender tall (DM Sans: 992 and 310 per 1000 em, no line gap),
  // stacked with no gap; a numeric linespacing instead makes each box linespacing x
  // (ascender + descender), centred on the line's ink. va aligns the whole block.
  const ASC = 0.992, DESC = 0.310;
  let measureCtx = null;
  function mctx() {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    return measureCtx;
  }
  function fontSpec(pt, weight, dpi) { return `${weight} ${(pt * dpi) / 72}px ${FONT}`; }
  function textBlock(ctx, s, em, linespacing = "normal") {
    let y = 0;
    const lines = s.split("\n").map((line) => {
      const m = line ? ctx.measureText(line) : null;
      let a = m ? m.actualBoundingBoxAscent : 0, d = m ? m.actualBoundingBoxDescent : 0;
      if (linespacing === "normal") { a = Math.max(a, ASC * em); d = Math.max(d, DESC * em); }
      else { const lead = linespacing * (ASC + DESC) * em - (a + d); a += lead / 2; d += lead / 2; }
      y += a;
      const out = { line, w: m ? m.width : 0, base: y };
      y += d;
      return out;
    });
    return { lines, ys: lines.map((l) => l.base), height: y, width: Math.max(...lines.map((l) => l.w)) };
  }
  // one text artist: x, y in px; ha / va as matplotlib's; optional stroke and rotation
  function drawText(ctx, s, x, y, o) {
    const { pt, weight = 400, colour = INK, ha = "left", va = "baseline", dpi, alpha = 1,
      stroke = null, linespacing = "normal", rotation = 0 } = o;
    if (alpha <= 0) return;
    ctx.save();
    ctx.font = fontSpec(pt, weight, dpi);
    const blk = textBlock(ctx, s, (pt * dpi) / 72, linespacing);
    ctx.translate(x, y);
    if (rotation) ctx.rotate((-rotation * Math.PI) / 180);
    const top = va === "top" ? 0 : va === "bottom" ? -blk.height : va === "center" ? -blk.height / 2 : -blk.ys[0];
    const left = ha === "left" ? 0 : ha === "right" ? -blk.width : -blk.width / 2;
    ctx.globalAlpha = alpha;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    blk.lines.forEach((l, i) => {
      if (!l.line) return;
      const lx = ha === "left" ? left : ha === "right" ? -l.w : -l.w / 2;
      const ly = top + blk.ys[i];
      if (stroke) {
        ctx.lineJoin = "round";
        ctx.lineWidth = (stroke.lw * dpi) / 72;
        ctx.strokeStyle = stroke.colour;
        ctx.strokeText(l.line, lx, ly);
      }
      ctx.fillStyle = colour;
      ctx.fillText(l.line, lx, ly);
    });
    ctx.restore();
  }

  // ---- label placement (label_places / leader) --------------------------------------------
  function labelPlaces(ells, order, sizes, frame, depth, nx, ny, XLIM, YLIM, nAng = 72) {
    const [fx0, fx1, fy0, fy1] = frame;
    let dmax = 1;
    for (let i = 0; i < depth.length; i++) if (depth[i] > dmax) dmax = depth[i];
    const [gx0, gx1] = XLIM, [gy0, gy1] = YLIM;
    const round = (v) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r; };  // numpy rounds halves to even
    const col = (v) => Math.min(nx - 1, Math.max(0, round(((v - gx0) / (gx1 - gx0)) * (nx - 1))));
    const row = (v) => Math.min(ny - 1, Math.max(0, round(((v - gy0) / (gy1 - gy0)) * (ny - 1))));
    function clear(cx, cy, hw, hh) {
      const r0 = row(cy - hh), r1 = row(cy + hh), c0 = col(cx - hw), c1 = col(cx + hw);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (depth[r * nx + c] >= 1) return false;
      return true;
    }
    function ink(cx, cy, hw, hh) {
      const r0 = row(cy - hh), r1 = row(cy + hh), c0 = col(cx - hw), c1 = col(cx + hw);
      let s = 0, n = 0;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { s += depth[r * nx + c]; n++; }
      return s / n / dmax;
    }
    const outside = (cx, cy, hw, hh) =>
      Math.max(0, fx0 + hw - cx, cx - (fx1 - hw)) / (2 * hw) + Math.max(0, fy0 + hh - cy, cy - (fy1 - hh)) / (2 * hh);
    function lap(cx, cy, hw, hh, placed) {
      let tot = 0;
      for (const [qx, qy, qhw, qhh] of placed) {
        const w = Math.min(cx + hw, qx + qhw) - Math.max(cx - hw, qx - qhw);
        const h = Math.min(cy + hh, qy + qhh) - Math.max(cy - hh, qy - qhh);
        if (w > 0 && h > 0) tot += w * h;
      }
      return tot / (4 * hw * hh);
    }
    const placed = [], out = {};
    for (const p of order) {
      const e = ells[p], [mx, my] = e.mean, [w, h] = sizes[p], hw = w / 2, hh = h / 2;
      const gap = LABEL_CLEAR * h;
      const [bx, by] = boundary(e, nAng);
      const ux = new Float64Array(nAng), uy = new Float64Array(nAng);
      for (let i = 0; i < nAng; i++) {
        const dx = bx[i] - mx, dy = by[i] - my, nrm = Math.hypot(dx, dy);
        ux[i] = dx / nrm; uy[i] = dy / nrm;
      }
      const reach = Math.hypot(...e.scale);
      let best = null, cheapest = Infinity, stuck = [mx, my], worst = Infinity;
      for (const step of LADDER) {
        for (let i = 0; i < nAng; i++) {
          const off = gap + step * h + Math.abs(ux[i]) * hw + Math.abs(uy[i]) * hh;
          const cx = bx[i] + ux[i] * off, cy = by[i] + uy[i] * off;
          const c = W_LAP * lap(cx, cy, hw, hh, placed) + W_OUT * outside(cx, cy, hw, hh) + (W_TET * Math.hypot(cx - mx, cy - my)) / reach;
          if (clear(cx, cy, hw + gap, hh + gap)) {
            if (c < cheapest) { best = [cx, cy]; cheapest = c; }
          } else {
            const cc = c + W_INK * ink(cx, cy, hw, hh);
            if (cc < worst) { stuck = [cx, cy]; worst = cc; }
          }
        }
      }
      const [cx, cy] = best || stuck;
      let k = 0, kd = Infinity;
      for (let i = 0; i < nAng; i++) { const d = Math.hypot(bx[i] - cx, by[i] - cy); if (d < kd) { kd = d; k = i; } }
      out[p] = { spot: [cx, cy], anchor: [bx[k], by[k]] };
      placed.push([cx, cy, hw, hh]);
    }
    return out;
  }
  function leaderLine(spot, anchor, size) {
    const [cx, cy] = spot, [tx, ty] = anchor;
    const hw = size[0] / 2 + LEADER_GAP * size[1], hh = size[1] / 2 + LEADER_GAP * size[1];
    const dx = tx - cx, dy = ty - cy;
    const f = 1.0 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh, 1e-9);
    if (f >= 1.0) return null;
    const sx = cx + dx * f, sy = cy + dy * f;
    if (Math.hypot(tx - sx, ty - sy) < LEADER_MIN * size[1]) return null;
    return [sx, sy, tx, ty];
  }

  // ---- dates --------------------------------------------------------------------------------
  const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  function spanText(start, end) {
    if (!start && !end) return "";
    if (!start) return `Through ${md(end)}`;
    if (!end) return `From ${md(start)}`;
    return `${md(start)} to ${md(end)}`;
  }
  function spanTag(start, end) {
    const mmdd = (iso) => iso.slice(5, 7) + iso.slice(8, 10);
    if (!start && !end) return "";
    if (!start) return `_thru${mmdd(end)}`;
    if (!end) return `_from${mmdd(start)}`;
    return `_${mmdd(start)}to${mmdd(end)}`;
  }

  // ---- build --------------------------------------------------------------------------------
  //   pitches: [{ t: pitch type, x: HRA, y: VRA, d: "YYYY-MM-DD" }], already cut to the segment
  //   opts:    { pitcher, start, end, qualifier, nStd, minRows, minSegArea, limits }
  function build(pitches, opts = {}) {
    const { pitcher = "", start = null, end = null, qualifier = "", nStd = 1.0, minRows = 20,
      minSegArea = 0.10, limits = null } = opts;
    if (!pitches.length) throw new Error("no pitches");
    const years = new Map();
    for (const p of pitches) { const y = Number(p.d.slice(0, 4)); years.set(y, (years.get(y) || 0) + 1); }
    const year = [...years].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];

    const { ells, order, skipped, counts } = fitEllipses(pitches, nStd, minRows);
    if (!order.length) throw new Error("no pitch type had enough tracked pitches");
    const hues = Object.fromEntries(order.map((p) => [p, HUES[p] || HUES.UN]));
    const kept = order.reduce((s, p) => s + counts.get(p), 0);
    const pct = Object.fromEntries(order.map((p) => [p, (counts.get(p) / kept) * 100]));

    const [x0, x1, y0, y1] = limits || squareFrame(...clusterBox(ells));
    const { XLIM, YLIM, dw, dh } = windowFor(x0, x1, y0, y1);
    const ratio = dw / dh;

    // the depth maps, on the Python's grid
    const nx = GRID_N, ny = Math.max(2, Math.trunc(GRID_N / ratio));
    const gxs = linspace(XLIM[0], XLIM[1], nx), gys = linspace(YLIM[0], YLIM[1], ny);
    const cells = nx * ny;
    const depth = new Uint8Array(cells), share = new Float64Array(cells), seg = new Int32Array(cells);
    order.forEach((p, k) => {
      const e = ells[p], w = pct[p] / 100, bit = 1 << k;
      // only the ellipse's bounding box can be inside it
      const [bx0, bx1, by0, by1] = bounds(e);
      for (let r = 0; r < ny; r++) {
        const gy = gys[r];
        if (gy < by0 - 1e-9 || gy > by1 + 1e-9) continue;
        for (let c = 0; c < nx; c++) {
          const gx = gxs[c];
          if (gx < bx0 - 1e-9 || gx > bx1 + 1e-9) continue;
          if (contains(e, gx, gy)) { const i = r * nx + c; depth[i]++; share[i] += w; seg[i] |= bit; }
        }
      }
    });
    let DMAX = 0, SMAX = -Infinity, SMIN = Infinity;
    for (let i = 0; i < cells; i++) {
      if (depth[i] > DMAX) DMAX = depth[i];
      if (share[i] > SMAX) SMAX = share[i];
      if (depth[i] >= 1 && share[i] < SMIN) SMIN = share[i];
    }
    const cell = (dw / nx) * (dh / ny);

    // segments: each exact set of overlapping ellipses, shaded by pitches per square degree
    const segCells = new Map(), segHits = new Map();
    for (let i = 0; i < cells; i++) segCells.set(seg[i], (segCells.get(seg[i]) || 0) + 1);
    for (const p of pitches) {
      let code = 0;
      order.forEach((t, k) => { if (contains(ells[t], p.x, p.y)) code |= 1 << k; });
      segHits.set(code, (segHits.get(code) || 0) + 1);
    }
    const segInfo = new Map();
    for (const [code, n] of segCells) {
      const a = n * cell, hits = segHits.get(code) || 0;
      segInfo.set(code, { code, n: hits, area: a, dens: a > 0 ? hits / a : 0, solid: a >= minSegArea });
    }
    const inside = [...segInfo.values()].filter((s) => s.code !== 0);
    const scaled = inside.some((s) => s.solid) ? inside.filter((s) => s.solid) : inside;
    const KMIN = Math.min(...scaled.map((s) => s.dens)), KMAX = Math.max(...scaled.map((s) => s.dens));
    const segments = inside.slice().sort((a, b) => b.dens - a.dens);

    // the three shaded encodings as colour indices per cell
    const steps = DMAX > 1 ? Array.from({ length: DMAX }, (_, i) => cmap(i / (DMAX - 1))) : [cmap(1.0)];
    const normC = normalize(SMIN, SMAX), normD = normalize(KMIN, KMAX);
    const idxC = new Uint8Array(cells), idxD = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) {
      if (!depth[i]) continue;
      idxC[i] = lutIndex(normC(share[i]));
      idxD[i] = lutIndex(normD(segInfo.get(seg[i]).dens));
    }

    const model = {
      pitcher, year, start, end, qualifier, nStd, minRows, minSegArea,
      when: `${year} ${spanText(start, end)}`.trim(),
      span: [qualifier, spanText(start, end)].filter(Boolean).join(", "),
      tag: spanTag(start, end),
      pitches, total: pitches.length, games: new Set(pitches.map((p) => p.d)).size,
      ells, order, skipped, counts, hues, pct,
      frame: [x0, x1, y0, y1], XLIM, YLIM, dw, dh,
      nx, ny, depth, share, seg, cell, DMAX, SMAX, SMIN, KMIN, KMAX, segments, steps,
      idxC, idxD, normC, normD,
    };
    model.labels = placeLabels(model);
    return model;
  }

  // Names are measured, then placed, in data units -- which is what they are in the Python,
  // so the placement does not depend on the dpi the figure is drawn at.
  function placeLabels(m) {
    const ctx = mctx(), dpi = DPI_PNG;
    ctx.font = fontSpec(LABEL_PT, SEMIBOLD, dpi);
    const pxPerX = (AX_W * FIG_W * dpi) / m.dw, pxPerY = (AX_H * FIG_H * dpi) / m.dh;
    const sizes = {}, text = {};
    for (const p of m.order) {
      text[p] = `${NAMES[p] || p}  ${m.pct[p].toFixed(1)}%`;
      const blk = textBlock(ctx, text[p], (LABEL_PT * dpi) / 72);
      sizes[p] = [blk.width / pxPerX, blk.height / pxPerY];
    }
    const places = labelPlaces(m.ells, m.order, sizes, m.frame, m.depth, m.nx, m.ny, m.XLIM, m.YLIM);
    return Object.fromEntries(m.order.map((p) => [p, {
      text: text[p], size: sizes[p], ...places[p],
      leader: leaderLine(places[p].spot, places[p].anchor, sizes[p]),
    }]));
  }

  // ---- the loop's weights -------------------------------------------------------------------
  function weights(frame) {
    const s = Math.floor(frame / (HOLD + TRANS)), k = frame % (HOLD + TRANS), w = [0, 0, 0, 0];
    if (k < HOLD) w[s] = 1;
    else {
      const p = (k - HOLD + 1) / TRANS, u = p * p * (3 - 2 * p);
      w[s] = 1 - u; w[(s + 1) % STATES] = u;
    }
    return w;
  }
  function swapWeights(frame) {
    const s = Math.floor(frame / (HOLD + TRANS)), k = frame % (HOLD + TRANS), w = [0, 0, 0, 0];
    if (k < HOLD) w[s] = 1;
    else {
      const p = (k - HOLD + 1) / TRANS;
      w[s] = Math.max(0, 1 - 2 * p); w[(s + 1) % STATES] = Math.max(0, 2 * p - 1);
    }
    return w;
  }
  const still = (i) => { const w = [0, 0, 0, 0]; w[i] = 1; return w; };

  // ---- drawing -------------------------------------------------------------------------------
  let wordmark = null;
  async function loadAssets() {
    const fonts = document.fonts
      ? Promise.all([document.fonts.load(`400 40px ${FONT}`), document.fonts.load(`${SEMIBOLD} 40px ${FONT}`)]).catch(() => null)
      : Promise.resolve();
    if (!wordmark) {
      wordmark = fetch(WORDMARK_URL).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
        .then((b) => createImageBitmap(b)).catch(() => null);
    }
    await fonts;
    return wordmark;
  }

  // the shaded map for a blend of the three shaded states, as an nx x ny canvas
  let mapCanvas = null;
  function shadedMap(m, wb, wc, wd) {
    if (!mapCanvas) mapCanvas = document.createElement("canvas");
    if (mapCanvas.width !== m.nx || mapCanvas.height !== m.ny) { mapCanvas.width = m.nx; mapCanvas.height = m.ny; }
    const c = mapCanvas.getContext("2d");
    const img = c.createImageData(m.nx, m.ny), px = img.data;
    const shaded = wb + wc + wd;
    const a = Math.round(Math.min(1, shaded) * 255);
    const stepsFlat = m.steps, lut = LUT;
    for (let r = 0; r < m.ny; r++) {
      const out = (m.ny - 1 - r) * m.nx;   // origin="lower"
      for (let col = 0; col < m.nx; col++) {
        const i = r * m.nx + col, d = m.depth[i];
        if (!d) continue;
        const B = stepsFlat[d - 1], C = lut[m.idxC[i]], D = lut[m.idxD[i]], o = (out + col) * 4;
        px[o] = Math.round(((wb * B[0] + wc * C[0] + wd * D[0]) / shaded) * 255);
        px[o + 1] = Math.round(((wb * B[1] + wc * C[1] + wd * D[1]) / shaded) * 255);
        px[o + 2] = Math.round(((wb * B[2] + wc * C[2] + wd * D[2]) / shaded) * 255);
        px[o + 3] = a;
      }
    }
    c.putImageData(img, 0, 0);
    return mapCanvas;
  }

  let gradCanvas = null;
  function gradient() {
    if (!gradCanvas) {
      gradCanvas = document.createElement("canvas");
      gradCanvas.width = 256; gradCanvas.height = 1;
      const c = gradCanvas.getContext("2d"), img = c.createImageData(256, 1);
      for (let i = 0; i < 256; i++) { const col = LUT[lutIndex(i / 255)]; img.data.set([...col.map((v) => Math.round(v * 255)), 255], i * 4); }
      c.putImageData(img, 0, 0);
    }
    return gradCanvas;
  }

  // Paint the figure. mw: map weights over (outline, count, share, segment); tw: the same for
  // the titles and legends, which swap staggered rather than blended.
  function draw(canvas, m, dpi, mw, tw = mw, mark = null) {
    const W = Math.round(FIG_W * dpi), H = Math.round(FIG_H * dpi);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext("2d");
    const pt = (v) => (v * dpi) / 72;
    const [x0, x1, y0, y1] = m.frame, { XLIM, YLIM, dw, dh } = m;
    const X = (v) => (AX_L + ((v - XLIM[0]) / dw) * AX_W) * W;
    const Y = (v) => (1 - (B + ((v - YLIM[0]) / dh) * AX_H)) * H;
    const fx = (f) => f * W, fy = (f) => (1 - f) * H;
    const T = (s, x, y, o) => drawText(ctx, s, x, y, { dpi, ...o });
    const [wa, wb, wc, wd] = mw, shaded = wb + wc + wd;

    ctx.save();
    ctx.fillStyle = SURFACE;
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = "butt";

    // degree grid under everything
    const xt = niceTicks(x0, x1), yt = niceTicks(y0, y1);
    ctx.strokeStyle = GRIDC; ctx.lineWidth = pt(0.8);
    ctx.beginPath();
    for (const v of xt) { ctx.moveTo(X(v), Y(y0)); ctx.lineTo(X(v), Y(y1)); }
    for (const v of yt) { ctx.moveTo(X(x0), Y(v)); ctx.lineTo(X(x1), Y(v)); }
    ctx.stroke();

    // the shaded map
    if (shaded > 0) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(shadedMap(m, wb, wc, wd), X(XLIM[0]), Y(YLIM[1]), X(XLIM[1]) - X(XLIM[0]), Y(YLIM[0]) - Y(YLIM[1]));
      ctx.imageSmoothingEnabled = true;
    }

    // legends, centred under the frame
    const KH = 0.035 * dh, KW = 0.25 * dw, KX = (x0 + x1) / 2 - KW / 2, KY = YLIM[0] + 0.07 * dh;
    const keyTitle = (s, a) => T(s, X(KX + KW / 2), Y(KY + KH + 0.018 * dh), { pt: 16, weight: SEMIBOLD, colour: INK, ha: "center", va: "bottom", alpha: a });
    const keyBox = (a) => { ctx.globalAlpha = a; ctx.strokeStyle = RULE; ctx.lineWidth = pt(0.7); ctx.strokeRect(X(KX), Y(KY + KH), X(KX + KW) - X(KX), Y(KY) - Y(KY + KH)); ctx.globalAlpha = 1; };
    const keyTick = (s, x, a) => T(s, X(x), Y(KY - 0.013 * dh), { pt: 14, colour: INK2, ha: "center", va: "top", alpha: a });
    if (tw[1] > 0) {
      const a = tw[1];
      keyTitle("Pitch types overlapping", a);
      const gap = 0.002 * dw, sw = (KW - gap * (m.DMAX - 1)) / m.DMAX;
      m.steps.forEach((c, i) => {
        const px0 = KX + i * (sw + gap);
        ctx.fillStyle = css(c, a);
        ctx.fillRect(X(px0), Y(KY + KH), X(px0 + sw) - X(px0), Y(KY) - Y(KY + KH));
        keyTick(String(i + 1), px0 + sw / 2, a);
      });
      keyBox(a);
    }
    const ramp = (a, title, lo, hi, fmt) => {
      keyTitle(title, a);
      ctx.globalAlpha = a;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(gradient(), X(KX), Y(KY + KH), X(KX + KW) - X(KX), Y(KY) - Y(KY + KH));
      ctx.globalAlpha = 1;
      keyBox(a);
      for (const f of [0, 0.25, 0.5, 0.75, 1]) keyTick(fmt(lo + f * (hi - lo)), KX + f * KW, a);
    };
    if (tw[2] > 0) ramp(tw[2], "Share of his pitches covering the spot", m.SMIN, m.SMAX, (v) => `${(v * 100).toFixed(0)}%`);
    if (tw[3] > 0) ramp(tw[3], "Pitches per square degree", m.KMIN, m.KMAX, (v) => v.toFixed(0));

    // ellipses: a surface-coloured halo under each outline, faded in with the shading
    const outline = (e) => {
      const [bx, by] = boundary(e, 361);
      ctx.beginPath();
      for (let i = 0; i < bx.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(bx[i]), Y(by[i]));
      ctx.closePath();
    };
    if (shaded > 0) {
      ctx.globalAlpha = Math.min(1, shaded);
      ctx.strokeStyle = SURFACE; ctx.lineWidth = pt(3.0);
      for (const p of m.order) { outline(m.ells[p]); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = pt(2.0 * wa + 1.4 * shaded);
    for (const p of m.order) { ctx.strokeStyle = m.hues[p]; outline(m.ells[p]); ctx.stroke(); }

    // leaders, then names
    ctx.lineCap = "round";
    for (const p of m.order) {
      const l = m.labels[p].leader;
      if (!l) continue;
      ctx.beginPath(); ctx.moveTo(X(l[0]), Y(l[1])); ctx.lineTo(X(l[2]), Y(l[3]));
      ctx.strokeStyle = SURFACE; ctx.lineWidth = pt(3.2); ctx.stroke();
      ctx.strokeStyle = m.hues[p]; ctx.lineWidth = pt(1.3); ctx.stroke();
    }
    ctx.lineCap = "butt";
    for (const p of m.order) {
      const { text, spot } = m.labels[p];
      T(text, X(spot[0]), Y(spot[1]), { pt: LABEL_PT, weight: SEMIBOLD, colour: m.hues[p], ha: "center", va: "center", stroke: { lw: 4.0, colour: SURFACE } });
    }

    // the frame, over the names, and its ticks
    ctx.strokeStyle = RULE; ctx.lineWidth = pt(1.0);
    ctx.strokeRect(X(x0), Y(y1), X(x1) - X(x0), Y(y0) - Y(y1));
    const g = (v) => String(Number(v.toPrecision(6)));
    for (const v of xt) T(g(v), X(v), Y(y0 - 0.018 * dh), { pt: 14, colour: INK2, ha: "center", va: "top" });
    for (const v of yt) T(g(v), X(x0 - 0.008 * dw), Y(v), { pt: 14, colour: INK2, ha: "right", va: "center" });
    T("HRA (°)", X((x0 + x1) / 2), Y(y0 - 0.060 * dh), { pt: 14, colour: INK2, ha: "center", va: "top" });
    T("VRA (°)", X(x0 - 0.048 * dw), Y((y0 + y1) / 2), { pt: 14, colour: INK2, ha: "center", va: "center", rotation: 90 });

    // titles in the header band, the rule, the footer and the word mark
    TITLES.forEach(([head, line2], i) => {
      if (tw[i] <= 0) return;
      const s = `${m.pitcher} ${m.year} ${head}\n` + [line2, m.span].filter(Boolean).join(", ");
      T(s, fx(L), fy((1.0 + RULE_Y) / 2), { pt: 24, weight: SEMIBOLD, colour: TITLE, va: "center", alpha: tw[i] });
    });
    ctx.strokeStyle = RULE; ctx.lineWidth = pt(0.8);
    ctx.beginPath(); ctx.moveTo(fx(L), fy(RULE_Y)); ctx.lineTo(fx(L + W_FRAC), fy(RULE_Y)); ctx.stroke();
    T("Angles as the ball leaves the hand\nData: MLB StatsAPI", fx(L), fy(FOOT_Y), { pt: 12, colour: INK3, va: "bottom", linespacing: 1.6 });
    if (mark) {
      const h = (WATERMARK_W * FIG_W) / FIG_H / (mark.width / mark.height);
      ctx.drawImage(mark, fx(L + W_FRAC - WATERMARK_W), fy(FOOT_Y + h), WATERMARK_W * W, h * H);
    }
    ctx.restore();
  }

  // ---- the GIF --------------------------------------------------------------------------------
  // The Python writes all 344 frames; the 72 identical frames of each hold are one frame here
  // with the hold's whole duration, which plays the same and encodes in a fraction of the time.
  async function gif(m, mark, onProgress = () => {}) {
    const { GIFEncoder, quantize, applyPalette } = await import("https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm");
    const canvas = document.createElement("canvas");
    const enc = GIFEncoder();
    const frames = [];
    for (let s = 0; s < STATES; s++) {
      const base = s * (HOLD + TRANS);
      // the transition's last frame is the next state at rest, so it joins that hold
      frames.push({ f: base, delay: (HOLD + (s === 0 ? 0 : 1)) * (1000 / FPS) });
      for (let k = HOLD; k < HOLD + TRANS - 1; k++) frames.push({ f: base + k, delay: 1000 / FPS });
    }
    frames.push({ f: 0, delay: 1000 / FPS });   // ...and the loop's last frame is the first state
    for (let i = 0; i < frames.length; i++) {
      draw(canvas, m, DPI_GIF, weights(frames[i].f), swapWeights(frames[i].f), mark);
      const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const palette = quantize(data, 256, { format: "rgb565" });
      const index = applyPalette(data, palette, "rgb565");
      enc.writeFrame(index, width, height, { palette, delay: frames[i].delay, repeat: 0 });
      onProgress((i + 1) / frames.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    enc.finish();
    return new Blob([enc.bytes()], { type: "image/gif" });
  }

  // ---- report() ------------------------------------------------------------------------------
  function report(m) {
    const { order, depth, share, nx, ny, ells, pct } = m;
    const rows = order.map((p, k) => {
      let n = 0, sd = 0, ss = 0;
      for (let i = 0; i < nx * ny; i++) if (m.seg[i] >> k & 1) { n++; sd += depth[i]; ss += share[i]; }
      return {
        type: p, pitch: NAMES[p] || p, n: m.counts.get(p), usage: pct[p], area: area(ells[p]),
        meanDepth: sd / n, meanShare: (ss / n) * 100, exclSelf: (ss / n - pct[p] / 100) * 100,
      };
    });
    let cov = 0, sdep = 0, peak = 0;
    for (let i = 0; i < nx * ny; i++) if (depth[i] >= 1) { cov++; sdep += depth[i]; }
    const weighted = rows.reduce((s, r) => s + (r.usage / 100) * r.meanDepth, 0);
    // the types covering (nearly) all of the peak's cells
    const inPeak = order.map(() => 0);
    for (let i = 0; i < nx * ny; i++) if (share[i] >= m.SMAX - 1e-9) { peak++; order.forEach((_, k) => { if (m.seg[i] >> k & 1) inPeak[k]++; }); }
    const peakTypes = order.filter((_, k) => inPeak[k] / peak > 0.99).map((p) => NAMES[p] || p);
    const segments = m.segments.map((s) => ({ ...s, members: order.filter((_, k) => s.code >> k & 1).map((p) => NAMES[p] || p) }));
    return {
      rows, weighted, unionDepth: sdep / cov, unionArea: cov * m.cell, DMAX: m.DMAX, SMAX: m.SMAX,
      peakTypes, segments, clipped: segments.filter((s) => !s.solid), skipped: m.skipped,
    };
  }

  const stem = (m) => `${m.pitcher.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}_${m.year}${m.tag}_angles`;

  return {
    build, draw, gif, report, loadAssets, weights, swapWeights, still, stem, squareFrame, clusterBox, fitEllipses,
    NAMES, HUES, TAGS, STATES, HOLD, TRANS, FPS, DPI_PNG, DPI_GIF,
  };
})();
