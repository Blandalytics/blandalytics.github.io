// The batted-ball chart: a hitter's density of spray angle against launch angle
// minus the league's (or their own prior season's), drawn on a canvas. A port of
// the figure in PLV_viz/hitter_app/pages/batted_ball_charts.py -- the same grid,
// the same scipy density, the same vlag bands, the same layout -- with Tanaka's
// illuminated lines along every contour. Laid out in the pixels of the 200 dpi image
// the app serves (1390 x 1135) and rasterised at 2x.
//
// The xwOBA view draws, on the same grid and layout, the 3D xwOBA model's surface
// (tools/xwoba: spray, launch angle, bat speed) at the hitter's average bat speed,
// with Tanaka's illuminated contour lines, and the model's xwOBA of the hitter's
// balls by zone. The value view draws the hitter's xwOBA-weighted density less
// MLB's at the hitter's average bat speed, on the density chart's scale.

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
  //
  // With weights, the same kernels (the bandwidth still from the points alone) summed
  // with each ball's weight, on the same scale: so with every weight 1 it is the
  // density, and the grid sums to 100 times the mean weight.
  function kdeGrid(points, weights = null) {
    const kernel = scottKernel(points);
    if (!kernel) return null;
    const n = points.length, { a, b, c } = kernel;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    points.forEach(([x, y], i) => { xs[i] = x; ys[i] = y; });
    const out = new Float64Array(N * N);
    const weighted = weights && new Float64Array(N * N);
    let total = 0;
    for (let ix = 0; ix < N; ix++) {
      const gx = SPRAY[0] + ix * (SPRAY[1] - SPRAY[0]) / (N - 1);
      for (let iy = 0; iy < N; iy++) {
        const gy = LAUNCH[0] + iy * (LAUNCH[1] - LAUNCH[0]) / (N - 1);
        let s = 0, sw = 0;
        for (let i = 0; i < n; i++) {
          const dx = gx - xs[i], dy = gy - ys[i];
          const e = Math.exp(-0.5 * (a * dx * dx + 2 * b * dx * dy + c * dy * dy));
          s += e;
          if (weighted) sw += weights[i] * e;
        }
        out[ix * N + iy] = s;
        if (weighted) weighted[ix * N + iy] = sw;
        total += s;
      }
    }
    const k = 100 / total, grid = weighted || out;
    for (let i = 0; i < grid.length; i++) grid[i] *= k;
    return grid;
  }

  // Scott's kernel for a set of points: the inverse of factor^2 times their sample
  // covariance, as (a, b, c) for a x^2 + 2 b x y + c y^2; null for fewer than three
  // points or all of them in a line.
  function scottKernel(points) {
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
    return { a: syy / det, b: -sxy / det, c: sxx / det };
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

  // ---- the xwOBA view -------------------------------------------------------------
  // The surface at one bat speed, from xwoba.json's slices (one per model node, in
  // thousandths, laid out as the league grid): linear between the two slices around
  // it, which is how the model itself reads between its nodes.
  function surfaceAt(surface, batSpeed) {
    const { lo, step, n } = surface.bat_speed;
    const t = Math.min(Math.max((batSpeed - lo) / step, 0), n - 1);
    const i = Math.min(Math.floor(t), n - 2), f = t - i;
    const a = surface.slices[i], b = surface.slices[i + 1];
    const out = new Float64Array(N * N);
    for (let k = 0; k < out.length; k++) out[k] = ((1 - f) * a[k] + f * b[k]) / surface.scale;
    return out;
  }

  // The mean xwOBA of the balls in each zone (the same zones as the shares), null
  // for a zone with none. A ball is [spray, launch angle, bat speed, xwOBA].
  function zoneXwoba(balls) {
    const mean = (keep) => {
      let s = 0, c = 0;
      for (const b of balls) if (keep(b)) { s += b[3]; c++; }
      return c ? s / c : null;
    };
    return {
      spray: SPRAY_BUCKETS.map((f) => mean(([x]) => f(x))),
      launch: LAUNCH_BUCKETS.map((g) => mean(([, y]) => g(y))),
      cells: SPRAY_BUCKETS.map((f) => LAUNCH_BUCKETS.map((g) => mean(([x, y]) => f(x) && g(y)))),
    };
  }

  // What the xwOBA view needs: the surface at the average bat speed of the balls the
  // model covers (swung at, tracked, not bunted), and their xwOBA by zone.
  function computeXwoba({ balls, surface }) {
    const tracked = balls.filter((b) => b[2] != null && b[3] != null);
    if (!tracked.length) return null;
    const batSpeed = tracked.reduce((s, b) => s + b[2], 0) / tracked.length;
    return {
      surface: surfaceAt(surface, batSpeed),
      zones: zoneXwoba(tracked),
      batSpeed,
      xwoba: tracked.reduce((s, b) => s + b[3], 0) / tracked.length,
      tracked: tracked.length,
    };
  }

  // ---- the value view -------------------------------------------------------------
  // The hitter's batted balls against MLB's off swings as fast as theirs, both weighted
  // by xwOBA. MLB's are the season's tracked balls, each weighted by how near its bat
  // speed is to the hitter's average (a Gaussian BAT_SPEED_WIDTH mph wide), and spread
  // with the hitter's own kernels, so the two maps differ only in where the balls go
  // and what they are worth, not in how finely they are drawn. A ball is [spray, launch
  // angle, bat speed, xwOBA].
  const BAT_SPEED_WIDTH = 1.5;
  const tracked = (b) => b[2] != null && b[3] != null;

  // MLB's weighted balls on the grid with a given kernel, scaled as kdeGrid scales: the
  // balls are binned to the grid's nodes (shared linearly between the nearest along
  // each axis) and spread by a table of the kernel at every offset between nodes, which
  // is all it depends on, the grid being regular -- a third of a second where a sum
  // ball by ball over ~100,000 balls would take several.
  function spreadLeague(league, weights, { a, b, c }) {
    const count = new Float64Array(N * N), value = new Float64Array(N * N);
    const toNode = (v, [lo, hi]) => (v - lo) * (N - 1) / (hi - lo);
    league.forEach((ball, j) => {
      const w = weights[j];
      if (w < 1e-6 || !inRange(ball)) return;
      const fx = toNode(ball[0], SPRAY), fy = toNode(ball[1], LAUNCH);
      const i = Math.min(Math.floor(fx), N - 2), k = Math.min(Math.floor(fy), N - 2), u = fx - i, v = fy - k;
      for (const [di, dk, f] of [[0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)], [0, 1, (1 - u) * v], [1, 1, u * v]]) {
        count[(i + di) * N + k + dk] += w * f;
        value[(i + di) * N + k + dk] += w * f * ball[3];
      }
    });
    // the grid steps a degree each way, so an offset in nodes is one in degrees
    const M = 2 * N - 1, table = new Float64Array(M * M);
    for (let dx = 1 - N; dx < N; dx++) for (let dy = 1 - N; dy < N; dy++) {
      table[(dx + N - 1) * M + dy + N - 1] = Math.exp(-0.5 * (a * dx * dx + 2 * b * dx * dy + c * dy * dy));
    }
    // bin by bin, each grid row reading a contiguous run of the table, and only as far
    // out as the kernel is above 1e-9 of its peak: the box around the ellipse
    // a x^2 + 2 b x y + c y^2 = 2 ln 1e9 reaches sqrt(Q var) along each axis
    const q = 2 * Math.log(1e9), det = a * c - b * b;
    const rx = Math.ceil(Math.sqrt((q * c) / det)), ry = Math.ceil(Math.sqrt((q * a) / det));
    const out = new Float64Array(N * N), mass = new Float64Array(N * N);
    for (let ix = 0; ix < N; ix++) for (let iy = 0; iy < N; iy++) {
      const cnt = count[ix * N + iy], val = value[ix * N + iy];
      if (!(cnt > 0)) continue;
      const y0 = Math.max(0, iy - ry), y1 = Math.min(N - 1, iy + ry);
      for (let gx = Math.max(0, ix - rx); gx <= Math.min(N - 1, ix + rx); gx++) {
        const t0 = (gx - ix + N - 1) * M + N - 1 - iy, o0 = gx * N;
        for (let gy = y0; gy <= y1; gy++) {
          const t = table[t0 + gy];
          mass[o0 + gy] += t * cnt;
          out[o0 + gy] += t * val;
        }
      }
    }
    const total = mass.reduce((t, v) => t + v, 0);
    for (let k = 0; k < out.length; k++) out[k] *= 100 / total;
    return out;
  }

  // Each ball's xwOBA (times a weight) summed into the twelve zones in one pass, the
  // zones partitioning the field (every ball in exactly one spray bucket and one launch
  // bucket), and scaled by `per`: [spray][launch].
  function zoneSums(balls, weight, per) {
    const cells = SPRAY_BUCKETS.map(() => LAUNCH_BUCKETS.map(() => 0));
    balls.forEach((b, j) => {
      const i = SPRAY_BUCKETS.findIndex((f) => f(b[0])), k = LAUNCH_BUCKETS.findIndex((g) => g(b[1]));
      cells[i][k] += weight(j) * b[3] * per;
    });
    return cells;
  }

  // What the value view needs: the hitter's xwOBA-weighted density less MLB's at the
  // hitter's average bat speed -- the grid sums to 100 times the gap in xwOBA on contact
  // (over the in-range balls) -- and each zone's part of that gap: the hitter's xwOBA
  // from the zone over all their tracked balls, less MLB's over its weighted balls.
  function computeValue({ balls, league }) {
    const mine = balls.filter(tracked), inside = mine.filter(inRange);
    const kernel = scottKernel(inside);
    if (!kernel) return null;
    const batSpeed = mine.reduce((t, b) => t + b[2], 0) / mine.length;
    const weights = Float64Array.from(league, (b) => Math.exp(-0.5 * ((b[2] - batSpeed) / BAT_SPEED_WIDTH) ** 2));
    const theirs = spreadLeague(league, weights, kernel);
    const diff = kdeGrid(inside, inside.map((b) => b[3])).map((v, k) => v - theirs[k]);
    const hitter = zoneSums(mine, () => 1, 1 / mine.length);
    const mlb = zoneSums(league, (j) => weights[j], 1 / weights.reduce((t, w) => t + w, 0));
    const cells = hitter.map((col, i) => col.map((v, k) => v - mlb[i][k]));
    const sum = (a) => a.reduce((t, v) => t + v, 0);
    const total = (z) => sum(z.map(sum));
    return {
      diff,
      zones: {
        spray: cells.map(sum),
        launch: LAUNCH_BUCKETS.map((_, k) => sum(cells.map((col) => col[k]))),
        cells,
      },
      total: total(cells),
      batSpeed,
      hitterXwoba: total(hitter),
      leagueXwoba: total(mlb),
      tracked: mine.length,
    };
  }

  // ---- colours ------------------------------------------------------------------
  const BACKGROUND = "#292C42";
  const WHITE = "#FEFEFE";
  // contourf(levels -12..10 by 2, cmap vlag, extend both): the under colour, the
  // eleven bands, the over colour
  const LEVELS = [-12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
  const BANDS = ["#2369bd", "#3f75bc", "#6a8dbf", "#92a7c8", "#b7c2d5", "#dcdee6", "#faf5f4",
    "#eed7d5", "#deb2b0", "#d08f8d", "#c16c6a", "#b1494a", "#a9373b"];
  // the colourbar: BoundaryNorm over 13 steps of vlag
  const STEPS = ["#2369bd", "#5380bc", "#7896c1", "#9aadca", "#bdc6d7", "#dfe1e8", "#faf5f5",
    "#f0dbda", "#e1b9b6", "#d49896", "#c77977", "#b95a59", "#a9373b"];
  // sns.color_palette("vlag", 25)[0] and [-1]: the Less / More Often labels
  const LABEL_BLUE = "#3b73bc", LABEL_RED = "#af4647";

  // The xwOBA surface: a spectrum pinned to the wOBA value of each outcome -- white for
  // an out, the single's blue, the double's green, the triple's yellow, the home run's
  // red -- in ten levels of .200. The bands take the spectrum evenly from end to end,
  // as matplotlib's contourf spreads a colormap: the lowest an out's white, the
  // .800-1.000 band a single's blue (.889), the highest a home run's red.
  const XW_STOPS = [[0, "#FFFFFF", "Out"], [0.9, "#2D99C8", "1B"], [1.25, "#54D29B", "2B"],
    [1.6, "#FFE066", "3B"], [2, "#F04542", "HR"]];
  const XW_MAX = 2, XW_N = 10, XW_STEP = XW_MAX / XW_N;
  const XW_LEVELS = Array.from({ length: XW_N - 1 }, (_, i) => (i + 1) * XW_STEP);  // .2 .. 1.8
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const STOPS_RGB = XW_STOPS.map(([v, hex]) => [v, rgb(hex)]);

  function xwColour(v) {
    const x = Math.max(0, Math.min(XW_MAX, v));
    let k = 0;
    while (k < STOPS_RGB.length - 2 && x > STOPS_RGB[k + 1][0]) k++;
    const [v0, c0] = STOPS_RGB[k], [v1, c1] = STOPS_RGB[k + 1];
    const u = (x - v0) / (v1 - v0);
    return c0.map((c, i) => Math.round(c + (c1[i] - c) * u));
  }
  const XW_BANDS = Array.from({ length: XW_N }, (_, i) => toHex(xwColour((i / (XW_N - 1)) * XW_MAX)));

  // xwOBA as baseball writes it: .412, 1.023; a dash for a zone without balls
  const fmtXw = (v) => (v == null ? "–" : v < 1 ? v.toFixed(3).slice(1) : v.toFixed(3));
  // and a margin of it: +.012, -.004
  const fmtMargin = (v) => (v >= 0 ? "+" : "-") + fmtXw(Math.abs(v));

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

  // A 91 x 91 grid's contours (d3-contour) at the given levels, in contour units
  // (grid x scale), with the values they were traced on, y-major as d3 reads them.
  function contours(grid, scale, levels) {
    const values = new Float64Array(N * N);
    for (let ix = 0; ix < N; ix++) for (let iy = 0; iy < N; iy++) values[iy * N + ix] = grid[ix * N + iy] * scale;
    return { values, rings: d3.contours().size([N, N]).thresholds(levels)(values) };
  }

  // Fill the axes band by band: the lowest colour under everything, then each level's
  // region in the next. d3 puts sample i at coordinate i + 0.5.
  function paintBands(ctx, { rings }, bands, px, py) {
    ctx.fillStyle = bands[0];
    ctx.fillRect(AX.left, AX.top, AX.size, AX.size);
    const cx = (c) => px(c - 0.5), cy = (c) => py(c - 0.5 + LAUNCH[0]);
    rings.forEach((multi, k) => {
      ctx.fillStyle = bands[k + 1];
      ctx.beginPath();
      for (const polygon of multi.coordinates) {
        for (const ring of polygon) {
          ring.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(cx(x), cy(y)); else ctx.lineTo(cx(x), cy(y)); });
          ctx.closePath();
        }
      }
      ctx.fill("evenodd");
    });
  }

  // Tanaka's illuminated contours: every level's line, segment by segment, light where
  // the slope below it faces a light in the upper left and dark where it faces away,
  // and wider the more squarely it faces toward or away from the light. Which side of a
  // segment is downhill is read off the grid on either side of it, so the lines stay
  // right when the chart is mirrored for a left-handed hitter. Segments are batched by
  // brightness, so a chart is a handful of strokes. Every chart's contours get them:
  // on the batted-ball and value charts, where the field runs from blue below zero to
  // red above it, the red reads as high ground and the blue as hollows.
  const LIGHT = [-Math.SQRT1_2, -Math.SQRT1_2];  // toward the upper left, on screen
  const TANAKA_BINS = 6;
  function paintTanaka(ctx, { values, rings }, px, py, flip) {
    // the grid between its samples, in d3's coordinates (sample i sits at i + 0.5)
    const at = (x, y) => {
      const gx = Math.min(Math.max(x - 0.5, 0), N - 1), gy = Math.min(Math.max(y - 0.5, 0), N - 1);
      const i = Math.min(Math.floor(gx), N - 2), j = Math.min(Math.floor(gy), N - 2), u = gx - i, w = gy - j;
      const v = (a, b) => values[b * N + a];
      return (1 - u) * (1 - w) * v(i, j) + u * (1 - w) * v(i + 1, j) + (1 - u) * w * v(i, j + 1) + u * w * v(i + 1, j + 1);
    };
    const cx = (c) => px(c - 0.5), cy = (c) => py(c - 0.5 + LAUNCH[0]);
    const onEdge = (c) => c <= 0.01 || c >= N - 0.01;
    const paths = { light: [], dark: [] };
    for (let k = 0; k < TANAKA_BINS; k++) { paths.light.push(new Path2D()); paths.dark.push(new Path2D()); }
    for (const multi of rings) {
      for (const polygon of multi.coordinates) for (const ring of polygon) {
        for (let s = 1; s < ring.length; s++) {
          const [x0, y0] = ring[s - 1], [x1, y1] = ring[s];
          if ((onEdge(x0) && onEdge(x1)) || (onEdge(y0) && onEdge(y1))) continue;  // the grid's own border
          const len = Math.hypot(x1 - x0, y1 - y0);
          if (!len) continue;
          let nx = (y1 - y0) / len, ny = -(x1 - x0) / len;  // a normal, in grid units
          const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, e = 0.25;
          if (at(mx + e * nx, my + e * ny) > at(mx - e * nx, my - e * ny)) { nx = -nx; ny = -ny; }  // point it downhill
          // on screen x runs the other way for a left-handed hitter and y always runs down
          const sx = flip ? -nx : nx, sy = -ny;
          const lit = sx * LIGHT[0] + sy * LIGHT[1];
          const bin = Math.min(TANAKA_BINS - 1, Math.floor(Math.abs(lit) * TANAKA_BINS));
          const path = (lit >= 0 ? paths.light : paths.dark)[bin];
          path.moveTo(cx(x0), cy(y0));
          path.lineTo(cx(x1), cy(y1));
        }
      }
    }
    ctx.save();
    ctx.lineCap = "round";
    for (let k = 0; k < TANAKA_BINS; k++) {
      ctx.lineWidth = 0.6 + 2.4 * (k + 0.5) / TANAKA_BINS;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke(paths.light[k]);
      ctx.strokeStyle = "rgba(20,20,30,0.6)";
      ctx.stroke(paths.dark[k]);
    }
    ctx.restore();
  }

  async function ensureFonts() {
    if (!document.fonts) return;
    try {
      await Promise.all([document.fonts.load(`400 40px ${FONT}`), document.fonts.load(`500 40px ${FONT}`)]);
    } catch { /* the fallback face draws instead */ }
  }

  // Draw the chart onto `canvas`.
  //   result:   from compute(), or computeXwoba() for the xwOBA view
  //   result:   or computeValue() for the value view
  //   opts:     { title, subtitle, hand: "L"|"R", view: "balls"|"xwoba"|"value",
  //               signed: bool (print shares as +/- differences), logo, footer }
  function draw(canvas, result, opts) {
    const scale = 2;
    canvas.width = W * scale; canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);

    const xw = opts.view === "xwoba", value = opts.view === "value";
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

    // --- the density (or the surface, or the value), banded, with its Tanaka lines ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(AX.left, AX.top, AX.size, AX.size);
    ctx.clip();
    const field = xw ? contours(result.surface, 1, XW_LEVELS) : contours(result.diff, 1000, LEVELS);
    paintBands(ctx, field, xw ? XW_BANDS : BANDS, px, py);
    paintTanaka(ctx, field, px, py, flip);
    ctx.restore();

    // --- the bucket lines: black at a quarter, 1 pt ----------------------------
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = pt(1);
    ctx.beginPath();
    for (const la of [10, 25, 50]) { ctx.moveTo(AX.left, py(la)); ctx.lineTo(AX.left + AX.size, py(la)); }
    for (const sp of [30, 60]) { ctx.moveTo(px(sp), AX.top); ctx.lineTo(px(sp), AX.top + AX.size); }
    ctx.stroke();

    // --- the shares (or the zones' xwOBA) in each cell, boxed --------------------
    const fmtShare = (v) => (opts.signed ? (v >= 0 ? "+" : "-") + Math.abs(v * 100).toFixed(1) : (v * 100).toFixed(1)) + "%";
    const fmt = xw ? fmtXw : value ? fmtMargin : fmtShare;
    const zones = xw || value ? result.zones : result.shares;
    const sprayMid = [15, 45, 75], launchMid = [-10, 17.5, 37.5, 55];
    setFont(12);
    const box = lineBox();
    const pad = pt(12) * 0.3;  // the Round boxstyle's pad, in text units
    zones.cells.forEach((col, i) => col.forEach((v, j) => {
      const s = fmt(v), x = px(sprayMid[i]), y = py(launchMid[j]);
      setFont(12);
      const w = ctx.measureText(s).width + 2 * pad, h = box.asc + box.desc + 2 * pad;
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = pt(2);
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, pad);
      ctx.globalAlpha = xw ? 0.85 : 0.25;  // the surface's darkest blues need a solid box
      ctx.fill();
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.restore();
      text(s, x, y, { size: 12, colour: "#000000" });
    }));

    // --- axis labels: the buckets, with the hitter's share under each ------------
    const xLabels = ["Pull", "Center", "Oppo"];
    xLabels.forEach((s, i) => {
      text(s, px(sprayMid[i]), AX.top + AX.size + 0.02 * AX.size, { size: 15, va: "top" });
      text(`(${fmt(zones.spray[i])})`, px(sprayMid[i]), AX.top + AX.size + 0.075 * AX.size, { size: 10, va: "top" });
    });
    const yLabels = ["Ground\nBall", "Line Drive", "Fly Ball", "Pop Up"];
    const yMid = [-10, 17.5, 37.5, 55];
    yLabels.forEach((s, j) => {
      const x = AX.left - 0.14 * AX.size;
      text(s, x, py(yMid[j] + 1), { size: 15 });
      text(`(${fmt(zones.launch[j])})`, x, py(yMid[j] - (j === 0 ? 6 : 3.5)), { size: 10 });
    });

    // --- the colourbar ---------------------------------------------------------------
    if (xw) xwColourbar(ctx, text);
    else {
      const h = CB.height / STEPS.length;
      STEPS.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(CB.left, CB.top + CB.height - (i + 1) * h, CB.width, h + 0.5);
      });
      const cbx = AX.left + 1.115 * AX.size;
      const [less, more] = value ? ["Below\nMLB", "Above\nMLB"] : ["Less\nOften", "More\nOften"];
      [[less, -24, LABEL_BLUE], ["Same", 15, "#000000"], [more, 53.5, LABEL_RED]]
        .forEach(([s, la, colour]) => text(s, cbx, py(la), { size: 15, weight: 500, colour }));
    }

    // --- title, credits, logo --------------------------------------------------------
    text(opts.title, 742, 40, { size: 16 });
    text(opts.subtitle, 742, 85, { size: 12 });
    text(opts.footer || "blandalytics.com/batted-balls", 27, 1085, { size: 6, ha: "left" });
    text("Data: MLB Statcast", 27, 1106, { size: 6, ha: "left" });
    text("@blandalytics", 1272, 1082, { size: 10 });
    if (opts.logo) ctx.drawImage(opts.logo, 61.6, 995.8, 209.8, 87.5);
  }

  // The xwOBA colourbar: narrower than the density's, its ten bands with the outcomes
  // named on its left at their wOBA values and the values on its right.
  const XW_BAR = { left: 1252, top: CB.top, width: 40, height: CB.height };
  function xwColourbar(ctx, text) {
    const { left, top, width, height } = XW_BAR;
    const bottom = top + height, y = (v) => bottom - (v / XW_MAX) * height;
    XW_BANDS.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(left, y((i + 1) * XW_STEP), width, height / XW_N + 0.5);
    });
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, width, height);
    for (const [v, , name] of XW_STOPS) {
      ctx.beginPath();
      ctx.moveTo(left - 5, y(v)); ctx.lineTo(left, y(v));
      ctx.moveTo(left + width, y(v)); ctx.lineTo(left + width + 5, y(v));
      ctx.stroke();
      text(name, left - 10, y(v), { size: 10, ha: "right" });
      text(v ? fmtXw(v) : "0", left + width + 10, y(v), { size: 10, ha: "left" });
    }
    text("xwOBA", left + width / 2, top - 48, { size: 15, weight: 500 });
  }

  async function render(canvas, result, opts) {
    await ensureFonts();
    const logo = await loadLogo();
    draw(canvas, result, { ...opts, logo });
  }

  window.BattedBalls = { N, kdeGrid, compute, computeXwoba, computeValue, surfaceAt, shares, render, inRange, tracked };
})();
