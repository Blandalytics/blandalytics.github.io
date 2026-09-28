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

  async function render(which, canvas, data, opts, scale = 2) {
    await ensureFonts();
    const wordmark = await loadWordmark();
    (which === "length" ? drawLength : drawOutcomes)(canvas, data, { ...opts, wordmark }, scale);
  }

  window.SeriesWin = { HFA, MAX_LEN, LENGTHS, xWin, log5, schedule, series, byLength, render };
})();
