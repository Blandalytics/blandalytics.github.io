// The drilldown as a social card: the same ctx flowSvg draws (app.js `view`), laid out as a 16:9
// card on a navy ground. The arsenal is a row of tabs across the top, under them the waterfall,
// and beside it the selected row against the league with its value and percentile beneath. The
// KPI stands alone in the top right corner.
//
// Text, rows, formats, colours and percentiles all come from data.js and charts.js; this file
// only lays them out. It is the page's desktop drilldown: rows and tabs carry data-k / data-pt
// (clicks, the linked focus), elements carry data-m keys so morph.js carries them from one draw to
// the next, and the league plot's dots are kept for the hover lookup (nearestCardPoint).

import {
  PITCH_NAMES, PITCH_COLORS, OUTCOMES, LABELS, AXIS, PCT, GROUPS, MODELS, isPlus, targetGood, targetName,
  rowValue, rowInput,
} from './data.js?v=9';
import { C, WORDMARK_URL, formats, kpiColor, kpiT, kpiName, niceTicks, pctile, ord } from './charts.js?v=69';

export const CARD = { W: 1280, H: 720 };
const K = {
  ground: '#13263F', panel: '#172D4A', line: '#2A3A57', ink: '#E8EEF7', muted: '#93A3BC', faint: '#6C7C96',
  sub: '#7F9CD6', dot: '#9FB3CF', conn: '#B4BECC',
};
const FONT = '"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif';
const WM_ASPECT = 178 / 928;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const n1 = (v) => +v.toFixed(1);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
// The highlight: the pitch type's colour at HILITE (10%) over the figure's card colour (C.card),
// blended here and drawn solid so the navy under it doesn't shift the hue. It tints the chosen
// pitch type's pill and the selected row.
const HILITE = 0.1;
function tint(hex, a, over = C.card) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [c, b] = [rgb(hex), rgb(over)];
  return `rgb(${c.map((v, i) => Math.round(b[i] + (v - b[i]) * a)).join(',')})`;
}
const text = (x, y, s, attrs = '', m = null) => `<text${m ? ` data-m="${esc(m)}"` : ''} x="${n1(x)}" y="${n1(y)}" ${attrs}>${esc(s)}</text>`;
let cardPoints = null;  // the league plot's dots in card coordinates, for the hover lookup

// bold DM Sans, measured once the font is in, else estimated per character
let measurer = null;
function textWidth(str, size, weight = 700) {
  if (document.fonts && document.fonts.check(`${weight} ${size}px "DM Sans"`)) {
    measurer ??= document.createElement('canvas').getContext('2d');
    measurer.font = `${weight} ${size}px "DM Sans"`;
    return measurer.measureText(str).width;
  }
  let w = 0;
  for (const ch of str) w += /[.,:]/.test(ch) ? 0.28 : /[0-9]/.test(ch) ? 0.58 : 0.6;
  return w * size;
}

// A waterfall bar: square where it starts (the running total before it) and rounded (r) where it
// ends, on the right for a rise and the left for a drop
function bar(x, y, w, h, r, right) {
  const [x1, y1] = [n1(x + w), n1(y + h)];
  [x, y, r] = [n1(x), n1(y), n1(r)];
  return right
    ? `M${x},${y}H${n1(x1 - r)}Q${x1},${y} ${x1},${n1(y + r)}V${n1(y1 - r)}Q${x1},${y1} ${n1(x1 - r)},${y1}H${x}Z`
    : `M${x1},${y}H${n1(x + r)}Q${x},${y} ${x},${n1(y + r)}V${n1(y1 - r)}Q${x},${y1} ${n1(x + r)},${y1}H${x1}Z`;
}

// a smooth path through points (Catmull-Rom as cubic Béziers)
function smooth(p) {
  if (p.length < 3) return `M${p.map(([x, y]) => `${x},${y}`).join('L')}`;
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const [a, b, c, e] = [p[i - 1] || p[i], p[i], p[i + 1], p[i + 2] || p[i + 1]];
    d += `C${n1(b[0] + (c[0] - a[0]) / 6)},${n1(b[1] + (c[1] - a[1]) / 6)} ${n1(c[0] - (e[0] - b[0]) / 6)},${n1(c[1] - (e[1] - b[1]) / 6)} ${c[0]},${c[1]}`;
  }
  return d;
}

function footnote(ctx) {
  const { target, model, unit } = ctx;
  const f = formats(target);
  const label = targetName(model, target);
  const note = ctx.byOutcome ? `${label} points (average 100, SD 15); each predicted outcome rate × its run value, an exact split`
    : f.unit === 'pts' ? `${label} points (average 100, SD 15); feature contributions from a proxy model`
    : f.unit === 'wOBA' ? `wOBA on contact (league ${f.v(unit.league)}); feature contributions from a proxy model`
    : f.unit === 'runs' ? `Expected runs per 9 IP (league ERA ${unit.league.toFixed(2)}); feature contributions from a proxy model`
      : `Per-pitch probability (league ${unit.league.toFixed(1)}%); feature contributions from a proxy model`;
  return `${note}. ${targetGood(target) > 0 ? 'Gold raises, teal lowers' : 'Gold lowers, teal raises'}.`;
}

// the widest KPI label ("In-Play Out% (Stuff)"): every model's targets, Location+ its one
const KPI_TARGETS = ['plus', 'outcomes', 'era', 'wobacon', ...OUTCOMES.map((o) => `p_${o}`)];
function widestKpiName(size) {
  return Math.max(...Object.entries(MODELS).flatMap(([m, d]) => (d.outcomesOnly ? ['outcomes'] : KPI_TARGETS)
    .map((t) => textWidth(kpiName(m, t), size))));
}

export function cardSvg(ctx) {
  const { W, H } = CARD;
  cardPoints = null;
  const { rows, unit, target, model, season, info, arsenal, selected } = ctx;
  const f = formats(target);
  const good = targetGood(target);
  const kcol = kpiColor(ctx.kpi ? ctx.kpi.t : kpiT(target, unit));
  const pitchCol = PITCH_COLORS[info.pt] || '#c7c7c7';
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="fig card-fig" font-family='${FONT}' role="img">`
    + `<rect data-m="bg" width="${W}" height="${H}" fill="${K.ground}"/>`;

  // ---- header: pitcher, pitch type, season; the KPI in the corner ----
  s += text(34, 56, info.pitcher_name, `font-size="46" font-weight="700" fill="${C.teal}"`, 'title');
  s += text(34, 90, PITCH_NAMES[info.pt] || info.pt, `font-size="29" font-weight="700" fill="${pitchCol}"`, 'title2');
  s += text(34, 114, String(season), `font-size="17" fill="${K.sub}"`, 'season');
  // the KPI's segment: as wide as the longest label any model and target can give, on one line
  // at full size, so the divider and the value sit still from target to target
  const KS = 24, KR = W - 16, KL = KR - widestKpiName(KS) - 40, kx = (KL + KR) / 2;
  const KB = 112;  // the divider's foot
  s += `<line data-m="kdiv" x1="${n1(KL)}" x2="${n1(KL)}" y1="18" y2="${KB}" stroke="${K.line}" stroke-width="1.5"/>`;
  s += text(kx, 42, kpiName(model, target), `font-size="${KS}" font-weight="700" fill="#fff" text-anchor="middle"`, 'klabel');
  const kval = f.v(unit.exact);
  // its baseline (digits sit on it, nothing hangs below) on the divider's foot
  s += text(kx, KB, kval, `font-size="${Math.min(74, ((KR - KL - 20) / textWidth(kval, 74)) * 74).toFixed(1)}" font-weight="700" fill="${kcol}" text-anchor="middle"`, 'kval');

  // ---- the arsenal tile, on the card's left edge, as tall as the others ----
  // Titled "Pitches", at the other tiles' title size and baseline. Under it a pill per pitch type,
  // stacked, most thrown first, as tall as its share of the pitches but never too short for its
  // one line, "<type> <value>": white, or bold in its colour for the chosen one. Each is outlined
  // in its colour (the pitcher cards' palette), the chosen one filled with its highlight (its
  // colour at HILITE over the card). The pills span the title, or their widest
  // label.
  const TT = 26, TM = 22;  // the tiles' title size and margin
  const AP = { x: 20, y: 133, h: 530 }, ATL = 'Pitches';
  const PFS = 17, PG = 6, PR = 9;  // label size, gap, corner radius (less on a pill too short for it)
  const pill = (p) => `${p.pt} ${p.unit ? f.v(p.unit.exact) : '–'}`;
  const PX = AP.x + TM, AB = AP.y + AP.h - TM;
  const PW = Math.ceil(Math.max(textWidth(ATL, TT), ...arsenal.map((p) => textWidth(pill(p), PFS) + 20)));
  AP.w = PX + PW + TM - AP.x;  // the tile's margin each side
  s += `<rect data-m="atile" x="${AP.x}" y="${AP.y}" width="${n1(AP.w)}" height="${AP.h}" rx="8" fill="${K.panel}"/>`;
  s += text(PX, AP.y + 41, ATL, `font-size="${TT}" font-weight="700" fill="${K.ink}"`, 'atitle');
  const AT = n1(AP.y + 41 + TT * 0.24 + 18);
  // heights: each pitch type's share of the column, floored at one line of text; the pills over
  // the floor give up what the floored ones take, in proportion
  const minH = PFS + 12, avail = AB - AT - PG * (arsenal.length - 1);
  const total = sum(arsenal.map((p) => p.n));
  let hs = arsenal.map((p) => (avail * p.n) / total);
  for (let it = 0; it < arsenal.length; it++) {
    const low = hs.map((h) => h <= minH + 1e-9);
    const need = sum(hs.map((h, k) => (low[k] ? minH - h : 0)));
    if (need <= 1e-9) break;
    const roomW = sum(hs.filter((_, k) => !low[k]));
    hs = hs.map((h, k) => (low[k] ? minH : h - (need * h) / roomW));
  }
  let py = AT;
  arsenal.forEach((p, i) => {
    const h = hs[i], on = p.pt === info.pt, col = PITCH_COLORS[p.pt] || '#c7c7c7';
    s += `<g class="tab${on ? ' on' : ''}" data-pt="${p.pt}" tabindex="0" role="button" aria-label="${esc(`${PITCH_NAMES[p.pt] || p.pt}, ${p.n} pitches`)}">`;
    s += `<rect data-m="band:${p.pt}" x="${PX + 1}" y="${n1(py + 1)}" width="${PW - 2}" height="${n1(h - 2)}" rx="${n1(Math.min(PR, (h - 2) / 2))}" fill="${on ? tint(col, HILITE) : K.panel}" stroke="${col}" stroke-width="${on ? 2.5 : 1.5}"/>`;
    s += text(PX + PW / 2, py + h / 2 + PFS * 0.36, pill(p), `font-size="${PFS}" font-weight="${on ? 700 : 500}" fill="${on ? col : '#fff'}" text-anchor="middle"`, `bl:${p.pt}`);
    s += '</g>';
    py += h + PG;
  });

  // ---- the waterfall tile, titled, right of the arsenal's (the tiles' 12 apart) ----
  const LP = { x: n1(AP.x + AP.w + 12), y: 133, h: 530 };
  LP.w = 810 - LP.x;
  s += `<rect data-m="wtile" x="${LP.x}" y="${LP.y}" width="${LP.w}" height="${LP.h}" rx="8" fill="${K.panel}"/>`;
  s += text(LP.x + TM, LP.y + 41, `${ctx.byOutcome ? 'Outcome' : 'Feature'} Contributions to ${kpiName(model, target)}`, `font-size="${TT}" font-weight="700" fill="${K.ink}"`, 'wtitle');

  // the waterfall: rows spread over the body, the axis under it
  const Y0 = 246, YB = 612;
  const S = (YB - Y0) / rows.length;  // rows spread over the body, as the drilldown spreads them
  const X1 = 762, ROOM_R = 792;
  const FS = 15, CHIP = FS * 1.4;  // the values beside the bars, and the chip behind each
  // bars half the row pitch, so fewer rows draw thicker bars; never thinner than a value's chip,
  // and always a little gap between rows
  const BAR = Math.min(S - 4, Math.max(CHIP, S * 0.5));
  // a row's name over its detail, sized and spaced to the row pitch (17 / 14 with room, as in a
  // seven-row card), the pair centred on the bar: LB the name's baseline, LG the gap to the detail's
  const LS = Math.max(12.5, Math.min(17, S * 0.46)), SS = Math.max(11, Math.min(14, S * 0.37));
  const LG = Math.max(LS * 0.92, Math.min(20, S * 0.38));
  const LB = -(LG - 0.72 * LS + 0.22 * SS) / 2;
  // Other, Location and Count rows, and every row of the Location model: name only
  const subOf = (r) => (r.k === 'Other' || GROUPS[r.k] || ctx.model === 'location' ? '' : r.detail);
  // the row names start at the tile's margin; the bars past the widest name or detail
  const TX0 = LP.x + 22;
  const textW = Math.max(...rows.map((r) => Math.max(textWidth(r.label, LS, 600), subOf(r) ? textWidth(subOf(r), SS, 400) : 0)));
  const ROOM_L = TX0 + textW + 10, X0 = Math.max(330, Math.min(440, ROOM_L + 20));
  let at = unit.league;
  const path = [at];
  for (const r of rows) { at += r.v; path.push(at); }
  const lo = Math.min(...path), hi = Math.max(...path);
  const pad = Math.max(f.pad * 0.4, 0.04 * (hi - lo));
  let d0 = lo - pad, d1 = hi + pad * 2;
  // widen until each value label clears the row names (left) and the panel's edge (right)
  for (let it = 0; it < 8; it++) {
    const k = (X1 - X0) / (d1 - d0);
    let under = 0, out = 0, x = unit.league;
    for (const r of rows) {
      const end = x + r.v, tw = textWidth(f.d(r.v), FS) + 8;
      if (r.v >= 0) out = Math.max(out, X0 + (Math.max(x, end) - d0) * k + tw - ROOM_R);
      else under = Math.max(under, ROOM_L - (X0 + (Math.min(x, end) - d0) * k - tw));
      x = end;
    }
    if (under <= 0.5 && out <= 0.5) break;
    if (under > 0) d0 -= (under + 2) / k;
    if (out > 0) d1 += (out + 2) / k;
  }
  const sx = (v) => n1(lin(d0, d1, X0, X1)(v));
  for (const t of niceTicks(d0, d1, 6)) {
    if (sx(t) < X0 - 1 || sx(t) > X1 + 30) continue;
    s += `<line data-m="g:${t}" x1="${sx(t)}" x2="${sx(t)}" y1="${Y0 - 6}" y2="${YB + 6}" stroke="${K.line}" stroke-width="1" pointer-events="none"/>`;
    s += text(sx(t), YB + 26, f.tick(t), `font-size="14" fill="${K.muted}" text-anchor="middle"`, `t:${t}`);
  }
  const label = targetName(model, target);
  s += text((X0 + X1) / 2, YB + 44, f.unit !== 'pp' || label.includes('%') ? label : `${label}, %`, `font-size="12" fill="${K.muted}" text-anchor="middle"`, 'xlab');

  // the selected row's tint, under everything in the row (clear of the arsenal). It covers the
  // row's name and detail and reaches halfway across the gap to the next row's text each way (the
  // end rows as far past their text as they reach inside), never short of the bar. Text extents:
  // ascent 0.74 and descent 0.24 of the font size.
  const ext = rows.map((r, i) => {
    const cy = Y0 + i * S + S / 2;
    return subOf(r) ? [cy + LB - LS * 0.74, cy + LB + LG + SS * 0.24] : [cy + LS * 0.35 - LS * 0.74, cy + LS * 0.35 + LS * 0.24];
  });
  const band = ext.map((e, i) => [i ? (ext[i - 1][1] + e[0]) / 2 : null, i < ext.length - 1 ? (e[1] + ext[i + 1][0]) / 2 : null]);
  band.forEach((b, i) => {
    const [t, u] = ext[i], cy = Y0 + i * S + S / 2;
    if (rows.length === 1) { b[0] = cy - S / 2 + 2; b[1] = cy + S / 2 - 2; return; }
    if (b[0] == null) b[0] = t - (b[1] - u);
    if (b[1] == null) b[1] = u + (t - b[0]);
    b[0] = Math.min(b[0], cy - BAR / 2 - 3);
    b[1] = Math.max(b[1], cy + BAR / 2 + 3);
  });
  rows.forEach((r, i) => {
    const cy = Y0 + i * S + S / 2;
    const on = r.k === selected;
    s += `<g class="row fx${on ? ' sel' : ''}" data-k="${r.k}" tabindex="0" role="button" aria-label="${esc(`${r.label} ${f.d(r.v)}`)}">`
      + `<rect class="hit" data-m="hit:${r.k}" x="${TX0 - 12}" y="${n1(band[i][0])}" width="${LP.x + LP.w - 6 - (TX0 - 12)}" height="${n1(band[i][1] - band[i][0])}" rx="6" fill="${on ? tint(pitchCol, HILITE) : pitchCol}" fill-opacity="${on ? 1 : 0}"/></g>`;
  });

  // AVG over the league line, an arrow in the KPI's colour to the final value
  const ax = sx(unit.league), ex = sx(at), AY = Y0 - 26, AH = 28;
  const aw = textWidth('AVG', 16) + 22;
  s += `<line data-m="league" x1="${ax}" x2="${ax}" y1="${AY + AH / 2}" y2="${YB + 6}" stroke="#fff" stroke-opacity=".8" stroke-width="1.2" stroke-dasharray="5 4" pointer-events="none"/>`;
  s += `<line data-m="exact" x1="${ex}" x2="${ex}" y1="${AY}" y2="${YB + 6}" stroke="#fff" stroke-opacity=".9" stroke-width="1.4" pointer-events="none"/>`;
  const dir = ex >= ax ? 1 : -1, from = ax + dir * (aw / 2 + 3);
  if (dir * (ex - from) > 20) {
    s += `<line data-m="arrow" x1="${n1(from)}" x2="${n1(ex - dir * 12)}" y1="${AY}" y2="${AY}" stroke="${kcol}" stroke-width="3.5" stroke-linecap="round"/>`;
    s += `<path data-m="arrowhead" d="M${ex},${AY}L${n1(ex - dir * 15)},${AY - 8}L${n1(ex - dir * 15)},${AY + 8}Z" fill="${kcol}"/>`;
  }
  s += `<rect data-m="avgbox" x="${n1(ax - aw / 2)}" y="${AY - AH / 2}" width="${n1(aw)}" height="${AH}" rx="4" fill="${K.ground}" stroke="#fff" stroke-width="1.3"/>`;
  s += text(ax, AY + 6, 'AVG', `font-size="16" font-weight="700" letter-spacing="1" fill="#fff" text-anchor="middle"`, 'avg');

  // bars, connectors, values and row names
  let x = unit.league;
  rows.forEach((r, i) => {
    const cy = Y0 + i * S + S / 2, end = x + r.v;
    const col = good * r.v > 0 ? C.gold : C.teal;
    const a = sx(Math.min(x, end)), b = sx(Math.max(x, end)), w = Math.max(1, n1(b - a));
    s += `<g class="row fx" data-k="${r.k}">`;
    if (i) s += `<line data-m="c:${r.k}" x1="${sx(x)}" x2="${sx(x)}" y1="${n1(cy - S + BAR / 2)}" y2="${n1(cy - BAR / 2)}" stroke="${K.conn}" stroke-width="1.2"/>`;
    s += `<path data-m="bar:${r.k}" d="${bar(a, cy - BAR / 2, w, BAR, Math.min(PR, BAR / 2, w), r.v >= 0)}" fill="${col}"/>`;
    const right = r.v >= 0;
    // on a chip, so it reads over the league and final-value lines
    const tw = textWidth(f.d(r.v), FS), vx = right ? b + 7 : a - 7;
    s += `<rect data-m="vb:${r.k}" x="${n1(right ? vx - 3 : vx - tw - 3)}" y="${n1(cy - CHIP / 2)}" width="${n1(tw + 6)}" height="${n1(CHIP)}" rx="3" fill="${K.panel}" fill-opacity=".85"/>`;
    s += text(vx, cy + FS * 0.35, f.d(r.v), `font-size="${FS}" font-weight="700" fill="#fff" text-anchor="${right ? 'start' : 'end'}"`, `v:${r.k}`);
    const sub = subOf(r);
    s += text(TX0, sub ? cy + LB : cy + LS * 0.35, r.label, `font-size="${n1(LS)}" font-weight="600" fill="${K.ink}"`, `l:${r.k}`);
    if (sub) s += text(TX0, cy + LB + LG, sub, `font-size="${n1(SS)}" fill="${K.muted}"`, `dt:${r.k}`);
    s += '</g>';
    x = end;
  });

  // ---- right panel: the selected row against the league ----
  const sel = rows.find((r) => r.k === selected) || rows[0];
  s += leaguePanel(ctx, sel, { x: 822, y: 133, w: 440, h: 530 });

  s += text(24, 694, footnote(ctx), `font-size="12.5" fill="${K.muted}"`, 'foot');
  const WMW = 180;
  s += `<image class="wordmark" data-m="wm" href="${WORDMARK_URL}" x="${W - 18 - WMW}" y="${n1(H - 14 - WMW * WM_ASPECT)}" width="${WMW}" height="${n1(WMW * WM_ASPECT)}"/>`;
  return s + '</svg>';
}

// A row's dependence plot over the comparison pool (one dot per pitcher × pitch type), its
// binned mean as a smooth white line and the pitcher's dot; then the value and percentiles.
// Location and Count plot their two inputs, coloured by the row's value.
function leaguePanel(ctx, r, P) {
  const { unit, info, target, pool } = ctx;
  const f = formats(target);
  const good = targetGood(target);
  const tname = isPlus(target) ? MODELS[ctx.model].title : targetName(ctx.model, target);
  const val = ctx.rowValueOf || ((k, p) => rowValue(k, p.unit));
  const inp = ctx.rowInputOf || ((k, p) => rowInput(k, p.info));
  const grouped = GROUPS[r.k];
  let s = `<rect data-m="pbox" x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="8" fill="${K.panel}"/>`;
  const L = P.x + 22;
  const title = r.label.length > 22 ? Math.min(26, (P.w - 44) / textWidth(r.label, 26) * 26) : 26;
  s += text(L, P.y + 41, r.label, `font-size="${n1(title)}" font-weight="700" fill="${K.ink}"`, 'ptitle');
  s += text(L, P.y + 68, (ctx.poolLabel || '').replace(/ \(\d+\+ pitches\)$/, ''), `font-size="15" fill="${K.muted}"`, 'psub');

  const pts = [];
  for (const p of pool) {
    const v = val(r.k, p);
    if (!Number.isFinite(v)) continue;
    let xv, yv;
    if (grouped) { xv = p.info[grouped[0]]; yv = p.info[grouped[1]]; } else { xv = inp(r.k, p); yv = v; }
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    if (r.k === 'Other') xv = Math.log10(xv);
    pts.push({ xv, yv, v, id: p.info.pitcher, pt: p.info.pt, info: p.info, me: p.info.pitcher === info.pitcher && p.info.pt === info.pt });
  }
  const me = pts.find((p) => p.me);
  if (!me) return s + text(L, P.y + 110, 'No league units to compare.', `font-size="15" fill="${K.muted}"`, 'pnone');

  const px0 = P.x + 82, px1 = P.x + P.w - 26, py0 = P.y + 100, py1 = P.y + 348;
  const xs = pts.map((p) => p.xv).sort((a, b) => a - b), ys = pts.map((p) => p.yv).sort((a, b) => a - b);
  let xa = Math.min(quantile(xs, 0.01), me.xv), xb = Math.max(quantile(xs, 0.99), me.xv);
  let ya = Math.min(quantile(ys, 0.01), me.yv), yb = Math.max(quantile(ys, 0.99), me.yv);
  if (xa === xb) { xa -= 0.5; xb += 0.5; }
  if (ya === yb) { ya -= 0.5; yb += 0.5; }
  const xp = (xb - xa) * 0.06, yp = (yb - ya) * 0.08;
  xa -= xp; xb += xp; ya -= yp; yb += yp;
  const sxr = lin(xa, xb, px0, px1), syr = lin(ya, yb, py1, py0);
  const cx = (v) => n1(Math.max(px0, Math.min(px1, sxr(v)))), cy = (v) => n1(Math.max(py0, Math.min(py1, syr(v))));
  const xfmt = (v) => (r.k === 'Other' ? String(Math.round(10 ** v)) : PCT.has(r.k) ? `${Math.round(v * 100)}%` : `${+v.toFixed(2)}`);
  // as many decimals as the tick step needs (a 2.5 step mustn't round to "3"), minus as "−"
  const yt = niceTicks(ya, yb, 4);
  const dp = yt.length > 1 ? Math.max(0, -Math.floor(Math.log10(yt[1] - yt[0]) + 1e-9), (yt[1] - yt[0]) % 1 ? 1 : 0) : 0;
  const yfmt = grouped || isPlus(target) ? (v) => (+v.toFixed(dp)).toFixed(dp).replace('-', '−') : f.tick;
  for (const t of yt) s += text(px0 - 14, syr(t) + 5, yfmt(t), `font-size="14" fill="${K.muted}" text-anchor="end"`, `py:${t}`);
  for (const t of niceTicks(xa, xb, 4)) s += text(sxr(t), py1 + 26, xfmt(t), `font-size="14" fill="${K.muted}" text-anchor="middle"`, `px:${t}`);
  // no influence on the target: a line across the plot at 0
  if (!grouped && ya < 0 && yb > 0) s += `<line data-m="pzero" x1="${px0}" x2="${px1}" y1="${n1(syr(0))}" y2="${n1(syr(0))}" stroke="#fff" stroke-opacity=".45" stroke-width="1.2"/>`;
  const xl = grouped ? (r.k === 'Location' ? 'Horizontal location (ft, + = inside)' : 'Balls before the pitch')
    : r.k === 'Other' ? 'Pitches (log scale)' : ctx.axisOf ? ctx.axisOf(r.k) : AXIS[r.k] || LABELS[r.k];
  s += text((px0 + px1) / 2, py1 + 50, xl, `font-size="13.5" fill="${K.muted}" text-anchor="middle"`, 'pxlab');
  const yl = grouped ? (r.k === 'Location' ? 'Vertical location' : 'Strikes before the pitch') : tname;
  s += `<text data-m="pylab" transform="translate(${P.x + 24},${n1((py0 + py1) / 2)}) rotate(-90)" font-size="13.5" fill="${K.muted}" text-anchor="middle">${esc(yl)}</text>`;

  const vs = pts.map((p) => p.v).sort((a, b) => a - b);
  const vmax = Math.max(Math.abs(quantile(vs, 0.02)), Math.abs(quantile(vs, 0.98)), 1e-9);
  let dots = '';
  for (const p of pts) {
    if (p.me) continue;
    dots += `<circle data-m="d:${p.id}|${p.pt}" cx="${cx(p.xv)}" cy="${cy(p.yv)}" r="1.9" fill="${grouped ? kpiColor((good * p.v) / vmax) : K.dot}" fill-opacity="${grouped ? 0.75 : 0.45}"/>`;
  }
  s += `<g class="dots">${dots}</g>`;
  if (!grouped && r.k !== 'lefty') {
    const sorted = pts.slice().sort((a, b) => a.xv - b.xv);
    const nb = Math.min(12, Math.floor(sorted.length / 15));
    if (nb >= 3) {
      const line = [];
      for (let b = 0; b < nb; b++) {
        const part = sorted.slice(Math.floor((b * sorted.length) / nb), Math.floor(((b + 1) * sorted.length) / nb));
        line.push([cx(sum(part.map((p) => p.xv)) / part.length), cy(sum(part.map((p) => p.yv)) / part.length)]);
      }
      s += `<path data-f="1" d="${smooth(line)}" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2" stroke-linejoin="round"/>`;
    }
  }
  const own = val(r.k, { unit, info });
  const mcol = good * (r.k === 'Other' ? r.v : own) > 0 ? C.gold : C.teal;
  s += `<circle data-m="pme" cx="${cx(me.xv)}" cy="${cy(me.yv)}" r="8" fill="${mcol}" stroke="#fff" stroke-width="2.4"/>`;
  // the plot's hover and click area (the page looks up the nearest dot: nearestCardPoint)
  s += `<rect class="panel-hit" x="${px0 - 6}" y="${py0 - 6}" width="${px1 - px0 + 12}" height="${py1 - py0 + 12}" fill="transparent"/>`;
  cardPoints = pts.map((p) => ({ ...p, fx: cx(p.xv), fy: cy(p.yv) }));

  // the numbers, two halves over a centred footer: on the left the row's input (as its sub-label
  // reads) over its percentile among the dots; on the right its impact on the target (gold or
  // teal, as its bar) over its percentile; then the minimum
  const DY = P.y + 414, mid = P.x + P.w / 2, half = P.w / 2 - 34;
  s += `<line data-m="pdiv" x1="${L}" x2="${P.x + P.w - 22}" y1="${DY}" y2="${DY}" stroke="${K.line}" stroke-width="1.5"/>`;
  s += `<line data-m="pdiv2" x1="${mid}" x2="${mid}" y1="${DY + 16}" y2="${DY + 76}" stroke="${K.line}" stroke-width="1.5"/>`;
  const fit = (str, size) => n1(Math.min(size, (half / textWidth(str, size)) * size));
  const seg = (cxs, big, col, sub, m) => text(cxs, DY + 42, big, `font-size="${fit(big, 27)}" font-weight="700" fill="${col}" text-anchor="middle"`, `${m}1`)
    + text(cxs, DY + 67, sub, `font-size="14.5" fill="${K.muted}" text-anchor="middle"`, `${m}2`);
  const rank = pctile(vs.map((v) => good * v).sort((a, b) => a - b), good * me.v);
  s += seg((mid + P.x + P.w - 22) / 2, `${f.d(r.k === 'Other' ? r.v : own)} ${tname}`, mcol, `${r.k === 'Other' ? 'Residual: ' : ''}${ord(rank)} percentile`, 'pr');
  // the input: Other's is the pitch count (its x axis), the baseline's the same-hand share
  const xin = grouped || r.k === 'lefty' ? NaN : r.k === 'Other' ? info.n : inp(r.k, { unit, info });
  const inVal = r.k === 'Other' ? `${info.n.toLocaleString()} pitches`
    : r.k === 'baseline' ? `${Math.round(100 * xin)}% vs Same Hand`
    : r.detail || '–';
  const inPct = Number.isFinite(xin) ? `${ord(pctile(pts.map((p) => p.xv), r.k === 'Other' ? Math.log10(xin) : xin))} percentile` : '';
  s += seg((L + mid) / 2, inVal, K.ink, inPct, 'pl');
  const minN = ctx.minN ?? 1;
  s += text(mid, DY + 101, `Min ${minN} pitch${minN === 1 ? '' : 'es'} thrown`, `font-size="14" fill="${K.faint}" text-anchor="middle"`, 'pl3');
  return s;
}

// the nearest league dot to a point in card coordinates, within maxDist
export function nearestCardPoint(fx, fy, maxDist = 12) {
  if (!cardPoints) return null;
  let best = null, bd = maxDist * maxDist;
  for (const p of cardPoints) {
    const d = (p.fx - fx) ** 2 + (p.fy - fy) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// The card for an export, leaving the on-screen card's hover lookup as it was.
export function cardSvgForExport(ctx) {
  const keep = cardPoints;
  const s = cardSvg(ctx);
  cardPoints = keep;
  return s;
}
