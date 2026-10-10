// The PLV Pitcher Game Card, drawn from its card dict (tools/pitcher_card/build_data.py,
// version 2) as one SVG, plus what a page needs to show it: the comparison layer, and the
// card as a PNG to copy or save.
//
// The card is drawn in the original figure's coordinate system (15 x 20 inches at 100 dpi,
// so 1500 x 2000 units): every panel keeps the matplotlib axes rectangle and data limits of
// the card it replaces, and text sizes are the original point sizes. Every comparison
// season's layer is drawn, tagged data-cmp="<year>" (data-cmp="0" is the no-comparison
// layer), and `show()` picks the one on display.
//
// This is the drawing tools/pitcher_card/render.py used to do, ported: for the same card it
// writes the same SVG byte for byte, which tools/pitcher_card/test/render.mjs holds it to.
// The dict carries numbers, so the formatting is Python's, reproduced exactly (see
// `fixed`). Constants and functions keep render.py's names so the history reads side by
// side.
//
//   PitcherCard.svg(card, {logo})        the SVG markup
//   PitcherCard.draw(el, card, opts)     ...drawn into an element; returns the <svg>
//   PitcherCard.show(el, year)           one comparison layer (0 for none)
//   PitcherCard.comparisonYear(card, y)  y if the card has that season, else its latest
//   PitcherCard.png(svgEl)               the card as a 3000 x 4000 PNG blob
//   PitcherCard.copyPng(svgEl, name)     ...onto the clipboard, else downloaded
//   PitcherCard.filename(card)           the name to save it under
//
// A classic <script> defines window.PitcherCard; require() returns the same object.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PitcherCard = factory();
})(typeof self !== "undefined" ? self : this, () => {
  "use strict";

  const VERSION = 2; // the card dict this draws

  // ---- Python's number formatting ---------------------------------------------------
  // f"{v:.Nf}" and round() take the double's exact binary value to the nearest, ties to
  // even; toFixed and Math.round settle ties upward, so 32.5 would round to 33 where the
  // card says 32. A double is m * 2^e for integers m and e, so the digits are worked out
  // from those in BigInt, exactly.
  const F64 = new Float64Array(1);
  const U64 = new BigUint64Array(F64.buffer);

  function parts(v) {
    // [sign bit, m, e] with |v| = m * 2^e
    F64[0] = v;
    const bits = U64[0];
    const exp = Number((bits >> 52n) & 0x7ffn);
    const frac = bits & 0xfffffffffffffn;
    const neg = bits >> 63n === 1n;
    return exp === 0 ? [neg, frac, -1074] : [neg, frac | (1n << 52n), exp - 1075];
  }

  function scaled(m, e, n) {
    // the integer nearest m * 2^e * 10^n, ties to even
    const num = m * 10n ** BigInt(n);
    if (e >= 0) return num << BigInt(e);
    const d = BigInt(-e);
    const q = num >> d;
    const r = num - (q << d);
    const half = 1n << (d - 1n);
    return r > half || (r === half && (q & 1n) === 1n) ? q + 1n : q;
  }

  // f"{v:.{n}f}": the sign kept even when it rounds to zero, as Python keeps it
  function fixed(v, n) {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
    const [neg, m, e] = parts(v);
    const digits = scaled(m, e, n).toString().padStart(n + 1, "0");
    const cut = digits.length - n;
    return (neg ? "-" : "") + digits.slice(0, cut) + (n ? "." + digits.slice(cut) : "");
  }

  // round(v): an int, so no negative zero
  function pyRound(v) {
    const [neg, m, e] = parts(v);
    const q = Number(scaled(m, e, 0));
    return neg && q ? -q : q;
  }

  const fmt = (v) => fixed(v, 1); // render.py's _fmt
  const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); // f"{n:,}"
  const isNum = (v) => typeof v === "number" && v === v; // NaN never arrives; None does

  // html.escape(s, quote=True)
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  // dict.get: own keys only, so a pitch type can never find Object.prototype's
  const get = (o, k, d) => (o != null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

  // ---- palette ----------------------------------------------------------------------
  const BACKGROUND = "#292C42";
  const WHITE = "#FFFFFF";
  const TEXT = "#00D4FF";
  const LINE = "#8D96B3";
  const HIGHLIGHT = "#F1C647";
  const LINE_TEXT = "#bae2ff"; // the box-score line under the title
  const NAME_GRADIENT = ["#00D4FF", "#0099CC"];

  const MARKER_COLORS = {
    FF: "#FF6683", SI: "#F2B24B", FS: "#83D6FF", FC: "#C59C9C", SL: "#CE66FF",
    ST: "#FFAAF7", CU: "#339cff", CH: "#6DE95D", KN: "#c7c7c7", UN: "#c7c7c7",
  };

  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  function mix(a, b, t) {
    const x = rgb(a);
    const y = rgb(b);
    return "#" + x.map((xi, i) => pyRound(xi + (y[i] - xi) * t).toString(16).padStart(2, "0")).join("");
  }

  // seaborn.blend_palette: n colours linearly interpolated through the stops
  function blend(stops, n) {
    const steps = stops.length - 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const pos = (i / (n - 1)) * steps;
      const k = Math.min(Math.trunc(pos), steps - 1);
      out.push(mix(stops[k], stops[k + 1], pos - k));
    }
    return out;
  }

  const DIVERGE_STOPS = ["#4BBFDF", "#FFFFFF", "#ff5757"];
  const DIVERGE = blend(DIVERGE_STOPS, 5); // stat colours, worst -> best
  const VELO_DIFF = blend(DIVERGE_STOPS, 13); // velo change vs the comparison season
  const GRADE_PALETTE = blend(DIVERGE_STOPS, 9);

  const LETTERS = ["F", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
  // a letter's colour is its family's (D-, D and D+ share one), A+ gets the highlight
  const GRADE_COLORS = { "-": WHITE, "A+": HIGHLIGHT };
  ["F", "D", "C", "B", "A"].forEach((g, i) => (GRADE_COLORS[g] = GRADE_PALETTE[2 * i]));
  LETTERS.forEach((g) => (GRADE_COLORS[g] = GRADE_COLORS[g] || GRADE_COLORS[g[0]]));

  const PITCH_NAMES = {
    FF: "Four-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider", ST: "Sweeper",
    CU: "Curveball", CH: "Changeup", FS: "Splitter", KN: "Knuckleball", UN: "Unknown",
  };

  // ---- benchmark bins ---------------------------------------------------------------
  // Inner cut points of five bins per stat, by pitch type: the coloured stats on the card
  // take the colour of the bin they fall in. Omitted stats stay white. plvStuff+ and PLV+
  // are the 10th, 30th, 70th and 90th percentiles of that pitch type's 2026 pitcher-games
  // (unweighted, on the pitcher_game_pitch_type plus scale; models of Oct 2026).
  const TYPE_BINS = {
    FF: {
      Velo: [90.2, 93.2, 95.6, 98.2], IVB: [10, 14.3, 16.9, 19.2],
      IVB_acc: [66.9, 91.7, 107.5, 121.6], HB: [1.6, 5.9, 9.6, 13.7],
      HB_acc: [9.7, 36, 59, 84.7], HAVAA: [0.13, 0.72, 1.2, 1.74],
      "SwStr%": [1, 5.9, 13, 22.8], "CSW%": [0, 20, 100 / 3, 50],
      xSLGcon: [0.125, 0.390, 0.725, 1.385], "plvStuff+": [73.3, 84.4, 99.7, 110.9],
      "PLV+": [72.8, 90.5, 107.5, 119.6],
    },
    SI: {
      Velo: [89.1, 92.4, 95.1, 97.7], IVB: [0.5, 6.3, 10.5, 15.1],
      IVB_acc: [7.3, 37, 61.3, 88], HB: [9.5, 13.9, 16.4, 18.5],
      HB_acc: [62.5, 86, 100.6, 116], HAVAA: [-0.27, 0.33, 0.83, 1.42],
      "SwStr%": [1, 2.8, 7.8, 16.6], "CSW%": [0, 100 / 6, 100 / 3, 50],
      xSLGcon: [0.15, 0.340, 0.585, 1.095], "plvStuff+": [75.2, 84.2, 95.9, 105.5],
      "PLV+": [72.6, 92.4, 110.3, 123.3],
    },
    FC: {
      Velo: [85, 88, 90.7, 93.8], IVB: [1.95, 6.2, 9.3, 13.2],
      IVB_acc: [15.7, 36.5, 54.5, 77.8], HB: [-6.1, -3.6, -0.8, 2.7],
      HB_acc: [-35.8, -20.8, -7.3, 9.9], HAVAA: [-0.9, -0.216, 0.41, 1.12],
      "SwStr%": [1, 6.3, 15, 25], "CSW%": [0, 100 / 6, 100 / 3, 50],
      xSLGcon: [0.115, 0.320, 0.62, 1.29], "plvStuff+": [92.2, 100.6, 111.9, 120],
      "PLV+": [73.5, 92.1, 109.6, 121.7],
    },
    SL: {
      Velo: [80.9, 84.6, 87.3, 90], IVB: [-4.2, -0.2, 3.6, 7.6],
      HB: [-11.9, -5.9, -2.8, 0], "SwStr%": [5, 11.1, 20, 32],
      "CSW%": [0, 20, 100 / 3, 50], xSLGcon: [0.105, 0.315, 0.6, 1.265],
      "plvStuff+": [99, 106.3, 117.3, 126.1], "PLV+": [75.2, 92.2, 109, 122],
    },
    ST: {
      Velo: [77.3, 80.8, 83.4, 86.2], IVB: [-5.4, -0.9, 3, 7.3],
      HB: [-19.1, -15.5, -12.2, -8.4], "SwStr%": [5, 10, 18.9, 31],
      "CSW%": [0, 20, 100 / 3, 50], xSLGcon: [0.08, 0.275, 0.575, 1.275],
      "plvStuff+": [94.4, 102.7, 116.2, 127.5], "PLV+": [72.5, 89.5, 106.9, 120.2],
    },
    CU: {
      Velo: [73.8, 78.2, 81.7, 85.8], IVB: [-16.6, -12.6, -7.4, -1.5],
      HB: [-16.3, -11.1, -6.2, -1.3], "SwStr%": [4, 9.1, 18.7, 31.2],
      "CSW%": [0, 100 / 6, 40, 200 / 3], xSLGcon: [0.105, 0.290, 0.585, 1.25],
      "plvStuff+": [85.2, 91.7, 102.8, 111.3], "PLV+": [68.1, 85.3, 102.8, 116.3],
    },
    CH: {
      Velo: [80.3, 84.8, 88.1, 91], IVB: [-1.5, 3.1, 7.4, 12.1],
      HB: [8.8, 13.2, 15.9, 18.3], "SwStr%": [5, 11.5, 21, 33.3],
      "CSW%": [0, 10, 30, 50], xSLGcon: [0.115, 0.285, 0.53, 1.085],
      "plvStuff+": [74.9, 87, 102, 112.4], "PLV+": [69.1, 87.2, 105.7, 118.7],
    },
    FS: {
      Velo: [82, 84.9, 88.1, 92.3], IVB: [-2, 1.5, 5.4, 10.3],
      HB: [4.3, 8.8, 12.7, 15.9], "SwStr%": [6, 11.6, 22.2, 35.2],
      "CSW%": [0, 10, 100 / 3, 50], xSLGcon: [0.12, 0.290, 0.56, 1.15],
      "plvStuff+": [84.9, 96.1, 111.7, 123.8], "PLV+": [70.4, 89.4, 107.8, 120.9],
    },
  };
  Object.values(TYPE_BINS).forEach((bins) => (bins.Ext = [5.75, 6.25, 6.66, 7.13]));
  // lower is better for expected slugging, so its colour scale runs the other way
  const INVERTED = new Set(["xSLGcon"]);

  // which right-closed bin a value falls in: bisect_left, 0 for <= cuts[0]
  function binIndex(value, cuts) {
    let i = 0;
    while (i < cuts.length && cuts[i] < value) i++;
    return i;
  }

  // Colour for a stat value on the benchmark scale of its pitch type, white if unknown;
  // `key` picks other cut points than the stat's own (the fastball panel colours movement
  // by its acceleration bins).
  //
  // `asFloat32` is for the fastball panel. Its velocity, extension, IVB and HAVAA columns
  // are float32 in the pipeline, and the Python compared them as numpy float32 scalars,
  // which numpy does in float32: the cut is rounded to float32 first. So a 1.2 that is
  // float32's 1.2000000476837158 sits at the cut of 1.2, not above it. A value that is a
  // float32 is compared that way here; anything else (a float64 column, or a dict built
  // from doubles) compares as doubles, as the table's cells always did.
  function statColor(pitchType, stat, value, key, asFloat32 = false) {
    let cuts = get(get(TYPE_BINS, pitchType, {}), key || stat);
    if (cuts === undefined || !isNum(value)) return WHITE;
    if (asFloat32 && Math.fround(value) === value) cuts = cuts.map(Math.fround);
    const idx = binIndex(value, cuts);
    return DIVERGE[INVERTED.has(stat) ? 4 - idx : idx];
  }

  // ---- display text -----------------------------------------------------------------
  const SUFFIX = { Ext: "'", IVB: '"', HB: '"', HAVAA: "°", "Str%": "%", "SwStr%": "%", "CSW%": "%" };
  const COLOURED = new Set(["Velo", "SwStr%", "CSW%", "xSLGcon", "PLV+", "plvStuff+"]);
  const WHOLE = new Set(["Str%", "SwStr%", "CSW%", "PLV+", "plvStuff+"]); // shown as integers
  const FASTBALL_PANEL = ["Velo", "Ext", "IVB", "HB", "HAVAA"];
  const VELO_DIFF_CUTS = [-2, -1, -0.5, 0.5, 1, 2];

  // display text and colour for one stat of one pitch type
  function cell(code, stat, value) {
    if (!isNum(value)) return { text: "-", color: WHITE };
    const color = COLOURED.has(stat) ? statColor(code, stat, value) : WHITE;
    if (stat === "xSLGcon") return { text: fixed(value, 3).replace(/^0+/, ""), color };
    const suffix = get(SUFFIX, stat, "");
    if (WHOLE.has(stat)) return { text: pyRound(value) + suffix, color };
    return { text: fixed(value, 1) + suffix, color };
  }

  // the primary fastball's shape, coloured against its pitch type's benchmarks
  function fastballStats(fb) {
    return FASTBALL_PANEL.map((stat) => {
      const key = stat === "IVB" || stat === "HB" ? `${stat}_acc` : stat;
      const v = fb.values[stat];
      const shown = isNum(v) ? fixed(v, 1) + get(SUFFIX, stat, "") : "-";
      return { label: stat, text: shown, color: statColor(fb.code, stat, fb.values[key], key, true) };
    });
  }

  // the change in velocity against a comparison season, or null when there is none
  function veloDiff(diff) {
    if (!isNum(diff)) return null;
    const s = fixed(diff, 1);
    const color = VELO_DIFF[2 * binIndex(diff, VELO_DIFF_CUTS)];
    return { text: ` (${s[0] === "-" ? s : "+" + s})`, color };
  }

  // ---- geometry ---------------------------------------------------------------------
  const W = 1500;
  const H = 2000;
  const PT = 100 / 72; // matplotlib points -> pixels at the figure's 100 dpi
  const LINE_ALPHA = 2 / 3;
  const MARKER_R = (Math.sqrt(300) * PT) / 2; // scatter s=300 (points squared) -> radius
  const ANCHOR = { left: "start", center: "middle", right: "end" };
  // baseline shift (em) that lands the first line where matplotlib's alignment would
  const SHIFT = { center: 0.28, bottom: -0.2, top: 0.72, baseline: 0.0 };
  const SPREAD = { center: 0.5, baseline: 1, bottom: 1 }; // how far extra lines push it up
  const LINE_HEIGHT = 1.2;
  const DASH = [3.7, 1.6]; // matplotlib's '--' pattern, in multiples of the line width

  const fx = (x) => x * W;
  const fy = (y) => (1 - y) * H;

  // A matplotlib-style axes: a rectangle in figure fractions plus data limits, mapping data
  // coordinates to page pixels. `equal` shrinks the box to the data's aspect ratio,
  // anchored bottom-left, as aspect=1 with the SW anchor does.
  class Axes {
    constructor(box, xlim, ylim, equal = false) {
      const [x0, y0, w, h] = box;
      let width = w * W;
      let height = h * H;
      const dx = xlim[1] - xlim[0];
      const dy = ylim[1] - ylim[0];
      if (equal) {
        const scale = Math.min(width / Math.abs(dx), height / Math.abs(dy));
        width = Math.abs(dx) * scale;
        height = Math.abs(dy) * scale;
      }
      this.left = fx(x0);
      this.bottom = fy(y0);
      this.width = width;
      this.height = height;
      this.xlim = xlim;
      this.ylim = ylim;
      this.sx = width / dx;
      this.sy = height / dy;
    }

    x(v) {
      return this.left + (v - this.xlim[0]) * this.sx;
    }

    y(v) {
      return this.bottom - (v - this.ylim[0]) * this.sy;
    }

    get top() {
      return this.bottom - this.height;
    }

    clip(name) {
      return (
        `<clipPath id="${name}"><rect x="${fmt(this.left)}" y="${fmt(this.top)}" ` +
        `width="${fmt(this.width)}" height="${fmt(this.height)}"/></clipPath>`
      );
    }

    // an SVG transform taking data coordinates to pixels (for paths in data units)
    transform() {
      return `translate(${fmt(this.x(0))},${fmt(this.y(0))}) scale(${fixed(this.sx, 4)},${fixed(-this.sy, 4)})`;
    }
  }

  // ---- primitives -------------------------------------------------------------------
  const opacityAttr = (alpha) => (alpha != null ? ` opacity="${fixed(alpha, 2)}"` : "");
  const dashAttr = (w) => ` stroke-dasharray="${fixed(DASH[0] * w, 1)} ${fixed(DASH[1] * w, 1)}"`;

  // a text element; `size` in points, alignment as matplotlib's ha / va
  function text(x, y, s, size, { color = WHITE, ha = "center", va = "center", alpha = null, attrs = "" } = {}) {
    const lines = String(s).split("\n");
    const shift = SHIFT[va] - (lines.length - 1) * LINE_HEIGHT * get(SPREAD, va, 0);
    const spans = lines
      .map((ln, i) => `<tspan x="${fmt(x)}" dy="${fixed(i === 0 ? shift : LINE_HEIGHT, 2)}em">${esc(ln)}</tspan>`)
      .join("");
    return (
      `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fixed(size * PT, 1)}" fill="${color}" ` +
      `text-anchor="${ANCHOR[ha]}"${opacityAttr(alpha)}${attrs}>${spans}</text>`
    );
  }

  function line(x1, y1, x2, y2, { color = WHITE, width = 1.5, alpha = null, dashed = false, attrs = "" } = {}) {
    const w = width * PT;
    return (
      `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" ` +
      `stroke="${color}" stroke-width="${fixed(w, 1)}" stroke-linecap="round"` +
      `${dashed ? dashAttr(w) : ""}${opacityAttr(alpha)}${attrs}/>`
    );
  }

  // one of the card's section rules, in figure fractions
  function border(x1, x2, y1, y2) {
    return line(fx(x1), fy(y1), fx(x2), fy(y2), { color: TEXT, width: 3, alpha: LINE_ALPHA });
  }

  function circle(cx, cy, r, { fill = "none", stroke = null, width = 1.0, alpha = null, dashed = false } = {}) {
    const w = width * PT;
    const strokeAttr = stroke ? ` stroke="${stroke}" stroke-width="${fixed(w, 1)}"` : "";
    return (
      `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${fill}"` +
      `${strokeAttr}${dashed ? dashAttr(w) : ""}${opacityAttr(alpha)}/>`
    );
  }

  function rect(x, y, w, h, { fill = "none", stroke = null, width = 1.0, alpha = null, rx = 0.0, ry = null } = {}) {
    const strokeAttr = stroke ? ` stroke="${stroke}" stroke-width="${fixed(width * PT, 1)}"` : "";
    const radius = rx ? ` rx="${fmt(rx)}" ry="${fmt(ry === null ? rx : ry)}"` : "";
    return (
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
      `fill="${fill}"${strokeAttr}${radius}${opacityAttr(alpha)}/>`
    );
  }

  // the pitches on a plot: one shared marker, placed per pitch and coloured per type
  function markers(ax, pitches, xkey, ykey) {
    return [...new Set(pitches.map((p) => p.t))].map((code) => {
      const uses = pitches
        .filter((p) => p.t === code)
        .map((p) => `<use href="#m" x="${fmt(ax.x(p[xkey]))}" y="${fmt(ax.y(p[ykey]))}"/>`)
        .join("");
      return `<g fill="${get(MARKER_COLORS, code, MARKER_COLORS.UN)}">${uses}</g>`;
    });
  }

  // ---- the header -------------------------------------------------------------------
  const BORDERS = [
    [0.01, 0.11, 0.815, 0.815], [0.205, 0.315, 0.815, 0.815], [0.01, 0.01, 0.715, 0.813],
    [0.305, 0.305, 0.715, 0.813], [0.01, 0.4325, 0.713, 0.713], [0.01, 0.01, 0.59, 0.688],
    [0.435, 0.435, 0.59, 0.813], [0.7725, 0.99, 0.815, 0.815], [0.425, 0.6525, 0.815, 0.815],
    [0.99, 0.99, 0.59, 0.813], [0.01, 0.99, 0.588, 0.588], [0.01, 0.12, 0.565, 0.565],
    [0.325, 0.505, 0.565, 0.565], [0.6425, 0.7825, 0.565, 0.565], [0.92, 0.99, 0.565, 0.565],
    [0.435, 0.435, 0.28, 0.563], [0.7125, 0.7125, 0.28, 0.563], [0.01, 0.01, 0.28, 0.563],
    [0.99, 0.99, 0.28, 0.563], [0.01, 0.99, 0.278, 0.278], [0.01, 0.35, 0.255, 0.255],
    [0.65, 0.99, 0.255, 0.255], [0.01, 0.01, 0.017, 0.253], [0.99, 0.99, 0.017, 0.253],
    [0.01, 0.99, 0.015, 0.015],
  ];

  // the Pitcher List mark; absolute, as the card is drawn into pages on other origins
  const LOGO = "https://blandalytics.com/pitcher-cards/PitcherList_Stats_watermark_with_logo.webp";
  const LOGO_ASPECT = 928 / 178;

  // the mark, filling the width of the original's logo axes and sitting on its bottom
  // edge as the image did
  function logo(href) {
    const w = fx(0.29);
    const h = w / LOGO_ASPECT;
    return (
      `<image x="${fmt(fx(0.69))}" y="${fmt(fy(0.93) - h)}" width="${fmt(w)}" ` +
      `height="${fmt(h)}" href="${esc(href)}"/>`
    );
  }

  // name, bio line, the game and its box-score line, and the Pitcher List mark
  function header(card, logoHref) {
    const size = Math.min(150.0, 1230 / [...card.name].length); // the original sized the name by length
    return [
      `<text x="45" y="130.8" font-size="${fixed(size, 1)}" fill="url(#name)">${esc(card.name)}</text>`,
      text(57, fy(0.91), card.bio, 20, { color: LINE, ha: "left" }),
      text(fx(0.5), fy(0.896), card.title, 24),
      rect(fx(0.01), fy(0.883), fx(0.98), 86, { fill: BACKGROUND, stroke: TEXT, width: 3, alpha: LINE_ALPHA, rx: 15 }),
      text(fx(0.5), fy(0.8425 + 0.037 / 2), card.line, 30, { color: LINE_TEXT }),
      logo(logoHref),
    ];
  }

  // the Skills (model) and Results (box score) grades
  function skills(card) {
    const ax = new Axes([0.01, 0.705, 0.295, 0.1], [0, 1], [0, 1]);
    const sg = new Axes([0.305, 0.705, 0.13, 0.1], [0, 1], [0, 1]);
    const g = card.grades;
    const out = [text(fx(0.1575), fy(0.815), "Skills", 30), text(fx(0.37), fy(0.815), "Results", 25)];
    for (const [x, label, key, size] of [[0.175, "Stuff", "stuff", 22], [0.5, "Locations", "loc", 20], [0.825, "PLV", "plv", 22]]) {
      out.push(text(ax.x(x), ax.y(0.8), label, size, { color: LINE }));
      out.push(text(ax.x(x), ax.y(0.4), g[key], 60, { color: GRADE_COLORS[g[key]] }));
    }
    out.push(text(sg.x(0.5), sg.y(0.8), card.label, 20, { color: LINE }));
    out.push(text(sg.x(0.5), sg.y(0.4), g.game, 60, { color: GRADE_COLORS[g.game] }));
    return out;
  }

  // the primary fastball and its shape, coloured against its type's benchmarks
  function fastball(card) {
    const fb = card.fastball;
    const name = fb ? PITCH_NAMES[fb.code] : "None";
    const color = fb ? MARKER_COLORS[fb.code] : MARKER_COLORS.UN;
    // the rule around the label leaves a gap sized to the fastball's name
    const [lx, nx, l1, l2] = name === "Four-Seam" ? [0.06, 0.25, 0.04, 0.41] : [0.093, 0.283, 0.073, 0.375];
    const out = [
      text(fx(lx), fy(0.69), "Primary Fastball:", 24, { ha: "left" }),
      text(fx(nx), fy(0.69), name, 28, { color, ha: "left" }),
      border(0.01, l1, 0.69, 0.69),
      border(l2, 0.4325, 0.69, 0.69),
    ];
    const ax = new Axes([0.01, 0.6, 0.425, 0.082], [-0.75, 4.75], [0, 1]);
    (fb ? fastballStats(fb) : []).forEach((stat, i) => {
      out.push(text(ax.x(i), ax.y(0.3), stat.text, 30, { color: stat.color }));
      out.push(text(ax.x(i), ax.y(0.55), stat.label, 24, { color: LINE, va: "bottom" }));
    });
    return out;
  }

  // ---- usage ------------------------------------------------------------------------
  function pct(v) {
    if (v == null) return "-";
    return v > 0.5 || v === 0 ? `${fixed(v, 0)}%` : "< 1%";
  }

  // One usage arrow per comparison season, as tspans shown one at a time. `shift` centres
  // them, for the element that has no label to carry the shift. Every arrow gets it rather
  // than just the first: one is displayed at a time, so it has to be on whichever that
  // turns out to be.
  function arrowSpans(card, code, key, shift = false) {
    const dy = shift ? ` dy="${SHIFT.center}em"` : "";
    return card.comparisons
      .map((c) => `<tspan data-cmp="${c.year}"${dy}>${esc(get(get(c.types, code, {}), key, ""))}</tspan>`)
      .join("");
  }

  // a usage share with its arrows trailing it, as the original annotated them
  function share(x, y, label, color, ha, spans) {
    // an empty leading tspan carries no glyphs, so its dy is never applied; the arrows
    // bring their own shift in that case
    const lead = label ? `<tspan dy="${SHIFT.center}em">${esc(label)}</tspan>` : "";
    return (
      `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fixed(20 * PT, 1)}" fill="${color}" ` +
      `text-anchor="${ANCHOR[ha]}">${lead}${spans}</text>`
    );
  }

  // Shapes cut to a vertical band. Painting over them instead would leave a hairline where
  // the two edges meet, which shows as a band once the card is scaled.
  function clipped(name, x, width, marks) {
    return (
      `<clipPath id="${name}"><rect x="${fmt(x)}" y="0" width="${fmt(width)}" ` +
      `height="${H}"/></clipPath><g clip-path="url(#${name})">${marks.join("")}</g>`
    );
  }

  // One side's usage bars, each running from the centre outward so the clip can cut it at
  // the gap's edge. A side the pitcher never faced gets no bar: a zero-width one would have
  // its own edge on the clip's, which is what leaves a hairline.
  function bars(ax, types, shares, fw, sign) {
    const rx = 2.5 * ax.sx;
    const ry = 0.25 * -ax.sy;
    const out = [];
    types.forEach((t, i) => {
      if (!shares[i]) return;
      const width = (shares[i] + fw) * ax.sx;
      const x = sign > 0 ? ax.x(0) : ax.x(0) - width;
      out.push(rect(x, ax.y(i - 0.4), width, 0.8 * -ax.sy, { fill: get(MARKER_COLORS, t.code, "#c7c7c7"), rx, ry }));
    });
    return out;
  }

  // Pitch mix against each side of the plate: bars out from the middle, the type and its
  // overall usage in the gap, arrows against the comparison season.
  function usage(card) {
    const types = card.types;
    const compared = card.comparisons.length > 0;
    const n = types.length;
    const vsR = types.map((t) => t.vsR || 0);
    const vsL = types.map((t) => t.vsL || 0);
    const barLim = (Math.max(...vsR, ...vsL) * 4) / 3;
    const fw = barLim / 3;
    const lo = -(Math.max(...vsL) + fw);
    const hi = Math.max(...vsR) + fw;
    const xl = ((Math.max(-lo, hi) + 0.05 * (hi - lo)) * 4) / 3;
    const ax = new Axes([0.445, 0.598, 0.535, 0.19], [-xl, xl], [n - 0.5, -0.5]);
    const out = [
      text(fx(0.7125), fy(0.815), "Usage", 30),
      text(fx(0.6525), fy(0.798), `vs LHB (${card.n_vl})`, 20, { color: LINE, ha: "right" }),
      text(fx(0.7725), fy(0.798), `vs RHB (${card.n_vr})`, 20, { color: LINE, ha: "left" }),
    ];
    types.forEach((t, i) => {
      const color = get(MARKER_COLORS, t.code, "#c7c7c7");
      const size = n > 1 ? (Math.min(t.usage || 0, 33) / 33) * 12 + 16 : 25;
      out.push(text(ax.x(0), ax.y(i + 0.05), `${t.code} ${fixed(t.usage, 0)}%`, size, { color }));
      const xr = ax.x(vsR[i] + barLim / 2.75);
      out.push(share(xr, ax.y(i), pct(t.vsR), color, "left", arrowSpans(card, t.code, "vsR_arrow")));
      // the left share is right-aligned, so its arrows sit in their own element after it
      const xli = ax.x(-(vsL[i] + barLim / (compared ? 2.2 : 2.5)));
      out.push(share(xli, ax.y(i), pct(t.vsL), color, "right", ""));
      out.push(share(xli, ax.y(i), "", color, "left", arrowSpans(card, t.code, "vsL_arrow", true)));
    });
    // the bars go under the labels, which sit in the gap, and are clipped to their own side
    // of it rather than having the gap painted over them
    out.splice(
      3,
      0,
      clipped("ubr", ax.x(fw), W - ax.x(fw), bars(ax, types, vsR, fw, 1)),
      clipped("ubl", 0, ax.x(-fw), bars(ax, types, vsL, fw, -1)),
    );
    for (const c of card.comparisons) {
      const note = `Arrows are vs\n${c.year} Usage`;
      out.push(text(fx(0.98), fy(0.595), note, 12, { ha: "right", va: "baseline", alpha: 0.5, attrs: ` data-cmp="${c.year}"` }));
    }
    return out;
  }

  // ---- movement ---------------------------------------------------------------------
  // concentric inch rings: dashed minor rings on the sixes, solid major on the twelves
  function rings(ax, lim) {
    const out = [];
    for (let k = 1; k <= Math.trunc((lim + 6) / 12); k++) {
      out.push(circle(ax.x(0), ax.y(0), (12 * k - 6) * ax.sx, { stroke: WHITE, width: 2, alpha: 0.1, dashed: true }));
    }
    for (let k = 1; k <= Math.trunc(lim / 12); k++) {
      out.push(circle(ax.x(0), ax.y(0), 12 * k * ax.sx, { stroke: WHITE, width: 2, alpha: 0.5 }));
    }
    return out;
  }

  // each major ring's radius, on both axes
  function ringLabels(ax, lim) {
    const out = [];
    for (let k = 1; k <= Math.trunc(lim / 12); k++) {
      const d = 12 * k;
      const label = `${d}"`;
      const yLabel = d - 0.25 - 0.25 * Math.trunc((lim + 6) / 12);
      const spots = [[d - 0.25, -0.5, "right", "top"], [-d + 0.5, -0.5, "left", "top"],
        [0.5, yLabel, "left", "top"], [0.5, -d + 0.75, "left", "bottom"]];
      for (const [x, y, ha, va] of spots) {
        out.push(text(ax.x(x), ax.y(y), label, 14, { color: WHITE, ha, va, alpha: 0.75 }));
      }
    }
    return out;
  }

  // where the arm-angle ray ends, in data units, or null without an arm angle
  function armRay(card, lim) {
    if (card.arm_angle == null) return null;
    const a = card.arm_angle * (Math.PI / 180); // math.radians
    const sign = card.hand === "R" ? 1 : -1;
    return [Math.cos(a) * sign * lim, Math.sin(a) * lim];
  }

  // the arm-angle ray, stopping short of its label, mirrored faintly through the origin
  function armLines(ax, card, lim) {
    const end = armRay(card, lim);
    if (end === null) return [];
    const [xv, yv] = end;
    const short = 4 / lim; // leave room for the label at the tip
    return [
      line(ax.x(0), ax.y(0), ax.x(xv * (1 - short)), ax.y(yv * (1 - short)), { color: WHITE, width: 1.5, dashed: true }),
      line(ax.x(0), ax.y(0), ax.x(-xv), ax.y(-yv), { color: WHITE, width: 1.5, alpha: 0.1, dashed: true }),
    ];
  }

  function armLabel(ax, card, lim) {
    const end = armRay(card, lim);
    if (end === null) return [];
    const label = `${fixed(card.arm_angle, 0)}°`;
    const size = 16 * PT;
    const w = (0.6 * [...label].length + 0.7) * size;
    const h = 1.5 * size;
    return [
      rect(ax.x(end[0]) - w / 2, ax.y(end[1]) - h / 2, w, h, { fill: BACKGROUND, stroke: WHITE, width: 1, alpha: 0.75, rx: 6 }),
      text(ax.x(end[0]), ax.y(end[1]), label, 16),
    ];
  }

  // The comparison seasons' movement regions, one group per season. The opacity is on each
  // path, not the group: seaborn draws a type at a time, so where two types overlap the
  // colours composite and darken. Group opacity would flatten the types together first and
  // composite once, hiding whatever the last type covers.
  function shapes(ax, card) {
    return card.comparisons.map((c) => {
      const paths = Object.entries(c.shapes)
        .flatMap(([code, ds]) => ds.map((d) => `<path d="${d}" fill="${get(MARKER_COLORS, code, "#c7c7c7")}" fill-opacity="0.25"/>`))
        .join("");
      return `<g data-cmp="${c.year}" transform="${ax.transform()}">${paths}</g>`;
    });
  }

  // Horizontal against induced vertical break, with the comparison season's regions. Marks
  // are clipped to the plot as matplotlib clips them; text is not, as it does not.
  function movement(card) {
    const lim = card.chart_lim;
    const ax = new Axes([0.03, 0.275, 0.423, 0.287], [-lim - 2, lim + 2], [-lim - 2, lim + 2], true);
    let [right, left] = ["Arm\nSide", "Glove\nSide"];
    if (card.hand === "L") [right, left] = [left, right];
    const marks = [
      line(ax.x(0), ax.y(-(lim - 4)), ax.x(0), ax.y(lim - 4), { color: WHITE, width: 2, alpha: 0.5 }),
      line(ax.x(-(lim - 4)), ax.y(0), ax.x(lim - 4), ax.y(0), { color: WHITE, width: 2, alpha: 0.5 }),
      ...rings(ax, lim),
      ...shapes(ax, card),
      ...markers(ax, card.pitches.filter((p) => p.hb != null), "hb", "ivb"),
      ...armLines(ax, card, lim),
    ];
    const labels = [
      ...ringLabels(ax, lim),
      text(ax.x(lim), ax.y(0), right, 16),
      text(ax.x(-lim), ax.y(0), left, 16),
      text(ax.x(0), ax.y(lim - 2), "Rise", 16),
      text(ax.x(0), ax.y(-(lim - 2)), "Drop", 16),
      ...armLabel(ax, card, lim),
    ];
    const notes = card.comparisons.map((c) =>
      text(fx(0.02), fy(0.285), `Shaded Regions are\n${c.year} Shapes translated\nto current Velo`, 12,
        { ha: "left", va: "baseline", alpha: 0.5, attrs: ` data-cmp="${c.year}"` }));
    const title = text(fx(0.2225), fy(0.565), "Movement", 30);
    return [title, ax.clip("mv"), '<g clip-path="url(#mv)">', ...marks, "</g>", ...labels, ...notes];
  }

  // ---- locations --------------------------------------------------------------------
  const SZ_BOT = 19.5 / 12;
  const SZ_TOP = 40.5 / 12;
  const PLATE_Y = -0.25;
  const PLATE = [ // the five edges of home plate, in feet
    [-8.5 / 12, PLATE_Y, 8.5 / 12, PLATE_Y],
    [-8.5 / 12, PLATE_Y, -8.25 / 12, PLATE_Y + 0.15],
    [8.5 / 12, PLATE_Y, 8.25 / 12, PLATE_Y + 0.15],
    [8.28 / 12, PLATE_Y + 0.15, 0, PLATE_Y + 0.25],
    [-8.28 / 12, PLATE_Y + 0.15, 0, PLATE_Y + 0.25],
  ];

  // the strike zone in thirds, each line shadowed in the background colour, and the plate
  function zone(ax) {
    const third = (SZ_TOP - SZ_BOT) / 3;
    const out = [];
    for (const [color, width, hx, dy] of [[BACKGROUND, 3.5, 8 / 12, 0.05], [WHITE, 2, 8.5 / 12, 0.025]]) {
      const vw = color === BACKGROUND ? width : 3;
      for (const k of [1, 2]) {
        const y = ax.y(SZ_BOT + k * third);
        out.push(line(ax.x(-hx), y, ax.x(hx), y, { color, width, alpha: 0.5 }));
      }
      for (const x of [8.5 / 36, -8.5 / 36]) {
        out.push(line(ax.x(x), ax.y(SZ_BOT + dy), ax.x(x), ax.y(SZ_TOP - dy), { color, width: vw, alpha: 0.5 }));
      }
    }
    const w = (17 / 12) * ax.sx;
    const h = (21 / 12) * ax.sy;
    out.push(rect(ax.x(-8.5 / 12), ax.y(SZ_TOP), w, h, { stroke: BACKGROUND, width: 3, alpha: 0.5 }));
    out.push(rect(ax.x(-8.5 / 12), ax.y(SZ_TOP), w, h, { stroke: WHITE, width: 2, alpha: 0.5 }));
    for (const [x1, y1, x2, y2] of PLATE) out.push(line(ax.x(x1), ax.y(y1), ax.x(x2), ax.y(y2), { color: WHITE, width: 2 }));
    return out;
  }

  // pitch locations against one side of the plate, on the standardised zone
  function location(card, stand, x0, gradeX0, grade, count) {
    const ax = new Axes([x0, 0.275, 0.2675, 0.287], [-2, 2], [-0.5, 5.5], true);
    const name = `loc${stand}`;
    const out = [ax.clip(name), `<g clip-path="url(#${name})">`, ...zone(ax)];
    const shown = card.pitches.filter((p) => p.stand === stand && p.x != null);
    out.push(...markers(ax, shown, "x", "z"), "</g>");
    if (count) {
      const g = new Axes([gradeX0, 0.48, 0.1, 0.1], [0, 1], [0, 1]);
      out.push(text(g.x(0.5), g.y(0.7), "Locations", 15, { color: LINE }));
      out.push(text(g.x(0.5), g.y(0.45), grade, 50, { color: GRADE_COLORS[grade] }));
    }
    return out;
  }

  function locations(card) {
    const g = card.grades;
    return [
      text(fx(0.57375), fy(0.565), "vs LHB", 30),
      text(fx(0.85125), fy(0.565), "vs RHB", 30),
      ...location(card, "L", 0.445, 0.435, g.loc_vl, card.n_vl),
      ...location(card, "R", 0.7225, 0.7125, g.loc_vr, card.n_vr),
    ];
  }

  // ---- the metrics table ------------------------------------------------------------
  const HEADERS = [
    [0.085, "Type"], [0.235, "#"], [0.42, "IVB"], [0.49, "HB"], [0.57, "Str%"], [0.645, "SwStr%"],
    [0.7225, "CSW%"], [0.8025, "xSLGcon"], [0.8825, "plvStuff+"], [0.955, "PLV+"],
  ];
  // the Velo column's centre in table coordinates: midway between the # and IVB columns
  const VELO_X = 0.15;
  const WIDTHS = [["Velo", 0], ["IVB", 0.9], ["HB", 0.65], ["Str%", 0.75], ["SwStr%", 0.75],
    ["CSW%", 0.75], ["xSLGcon", 0.75], ["plvStuff+", 0.75], ["PLV+", 0.7]];

  // The velocity cell: coloured on its own, white with the coloured change beside it when
  // a comparison season is showing.
  function veloCell(card, t, ax, x, y) {
    const c0 = cell(t.code, "Velo", t.values.Velo);
    const out = [text(ax.x(x), y, c0.text, 20, { color: c0.color, attrs: ' data-cmp="0"' })];
    for (const c of card.comparisons) {
      const diff = veloDiff(get(get(c.types, t.code, {}), "velo_diff", null));
      const span = diff ? `<tspan font-size="${fixed(16 * PT, 1)}" fill="${diff.color}">${esc(diff.text)}</tspan>` : "";
      out.push(
        `<text x="${fmt(ax.x(x))}" y="${fmt(y)}" font-size="${fixed(20 * PT, 1)}" ` +
        `fill="${WHITE}" text-anchor="middle" data-cmp="${c.year}">` +
        `<tspan dy="${SHIFT.center}em">${esc(c0.text)}</tspan>${span}</text>`,
      );
    }
    return out;
  }

  // one row per pitch type: the colour swatch, name and count, then the stats
  function metrics(card) {
    const types = card.types;
    const n = types.length;
    const out = [text(fx(0.5), fy(0.255), "Pitch Type Metrics", 30)];
    if (card.missing_data) {
      out.push(text(fx(0.632), fy(0.2575), "*", 18, { alpha: 0.5 }));
      out.push(text(fx(0.97), fy(0.005), "*Some pitches missing data", 12, { ha: "right", alpha: 0.5 }));
    }
    out.push(...HEADERS.map(([x, label]) => text(fx(x), fy(0.23), label, 16, { color: LINE })));
    const hdr = new Axes([0.01, 0.015, 0.25, 0.205], [0, 1], [n - 0.5, -0.5]);
    const tbl = new Axes([0.26, 0.015, 0.73, 0.205], [-0.5, 6.5], [n - 0.5, -0.5]);
    const veloX = tbl.x(VELO_X); // the header sits over its own values, not beside them
    out.push(text(veloX, fy(0.23), "Velo", 16, { color: LINE, attrs: ' data-cmp="0"' }));
    for (const c of card.comparisons) {
      out.push(text(veloX, fy(0.23), `Velo (vs '${String(c.year).slice(-2)})`, 16, { color: LINE, attrs: ` data-cmp="${c.year}"` }));
    }
    const bw = Math.max(0.5, Math.min(0.8, 2 / n));
    types.forEach((t, i) => {
      const color = get(MARKER_COLORS, t.code, "#c7c7c7");
      const y = hdr.y(i);
      out.push(rect(hdr.x(0.1), hdr.y(i - bw / 2), 0.075 * hdr.sx, bw * -hdr.sy, { fill: color, rx: 4 }));
      out.push(text(hdr.x(0.225), y, get(PITCH_NAMES, t.code, t.code), 20, { color, ha: "left" }));
      out.push(text(hdr.x(0.9), y, thousands(t.n), 20));
      let x = VELO_X;
      for (const [stat, width] of WIDTHS) {
        x += width;
        if (stat === "Velo") {
          out.push(...veloCell(card, t, tbl, x, y));
        } else {
          const c = cell(t.code, stat, t.values[stat]);
          out.push(text(tbl.x(x), y, c.text, 20, { color: c.color }));
        }
      }
    });
    return out;
  }

  // ---- the card ---------------------------------------------------------------------
  // the whole card as one SVG; opts.logo is the Pitcher List mark's URL
  function svg(card, opts = {}) {
    if (card.version !== VERSION) {
      throw new Error(`card.js draws card dict version ${VERSION}, not ${card.version}`);
    }
    const body = [
      rect(0, 0, W, H, { fill: BACKGROUND }),
      ...header(card, opts.logo || LOGO),
      ...skills(card),
      ...fastball(card),
      ...usage(card),
      ...movement(card),
      ...locations(card),
      ...metrics(card),
      ...BORDERS.map((b) => border(...b)),
    ];
    return (
      `<svg id="card" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
      'role="img" aria-label="PLV pitcher game card">' +
      "<style>text{font-family:'DM Sans',system-ui,sans-serif;font-weight:700}</style>" +
      '<defs><linearGradient id="name" x1="0" y1="1" x2="0" y2="0">' +
      `<stop offset="0" stop-color="${NAME_GRADIENT[0]}"/>` +
      `<stop offset="1" stop-color="${NAME_GRADIENT[1]}"/></linearGradient>` +
      `<circle id="m" r="${fmt(MARKER_R)}" stroke="${BACKGROUND}" stroke-width="${fixed(0.5 * PT, 1)}"/>` +
      "</defs>" + body.join("") + "</svg>"
    );
  }

  // ---- on a page --------------------------------------------------------------------
  // the card drawn into `el` (replacing what was there); returns its <svg>
  function draw(el, card, opts) {
    el.innerHTML = svg(card, opts);
    return el.querySelector("svg");
  }

  // `year` if the card has that comparison season (0 asks for none), else its most recent
  // (or none, without one); null or undefined asks for the default
  function comparisonYear(card, year) {
    const years = card.comparisons.map((c) => c.year);
    const y = year == null ? years[0] || 0 : +year;
    return y && years.indexOf(y) < 0 ? years[0] || 0 : y;
  }

  // show one comparison season's layers under `el` and hide the rest; 0 for none
  function show(el, year) {
    const y = String(year || 0);
    el.querySelectorAll("[data-cmp]").forEach((node) => {
      node.style.display = node.getAttribute("data-cmp") === y ? "" : "none";
    });
  }

  const FONT = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@700&display=swap";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function b64(buf) {
    let s = "";
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // the font's stylesheet with the font files inlined: an SVG drawn to a canvas loads nothing
  function fontCss() {
    return fetch(FONT)
      .then((r) => r.text())
      .then((css) => {
        const urls = css.match(/url\([^)]+\)/g) || [];
        return Promise.all(urls.map((u) => fetch(u.slice(4, -1).replace(/["']/g, ""))
          .then((r) => r.arrayBuffer())
          .then((buf) => { css = css.replace(u, `url(data:font/woff2;base64,${b64(buf)})`); })))
          .then(() => css);
      })
      .catch(() => "");
  }

  // an SVG drawn to a canvas cannot load external images either, so embed the logo too
  function inlineImages(el) {
    return Promise.all([].map.call(el.querySelectorAll("image"), (im) =>
      fetch(im.getAttribute("href"))
        .then((r) => r.blob())
        .then((blob) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => { im.setAttribute("href", reader.result); resolve(); };
          reader.readAsDataURL(blob);
        }))
        .catch(() => im.remove())));
  }

  // the card's <svg> as a PNG blob at 3000 x 4000, with the layer that is showing
  function png(svgEl) {
    const clone = svgEl.cloneNode(true);
    clone.querySelectorAll("[data-cmp]").forEach((node) => {
      if (node.style.display === "none") node.remove();
    });
    return Promise.all([fontCss(), inlineImages(clone)]).then(([css]) => {
      const style = document.createElementNS(SVG_NS, "style");
      style.textContent = css + " text{font-family:'DM Sans',sans-serif;font-weight:700}";
      clone.insertBefore(style, clone.firstChild);
      clone.setAttribute("width", "1500");
      clone.setAttribute("height", "2000");
      const xml = new XMLSerializer().serializeToString(clone);
      const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = 3000;
          c.height = 4000;
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no PNG"))), "image/png");
        };
        img.onerror = reject;
        img.src = url;
      });
    });
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // The card onto the clipboard, else downloaded; resolves with what to report. Call it
  // inside the click: clipboard.write is handed a promise rather than a blob, and started
  // straight away, because rendering at 3000x4000 outlives the click's user activation and
  // a write begun after that has lapsed is refused.
  function copyPng(svgEl, name) {
    const blob = png(svgEl);
    const saved = () => blob.then((b) => download(b, name)).then(() => "Saved PNG");
    const clip = typeof navigator !== "undefined" && navigator.clipboard;
    if (typeof ClipboardItem === "undefined" || !clip || !clip.write) return saved();
    return clip.write([new ClipboardItem({ "image/png": blob })]).then(() => "Copied", saved);
  }

  // what the PNG is saved as: Name_Surname_2026-09-27_LAA_SEA_PLV_card.png
  function filename(card) {
    return `${card.name.replace(/ /g, "_")}_${card.date}_${card.team}_${card.opp}_PLV_card.png`;
  }

  return { VERSION, LOGO, svg, draw, show, comparisonYear, png, download, copyPng, filename, fixed, pyRound };
});
