"use strict";
// League Calendar: each level's run environment week by week. The data (data.json) comes from
// tools/park_factors/build_calendar.py: per level and year, the weeks, the model's calendar curve
// and (past years) what each week produced, every value 10 x an index (100 = the season average).

const $ = id => document.getElementById(id);
const NAMES = {wOBA: "wOBA", R: "Runs", OBP: "OBP", AVG: "Hits (AVG)", "1B": "Singles", "2B": "Doubles", "3B": "Triples",
  HR: "Home runs", BB: "Walks", K: "Strikeouts", HBP: "Hit by pitch", BACON: "BACON", wOBACon: "wOBACon"};
const LOWER_BETTER = new Set(["K"]);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ALL = "all";
const DEFAULTS = {level: "MLB", year: ALL, stat: "R", wk: "", grid: "model"};
const state = {...DEFAULTS};
let D = null;

// the diverging scale of Park Factors: blue (worse for hitters) – surface – red (better), clipped at 90/110
const SURF = [21, 27, 35], RED = [214, 72, 66], BLUE = [58, 116, 214];
function shade(v, col) {
  let t = Math.max(-1, Math.min(1, (v - 100) / 10));
  if (LOWER_BETTER.has(col)) t = -t;
  const to = t >= 0 ? RED : BLUE, a = Math.abs(t) * 0.9;
  return `rgb(${SURF.map((s, i) => Math.round(s + (to[i] - s) * a)).join(",")})`;
}
$("legend_bar").style.background = `linear-gradient(90deg, ${[90, 95, 100, 105, 110].map(v => shade(v, "")).join(",")})`;

// a "MM-DD" as a day of a common year, so that seasons line up by date
const DAY0 = Date.UTC(2023, 0, 1);
const dayOf = md => (Date.UTC(2023, +md.slice(0, 2) - 1, +md.slice(3)) - DAY0) / 864e5;
const mid = w => (dayOf(w[0]) + dayOf(w[1])) / 2;
const short = md => `${MON[+md.slice(0, 2) - 1]} ${+md.slice(3)}`;
const num = n => n.toLocaleString("en-US");
const f1 = v => v.toFixed(1);

const years = () => D.years[state.level];
const newest = () => years()[0];
const yearShown = () => (state.year === ALL ? newest() : +state.year);
const series = y => D.series[state.level][y];
const cur = () => series(yearShown());
const si = () => D.cols.indexOf(state.stat);
// All years pools the past seasons that began by mid-April: a season without April (MLB 2020, the
// minors' 2021) has a summer-only average for its 100
const pooled = () => years().filter(y => series(y).obs && dayOf(series(y).weeks[0][0]) <= dayOf("04-15"));

function weekIndex(s) {
  if (!state.wk) return 0;
  const i = s.weeks.findIndex(w => w[0] === state.wk);
  if (i >= 0) return i;
  const d = dayOf(state.wk);
  let best = 0;
  s.weeks.forEach((w, j) => { if (Math.abs(mid(w) - d - 3) < Math.abs(mid(s.weeks[best]) - d - 3)) best = j; });
  return best;
}

// All years, per week of the newest year: the PA-weighted average of the pooled seasons' weeks
// nearest by date (an index x 10), with the seasons and PAs behind it
function pooledActual(c) {
  const ws = cur().weeks, acc = ws.map(() => ({s: 0, pa: 0, n: 0}));
  for (const y of pooled()) {
    const s = series(y);
    s.weeks.forEach((w, j) => {
      if (!s.obs[j]) return;
      const m = mid(w);
      let k = 0;
      ws.forEach((x, i) => { if (Math.abs(mid(x) - m) < Math.abs(mid(ws[k]) - m)) k = i; });
      acc[k].s += s.pa[j] * s.obs[j][c]; acc[k].pa += s.pa[j]; acc[k].n += 1;
    });
  }
  return acc.map(a => (a.pa ? {v: a.s / a.pa, pa: a.pa, n: a.n} : null));
}

// the table's values: per week, per column, an index x 10 (or null), and a hover note
function gridValues() {
  const s = cur();
  if (state.grid === "model" || !hasActual()) return s.model.map(row => row.map(v => ({v, note: "model"})));
  if (state.year !== ALL) return s.obs.map((row, i) => D.cols.map((_, c) => ({v: row ? row[c] : null, note: `actual, ${num(s.pa[i])} PA`, thin: s.pa[i] < 1500})));
  const cols = D.cols.map((_, c) => pooledActual(c));
  return s.weeks.map((_, i) => D.cols.map((_, c) => {
    const a = cols[c][i];
    return {v: a ? a.v : null, note: a ? `actual, ${a.n} weeks, ${num(a.pa)} PA` : ""};
  }));
}
const hasActual = () => (state.year === ALL ? pooled().length > 0 : !!cur().obs);

function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  sel.value = value;
}
function refreshOptions() {
  fillSelect($("level"), D.levels.map(l => [l, l]), state.level);
  if (state.year !== ALL && !years().includes(+state.year)) state.year = ALL;
  const ys = years().map(y => [String(y), y === 2027 ? "2027 (schedule)" : String(y)]);
  fillSelect($("year"), [[ALL, "All years"], ...ys], state.year);
  fillSelect($("stat"), D.cols.map(c => [c, NAMES[c] || c]), state.stat);
}

function render() {
  const s = cur(), wi = weekIndex(s), w = s.weeks[wi];
  state.wk = w[0];
  $("week").max = s.weeks.length - 1;
  $("week").value = wi;
  $("week").setAttribute("aria-valuetext", w[2]);
  $("wk_label").textContent = `${w[2]}, ${yearShown()}`;
  const n = s.weeks.length;
  $("months").innerHTML = s.weeks.map((x, i) => (i && x[0].slice(0, 2) !== s.weeks[i - 1][0].slice(0, 2)
    ? `<span style="left:${(100 * i) / (n - 1)}%">${MON[+x[0].slice(0, 2) - 1]}</span>` : "")).join("");
  const gb = $("grid_src").querySelectorAll("button");
  gb.forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.v === (hasActual() ? state.grid : "model")));
    if (b.dataset.v === "actual") b.disabled = !hasActual();
  });
  renderReadout(s, wi);
  drawChart();
  renderGrid(s, wi);
  const h = new URLSearchParams();
  for (const k of Object.keys(DEFAULTS)) if (state[k] !== DEFAULTS[k] && !(k === "wk" && wi === 0)) h.set(k, state[k]);
  history.replaceState(null, "", h.toString() ? `#${h}` : location.pathname + location.search);
}

function renderReadout(s, wi) {
  const c = si(), name = NAMES[state.stat] || state.stat, w = s.weeks[wi];
  const parts = [`<span><b>${w[2]}</b> · ${name}</span>`,
    `<span>model <span class="m">${f1(s.model[wi][c] / 10)}</span>${yearShown() === 2027 ? " on the 2027 schedule" : ""}</span>`];
  if (state.year === ALL) {
    const a = pooledActual(c)[wi], ps = pooled();
    if (a) parts.push(`<span>actual <span class="a">${f1(a.v / 10)}</span>: the average of ${a.n} weeks, ${ps[ps.length - 1]}–${ps[0]} (${num(a.pa)} PA)</span>`);
  } else if (s.obs) {
    const o = s.obs[wi];
    parts.push(o ? `<span>actual <span class="a">${f1(o[c] / 10)}</span> (${num(s.pa[wi])} PA in ${num(s.games[wi])} games)</span>` : "<span>no games</span>");
  } else {
    parts.push("<span>not played yet</span>");
  }
  $("readout").innerHTML = parts.join("");
}

function niceStep(range) {
  for (const s of [1, 2, 5, 10, 20, 25, 50]) if (range / s <= 7) return s;
  return 100;
}
const quantile = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function drawChart() {
  const s = cur(), c = si(), wi = weekIndex(s), all = state.year === ALL;
  const box = $("chartbox"), W = Math.max(280, box.clientWidth), H = Math.round(Math.max(240, Math.min(360, W * 0.4)));
  const m = {l: 40, r: 12, t: 10, b: 26};
  // the dots: [day, index, PA, label, selected year?]
  const dots = [];
  for (const y of all ? pooled() : s.obs ? [yearShown()] : []) {
    const z = series(y);
    z.weeks.forEach((w, j) => { if (z.obs[j]) dots.push([mid(w), z.obs[j][c] / 10, z.pa[j], `${y} · ${w[2]}`, !all]); });
  }
  const line = s.weeks.map(w => mid(w)).map((x, i) => [x, s.model[i][c] / 10]);
  const xs = [...line.map(p => p[0]), ...dots.map(p => p[0])];
  const x0 = Math.min(...xs) - 4, x1 = Math.max(...xs) + 4;
  // the y range: the whole line and the dots between their 2nd and 98th percentiles; the rest sit on the edge
  const ov = dots.filter(d => d[2] >= 1500).map(d => d[1]).sort((a, b) => a - b);
  let lo = Math.min(100, ...line.map(p => p[1])), hi = Math.max(100, ...line.map(p => p[1]));
  if (ov.length) { lo = Math.min(lo, quantile(ov, 0.02)); hi = Math.max(hi, quantile(ov, 0.98)); }
  const pad = Math.max(1, (hi - lo) * 0.06);
  lo -= pad; hi += pad;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = x => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = v => m.t + ((hi - v) / (hi - lo)) * (H - m.t - m.b);
  const out = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 100 ? "#4a5565" : "#242c37"}" stroke-width="${v === 100 ? 1.5 : 1}"/>`);
    out.push(`<text class="ylab" x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  for (let mo = 2; mo <= 10; mo++) {
    const d = (Date.UTC(2023, mo, 1) - DAY0) / 864e5;
    if (d >= x0 && d <= x1) {
      out.push(`<line x1="${X(d)}" x2="${X(d)}" y1="${m.t}" y2="${H - m.b}" stroke="#1d242e"/>`);
      out.push(`<text x="${X(d) + 4}" y="${H - 8}">${MON[mo]}</text>`);
    }
  }
  const xw = X(mid(s.weeks[wi]));
  out.push(`<rect x="${xw - 3.5 * (W - m.l - m.r) / (x1 - x0)}" y="${m.t}" width="${7 * (W - m.l - m.r) / (x1 - x0)}" height="${H - m.t - m.b}" fill="rgba(108,180,255,.08)"/>`);
  let clipped = false;
  for (const [x, v, pa, lab, sel] of dots) {
    const r = Math.max(1.6, Math.min(5, 4.2 * Math.sqrt(pa / 7000))), vy = Math.max(lo, Math.min(hi, v));
    const col = sel ? "var(--actual)" : "var(--other)", op = (sel ? 0.9 : 0.42) * (pa < 1500 ? 0.55 : 1);
    const tip = `<title>${esc(lab)}: ${f1(v)} (${num(pa)} PA)</title>`;
    if (v !== vy) {
      clipped = true;
      const dy = v > hi ? -1 : 1, yy = Y(vy);
      out.push(`<path d="M${X(x) - 4},${yy - 3 * dy} L${X(x) + 4},${yy - 3 * dy} L${X(x)},${yy + 4 * dy} Z" fill="none" stroke="${col}" opacity="${op}">${tip}</path>`);
    } else {
      out.push(`<circle cx="${X(x)}" cy="${Y(v)}" r="${r}" fill="${col}" opacity="${op}">${tip}</circle>`);
    }
  }
  // All years: the actual weeks' average by date (the table's Actual), dashed
  const avg = all ? pooledActual(c) : [];
  const ap = avg.map((a, i) => (a ? `${X(mid(s.weeks[i]))},${Y(Math.max(lo, Math.min(hi, a.v / 10)))}` : null)).filter(Boolean);
  if (ap.length > 1) out.push(`<polyline points="${ap.join(" ")}" fill="none" stroke="var(--actual)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" opacity=".9"/>`);
  out.push(`<polyline points="${line.map(([x, v]) => `${X(x)},${Y(v)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>`);
  line.forEach(([x, v], i) => out.push(`<circle cx="${X(x)}" cy="${Y(v)}" r="${i === wi ? 5 : 0}" fill="var(--accent)" stroke="#0d1117" stroke-width="1.5"><title>model · ${esc(s.weeks[i][2])}: ${f1(v)}</title></circle>`));
  line.forEach(([x, v], i) => { if (i !== wi) out.push(`<circle cx="${X(x)}" cy="${Y(v)}" r="7" fill="transparent"><title>model · ${esc(s.weeks[i][2])}: ${f1(v)}</title></circle>`); });
  const svg = $("chart");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);
  const name = NAMES[state.stat] || state.stat;
  svg.innerHTML = `<title id="chart_title">${esc(`${name} by week, ${state.level} ${all ? "all years" : yearShown()}: the model's curve${dots.length ? " and the actual weeks" : ""}, 100 = the season average`)}</title>${out.join("")}`;
  const key = [`<span><i class="ln"></i>Model: ${state.level} ${yearShown()}${yearShown() === 2027 ? " on the 2027 schedule" : ""}</span>`];
  if (all && dots.length) {
    key.push(`<span><i class="dt o"></i>Actual weeks, ${pooled()[pooled().length - 1]}–${pooled()[0]} (size: plate appearances)</span>`);
    key.push(`<span><i class="ln" style="background:repeating-linear-gradient(90deg,var(--actual) 0 5px,transparent 5px 8px)"></i>Their average by date</span>`);
  }
  else if (dots.length) key.push(`<span><i class="dt"></i>Actual weeks, ${yearShown()} (size: plate appearances)</span>`);
  if (clipped) key.push(`<span>▵ ▿ a week outside the range, on the edge</span>`);
  $("key").innerHTML = key.join("");
}

function renderGrid(s, wi) {
  const vals = gridValues(), sel = si();
  $("grid_head").innerHTML = `<th class="name">${state.level} ${state.year === ALL ? "all years" : yearShown()}</th>` +
    s.weeks.map((w, i) => {
      const prev = i ? s.weeks[i - 1][0].slice(0, 2) : "";
      const lab = w[0].slice(0, 2) !== prev ? short(w[0]) : String(+w[0].slice(3));
      return `<th data-i="${i}" class="${i === wi ? "sel" : ""}" title="${w[2]}">${lab}</th>`;
    }).join("");
  $("grid_body").innerHTML = D.cols.map((c, ci) => `<tr class="${ci === sel ? "on" : ""}" data-c="${c}"><td class="name">${NAMES[c] || c}</td>` +
    vals.map((row, i) => {
      const {v, note, thin} = row[ci], cls = `${i === wi ? "sel" : ""}${thin ? " thin" : ""}`;
      if (v === null || v === undefined) return `<td class="na ${cls}" data-i="${i}">–</td>`;
      return `<td class="${cls}" data-i="${i}" style="background:${shade(v / 10, c)}" title="${NAMES[c] || c}, ${s.weeks[i][2]}: ${f1(v / 10)} (${note})">${Math.round(v / 10)}</td>`;
    }).join("") + "</tr>").join("");
  const gs = state.year === ALL ? pooled() : [];
  $("grid_note").textContent = state.grid === "actual" && hasActual()
    ? (state.year === ALL ? `Actual: the plate-appearance-weighted average of ${gs[gs.length - 1]}–${gs[0]} by date.` : `Actual: what each week of ${yearShown()} produced, unadjusted.`)
    : `Model: the calendar curve for ${state.level} ${yearShown()}${yearShown() === 2027 ? " on the 2027 schedule" : ""}. Click a cell to chart that stat and week.`;
}

// the tile image: the chart on screen, drawn as the homepage tile is (900 x 900, the Pitcher List
// Stats colors and wordmark, tools/park_factors/build_calendar_tile.py), to copy or download
const TILE = {W: 900, L: 118, R: 862, T: 176, B: 742, bg: "rgb(41,44,66)", cyan: "rgb(4,209,249)",
  gold: "rgb(255,209,102)", dot: "#9aa0b8", sub: "#9aa0b8", axis: "#c0c4d3"};
let logoImg = null;
const loadLogo = () => logoImg || (logoImg = new Promise((res, rej) => {
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = rej;
  im.src = "logo.png";
}));
function tileStep(range) {
  for (const s of [1, 2, 4, 5, 10, 20, 25, 50]) if (range / s <= 5) return s;
  return 100;
}
// the image's title: "<level> <metric> Factor, by Week"
const TITLE_NAMES = {R: "Run"};
const yearLabel = ys => (state.year === ALL ? `${ys[ys.length - 1]}–${ys[0]}` : yearShown() === 2027 ? "2027 Schedule" : String(yearShown()));
const fileName = () => `league_calendar_${state.level.replace("+", "plus")}_${state.year === ALL ? "all_years" : yearShown()}_${state.stat}.png`;

async function tileBlob() {
  const s = cur(), c = si(), all = state.year === ALL;
  await Promise.all(["700 36px", "700 19px", "400 21px", "400 17px", "400 16px", "400 15px"].map(f => document.fonts.load(`${f} "DM Sans"`)));
  const logo = await loadLogo();
  const {W, L, R, T, B} = TILE;
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  const g = cv.getContext("2d");
  g.fillStyle = TILE.bg;
  g.fillRect(0, 0, W, W);
  // the data, as the chart on the page has it
  const ys = all ? pooled() : s.obs ? [yearShown()] : [];
  const dots = [];
  for (const y of ys) {
    const z = series(y);
    z.weeks.forEach((w, j) => { if (z.obs[j]) dots.push([mid(w), z.obs[j][c] / 10, z.pa[j]]); });
  }
  const line = s.weeks.map((w, i) => [mid(w), s.model[i][c] / 10]);
  const avg = all ? pooledActual(c).map((a, i) => (a ? [mid(s.weeks[i]), a.v / 10] : null)).filter(Boolean) : [];
  const xs = [...line, ...dots].map(q => q[0]);
  const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3;
  const ov = dots.filter(d => d[2] >= 1500).map(d => d[1]).sort((a, b) => a - b);
  let lo = Math.min(100, ...line.map(q => q[1])), hi = Math.max(100, ...line.map(q => q[1]));
  if (ov.length) { lo = Math.min(lo, quantile(ov, 0.02)); hi = Math.max(hi, quantile(ov, 0.98)); }
  const pad = Math.max(0.5, (hi - lo) * 0.06);
  const step = tileStep(hi - lo + 2 * pad);
  lo = Math.floor((lo - pad) / step) * step; hi = Math.ceil((hi + pad) / step) * step;
  const X = x => L + ((x - x0) / (x1 - x0)) * (R - L);
  const Y = v => T + ((hi - Math.min(hi, Math.max(lo, v))) / (hi - lo)) * (B - T);
  // title, subtitle, wordmark
  g.font = '700 36px "DM Sans"';
  g.fillStyle = TILE.cyan;
  g.fillText(`${state.level} ${TITLE_NAMES[state.stat] || state.stat} Factor, by Week`, 90, 64);
  g.font = '400 21px "DM Sans"';
  g.fillStyle = TILE.sub;
  g.fillText(yearLabel(ys.length ? ys : [yearShown()]), 90, 100);
  g.drawImage(logo, W - 32 - 236, 27, 236, (236 * logo.naturalHeight) / logo.naturalWidth);
  // the grid, 100 brighter, and the months
  g.font = '400 17px "DM Sans"';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    g.strokeStyle = v === 100 ? "#6d7290" : "#3a3e5a";
    g.lineWidth = v === 100 ? 2 : 1;
    g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(R, Y(v)); g.stroke();
    g.fillStyle = TILE.axis;
    g.textAlign = "right";
    g.fillText(String(v), L - 14, Y(v) + 6);
  }
  g.textAlign = "left";
  for (let mo = 3; mo <= 9; mo++) {
    const d = (Date.UTC(2023, mo, 1) - DAY0) / 864e5;
    if (d < x0 || d > x1) continue;
    g.strokeStyle = "#33374f";
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(d), T); g.lineTo(X(d), B); g.stroke();
    g.fillStyle = TILE.axis;
    g.fillText(MON[mo], X(d) + 7, B + 30);
  }
  // the actual weeks (sized by PA), their average, the model curve
  for (const [x, v, pa] of dots) {
    g.globalAlpha = all ? (pa >= 1500 ? 0.42 : 0.22) : pa >= 1500 ? 0.85 : 0.4;
    g.fillStyle = all ? TILE.dot : TILE.gold;
    g.beginPath(); g.arc(X(x), Y(v), Math.max(2.5, Math.min(7, 7 * Math.sqrt(pa / 7000))), 0, 2 * Math.PI); g.fill();
  }
  g.globalAlpha = 1;
  g.lineJoin = "round";
  const poly = pts => {
    g.beginPath();
    pts.forEach(([x, v], i) => (i ? g.lineTo(X(x), Y(v)) : g.moveTo(X(x), Y(v))));
    g.stroke();
  };
  if (avg.length > 1) {
    g.strokeStyle = TILE.gold; g.lineWidth = 3.5; g.setLineDash([11, 8]); poly(avg); g.setLineDash([]);
  }
  g.strokeStyle = TILE.cyan; g.lineWidth = 6; g.lineCap = "round"; poly(line); g.lineCap = "butt";
  // the curve's low and high, labeled
  const low = line.reduce((a, q) => (q[1] < a[1] ? q : a)), high = line.reduce((a, q) => (q[1] > a[1] ? q : a));
  g.font = '700 19px "DM Sans"';
  g.textAlign = "center";
  for (const [[x, v], below] of [[low, true], [high, false]]) {
    const y = Y(v), under = below ? y + 34 < B - 4 : y - 20 < T + 18;
    g.beginPath(); g.arc(X(x), y, 8, 0, 2 * Math.PI);
    g.fillStyle = TILE.cyan; g.fill();
    g.lineWidth = 3; g.strokeStyle = TILE.bg; g.stroke();
    // the label on a slight shade of the ground, so it reads over the dots
    const text = v.toFixed(1), tx = Math.max(L + 24, Math.min(R - 24, X(x))), ty = under ? y + 34 : y - 20;
    const m = g.measureText(text), up = m.actualBoundingBoxAscent || 14, down = m.actualBoundingBoxDescent || 0;
    g.fillStyle = "rgba(41,44,66,0.8)";
    g.beginPath();
    const bx = tx - m.width / 2 - 6, by = ty - up - 4, bw = m.width + 12, bh = up + down + 8;
    if (g.roundRect) g.roundRect(bx, by, bw, bh, 5); else g.rect(bx, by, bw, bh);
    g.fill();
    g.fillStyle = "#fff";
    g.fillText(text, tx, ty);
  }
  // the key and the note
  g.font = '400 16px "DM Sans"';
  g.textAlign = "left";
  g.textBaseline = "middle";
  let kx = 90;
  const ky = 804;
  const item = (draw, w, text) => {
    draw(kx);
    kx += w + 9;
    g.fillStyle = TILE.axis;
    g.fillText(text, kx, ky);
    kx += g.measureText(text).width + 26;
  };
  item(x => { g.fillStyle = TILE.cyan; g.fillRect(x, ky - 3, 30, 6); }, 30, "Model curve");
  if (dots.length) {
    item(x => {
      g.globalAlpha = 0.7; g.fillStyle = all ? TILE.dot : TILE.gold;
      g.beginPath(); g.arc(x + 6, ky, 6, 0, 2 * Math.PI); g.fill(); g.globalAlpha = 1;
    }, 12, "Actual weeks");
  }
  if (avg.length > 1) item(x => { g.fillStyle = TILE.gold; g.fillRect(x, ky - 2, 11, 4); g.fillRect(x + 19, ky - 2, 11, 4); }, 30, "Their average");
  g.textBaseline = "alphabetic";
  g.font = '400 15px "DM Sans"';
  g.fillStyle = TILE.sub;
  g.fillText(`100 = ${state.level} Season Average`, 90, 871);
  return new Promise(res => cv.toBlob(res, "image/png"));
}
// Share image (shared/share-image.js): copy or download that image
ShareImage.image($("share"), tileBlob, fileName);

// events
$("level").addEventListener("change", e => { state.level = e.target.value; refreshOptions(); render(); });
$("year").addEventListener("change", e => { state.year = e.target.value; refreshOptions(); render(); });
$("stat").addEventListener("change", e => { state.stat = e.target.value; render(); });
$("week").addEventListener("input", e => { stop(); state.wk = cur().weeks[+e.target.value][0]; render(); });
$("grid_src").addEventListener("click", e => { const b = e.target.closest("button"); if (b && !b.disabled) { state.grid = b.dataset.v; render(); } });
$("grid").addEventListener("click", e => {
  const cell = e.target.closest("td,th");
  if (!cell) return;
  const tr = cell.closest("tr");
  if (tr && tr.dataset.c) { state.stat = tr.dataset.c; $("stat").value = state.stat; }
  if (cell.dataset.i !== undefined) state.wk = cur().weeks[+cell.dataset.i][0];
  stop(); render();
});
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(location.href); $("copy").textContent = "Copied"; }
  catch { $("copy").textContent = "Copy failed"; }
  setTimeout(() => { $("copy").textContent = "Copy link"; }, 1400);
});
// ▶ steps a week at a time to the end of the season (from opening week again once at the end)
let timer = null;
function stop() {
  clearInterval(timer); timer = null;
  $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play through the season");
}
$("play").addEventListener("click", () => {
  if (timer) return stop();
  if (weekIndex(cur()) >= cur().weeks.length - 1) { state.wk = cur().weeks[0][0]; render(); }
  $("play").textContent = "❚❚"; $("play").setAttribute("aria-label", "Pause");
  timer = setInterval(() => {
    const s = cur(), i = weekIndex(s);
    if (i >= s.weeks.length - 1) return stop();
    state.wk = s.weeks[i + 1][0]; render();
  }, 650);
});
// redraw at the box's width (the chart is drawn in pixels, so its text keeps its size on a phone)
let lastW = 0;
new ResizeObserver(() => {
  const w = $("chartbox").clientWidth;
  if (D && w !== lastW) { lastW = w; drawChart(); }
}).observe($("chartbox"));

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(DEFAULTS)) if (h.has(k)) state[k] = h.get(k);
  if (!D.levels.includes(state.level)) state.level = DEFAULTS.level;
  if (!D.cols.includes(state.stat)) state.stat = DEFAULTS.stat;
  if (!["model", "actual"].includes(state.grid)) state.grid = DEFAULTS.grid;
  if (!/^\d\d-\d\d$/.test(state.wk)) state.wk = "";
}

fetch("data.json")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(d => {
    D = d;
    $("generated").textContent = `Data through the 2026 season; built ${d.generated}.`;
    readHash(); refreshOptions(); render();
  })
  .catch(err => { $("readout").textContent = `Could not load the data (${err.message}).`; });
