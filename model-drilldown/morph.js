// Redrawing a figure the way Sequencing Flow's Plotly sankey redraws (Plotly.react: its sankey
// constants are duration 500 ms, linear easing):
//
//   * elements that persist (data-m="<key>" in both the old and new SVG) move and resize from
//     where they were to where they now are: every number in their geometry attributes, their
//     colours, and a text's number, are tweened
//   * ribbons (data-f) are drawn at their new shape and fade in from nothing, as Plotly's links do
//   * elements that are new fade in; elements that are gone fade out where they were
//
// A redraw that arrives mid-transition starts from wherever the last one had got to.

const DURATION = 500;
const GEOMETRY = [
  'x',
  'y',
  'width',
  'height',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'd',
  'transform',
  'opacity',
  'fill-opacity',
  'stroke-width',
];
const COLOURS = ['fill', 'stroke'];
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// "M10,20C..." -> a function of t that keeps the skeleton and tweens every number
function numberTween(a, b) {
  const na = a.match(NUM),
    nb = b.match(NUM);
  if (!na || !nb || na.length !== nb.length) return null;
  const sa = a.split(NUM),
    sb = b.split(NUM);
  if (sa.join('|') !== sb.join('|')) return null;
  const va = na.map(Number),
    vb = nb.map(Number);
  return (t) => {
    let out = sb[0];
    for (let i = 0; i < vb.length; i++) out += +(va[i] + (vb[i] - va[i]) * t).toFixed(2) + sb[i + 1];
    return out;
  };
}

function rgb(c) {
  if (!c) return null;
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(c);
  return m ? m.slice(1).map(Number) : null;
}
function colourTween(a, b) {
  const ca = rgb(a),
    cb = rgb(b);
  if (!ca || !cb) return null;
  return (t) => `rgb(${ca.map((v, i) => Math.round(v + (cb[i] - v) * t)).join(',')})`;
}

// "+17.7" -> "+4.2": the number counts across, keeping the new text's decimals and signs
function textTween(a, b) {
  const re = /^([^\d]*?)([+−-]?)(\d*\.?\d+)(.*)$/;
  const ma = re.exec(a),
    mb = re.exec(b);
  if (!ma || !mb || ma[1] !== mb[1] || ma[4] !== mb[4] || a === b) return null;
  const val = (m) => (m[2] === '−' || m[2] === '-' ? -1 : 1) * Number(m[3]);
  const va = val(ma),
    vb = val(mb);
  const dec = (mb[3].split('.')[1] || '').length;
  const lead = mb[3].startsWith('.'); // wOBA style
  const signed = mb[2] !== '';
  const neg = mb[2] === '-' ? '-' : '−';
  return (t) => {
    const v = va + (vb - va) * t;
    let s = Math.abs(v).toFixed(dec);
    if (lead) s = s.replace(/^0\./, '.');
    const sign = v < 0 && Number(s) !== 0 ? neg : signed && Number(s) !== 0 ? '+' : '';
    return mb[1] + sign + s + mb[4];
  };
}

const running = new WeakMap();

export function morph(host, markup) {
  const old = host.querySelector(':scope > svg');
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  const svg = tpl.content.firstElementChild;
  if (running.has(host)) cancelAnimationFrame(running.get(host));
  // a hidden page gets no animation frames, so it goes straight to the end state
  if (!old || reduced() || document.visibilityState === 'hidden') {
    host.replaceChildren(svg);
    return svg;
  }
  const oldKeyed = new Map();
  for (const e of old.querySelectorAll('[data-m]')) oldKeyed.set(e.dataset.m, e);
  const tweens = []; // (t) => void
  const fades = []; // [element, from, to]

  for (const el of svg.querySelectorAll('[data-m]')) {
    const o = oldKeyed.get(el.dataset.m);
    if (!o || o.tagName !== el.tagName) {
      if (!el.closest('[data-f]')) fades.push([el, 0, 1]);
      continue;
    }
    oldKeyed.delete(el.dataset.m);
    for (const attr of GEOMETRY) {
      const a = o.getAttribute(attr),
        b = el.getAttribute(attr);
      if (a == null || b == null || a === b) continue;
      const f = numberTween(a, b);
      if (f) {
        el.setAttribute(attr, a);
        tweens.push((t) => el.setAttribute(attr, f(t)));
      }
    }
    for (const attr of COLOURS) {
      const a = o.getAttribute(attr),
        b = el.getAttribute(attr);
      if (a == null || b == null || a === b) continue;
      const f = colourTween(a, b);
      if (f) {
        el.setAttribute(attr, a);
        tweens.push((t) => el.setAttribute(attr, f(t)));
      }
    }
    if (el.tagName === 'text' && el.childElementCount === 0) {
      const f = textTween(o.textContent, el.textContent);
      if (f) {
        el.textContent = f(0);
        tweens.push((t) => {
          el.textContent = f(t);
        });
      }
    }
  }
  // ribbons: final shape, faded in from nothing
  for (const el of svg.querySelectorAll('[data-f]')) fades.push([el, 0, 1]);

  // what's gone fades out where it was: the outermost of the old keyed leftovers (and old
  // ribbons), copied into the new figure in the old coordinates
  const ghosts = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  ghosts.setAttribute('class', 'ghosts');
  ghosts.style.pointerEvents = 'none';
  const gone = [...oldKeyed.values(), ...old.querySelectorAll('[data-f]')];
  const goneSet = new Set(gone);
  const rootCtm = old.getScreenCTM();
  for (const o of gone) {
    let p = o.parentElement,
      inner = false;
    while (p && p !== old) {
      if (goneSet.has(p)) {
        inner = true;
        break;
      }
      p = p.parentElement;
    }
    if (inner || o.closest('.ghosts')) continue;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const pc = o.parentElement.getScreenCTM();
    if (rootCtm && pc) {
      const m = rootCtm.inverse().multiply(pc);
      g.setAttribute('transform', `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`);
    }
    const c = o.cloneNode(true);
    c.removeAttribute('data-m');
    c.removeAttribute('data-f');
    c.querySelectorAll('[data-m],[data-f]').forEach((e) => {
      e.removeAttribute('data-m');
      e.removeAttribute('data-f');
    });
    const from = parseFloat(getComputedStyle(o).opacity) || 1;
    c.style.opacity = from;
    g.appendChild(c);
    ghosts.appendChild(g);
    fades.push([c, from, 0]);
  }
  svg.appendChild(ghosts);

  // the figure's height follows (a waterfall with more rows is taller)
  const vbA = old.getAttribute('viewBox'),
    vbB = svg.getAttribute('viewBox');
  const vbF = vbA !== vbB && numberTween(vbA, vbB);
  if (vbF) {
    svg.setAttribute('viewBox', vbA);
    tweens.push((t) => svg.setAttribute('viewBox', vbF(t)));
  }

  // A fade-in ends at the opacity the element will have once its inline style is gone (its
  // attribute or the page's CSS), read in place before anything paints.
  host.replaceChildren(svg);
  for (const f of fades) if (f[1] === 0) f[2] = parseFloat(getComputedStyle(f[0]).opacity);
  for (const [el, a] of fades) el.style.opacity = a;
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / DURATION); // linear, as Plotly's sankey
    for (const f of tweens) f(t);
    for (const [el, a, b] of fades) el.style.opacity = a + (b - a) * t;
    if (t < 1) {
      running.set(host, requestAnimationFrame(step));
    } else {
      running.delete(host);
      for (const [el] of fades) el.style.opacity = '';
      ghosts.remove();
    }
  };
  running.set(host, requestAnimationFrame(step));
  return svg;
}
