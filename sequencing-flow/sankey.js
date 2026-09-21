// The sequencing Sankey: nodes are (pitch number in the plate appearance, pitch type), links
// follow each pitch to the next one in the same plate appearance. Drawn with Plotly's sankey
// trace in a fixed layout computed here, so every column is a pitch number and the bands
// stack in the game's usage order. Hover traces plate appearances; the tooltip dodges them.
//
// Expects, in the page: #legend, #show-ends, #end-key, #chart, #tip. `show(DATA)` draws a
// flow built by data.js's buildFlow.

const ORD = n => ({ 1: '1st', 2: '2nd', 3: '3rd' }[n] || n + 'th');
const $ = id => document.getElementById(id);

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

let DATA = null;
let focus = null;                 // a pitch type isolated from the legend
let currentLinks = [], currentNodes = [];
let paById = new Map();
let wired = false;

const legendEl = $('legend'), showEnds = $('show-ends'), endKey = $('end-key'), chartEl = $('chart'), tip = $('tip');
// Each .sankey-link path and .node-rect carries its d3 datum on __data__ (Plotly 2 no longer exposes d3).
const linkPaths = () => [...chartEl.querySelectorAll('path.sankey-link')];
const nodeRects = () => [...chartEl.querySelectorAll('rect.node-rect')];

showEnds.addEventListener('change', () => { endKey.hidden = !showEnds.checked; if (DATA) render(); });

function fillLegend() {
  legendEl.innerHTML = '';
  legendEl.classList.toggle('has-focus', !!focus);
  DATA.types.forEach(t => {
    const b = document.createElement('button');
    b.className = 'chip' + (focus === t.code ? ' on' : ''); b.type = 'button'; b.dataset.code = t.code;
    b.setAttribute('aria-pressed', String(focus === t.code));
    b.innerHTML = `<span class="sw" style="background:${t.color}"></span><span class="code">${t.code}</span><span class="nm">${t.name}</span><span class="ct">${t.count}</span>`;
    b.addEventListener('click', () => {
      focus = focus === t.code ? null : t.code;
      legendEl.classList.toggle('has-focus', !!focus);
      legendEl.querySelectorAll('.chip').forEach(c => {
        const on = c.dataset.code === focus;
        c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
      });
      render();
    });
    legendEl.appendChild(b);
  });
  endKey.innerHTML = DATA.end_cats.map(c => `<span><i style="--k:${DATA.end_outlines[c]}"></i>${c}</span>`).join('');
  endKey.hidden = !showEnds.checked;
}

// opts.export = { W, H } builds the trace for a PNG at that size instead of the live chart: no
// ending nodes, no isolation, and the labels come back as geometry (drawn onto the canvas, where
// the page's font is available) rather than Plotly annotations.
function build(opts = {}) {
  const exp = opts.export || null;
  const withEnds = exp ? false : showEnds.checked;
  const nodes = DATA.nodes;
  const keep = nodes.map(n => withEnds || n.type !== 'END');
  const remap = new Map(); let k = 0;
  nodes.forEach((n, i) => { if (keep[i]) remap.set(i, k++); });

  const ink = token('--ink'), muted = token('--muted'), surface = token('--surface');
  const alpha = parseFloat(token('--link-alpha')) || 0.5;
  const dim = t => !exp && focus && t !== focus;
  // With a pitch type isolated, only the outcomes it produced stay lit
  const endLit = new Set();
  DATA.links.forEach(l => { if (l.terminal && !dim(l.type)) endLit.add(l.target); });
  const nodeDimmed = i => nodes[i].type === 'END' ? (!!focus && !endLit.has(i)) : dim(nodes[i].type);

  // Fixed layout. Plotly's node.x / node.y are node CENTRES (0..1 of the plot area) and node heights
  // come from d3-sankey (value * ky), so we replicate that scale here to stack bands without overlap:
  // one column per pitch number, bands in game-usage order (most-thrown type on top), vertically centred.
  // node.align = 'left' keeps d3's depth = pitch number - 1, so its ky columns match ours.
  const PAD = 14, THICK = 22, MARGIN_T = 14, MARGIN_B = 14;
  const MARGIN_L = 48, MARGIN_R = 24;
  const H = Math.max(200, (exp ? exp.H : chartEl.clientHeight) - MARGIN_T - MARGIN_B);
  // d3 value = max(inflow, outflow). Column 1 has no inflow; every later real node's inflow is its count.
  const val = i => {
    const n = nodes[i];
    if (n.type === 'END') return n.count;
    return n.n === 1 ? (withEnds ? n.count : n.count - n.ended) : n.count;
  };
  // d3 columns (by depth): real nodes at depth n-1, END nodes at depth n.
  const depth = i => nodes[i].type === 'END' ? nodes[i].n : nodes[i].n - 1;
  const cols = {};
  nodes.forEach((n, i) => { if (keep[i]) (cols[depth(i)] = cols[depth(i)] || []).push(i); });
  const colList = Object.values(cols);
  const L = Math.max(...colList.map(c => c.length));
  const py = Math.min(PAD, L > 1 ? (2 / 3) * H / (L - 1) : PAD);
  let ky = Infinity;
  colList.forEach(ids => {
    const total = ids.reduce((s, i) => s + val(i), 0);
    if (total > 0) ky = Math.min(ky, (H - (ids.length - 1) * py) / total);
  });
  const nCols = colList.length;
  const xs = d => nCols === 1 ? 0.5 : 0.02 + 0.96 * d / (nCols - 1);
  const x = [], y = [];
  Object.keys(cols).forEach(d => {
    const ids = cols[d].filter(i => val(i) > 0);   // zero-value nodes draw nothing
    const h = i => val(i) * ky / H, pad = py / H;
    const stack = ids.reduce((s, i) => s + h(i), 0) + pad * (ids.length - 1);
    let cur = 0.5 - stack / 2;
    cols[d].forEach(i => { x[remap.get(i)] = xs(+d); y[remap.get(i)] = 0.5; });
    ids.forEach(i => { y[remap.get(i)] = cur + h(i) / 2; cur += h(i) + pad; });
  });
  const nodeIds = nodes.map((n, i) => i).filter(i => keep[i]);
  const node = {
    pad: PAD, thickness: THICK, align: 'left', line: { color: surface, width: 1 },
    label: nodeIds.map(() => ''),
    color: nodeIds.map(i => {
      const n = nodes[i];
      if (n.type === 'END') return surface;                 // ending faces match the chart background
      return dim(n.type) ? hexToRgba(n.color, 0.18) : n.color;
    }),
    x, y,
    hoverinfo: 'none',            // node tooltips are drawn by the page too, so they can dodge the traced paths
  };

  // One link per pitch-to-pitch step of each plate appearance. Links that share a `label` (the PA id)
  // are what Plotly lights up together on hover, which is how a whole PA gets traced.
  const links = DATA.links.filter(l => withEnds || !l.terminal);
  if (!exp) {
    currentLinks = links;
    currentNodes = nodeIds.map(i => ({ ...nodes[i], index: i, dimmed: nodeDimmed(i) }));
  }
  const link = {
    source: links.map(l => remap.get(l.source)),
    target: links.map(l => remap.get(l.target)),
    value: links.map(() => 1),
    label: links.map(l => String(l.pa)),
    color: links.map(l => hexToRgba(DATA.nodes[l.source].color, dim(l.type) ? 0.06 : alpha)),
    hovercolor: links.map(l => hexToRgba(DATA.nodes[l.source].color, dim(l.type) ? 0.06 : 0.95)),
    hoverinfo: 'none',            // link tooltips are drawn by the page so they can dodge the traced path
    line: { width: 0 },
  };

  // Pitch-type labels sit to the left of the first column, centred on each band. A type never
  // thrown first in a plate appearance gets its label inside the first band it does appear in,
  // so every type is named somewhere.
  const firstCol = new Map();
  nodes.forEach(n => { if (n.type !== 'END' && !(firstCol.has(n.type) && firstCol.get(n.type) <= n.n)) firstCol.set(n.type, n.n); });
  const labels = [];
  nodeIds.forEach(i => {
    const n = nodes[i];
    if (n.type === 'END' || val(i) <= 0) return;
    const at = { x: x[remap.get(i)], y: y[remap.get(i)], text: n.label, type: n.type, dimmed: dim(n.type) };
    if (n.n === 1) labels.push({ ...at, inside: false });
    else if (firstCol.get(n.type) === n.n && val(i) * ky >= 11) labels.push({ ...at, inside: true });
  });
  const annotations = exp ? [] : labels.map(l => ({
    x: l.x, y: 1 - l.y, xref: 'paper', yref: 'paper', yanchor: 'middle', showarrow: false,
    xanchor: l.inside ? 'center' : 'right', xshift: l.inside ? 0 : -(THICK / 2 + 8),
    text: l.inside ? `<b>${l.text}</b>` : l.text,
    font: { family: token('--body'), size: 12.5, color: l.dimmed ? muted : (l.inside ? '#0d1117' : ink) },
  }));

  const trace = {
    type: 'sankey', orientation: 'h', arrangement: 'fixed', valueformat: 'd',
    node, link, textfont: { family: token('--body'), size: 12, color: ink },
  };
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { l: MARGIN_L, r: MARGIN_R, t: MARGIN_T, b: MARGIN_B }, autosize: !exp,
    font: { family: token('--body'), color: ink },
    hovermode: 'closest',
    annotations,
    hoverlabel: { bgcolor: surface, bordercolor: token('--rule'), font: { family: token('--body'), size: 12.5, color: ink } },
  };
  if (exp) Object.assign(layout, { width: exp.W, height: exp.H });
  return { trace, layout, labels, margin: { l: MARGIN_L, r: MARGIN_R, t: MARGIN_T, b: MARGIN_B }, thick: THICK };
}

// Ending nodes share one face and are told apart by outline color. Plotly only takes a single
// node outline, so the per-node outlines are painted onto the rects after each plot.
function paintOutlines() {
  nodeRects().forEach(el => {
    const d = el.__data__, n = d && currentNodes[d.node.pointNumber];
    if (n && n.type === 'END') { el.style.stroke = n.outline; el.style.strokeWidth = '2.5px'; el.style.strokeOpacity = n.dimmed ? 0.18 : 1; }
  });
}
function render() {
  const { trace, layout } = build();
  return Plotly.react(chartEl, [trace], layout, { displayModeBar: false, responsive: true }).then(paintOutlines);
}

// Find a spot for the tooltip near the cursor that doesn't touch any link or node of the traced PA.
function placeTip(anchor, paths, rects) {
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const bounds = chartEl.getBoundingClientRect();
  const left = Math.max(bounds.left, 0), top = Math.max(bounds.top, 0);
  const right = Math.min(bounds.right, window.innerWidth), bottom = Math.min(bounds.bottom, window.innerHeight);

  // Points along each traced ribbon's outline, in screen space.
  const samples = [];
  const geo = paths.map(p => {
    const m = p.getScreenCTM(), L = p.getTotalLength(), step = Math.max(3, L / 120);
    for (let s = 0; s <= L; s += step) { const q = p.getPointAtLength(s).matrixTransform(m); samples.push([q.x, q.y]); }
    return { p, inv: m.inverse() };
  });
  const inRibbon = (x, y) => geo.some(g => g.p.isPointInFill(new DOMPoint(x, y).matrixTransform(g.inv)));
  const clear = (x, y) => {
    if (rects.some(r => r.left < x + tw && r.right > x && r.top < y + th && r.bottom > y)) return false;
    if (samples.some(([sx, sy]) => sx >= x && sx <= x + tw && sy >= y && sy <= y + th)) return false;
    const probes = [[x, y], [x + tw, y], [x, y + th], [x + tw, y + th], [x + tw / 2, y + th / 2],
                    [x + tw / 2, y], [x + tw / 2, y + th], [x, y + th / 2], [x + tw, y + th / 2]];
    return !probes.some(([px, py]) => inRibbon(px, py));
  };
  const dirs = [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]];
  const tried = [];
  for (const dist of [14, 28, 46, 68, 95, 130, 170, 220, 280, 350]) {
    for (const [dx, dy] of dirs) {
      let x = anchor.x + dx * dist - (dx < 0 ? tw : dx === 0 ? tw / 2 : 0);
      let y = anchor.y + dy * dist - (dy < 0 ? th : dy === 0 ? th / 2 : 0);
      x = Math.min(Math.max(x, left), Math.max(left, right - tw));
      y = Math.min(Math.max(y, top), Math.max(top, bottom - th));
      if (tried.some(([tx, ty]) => Math.abs(tx - x) < 2 && Math.abs(ty - y) < 2)) continue;
      tried.push([x, y]);
      if (clear(x, y)) return [x, y];
    }
  }
  return [Math.min(anchor.x + 14, right - tw), Math.min(anchor.y + 14, bottom - th)];   // nothing clear: stay near the cursor
}

// Light up a set of plate appearances: their links go solid, everything else fades.
// Returns the traced link paths and node rects (for tooltip placement).
function trace(paSet) {
  const onPath = new Set(), paPaths = [], paRects = [];
  linkPaths().forEach(el => {
    const d = el.__data__;
    if (!d) return;
    if (paSet.has(d.link.label)) {
      onPath.add(d.link.source.pointNumber); onPath.add(d.link.target.pointNumber);
      el.style.fillOpacity = d.tinyColorHoverAlpha; paPaths.push(el);
    } else el.style.fillOpacity = 0.07;
  });
  nodeRects().forEach(el => {
    const d = el.__data__;
    if (!d) return;
    if (onPath.has(d.node.pointNumber)) paRects.push(el.getBoundingClientRect());
    else { el.style.fillOpacity = 0.18; el.style.strokeOpacity = 0.18; }
  });
  return { paPaths, paRects };
}
function untrace() {
  tip.hidden = true;
  linkPaths().forEach(el => { const d = el.__data__; if (d) el.style.fillOpacity = d.tinyColorAlpha; });
  nodeRects().forEach(el => {
    const d = el.__data__, n = d && currentNodes[d.node.pointNumber];
    if (d) { el.style.fillOpacity = d.tinyColorAlpha; el.style.strokeOpacity = n && n.type === 'END' && n.dimmed ? 0.18 : 1; }
  });
}

// A band's tooltip: the pitch and its share at that count. An ending's: the outcome (in its outline
// color) and, one per plate appearance, the pitch that ended it and the actual event.
function nodeTip(n) {
  const tot = DATA.col_total[n.n];
  if (n.type === 'END') {
    const rows = DATA.pas
      .filter(p => p.seq.length === n.n && p.cat === n.cat)
      .map(p => {
        const t = p.seq[p.seq.length - 1], c = (DATA.types.find(x => x.code === t) || {}).color || '#c7c7c7';
        const ev = `<span style="color:${p.result === 'Home Run' ? '#FF5EDC' : '#fff'}">${p.result}</span>`;
        return `<li><span style="color:${c}">${t}</span> → ${ev}</li>`;
      });
    return `<span class="name" style="color:${n.outline}">${n.cat}</span> &nbsp;<span class="meta">after pitch ${n.n}</span>`
      + `<ul class="list">${rows.join('')}</ul>`;
  }
  const pct = Math.round(100 * n.count / tot);
  const ended = n.ended ? `<div class="meta">${n.ended} ended the plate appearance</div>` : '';
  return `<span class="name" style="color:${n.color}">${n.type}</span> &nbsp;<span class="meta">${n.name} · ${ORD(n.n)} pitch of the PA</span>`
    + `<div class="seq">${n.count} of ${tot} ${ORD(n.n)} pitches (${pct}%)</div>${ended}`;
}

// Show a link's or node's tooltip and trace its plate appearances.
function focusPoint(pt, anchor) {
  untrace();
  if (pt.source === undefined) {
    // Node: every plate appearance that passes through it
    const idx = pt.pointNumber, pas = new Set();
    linkPaths().forEach(el => {
      const d = el.__data__;
      if (d && (d.link.source.pointNumber === idx || d.link.target.pointNumber === idx)) pas.add(d.link.label);
    });
    const { paPaths, paRects } = trace(pas);
    tip.innerHTML = nodeTip(currentNodes[idx]);
    tip.hidden = false;
    const [x, y] = placeTip(anchor, paPaths, paRects);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    return;
  }
  // Link: this one plate appearance, with its own tooltip placed clear of the path
  const { paPaths, paRects } = trace(new Set([pt.label]));
  const l = currentLinks[pt.pointNumber], p = paById.get(l.pa);
  if (!p) return;
  // Pitch chain ending in the actual event, colored by its outcome group's outline; the hovered step is bold.
  const hot = k => k === l.step || k === l.step + 1;
  const seq = p.seq.map((c, k) => hot(k) ? `<b>${c}</b>` : `<span class="off">${c}</span>`);
  const evColor = DATA.end_outlines[p.cat];
  seq.push(`<span class="ev" style="color:${evColor}">${l.terminal ? `<b>${p.result}</b>` : p.result}</span>`);
  tip.innerHTML = `<span class="name">${p.batter}</span> &nbsp;<span class="meta">${ORD(p.inning)} inning</span>`
    + `<div class="seq">${seq.join(' → ')}</div>`;
  tip.hidden = false;
  const [x, y] = placeTip(anchor, paPaths, paRects);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function anchorOf(e) { return { x: e?.clientX ?? 0, y: e?.clientY ?? 0 }; }
function pointKey(pt) { return (pt.source === undefined ? 'n' : 'l') + pt.pointNumber; }

// Without a real hover (phones), a tap pins a link's or node's tooltip and a second tap on it,
// or a tap anywhere else in the chart, clears it.
const TOUCH = window.matchMedia('(hover: none)').matches;
let pinned = null;

function wireHover() {
  if (wired) return;
  wired = true;
  if (!TOUCH) {
    chartEl.on('plotly_hover', ev => {
      const pt = ev.points && ev.points[0];
      if (pt) focusPoint(pt, anchorOf(ev.event));
    });
    chartEl.on('plotly_unhover', untrace);
    return;
  }
  chartEl.on('plotly_click', ev => {
    const pt = ev.points && ev.points[0];
    if (!pt) return;
    const key = pointKey(pt);
    if (pinned === key) { pinned = null; untrace(); return; }
    pinned = key;
    // Plotly's sankey click carries no coordinates of its own; the original tap does
    const e = pt.originalEvent || ev.event;
    const ce = e && e.changedTouches ? e.changedTouches[0] : e;
    focusPoint(pt, anchorOf(ce));
  });
  chartEl.addEventListener('click', ev => {
    if (ev.target.closest && ev.target.closest('.sankey-link, .sankey-node')) return;
    if (pinned) { pinned = null; untrace(); }
  });
}

/**
 * Save the diagram as a square PNG (2000 x 2000): the pitcher's line above, the pitch-type key,
 * the flow without ending nodes, and a credit. Plotly rasterises the sankey itself; the text is
 * drawn on the canvas so it uses the page's font.
 */
const WORDMARK_URL = '../pitcher-cards/PitcherList_Stats_watermark_with_logo.webp';
let wordmarkPromise = null;
function loadWordmark() {
  if (!wordmarkPromise) {
    wordmarkPromise = new Promise(ok => {
      const im = new Image();
      im.onload = () => ok(im); im.onerror = () => ok(null);
      im.src = WORDMARK_URL;
    });
  }
  return wordmarkPromise;
}

export async function savePng(meta) {
  if (!DATA) return;
  const S = 1000, SCALE = 2, PADX = 44;
  const mark = await loadWordmark();
  const ground = token('--ground') || '#0d1117', ink = token('--ink'), muted = token('--muted');
  const family = (token('--body') || 'sans-serif');
  await document.fonts.ready;

  // Header and key, laid out first so the flow gets whatever height is left.
  const cv = document.createElement('canvas');
  cv.width = S * SCALE; cv.height = S * SCALE;
  const ctx = cv.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = ground; ctx.fillRect(0, 0, S, S);
  ctx.textBaseline = 'alphabetic';
  let yCur = 70;
  ctx.fillStyle = ink; ctx.font = `700 34px ${family}`;
  ctx.fillText(meta.pitcher, PADX, yCur);
  const L = meta.line || {};
  const lineTxt = `${L.ip} IP · ${L.h} H · ${L.bb} BB · ${L.k} K · ${L.pitches} pitches`;
  ctx.font = `600 17px ${family}`; ctx.textAlign = 'right';
  ctx.fillText(lineTxt, S - PADX, yCur); ctx.textAlign = 'left';
  yCur += 28;
  ctx.fillStyle = muted; ctx.font = `500 17px ${family}`;
  const d = new Date(meta.date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  ctx.fillText(`${meta.away} @ ${meta.home} · ${dateStr} · vs ${meta.opponent}`, PADX, yCur);
  yCur += 34;
  // key: swatch, code, name, count
  let kx = PADX;
  DATA.types.forEach(t => {
    const code = t.code, name = t.name, count = String(t.count);
    ctx.font = `600 14px ${family}`; const wCode = ctx.measureText(code).width;
    ctx.font = `400 14px ${family}`; const wName = ctx.measureText(name).width, wCount = ctx.measureText(count).width;
    const w = 14 + 8 + wCode + 6 + wName + 6 + wCount;
    if (kx + w > S - PADX) { kx = PADX; yCur += 26; }
    ctx.fillStyle = t.color; ctx.beginPath(); ctx.roundRect(kx, yCur - 12, 14, 14, 3); ctx.fill();
    ctx.fillStyle = ink; ctx.font = `600 14px ${family}`; ctx.fillText(code, kx + 22, yCur);
    ctx.fillStyle = muted; ctx.font = `400 14px ${family}`; ctx.fillText(name, kx + 22 + wCode + 6, yCur);
    ctx.fillText(count, kx + 22 + wCode + 6 + wName + 6, yCur);
    kx += w + 26;
  });
  yCur += 22;

  // The flow, rasterised by Plotly at the remaining size.
  const FOOT = 74;                                       // room for the credit line and the wordmark
  const W = S - 2 * PADX, H = S - yCur - FOOT;
  const { trace, layout, labels, margin, thick } = build({ export: { W, H } });
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:-20000px;top:0;width:${W}px;height:${H}px;`;
  document.body.appendChild(box);
  let url;
  try {
    await Plotly.newPlot(box, [trace], layout, { staticPlot: true, displayModeBar: false });
    url = await Plotly.toImage(box, { format: 'png', width: W, height: H, scale: SCALE });
  } finally {
    Plotly.purge(box); box.remove();
  }
  const img = new Image();
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
  ctx.drawImage(img, PADX, yCur, W, H);

  // Labels, at the same places the page puts them.
  const plotW = W - margin.l - margin.r, plotH = H - margin.t - margin.b;
  labels.forEach(l => {
    const px = PADX + margin.l + l.x * plotW, py = yCur + margin.t + l.y * plotH;
    ctx.textBaseline = 'middle';
    if (l.inside) { ctx.font = `700 15px ${family}`; ctx.fillStyle = '#0d1117'; ctx.textAlign = 'center'; ctx.fillText(l.text, px, py); }
    else { ctx.font = `500 15px ${family}`; ctx.fillStyle = ink; ctx.textAlign = 'right'; ctx.fillText(l.text, px - thick / 2 - 8, py); }
  });
  // Footer: the credit and reading key on the left, the Pitcher List wordmark on the right.
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = muted; ctx.font = `500 13px ${family}`;
  ctx.fillText('blandalytics.com/sequencing-flow', PADX, S - 40);
  ctx.fillText('Columns: pitch number in the plate appearance · bands: pitch type · links: one plate appearance each', PADX, S - 20);
  if (mark) {
    const mw = 230, mh = mw * mark.height / mark.width;
    ctx.drawImage(mark, S - PADX - mw, S - 22 - mh, mw, mh);
  }

  const a = document.createElement('a');
  const slug = `${meta.pitcher}_${meta.date}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  a.download = `${slug}_sequencing_flow.png`;
  a.href = cv.toDataURL('image/png');
  a.click();
}

/** Draw a flow. Resolves once Plotly has painted it. */
export function show(data) {
  DATA = data;
  focus = null;
  pinned = null;
  paById = new Map(DATA.pas.map(p => [p.id, p]));
  tip.hidden = true;
  fillLegend();
  return render().then(wireHover);   // gd.on exists only once the first plot has finished
}

/** Clear the chart (between selections). */
export function clear() {
  DATA = null;
  pinned = null;
  legendEl.innerHTML = '';
  endKey.hidden = true;
  tip.hidden = true;
  if (chartEl.data) Plotly.purge(chartEl);
  wired = false;
}

export function hasFlow() { return !!DATA; }
