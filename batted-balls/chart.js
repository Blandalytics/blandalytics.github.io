// The batted-ball chart: a hitter's density of spray angle against launch angle
// minus the league's (or their own prior season's), drawn on a canvas. A port of
// the figure in PLV_viz/hitter_app/pages/batted_ball_charts.py -- the same grid,
// the same scipy density, the same vlag bands and heatmap palette, the same
// layout -- so the PNG matches what the Streamlit app draws. Laid out in the pixels
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
  // seaborn's vlag, for the continuous colourbar
  const VLAG = ["#2369bd", "#266abd", "#296cbc", "#2c6dbc", "#2f6ebc", "#316fbc", "#3470bc", "#3671bc", "#3972bc", "#3b73bc", "#3d74bc", "#3f75bc", "#4276bc", "#4477bc", "#4678bc", "#4879bc", "#4a7bbc", "#4c7cbc", "#4e7dbc", "#507ebc", "#517fbc", "#5380bc", "#5581bc", "#5782bc", "#5983bd", "#5b84bd", "#5c85bd", "#5e86bd", "#6087bd", "#6288bd", "#6489be", "#658abe", "#678bbe", "#698cbe", "#6a8dbf", "#6c8ebf", "#6e90bf", "#6f91bf", "#7192c0", "#7393c0", "#7594c0", "#7695c1", "#7896c1", "#7997c1", "#7b98c2", "#7d99c2", "#7e9ac2", "#809bc3", "#829cc3", "#839dc4", "#859ec4", "#87a0c4", "#88a1c5", "#8aa2c5", "#8ba3c6", "#8da4c6", "#8fa5c7", "#90a6c7", "#92a7c8", "#93a8c8", "#95a9c8", "#97abc9", "#98acc9", "#9aadca", "#9baecb", "#9dafcb", "#9fb0cc", "#a0b1cc", "#a2b2cd", "#a3b4cd", "#a5b5ce", "#a7b6ce", "#a8b7cf", "#aab8d0", "#abb9d0", "#adbbd1", "#afbcd1", "#b0bdd2", "#b2bed3", "#b3bfd3", "#b5c0d4", "#b7c2d5", "#b8c3d5", "#bac4d6", "#bbc5d7", "#bdc6d7", "#bfc8d8", "#c0c9d9", "#c2cada", "#c3cbda", "#c5cddb", "#c7cedc", "#c8cfdd", "#cad0dd", "#cbd1de", "#cdd3df", "#cfd4e0", "#d0d5e0", "#d2d7e1", "#d4d8e2", "#d5d9e3", "#d7dae4", "#d9dce5", "#dadde5", "#dcdee6", "#dde0e7", "#dfe1e8", "#e1e2e9", "#e2e3ea", "#e4e5eb", "#e6e6ec", "#e7e7ec", "#e9e9ed", "#ebeaee", "#ecebef", "#eeedf0", "#efeef1", "#f1eff2", "#f2f0f2", "#f3f1f3", "#f5f2f4", "#f6f3f4", "#f7f4f4", "#f8f4f5", "#f9f5f5", "#f9f5f5", "#faf5f5", "#faf5f5", "#faf5f4", "#faf5f4", "#faf4f3", "#faf3f3", "#faf3f2", "#faf2f1", "#faf0ef", "#f9efee", "#f9eeed", "#f8edeb", "#f7ebea", "#f7eae8", "#f6e8e7", "#f5e7e5", "#f5e5e4", "#f4e3e2", "#f3e2e0", "#f2e0df", "#f2dfdd", "#f1dddb", "#f0dbda", "#efdad8", "#efd8d6", "#eed7d5", "#edd5d3", "#ecd3d2", "#ecd2d0", "#ebd0ce", "#eacfcd", "#eacdcb", "#e9cbc9", "#e8cac8", "#e7c8c6", "#e7c7c5", "#e6c5c3", "#e5c3c1", "#e5c2c0", "#e4c0be", "#e3bfbd", "#e3bdbb", "#e2bcb9", "#e1bab8", "#e1b9b6", "#e0b7b5", "#dfb5b3", "#dfb4b2", "#deb2b0", "#deb1ae", "#ddafad", "#dcaeab", "#dcacaa", "#dbaba8", "#daa9a7", "#daa8a5", "#d9a6a4", "#d9a5a2", "#d8a3a0", "#d7a29f", "#d7a09d", "#d69f9c", "#d59d9a", "#d59c99", "#d49a97", "#d49896", "#d39794", "#d29593", "#d29491", "#d19290", "#d1918e", "#d08f8d", "#cf8e8b", "#cf8c8a", "#ce8b88", "#cd8987", "#cd8885", "#cc8784", "#cc8582", "#cb8481", "#ca827f", "#ca817e", "#c97f7d", "#c87e7b", "#c87c7a", "#c77b78", "#c77977", "#c67875", "#c57674", "#c57572", "#c47371", "#c3726f", "#c3706e", "#c26f6d", "#c16d6b", "#c16c6a", "#c06a68", "#c06967", "#bf6765", "#be6664", "#be6463", "#bd6361", "#bc6160", "#bc605e", "#bb5e5d", "#ba5d5c", "#b95b5a", "#b95a59", "#b85857", "#b75756", "#b75555", "#b65453", "#b55252", "#b55151", "#b44f4f", "#b34d4e", "#b24c4c", "#b24a4b", "#b1494a", "#b04748", "#af4647", "#af4446", "#ae4244", "#ad4143", "#ac3f42", "#ac3e40", "#ab3c3f", "#aa3a3e", "#a9393c", "#a9373b"];
  // sns.color_palette("vlag", 25)[0] and [-1]: the Less / More Often labels
  const LABEL_BLUE = "#3b73bc", LABEL_RED = "#af4647";
  // the heatmap palette: blend kde_min -> white -> kde_max, centred on 0 at +/-0.01
  const KDE_MIN = [0x23, 0x6a, 0xbe], KDE_MAX = [0xa9, 0x37, 0x3b], KDE_MID = [0xfe, 0xfe, 0xfe];
  const KDE_THRESH = 0.01;

  function heatColour(v) {
    const t = Math.max(-1, Math.min(1, v / KDE_THRESH));
    const [from, to, u] = t < 0 ? [KDE_MID, KDE_MIN, -t] : [KDE_MID, KDE_MAX, t];
    return from.map((c, i) => Math.round(c + (to[i] - c) * u));
  }

  // ---- layout, in the pixels of the app's 1390 x 1135 image ---------------------
  const W = 1390, H = 1135;
  const AX = { left: 286, top: 108.5, size: 900 };  // 10 px per degree
  const CB = { left: 1208, top: 233, width: 163, height: 652 };
  const PX_PER_PT = 200 / 72;
  const FONT = '"Alexandria", "DM Sans", "Segoe UI", sans-serif';
  const LINE_SPACING = 1.2;  // matplotlib's multi-line spacing

  let logoPromise = null;
  function loadLogo() {
    if (!logoPromise) {
      logoPromise = fetch("pl-text-wht.png").then((r) => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((b) => createImageBitmap(b)).catch(() => null);
    }
    return logoPromise;
  }

  async function ensureFonts() {
    if (!document.fonts) return;
    try {
      await Promise.all([document.fonts.load(`400 40px ${FONT}`), document.fonts.load(`500 40px ${FONT}`)]);
    } catch { /* the fallback face draws instead */ }
  }

  // Draw the chart onto `canvas`.
  //   result:   from compute()
  //   opts:     { title, subtitle, hand: "L"|"R", scale: "discrete"|"continuous",
  //               signed: bool (print shares as +/- differences), logo, footer }
  function draw(canvas, result, opts) {
    const scale = 2;
    canvas.width = W * scale; canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);

    const discrete = opts.scale !== "continuous";
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
    if (discrete) {
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
    } else {
      // seaborn.heatmap of the transposed grid: cell (ix, iy) spans [ix, ix+1) by
      // [iy, iy+1) in index units, with the axes cut at 90 so the last row and
      // column are clipped away
      const off = document.createElement("canvas");
      off.width = N; off.height = N;
      const img = off.getContext("2d").createImageData(N, N);
      for (let ix = 0; ix < N; ix++) for (let iy = 0; iy < N; iy++) {
        const [r, g, b] = heatColour(result.diff[ix * N + iy]);
        const o = ((N - 1 - iy) * N + ix) * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
      off.getContext("2d").putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      if (flip) { ctx.translate(AX.left * 2 + AX.size, 0); ctx.scale(-1, 1); }
      ctx.drawImage(off, 0, 1, N - 1, N - 1, AX.left, AX.top, AX.size, AX.size);
      ctx.restore();
      ctx.imageSmoothingEnabled = true;
    }
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
    if (discrete) {
      const h = CB.height / STEPS.length;
      STEPS.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(CB.left, CB.top + CB.height - (i + 1) * h, CB.width, h + 0.5);
      });
    } else {
      const grad = ctx.createLinearGradient(0, CB.top + CB.height, 0, CB.top);
      VLAG.forEach((c, i) => grad.addColorStop(i / (VLAG.length - 1), c));
      ctx.fillStyle = grad;
      ctx.fillRect(CB.left, CB.top, CB.width, CB.height);
    }
    const cbx = AX.left + 1.115 * AX.size;
    [["Less\nOften", -24, LABEL_BLUE], ["Same", 15, "#000000"], ["More\nOften", 53.5, LABEL_RED]]
      .forEach(([s, la, colour]) => text(s, cbx, py(la), { size: 15, weight: 500, colour }));

    // --- title, credits, logo --------------------------------------------------------
    text(opts.title, 742, 40, { size: 16 });
    text(opts.subtitle, 742, 85, { size: 12 });
    text(opts.footer || "blandalytics.com/batted-balls", 27, 1085, { size: 6, ha: "left" });
    text("Data: MLB Statcast", 27, 1106, { size: 6, ha: "left" });
    text("@blandalytics", 1272, 1082, { size: 10 });
    if (opts.logo) ctx.drawImage(opts.logo, 61.6, 995.8, 209.8, 87.5);
  }

  async function render(canvas, result, opts) {
    await ensureFonts();
    const logo = await loadLogo();
    draw(canvas, result, { ...opts, logo });
  }

  window.BattedBalls = { N, kdeGrid, compute, shares, render, inRange };
})();
