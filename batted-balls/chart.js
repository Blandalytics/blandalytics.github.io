// The batted-ball chart: a hitter's density of spray angle against launch angle
// minus the league's (or their own prior season's), drawn on a canvas. A port of
// the figure in PLV_viz/hitter_app/pages/batted_ball_charts.py -- the same grid,
// the same scipy density, the same vlag contour bands, the same layout -- so the
// PNG matches what the Streamlit app draws in its discrete colour scale. Laid out in the pixels
// of the 200 dpi image the app serves (1390 x 1135) and rasterised at 2x.

(() => {
  "use strict";

  // ---- the grid: spray 0..90 by launch angle -30..60, 91 points each way ------
  const N = 91;
  const SPRAY = [0, 90];
  const LAUNCH = [-30, 60];

  // scipy.stats.gaussian_kde on the grid, scaled to sum to 100: Scott's factor
  // n^(-1/6) on the sample covariance (ddof 1), the full bivariate kernel. Only the
  // shape matters after scaling, so the normalising constant is dropped. Row-major
  // by spray then launch angle, as np.mgrid lays it out.
  function kdeGrid(points) {
    const n = points.length;
    if (n < 3) return null;
    let mx = 0, my = 0;
    for (const [x, y] of points) { mx += x; my += y; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of points) {
      const dx = x - mx, dy = y - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const f2 = n ** (-1 / 3);  // factor squared
    sxx *= f2 / (n - 1); sxy *= f2 / (n - 1); syy *= f2 / (n - 1);
    const det = sxx * syy - sxy * sxy;
    if (!(det > 1e-12)) return null;  // every ball in a line: no density to draw
    const a = syy / det, b = -sxy / det, c = sxx / det;  // the inverse covariance
    const xs = new Float64Array(n), ys = new Float64Array(n);
    points.forEach(([x, y], i) => { xs[i] = x; ys[i] = y; });
    const out = new Float64Array(N * N);
    let total = 0;
    for (let ix = 0; ix < N; ix++) {
      const gx = SPRAY[0] + ix * (SPRAY[1] - SPRAY[0]) / (N - 1);
      for (let iy = 0; iy < N; iy++) {
        const gy = LAUNCH[0] + iy * (LAUNCH[1] - LAUNCH[0]) / (N - 1);
        let s = 0;
        for (let i = 0; i < n; i++) {
          const dx = gx - xs[i], dy = gy - ys[i];
          s += Math.exp(-0.5 * (a * dx * dx + 2 * b * dx * dy + c * dy * dy));
        }
        out[ix * N + iy] = s;
        total += s;
      }
    }
    const k = 100 / total;
    for (let i = 0; i < out.length; i++) out[i] *= k;
    return out;
  }

  const inRange = ([x, y]) => x >= SPRAY[0] && x <= SPRAY[1] && y >= LAUNCH[0] && y <= LAUNCH[1];
  const clamp = ([x, y]) => [Math.min(Math.max(x, SPRAY[0]), SPRAY[1]), Math.min(Math.max(y, LAUNCH[0]), LAUNCH[1])];

  // The app's bucket shares: pull / centre / oppo by spray, ground ball / line
  // drive / fly ball / pop up by launch angle, over every batted ball (in range
  // or not). The centre bucket is closed on both ends, as pandas' between is.
  const SPRAY_BUCKETS = [(x) => x < 30, (x) => x >= 30 && x <= 60, (x) => x > 60];
  const LAUNCH_BUCKETS = [(y) => y < 10, (y) => y >= 10 && y < 25, (y) => y >= 25 && y <= 50, (y) => y > 50];

  function shares(points) {
    const n = points.length || 1;
    const spray = SPRAY_BUCKETS.map((f) => points.filter(([x]) => f(x)).length / n);
    const launch = LAUNCH_BUCKETS.map((f) => points.filter(([, y]) => f(y)).length / n);
    const cells = SPRAY_BUCKETS.map((f) => LAUNCH_BUCKETS.map((g) => points.filter(([x, y]) => f(x) && g(y)).length / n));
    return { spray, launch, cells };
  }

  // What one chart needs: the difference grid and the shares to print.
  //   hitter:  the batted balls this season (in the app's spray_deg convention)
  //   against: null for the league (whose grid is passed as `league`), or the
  //            prior season's batted balls for the self comparison
  function compute({ hitter, league, prior }) {
    if (prior) {
      // Against a prior season the app clips both seasons to the grid rather
      // than dropping the balls outside it.
      const now = kdeGrid(hitter.map(clamp)), before = kdeGrid(prior.map(clamp));
      if (!now || !before) return null;
      const diff = new Float64Array(N * N);
      for (let i = 0; i < diff.length; i++) diff[i] = now[i] - before[i];
      const a = shares(hitter), b = shares(prior);
      return {
        diff,
        shares: {
          spray: a.spray.map((v, i) => v - b.spray[i]),
          launch: a.launch.map((v, i) => v - b.launch[i]),
          cells: a.cells.map((col, i) => col.map((v, j) => v - b.cells[i][j])),
        },
      };
    }
    const now = kdeGrid(hitter.filter(inRange));
    if (!now) return null;
    const diff = new Float64Array(N * N);
    for (let i = 0; i < diff.length; i++) diff[i] = now[i] - league[i];
    return { diff, shares: shares(hitter) };
  }

  // ---- colours ------------------------------------------------------------------
  const BACKGROUND = "#292C42";
  const WHITE = "#FEFEFE";
  // contourf(levels -12..10 by 2, cmap vlag, extend both): the under colour, the
  // eleven bands, the over colour
  const LEVELS = [-12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
  const BANDS = ["#2369bd", "#3f75bc", "#6a8dbf", "#92a7c8", "#b7c2d5", "#dcdee6", "#faf5f4",
    "#eed7d5", "#deb2b0", "#d08f8d", "#c16c6a", "#b1494a", "#a9373b"];
  // the discrete colourbar: BoundaryNorm over 13 steps of vlag
  const STEPS = ["#2369bd", "#5380bc", "#7896c1", "#9aadca", "#bdc6d7", "#dfe1e8", "#faf5f5",
    "#f0dbda", "#e1b9b6", "#d49896", "#c77977", "#b95a59", "#a9373b"];
  // sns.color_palette("vlag", 25)[0] and [-1]: the Less / More Often labels
  const LABEL_BLUE = "#3b73bc", LABEL_RED = "#af4647";
  // ---- layout, in the pixels of the app's 1390 x 1135 image ---------------------
  const W = 1390, H = 1135;
  const AX = { left: 286, top: 108.5, size: 900 };  // 10 px per degree
  const CB = { left: 1208, top: 233, width: 163, height: 652 };
  const PX_PER_PT = 200 / 72;
  const FONT = '"Alexandria", "DM Sans", "Segoe UI", sans-serif';
  const LINE_SPACING = 1.2;  // matplotlib's multi-line spacing

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
    try {
      await Promise.all([document.fonts.load(`400 40px ${FONT}`), document.fonts.load(`500 40px ${FONT}`)]);
    } catch { /* the fallback face draws instead */ }
  }

  // Draw the chart onto `canvas`.
  //   result:   from compute()
  //   opts:     { title, subtitle, hand: "L"|"R",
  //               signed: bool (print shares as +/- differences), wordmark }
  function draw(canvas, result, opts) {
    const scale = 2;
    canvas.width = W * scale; canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);

    const flip = opts.hand === "L";  // the pull side stays on the left for right-handers, right for lefties
    const px = (spray) => AX.left + (flip ? 90 - spray : spray) * 10;
    const py = (launch) => AX.top + (60 - launch) * 10;
    const pt = (size) => size * PX_PER_PT;

    const setFont = (size, weight = 400) => { ctx.font = `${weight} ${pt(size)}px ${FONT}`; };
    // matplotlib's vertical alignment: the line box spans the font's ascent and
    // descent (it measures "lp"), and va="center" centres that box
    const lineBox = () => { const m = ctx.measureText("lp"); return { asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent }; };
    function text(s, x, y, { size, weight = 400, colour = WHITE, ha = "center", va = "center" }) {
      setFont(size, weight);
      ctx.fillStyle = colour;
      ctx.textAlign = ha;
      ctx.textBaseline = "alphabetic";
      const lines = s.split("\n");
      const { asc, desc } = lineBox();
      const lh = asc * LINE_SPACING + desc;  // baseline to baseline, as Text._get_layout spaces lines
      const block = (lines.length - 1) * lh + asc + desc;
      let top = va === "top" ? y : va === "bottom" ? y - block : y - block / 2;
      for (const line of lines) {
        ctx.fillText(line, x, top + asc);
        top += lh;
      }
    }

    // --- the density -------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(AX.left, AX.top, AX.size, AX.size);
    ctx.clip();
    // contourf of diff x 1000: values on the grid, y-major for d3
    const values = new Float64Array(N * N);
    for (let ix = 0; ix < N; ix++) for (let iy = 0; iy < N; iy++) values[iy * N + ix] = result.diff[ix * N + iy] * 1000;
    ctx.fillStyle = BANDS[0];
    ctx.fillRect(AX.left, AX.top, AX.size, AX.size);
    const rings = d3.contours().size([N, N]).thresholds(LEVELS)(values);
    // d3 puts sample i at coordinate i + 0.5
    const cx = (c) => px(c - 0.5), cy = (c) => py(c - 0.5 + LAUNCH[0]);
    rings.forEach((multi, k) => {
      ctx.fillStyle = BANDS[k + 1];
      ctx.beginPath();
      for (const polygon of multi.coordinates) {
        for (const ring of polygon) {
          ring.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(cx(x), cy(y)); else ctx.lineTo(cx(x), cy(y)); });
          ctx.closePath();
        }
      }
      ctx.fill("evenodd");
    });
    ctx.restore();

    // --- the bucket lines: black at a quarter, 1 pt ----------------------------
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = pt(1);
    ctx.beginPath();
    for (const la of [10, 25, 50]) { ctx.moveTo(AX.left, py(la)); ctx.lineTo(AX.left + AX.size, py(la)); }
    for (const sp of [30, 60]) { ctx.moveTo(px(sp), AX.top); ctx.lineTo(px(sp), AX.top + AX.size); }
    ctx.stroke();

    // --- the shares in each cell, boxed ------------------------------------------
    const fmt = (v) => (opts.signed ? (v >= 0 ? "+" : "-") + Math.abs(v * 100).toFixed(1) : (v * 100).toFixed(1)) + "%";
    const sprayMid = [15, 45, 75], launchMid = [-10, 17.5, 37.5, 55];
    setFont(12);
    const box = lineBox();
    const pad = pt(12) * 0.3;  // the Round boxstyle's pad, in text units
    result.shares.cells.forEach((col, i) => col.forEach((v, j) => {
      const s = fmt(v), x = px(sprayMid[i]), y = py(launchMid[j]);
      setFont(12);
      const w = ctx.measureText(s).width + 2 * pad, h = box.asc + box.desc + 2 * pad;
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = pt(2);
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, pad);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      text(s, x, y, { size: 12, colour: "#000000" });
    }));

    // --- axis labels: the buckets, with the hitter's share under each ------------
    const xLabels = ["Pull", "Center", "Oppo"];
    xLabels.forEach((s, i) => {
      text(s, px(sprayMid[i]), AX.top + AX.size + 0.02 * AX.size, { size: 15, va: "top" });
      text(`(${fmt(result.shares.spray[i])})`, px(sprayMid[i]), AX.top + AX.size + 0.075 * AX.size, { size: 10, va: "top" });
    });
    const yLabels = ["Ground\nBall", "Line Drive", "Fly Ball", "Pop Up"];
    const yMid = [-10, 17.5, 37.5, 55];
    yLabels.forEach((s, j) => {
      const x = AX.left - 0.14 * AX.size;
      text(s, x, py(yMid[j] + 1), { size: 15 });
      text(`(${fmt(result.shares.launch[j])})`, x, py(yMid[j] - (j === 0 ? 6 : 3.5)), { size: 10 });
    });

    // --- the colourbar ---------------------------------------------------------------
    const h = CB.height / STEPS.length;
    STEPS.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(CB.left, CB.top + CB.height - (i + 1) * h, CB.width, h + 0.5);
    });
    const cbx = AX.left + 1.115 * AX.size;
    [["Less\nOften", -24, LABEL_BLUE], ["Same", 15, "#000000"], ["More\nOften", 53.5, LABEL_RED]]
      .forEach(([s, la, colour]) => text(s, cbx, py(la), { size: 15, weight: 500, colour }));

    // --- title, credit, wordmark ------------------------------------------------------
    text(opts.title, 742, 40, { size: 16 });
    text(opts.subtitle, 742, 85, { size: 12 });
    text("Data: MLB Statcast", 27, 1085, { size: 6, ha: "left" });
    if (opts.wordmark) {
      // bottom right, under the colourbar and flush with its right edge
      const w = 230, h = w * (opts.wordmark.height / opts.wordmark.width);
      ctx.drawImage(opts.wordmark, CB.left + CB.width - w, 1108 - h, w, h);
    }
  }

  async function render(canvas, result, opts) {
    await ensureFonts();
    const wordmark = await loadWordmark();
    draw(canvas, result, { ...opts, wordmark });
  }

  window.BattedBalls = { N, kdeGrid, compute, shares, render, inRange };
})();
