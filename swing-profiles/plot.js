// Rendering for swing profiles: bat speed and acceleration as stacked panels, on a
// canvas. A port of swing_plot.plot_swing_kinematics -- the same figure geometry
// (inches, points, subplots_adjust, hspace), the same fixed y-limits, the same
// theme and annotations -- so the PNG the page downloads matches what the Python
// saves. The figure is laid out at 200 dpi, the size matplotlib writes.

(() => {
  "use strict";

  // Fixed y-limits, so panels are comparable across players at a glance.
  const SPEED_YLIM = 90.0;    // mph
  const ACCEL_YLIM_G = 47.0;  // g
  // Jerk is asymmetric league-wide (2026: -2577 to +1511 g/s) because every
  // hitter's sharpest event is the late let-off, not the build.
  const JERK_YLIM = [-2700.0, 1600.0];  // g per second

  const THEMES = {
    pitcherlist: {
      surface: "#292C42",   // page + panel ground
      text: "#FFFFFF",      // labels, ticks, annotations
      header: "#00D4FF",
      subheader: "#8D96B3",
      chrome: "#8D96B3",    // axes, spines, gridlines, footer
      velocity: "#00D4FF",
      accel: "#F1C647",
      jerk: "#FFFFFF",
    },
  };
  const GRID_ALPHA = 0.3;
  const FONT = '"DM Sans", "Segoe UI", "DejaVu Sans", sans-serif';
  const DPI = 200;
  const WORDMARK_URL = "https://res.cloudinary.com/dduabusaf/image/upload/v1772839288/PitcherList_Stats_watermark_with_logo_k9e3xa.webp";

  let wordmarkPromise = null;
  function loadWordmark() {
    if (!wordmarkPromise) {
      wordmarkPromise = fetch(WORDMARK_URL).then((r) => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((b) => createImageBitmap(b)).catch(() => null);
    }
    return wordmarkPromise;
  }

  // matplotlib's MaxNLocator with nbins="auto": the smallest of {1,2,2.5,5,10}x10^k
  // at least range/nbins, where nbins comes from the axis length and tick label
  // size (capped at 9).
  function tickValues(vmin, vmax, nbins) {
    const raw = (vmax - vmin) / nbins;
    const base = 10 ** Math.floor(Math.log10(raw));
    let step = 10 * base;
    for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= raw) { step = m * base; break; }
    const lo = Math.ceil(vmin / step - 1e-9), hi = Math.floor(vmax / step + 1e-9);
    const out = [];
    for (let k = lo; k <= hi; k++) out.push(k * step);
    return { ticks: out, step };
  }

  function tickLabel(v, step) {
    const decimals = Number.isInteger(step) ? 0 : Math.min(3, String(step).split(".")[1]?.length ?? 0);
    const s = Math.abs(v).toFixed(decimals);
    return v < 0 && Number(s) !== 0 ? "−" + s : s;
  }

  // Python's round-half-even, for the "{:.0f}" annotations.
  function fmt0(x) {
    const f = Math.floor(x), r = x - f;
    const n = r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
    return String(n);
  }
  function fmt1(x) {
    const y = x * 10, f = Math.floor(y), r = y - f;
    const n = r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
    return (n / 10).toFixed(1);
  }
  function fmtComma0(x) {
    return Number(fmt0(x)).toLocaleString("en-US");
  }

  // Put the opening sentence on its own line when more than one follows.
  function breakAfterFirstSentence(text) {
    const m = /^(.*?\.)\s+(.+)$/s.exec(text.trim());
    return m ? [m[1], m[2]] : [text.trim()];
  }

  async function ensureFonts() {
    if (!document.fonts) return;
    try {
      await Promise.all([
        document.fonts.load(`bold 18px ${FONT}`),
        document.fonts.load(`400 10px ${FONT}`),
      ]);
    } catch (e) { /* fall back to whatever the browser has */ }
  }

  // Plot bat speed and its derivative on a shared x-axis. `profile` is what
  // Swing.getSwingProfile returns. Returns the canvas (200 dpi, ready to save).
  async function plotSwingKinematics(profile, {
    theme = "pitcherlist", showJerk = false, showWordmark = true, canvas = null,
    speedYlim = SPEED_YLIM, accelYlim = ACCEL_YLIM_G, jerkYlim = JERK_YLIM,
  } = {}) {
    if (!(theme in THEMES)) throw new Error(`theme must be one of ${Object.keys(THEMES).sort()}`);
    const c = THEMES[theme];
    const figW = 8.0, figH = showJerk ? 9.2 : 7.0;
    const S = DPI;                     // px per inch
    const pt = (p) => (p * S) / 72;    // points -> px

    await ensureFonts();
    const mark = showWordmark ? await loadWordmark() : null;

    const cv = canvas || document.createElement("canvas");
    cv.width = Math.round(figW * S);
    cv.height = Math.round(figH * S);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = c.surface;
    ctx.fillRect(0, 0, cv.width, cv.height);

    const d = profile.data;
    const t = d.swing_time, v = d.swing_speed, a = d.acceleration, j = d.jerk;
    const n = t.length;
    const swingDuration = profile.duration_s;
    const span = t[n - 1] - t[0];
    const warnings = [];
    if (Math.max(...v) > speedYlim) warnings.push(`bat speed peaks at ${Math.max(...v).toFixed(1)}, above the fixed axis limit of ${speedYlim}; the curve is clipped.`);
    if (Math.max(...a) > accelYlim) warnings.push(`acceleration peaks at ${Math.max(...a).toFixed(1)}, above the fixed axis limit of ${accelYlim}; the curve is clipped.`);

    // --- geometry (matplotlib figure fractions, y measured from the bottom) ---
    const nPanels = showJerk ? 3 : 2;
    const left = 0.10, right = 0.96;
    const top = 1 - 0.95 / figH, bottom = 1.08 / figH;
    const hspace = 0.22;
    const axH = (top - bottom) / (nPanels + (nPanels - 1) * hspace);
    const gap = hspace * axH;
    const X = (fx) => fx * figW * S;
    const Y = (fy) => (1 - fy) * figH * S;
    const panels = [];
    for (let i = 0; i < nPanels; i++) {
      const yTop = top - i * (axH + gap);
      panels.push({ x0: X(left), x1: X(right), y0: Y(yTop), y1: Y(yTop - axH) });
    }
    const xlim = [t[0], t[n - 1] * 1.01];
    const axWidthPt = ((right - left) * figW * 72);
    const axHeightPt = (axH * figH * 72);
    const xBins = Math.min(9, Math.max(1, Math.floor(axWidthPt / (9 * 3))));
    const yBins = Math.min(9, Math.max(1, Math.floor(axHeightPt / (9 * 2))));

    const setFont = (size, weight = 400) => { ctx.font = `${weight} ${pt(size)}px ${FONT}`; };
    const text = (s, x, y, { size = 10, weight = 400, color = c.text, ha = "left", va = "alphabetic", rotate = 0 } = {}) => {
      ctx.save();
      setFont(size, weight);
      ctx.fillStyle = color;
      ctx.textAlign = ha === "right" ? "right" : ha === "center" ? "center" : "left";
      ctx.textBaseline = va;
      ctx.translate(x, y);
      if (rotate) ctx.rotate(rotate);
      ctx.fillText(s, 0, 0);
      ctx.restore();
    };
    const measure = (s, size, weight = 400) => { setFont(size, weight); return ctx.measureText(s).width; };

    const xTicks = tickValues(xlim[0], xlim[1], xBins);
    const tickPad = pt(3.5), labelPad = pt(4);

    // Recessive grid and axes in the chrome color; tick labels in text color.
    function styleAxis(p, ylim, yTicks) {
      const sx = (x) => p.x0 + ((x - xlim[0]) / (xlim[1] - xlim[0])) * (p.x1 - p.x0);
      const sy = (y) => p.y1 - ((y - ylim[0]) / (ylim[1] - ylim[0])) * (p.y1 - p.y0);
      ctx.save();
      ctx.globalAlpha = GRID_ALPHA;
      ctx.strokeStyle = c.chrome;
      ctx.lineWidth = pt(0.8);
      ctx.beginPath();
      for (const xv of xTicks.ticks) { const x = sx(xv); ctx.moveTo(x, p.y0); ctx.lineTo(x, p.y1); }
      for (const yv of yTicks.ticks) { const y = sy(yv); ctx.moveTo(p.x0, y); ctx.lineTo(p.x1, y); }
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = c.chrome;
      ctx.lineWidth = pt(1.0);
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x0, p.y1); ctx.lineTo(p.x1, p.y1);
      ctx.stroke();
      ctx.restore();
      let widest = 0;
      for (const yv of yTicks.ticks) {
        const s = tickLabel(yv, yTicks.step);
        widest = Math.max(widest, measure(s, 9));
        text(s, p.x0 - tickPad, sy(yv), { size: 9, ha: "right", va: "middle" });
      }
      return { sx, sy, tickWidth: widest };
    }
    function yLabel(p, label, tickWidth) {
      text(label, p.x0 - tickPad - tickWidth - labelPad, (p.y0 + p.y1) / 2,
        { size: 10, ha: "center", va: "bottom", rotate: -Math.PI / 2 });
    }
    function line(p, xs, ys, sx, sy, color) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0);
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.lineWidth = pt(2.0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      xs.forEach((x, i) => (i ? ctx.lineTo(sx(x), sy(ys[i])) : ctx.moveTo(sx(x), sy(ys[i]))));
      ctx.stroke();
      ctx.restore();
    }
    // markersize 8 with a 2pt edge in the surface color, the edge centred on the rim.
    function marker(x, y, color) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, pt(4), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = c.surface;
      ctx.lineWidth = pt(2);
      ctx.stroke();
      ctx.restore();
    }
    function zeroLine(p, sy) {
      ctx.save();
      ctx.strokeStyle = c.chrome;
      ctx.lineWidth = pt(1.0);
      ctx.beginPath(); ctx.moveTo(p.x0, sy(0)); ctx.lineTo(p.x1, sy(0)); ctx.stroke();
      ctx.restore();
    }
    // Put a marker label on whichever side keeps it inside the axes.
    const labelSide = (x) => ((x - t[0]) / span > 0.62 ? ["right", x - 0.02 * span] : ["left", x + 0.02 * span]);

    // --- velocity ------------------------------------------------------------
    {
      const p = panels[0], ylim = [0, speedYlim];
      const yt = tickValues(ylim[0], ylim[1], yBins);
      const { sx, sy, tickWidth } = styleAxis(p, ylim, yt);
      line(p, t, v, sx, sy, c.velocity);
      marker(sx(t[n - 1]), sy(v[n - 1]), c.velocity);
      // Sit the label just above the point, but never push it past the ceiling.
      text(`${fmt1(v[n - 1])} mph at Contact`,
        sx(t[n - 1] - 0.01 * span), sy(Math.min(v[n - 1] + 0.03 * speedYlim, 0.93 * speedYlim)),
        { size: 14, ha: "right", va: "bottom" });
      yLabel(p, "Bat speed (mph)", tickWidth);
    }

    // --- derivative ----------------------------------------------------------
    let peak;
    {
      const p = panels[1];
      const aMin = Math.min(...a);
      const ylim = [Math.min(0, aMin * 1.1), accelYlim];
      const yt = tickValues(ylim[0], ylim[1], yBins);
      const { sx, sy, tickWidth } = styleAxis(p, ylim, yt);
      zeroLine(p, sy);
      const lo = 4, hi = n - 5;
      peak = lo;
      for (let i = lo; i < hi; i++) if (a[i] > a[peak]) peak = i;
      line(p, t.slice(lo, hi), a.slice(lo, hi), sx, sy, c.accel);
      marker(sx(t[peak]), sy(a[peak]), c.accel);
      const [ha, xa] = labelSide(t[peak]);
      text(`Peak: ${fmt0(a[peak])} g at ${fmt0(t[peak])} ms`,
        sx(xa), sy(Math.min(a[peak] + 0.02 * accelYlim, 0.93 * accelYlim)),
        { size: 14, ha, va: "bottom" });
      yLabel(p, "Acceleration (g)", tickWidth);
    }

    // --- jerk ----------------------------------------------------------------
    let trough = null;
    if (showJerk) {
      const p = panels[2];
      const [lo, hi] = jerkYlim;
      const yt = tickValues(lo, hi, yBins);
      const { sx, sy, tickWidth } = styleAxis(p, [lo, hi], yt);
      zeroLine(p, sy);
      const i0 = 9, i1 = n - 10;
      trough = i0;
      for (let i = i0; i < i1; i++) if (j[i] < j[trough]) trough = i;
      line(p, t.slice(i0, i1), j.slice(i0, i1), sx, sy, c.jerk);
      marker(sx(t[trough]), sy(j[trough]), c.jerk);
      // The let-off is the informative extreme, so label the trough.
      const [ha, xj] = labelSide(t[trough]);
      text(`Let-off: ${fmtComma0(j[trough])} g/s at ${fmt0(t[trough])} ms`,
        sx(xj), sy(Math.max(j[trough] - 0.02 * (hi - lo), lo + 0.06 * (hi - lo))),
        { size: 14, ha, va: "top" });
      yLabel(p, "Jerk (g per second)", tickWidth);
      const jMax = Math.max(...j), jMin = Math.min(...j);
      if (jMax > hi || jMin < lo) warnings.push(`jerk spans ${jMin.toFixed(0)} to ${jMax.toFixed(0)}, outside the fixed axis ${lo} to ${hi}; the curve is clipped.`);
    }

    // --- shared x axis -------------------------------------------------------
    {
      const p = panels[nPanels - 1];
      const sx = (x) => p.x0 + ((x - xlim[0]) / (xlim[1] - xlim[0])) * (p.x1 - p.x0);
      for (const xv of xTicks.ticks) text(tickLabel(xv, xTicks.step), sx(xv), p.y1 + tickPad, { size: 9, ha: "center", va: "top" });
      text("Elapsed time (ms)", (p.x0 + p.x1) / 2, p.y1 + tickPad + pt(9) + labelPad, { size: 10, ha: "center", va: "top" });
    }

    // --- header, footer, wordmark --------------------------------------------
    // The player is the title; each panel's y-label names its own series. The
    // header block sits a fixed distance from the top in inches, so it does not
    // drift when a third panel makes the figure taller.
    if (profile.display_name) {
      text(profile.display_name, X(left), 0.25 * S, { size: 22, weight: 700, color: c.header, va: "top" });
    }
    text(`${profile.year} Swing Kinematics, as ${profile.handedness}HB`, X(left), 0.625 * S, { size: 14, color: c.subheader, va: "top" });

    const note = breakAfterFirstSentence(
      "Derived from Baseball Savant images and data. Duration imputed as swing " +
      `length / mean bat speed ≈ ${fmt0(swingDuration * 1000)} ms.`);
    const lineH = pt(7.5) * 1.6;
    const noteBottom = figH * S - 0.22 * S;
    note.forEach((s, i) => text(s, X(left), noteBottom - (note.length - 1 - i) * lineH, { size: 10, color: c.chrome, va: "bottom" }));

    if (mark) {
      const wFrac = 0.25;
      const w = wFrac * figW * S, h = w * (mark.height / mark.width);
      //ctx.drawImage(mark, X(right) - w, figH * S - 0.24 * S - h, w, h);
      ctx.drawImage(mark, X(right) - w, 0.3 * S, w, h);
    }

    return { canvas: cv, peak, trough, warnings };
  }

  window.SwingPlot = { plotSwingKinematics, THEMES, SPEED_YLIM, ACCEL_YLIM_G, JERK_YLIM, DPI, fmt0, fmt1, fmtComma0 };
})();
