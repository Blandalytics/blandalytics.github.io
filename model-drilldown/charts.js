// The figures, as SVG in the Swing Profiles card colours with shap_values_card.py's waterfall
// (its bars, gold and teal, connectors, league line and dashed finish). Three of them, linked
// through one focus:
//
//   flow     the pitcher's arsenal, the chosen pitch type's SHAP waterfall, and the league
//            picture of the chosen row, joined by ribbons: a pitch type fans out into its
//            waterfall, and the selected row fans out into its league panel
//   swarm    every row's SHAP over the league's units, the pitcher marked on each
//   sankey   the nine outcome probabilities: what each feature takes from some outcomes and
//            gives to others
//
// Every element that belongs to a row carries data-k="<row key>" and the class fx, so hovering
// a row anywhere lights it everywhere (app.js toggles the classes). Every element that persists
// from one input to the next carries data-m="<key>", and every ribbon data-f, for morph.js.

import {
  PITCH_NAMES, PITCH_COLORS, OUTCOMES, OUTCOME_NAMES, OUTCOME_COLORS, TARGET_NAMES, LABELS, AXIS, PCT,
  GROUPS, MODELS, isPlus, targetGood, targetName, rowValue, rowInput, allRows, sgn,
} from './data.js?v=10';

export const C = {
  card: '#292C42', raise: '#30344F', ink: '#E3E9F1', muted: '#8A96A6', faint: '#6B7684', grid: '#3A3E5A',
  gold: '#F1C647', teal: '#00D4FF',
};
// the card's navy palette (card.js, and the phone's drilldown): the ground, its tiles, rules and text
export const K = {
  ground: '#13263F', panel: '#172D4A', line: '#2A3A57', ink: '#E8EEF7', muted: '#93A3BC', faint: '#6C7C96',
  sub: '#7F9CD6', dot: '#9FB3CF', conn: '#B4BECC',
};
const FONT = '"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif';
export const WORDMARK_URL = 'https://res.cloudinary.com/dduabusaf/image/upload/v1772839288/PitcherList_Stats_watermark_with_logo_k9e3xa.webp';
const WM_ASPECT = 178 / 928;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const woba = (v, sign = false) => (sign ? sgn(v, 3) : v.toFixed(3)).replace(/^([+−-]?)0\./, '$1.');
const n1 = (v) => +v.toFixed(1);

// ---- formats per target ----------------------------------------------------------------------

export function formats(target) {
  if (isPlus(target)) {
    return { d: (v) => sgn(v, 1), v: (v) => String(Math.round(v)), tick: (v) => String(Math.round(v)), unit: 'pts', pad: 3 };
  }
  if (target === 'wobacon') {
    return { d: (v) => woba(v, true), v: (v) => woba(v), tick: (v) => woba(v), unit: 'wOBA', pad: 0.005 };
  }
  if (target === 'era') {  // runs per 9
    return { d: (v) => sgn(v, 2), v: (v) => v.toFixed(2), tick: (v) => `${+v.toFixed(2)}`, unit: 'runs', pad: 0.2 };
  }
  return { d: (v) => sgn(v, 2), v: (v) => `${v.toFixed(1)}%`, tick: (v) => `${+v.toFixed(2)}`, unit: 'pp', pad: 0.3 };
}

// t = -1 pure teal, 0 white, +1 pure gold (shap_values_card.kpi_color)
export function kpiColor(t) {
  t = Math.max(-1, Math.min(1, t));
  const to = t < 0 ? [0x00, 0xd4, 0xff] : [0xf1, 0xc6, 0x47];
  const a = Math.abs(t);
  return `rgb(${to.map((c) => Math.round(255 + (c - 255) * a)).join(',')})`;
}

// The title's sizes: the pitcher's name over the pitch type
const NAME_SIZE = 55, PT_SIZE = 44;
// Where the longest title line ends: the longest of these names, or of the pitch type names
// (the title's second line).
export function titleRight(names) {
  return 36 + Math.max(...names.map((n) => textWidth(n, NAME_SIZE)), ...Object.values(PITCH_NAMES).map((n) => textWidth(n, PT_SIZE)));
}

// the KPI box's target on one line: "Stuff+", "In-Play Out% (PLV)", "ERA (Stuff)"
export const kpiName = (model, target) => (isPlus(target) ? MODELS[model].title : `${TARGET_NAMES[target]} (${MODELS[model].short})`);

export function kpiT(target, unit) {
  const good = targetGood(target);
  if (isPlus(target)) return (unit.exact - 100) / 45;
  if (target === 'wobacon') return (good * (unit.exact - unit.league)) / 0.1;
  return (good * (unit.exact - unit.league)) / Math.max(unit.league, 1);
}

// ---- small helpers --------------------------------------------------------------------------

export function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) out.push(+v.toFixed(10));
  return out;
}
const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
export const pctile = (values, x) => Math.round((100 * values.filter((v) => v < x).length) / Math.max(values.length, 1));
export const ord = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
const sum = (a) => a.reduce((x, y) => x + y, 0);

// A waterfall bar: square where it starts (the running total before it) and rounded (r) where it
// ends, on the right for a rise and the left for a drop
export function bar(x, y, w, h, r, right) {
  const [x1, y1] = [n1(x + w), n1(y + h)];
  [x, y, r] = [n1(x), n1(y), n1(r)];
  return right
    ? `M${x},${y}H${n1(x1 - r)}Q${x1},${y} ${x1},${n1(y + r)}V${n1(y1 - r)}Q${x1},${y1} ${n1(x1 - r)},${y1}H${x}Z`
    : `M${x1},${y}H${n1(x + r)}Q${x},${y} ${x},${n1(y + r)}V${n1(y1 - r)}Q${x},${y1} ${n1(x + r)},${y1}H${x1}Z`;
}

// a horizontal Sankey ribbon from (x0, a0..a1) to (x1, b0..b1)
function ribbon(x0, a0, a1, x1, b0, b1) {
  const m = n1((x0 + x1) / 2);
  [x0, a0, a1, x1, b0, b1] = [x0, a0, a1, x1, b0, b1].map(n1);
  return `M${x0},${a0}C${m},${a0} ${m},${b0} ${x1},${b0}L${x1},${b1}C${m},${b1} ${m},${a1} ${x0},${a1}Z`;
}

// feature value -> colour: blue (low) through grey to pink (high), the beeswarm's scale
function valueColor(t) {
  const lo = [0x33, 0x9c, 0xff], mid = [0x8a, 0x96, 0xa6], hi = [0xff, 0x66, 0x83];
  const [a, b, u] = t < 0.5 ? [lo, mid, t * 2] : [mid, hi, (t - 0.5) * 2];
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * u)).join(',')})`;
}

const svgOpen = (W, H, cls) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${n1(H)}" class="${cls}" font-family='${FONT}' role="img">`
  + `<rect class="bg" data-m="bg" width="${W}" height="${n1(H)}" rx="10" fill="${C.card}"/>`;
const wordmark = (x, y, w) => `<image class="wordmark" data-m="wm" href="${WORDMARK_URL}" x="${x}" y="${n1(y)}" width="${w}" height="${n1(w * WM_ASPECT)}"/>`;
const WM_W = 300;  // the wordmark's width: twice the old 150
const corner = (W, H) => wordmark(W - 36 - WM_W, H - 20 - WM_W * WM_ASPECT, WM_W);
// A footer note, wrapped so it stays clear of the wordmark (whose left edge is wmX, by default
// in the corner): its last line on H - 26, the lines before it stacked above.
function footLines(str, W, size, wmX = W - 36 - WM_W) {
  const max = wmX - 24 - 36;
  const lines = [''];
  for (const word of str.split(' ')) {
    const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${word}` : word;
    if (textWidth(next, size) * 0.94 > max && lines[lines.length - 1]) lines.push(word);  // regular, not bold
    else lines[lines.length - 1] = next;
  }
  return lines;
}
function footnote(str, W, H, size = 11.5, wmX = W - 36 - WM_W) {
  const lines = footLines(str, W, size, wmX), lh = size * 1.4;
  return lines.map((l, i) => text(36, H - 26 - lh * (lines.length - 1 - i), l, `font-size="${size}" fill="${C.faint}"`, i ? `foot${i}` : 'foot')).join('');
}
const text = (x, y, s, attrs = '', m = null) => `<text${m ? ` data-m="${esc(m)}"` : ''} x="${n1(x)}" y="${n1(y)}" ${attrs}>${esc(s)}</text>`;
const head = (x, y, s, anchor, m, fill = C.faint, size = 11) => text(x, y, s.toUpperCase(), `font-size="${n1(size)}" font-weight="600" letter-spacing="${n1(size * 0.145)}" fill="${fill}" text-anchor="${anchor}"`, m);

// kpiX: where to centre the KPI box (the drilldown puts it over the league card); otherwise it
// is centred between the season's longest title line and the right edge
function header(W, ctx, subtitle, kpiX = null) {
  const { info, unit, target, model } = ctx;
  const f = formats(target);
  // shaded by the value's standing among the season's established pitches (app.js kpiShade)
  const col = kpiColor(ctx.kpi ? ctx.kpi.t : kpiT(target, unit));
  const val = f.v(unit.exact);
  // KPI: "{stat} {value}". A plus score is its own stat (Stuff+, PLV+); anything else is the
  // stat over "(<model>)", centred, and the value is twice the label's size to span both.
  // The box spans the title and subtitle, top of the name (24) to under the subtitle (158),
  // and everything in it scales with it (K: against the old 98-tall box).
  const lines = isPlus(target) ? [MODELS[model].title] : [TARGET_NAMES[target], `(${MODELS[model].short})`];
  const BY = 24, BH = 134, K = BH / 98;
  const LS = 21 * K, VS = 2 * LS, pad = 22 * K, cy = BY + BH / 2, gap = 16 * K;
  const one = lines.length === 1, size = one ? VS : LS;  // a one-line plus label matches its value
  const lw = Math.max(...lines.map((l) => textWidth(l, size)));
  const vw = textWidth(val, VS);
  const bw = pad + lw + gap + vw + pad;
  // centred between where the season's longest title line ends (ctx.titleRight, so the box
  // sits still from pitcher to pitcher) and the card's right edge
  const right = ctx.titleRight ?? titleRight([info.pitcher_name]);
  const kx = kpiX == null ? Math.min(W - 12 - bw, (right + W) / 2 - bw / 2)
    : Math.max(right + 24, Math.min(W - 12 - bw, kpiX - bw / 2));
  const lx = kx + pad + lw / 2, vx = kx + pad + lw + gap;
  const base = one ? [cy + 15 * K] : [cy - 3.5 * K, cy + 18.5 * K];  // one line shares the value's baseline
  const lab = `font-size="${n1(size)}" font-weight="700" fill="#fff" text-anchor="middle"`;
  // the title: the pitcher in teal (a quarter larger) over the pitch type in its own colour, from
  // the KPI box's top (24); the subtitle close under both, on the box's bottom (158)
  return text(36, 63, info.pitcher_name, `font-size="${NAME_SIZE}" font-weight="700" fill="${C.teal}"`, 'title')
    + text(36, 115, PITCH_NAMES[info.pt] || info.pt, `font-size="${PT_SIZE}" font-weight="700" fill="${PITCH_COLORS[info.pt] || C.ink}"`, 'title2')
    + text(36, 154, subtitle, `font-size="18" fill="${C.muted}"`, 'sub')
    + `<rect data-m="kbox" x="${n1(kx)}" y="${BY}" width="${n1(bw)}" height="${BH}" rx="${n1(14 * K)}" fill="${C.card}" stroke="${col}" stroke-width="3"/>`
    + lines.map((l, i) => text(lx, base[i], l, lab, `klabel${i}`)).join('')
    + text(vx, cy + 15 * K, val, `font-size="${n1(VS)}" font-weight="700" fill="${col}"`, 'kval');
}

// ======================================================================================
// flow: arsenal -> waterfall -> league panel
// ======================================================================================

export const FLOW = { W: 1200, Y0: 232, RH: 46, PH: 380 };  // PH: the league card's least height
export const FLOW_ASPECT = 16 / 9;  // the drilldown's shape (width / height), on screen and copied
// The drilldown's least text size. On a desktop the 16:9 figure (2133 wide at 1200 tall) shows at
// about 1200 px, so 18 units is 10 px on screen.
const FLOW_MIN = 18;
// the league card's text sizes: FLOW_MIN, with the title and highlighted line at the waterfall's
// label size (dot: the pitcher's marker's radius)
const flowPanelText = (FS) => ({ title: FS, sub: FLOW_MIN, tick: FLOW_MIN, axis: FLOW_MIN, zone: FLOW_MIN, hi: FS, line: FLOW_MIN, foot: FLOW_MIN, none: FLOW_MIN, dot: 13 });
const HILITE = 0.16;         // the selected row's tint: the same colour and opacity as its funnel
const CONNECTOR = '#B4BECC';  // the waterfall's bar-to-bar connectors

// The width of bold text in DM Sans, measured on a canvas once the font is in (app.js waits for
// it), else estimated per character.
let measurer = null;
function textWidth(str, size) {
  if (document.fonts && document.fonts.check(`700 ${size}px "DM Sans"`)) {
    measurer ??= document.createElement('canvas').getContext('2d');
    measurer.font = `700 ${size}px "DM Sans"`;
    return measurer.measureText(str).width;
  }
  let w = 0;
  for (const ch of str) w += /[.,:]/.test(ch) ? 0.28 : /[0-9]/.test(ch) ? 0.58 : 0.6;
  return w * size;
}
let panelPoints = null;  // the panel's dots in figure coordinates, for the hover lookup

// The figure is 16:9 (FLOW_ASPECT): 1200 tall (more if the rows need it) and as wide as that
// makes it. The width past the old square's 1200 goes to the arsenal's labels as they need it,
// then to the row names, the bars, the funnel and the league card.
export function flowSvg(ctx) {
  const { Y0, RH, PH } = FLOW;
  const { rows, unit, target, model, season, info, arsenal, selected, pool, poolLabel } = ctx;
  const f = formats(target);
  const good = targetGood(target);
  const label = targetName(model, target);
  const note = ctx.model === 'location' ? `${label} points (average 100, SD 15): location's change in each outcome rate (PLV vs Stuff at the same count) × its run value at the count, vs league`
    : ctx.byOutcome ? `${label} points (average 100, SD 15): each predicted outcome rate × its average run value, vs league`
    : f.unit === 'pts' ? `${label} points (average 100, SD 15)`
    : f.unit === 'wOBA' ? `wOBA on contact (league ${woba(unit.league)})`
    : f.unit === 'runs' ? `Expected runs per 9 IP (league ERA ${unit.league.toFixed(2)})`
      : `Per-pitch probability (league ${unit.league.toFixed(1)}%)`;
  const foot = `${note}; ${ctx.byOutcome ? 'an exact split, no proxy' : 'feature contributions from a proxy model'}. ${good > 0 ? 'Gold raises, teal lowers' : 'Gold lowers, teal raises'}.`;
  // The body takes whatever height makes H = 1200, or more if the rows, the league card or the
  // arsenal need it. Rows and pitch types are spread evenly
  // over it; bars thicken a little with the spacing (up to 1.5x the card's), and the league
  // card grows with the body.
  const BB = Math.max(rows.length * RH, PH, arsenal.length * 22, FLOW.W - Y0 - 118);
  const S = BB / rows.length;              // row pitch
  const BAR = Math.min(S * 0.6, RH * 0.9);  // bar thickness
  // the arsenal's labels (pitch type over value, or both on one line for a thin band) end at
  // AX - 10, at least 20 from the edge: the columns right of them shift over to make room
  const armW = Math.max(0, ...arsenal.map((p) => {
    const v = p.unit ? f.v(p.unit.exact) : '–';
    return Math.max(textWidth(p.pt, 28), textWidth(v, 24), textWidth(`${p.pt} ${v}`, 22));
  }));
  const AX = Math.max(94, Math.ceil(30 + armW)), shift = AX - 94;
  // columns, at the old square's 1200: arsenal labels | bands 94-108 | ribbon | row names (end 440)
  // | bars 452-832 | ribbon | panel 888-1164. Of the extra width, a quarter goes to the names, a
  // third or so each to the bars and the card, and the rest to the funnel. The wordmark is
  // centred under the card (wmX: its left edge).
  const columns = (W) => {
    const extra = W - FLOW.W - shift;
    const LX = n1(440 + shift + 0.25 * extra), X1 = n1(832 + shift + 0.6 * extra), HX1 = X1 + 16;
    const PX = n1(HX1 + 40 + 0.05 * extra), PW = W - 36 - PX;
    return { LX, X0: LX + 12, X1, HX0: 208 + shift, HX1, PX, PW, wmX: n1(PX + PW / 2 - WM_W / 2) };
  };
  // under the body: tick labels, the axis label, then the footnote (a line taller per extra line;
  // counted at the one-line height's width, where the wordmark sits furthest left)
  const H1 = Y0 + BB + 130;
  const footN = footLines(foot, Math.round(H1 * FLOW_ASPECT), FLOW_MIN, columns(Math.round(H1 * FLOW_ASPECT)).wmX).length;
  const H = H1 + (footN - 1) * FLOW_MIN * 1.4;
  const W = Math.round(H * FLOW_ASPECT);
  const cols = columns(W);
  const { X1, HX0, HX1, PX, PW, wmX } = cols;
  let { LX, X0 } = cols;  // moved left once the labels' size is known (the waterfall section)
  let s = svgOpen(W, H, 'fig flow-fig');
  s += header(W, ctx, `${season}; Each ${ctx.byOutcome ? 'Outcome' : 'Feature'}'s Contribution to ${kpiName(model, target)}`, PX + PW / 2);
  const pitchCol = PITCH_COLORS[info.pt] || '#c7c7c7';  // the selected row and its funnel

  // ---- arsenal: one band per pitch type, as tall as its share of the pitches ----
  const AW = 14, gap = 8, minH = 20;  // minH: room for a thin band's one-line label
  const total = sum(arsenal.map((p) => p.n));
  const avail = BB - gap * (arsenal.length - 1);
  const small = arsenal.filter((p) => (avail * p.n) / total < minH);
  const bigTotal = total - sum(small.map((p) => p.n));
  const bigAvail = avail - small.length * minH;
  let y = Y0;
  let sel = null;
  for (const p of arsenal) {
    const h = small.includes(p) ? minH : (bigAvail * p.n) / bigTotal;
    const on = p.pt === info.pt;
    const col = PITCH_COLORS[p.pt] || '#c7c7c7';
    s += `<g class="pt${on ? ' on' : ''}" data-pt="${p.pt}" tabindex="0" role="button" aria-label="${esc(`${PITCH_NAMES[p.pt] || p.pt}, ${p.n} pitches`)}">`;
    s += `<rect data-m="bh:${p.pt}" x="0" y="${n1(y - gap / 2)}" width="${AX + AW + 4}" height="${n1(h + gap)}" fill="transparent"/>`;
    s += `<rect data-m="band:${p.pt}" x="${AX}" y="${n1(y)}" width="${AW}" height="${n1(h)}" rx="2" fill="${col}" opacity="${on ? 1 : 0.5}"/>`;
    const cy = y + h / 2;
    const val = p.unit ? f.v(p.unit.exact) : '–';
    if (h >= 56) {
      s += text(AX - 10, cy - 3, p.pt, `font-size="28" font-weight="700" fill="${on ? C.ink : C.muted}" text-anchor="end"`, `bl:${p.pt}`);
      s += text(AX - 10, cy + 25, val, `font-size="24" fill="${on ? C.ink : C.faint}" text-anchor="end"`, `bv:${p.pt}`);
    } else {
      s += text(AX - 10, cy + 8, `${p.pt} ${val}`, `font-size="22" font-weight="600" fill="${on ? C.ink : C.faint}" text-anchor="end"`, `bs:${p.pt}`);
    }
    s += '</g>';
    if (on) sel = { y0: y, y1: y + h, col };
    y += h + gap;
  }
  if (sel) {
    s += `<path class="ribbon" data-f="1" d="${ribbon(AX + AW, sel.y0, sel.y1, 198 + shift, Y0, Y0 + BB)}" fill="${sel.col}" opacity=".16"/>`;
    s += `<rect data-m="bracket" x="${198 + shift}" y="${Y0}" width="3" height="${BB}" rx="1.5" fill="${sel.col}" opacity=".6"/>`;
  }

  // ---- waterfall (shap_values_card.card) ----
  let x = unit.league;
  const path = [x];
  for (const r of rows) { x += r.v; path.push(x); }
  const lo = Math.min(...path), hi = Math.max(...path);
  const pad = Math.max(f.pad, 0.06 * (hi - lo));
  let d0 = lo - pad, d1 = hi + pad * 1.6;
  // Widen the axis until every value, chip and all, fits beside its bar: a drag's number (left
  // of its bar) must clear the row labels, a lift's (right) the funnel.
  // One font size for every row's label, value and sub-label (at 0.8x): the largest at which
  // each label and sub-label fits on one line between the funnel's bracket and the bars, and each
  // label block fits its row's height. Kept between the card's 14.5 and 32 px.
  // Other, Location and Count rows, and every row of the Location model: name only
  const subOf = (r) => (r.k === 'Other' || GROUPS[r.k] || ctx.model === 'location' ? '' : r.detail);
  const per = (str) => textWidth(str, 100) / 100;  // width per px of font size
  const room = LX - (HX0 + 14);
  const FS = Math.max(FLOW_MIN + 4, Math.min(32,
    room / Math.max(...rows.map((r) => per(r.label))),
    room / (0.8 * Math.max(1e-9, ...rows.map((r) => per(subOf(r))))),
    (S * 0.82) / 1.9));
  const SUB = Math.max(FLOW_MIN, FS * 0.8);
  // A row's label and sub-label, centred together on its bar: LB is the label's baseline against
  // the bar's centre (the label's cap top to the sub-label's descender, its baseline 1.1 FS lower)
  const LB = FS * 0.74 - (FS * 0.74 + FS * 1.1 + SUB * 0.24) / 2;
  // The labels at that size leave room between the widest of them (label or sub-label) and the
  // arsenal's bracket (its right edge at 201): the label column moves left until that gap is a
  // quarter of what it was, and the bars take the width
  const textW = Math.max(...rows.map((r) => Math.max(textWidth(r.label, FS), subOf(r) ? textWidth(subOf(r), SUB) * 0.94 : 0)));
  const slack = LX - textW - (201 + shift);
  if (slack > 0) { LX = n1(LX - 0.75 * slack); X0 = LX + 12; }
  // Each row's highlight / hover band [top, bottom]: it covers the row's label and sub-label and
  // meets the next row's halfway between their text (the end rows reach as far past their text),
  // never short of the bar. Text extents: ascent 0.74 and descent 0.24 of the font size.
  const ext = rows.map((r, i) => {
    const cy = Y0 + i * S + S / 2;
    return subOf(r) ? [cy + LB - FS * 0.74, cy + LB + FS * 1.1 + SUB * 0.24] : [cy - FS * 0.39, cy + FS * 0.59];
  });
  const band = ext.map((e, i) => [i ? (ext[i - 1][1] + e[0]) / 2 : null, i < ext.length - 1 ? (e[1] + ext[i + 1][0]) / 2 : null]);
  band.forEach((b, i) => {
    const [t, u] = ext[i], cy = Y0 + i * S + S / 2;
    if (rows.length === 1) { b[0] = cy - BB / 4; b[1] = cy + BB / 4; return; }  // a lone row: half the body
    if (b[0] == null) b[0] = t - (b[1] - u);
    if (b[1] == null) b[1] = u + (t - b[0]);
    b[0] = Math.min(b[0], cy - BAR / 2 - 4);
    b[1] = Math.max(b[1], cy + BAR / 2 + 4);
  });
  // The league card stays within the first row's band top and the last row's bottom, so with
  // either end row selected its edge runs straight on from the highlight's (a lone row's card
  // has the whole body, its funnel widening to it)
  const [CT, CB] = rows.length === 1 ? [Y0, Y0 + BB] : [band[0][0], band[band.length - 1][1]];
  const CARD = Math.min(CB - CT, Math.max(560, PW + 284));  // the league card's height: taller as it widens
  const ROOM_L = LX + 10, ROOM_R = HX1 - 6;
  for (let iter = 0; iter < 8; iter++) {
    const k = (X1 - X0) / (d1 - d0);
    let over = 0, under = 0, at = unit.league;
    for (const r of rows) {
      const end = at + r.v;
      const tw = textWidth(f.d(r.v), FS) + 11;  // gap to the bar, chip padding
      if (r.v >= 0) over = Math.max(over, X0 + (Math.max(at, end) - d0) * k + tw - ROOM_R);
      else under = Math.max(under, ROOM_L - (X0 + (Math.min(at, end) - d0) * k - tw));
      at = end;
    }
    if (over <= 0.5 && under <= 0.5) break;
    if (under > 0) d0 -= (under + 2) / k;
    if (over > 0) d1 += (over + 2) / k;
  }
  const sx = (v) => n1(lin(d0, d1, X0, X1)(v));
  // Layers, bottom to top: row highlights (tinted like the funnel they feed), gridlines, the
  // league line, bars and connectors, the final-value line, then the labels. Each row is split
  // across the layers as <g class="row fx" data-k>, so hover, focus and clicks still see one row.
  let back = '', bars = '', front = '';
  x = unit.league;
  let selRow = null;
  rows.forEach((r, i) => {
    const cy = Y0 + i * S + S / 2;
    const end = x + r.v;
    const col = good * r.v > 0 ? C.gold : C.teal;
    const on = r.k === selected;
    const g = `<g class="row fx${on ? ' sel' : ''}" data-k="${r.k}"`;
    back += `${g} tabindex="0" role="button" aria-label="${esc(`${r.label} ${f.d(r.v)}`)}">`
      + `<rect class="hit" data-m="hit:${r.k}" x="${HX0}" y="${n1(band[i][0])}" width="${HX1 - HX0}" height="${n1(band[i][1] - band[i][0])}" rx="8" fill="${pitchCol}" fill-opacity="0"/></g>`;
    const a = sx(Math.min(x, end)), b = sx(Math.max(x, end));
    const w = Math.max(1, n1(b - a));
    bars += `${g}><rect data-m="bar:${r.k}" x="${a}" y="${n1(cy - BAR / 2)}" width="${w}" height="${n1(BAR)}" rx="${n1(Math.min(4, w / 2))}" fill="${col}"/>`;
    if (i) bars += `<line data-m="c:${r.k}" x1="${sx(x)}" x2="${sx(x)}" y1="${n1(cy - S + BAR / 2)}" y2="${n1(cy - BAR / 2)}" stroke="${CONNECTOR}" stroke-width="1.5"/>`;
    bars += '</g>';
    // the lift, on a translucent chip so it reads over the league and final-value lines
    const right = r.v >= 0;
    const val = f.d(r.v);
    const tw = textWidth(val, FS), tx = right ? b + 7 : a - 7, ch = FS + 7;
    front += `${g}><rect data-m="vb:${r.k}" x="${n1(right ? tx - 4 : tx - tw - 4)}" y="${n1(cy - ch / 2)}" width="${n1(tw + 8)}" height="${n1(ch)}" rx="4" fill="${C.card}" fill-opacity=".8"/>`;
    front += text(tx, cy + FS * 0.35, val, `font-size="${n1(FS)}" font-weight="700" fill="${C.ink}" text-anchor="${right ? 'start' : 'end'}"`, `v:${r.k}`);
    // Other, Location and Count carry no sub-label here (the tooltip and league panel say more)
    const sub = subOf(r);
    front += text(LX, sub ? cy + LB : cy + FS * 0.35, r.label, `font-size="${n1(FS)}" font-weight="700" fill="${C.ink}" text-anchor="end"`, `l:${r.k}`);
    if (sub) front += text(LX, cy + LB + FS * 1.1, sub, `font-size="${n1(SUB)}" fill="${C.muted}" text-anchor="end"`, `dt:${r.k}`);
    front += '</g>';
    if (on) selRow = { cy, col, r, top: band[i][0], bottom: band[i][1] };
    x = end;
  });
  // The selected row's highlight and its funnel to the league panel are one shape, rounded on
  // the left only, so the band runs into the ribbon with no seam or pinch.
  const py = selRow ? Math.max(CT, Math.min(CB - CARD, (selRow.top + selRow.bottom) / 2 - CARD / 2)) : 0;
  if (selRow) {
    const y0 = n1(selRow.top), y1 = n1(selRow.bottom), b0 = n1(py), b1 = n1(py + CARD);  // the card's full height
    const rr = 8, m = n1((HX1 + PX) / 2);
    const d = `M${HX0 + rr},${y0}L${HX1},${y0}C${m},${y0} ${m},${b0} ${PX},${b0}L${PX},${b1}C${m},${b1} ${m},${y1} ${HX1},${y1}`
      + `L${HX0 + rr},${y1}Q${HX0},${y1} ${HX0},${n1(y1 - rr)}L${HX0},${n1(y0 + rr)}Q${HX0},${y0} ${HX0 + rr},${y0}Z`;
    s += `<g class="row fx sel" data-k="${selRow.r.k}"><path class="ribbon" data-f="1" d="${d}" fill="${pitchCol}" opacity="${HILITE}" pointer-events="none"/></g>`;
  }
  s += back;
  for (const t of niceTicks(d0, d1, 6)) {
    s += `<line data-m="g:${t}" x1="${sx(t)}" x2="${sx(t)}" y1="${Y0 - 6}" y2="${Y0 + BB + 4}" stroke="${C.grid}" stroke-width="1" pointer-events="none"/>`;
    s += text(sx(t), Y0 + BB + 4 + 8 + FLOW_MIN, f.tick(t), `font-size="${FLOW_MIN}" fill="${C.muted}" text-anchor="middle"`, `t:${t}`);
  }
  s += text((X0 + X1) / 2, Y0 + BB + 4 + 8 + FLOW_MIN + 10 + FLOW_MIN, f.unit !== 'pp' || label.includes('%') ? label : `${label}, %`, `font-size="${FLOW_MIN}" fill="${C.muted}" text-anchor="middle"`, 'xlab');
  // the AVG label at the feature labels' size (FS); its box's height, and its and the arrow's
  // centre line, the box's bottom 9 over the body
  const AH = n1(FS * 1.2 + 6), AY = n1(Y0 - 9 - AH / 2);
  s += `<line data-m="league" x1="${sx(unit.league)}" x2="${sx(unit.league)}" y1="${n1(AY + AH / 2)}" y2="${Y0 + BB + 4}" stroke="#fff" stroke-width="1.2" pointer-events="none"/>`;
  s += bars;
  s += `<line data-m="exact" x1="${sx(x)}" x2="${sx(x)}" y1="${AY}" y2="${Y0 + BB + 4}" stroke="#fff" stroke-width="1.6" stroke-dasharray="6 5" pointer-events="none"/>`;
  // "AVG" boxed over the league line, and an arrow in the KPI box's colour from it to the
  // final value (none when the two nearly meet)
  const ax = sx(unit.league), ex = sx(x);
  const aw = textWidth('AVG', FS) + FS * 1.1;
  s += `<rect data-m="avgbox" x="${n1(ax - aw / 2)}" y="${n1(AY - AH / 2)}" width="${n1(aw)}" height="${AH}" rx="${n1(FS * 0.2)}" fill="${C.card}" stroke="#fff" stroke-width="1.4"/>`;
  s += text(ax, AY + FS * 0.36, 'AVG', `font-size="${n1(FS)}" font-weight="700" letter-spacing="${n1(FS * 0.05)}" fill="#fff" text-anchor="middle"`, 'avg');
  const dir = ex >= ax ? 1 : -1, from = ax + dir * (aw / 2 + 3);
  if (dir * (ex - from) > 24) {  // line 5 wide, head 20 long and 24 across
    const kcol = kpiColor(ctx.kpi ? ctx.kpi.t : kpiT(target, unit));
    s += `<line data-m="arrow" x1="${n1(from)}" x2="${n1(ex - dir * 16)}" y1="${AY}" y2="${AY}" stroke="${kcol}" stroke-width="5" stroke-linecap="round"/>`;
    s += `<path data-m="arrowhead" d="M${ex},${AY}L${n1(ex - dir * 20)},${AY - 12}L${n1(ex - dir * 20)},${AY + 12}Z" fill="${kcol}"/>`;
  }
  s += front;

  // ---- league panel for the selected row ----
  panelPoints = null;
  if (selRow) {
    s += panel(ctx, selRow.r, PX, py, PW, CARD, pool, poolLabel, flowPanelText(FS));
  }

  s += footnote(foot, W, H, FLOW_MIN, wmX);
  s += wordmark(wmX, H - 20 - WM_W * WM_ASPECT, WM_W);
  return s + '</svg>';
}

// The selected row among the league's units: its SHAP against the unit's mean input (the
// dependence plot of shap_analysis.py, one dot per pitcher x pitch type rather than per pitch),
// a binned mean through it, and the pitcher's own dot. Location and Count plot the two inputs
// against each other instead, coloured by the row's SHAP.
// T: the text sizes (flowPanelText); the lines and the plot's
// margins follow from them.
function panel(ctx, r, x, y, w, h, pool, poolLabel, T) {
  const { unit, info, target } = ctx;
  // the target, as the y axis and the value line name it: Stuff+, SwStr%, ERA, wOBAcon
  const tname = isPlus(target) ? MODELS[ctx.model].title : TARGET_NAMES[target];
  const val = ctx.rowValueOf || ((k, p) => rowValue(k, p.unit));
  const inp = ctx.rowInputOf || ((k, p) => rowInput(k, p.info));
  const f = formats(target);
  const good = targetGood(target);
  // square on the left, where the funnel meets it edge to edge; rounded on the right
  const rr = 12, y0 = n1(y), y1 = n1(y + h), x1 = x + w;
  // (the phone card stands alone, so it is rounded all round)
  let s = `<path data-m="pbox" d="M${x},${y0}L${x1 - rr},${y0}Q${x1},${y0} ${x1},${n1(y0 + rr)}L${x1},${n1(y1 - rr)}Q${x1},${y1} ${x1 - rr},${y1}L${x},${y1}Z" fill="${C.raise}"/>`;
  // the Location card plots each unit's average location, and says so
  const tx = x + 16, ta = '';
  const t1 = y + 13 + T.title, t2 = t1 + T.sub * 1.55;  // title and pool baselines
  s += text(tx, t1, r.k === 'Location' ? 'Average Location' : r.label, `font-size="${n1(T.title)}" font-weight="700" fill="${C.ink}"${ta}`, 'ptitle');
  s += text(tx, t2, poolLabel.replace(/ \(\d+\+ pitches\)$/, ''), `font-size="${n1(T.sub)}" fill="${C.muted}"${ta}`, 'psub');
  const grouped = GROUPS[r.k];
  const zone = r.k === 'Location';  // drawn as a strike zone, no axes
  // the lines under the plot, bottom up: the minimum, the input, the highlighted value
  // (Other has two input lines: its residual, then what it folds in)
  const LH = T.line * 1.6 + 1.6;
  const b3 = y + h - 8 - T.foot, b2 = b3 - LH, b2a = r.k === 'Other' ? b2 - LH : b2, b1 = b2a - T.hi * 1.4 - 1.8;
  // the plot: under the pool line; over the x ticks and axis label (or the zone's Inside/Away)
  const tickGap = 5 + T.tick, xlabGap = tickGap + 6 + T.axis * 1.1;
  const py0 = t2 + 18, py1 = b1 - T.hi * 1.5 - (zone ? 5 + T.zone : xlabGap);
  const pts = [];
  for (const p of pool) {
    const v = val(r.k, p);
    if (!Number.isFinite(v)) continue;
    let xv, yv;
    if (grouped) { xv = p.info[grouped[0]]; yv = p.info[grouped[1]]; } else { xv = inp(r.k, p); yv = v; }
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    if (r.k === 'Other') xv = Math.log10(xv);
    if (r.k === 'Location') xv = -xv;  // x_b is + = inside: drawn with inside on the left (the zone's "Inside" side)
    if (r.k === 'lefty') xv += (((p.info.pitcher * 2654435761) % 1000) / 1000) * 0.3 - 0.15;  // strip-plot jitter
    pts.push({ xv, yv, v, id: p.info.pitcher, name: p.info.pitcher_name, pt: p.info.pt, info: p.info, me: p.info.pitcher === info.pitcher && p.info.pt === info.pt });
  }
  const me = pts.find((p) => p.me);
  if (!me) return s + text(x + 16, t2 + 18 + T.none * 2, 'No league units to compare.', `font-size="${T.none}" fill="${C.muted}"`, 'pnone');
  // robust extents: 1st-99th percentile, widened to include the pitcher
  const xs = pts.map((p) => p.xv).sort((a, b) => a - b), ys = pts.map((p) => p.yv).sort((a, b) => a - b);
  let xa = Math.min(quantile(xs, 0.01), me.xv), xb = Math.max(quantile(xs, 0.99), me.xv);
  let ya = Math.min(quantile(ys, 0.01), me.yv), yb = Math.max(quantile(ys, 0.99), me.yv);
  if (xa === xb) { xa -= 0.5; xb += 0.5; }
  if (ya === yb) { ya -= 0.5; yb += 0.5; }
  const xpad = (xb - xa) * 0.06, ypad = (yb - ya) * 0.08;
  xa -= xpad; xb += xpad; ya -= ypad; yb += ypad;
  let yfmt = grouped ? (r.k === 'Location' ? (v) => `${Math.round(v * 100)}%` : (v) => `${+v.toFixed(2)}`) : f.tick;
  // tiny values (a lone Other row's residual) can round every tick to one label: then as many
  // decimals as the tick step needs
  const yt = niceTicks(ya, yb, 4);
  if (new Set(yt.map(yfmt)).size < yt.length && yt.length > 1) {
    const dp = Math.max(0, Math.ceil(-Math.log10(Math.abs(yt[1] - yt[0])) - 1e-9));
    yfmt = (v) => `${+v.toFixed(dp)}`;
  }
  // left of the plot: the rotated y label, then the y ticks (as wide as the widest)
  const ylabX = x + 8 + T.axis * 0.75;
  const ytw = Math.max(0, ...niceTicks(ya, yb, 4).map((t) => textWidth(yfmt(t), T.tick) * 0.94));
  const px0 = zone ? x + 20 : n1(ylabX + T.axis * 0.4 + 8 + ytw + 6), px1 = x + w - (zone ? 20 : 16);
  const ZW = 17 / 12, ZASPECT = 17 / 22;  // the zone's width (ft) and width / height
  if (zone) {
    // a frame round the zone and the league's 1st-99th percentile of locations, at the zone's
    // true proportions (x in ft, y in zone heights), centred on the plate
    const pw = px1 - px0, ph = py1 - py0;
    const lo = Math.min(quantile(ys, 0.01), me.yv, -0.05) - 0.08, hi = Math.max(quantile(ys, 0.99), me.yv, 1.05) + 0.08;
    const half = Math.max(Math.abs(quantile(xs, 0.01)), Math.abs(quantile(xs, 0.99)), Math.abs(me.xv), ZW / 2) * 1.15;
    let zh = ph / (hi - lo);                              // px per zone height
    let k = (zh * ZASPECT) / ZW;                          // px per ft, at the zone's proportions
    if (pw / k < 2 * half) { k = pw / (2 * half); zh = (ZW * k) / ZASPECT; }  // too narrow: fit x
    const mid = (lo + hi) / 2;
    [xa, xb] = [-pw / (2 * k), pw / (2 * k)];
    [ya, yb] = [mid - ph / (2 * zh), mid + ph / (2 * zh)];
  }
  const sxr = lin(xa, xb, px0, px1), syr = lin(ya, yb, py1, py0);
  const cx = (v) => n1(Math.max(px0, Math.min(px1, sxr(v)))), cy = (v) => n1(Math.max(py0, Math.min(py1, syr(v))));
  const xfmt = (v) => (r.k === 'Other' ? String(Math.round(10 ** v)) : PCT.has(r.k) ? `${Math.round(v * 100)}%` : r.k === 'lefty' ? (Math.round(v) ? 'LHP' : 'RHP') : `${+v.toFixed(2)}`);
  for (const t of zone ? [] : niceTicks(ya, yb, 4)) {
    s += `<line data-m="pg:${t}" x1="${px0}" x2="${px1}" y1="${n1(syr(t))}" y2="${n1(syr(t))}" stroke="${C.grid}"/>`;
    s += text(px0 - 6, syr(t) + T.tick * 0.35, yfmt(t), `font-size="${T.tick}" fill="${C.faint}" text-anchor="end"`, `py:${t}`);
  }
  const xticks = zone ? [] : r.k === 'lefty' ? [0, 1] : niceTicks(xa, xb, 4);
  for (const t of xticks) s += text(sxr(t), py1 + tickGap, xfmt(t), `font-size="${T.tick}" fill="${C.faint}" text-anchor="middle"`, `px:${t}`);
  if (!grouped && ya < 0 && yb > 0) s += `<line data-m="pzero" x1="${px0}" x2="${px1}" y1="${n1(syr(0))}" y2="${n1(syr(0))}" stroke="#fff" stroke-opacity=".5"/>`;
  const xl = grouped ? (r.k === 'Location' ? 'Horizontal location (ft, + = inside)' : 'Balls before the pitch')
    : r.k === 'Other' ? 'Pitches (log scale)' : ctx.axisOf ? ctx.axisOf(r.k) : AXIS[r.k] || LABELS[r.k];
  if (!zone) s += text((px0 + px1) / 2, py1 + xlabGap, xl, `font-size="${T.axis}" fill="${C.muted}" text-anchor="middle"`, 'pxlab');
  // the y axis is the row's contribution to the target, so it is named for the target ("Stuff+",
  // "SwStr%", "ERA", "wOBAcon"); Count plots its strikes there instead
  const yl = grouped ? (r.k === 'Location' ? 'Vertical location (zone height)' : 'Strikes before the pitch')
    : tname;
  if (!zone) s += `<text data-m="pylab" transform="translate(${n1(ylabX)},${n1((py0 + py1) / 2)}) rotate(-90)" font-size="${T.axis}" fill="${C.muted}" text-anchor="middle">${esc(yl)}</text>`;

  // dots, keyed by unit so they glide from one row's chart to the next
  const vs = pts.map((p) => p.v).sort((a, b) => a - b);
  const vmax = Math.max(Math.abs(quantile(vs, 0.02)), Math.abs(quantile(vs, 0.98)), 1e-9);
  const dotFill = (p) => (grouped ? kpiColor((good * p.v) / vmax) : C.muted);
  let dots = '';
  for (const p of pts) {
    if (p.me) continue;
    dots += `<circle data-m="d:${p.id}|${p.pt}" cx="${cx(p.xv)}" cy="${cy(p.yv)}" r="2.3" fill="${dotFill(p)}" fill-opacity="${grouped ? 0.75 : 0.42}"/>`;
  }
  s += `<g class="dots">${dots}</g>`;
  // binned means (shap_analysis.dependence): quantile bins of the input
  if (!grouped && r.k !== 'lefty') {
    const sorted = pts.slice().sort((a, b) => a.xv - b.xv);
    const nb = Math.min(12, Math.floor(sorted.length / 15));
    if (nb >= 3) {
      const line = [];
      for (let b = 0; b < nb; b++) {
        const part = sorted.slice(Math.floor((b * sorted.length) / nb), Math.floor(((b + 1) * sorted.length) / nb));
        line.push([sum(part.map((p) => p.xv)) / part.length, sum(part.map((p) => p.yv)) / part.length]);
      }
      s += `<path data-f="1" d="M${line.map(([a, b]) => `${cx(a)},${cy(b)}`).join('L')}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round"/>`;
    }
  }
  const own = val(r.k, { unit, info });
  // the marker and its value line share a colour: for Other, the row's full value's (its bar's)
  const mcol = good * (r.k === 'Other' ? r.v : own) > 0 ? C.gold : C.teal;
  if (zone) {
    const zl = sxr(-ZW / 2), zr = sxr(ZW / 2), zt = syr(1), zb = syr(0);
    s += `<rect data-m="zone" x="${n1(zl)}" y="${n1(zt)}" width="${n1(zr - zl)}" height="${n1(zb - zt)}" fill="none" stroke="#fff" stroke-width="1.6" pointer-events="none"/>`;
    s += text(zl, zb + 5 + T.zone, 'Inside', `font-size="${T.zone}" font-weight="600" fill="${C.muted}" text-anchor="start" pointer-events="none"`, 'zin');
    s += text(zr, zb + 5 + T.zone, 'Away', `font-size="${T.zone}" font-weight="600" fill="${C.muted}" text-anchor="end" pointer-events="none"`, 'zaway');
  }
  s += `<circle data-m="pme" cx="${cx(me.xv)}" cy="${cy(me.yv)}" r="${T.dot}" fill="${mcol}" stroke="#fff" stroke-width="${n1(T.dot * 0.3)}"/>`;
  s += `<rect class="panel-hit" x="${px0 - 6}" y="${n1(py0 - 6)}" width="${px1 - px0 + 12}" height="${py1 - py0 + 12}" fill="transparent"/>`;

  // the numbers under it
  // ranked in the pitcher's favour: the change that helps the pitcher most is the 100th percentile, so a
  // big drop in ERA or wOBAcon ranks high
  const rank = pctile(vs.map((v) => good * v).sort((a, b) => a - b), good * me.v);
  // Other: the row's full value (its folded rows and the residual), as its bar shows it; the
  // plot and the percentile are the residual's
  if (r.k === 'Other') {
    s += text(tx, b1, `${f.d(r.v)} ${tname}`, `font-size="${n1(T.hi)}" font-weight="700" fill="${mcol}"${ta}`, 'pl1');
    s += text(tx, b2a, `Residual ${f.d(own)} ${tname} · ${ord(rank)} percentile`, `font-size="${T.line}" fill="${C.muted}"${ta}`, 'pl2a');
  } else {
    // shrunk only if it would run past the card's edge
    const hi = `${f.d(own)} ${tname} (${ord(rank)} percentile)`;
    const hs = Math.min(T.hi, (T.hi * (w - 32)) / textWidth(hi, T.hi));
    s += text(tx, b1, hi, `font-size="${n1(hs)}" font-weight="700" fill="${mcol}"${ta}`, 'pl1');
  }
  let line2 = r.detail || '';
  if (grouped) line2 = '';
  else if (r.k !== 'Other' && r.k !== 'lefty') {
    const xin = inp(r.k, { unit, info });
    const what = ctx.byOutcome
      ? (r.k === 'leverage' ? `Strikes − balls ${sgn(xin, 2)}` : ctx.model === 'location' ? `Rate change ${sgn(xin, 1)} pp` : `Predicted rate ${xin.toFixed(1)}%`)
      : `${r.k === 'baseline' ? 'Same-hand share' : 'Input'} ${r.k === 'baseline' ? xfmt(xin) : r.detail}`;
    if (Number.isFinite(xin)) line2 = `${what} · ${ord(pctile(pts.map((p) => p.xv), xin))} percentile`;
  }
  s += text(tx, b2, line2, `font-size="${T.line}" fill="${C.muted}"${ta}`, 'pl2');
  const minN = ctx.minN ?? 1;
  s += text(tx, b3, `Min ${minN} pitch${minN === 1 ? '' : 'es'} thrown`, `font-size="${T.foot}" fill="${C.faint}"${ta}`, 'pl3');
  panelPoints = { pts: pts.map((p) => ({ ...p, fx: cx(p.xv), fy: cy(p.yv) })) };
  return s;
}

export function nearestPanelPoint(fx, fy, maxDist = 12) {
  if (!panelPoints) return null;
  let best = null, bd = maxDist * maxDist;
  for (const p of panelPoints.pts) {
    const d = (p.fx - fx) ** 2 + (p.fy - fy) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ======================================================================================
// the drilldown on a phone: a one-line header and the waterfall, drawn at the screen's own
// pixel width (1 unit = 1 CSS px, so no text is under 11 px). Its rows are static, and there is
// no league card (nor beeswarm or Sankey) on a phone.
// ======================================================================================

const PHONE_MIN = 11;  // the smallest text on a phone, in CSS px

// wrap a note into lines no wider than max at the given size
function wrapLines(str, size, max) {
  const lines = [''];
  for (const word of str.split(' ')) {
    const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${word}` : word;
    if (textWidth(next, size) * 0.94 > max && lines[lines.length - 1]) lines.push(word);
    else lines[lines.length - 1] = next;
  }
  return lines;
}

export function phoneFlowSvg(ctx, W) {
  const { rows, unit, target, model, info } = ctx;
  const f = formats(target);
  const good = targetGood(target);
  const P = 12;  // side margin
  const pitchCol = PITCH_COLORS[info.pt] || '#c7c7c7';

  // ---- header: the desktop's, at phone sizes. The pitcher (teal) over the full pitch type
  // (its colour), the KPI box under it, both centred, then the subtitle ----
  const kcol = kpiColor(ctx.kpi ? ctx.kpi.t : kpiT(target, unit));
  const kv = f.v(unit.exact);
  const kLines = isPlus(target) ? [MODELS[model].title] : [TARGET_NAMES[target], `(${MODELS[model].short})`];
  const one = kLines.length === 1;
  const KLS = 12, KVS = 24, KLSZ = one ? KVS : KLS;  // a one-line plus label matches its value
  const klw = Math.max(...kLines.map((l) => textWidth(l, KLSZ))), kvw = textWidth(kv, KVS);
  const BW = 12 + klw + 10 + kvw + 12, BH0 = 56;
  const ptName = PITCH_NAMES[info.pt] || info.pt;
  const titleW = (sz) => Math.max(textWidth(info.pitcher_name, sz), textWidth(ptName, sz));
  // title and KPI box each centred across the screen, the box under the title
  let NS = 22;
  while (NS > 14 && P + titleW(NS) > W - P) NS -= 0.5;
  const T0 = 12;  // the header's top
  const t1 = T0 + NS * 0.74, t2 = t1 + NS * 1.12;  // the title's baselines
  const titleBottom = t2 + NS * 0.26;
  const bx = (W - BW) / 2, by = titleBottom + 8;
  // the card's navy ground (svgOpen's first fill is its background)
  let s = svgOpen(W, 100, 'fig flow-fig phone').replace(`fill="${C.card}"`, `fill="${K.ground}"`);  // height set at the end
  s += text(W / 2, t1, info.pitcher_name, `font-size="${NS}" font-weight="700" fill="${C.teal}" text-anchor="middle"`, 'title');
  s += text(W / 2, t2, ptName, `font-size="${NS}" font-weight="700" fill="${pitchCol}" text-anchor="middle"`, 'title2');
  const bcy = by + BH0 / 2;
  s += `<rect data-m="kbox" x="${n1(bx)}" y="${n1(by)}" width="${n1(BW)}" height="${BH0}" rx="10" fill="${K.ground}" stroke="${kcol}" stroke-width="2"/>`;
  const lbase = one ? [bcy + KVS * 0.36] : [bcy - 2, bcy + KLS + 1];
  kLines.forEach((l, i) => { s += text(bx + 12 + klw / 2, lbase[i], l, `font-size="${KLSZ}" font-weight="700" fill="#fff" text-anchor="middle"`, `klabel${i}`); });
  s += text(bx + 12 + klw + 10, bcy + KVS * 0.36, kv, `font-size="${KVS}" font-weight="700" fill="${kcol}"`, 'kval');
  // the season under it, as the card's header has it
  const sy0 = Math.max(titleBottom, by + BH0) + 20;
  s += text(W / 2, sy0, String(ctx.season), `font-size="12" fill="${K.sub}" text-anchor="middle"`, 'sub');
  const headerBottom = sy0;

  // ---- the waterfall's tile, as the card's: titled, its edges TP in from the figure's ----
  const TP = 6, TY = headerBottom + 14;
  const tLines = wrapLines(`${ctx.byOutcome ? 'Outcome' : 'Feature'} Contributions to ${kpiName(model, target)}`, 15, W - 2 * TP - 24);
  const tile = s.length;  // the tile's rect goes in here, once its height is known
  tLines.forEach((l, i) => { s += text(TP + 12, TY + 24 + i * 19, l, `font-size="15" font-weight="700" fill="${K.ink}"`, i ? `wtitle${i}` : 'wtitle'); });
  const tTop = TY + 24 + (tLines.length - 1) * 19;

  // ---- the waterfall, full width ----
  const FS = 12.5, SUB = PHONE_MIN, VS = 12;
  // as the card's: names only for Other, Location and Count, the Location model, and every row shown
  const subOf = (r) => (ctx.all || r.k === 'Other' || GROUPS[r.k] || ctx.model === 'location' ? '' : r.detail);
  const LW = Math.max(...rows.map((r) => Math.max(textWidth(r.label, FS), subOf(r) ? textWidth(subOf(r), SUB) * 0.95 : 0)));
  const PI = TP + 12;  // the tile's inner margin
  const LX = PI + LW, X0 = LX + 12, X1 = W - PI - 4;
  const S = ctx.all ? FS + 12 : FS + SUB + 16;  // row pitch (names alone pack closer)
  const BAR = 14;
  const Y0 = tTop + 40, BH = rows.length * S;  // room for the AVG label above the bars
  let x = unit.league;
  const path = [x];
  for (const r of rows) { x += r.v; path.push(x); }
  const lo = Math.min(...path), hi = Math.max(...path);
  const pad = Math.max(f.pad, 0.06 * (hi - lo));
  let d0 = lo - pad, d1 = hi + pad * 1.6;
  const ROOM_L = LX + 6, ROOM_R = W - PI;
  for (let iter = 0; iter < 8; iter++) {  // widen until every value's chip fits beside its bar
    const k = (X1 - X0) / (d1 - d0);
    let over = 0, under = 0, at = unit.league;
    for (const r of rows) {
      const end = at + r.v;
      const tw = textWidth(f.d(r.v), VS) + 9;
      if (r.v >= 0) over = Math.max(over, X0 + (Math.max(at, end) - d0) * k + tw - ROOM_R);
      else under = Math.max(under, ROOM_L - (X0 + (Math.min(at, end) - d0) * k - tw));
      at = end;
    }
    if (over <= 0.5 && under <= 0.5) break;
    if (under > 0) d0 -= (under + 2) / k;
    if (over > 0) d1 += (over + 2) / k;
  }
  const sx = (v) => n1(lin(d0, d1, X0, X1)(v));
  // the rows are static on a phone: no highlight, hover or selection (there is no league card)
  let bars = '', front = '';
  x = unit.league;
  rows.forEach((r, i) => {
    const cy = Y0 + i * S + S / 2;
    const end = x + r.v;
    const col = good * r.v > 0 ? C.gold : C.teal;
    const g = '<g class="prow"';
    const a = sx(Math.min(x, end)), b = sx(Math.max(x, end));
    const w = Math.max(1, n1(b - a));
    // as the card's: square where it starts, rounded where it ends (the pills' 9, at most half the bar)
    bars += `${g}><path data-m="bar:${r.k}" d="${bar(a, cy - BAR / 2, w, BAR, Math.min(9, BAR / 2, w), r.v >= 0)}" fill="${col}"/>`;
    if (i) bars += `<line data-m="c:${r.k}" x1="${sx(x)}" x2="${sx(x)}" y1="${n1(cy - S + BAR / 2)}" y2="${n1(cy - BAR / 2)}" stroke="${K.conn}" stroke-width="1.2"/>`;
    bars += '</g>';
    const right = r.v >= 0;
    const val = f.d(r.v);
    const tw = textWidth(val, VS), tx = right ? b + 5 : a - 5, ch = VS + 5;
    front += `${g}><rect data-m="vb:${r.k}" x="${n1(right ? tx - 3 : tx - tw - 3)}" y="${n1(cy - ch / 2)}" width="${n1(tw + 6)}" height="${n1(ch)}" rx="3" fill="${K.panel}" fill-opacity=".85"/>`;
    front += text(tx, cy + VS * 0.35, val, `font-size="${VS}" font-weight="700" fill="#fff" text-anchor="${right ? 'start' : 'end'}"`, `v:${r.k}`);
    const sub = subOf(r);
    // label and sub-label centred together on the bar (cap top to descender; sub baseline SUB + 3 lower)
    const lb = FS * 0.74 - (FS * 0.74 + SUB + 3 + SUB * 0.24) / 2;
    front += text(LX, sub ? cy + lb : cy + FS * 0.35, r.label, `font-size="${FS}" font-weight="600" fill="${K.ink}" text-anchor="end"`, `l:${r.k}`);
    if (sub) front += text(LX, cy + lb + SUB + 3, sub, `font-size="${SUB}" fill="${K.muted}" text-anchor="end"`, `dt:${r.k}`);
    front += '</g>';
    x = end;
  });
  for (const t of niceTicks(d0, d1, 4)) {
    s += `<line data-m="g:${t}" x1="${sx(t)}" x2="${sx(t)}" y1="${Y0 - 4}" y2="${Y0 + BH + 2}" stroke="${K.line}" stroke-width="1" pointer-events="none"/>`;
    s += text(sx(t), Y0 + BH + 16, f.tick(t), `font-size="${PHONE_MIN}" fill="${K.muted}" text-anchor="middle"`, `t:${t}`);
  }
  const label = targetName(model, target);
  s += text((X0 + X1) / 2, Y0 + BH + 32, f.unit !== 'pp' || label.includes('%') ? label : `${label}, %`, `font-size="${PHONE_MIN}" fill="${K.muted}" text-anchor="middle"`, 'xlab');
  const AY = Y0 - 16;
  // as the card's: the league line dashed, the final value's solid
  s += `<line data-m="league" x1="${sx(unit.league)}" x2="${sx(unit.league)}" y1="${AY + 7}" y2="${Y0 + BH + 2}" stroke="#fff" stroke-opacity=".8" stroke-width="1" stroke-dasharray="4 3" pointer-events="none"/>`;
  s += bars;
  s += `<line data-m="exact" x1="${sx(x)}" x2="${sx(x)}" y1="${AY}" y2="${Y0 + BH + 2}" stroke="#fff" stroke-opacity=".9" stroke-width="1.2" pointer-events="none"/>`;
  const ax = sx(unit.league), ex = sx(x), aw = textWidth('AVG', PHONE_MIN) + 10;
  s += `<rect data-m="avgbox" x="${n1(ax - aw / 2)}" y="${AY - 8}" width="${n1(aw)}" height="16" rx="3" fill="${K.panel}" stroke="#fff" stroke-width="1"/>`;
  s += text(ax, AY + 4, 'AVG', `font-size="${PHONE_MIN}" font-weight="700" fill="#fff" text-anchor="middle"`, 'avg');
  const dir = ex >= ax ? 1 : -1, from = ax + dir * (aw / 2 + 2);
  if (dir * (ex - from) > 10) {
    s += `<line data-m="arrow" x1="${n1(from)}" x2="${n1(ex - dir * 6)}" y1="${AY}" y2="${AY}" stroke="${kcol}" stroke-width="2" stroke-linecap="round"/>`;
    s += `<path data-m="arrowhead" d="M${ex},${AY}L${n1(ex - dir * 8)},${AY - 5}L${n1(ex - dir * 8)},${AY + 5}Z" fill="${kcol}"/>`;
  }
  s += front;

  // ---- footer note, then the wordmark ----
  const note = ctx.model === 'location' ? `${label} points (average 100, SD 15): location's change in each outcome rate (PLV vs Stuff at the same count) × its run value at the count, vs league; an exact split, no proxy.`
    : ctx.byOutcome ? `${label} points (average 100, SD 15): each predicted outcome rate × its average run value, vs league; an exact split, no proxy.`
    : f.unit === 'pts' ? `${label} points (average 100, SD 15); feature contributions from a proxy model.`
    : f.unit === 'wOBA' ? `wOBA on contact (league ${woba(unit.league)}); feature contributions from a proxy model.`
    : f.unit === 'runs' ? `Expected runs per 9 IP (league ERA ${unit.league.toFixed(2)}); feature contributions from a proxy model.`
    : `Per-pitch probability (league ${unit.league.toFixed(1)}%); feature contributions from a proxy model.`;
  const lines = wrapLines(`${note} ${good > 0 ? 'Gold raises, teal lowers' : 'Gold lowers, teal raises'}.`, PHONE_MIN, W - 2 * P);
  const tBottom = Y0 + BH + 44;  // the tile's foot, under the axis label
  s = s.slice(0, tile) + `<rect data-m="wtile" x="${TP}" y="${n1(TY)}" width="${W - 2 * TP}" height="${n1(tBottom - TY)}" rx="8" fill="${K.panel}"/>` + s.slice(tile);
  let fy = tBottom + 20;
  lines.forEach((l, i) => { s += text(W / 2, fy + i * 15, l, `font-size="${PHONE_MIN}" fill="${K.muted}" text-anchor="middle"`, i ? `foot${i}` : 'foot'); });
  fy += (lines.length - 1) * 15;
  const ww = 130;
  s += wordmark((W - ww) / 2, fy + 12, ww);  // centred, like everything on the phone
  const H = fy + 12 + ww * WM_ASPECT + 12;
  s = s.replace(`viewBox="0 0 ${W} 100"`, `viewBox="0 0 ${W} ${n1(H)}"`).replace('height="100" rx="10"', `height="${n1(H)}" rx="10"`);
  return s + '</svg>';
}

// The desktop figure for an export, leaving the on-screen card's hover lookup as it was.
export function flowSvgForExport(ctx) {
  const keep = panelPoints;
  const s = flowSvg(ctx);
  panelPoints = keep;
  return s;
}

// ======================================================================================
// swarm: every row's SHAP over the league (shap_analysis.beeswarm, one dot per unit)
// ======================================================================================

let swarmPoints = null;

export function swarmSvg(ctx) {
  const { meta, model, target, unit, info, pool, poolLabel, season } = ctx;
  const f = formats(target);
  const good = targetGood(target);
  const W = 1200, RH = 36, top = 226, L = 330, R = 1070;
  const val = ctx.rowValueOf || ((k, p) => rowValue(k, p.unit));
  const inp = ctx.rowInputOf || ((k, p) => rowInput(k, p.info));
  // Primary Fastball stays while its SHAP varies anywhere in the comparison group; it goes when
  // every pitch there has none (e.g. splitters, which are never a primary fastball)
  const inert = !ctx.byOutcome && pool.every((p) => Math.abs(rowValue('is_primary', p.unit) || 0) < 1e-9);
  const rows = ctx.byOutcome ? ctx.rows.slice() : allRows(meta, model, unit, info)
    .filter((r) => !r.season && !(r.k === 'is_primary' && inert))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const BH = rows.length * RH;
  const H = top + BH + 180;  // the axis, the colour key, then the wordmark under it
  let s = svgOpen(W, H, 'fig swarm-fig');
  s += header(W, ctx, `${season}  ·  every row's ${ctx.byOutcome ? 'run value' : 'SHAP'}, ${poolLabel.replace(/^vs /, '')}`);
  // One shared axis, clipped to the 0.5th-99.5th percentile of every row's values pooled (so one
  // heavy-tailed row, like Location, can't stretch it), always including the pitcher's own
  // values. The dots beyond it are pinned at the edge.
  const pooled = [];
  for (const r of rows) for (const p of pool) { const v = val(r.k, p); if (Number.isFinite(v)) pooled.push(v); }
  pooled.sort((a, b) => a - b);
  let lo = Math.min(...rows.map((r) => r.v), pooled.length ? quantile(pooled, 0.005) : 0);
  let hi = Math.max(...rows.map((r) => r.v), pooled.length ? quantile(pooled, 0.995) : 0);
  const pad = (hi - lo) * 0.03;
  lo -= pad; hi += pad;
  const sx = lin(lo, hi, L, R);
  for (const t of niceTicks(lo, hi, 8)) {
    s += `<line data-m="g:${t}" x1="${n1(sx(t))}" x2="${n1(sx(t))}" y1="${top - 8}" y2="${top + BH}" stroke="${C.grid}"/>`;
    s += text(sx(t), top + BH + 20, t === 0 ? '0' : `${t > 0 ? '+' : '−'}${f.tick(Math.abs(t))}`, `font-size="12" fill="${C.muted}" text-anchor="middle"`, `t:${t}`);
  }
  s += `<line data-m="zero" x1="${n1(sx(0))}" x2="${n1(sx(0))}" y1="${top - 8}" y2="${top + BH}" stroke="#fff" stroke-opacity=".6"/>`;
  const unitWord = f.unit === 'pts' ? 'points' : f.unit === 'pp' ? 'percentage points' : f.unit === 'runs' ? 'runs per 9' : 'wOBA';
  s += text((L + R) / 2, top + BH + 44, `${ctx.byOutcome ? 'Run value' : 'SHAP value'} (${targetName(model, target)}, ${unitWord})`, `font-size="13" fill="${C.muted}" text-anchor="middle"`, 'xlab');
  s += head(L - 16, top - 22, 'Row', 'end', 'h1') + head(L, top - 22, poolLabel.replace(/^vs /, 'League: '), 'start', 'h2')
    + head(R + 20, top - 22, `This ${info.pt}`, 'start', 'h3');

  const byRow = [];
  rows.forEach((r, i) => {
    const cy = top + i * RH + RH / 2;
    // the row's contents are drawn about 0 and the group moved into place, so a re-sorted row
    // slides to its new position whole
    s += `<g class="srow fx" data-k="${r.k}" data-m="sr:${r.k}" transform="translate(0,${n1(cy)})">`;
    s += `<rect class="hit" x="16" y="${-RH / 2 + 1}" width="${W - 32}" height="${RH - 2}" rx="6" fill="transparent"/>`;
    const sub = GROUPS[r.k] || ctx.model === 'location' ? '' : r.detail;  // Location and Count, and the Location model, go without one here
    s += text(L - 16, sub ? -1 : 4.5, r.label, `font-size="13.5" font-weight="700" fill="${C.ink}" text-anchor="end"`, `sl:${r.k}`);
    if (sub) s += text(L - 16, 13, sub, `font-size="11" fill="${C.muted}" text-anchor="end"`, `sd:${r.k}`);
    // colour by the unit's input, 2nd-98th percentile within the pool
    const xin = pool.map((p) => inp(r.k, p));
    const fin = xin.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const hasInput = !GROUPS[r.k] && r.k !== 'Other' && fin.length > 1;
    const qa = hasInput ? quantile(fin, 0.02) : 0, qb = hasInput ? quantile(fin, 0.98) : 1;
    const pts = [];
    pool.forEach((p, j) => {
      const v = val(r.k, p);
      if (!Number.isFinite(v)) return;
      const c = hasInput && Number.isFinite(xin[j]) ? Math.max(0, Math.min(1, (xin[j] - qa) / (qb - qa || 1))) : null;
      pts.push({ p, v, c, x: Math.max(L, Math.min(R, sx(v))) });
    });
    // swarm: bin by pixel and spread each bin about the row's centre, scaled to the fullest bin
    const bins = new Map();
    for (const q of pts) {
      const b = Math.round(q.x / 3);
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(q);
    }
    const most = Math.max(1, ...[...bins.values()].map((b) => b.length));
    const half = RH * 0.4;
    for (const b of bins.values()) {
      b.forEach((q, n) => {
        const step = Math.ceil(n / 2) * (n % 2 ? 1 : -1);
        q.y = (step / Math.max(1, most / 2)) * half * Math.min(1, most / 12);
      });
    }
    // one path per colour bucket keeps thousands of dots cheap; they cross-fade between inputs
    const buckets = new Map();
    for (const q of pts) {
      if (q.p.info.pitcher === info.pitcher && q.p.info.pt === info.pt) continue;
      const key = q.c == null ? 'n' : Math.round(q.c * 10);
      buckets.set(key, (buckets.get(key) || '') + `M${(q.x - 1.9).toFixed(1)},${q.y.toFixed(1)}a1.9,1.9 0 1,0 3.8,0a1.9,1.9 0 1,0 -3.8,0`);
    }
    for (const [key, d] of buckets) s += `<path data-f="1" d="${d}" fill="${key === 'n' ? C.muted : valueColor(key / 10)}" opacity=".8"/>`;
    const mx = n1(Math.max(L, Math.min(R, sx(r.v))));
    const col = good * r.v > 0 ? C.gold : C.teal;
    // the pitcher's marker: a diamond as tall as the row
    const mh = RH / 2 - 1, mw = 9;
    s += `<path data-m="dia:${r.k}" d="M${mx},${-mh}L${n1(mx + mw)},0L${mx},${mh}L${n1(mx - mw)},0Z" fill="${col}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`;
    s += text(R + 20, 4.5, f.d(r.v), `font-size="13" font-weight="700" fill="${col}"`, `sv:${r.k}`);
    s += '</g>';
    byRow.push({ k: r.k, cy, pts });
  });
  // colour key
  const kx = L, ky = top + BH + 78;
  s += text(kx - 16, ky + 4, ctx.model === 'location' ? 'Unit\'s rate change' : ctx.byOutcome ? 'Unit\'s predicted rate' : 'Unit\'s mean input', `font-size="11.5" fill="${C.muted}" text-anchor="end"`, 'k1');
  for (let i = 0; i <= 20; i++) s += `<rect data-m="kc:${i}" x="${kx + i * 6}" y="${ky - 5}" width="6.5" height="10" fill="${valueColor(i / 20)}"/>`;
  s += text(kx + 134, ky + 4, 'low → high   (grey: no single input)', `font-size="11.5" fill="${C.muted}"`, 'k2');
  s += `<path data-m="kd" d="M${kx + 400},${ky - 11}L${kx + 406},${ky}L${kx + 400},${ky + 11}L${kx + 394},${ky}Z" fill="${C.gold}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`;
  s += text(kx + 414, ky + 4, `${info.pitcher_name}'s ${PITCH_NAMES[info.pt] || info.pt}`, `font-size="11.5" fill="${C.muted}"`, 'k3');
  s += corner(W, H);
  swarmPoints = { rows: byRow, RH };
  return s + '</svg>';
}

export function nearestSwarmPoint(fx, fy, maxDist = 8) {
  if (!swarmPoints) return null;
  const row = swarmPoints.rows.find((r) => Math.abs(fy - r.cy) <= swarmPoints.RH / 2);
  if (!row) return null;
  let best = null, bd = maxDist * maxDist;
  for (const q of row.pts) {
    const d = (q.x - fx) ** 2 + (row.cy + q.y - fy) ** 2;
    if (d < bd) { bd = d; best = q; }
  }
  return best && { ...best, k: row.k };
}

// ======================================================================================
// sankey: where the probability goes
// ======================================================================================

// A feature's SHAP on the nine outcome probabilities (percentage points). Probabilities sum to
// 100, so whatever a feature adds to some outcomes it takes from others: the left column is
// what each outcome gives up, the right what each gains, and the ribbons run through the
// features in between. The surrogates are fit per outcome, so a feature's two sides agree
// closely but not exactly; its node is as tall as the larger.
const MIN_MOVE = 0.12;   // a row moving less probability than this joins Other
const MIN_LINK = 0.02;   // ribbons thinner than this (pp) are left out
let sankeyLinks = [];

export function sankeySvg(ctx) {
  const { meta, model, units, info, target, season } = ctx;
  const per = OUTCOMES.map((o) => units.get(`p_${o}`));
  if (per.some((u) => !u)) return null;
  let feats = allRows(meta, model, per[0], info).map((r) => ({ k: r.k, label: r.label, season: r.season, s: per.map((u) => rowValue(r.k, u)) }));
  const move = (f) => sum(f.s.map(Math.abs)) / 2;
  const big = feats.filter((f) => !f.season && move(f) >= MIN_MOVE).sort((a, b) => move(b) - move(a));
  const rest = feats.filter((f) => !big.includes(f));
  if (rest.length) big.push({ k: 'Other', label: 'Other', s: OUTCOMES.map((_, j) => sum(rest.map((f) => f.s[j]))) });
  feats = big;
  const exact = per.map((u) => u.exact), league = per.map((u) => u.league);
  const hl = target.startsWith('p_') ? target.slice(2) : null;

  const W = 1200, top = 226, avail = 500, gap = 10, NW = 14;
  const XL = 250, XM = 560, XR = 870;
  const lossOf = OUTCOMES.map((_, j) => sum(feats.map((f) => Math.max(0, -f.s[j]))));
  const gainOf = OUTCOMES.map((_, j) => sum(feats.map((f) => Math.max(0, f.s[j]))));
  const fin = feats.map((f) => sum(f.s.map((v) => Math.max(0, -v))));
  const fout = feats.map((f) => sum(f.s.map((v) => Math.max(0, v))));
  const fh = feats.map((_, i) => Math.max(fin[i], fout[i]));
  const ky = Math.min((avail - gap * 8) / Math.max(sum(lossOf), 1e-9), (avail - gap * 8) / Math.max(sum(gainOf), 1e-9),
    (avail - gap * (feats.length - 1)) / Math.max(sum(fh), 1e-9));
  const minH = 1.5, slot = 16;  // a thin node still gets a label's height of room
  const stack = (hs) => {
    const hh = hs.map((v) => Math.max(minH, v * ky));
    const room = hh.map((h) => Math.max(h, slot));
    let y = top + Math.max(0, (avail - sum(room) - gap * (hs.length - 1)) / 2);
    return hh.map((h, i) => {
      const y0 = y + (room[i] - h) / 2;
      y += room[i] + gap;
      return { y0, y1: y0 + h };
    });
  };
  const left = stack(lossOf), right = stack(gainOf), mid = stack(fh);
  const H = Math.max(top + avail, ...[left, right, mid].map((c) => c[c.length - 1].y1)) + 130;
  let s = svgOpen(W, H, 'fig sankey-fig');
  s += header(W, ctx, `${season}  ·  ${model === 'stuff' ? 'Stuff' : 'PLV'} model outcome probabilities: what each row moves`);
  s += head(XL + NW, top - 22, 'Takes from', 'end', 'h1') + head(XM + NW / 2, top - 22, 'Row', 'middle', 'h2')
    + head(XR, top - 22, 'Gives to', 'start', 'h3') + head(W - 36, top - 22, 'Net vs league', 'end', 'h4');

  // ribbons: outcome (left) -> row -> outcome (right), each end stacked in the order of the
  // other end so they cross as little as possible. Plotly-style: redrawn, then faded in.
  const lcur = left.map((n) => n.y0), rcur = right.map((n) => n.y0);
  const min = mid.map((n, i) => n.y0 + (n.y1 - n.y0 - Math.max(minH, fin[i] * ky)) / 2);
  const mout = mid.map((n, i) => n.y0 + (n.y1 - n.y0 - Math.max(minH, fout[i] * ky)) / 2);
  let links = '';
  sankeyLinks = [];
  feats.forEach((f, i) => {
    OUTCOMES.forEach((o, j) => {
      const v = f.s[j];
      if (Math.abs(v) < MIN_LINK) return;
      const h = Math.abs(v) * ky;
      const cls = `link fx${hl === o ? ' hl' : ''}`;
      const attrs = `class="${cls}" data-k="${f.k}" data-o="${o}" data-i="${sankeyLinks.length}" data-f="1" fill="${OUTCOME_COLORS[o]}"`;
      if (v < 0) {
        links += `<path ${attrs} d="${ribbon(XL + NW, lcur[j], lcur[j] + h, XM, min[i], min[i] + h)}"/>`;
        lcur[j] += h; min[i] += h;
      } else {
        links += `<path ${attrs} d="${ribbon(XM + NW, mout[i], mout[i] + h, XR, rcur[j], rcur[j] + h)}"/>`;
        mout[i] += h; rcur[j] += h;
      }
      sankeyLinks.push({ label: f.label, o, v });
    });
  });
  s += `<g class="links">${links}</g>`;
  OUTCOMES.forEach((o, j) => {
    const name = TARGET_NAMES[`p_${o}`];
    const on = hl === o;
    const L = left[j], R = right[j];
    const d = exact[j] - league[j];
    const tip = esc(`${OUTCOME_NAMES[o]}: ${exact[j].toFixed(1)}% (league ${league[j].toFixed(1)}%)`);
    s += `<rect class="onode" data-o="${o}" data-m="ol:${o}" x="${XL}" y="${n1(L.y0)}" width="${NW}" height="${n1(L.y1 - L.y0)}" fill="${OUTCOME_COLORS[o]}" rx="1.5"><title>${tip}</title></rect>`;
    s += text(XL - 10, (L.y0 + L.y1) / 2 + 4.5, `${name}  −${lossOf[j].toFixed(2)}`, `font-size="13" font-weight="${on ? 700 : 500}" fill="${on ? C.ink : C.muted}" text-anchor="end"`, `oll:${o}`);
    s += `<rect class="onode" data-o="${o}" data-m="or:${o}" x="${XR}" y="${n1(R.y0)}" width="${NW}" height="${n1(R.y1 - R.y0)}" fill="${OUTCOME_COLORS[o]}" rx="1.5"><title>${tip}</title></rect>`;
    s += text(XR + NW + 10, (R.y0 + R.y1) / 2 + 4.5, `${name}  +${gainOf[j].toFixed(2)}`, `font-size="13" font-weight="${on ? 700 : 500}" fill="${on ? C.ink : C.muted}"`, `orl:${o}`);
    const g = targetGood(`p_${o}`) * d > 0;
    s += text(W - 36, (R.y0 + R.y1) / 2 + 4.5, `${exact[j].toFixed(1)}%  ${sgn(d, 2)}`, `font-size="13" font-weight="700" fill="${Math.abs(d) < 0.05 ? C.muted : g ? C.gold : C.teal}" text-anchor="end"`, `net:${o}`);
  });
  feats.forEach((f, i) => {
    const n = mid[i];
    s += `<g class="fnode fx" data-k="${f.k}" tabindex="0" role="button">`;
    s += `<rect data-m="fn:${f.k}" x="${XM}" y="${n1(n.y0)}" width="${NW}" height="${n1(n.y1 - n.y0)}" fill="${C.ink}" rx="1.5"/>`;
    s += text(XM + NW + 8, (n.y0 + n.y1) / 2 + 4.5, `${f.label}  ${move(f).toFixed(2)}`, `font-size="13" font-weight="700" fill="${C.ink}" stroke="${C.card}" stroke-width="4" paint-order="stroke"`, `fl:${f.k}`);
    s += '</g>';
  });
  s += footnote(`Percentage points of each per-pitch outcome probability against the league; a row's number is the probability it moves. Ribbons under ${MIN_LINK} pp are left out.`, W, H);
  s += corner(W, H);
  return s + '</svg>';
}
export const sankeyLink = (i) => sankeyLinks[i];

// ======================================================================================
// PNG export
// ======================================================================================

let fontCss = null;
// DM Sans inlined, so the SVG rasterises in the page's font (an <img> can't reach webfonts)
async function embeddedFont() {
  if (fontCss != null) return fontCss;
  try {
    const css = await (await fetch('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap')).text();
    let out = css;
    for (const u of new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))) {
      out = out.split(u).join(await blobToDataUrl(await (await fetch(u)).blob()));
    }
    fontCss = out;
  } catch (e) { fontCss = ''; }
  return fontCss;
}
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

export async function svgToPng(svg, scale = 2) {
  const clone = svg.cloneNode(true);
  const vb = svg.viewBox.baseVal;
  clone.setAttribute('width', vb.width);
  clone.setAttribute('height', vb.height);
  clone.querySelectorAll('.panel-hit,.ghosts').forEach((e) => e.remove());
  clone.querySelectorAll('[style]').forEach((e) => e.removeAttribute('style'));
  clone.querySelectorAll('.hot').forEach((e) => e.classList.remove('hot'));
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `${await embeddedFont()} .link{opacity:.5}`;
  clone.insertBefore(style, clone.firstChild);
  for (const im of clone.querySelectorAll('image')) {
    try { im.setAttribute('href', await blobToDataUrl(await (await fetch(im.getAttribute('href'))).blob())); } catch (e) { im.remove(); }
  }
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = vb.width * scale;
    canvas.height = vb.height * scale;
    const g = canvas.getContext('2d');
    g.fillStyle = C.card;  // square corners: the on-page rounding is the page's, not the image's
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob(res, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
