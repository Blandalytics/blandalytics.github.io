// The drilldown as a social card: the same ctx flowSvg draws (app.js `view`), laid out as a 16:9
// card on a navy ground. The arsenal is a row of tabs across the top, under them the waterfall,
// and beside it the selected row against the league with its value and percentile beneath. The
// KPI stands alone in the top right corner.
//
// Text, rows, formats, colours and percentiles all come from data.js and charts.js; this file
// only lays them out. Elements carry data-k / data-pt like the drilldown's, so a page can make
// rows and tabs clickable the same way.

import {
  PITCH_NAMES, PITCH_COLORS, OUTCOMES, LABELS, AXIS, PCT, GROUPS, MODELS, isPlus, targetGood, targetName,
  rowValue, rowInput,
} from './data.js?v=9';
import { C, WORDMARK_URL, formats, kpiColor, kpiT, kpiName, niceTicks, pctile, ord } from './charts.js?v=69';

export const CARD = { W: 1280, H: 720 };
const K = {
  ground: '#121D31', panel: '#182740', line: '#2A3A57', ink: '#E8EEF7', muted: '#93A3BC', faint: '#6C7C96',
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
// The drilldown's highlight, as the figure shows it: the pitch type's colour at HILITE over the
// figure's card colour (C.card), blended here and drawn solid so the navy under it doesn't shift
// the hue. It tints the chosen pitch type's tab and the selected row.
const HILITE = 0.16;
function tint(hex, a, over = C.card) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [c, b] = [rgb(hex), rgb(over)];
  return `rgb(${c.map((v, i) => Math.round(b[i] + (v - b[i]) * a)).join(',')})`;
}
const text = (x, y, s, attrs = '') => `<text x="${n1(x)}" y="${n1(y)}" ${attrs}>${esc(s)}</text>`;

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
  const { rows, unit, target, model, season, info, arsenal, selected } = ctx;
  const f = formats(target);
  const good = targetGood(target);
  const kcol = kpiColor(ctx.kpi ? ctx.kpi.t : kpiT(target, unit));
  const pitchCol = PITCH_COLORS[info.pt] || '#c7c7c7';
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="fig card-fig" font-family='${FONT}' role="img">`
    + `<rect width="${W}" height="${H}" fill="${K.ground}"/>`;

  // ---- header: pitcher, pitch type, subtitle; the KPI in the corner ----
  s += text(34, 56, info.pitcher_name, `font-size="46" font-weight="700" fill="${C.teal}"`);
  s += text(34, 90, PITCH_NAMES[info.pt] || info.pt, `font-size="29" font-weight="700" fill="${pitchCol}"`);
  s += text(34, 114, `${season}, ${ctx.byOutcome ? 'Outcome' : 'Feature'} Contributions to ${kpiName(model, target)}`, `font-size="17" fill="${K.sub}"`);
  // the KPI's segment: as wide as the longest label any model and target can give, on one line
  // at full size, so the divider and the value sit still from target to target
  const KS = 24, KR = W - 16, KL = KR - widestKpiName(KS) - 40, kx = (KL + KR) / 2;
  const KB = 112;  // the divider's foot
  s += `<line x1="${n1(KL)}" x2="${n1(KL)}" y1="18" y2="${KB}" stroke="${K.line}" stroke-width="1.5"/>`;
  s += text(kx, 42, kpiName(model, target), `font-size="${KS}" font-weight="700" fill="#fff" text-anchor="middle"`);
  const kval = f.v(unit.exact);
  // its baseline (digits sit on it, nothing hangs below) on the divider's foot
  s += text(kx, KB, kval, `font-size="${Math.min(74, ((KR - KL - 20) / textWidth(kval, 74)) * 74).toFixed(1)}" font-weight="700" fill="${kcol}" text-anchor="middle"`);

  // ---- left panel: the arsenal over the waterfall ----
  const LP = { x: 20, y: 133, w: 790, h: 530 };
  s += `<rect x="${LP.x}" y="${LP.y}" width="${LP.w}" height="${LP.h}" rx="8" fill="${K.panel}"/>`;
  const TX0 = 44, TX1 = 786, TGAP = 8, TY = 146, TH = 40;
  const minW = (p) => textWidth(`${p.pt} ${p.unit ? f.v(p.unit.exact) : '–'}`, 17) + 24;
  const avail = TX1 - TX0 - TGAP * (arsenal.length - 1);
  const total = sum(arsenal.map((p) => p.n));
  // as wide as the pitch type's share of the pitches, but never narrower than its label
  const fixed = arsenal.map((p) => Math.max(minW(p), (avail * p.n) / total));
  const over = sum(fixed) - avail;
  const roomy = arsenal.map((p, i) => fixed[i] > minW(p));
  const roomyW = sum(fixed.filter((_, i) => roomy[i]));
  const widths = fixed.map((w, i) => (over > 0 && roomy[i] ? w - (over * w) / roomyW : w));
  let tx = TX0;
  arsenal.forEach((p, i) => {
    const w = widths[i], on = p.pt === info.pt, col = PITCH_COLORS[p.pt] || '#c7c7c7';
    const val = p.unit ? f.v(p.unit.exact) : '–';
    s += `<g class="tab${on ? ' on' : ''}" data-pt="${p.pt}" tabindex="0" role="button" aria-label="${esc(`${PITCH_NAMES[p.pt] || p.pt}, ${p.n} pitches`)}">`;
    // a box per pitch type, outlined in its colour (the pitcher cards' palette); the chosen one
    // filled with its highlight, as its rows are
    s += `<rect x="${n1(tx + 1)}" y="${TY + 1}" width="${n1(w - 2)}" height="${TH - 2}" rx="9" fill="${on ? tint(col, HILITE) : 'transparent'}" stroke="${col}" stroke-width="2"/>`;
    s += `<text x="${n1(tx + w / 2)}" y="${TY + TH / 2 + 6}" text-anchor="middle" font-size="17" font-weight="700" fill="#fff">`
      + `${esc(p.pt)}<tspan font-weight="${on ? 700 : 500}"> ${esc(val)}</tspan></text></g>`;
    tx += w + TGAP;
  });

  // the waterfall: rows spread over the body, the axis under it
  const Y0 = 246, YB = 612;
  const S = (YB - Y0) / rows.length;  // rows spread over the body, as the drilldown spreads them
  const X0 = 336, X1 = 762, ROOM_L = 300, ROOM_R = 792;
  const FS = 15, CHIP = FS * 1.4;  // the values beside the bars, and the chip behind each
  // bars half the row pitch, so fewer rows draw thicker bars; never thinner than a value's chip,
  // and always a little gap between rows
  const BAR = Math.min(S - 4, Math.max(CHIP, S * 0.5));
  // a row's name over its detail, sized and spaced to the row pitch (17 / 14 with room, as in a
  // seven-row card), the pair centred on the bar: LB the name's baseline, LG the gap to the detail's
  const LS = Math.max(12.5, Math.min(17, S * 0.46)), SS = Math.max(11, Math.min(14, S * 0.37));
  const LG = Math.max(LS * 0.92, Math.min(20, S * 0.38));
  const LB = -(LG - 0.72 * LS + 0.22 * SS) / 2;
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
    s += `<line x1="${sx(t)}" x2="${sx(t)}" y1="${Y0 - 6}" y2="${YB + 6}" stroke="${K.line}" stroke-width="1"/>`;
    s += text(sx(t), YB + 26, f.tick(t), `font-size="14" fill="${K.muted}" text-anchor="middle"`);
  }
  const label = targetName(model, target);
  s += text((X0 + X1) / 2, YB + 44, f.unit !== 'pp' || label.includes('%') ? label : `${label}, %`, `font-size="12" fill="${K.muted}" text-anchor="middle"`);

  // the selected row's tint, under everything in the row
  const subOf = (r) => (r.k === 'Other' || GROUPS[r.k] || ctx.model === 'location' ? '' : r.detail);
  rows.forEach((r, i) => {
    const cy = Y0 + i * S + S / 2;
    const on = r.k === selected;
    s += `<g class="row fx${on ? ' sel' : ''}" data-k="${r.k}" tabindex="0" role="button" aria-label="${esc(`${r.label} ${f.d(r.v)}`)}">`
      + `<rect class="hit" x="${LP.x + 6}" y="${n1(cy - S / 2 + 2)}" width="${LP.w - 12}" height="${n1(S - 4)}" rx="6" fill="${on ? tint(pitchCol, HILITE) : 'transparent'}"/></g>`;
  });

  // AVG over the league line, an arrow in the KPI's colour to the final value
  const ax = sx(unit.league), ex = sx(at), AY = Y0 - 26, AH = 28;
  const aw = textWidth('AVG', 16) + 22;
  s += `<line x1="${ax}" x2="${ax}" y1="${AY + AH / 2}" y2="${YB + 6}" stroke="#fff" stroke-opacity=".8" stroke-width="1.2" stroke-dasharray="5 4"/>`;
  s += `<line x1="${ex}" x2="${ex}" y1="${AY}" y2="${YB + 6}" stroke="#fff" stroke-opacity=".9" stroke-width="1.4"/>`;
  const dir = ex >= ax ? 1 : -1, from = ax + dir * (aw / 2 + 3);
  if (dir * (ex - from) > 20) {
    s += `<line x1="${n1(from)}" x2="${n1(ex - dir * 12)}" y1="${AY}" y2="${AY}" stroke="${kcol}" stroke-width="3.5" stroke-linecap="round"/>`;
    s += `<path d="M${ex},${AY}L${n1(ex - dir * 15)},${AY - 8}L${n1(ex - dir * 15)},${AY + 8}Z" fill="${kcol}"/>`;
  }
  s += `<rect x="${n1(ax - aw / 2)}" y="${AY - AH / 2}" width="${n1(aw)}" height="${AH}" rx="4" fill="${K.ground}" stroke="#fff" stroke-width="1.3"/>`;
  s += text(ax, AY + 6, 'AVG', `font-size="16" font-weight="700" letter-spacing="1" fill="#fff" text-anchor="middle"`);

  // bars, connectors, values and row names
  let x = unit.league;
  rows.forEach((r, i) => {
    const cy = Y0 + i * S + S / 2, end = x + r.v;
    const col = good * r.v > 0 ? C.gold : C.teal;
    const a = sx(Math.min(x, end)), b = sx(Math.max(x, end)), w = Math.max(1, n1(b - a));
    s += `<g class="row fx" data-k="${r.k}">`;
    if (i) s += `<line x1="${sx(x)}" x2="${sx(x)}" y1="${n1(cy - S + BAR / 2)}" y2="${n1(cy - BAR / 2)}" stroke="${K.conn}" stroke-width="1.2"/>`;
    s += `<rect x="${a}" y="${n1(cy - BAR / 2)}" width="${w}" height="${n1(BAR)}" rx="${n1(Math.min(3, w / 2))}" fill="${col}"/>`;
    const right = r.v >= 0;
    // on a chip, so it reads over the league and final-value lines
    const tw = textWidth(f.d(r.v), FS), vx = right ? b + 7 : a - 7;
    s += `<rect x="${n1(right ? vx - 3 : vx - tw - 3)}" y="${n1(cy - CHIP / 2)}" width="${n1(tw + 6)}" height="${n1(CHIP)}" rx="3" fill="${K.panel}" fill-opacity=".85"/>`;
    s += text(vx, cy + FS * 0.35, f.d(r.v), `font-size="${FS}" font-weight="700" fill="#fff" text-anchor="${right ? 'start' : 'end'}"`);
    const sub = subOf(r);
    s += text(TX0, sub ? cy + LB : cy + LS * 0.35, r.label, `font-size="${n1(LS)}" font-weight="600" fill="${K.ink}"`);
    if (sub) s += text(TX0, cy + LB + LG, sub, `font-size="${n1(SS)}" fill="${K.muted}"`);
    s += '</g>';
    x = end;
  });

  // ---- right panel: the selected row against the league ----
  const sel = rows.find((r) => r.k === selected) || rows[0];
  s += leaguePanel(ctx, sel, { x: 822, y: 133, w: 440, h: 530 });

  s += text(24, 694, footnote(ctx), `font-size="12.5" fill="${K.muted}"`);
  const WMW = 180;
  s += `<image class="wordmark" href="${WORDMARK_URL}" x="${W - 18 - WMW}" y="${n1(H - 14 - WMW * WM_ASPECT)}" width="${WMW}" height="${n1(WMW * WM_ASPECT)}"/>`;
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
  let s = `<rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="8" fill="${K.panel}"/>`;
  const L = P.x + 22;
  const title = r.label.length > 22 ? Math.min(26, (P.w - 44) / textWidth(r.label, 26) * 26) : 26;
  s += text(L, P.y + 41, r.label, `font-size="${n1(title)}" font-weight="700" fill="${K.ink}"`);
  s += text(L, P.y + 68, (ctx.poolLabel || '').replace(/ \(\d+\+ pitches\)$/, ''), `font-size="15" fill="${K.muted}"`);

  const pts = [];
  for (const p of pool) {
    const v = val(r.k, p);
    if (!Number.isFinite(v)) continue;
    let xv, yv;
    if (grouped) { xv = p.info[grouped[0]]; yv = p.info[grouped[1]]; } else { xv = inp(r.k, p); yv = v; }
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    if (r.k === 'Other') xv = Math.log10(xv);
    pts.push({ xv, yv, v, me: p.info.pitcher === info.pitcher && p.info.pt === info.pt });
  }
  const me = pts.find((p) => p.me);
  if (!me) return s + text(L, P.y + 110, 'No league units to compare.', `font-size="15" fill="${K.muted}"`);

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
  for (const t of yt) s += text(px0 - 14, syr(t) + 5, yfmt(t), `font-size="14" fill="${K.muted}" text-anchor="end"`);
  for (const t of niceTicks(xa, xb, 4)) s += text(sxr(t), py1 + 26, xfmt(t), `font-size="14" fill="${K.muted}" text-anchor="middle"`);
  // no influence on the target: a line across the plot at 0
  if (!grouped && ya < 0 && yb > 0) s += `<line x1="${px0}" x2="${px1}" y1="${n1(syr(0))}" y2="${n1(syr(0))}" stroke="#fff" stroke-opacity=".45" stroke-width="1.2"/>`;
  const xl = grouped ? (r.k === 'Location' ? 'Horizontal location (ft, + = inside)' : 'Balls before the pitch')
    : r.k === 'Other' ? 'Pitches (log scale)' : ctx.axisOf ? ctx.axisOf(r.k) : AXIS[r.k] || LABELS[r.k];
  s += text((px0 + px1) / 2, py1 + 50, xl, `font-size="13.5" fill="${K.muted}" text-anchor="middle"`);
  const yl = grouped ? (r.k === 'Location' ? 'Vertical location' : 'Strikes before the pitch') : tname;
  s += `<text transform="translate(${P.x + 24},${n1((py0 + py1) / 2)}) rotate(-90)" font-size="13.5" fill="${K.muted}" text-anchor="middle">${esc(yl)}</text>`;

  const vs = pts.map((p) => p.v).sort((a, b) => a - b);
  const vmax = Math.max(Math.abs(quantile(vs, 0.02)), Math.abs(quantile(vs, 0.98)), 1e-9);
  let dots = '';
  for (const p of pts) {
    if (p.me) continue;
    dots += `<circle cx="${cx(p.xv)}" cy="${cy(p.yv)}" r="1.9" fill="${grouped ? kpiColor((good * p.v) / vmax) : K.dot}" fill-opacity="${grouped ? 0.75 : 0.45}"/>`;
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
      s += `<path d="${smooth(line)}" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2" stroke-linejoin="round"/>`;
    }
  }
  const own = val(r.k, { unit, info });
  const mcol = good * (r.k === 'Other' ? r.v : own) > 0 ? C.gold : C.teal;
  s += `<circle cx="${cx(me.xv)}" cy="${cy(me.yv)}" r="8" fill="${mcol}" stroke="#fff" stroke-width="2.4"/>`;

  // the numbers, two halves over a centred footer: the row's impact on the target (gold or teal,
  // as its bar) over its percentile; the row's input (as its sub-label reads) over its percentile
  // among the dots; then the minimum
  const DY = P.y + 414, mid = P.x + P.w / 2, half = P.w / 2 - 34;
  s += `<line x1="${L}" x2="${P.x + P.w - 22}" y1="${DY}" y2="${DY}" stroke="${K.line}" stroke-width="1.5"/>`;
  s += `<line x1="${mid}" x2="${mid}" y1="${DY + 16}" y2="${DY + 76}" stroke="${K.line}" stroke-width="1.5"/>`;
  const fit = (str, size) => n1(Math.min(size, (half / textWidth(str, size)) * size));
  const seg = (cxs, big, col, sub) => text(cxs, DY + 42, big, `font-size="${fit(big, 27)}" font-weight="700" fill="${col}" text-anchor="middle"`)
    + text(cxs, DY + 67, sub, `font-size="14.5" fill="${K.muted}" text-anchor="middle"`);
  const rank = pctile(vs.map((v) => good * v).sort((a, b) => a - b), good * me.v);
  s += seg((L + mid) / 2, `${f.d(r.k === 'Other' ? r.v : own)} ${tname}`, mcol, `${r.k === 'Other' ? 'Residual: ' : ''}${ord(rank)} percentile`);
  // the input: Other's is the pitch count (its x axis), the baseline's the same-hand share
  const xin = grouped || r.k === 'lefty' ? NaN : r.k === 'Other' ? info.n : inp(r.k, { unit, info });
  const inVal = r.k === 'Other' ? `${info.n.toLocaleString()} pitches`
    : r.k === 'baseline' ? `${Math.round(100 * xin)}% vs Same Hand`
    : r.detail || '–';
  const inPct = Number.isFinite(xin) ? `${ord(pctile(pts.map((p) => p.xv), r.k === 'Other' ? Math.log10(xin) : xin))} percentile` : '';
  s += seg((mid + P.x + P.w - 22) / 2, inVal, K.ink, inPct);
  const minN = ctx.minN ?? 1;
  s += text(mid, DY + 101, `Min ${minN} pitch${minN === 1 ? '' : 'es'} thrown`, `font-size="14" fill="${K.faint}" text-anchor="middle"`);
  return s;
}
