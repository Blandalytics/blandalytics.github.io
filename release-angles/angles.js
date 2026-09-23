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

  const SURFACE = "#262940", RULE = "#4a4d63";
  // the header's colours, as Swing Profiles': the player in teal, the sub-header (and the footer) muted
  const HEADER = "#00D4FF", SUBHEADER = "#8D96B3";
  const INK = "#ffffff", INK2 = INK;
  const RAMP_ENDS = ["#262940", "#ffffff"];

  const FRAME_PAD = [0.26, 0.20];
  const SIDE_PAD = 0.07, TOP_PAD = 0.04, BOT_PAD = 0.24;
  const GRIDC = "#3a3d55";

  const FIG_W = 11.6, FIG_ASPECT = 1.0;
  const L = 0.035, B = 0.052, W_FRAC = 0.93, TOP = 0.875;
  // The bottom row: the footer note, the scale and the word mark, each centred on this line
  // (a fraction of the figure's height) -- the Python sits the note and mark on FOOT_Y and
  // the scale up under the frame.
  const ROW_Y = 0.07;
  const FIG_H = FIG_W / FIG_ASPECT;
  const AX_H = TOP - B;
  const AX_W = AX_H * FIG_H / FIG_W;
  const AX_L = (1 - AX_W) / 2;
  const AXES_RATIO = AX_W * FIG_W / (AX_H * FIG_H);
  const LABEL_PT = 18;
  const LEADER_GAP = 0.28, LEADER_MIN = 0.30;
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

  // ---- label placement -----------------------------------------------------------------------
  // Each name is a box of text in data units. Candidate spots ring every ellipse at a ladder of
  // distances, and a candidate must clear every ellipse's fill. Names are then placed greedily,
  // in many orders, under hard rules -- no name overlaps another, and no leader crosses a name
  // or another leader -- and the arrangement kept is the one whose frame (the square round the
  // ellipses and the names, plus a margin) is smallest, so the chart sits as tight on the
  // ellipses as the names allow; nearness to its own ellipse, and a leader that doesn't run
  // over other ellipses, break ties. Text is sized in points while the frame sets the scale, so
  // frame -> name sizes -> placement is iterated until the frame settles.
  const LABEL_GAP = 0.45;     // name to any ellipse, in name heights
  const LABEL_SEP = 0.30;     // name to name
  const LEADER_PAD = 0.12;    // leader to another name
  const FRAME_MARGIN = 0.60;  // outermost name or ellipse to the frame
  const STEPS = [0, 0.35, 0.8, 1.4, 2.2, 3.2, 4.5, 6.2, 8.4, 11.2];
  const N_ANG = 72, N_RING = 180, N_ORDERS = 120, N_COARSE = 20;
  const W_GROW = 1.0, W_DIST = 0.22, W_CROSS = 0.35, W_VIOL = 50;

  const overlaps = (a, b, pad) => a[0] - pad < b[1] && b[0] - pad < a[1] && a[2] - pad < b[3] && b[2] - pad < a[3];
  // Liang-Barsky: does segment s pass through box b grown by pad?
  function segHitsBox(s, b, pad) {
    if (!s) return false;
    const [x0, y0, x1, y1] = s, dx = x1 - x0, dy = y1 - y0;
    const P = [-dx, dx, -dy, dy], Q = [x0 - (b[0] - pad), b[1] + pad - x0, y0 - (b[2] - pad), b[3] + pad - y0];
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 4; i++) {
      if (P[i] === 0) { if (Q[i] < 0) return false; continue; }
      const r = Q[i] / P[i];
      if (P[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 <= t1;
  }
  function segsCross(a, b) {
    if (!a || !b) return false;
    const o = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    return o(a[0], a[1], a[2], a[3], b[0], b[1]) !== o(a[0], a[1], a[2], a[3], b[2], b[3])
      && o(b[0], b[1], b[2], b[3], a[0], a[1]) !== o(b[0], b[1], b[2], b[3], a[2], a[3]);
  }
  // contains() as a quadratic form: Q = A u^2 + B u v + C v^2 <= 1, u = (x - mx) / sx, v = (y - my) / sy
  function quad(e) {
    if (!e.q) {
      const irx = 1 / e.radii[0] ** 2, iry = 1 / e.radii[1] ** 2;
      e.q = [CA * CA * irx + SA * SA * iry, 2 * CA * SA * (iry - irx), SA * SA * irx + CA * CA * iry];
    }
    return e.q;
  }
  // An ellipse and a box meet if Q's minimum over the box is <= 1. Q is convex: the minimum is 0
  // with the centre inside, else on an edge, where Q is a 1-D quadratic minimised by clamping.
  function boxHitsEllipse(e, b) {
    const [ex0, ex1, ey0, ey1] = bounds(e);
    if (b[1] < ex0 || b[0] > ex1 || b[3] < ey0 || b[2] > ey1) return false;
    const [A, B, C] = quad(e), [mx, my] = e.mean, [sx, sy] = e.scale;
    const u0 = (b[0] - mx) / sx, u1 = (b[1] - mx) / sx, v0 = (b[2] - my) / sy, v1 = (b[3] - my) / sy;
    if (u0 <= 0 && u1 >= 0 && v0 <= 0 && v1 >= 0) return true;
    const clamp = (t, lo, hi) => (t < lo ? lo : t > hi ? hi : t);
    for (const u of [u0, u1]) { const v = clamp((-B * u) / (2 * C), v0, v1); if (A * u * u + B * u * v + C * v * v <= 1) return true; }
    for (const v of [v0, v1]) { const u = clamp((-B * v) / (2 * A), u0, u1); if (A * u * u + B * u * v + C * v * v <= 1) return true; }
    return false;
  }
  function segHitsEllipse(s, e) {
    for (let k = 1; k < 12; k++) { const t = k / 12; if (contains(e, s[0] + t * (s[2] - s[0]), s[1] + t * (s[3] - s[1]))) return true; }
    return false;
  }
  function mulberry32(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const squareSide = (b) => Math.max(b[1] - b[0], b[3] - b[2]);
  const grown = (b, c) => [Math.min(b[0], c[0]), Math.max(b[1], c[1]), Math.min(b[2], c[2]), Math.max(b[3], c[3])];

  // every spot a name may take: stepped out from its ellipse, clear of all the fills
  function candidates(p, ells, rings, order, w, h, strict = true) {
    const e = ells[p], [mx, my] = e.mean, hw = w / 2, hh = h / 2, gap = LABEL_GAP * h;
    const [bx, by] = boundary(e, N_ANG), [rx, ry] = rings[p], out = [];
    const others = order.map((q) => ells[q]);
    // the outward direction at each outline point, and the box's reach along it
    const ux = new Float64Array(N_ANG), uy = new Float64Array(N_ANG), reach = new Float64Array(N_ANG);
    for (let i = 0; i < N_ANG; i++) {
      const dx = bx[i] - mx, dy = by[i] - my, n = Math.sqrt(dx * dx + dy * dy);
      ux[i] = dx / n; uy[i] = dy / n; reach[i] = gap + Math.abs(ux[i]) * hw + Math.abs(uy[i]) * hh;
    }
    for (const step of STEPS) {
      for (let i = 0; i < N_ANG; i++) {
        const off = reach[i] + step * h, cx = bx[i] + ux[i] * off, cy = by[i] + uy[i] * off;
        const box = [cx - hw, cx + hw, cy - hh, cy + hh];
        if (strict) {
          const padded = [box[0] - gap, box[1] + gap, box[2] - gap, box[3] + gap];
          let hit = false;
          for (let q = 0; q < others.length && !hit; q++) hit = boxHitsEllipse(others[q], padded);
          if (hit) continue;
        }
        let k = 0, kd = Infinity;
        for (let j = 0; j < rx.length; j++) { const dx2 = rx[j] - cx, dy2 = ry[j] - cy, d = dx2 * dx2 + dy2 * dy2; if (d < kd) { kd = d; k = j; } }
        kd = Math.sqrt(kd);
        const anchor = [rx[k], ry[k]], leader = leaderLine([cx, cy], anchor, [w, h]);
        let cross = 0;
        if (leader) for (const q of order) if (q !== p && segHitsEllipse(leader, ells[q])) cross++;
        out.push({ spot: [cx, cy], anchor, box, leader, dist: kd / h, cross });
      }
    }
    return out.length || !strict ? out : candidates(p, ells, rings, order, w, h, false);
  }

  // A label's candidates sorted by the part of their cost that doesn't depend on what is
  // already placed (distance and ellipse crossings): frame growth and violations only add to
  // it, so a pass can stop at the first candidate whose floor is above the best cost so far.
  // Ties keep the original candidate order, so the pick is the same as a full scan's.
  function ranked(cands) {
    const out = cands.map((c, i) => ({ c, i, lb: W_DIST * c.dist + W_CROSS * c.cross }));
    out.sort((a, b) => a.lb - b.lb || a.i - b.i);
    return out;
  }

  // one greedy pass in a given order; returns the placement and its score
  function arrange(seq, ranks, cluster, h) {
    let b0 = cluster[0], b1 = cluster[1], b2 = cluster[2], b3 = cluster[3], score = 0;
    const placed = [], sep = LABEL_SEP * h, pad = LEADER_PAD * h;
    for (const p of seq) {
      const side = Math.max(b1 - b0, b3 - b2);
      let best = null, bestCost = Infinity, bestIdx = Infinity, bestViol = 0;
      for (const { c, i, lb } of ranks[p]) {
        if (lb > bestCost) break;
        const bx = c.box;
        const grow = (W_GROW * (Math.max(Math.max(b1, bx[1]) - Math.min(b0, bx[0]), Math.max(b3, bx[3]) - Math.min(b2, bx[2])) - side)) / h;
        let cost = lb + grow;
        if (cost > bestCost || (cost === bestCost && i > bestIdx)) continue;
        let viol = 0;
        for (let k = 0; k < placed.length; k++) {
          const q = placed[k];
          if (overlaps(bx, q.box, sep)) viol += 3;
          if (segHitsBox(c.leader, q.box, pad)) viol++;
          if (segHitsBox(q.leader, bx, pad)) viol++;
          if (segsCross(c.leader, q.leader)) viol++;
        }
        cost += W_VIOL * viol;
        if (cost < bestCost || (cost === bestCost && i < bestIdx)) { best = c; bestCost = cost; bestIdx = i; bestViol = viol; }
      }
      placed.push(best);
      b0 = Math.min(b0, best.box[0]); b1 = Math.max(b1, best.box[1]);
      b2 = Math.min(b2, best.box[2]); b3 = Math.max(b3, best.box[3]);
      score += W_DIST * best.dist + W_CROSS * best.cross + W_VIOL * bestViol;
    }
    const bbox = [b0, b1, b2, b3];
    return { placed: seq.map((p, k) => ({ p, ...placed[k] })), bbox, score: score + (W_GROW * squareSide(bbox)) / h };
  }

  // The names measured and placed, and the frame they fit in: { labels, frame }
  function layoutLabels(ells, order, pct) {
    const ctx = mctx(), dpi = DPI_PNG;
    ctx.font = fontSpec(LABEL_PT, SEMIBOLD, dpi);
    const text = {}, px = {};
    for (const p of order) {
      text[p] = `${NAMES[p] || p}  ${pct[p].toFixed(1)}%`;
      const blk = textBlock(ctx, text[p], (LABEL_PT * dpi) / 72);
      px[p] = [blk.width, blk.height];
    }
    // data units per pixel for a square frame of side S: the window, and so the scale, follows it
    const unit = (S) => windowFor(0, S, 0, S).dw / (AX_W * FIG_W * dpi);
    const rings = Object.fromEntries(order.map((p) => [p, boundary(ells[p], N_RING)]));
    const cluster = clusterBox(ells);
    const rand = mulberry32(20260922);
    const orders = [order.slice()];
    for (let i = 1; i < N_ORDERS; i++) {
      const o = order.slice();
      for (let j = o.length - 1; j > 0; j--) { const k = Math.floor(rand() * (j + 1)); [o[j], o[k]] = [o[k], o[j]]; }
      orders.push(o);
    }
    // the frame settles with a coarse search (the first N_COARSE orders); the full search then
    // runs at that size, and the loop only goes on if it moves the frame
    let S = squareSide(squareFrame(...cluster)), best = null, sizes = null, h = 0, full = false;
    for (let it = 0; it < 12; it++) {
      const u = unit(S);
      sizes = Object.fromEntries(order.map((p) => [p, [px[p][0] * u, px[p][1] * u]]));
      h = Math.max(...order.map((p) => sizes[p][1]));
      const ranks = Object.fromEntries(order.map((p) => [p, ranked(candidates(p, ells, rings, order, ...sizes[p]))]));
      const search = (list) => {
        let top = null;
        for (const seq of list) { const r = arrange(seq, ranks, cluster, h); if (!top || r.score < top.score) top = r; }
        return top;
      };
      best = search(full ? orders : orders.slice(0, N_COARSE));
      let next = squareSide(best.bbox) + 2 * FRAME_MARGIN * h;
      if (!full && (Math.abs(next - S) <= 0.004 * S || it >= 8)) {
        full = true;
        best = search(orders);
        next = squareSide(best.bbox) + 2 * FRAME_MARGIN * h;
      }
      if (full && Math.abs(next - S) <= 0.004 * S) { S = Math.max(S, next); break; }
      S = it < 3 ? next : (S + next) / 2;
    }
    const b = best.bbox, cx = (b[0] + b[1]) / 2, cy = (b[2] + b[3]) / 2;
    const side = Math.max(S, squareSide(b) + 2 * FRAME_MARGIN * h);
    const labels = {};
    for (const q of best.placed) labels[q.p] = { text: text[q.p], size: sizes[q.p], spot: q.spot, anchor: q.anchor, leader: q.leader };
    return { labels, frame: [cx - side / 2, cx + side / 2, cy - side / 2, cy + side / 2] };
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
  //   opts:    { pitcher, start, end, nStd, minRows, minSegArea }
  function build(pitches, opts = {}) {
    const { pitcher = "", start = null, end = null, nStd = 1.0, minRows = 20,
      minSegArea = 0.10 } = opts;
    if (!pitches.length) throw new Error("no pitches");
    const years = new Map();
    for (const p of pitches) { const y = Number(p.d.slice(0, 4)); years.set(y, (years.get(y) || 0) + 1); }
    const year = [...years].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];

    const { ells, order, skipped, counts } = fitEllipses(pitches, nStd, minRows);
    if (!order.length) throw new Error("no pitch type had enough tracked pitches");
    const hues = Object.fromEntries(order.map((p) => [p, HUES[p] || HUES.UN]));
    const kept = order.reduce((s, p) => s + counts.get(p), 0);
    const pct = Object.fromEntries(order.map((p) => [p, (counts.get(p) / kept) * 100]));

    // the names are placed first: the frame is the square they and the ellipses fit in
    const { labels, frame } = layoutLabels(ells, order, pct);
    const [x0, x1, y0, y1] = frame;
    const { XLIM, YLIM, dw, dh } = windowFor(x0, x1, y0, y1);
    const ratio = dw / dh;

    // the depth maps, on the Python's grid
    const nx = GRID_N, ny = Math.max(2, Math.trunc(GRID_N / ratio));
    const gxs = linspace(XLIM[0], XLIM[1], nx), gys = linspace(YLIM[0], YLIM[1], ny);
    const cells = nx * ny;
    const depth = new Uint8Array(cells), share = new Float64Array(cells), seg = new Int32Array(cells);
    const xstep = (XLIM[1] - XLIM[0]) / (nx - 1);
    order.forEach((p, k) => {
      const e = ells[p], w = pct[p] / 100, bit = 1 << k;
      const [mx, my] = e.mean, [sx, sy] = e.scale, irx = 1 / e.radii[0] ** 2, iry = 1 / e.radii[1] ** 2;
      // contains() as a quadratic in u = (x - mx) / sx for a row's v: A u^2 + B u + C <= 1
      const A = CA * CA * irx + SA * SA * iry, Bv = 2 * CA * SA * (iry - irx), Cv = SA * SA * irx + CA * CA * iry;
      const mark = (r, c) => { const i = r * nx + c; depth[i]++; share[i] += w; seg[i] |= bit; };
      for (let r = 0; r < ny; r++) {
        const gy = gys[r], v = (gy - my) / sy, B = Bv * v, disc = B * B - 4 * A * (Cv * v * v - 1);
        if (disc < 0) continue;
        const rt = Math.sqrt(disc), xlo = mx + sx * ((-B - rt) / (2 * A)), xhi = mx + sx * ((-B + rt) / (2 * A));
        // a cell or two either side of the solved span is tested exactly; the rest is inside
        const c0 = Math.max(0, Math.ceil((xlo - XLIM[0]) / xstep) - 2), c1 = Math.min(nx - 1, Math.floor((xhi - XLIM[0]) / xstep) + 2);
        for (let c = c0; c <= c1; c++) {
          if (c >= c0 + 4 && c <= c1 - 4) mark(r, c);
          else if (contains(e, gxs[c], gy)) mark(r, c);
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
    const codes = 1 << order.length, segCells = new Int32Array(codes), segHits = new Int32Array(codes);
    for (let i = 0; i < cells; i++) segCells[seg[i]]++;
    const ellList = order.map((t) => ells[t]);
    for (const p of pitches) {
      let code = 0;
      for (let k = 0; k < ellList.length; k++) if (contains(ellList[k], p.x, p.y)) code |= 1 << k;
      segHits[code]++;
    }
    const segDens = new Float64Array(codes), inside = [];
    for (let code = 1; code < codes; code++) {
      if (!segCells[code]) continue;
      const a = segCells[code] * cell, hits = segHits[code];
      segDens[code] = hits / a;
      inside.push({ code, n: hits, area: a, dens: segDens[code], solid: a >= minSegArea });
    }
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
      idxD[i] = lutIndex(normD(segDens[seg[i]]));
    }

    const model = {
      pitcher, year, start, end, nStd, minRows, minSegArea,
      when: `${year} ${spanText(start, end)}`.trim(),
      span: spanText(start, end),
      tag: spanTag(start, end),
      pitches, total: pitches.length, games: new Set(pitches.map((p) => p.d)).size,
      ells, order, skipped, counts, hues, pct,
      frame: [x0, x1, y0, y1], XLIM, YLIM, dw, dh,
      nx, ny, depth, share, seg, cell, DMAX, SMAX, SMIN, KMIN, KMAX, segments, steps,
      idxC, idxD, normC, normD, labels,
    };
    return model;
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
    // the scale's title, bar and tick labels as one block, centred on the bottom row
    const ptF = (p) => (p / 72) * (ASC + DESC) / FIG_H;   // a line of p-point text, in figure heights
    const above = 0.018 * AX_H + ptF(16), below = 0.013 * AX_H + ptF(14);
    const barBottom = ROW_Y - (0.035 * AX_H + above + below) / 2 + below;
    const KH = 0.035 * dh, KW = 0.25 * dw, KX = (x0 + x1) / 2 - KW / 2, KY = YLIM[0] + ((barBottom - B) / AX_H) * dh;
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

    // the ticks (no spines: the degree grid is the only frame)
    const g = (v) => String(Number(v.toPrecision(6)));
    for (const v of xt) T(g(v), X(v), Y(y0 - 0.018 * dh), { pt: 14, colour: INK2, ha: "center", va: "top" });
    for (const v of yt) T(g(v), X(x0 - 0.008 * dw), Y(v), { pt: 14, colour: INK2, ha: "right", va: "center" });
    T("HRA (°)", X((x0 + x1) / 2), Y(y0 - 0.060 * dh), { pt: 14, colour: INK2, ha: "center", va: "top" });
    T("VRA (°)", X(x0 - 0.048 * dw), Y((y0 + y1) / 2), { pt: 14, colour: INK2, ha: "center", va: "center", rotation: 90 });

    // The header, as Swing Profiles' figure has it: the pitcher in large teal type, what the
    // chart shows in a muted line under it, and the word mark top right. Its sizes and offsets
    // are that figure's (8 in wide) scaled to this one's width, so the two read the same at the
    // same size on screen; a line too long to clear the word mark is set smaller.
    const HS = FIG_W / 8, inch = (v) => v * HS * dpi;
    const room = fx(L + W_FRAC - (mark ? WATERMARK_W : 0)) - fx(L) - (mark ? inch(0.2) : 0);
    const fit = (s, size, weight) => {
      ctx.font = fontSpec(size, weight, dpi);
      const w = ctx.measureText(s).width;
      return w > room ? (size * room) / w : size;
    };
    T(m.pitcher, fx(L), inch(0.25), { pt: fit(m.pitcher, 22 * HS, 700), weight: 700, colour: HEADER, va: "top" });
    TITLES.forEach(([head, line2], i) => {
      if (tw[i] <= 0) return;
      const s = [`${m.year} ${head}`, line2, m.span].filter(Boolean).join(", by ");
      T(s, fx(L), inch(0.625), { pt: fit(s, 14 * HS, 400), colour: SUBHEADER, va: "top", alpha: tw[i] });
    });
    if (mark) {
      const w = WATERMARK_W * W, h = w * (mark.height / mark.width);
      ctx.drawImage(mark, fx(L + W_FRAC) - w, inch(0.3), w, h);
    }
    T("Angles as the ball leaves the hand\nData: MLB StatsAPI", fx(L), fy(ROW_Y), { pt: 12, colour: SUBHEADER, va: "center", linespacing: 1.2 });
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
    const { order, depth, share, seg, nx, ny, ells, pct } = m, K = order.length, cells = nx * ny;
    // one pass over the grid; each sum still runs in cell order, so it matches a pass per type
    const n = new Float64Array(K), sd = new Float64Array(K), ss = new Float64Array(K), inPeak = new Float64Array(K);
    let cov = 0, sdep = 0, peak = 0;
    const top = m.SMAX - 1e-9;
    for (let i = 0; i < cells; i++) {
      const code = seg[i];
      if (!code) continue;
      cov++; sdep += depth[i];
      const atPeak = share[i] >= top;
      if (atPeak) peak++;
      for (let k = 0; k < K; k++) {
        if (!(code >> k & 1)) continue;
        n[k]++; sd[k] += depth[i]; ss[k] += share[i];
        if (atPeak) inPeak[k]++;
      }
    }
    const rows = order.map((p, k) => ({
      type: p, pitch: NAMES[p] || p, n: m.counts.get(p), usage: pct[p], area: area(ells[p]),
      meanDepth: sd[k] / n[k], meanShare: (ss[k] / n[k]) * 100, exclSelf: (ss[k] / n[k] - pct[p] / 100) * 100,
    }));
    const weighted = rows.reduce((s, r) => s + (r.usage / 100) * r.meanDepth, 0);
    // the types covering (nearly) all of the peak's cells
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
