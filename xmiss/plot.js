// Miss-ellipse chart for /xmiss/: a pitcher's 1-SD miss ellipses around the predicted target,
// drawn on a square canvas in the Swing Profile figure style (the Pitcher List theme, DM Sans,
// the wordmark top right). The frame is the pitcher-card Movement chart's: rings every 6",
// solid at 12" and 24", axes running past the outer ring, side labels outside it. The scale is
// fixed (24" outer ring) so pitchers compare, and anything past the ring is clipped.
//
// Data coordinates (xmiss/<built>/<season>.json): inches from the pitcher's view, x positive
// toward the pitcher's arm side, z positive high; angle is the long axis in degrees
// counter-clockwise from the arm-side horizontal. On screen, as on the pitcher card, the arm
// side is on the right for a right-hander and on the left for a left-hander, so a lefty's
// x is mirrored (x -> -x) and so is his angle (angle -> 180 - angle).
(() => {
  "use strict";

  const C = {
    surface: "#292C42", text: "#FFFFFF", header: "#00D4FF", subheader: "#8D96B3", chrome: "#8D96B3",
  };
  const FONT = '"DM Sans", "Segoe UI", "DejaVu Sans", sans-serif';
  const WORDMARK_URL = "https://res.cloudinary.com/dduabusaf/image/upload/v1772839288/PitcherList_Stats_watermark_with_logo_k9e3xa.webp";
  const SIZE = 1600;            // canvas px, square; shown at up to 720 CSS px, so sharp to 2.2x
  const RING = 24, AXIS = 26.5; // inches: outer ring, axis length
  // the text floor: the chart's 1000 layout units show at SHOWN CSS px on a laptop-width page, so
  // no text is drawn smaller than MIN_PX there (or in the shared image viewed at that size)
  const SHOWN = 640, MIN_PX = 12, MIN = MIN_PX * 1000 / SHOWN;   // the site minimum: 12px
  const atLeast = (size) => Math.max(size, MIN);

  // the site's pitch palette: pitcher-cards/card.js MARKER_COLORS (the PLPD pitch-* colours); the
  // variants it doesn't list take their family's colour
  const MARKER_COLORS = {
    FF: "#ff839b", SI: "#ffc277", FS: "#83d6ff", FC: "#c59c9c", SL: "#ce66ff",
    ST: "#ffaaf7", CU: "#2a98ff", CH: "#6de95d", KN: "#a0a0a0", UN: "#c7c7c7",
    KC: "#2a98ff", CS: "#2a98ff", SV: "#ffaaf7", FO: "#83d6ff", SC: "#6de95d",
  };
  const PITCH_NAMES = {
    FF: "Four-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider", ST: "Sweeper", CU: "Curveball",
    CH: "Changeup", FS: "Splitter", KN: "Knuckleball", UN: "Unknown",
    KC: "Knuckle Curve", CS: "Slow Curve", SV: "Slurve", FO: "Forkball", SC: "Screwball",
  };
  const color = (pt) => MARKER_COLORS[pt] || MARKER_COLORS.UN;
  const pitchName = (pt) => PITCH_NAMES[pt] || pt;

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  let wordmarkPromise = null;
  function loadWordmark() {
    if (!wordmarkPromise) {
      wordmarkPromise = fetch(WORDMARK_URL).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => createImageBitmap(b)).catch(() => null);
    }
    return wordmarkPromise;
  }

  async function ensureFonts() {
    if (!document.fonts) return;
    try {
      await Promise.all([document.fonts.load(`700 40px ${FONT}`), document.fonts.load(`400 20px ${FONT}`)]);
    } catch (e) { /* fall back to whatever the browser has */ }
  }

  // Draw the chart. `p` is a pitcher from the season file, `view` "mix" or a pitch code,
  // `league` the season file's league averages, `dots` (a pitch-type view only) that pitch type's
  // pitches from the pitcher file, {x, z} in tenths of an inch: where each pitch landed relative
  // to the pitcher's count-group spot, the spread the ellipse summarizes. Returns the canvas.
  async function draw(canvas, { p, season, view, league, dots = null }) {
    await ensureFonts();
    const mark = await loadWordmark();
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    const u = SIZE / 1000;                         // layout units: the figure is 1000 x 1000
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, SIZE, SIZE);

    const text = (s, x, y, { size = 20, weight = 400, fill = C.text, align = "left", base = "alphabetic", alpha = 1 } = {}) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `${weight} ${size * u}px ${FONT}`;
      ctx.fillStyle = fill;
      ctx.textAlign = align;
      ctx.textBaseline = base;
      ctx.fillText(s, x * u, y * u);
      ctx.restore();
    };
    const width = (s, size, weight = 400) => { ctx.font = `${weight} ${size * u}px ${FONT}`; return ctx.measureText(s).width / u; };

    // ---- header: Model Drilldown's card header (pitcher; pitch in its colour; season), its
    // 46 / 29 / 17 px on a 1280-wide card scaled to this one's width ----
    const one = view !== "mix" ? p.pitches[view] : null;
    text(p.name, 50, 76, { size: 36, weight: 700, fill: C.header });
    // a pitch type: its name in its colour before "xMiss Distance"; the whole mix says so in its key
    const what = one ? pitchName(view) + " " : "";
    if (one) text(what, 50, 106, { size: 22.6, weight: 700, fill: color(view) });
    text("xMiss Distance", 50 + width(what, 22.6, 700), 106, { size: 22.6, weight: 700, fill: C.text });
    text(`${season} - ${(one ? one.n : p.n).toLocaleString("en-US")} pitches`, 50, 132, { size: atLeast(13.3), fill: C.subheader });
    if (mark) {
      const w = 230, h = w * (mark.height / mark.width);
      ctx.drawImage(mark, (950 - w) * u, 46 * u, w * u, h * u);
    }

    // ---- key: every pitch's xMiss (whole mix) or the pitch's numbers ----
    let keyBottom = 208;                           // the key's last baseline: one legend row
    const LG = Math.max(30, atLeast(20) * 1.4);    // between legend rows
    if (one) {
      const lg = league[view];
      const parts = [
        [`xMiss ${one.xmiss.toFixed(2)}"`, C.text, 700],
        [one.pct == null ? "no percentile" : `${ordinal(one.pct)} percentile`, C.text, 400],
        [`1 SD ${one.major.toFixed(1)}" × ${one.minor.toFixed(1)}", Tilt: ${Math.round(one.angle)}°`, C.text, 400],
      ];
      if (lg) parts.splice(1, 0, [`(lg: ${lg.xmiss.toFixed(2)}")`, C.subheader, 400]);   // right after the xMiss
      // one line, centred on the canvas; shrunk to fit the margins if it ever runs long
      const sepOf = (s, i) => (!i ? "" : s.startsWith("(lg") ? " " : " - ");   // "xMiss 8.85" (lg: 11.37") - ..."
      const lineW = (size) => parts.reduce((w, [s, , weight], i) => w + width(sepOf(s, i), size) + width(s, size, weight), 0);
      const size = atLeast(Math.min(22, 22 * 900 / lineW(22)));
      let x = 500 - lineW(size) / 2;
      parts.forEach(([s, fill, weight], i) => {
        const sep = sepOf(s, i);
        if (sep) { text(sep, x, 180, { size, fill: C.subheader }); x += width(sep, size); }
        text(s, x, 180, { size, fill, weight });
        x += width(s, size, weight);
      });
    } else {
      // both lines centred on the canvas: the whole mix's number, then the pitch types (rows
      // wrapped within the margins, each row centred)
      text(`Whole Mix xMiss: ${p.xmiss.toFixed(2)}"${p.pct == null ? "" : `  (${ordinal(p.pct)} pct)`}`, 500, 172,
        { size: 22, weight: 700, align: "center" });
      // the pitch types in usage order over as few rows as fit within the margins, split evenly
      // (5 + 1 becomes 3 + 3), so every row holds at least two. A pitcher with too few pitch
      // types for that (three long names that won't share a row) gets fewer rows in smaller type.
      const B = atLeast(20), MAXW = 900;              // the key's size, unless a row must shrink to fit
      const GAP = 26 / 20, DOT = 24 / 20;             // per unit of size: between items; the dot and its space
      const items = Object.entries(p.pitches).map(([pt, e]) => ({ pt, s: `${pitchName(pt)} ${e.xmiss.toFixed(2)}"` }));
      items.forEach((it) => { it.w = width(it.s, 20) / 20; });   // text width per unit of size
      const n = items.length;
      const split = (R) => {                          // R rows, the larger ones first
        const out = [];
        for (let r = 0, i = 0; r < R; r++) { const c = Math.floor(n / R) + (r < n % R ? 1 : 0); out.push(items.slice(i, i + c)); i += c; }
        return out;
      };
      const rowW = (row, size) => size * (row.reduce((t, it) => t + DOT + it.w, 0) + GAP * (row.length - 1));
      let rows = split(1);
      for (let R = 2; R <= n && rows.some((row) => rowW(row, B) > MAXW); R++) rows = split(R);
      const most = Math.max(1, Math.floor(n / 2));
      if (rows.length > most) rows = split(most);
      const fits = () => Math.min(B, ...rows.map((row) => B * MAXW / rowW(row, B)));
      // never under the text floor: a key that would need it takes another row instead
      for (let R = rows.length + 1; R <= n && fits() < MIN; R++) rows = split(R);
      const size = atLeast(fits()), f = size / 20;
      keyBottom = 208 + (rows.length - 1) * LG;
      rows.forEach((row, r) => {
        const y = 208 + r * LG;
        let x = 500 - rowW(row, size) / 2;
        row.forEach(({ pt, s, w }) => {
          ctx.save();
          ctx.fillStyle = color(pt);
          ctx.beginPath();
          ctx.arc((x + 8 * f) * u, (y - 7 * f) * u, 8 * f * u, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          text(s, x + DOT * size, y, { size });
          x += (DOT + w + GAP) * size;
        });
      });
    }

    // ---- frame ----
    // one scale for every chart, so pitchers compare: the frame sits under room for a two-row
    // key (the High label 37 units below its last line) with its foot, the Low label, just above
    // the footer. A rarer three-row key shrinks it further.
    // The footer, the same two lines on every chart (each sentence on its own, wrapped only if
    // one ever outgrows the margins), sets the frame's foot, so every chart keeps one scale.
    const FS = atLeast(15), LH = FS * 1.3;
    const wrapAt = (para, maxW) => para.split(" ").reduce((lines, w) => {
      const last = lines[lines.length - 1], t = last ? last + " " + w : w;
      if (last && width(t, FS) > maxW) lines.push(w); else lines[lines.length - 1] = t;
      return lines;
    }, [""]);
    const wrap = (para) => {                       // as few lines as fit, balanced: no lone last word
      const n = wrapAt(para, 900).length;
      let lo = 0, hi = 900;
      while (n > 1 && hi - lo > 1) { const mid = (lo + hi) / 2; if (wrapAt(para, mid).length > n) lo = mid; else hi = mid; }
      return wrapAt(para, hi);
    };
    const footer = ["xMiss: expected miss from a predicted target.",
      "Statcast-feature model trained on Open Command miss distance data"].flatMap(wrap);
    const footLimit = 982 - (footer.length - 1) * LH - FS * 0.75 - 22;
    const cx = 500;
    let cy = 585, k = 12.6;
    const top = Math.max(cy - AXIS * k - 6, Math.max(keyBottom, 208 + LG) + 37);
    const foot = Math.min(cy + AXIS * k + 6, footLimit);
    if (top > cy - AXIS * k - 6 || foot < cy + AXIS * k + 6) {
      const half = (foot - top) / 2;
      cy = top + half;
      k = (half - 6) / AXIS;
    }
    const X = (v) => (cx + v * k) * u, Y = (v) => (cy - v * k) * u;
    ctx.save();
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = C.text;
    for (const r of [6, 18]) {
      ctx.globalAlpha = 0.1;
      ctx.setLineDash([8 * u, 8 * u]);
      ctx.beginPath(); ctx.arc(X(0), Y(0), r * k * u, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.5;
    for (const r of [12, 24]) { ctx.beginPath(); ctx.arc(X(0), Y(0), r * k * u, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath();
    ctx.moveTo(X(-AXIS), Y(0)); ctx.lineTo(X(AXIS), Y(0));
    ctx.moveTo(X(0), Y(AXIS)); ctx.lineTo(X(0), Y(-AXIS));
    ctx.stroke();
    ctx.restore();
    for (const r of [12, 24]) {
      text(`${r}"`, cx + r * k - 6, cy + 22, { size: atLeast(16), align: "right", alpha: 0.75 });
      text(`${r}"`, cx - r * k + 6, cy + 22, { size: atLeast(16), align: "left", alpha: 0.75 });
      text(`${r}"`, cx + 8, cy - r * k + 22, { size: atLeast(16), alpha: 0.75 });
      text(`${r}"`, cx + 8, cy + r * k - 8, { size: atLeast(16), alpha: 0.75 });
    }
    const lefty = p.hand === "L";
    const side = { size: atLeast(20), weight: 700, base: "middle" };
    text(lefty ? "Glove Side" : "Arm Side", cx + AXIS * k + 12, cy, { ...side, align: "left" });
    text(lefty ? "Arm Side" : "Glove Side", cx - AXIS * k - 12, cy, { ...side, align: "right" });
    // beside the axis ends, so a two-row key above never meets them
    text("High", cx + 12, cy - AXIS * k + 4, { ...side, align: "left" });
    text("Low", cx + 12, cy + AXIS * k - 4, { ...side, align: "left" });

    // ---- ellipses, clipped to the outer ring ----
    const shown = one ? [[view, one]] : Object.entries(p.pitches)
      .sort((a, b) => b[1].major * b[1].minor - a[1].major * a[1].minor);   // largest first, small ones on top
    ctx.save();
    ctx.beginPath(); ctx.arc(X(0), Y(0), RING * k * u, 0, Math.PI * 2); ctx.clip();
    if (one && dots && dots.x && dots.x.length) {
      // the pitches: small, muted and see-through, under the ellipse
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = color(view);
      const r = 3.2 * u, flip = lefty ? -1 : 1;
      ctx.beginPath();
      for (let i = 0; i < dots.x.length; i++) {
        const x = X(flip * dots.x[i] / 10), y = Y(dots.z[i] / 10);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    }
    for (const [pt, e] of shown) {
      const ex = lefty ? -e.cx : e.cx, ang = lefty ? 180 - e.angle : e.angle;
      const rot = -ang * Math.PI / 180;                  // counter-clockwise on screen (y runs down)
      ctx.beginPath();
      ctx.ellipse(X(ex), Y(e.cz), e.major * k * u, e.minor * k * u, rot, 0, Math.PI * 2);
      ctx.globalAlpha = one ? 0.35 : 0.2;
      ctx.fillStyle = color(pt);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = (one ? 5 : 3.5) * u;
      ctx.strokeStyle = color(pt);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X(ex), Y(e.cz), (one ? 7 : 4.5) * u, 0, Math.PI * 2);
      ctx.fillStyle = color(pt);
      ctx.fill();
      ctx.lineWidth = 2 * u;
      ctx.strokeStyle = C.text;
      ctx.stroke();
    }
    ctx.restore();

    // ---- footer: wrapped within the margins, its last line on the same baseline as ever ----
    footer.forEach((line, i) => text(line, 50, 982 - (footer.length - 1 - i) * LH, { size: FS, fill: C.chrome }));
    return canvas;
  }

  window.XmissPlot = { draw, MARKER_COLORS, PITCH_NAMES, color, pitchName, ordinal, SIZE };
})();
