// The Series Win maths and its two figures. A port of baseball_snippets
// mlb_series_win.py: PythagenPat xWin% for each team, log5 between them, home
// field worth 4%, and the series played out game by game. Where the script
// simulates 100,000 (or 250,000) series, this sums every path through the series
// exactly, so the numbers don't move between loads.
//
// The figures are the script's two matplotlib charts (6 x 4 in at 200 dpi, cut
// to their tight bounding box as st.pyplot does), laid out in the pixels of that
// figure and rasterised at any scale.

(() => {
  "use strict";

  const HFA = 0.04;
  const MAX_LEN = 15;
  const LENGTHS = Array.from({ length: (MAX_LEN + 1) / 2 }, (_, i) => 2 * i + 1);  // 1, 3, ... 15

  // ---- the model ---------------------------------------------------------------------

  // PythagenPat: the exponent follows the run environment
  function xWin(rsg, rag) {
    const f = (rsg + rag) ** 0.285;
    return rsg ** f / (rsg ** f + rag ** f);
  }

  // log5: the higher seed's chance to beat the lower seed at a neutral site
  function log5(h, l) {
    return (h - h * l) / (h + l - 2 * h * l);
  }

  // Which games the higher seed hosts (1) or visits (0): the script's schedule.
  // 3 games is 1-1-1; 5 and up open 2-2 and alternate from game 5 (2-2-1, 2-2-1-1-1, ...).
  function schedule(games, allHome = false) {
    if (allHome) return Array(games).fill(1);
    if (games === 3) return [1, 0, 1];
    const s = [1, 1, 0, 0];
    for (let i = 0; i < Math.round((games - 5) / 2); i++) s.push(1, 0);
    s.push(1);
    return s.slice(0, games);
  }

  // Every way a best-of-`games` series can go. Returns { win, higher[g], lower[g] }:
  // the higher seed's chance to take the series, and the chance each side wins it
  // in exactly g games.
  function series(p, games, { hfa = HFA, allHome = false } = {}) {
    const need = (games + 1) / 2;
    const sched = schedule(games, allHome);
    const higher = new Float64Array(games + 1), lower = new Float64Array(games + 1);
    // prob[h * need + l]: the series stands at h-l and is still going
    let prob = new Float64Array(need * need);
    prob[0] = 1;
    for (let g = 0; g < sched.length; g++) {
      const q = Math.min(1, Math.max(0, p + hfa * (sched[g] ? 1 : -1)));
      const next = new Float64Array(need * need);
      for (let h = 0; h < need; h++) {
        for (let l = 0; l < need; l++) {
          const m = prob[h * need + l];
          if (!m) continue;
          if (h + 1 === need) higher[g + 1] += m * q;
          else next[(h + 1) * need + l] += m * q;
          if (l + 1 === need) lower[g + 1] += m * (1 - q);
          else next[h * need + l + 1] += m * (1 - q);
        }
      }
      prob = next;
    }
    const win = higher.reduce((a, b) => a + b, 0);
    return { win, higher, lower, games, need };
  }

  // The first chart's line: series win% at each length
  function byLength(p, opts) {
    return LENGTHS.map((n) => [n, series(p, n, opts).win]);
  }

  // ---- drawing -----------------------------------------------------------------------

  // The script's style: seaborn "notebook" sizes, DM Sans bold throughout, the
  // Pitcher List palette.
  const DPI = 200;
  const PT = DPI / 72;                          // px per point
  const FIG = { w: 6 * DPI, h: 4 * DPI };       // 1200 x 800
  const AX = { left: 0.125 * FIG.w, right: 0.9 * FIG.w, top: (1 - 0.88) * FIG.h, bottom: (1 - 0.11) * FIG.h };
  const PAD = 0.1 * DPI;                        // bbox_inches="tight" pad
  const BACKGROUND = "#292C42";
  const WHITE = "#FFFFFF";
  const LINE = "#8D96B3";
  const FONT = '"DM Sans", "Segoe UI", "DejaVu Sans", sans-serif';
  const ASC = 0.992, DESC = 0.310;              // DM Sans' typo ascender / descender, in em
  const SIZE = { suptitle: 14.4, sub: 9, tick: 11, label: 12, legend: 11, box: 10 };
  const TICK_LEN = 6 * PT, TICK_W = 1.25 * PT, TICK_PAD = 3.5 * PT, LABEL_PAD = 4 * PT;

  const WORDMARK_URL = "../pitcher-cards/PitcherList_Stats_watermark_with_logo.webp";
  let wordmarkPromise = null;
  function loadWordmark() {
    if (!wordmarkPromise) {
      wordmarkPromise = fetch(WORDMARK_URL).then((r) => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((b) => createImageBitmap(b)).catch(() => null);
    }
    return wordmarkPromise;
  }
  async function ensureFonts() {
    if (!document.fonts) return;
    try { await document.fonts.load(`700 40px ${FONT}`); } catch { /* the fallback face draws instead */ }
  }

  const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

  // A text helper in matplotlib's terms: size in points, ha / va of the line box.
  function texter(ctx) {
    const font = (size) => { ctx.font = `700 ${size * PT}px ${FONT}`; };
    const width = (s, size) => { font(size); return ctx.measureText(s).width; };
    const box = (size) => ({ asc: ASC * size * PT, desc: DESC * size * PT, h: (ASC + DESC) * size * PT });
    function text(s, x, y, { size, colour = WHITE, ha = "center", va = "center" }) {
      font(size);
      const b = box(size);
      ctx.fillStyle = colour;
      ctx.textAlign = ha;
      ctx.textBaseline = "alphabetic";
      const base = va === "baseline" ? y : va === "top" ? y + b.asc : va === "bottom" ? y - b.desc : y + (b.asc - b.desc) / 2;
      ctx.fillText(s, x, base);
    }
    // text in a round box (boxstyle="round", pad=0.25, white 1 pt edge)
    function boxed(s, x, y, { size, face, va = "center" }) {
      const b = box(size), pad = 0.25 * size * PT;
      const w = width(s, size) + 2 * pad, h = b.h + 2 * pad;
      const cy = va === "bottom" ? y - b.h / 2 : y;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, cy - h / 2, w, h, pad);
      ctx.fillStyle = face;
      ctx.fill();
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = 1 * PT;
      ctx.stroke();
      text(s, x, cy, { size });
    }
    return { text, boxed, width, box };
  }

  // matplotlib's MaxNLocator (steps 1, 2, 2.5, 5, 10): the tick values inside [lo, hi]
  function niceTicks(lo, hi, nbins) {
    const raw = (hi - lo) / nbins;
    const scale = 10 ** Math.floor(Math.log10(raw));
    for (const s of [1, 2, 2.5, 5, 10, 20]) {
      const step = s * scale;
      if (step < raw - 1e-12) continue;
      const first = Math.ceil(lo / step - 1e-9) * step;
      const ticks = [];
      for (let v = first; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(10));
      if (ticks.length >= 2) return ticks;
    }
    return [lo, hi];
  }

  // Size the canvas to the figure's tight box and hand back a context in figure pixels.
  function setup(canvas, bounds, scale) {
    const x0 = bounds.left - PAD, y0 = bounds.top - PAD;
    const w = bounds.right + PAD - x0, h = bounds.bottom + PAD - y0;
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(x0, y0, w, h);
    return ctx;
  }

  // the wordmark in an axes box [x, y, w, h] (figure fractions), fitted and anchored at the bottom
  function wordmarkRect(wordmark, [fx, fy, fw, fh]) {
    const bw = fw * FIG.w, bh = fh * FIG.h;
    const ar = wordmark ? wordmark.width / wordmark.height : 928 / 178;
    const w = Math.min(bw, bh * ar), h = w / ar;
    const bottom = FIG.h * (1 - fy);
    return { x: fx * FIG.w + (bw - w) / 2, y: bottom - h, w, h };
  }

  function header(t, title, subtitle, subY) {
    t.text(title, FIG.w / 2, 0, { size: SIZE.suptitle, va: "top" });
    t.text(subtitle, FIG.w / 2, subY, { size: SIZE.sub, va: "baseline" });
  }

  function xTicks(ctx, t, ticks, px) {
    ctx.strokeStyle = LINE;
    ctx.lineWidth = TICK_W;
    ctx.beginPath();
    for (const v of ticks) { ctx.moveTo(px(v), AX.bottom); ctx.lineTo(px(v), AX.bottom + TICK_LEN); }
    ctx.stroke();
    for (const v of ticks) t.text(String(v), px(v), AX.bottom + TICK_LEN + TICK_PAD, { size: SIZE.tick, colour: LINE, va: "top" });
  }
  const xLabelY = (t) => AX.bottom + TICK_LEN + TICK_PAD + t.box(SIZE.tick).h + LABEL_PAD;

  // ---- the first chart: series win% by series length -----------------------------------
  //   line:  byLength()   opts: { higher, lower, p, allHome, code, wordmark }
  //   higher / lower: { name, color }
  function drawLength(canvas, line, opts, scale = 2) {
    const vals = line.map(([, v]) => v);
    const ylo = Math.min(0.3, Math.min(...vals) - 0.05), yhi = Math.max(0.7, Math.max(...vals) + 0.05);
    const px = (x) => AX.left + (x / (MAX_LEN + 1)) * (AX.right - AX.left);
    const py = (y) => AX.bottom - ((y - ylo) / (yhi - ylo)) * (AX.bottom - AX.top);
    // tick space as matplotlib's YAxis works it out: axis length over twice the label size
    const nbins = Math.min(9, Math.floor((AX.bottom - AX.top) / (2 * SIZE.tick * PT)));
    const yticks = niceTicks(ylo, yhi, nbins);
    const logo = wordmarkRect(opts.wordmark, [0.05, -0.04, 0.2, 0.1]);

    // the tight box: the tick labels at the left, the axes, the wordmark under it
    const probe = texter(canvas.getContext("2d"));
    const labelW = Math.max(...yticks.map((v) => probe.width(pct(v, 0), SIZE.tick)));
    const titleW = probe.width(`${opts.higher.name} over ${opts.lower.name} Series Win%`, SIZE.suptitle);
    const ctx = setup(canvas, {
      left: Math.min(AX.left - TICK_LEN - TICK_PAD - labelW, logo.x, FIG.w / 2 - titleW / 2),
      right: Math.max(AX.right, FIG.w / 2 + titleW / 2),
      top: 0,
      bottom: Math.max(logo.y + logo.h, xLabelY(probe) + probe.box(SIZE.label).h),
    }, scale);
    const t = texter(ctx);

    // the 50% line: dashed white at a quarter
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1.5 * PT;
    ctx.setLineDash([3.7 * 1.5 * PT, 1.6 * 1.5 * PT]);
    ctx.beginPath(); ctx.moveTo(AX.left, py(0.5)); ctx.lineTo(AX.right, py(0.5)); ctx.stroke();
    ctx.restore();

    // the line, white under the lower seed's colour
    ctx.lineJoin = "round";
    for (const [colour, lw] of [[WHITE, 5], [opts.lower.color, 3]]) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = lw * PT;
      ctx.beginPath();
      line.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
      ctx.stroke();
    }
    // each point's value boxed in the higher seed's colour
    for (const [x, y] of line) {
      t.boxed(Math.round(y * 1000) / 1000 < 1 ? pct(y) : "~100%", px(x), py(y), { size: SIZE.box, face: opts.higher.color });
    }

    // the y axis, trimmed to its ticks
    ctx.strokeStyle = LINE;
    ctx.lineWidth = TICK_W;
    ctx.beginPath();
    ctx.moveTo(AX.left, py(yticks[0])); ctx.lineTo(AX.left, py(yticks[yticks.length - 1]));
    for (const v of yticks) { ctx.moveTo(AX.left, py(v)); ctx.lineTo(AX.left - TICK_LEN, py(v)); }
    ctx.stroke();
    for (const v of yticks) t.text(pct(v, 0), AX.left - TICK_LEN - TICK_PAD, py(v), { size: SIZE.tick, colour: LINE, ha: "right" });
    xTicks(ctx, t, LENGTHS, px);
    t.text('Series Length ("Best of X")', (AX.left + AX.right) / 2, xLabelY(t), { size: SIZE.label, va: "top" });

    const home = opts.allHome ? `, all @${opts.code}` : "";
    header(t, `${opts.higher.name} over ${opts.lower.name} Series Win%`,
      `(Single Game, Neutral Site xWin%: ${pct(opts.p)}${home})`, 0.1 * FIG.h);
    if (opts.wordmark) ctx.drawImage(opts.wordmark, logo.x, logo.y, logo.w, logo.h);
  }

  // ---- the second chart: how many games the series takes --------------------------------
  //   res: series()   opts: { higher, lower, allHome, code, wordmark }
  function drawOutcomes(canvas, res, opts, scale = 2) {
    const n = res.games;
    const space = [];
    for (let g = res.need; g <= n; g++) space.push(g);
    const hi = space.map((g) => res.higher[g] * 100), lo = space.map((g) => res.lower[g] * 100);
    const tallest = Math.max(...space.map((_, i) => hi[i] + lo[i]));
    const x0 = space[0] - 0.5, x1 = space[space.length - 1] + 0.5, margin = 0.05 * (x1 - x0);
    const px = (x) => AX.left + ((x - (x0 - margin)) / (x1 - x0 + 2 * margin)) * (AX.right - AX.left);
    const ylimAuto = tallest * 1.05;          // the autoscaled top the labels are placed against
    const ytop = ylimAuto * 1.15;             // then the script makes room for the legend
    const py = (y) => AX.bottom - (y / ytop) * (AX.bottom - AX.top);
    const fontSize = Math.min(12, Math.max(6, 120 / n));
    const logo = wordmarkRect(opts.wordmark, [0.15, -0.06, 0.2, 0.1]);

    const win = res.win;
    const labels = [`${opts.higher.name} Win: ${pct(win)}`, `${opts.lower.name} Win: ${pct(1 - win)}`];
    // the legend: two columns, lower centre at (0.49, 0.87) of the axes
    const em = SIZE.legend * PT;
    const probe = texter(canvas.getContext("2d"));
    const items = labels.map((s) => 2 * em + 0.8 * em + probe.width(s, SIZE.legend));
    const legendW = items[0] + 2 * em + items[1] + 2 * 0.4 * em;
    const legendX = AX.left + 0.49 * (AX.right - AX.left) - legendW / 2;
    const legendY = AX.bottom - 0.87 * (AX.bottom - AX.top) - 0.5 * em - 0.4 * em;  // the row's bottom
    const rowH = probe.box(SIZE.legend).h;
    const titleW = Math.max(probe.width(`${opts.higher.name}/${opts.lower.name} Series Outcomes`, SIZE.suptitle));

    const ctx = setup(canvas, {
      left: Math.min(AX.left, logo.x, legendX, FIG.w / 2 - titleW / 2),
      right: Math.max(AX.right, legendX + legendW, FIG.w / 2 + titleW / 2),
      top: 0,
      bottom: Math.max(logo.y + logo.h, xLabelY(probe) + probe.box(SIZE.label).h),
    }, scale);
    const t = texter(ctx);

    // stacked bars: the higher seed's wins at the bottom, the lower seed's on top
    const bars = [];
    space.forEach((g, i) => {
      bars.push({ x: g, y: 0, h: hi[i], color: opts.higher.color });
      bars.push({ x: g, y: hi[i], h: lo[i], color: opts.lower.color });
    });
    ctx.lineWidth = 1 * PT;
    ctx.strokeStyle = WHITE;
    for (const b of bars) {
      const l = px(b.x - 0.5), r = px(b.x + 0.5), top = py(b.y + b.h), bot = py(b.y);
      ctx.fillStyle = b.color;
      ctx.fillRect(l, top, r - l, bot - top);
      ctx.strokeRect(l, top, r - l, bot - top);
    }
    // each bar's share: inside if it fits, else boxed above it
    for (const b of bars) {
      const s = b.h >= 0.05 ? `${b.h.toFixed(1)}%` : "~0%";
      if (b.h + 1 > ylimAuto / 10) t.text(s, px(b.x), py(b.y + b.h / 2), { size: fontSize });
      else t.boxed(s, px(b.x), py(b.y + b.h + ylimAuto / 30), { size: fontSize, face: opts.lower.color, va: "bottom" });
    }

    // the legend
    let lx = legendX + 0.4 * em;
    const cy = legendY - rowH / 2;
    [opts.higher.color, opts.lower.color].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(lx, cy - 0.35 * em, 2 * em, 0.7 * em);
      ctx.strokeRect(lx, cy - 0.35 * em, 2 * em, 0.7 * em);
      t.text(labels[i], lx + 2.8 * em, cy, { size: SIZE.legend, ha: "left" });
      lx += items[i] + 2 * em;
    });

    xTicks(ctx, t, space, px);
    t.text("Win in X Games", (AX.left + AX.right) / 2, xLabelY(t), { size: SIZE.label, va: "top" });
    const home = opts.allHome ? `, all @${opts.code}` : "";
    header(t, `${opts.higher.name}/${opts.lower.name} Series Outcomes`, `Games Played Distribution (Best of ${n}${home})`, 0.1 * FIG.h);
    if (opts.wordmark) ctx.drawImage(opts.wordmark, logo.x, logo.y, logo.w, logo.h);
  }

  // ---- the Swing Profiles style ------------------------------------------------------
  //
  // The page's figures: the same two charts in the Swing Profiles figure's clothes -- an
  // square 8 x 8 in figure at 200 dpi, its axes box (left 0.10, right 0.96, 0.95 in from the
  // top, 1.08 in from the bottom), the matchup as a large teal title with a muted
  // subtitle under it, the wordmark top right, regular-weight 9 / 10 pt axis text, 2 pt
  // lines with surface-edged markers, and a footer note bottom left. No gridlines and no
  // x spine; the series win% chart keeps a y axis trimmed to its ticks, the outcomes
  // chart has none. (The app's own matplotlib look above is kept as ?style=app.)

  const SW = {
    w: 8, h: 8, left: 0.10, right: 0.96, top: 0.95, bottom: 1.08,
    header: "#00D4FF", sub: "#8D96B3", chrome: "#8D96B3", line: "#00D4FF",
  };

  function swingFigure(canvas, scale) {
    const W = SW.w * DPI, H = SW.h * DPI;
    canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);
    const ax = { x0: SW.left * W, x1: SW.right * W, y0: SW.top * DPI, y1: H - SW.bottom * DPI };
    const font = (size, weight) => { ctx.font = `${weight} ${size * PT}px ${FONT}`; };
    const text = (s, x, y, { size = 10, weight = 400, colour = WHITE, ha = "left", va = "alphabetic", rotate = 0 } = {}) => {
      ctx.save();
      font(size, weight);
      ctx.fillStyle = colour;
      ctx.textAlign = ha;
      ctx.textBaseline = va;
      ctx.translate(x, y);
      if (rotate) ctx.rotate(rotate);
      ctx.fillText(s, 0, 0);
      ctx.restore();
    };
    const measure = (s, size, weight = 400) => { font(size, weight); return ctx.measureText(s).width; };
    return { ctx, W, H, ax, text, measure };
  }

  // tick labels and axis labels, as Swing Profiles' styleAxis, without its gridlines.
  // `y` is optional: { ticks, fmt, sy, label }.
  function swingAxes(f, { xTicks, xFmt = String, sx, xLabel, y = null }) {
    const { ax, text, measure } = f;
    const tickPad = 3.5 * PT, labelPad = 4 * PT;
    for (const v of xTicks) text(xFmt(v), sx(v), ax.y1 + tickPad, { size: 9, ha: "center", va: "top" });
    text(xLabel, (ax.x0 + ax.x1) / 2, ax.y1 + tickPad + 9 * PT + labelPad, { size: 10, ha: "center", va: "top" });
    if (!y) return;
    let widest = 0;
    for (const v of y.ticks) {
      widest = Math.max(widest, measure(y.fmt(v), 9));
      text(y.fmt(v), ax.x0 - tickPad, y.sy(v), { size: 9, ha: "right", va: "middle" });
    }
    text(y.label, ax.x0 - tickPad - widest - labelPad, (ax.y0 + ax.y1) / 2, { size: 10, ha: "center", va: "bottom", rotate: -Math.PI / 2 });
  }
  // the y spine alone, trimmed to run from the first labelled tick to the last
  function ySpine(f, top, bottom) {
    const { ctx, ax } = f;
    ctx.save();
    ctx.strokeStyle = SW.chrome;
    ctx.lineWidth = 1 * PT;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(ax.x0, top); ctx.lineTo(ax.x0, bottom);
    ctx.stroke();
    ctx.restore();
  }

  // Two team colours "look alike" when they are under SIMILAR apart in CIELAB (CIE76):
  // Dodgers/Yankees, Red Sox/Angels, Royals/Blue Jays do; Dodgers/Rays, Brewers/Athletics don't.
  const SIMILAR = 30;
  // the outcomes chart outlines each bar segment, and the tags and key swatches standing in for them
  const OUTLINE = 1 * PT;
  // the outcomes chart's tallest bar stops this far under the key (half the 75 pt it used to)
  const KEY_GAP = 37.5 * PT;
  function lab(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722,
      z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  }
  function lookAlike(a, b) {
    const A = lab(a), B = lab(b);
    return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) < SIMILAR;
  }
  // a faint cross-hatch over a rectangle (clipped to it, and to any clip already set)
  function crossHatch(ctx, x, y, w, h) {
    const step = 7 * PT;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 0.8 * PT;
    ctx.beginPath();
    // anchored to the page, so stacked segments' hatches line up
    for (let c = Math.floor((x - h) / step) * step; c <= x + w + h; c += step) {
      ctx.moveTo(c, y); ctx.lineTo(c + h, y + h);
    //  ctx.moveTo(c + h, y); ctx.lineTo(c, y + h);
    }
    ctx.stroke();
    ctx.restore();
  }

  // title, subtitle, wordmark and the footer note (one sentence a line)
  function swingChrome(f, title, subtitle, note, wordmark) {
    const { ctx, W, H, text } = f;
    text(title, SW.left * W, 0.25 * DPI, { size: 22, weight: 700, colour: SW.header, va: "top" });
    text(subtitle, SW.left * W, 0.625 * DPI, { size: 14, colour: SW.sub, va: "top" });
    const lines = note.split(/(?<=\.)\s+/).filter(Boolean);
    const lineH = 7.5 * PT * 1.6, bottom = H - 0.22 * DPI;
    lines.forEach((s, i) => text(s, SW.left * W, bottom - (lines.length - 1 - i) * lineH, { size: 10, colour: SW.chrome, va: "bottom" }));
    if (wordmark) {
      const w = 0.25 * W, h = w * (wordmark.height / wordmark.width);
      ctx.drawImage(wordmark, SW.right * W - w, 0.3 * DPI, w, h);
    }
  }

  function marker(ctx, x, y, colour) {
    ctx.beginPath();
    ctx.arc(x, y, 4 * PT, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.strokeStyle = BACKGROUND;
    ctx.lineWidth = 2 * PT;
    ctx.stroke();
  }

  // who hosts: "hosts games 1, 2, 5 and 7 (2-2-1-1-1)"
  function hostingNote(code, games, allHome) {
    if (allHome) return `Every game at ${code}, home field worth 4%.`;
    const s = schedule(games);
    const home = s.map((h, i) => (h ? i + 1 : 0)).filter(Boolean);
    const runs = [];
    s.forEach((h, i) => (i && h === s[i - 1] ? runs[runs.length - 1]++ : runs.push(1)));
    const list = home.length > 1 ? `${home.slice(0, -1).join(", ")} and ${home[home.length - 1]}` : String(home[0]);
    return `${code} hosts games ${list} (${runs.join("-")}), home field worth 4%.`;
  }

  function drawLengthSwing(canvas, line, opts, scale) {
    const f = swingFigure(canvas, scale), { ctx, ax, text } = f;
    const vals = line.map(([, v]) => v);
    const ylo = Math.min(0.3, Math.min(...vals) - 0.05), yhi = Math.max(0.7, Math.max(...vals) + 0.05);
    const sx = (x) => ax.x0 + (x / (MAX_LEN + 1)) * (ax.x1 - ax.x0);
    const sy = (y) => ax.y1 - ((y - ylo) / (yhi - ylo)) * (ax.y1 - ax.y0);
    const yBins = Math.min(9, Math.floor((ax.y1 - ax.y0) / PT / 18));
    const yTicks = niceTicks(ylo, yhi, yBins);
    swingAxes(f, { xTicks: LENGTHS, sx, xLabel: "Series Length (Best of X)",
      y: { ticks: yTicks, fmt: (v) => pct(v, 0), sy, label: `${opts.higher.name} Series Win%` } });
    // the coin flip, dashed
    ctx.save();
    ctx.strokeStyle = SW.chrome;
    ctx.lineWidth = 1 * PT;
    ctx.setLineDash([4 * PT, 3 * PT]);
    ctx.beginPath(); ctx.moveTo(ax.x0, sy(0.5)); ctx.lineTo(ax.x1, sy(0.5)); ctx.stroke();
    ctx.restore();
    ySpine(f, sy(yTicks[yTicks.length - 1]), sy(yTicks[0]));
    ctx.save();
    ctx.strokeStyle = SW.line;
    ctx.lineWidth = 2 * PT;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    line.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.stroke();
    ctx.restore();
    for (const [x, y] of line) marker(ctx, sx(x), sy(y), SW.line);
    // Each value sits above its point unless the line runs through that spot (a steep
    // drop does); then below, then the four diagonals -- the first spot clear of the line,
    // the markers and the labels already placed.
    const pts = line.map(([x, y]) => [sx(x), sy(y)]);
    const lh = 11 * PT * (ASC + DESC), off = 8 * PT, clear = 3 * PT;
    const placed = [];
    const hits = (r) => {
      const inside = (px, py) => px > r.l - clear && px < r.r + clear && py > r.t - clear && py < r.b + clear;
      for (let i = 1; i < pts.length; i++) {
        const [ax0, ay0] = pts[i - 1], [ax1, ay1] = pts[i];
        for (let k = 0; k <= 24; k++) if (inside(ax0 + (ax1 - ax0) * k / 24, ay0 + (ay1 - ay0) * k / 24)) return true;
      }
      const m = 4 * PT;  // the markers' radius
      if (pts.some(([px, py]) => px > r.l - m && px < r.r + m && py > r.t - m && py < r.b + m)) return true;
      return placed.some((o) => r.l < o.r && r.r > o.l && r.t < o.b && r.b > o.t);
    };
    line.forEach(([, y], i) => {
      const s = Math.round(y * 1000) / 1000 < 1 ? pct(y) : "~100%";
      const w = f.measure(s, 11), [px, py] = pts[i];
      const spots = [[0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => {
        const cx = px + dx * (w / 2 + off * 0.5), cy = py + dy * (off + lh / 2);
        return { l: cx - w / 2, r: cx + w / 2, t: cy - lh / 2, b: cy + lh / 2, cx, cy };
      });
      const r = spots.find((c) => !hits(c)) || spots[0];
      placed.push(r);
      text(s, r.cx, r.cy, { size: 11, ha: "center", va: "middle" });
    });
    const home = opts.allHome ? `, all @${opts.code}` : "";
    swingChrome(f, `${opts.higher.name} over ${opts.lower.name}`, `${opts.season} Series Win%, by Series Length${home}`,
      `Single game at a neutral site: ${opts.code} ${pct(opts.p)}. ` +
      (opts.allHome ? `Every game at ${opts.code}, home field worth 4%.` : "Higher seed has home field, worth 4%."), opts.wordmark);
  }

  function drawOutcomesSwing(canvas, res, opts, scale) {
    const f = swingFigure(canvas, scale), { ctx, ax, text, measure } = f;
    // no y axis to make room for, so the axes take the right margin on both sides and the
    // bars, the key and the x label centre on the image
    ax.x0 = f.W - ax.x1;
    const n = res.games;
    const space = [];
    for (let g = res.need; g <= n; g++) space.push(g);
    const hi = space.map((g) => res.higher[g]), lo = space.map((g) => res.lower[g]);
    const tallest = Math.max(...space.map((_, i) => hi[i] + lo[i]));
    const x0 = space[0] - 0.5, x1 = space[space.length - 1] + 0.5, margin = 0.05 * (x1 - x0);
    const sx = (x) => ax.x0 + ((x - (x0 - margin)) / (x1 - x0 + 2 * margin)) * (ax.x1 - ax.x0);
    const size = n >= 13 ? 9 : n >= 9 ? 10 : 11;
    const labelH = size * PT * 1.25;
    const fits = (px) => px >= labelH + 4 * PT;       // a segment tall enough to hold its label
    const tagStep = labelH + 2 * PT + 3 * PT;          // one tag over a bar, and the space after it
    // The key sits at the top of the axes; the tallest bar stops KEY_GAP under it. A bar
    // carrying tags for thin slices stops low enough that its tags keep clear of the key.
    // (Which slices need tags depends on the scale, so it settles over a few passes.)
    const ky = ax.y0 + 14 * PT, sw = 10 * PT;
    const room = ax.y1 - (ky + sw / 2);
    let k = (room - KEY_GAP) / tallest;               // px per unit share
    for (let pass = 0; pass < 3; pass++) {
      let next = (room - KEY_GAP) / tallest;
      space.forEach((_, i) => {
        const tags = [hi[i], lo[i]].filter((v) => !fits(v * k)).length;
        if (tags) next = Math.min(next, (room - 6 * PT - 4 * PT - tags * tagStep) / (hi[i] + lo[i]));
      });
      k = next;
    }
    const sy = (y) => ax.y1 - y * k;
    swingAxes(f, { xTicks: space, sx, xLabel: "Series Ends in X Games" });
    // the lower seed's parts are hatched when its colour could pass for the higher seed's
    const hatch = lookAlike(opts.higher.color, opts.lower.color);

    // stacked bars, the higher seed at the bottom, each segment outlined in white
    const halfW = 0.4;
    const above = [];  // labels too big for their segment, stacked over the bar
    space.forEach((g, i) => {
      const segs = [[0, hi[i], opts.higher.color], [hi[i], hi[i] + lo[i], opts.lower.color]];
      const l = sx(g - halfW), r = sx(g + halfW);
      segs.forEach(([a, b, colour], k) => {
        ctx.fillStyle = colour;
        ctx.fillRect(l, sy(b), r - l, sy(a) - sy(b));
        if (hatch && k === 1) crossHatch(ctx, l, sy(b), r - l, sy(a) - sy(b));
      });
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = OUTLINE;
      for (const [a, b] of segs) if (sy(a) - sy(b) > 0.5) ctx.strokeRect(l, sy(b), r - l, sy(a) - sy(b));
      const stack = [];
      segs.forEach(([a, b, colour], k) => {
        const s = b - a >= 0.0005 ? pct(b - a) : "~0%";
        if (fits(sy(a) - sy(b))) text(s, (l + r) / 2, (sy(a) + sy(b)) / 2, { size, ha: "center", va: "middle" });
        else stack.push([s, colour, hatch && k === 1]);
      });
      above.push([g, hi[i] + lo[i], stack]);
    });
    // a label that doesn't fit sits over its bar in a pill of its team's colour
    for (const [g, top, stack] of above) {
      let y = sy(top) - 4 * PT;
      for (const [s, colour, hatched] of stack) {  // in the bar's order: the higher seed's lowest
        const w = measure(s, size) + 8 * PT, h = labelH + 2 * PT;
        ctx.beginPath();
        ctx.roundRect(sx(g) - w / 2, y - h, w, h, 3 * PT);
        ctx.fillStyle = colour;
        ctx.fill();
        if (hatched) { ctx.save(); ctx.clip(); crossHatch(ctx, sx(g) - w / 2, y - h, w, h); ctx.restore(); }
        ctx.beginPath();
        ctx.roundRect(sx(g) - w / 2, y - h, w, h, 3 * PT);
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = OUTLINE;
        ctx.stroke();
        text(s, sx(g), y - h / 2, { size, ha: "center", va: "middle" });
        y -= h + 3 * PT;
      }
    }

    // the key: each side's colour and series win%, centred over the bars
    const gap = 6 * PT, between = 24 * PT;
    const items = [[opts.higher, res.win, false], [opts.lower, 1 - res.win, hatch]].map(([team, v, hatched]) => {
      const s = `${team.name} win: ${pct(v)}`;
      return { team, s, hatched, w: sw + gap + measure(s, 12) };
    });
    let kx = (ax.x0 + ax.x1) / 2 - (items[0].w + between + items[1].w) / 2;
    for (const it of items) {
      ctx.fillStyle = it.team.color;
      ctx.fillRect(kx, ky - sw / 2, sw, sw);
      if (it.hatched) crossHatch(ctx, kx, ky - sw / 2, sw, sw);
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = OUTLINE;
      ctx.strokeRect(kx, ky - sw / 2, sw, sw);
      text(it.s, kx + sw + gap, ky, { size: 12, va: "middle" });
      kx += it.w + between;
    }

    const home = opts.allHome ? `, all @${opts.code}` : "";
    swingChrome(f, `${opts.higher.name} vs. ${opts.lower.name}`, `${opts.season} Series Outcomes, Best of ${n}${home}`,
      `Share of series won by each side, by games played. ${hostingNote(opts.code, n, opts.allHome)}`, opts.wordmark);
  }

  async function render(which, canvas, data, opts, scale = 2, style = "app") {
    await ensureFonts();
    if (style === "swing" && document.fonts) { try { await document.fonts.load(`400 40px ${FONT}`); } catch { /* fallback */ } }
    const wordmark = await loadWordmark();
    const draw = style === "swing" ? (which === "length" ? drawLengthSwing : drawOutcomesSwing) : (which === "length" ? drawLength : drawOutcomes);
    draw(canvas, data, { ...opts, wordmark }, scale);
  }

  window.SeriesWin = { HFA, MAX_LEN, LENGTHS, xWin, log5, schedule, series, byLength, render };
})();
