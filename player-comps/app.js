'use strict';
// Page: feature picker, presets, target selection; the Web Worker (comps-worker.js) does all the math.
(function () {
  const $ = (id) => document.getElementById(id);
  const worker = new Worker('comps-worker.js?v=1');
  let msgId = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const m = e.data, p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m);
  };
  // Data location: on blandalytics.com (or with ?data=r2) the R2 build named by player-comps/index.json, which is read
  // at an hourly ?v= so a new upload shows within the hour and the build folder itself is immutable. Else local data/.
  const R2 = 'https://data.blandalytics.com/player-comps/';
  let dataBase = null;
  async function resolveBase() {
    if (dataBase) return dataBase;
    const useR2 = /(^|\.)blandalytics\.com$/.test(location.hostname) || new URLSearchParams(location.search).get('data') === 'r2';
    if (!useR2) return (dataBase = 'data/');
    const hour = Math.floor(Date.now() / 3600000);
    const idx = await fetch(`${R2}index.json?v=${hour}`).then((r) => { if (!r.ok) throw new Error('index.json: ' + r.status); return r.json(); });
    return (dataBase = `${R2}${idx.built}/`);
  }
  const ask = (msg) => new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });

  const FAM_VARS = ['--fam-1', '--fam-2', '--fam-3', '--fam-4', '--fam-5', '--fam-6', '--fam-7', '--fam-8'];
  const ROLE_LABEL = { pitcher: 'Pitchers', pitch: 'Pitches', hitter: 'Hitters' };
  const ROW_NOUN = { pitcher: 'pitcher-seasons', pitch: 'pitches', hitter: 'hitter-seasons' };
  const DEFAULT_PLAYER = { pitcher: 'Tarik Skubal', pitch: 'Tarik Skubal', hitter: 'Juan Soto' };
  const PT_NAMES = { FF: 'Four-seam', FA: 'Fastball', SI: 'Sinker', FC: 'Cutter', SL: 'Slider', ST: 'Sweeper', SV: 'Slurve', CU: 'Curveball',
    KC: 'Knuckle curve', CS: 'Slow curve', CH: 'Changeup', FS: 'Splitter', FO: 'Forkball', EP: 'Eephus', KN: 'Knuckleball', SC: 'Screwball', UN: 'Unknown' };
  const WARN = {
    'few-effective-comps': 'Few close comps, so the forecast leans on the aging curve and its range widens.',
    'many-features': 'More than 12 features: distances bunch together and the closest comps get less distinct.',
    'small-pool': 'Fewer comps were eligible than the list holds.',
    'no-eligible-comps': 'No eligible comps. Loosen the filters or switch to Style mode.',
    'no-comps': 'No comps share the selected inputs with this target.',
    'no-features': 'Pick at least one feature.',
  };

  const roles = {};       // role -> { manifest, names, index, tuning, fi, byPlayer }
  const S = { role: 'pitcher', row: -1, preset: null, mode: 'forecast', stat: null, rate: new Set(), mix: false, cat: new Set(),
    filters: new Set(), gw: { rate: 0.75, mix: 0.15, cat: 0.1 }, corr: false, weights: {}, nums: {}, shown: 25 };
  let last = null;

  // ---------- formatting ----------
  function fmt(f, v) {
    if (v === undefined || v === null || Number.isNaN(v)) return '–';
    if (f.id === 'sb_rate') return Math.exp(v).toFixed(1);
    if (f.unit === 'logit') return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
    if (f.unit === 'wOBA') return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3).replace(/^0/, '');
    if (['iso', 'babip', 'woba'].includes(f.id)) return v.toFixed(3).replace(/^0/, '');
    if (f.unit === 'ft/s') return v.toFixed(1);
    if (f.unit === '%') return (100 * v).toFixed(1) + '%';
    if (f.unit === 'mph') return v.toFixed(1);
    if (f.unit === 'rpm') return Math.round(v).toLocaleString();
    if (f.unit === 'ft') return v.toFixed(2);
    if (f.unit === '°') return v.toFixed(0) + '°';
    if (f.unit === 'ft/s²') return v.toFixed(1);
    if (/wobacon/.test(f.id)) return v.toFixed(3).replace(/^0/, '');
    if (/plus|stuff$/.test(f.id)) return v.toFixed(0);
    if (f.id === 'spin_eff') return (100 * v).toFixed(0) + '%';
    return v.toFixed(2);
  }
  function fmtStat(st, v) {
    if (Number.isNaN(v) || v === undefined) return '–';
    if (st.transform !== 'logit') return v.toFixed(0);
    return st.scale === 100 ? (100 * v).toFixed(1) + '%' : v.toFixed(3).replace(/^0/, '');
  }
  const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- role data ----------
  async function loadRole(role) {
    if (roles[role]) return roles[role];
    setStatus('Loading ' + ROLE_LABEL[role].toLowerCase() + '…');
    const m = await ask({ type: 'load', role, base: await resolveBase() });
    const R = { manifest: m.manifest, names: m.names, index: m.index, tuning: m.tuning };
    R.fi = Object.fromEntries(R.manifest.features.map((f, i) => [f.id, i]));
    R.ci = Object.fromEntries(R.manifest.categoricals.map((c, i) => [c.id, i]));
    R.byPlayer = new Map();
    const n = R.manifest.n;
    for (let i = 0; i < n; i++) {
      const pid = R.index.playerId[i];
      if (!R.byPlayer.has(pid)) R.byPlayer.set(pid, []);
      R.byPlayer.get(pid).push(i);
    }
    R.players = [...R.byPlayer.keys()].map((pid) => {
      const rows = R.byPlayer.get(pid);
      return { pid, name: R.names[pid] || String(pid), rows, last: Math.max(...rows.map((r) => R.index.season[r])), sample: rows.reduce((s, r) => s + R.index.sample[r], 0) };
    }).sort((a, b) => b.sample - a.sample);
    roles[role] = R;
    return R;
  }
  const catCode = (R, row, id) => R.index.cat[R.ci[id] * R.manifest.n + row];
  const catLabel = (R, row, id) => R.manifest.categoricals[R.ci[id]].levels[catCode(R, row, id)];
  const rowLabel = (R, row) => {
    const s = R.index.season[row];
    if (S.role === 'pitch') return `${s} ${PT_NAMES[catLabel(R, row, 'pt')] || catLabel(R, row, 'pt')}`;
    return String(s);
  };

  // ---------- presets and controls ----------
  function applyPreset(R, p) {
    S.preset = p.id; S.mode = p.mode;
    S.stat = p.stat || S.stat || R.manifest.forecastStats[0].id;
    if (!R.manifest.forecastStats.some((s) => s.id === S.stat)) S.stat = R.manifest.forecastStats[0].id;
    S.rate = new Set(p.features.rate); S.mix = !!p.features.mix; S.cat = new Set(p.features.cat);
    S.filters = new Set(p.filters); S.gw = { ...p.groupWeights }; S.weights = {}; S.nums = {}; S.corr = !!p.correlation;
  }

  function renderControls(R) {
    const man = R.manifest;
    document.querySelectorAll('[data-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === S.role)));
    $('search').placeholder = S.role === 'pitch' ? 'Search pitchers, then pick a pitch' : S.role === 'hitter' ? 'Search hitters' : 'Search pitchers';
    $('presets').innerHTML = man.presets.map((p) => `<button class="plpd-chip" data-preset="${p.id}" aria-pressed="${p.id === S.preset}">${esc(p.label)}</button>`).join('');
    $('stat').innerHTML = man.forecastStats.map((s) => `<option value="${s.id}"${s.id === S.stat ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    $('stat').disabled = S.mode !== 'forecast';
    $('corr').checked = S.corr;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));

    const fams = man.families;
    $('families').innerHTML = fams.map((fam, k) => {
      const feats = man.features.filter((f) => f.family === fam);
      return `<div class="family"><h4><i class="swatch" style="background:var(${FAM_VARS[k]})"></i>${esc(fam)}</h4>` + feats.map((f) => {
        const w = S.weights[f.id] !== undefined ? S.weights[f.id] : f.w0;
        return `<div class="feat"><label class="plpd-check" title="${esc(featTitle(f))}"><input type="checkbox" data-feat="${f.id}"${S.rate.has(f.id) ? ' checked' : ''}> ${esc(f.label)}</label>` +
          `<input type="number" step="0.1" min="0" value="${(+w).toFixed(2)}" data-weight="${f.id}" aria-label="${esc(f.label)} weight" title="Feature weight (default from year-over-year reliability)"></div>`;
      }).join('') + '</div>';
    }).join('');

    const other = [];
    if (man.mix) other.push(`<label class="plpd-check"><input type="checkbox" id="use_mix"${S.mix ? ' checked' : ''}> ${esc(man.mix.label)} (cosine)</label>`);
    for (const c of man.categoricals) {
      if (c.id === 'pt' || c.id === 'cls' || c.id === 'group') continue;
      other.push(`<label class="plpd-check"><input type="checkbox" data-cat="${c.id}"${S.cat.has(c.id) ? ' checked' : ''}> ${esc(c.label)} (penalize mismatch)</label>`);
    }
    $('other_inputs').innerHTML = other.join('');
    $('filters').innerHTML = man.categoricals.filter((c) => c.id !== 'pt').map((c) =>
      `<label class="plpd-check"><input type="checkbox" data-filter="${c.id}"${S.filters.has(c.id) ? ' checked' : ''}> Same ${esc(c.label.toLowerCase())}</label>`).join('');
    const groups = [['rate', 'Stats'], ...(man.mix ? [['mix', S.role === 'hitter' ? 'Batted balls' : 'Pitch mix']] : []), ['cat', 'Categories']];
    $('group_weights').innerHTML = groups.map(([g, label]) => {
      const v = S.gw[g] || 0;
      return `<div class="slider"><span>${label}</span><input type="range" class="plpd-range" min="0" max="1" step="0.05" value="${v}" data-gw="${g}" style="--plpd-range-pct:${v * 100}%"><output>${v.toFixed(2)}</output></div>`;
    }).join('');
    const tuned = currentTuned(R);
    const numDefs = [['K', 'Comps kept (K)', 1], ['beta', 'Bandwidth β', 0.05], ['m', 'Prior strength m', 1], ['ageWindow', 'Age window (yrs)', 0.5], ['minSample', `Min comp ${man.sampleLabel}`, 10]];
    $('nums').innerHTML = numDefs.map(([k, label, step]) => `<label>${label}<input type="number" step="${step}" min="0" data-num="${k}" value="${S.nums[k] !== undefined ? S.nums[k] : tuned[k]}"></label>`).join('');
  }

  function featTitle(f) {
    return `${f.label}${f.unit ? ' (' + f.unit + ')' : ''}. Transform: ${f.transform}; shrinkage n0 ${f.n0}; year-over-year r ${f.yoy}; default weight ${f.w0}.`;
  }

  function currentTuned(R) {
    const d = R.manifest.defaults, t = R.tuning && R.tuning.perStat && R.tuning.perStat[S.stat];
    return { K: (t && t.K) || d.K, kh: (t && t.kh) || d.kh, beta: (t && t.beta) || d.beta, m: (t && t.m) || d.m, ageWindow: d.ageWindow, minSample: 0, h0: (R.tuning && R.tuning.h0ByPreset && R.tuning.h0ByPreset[S.preset]) || (R.tuning && R.tuning.h0) || d.h0 };
  }

  // ---------- target selection ----------
  function setTargetPlayer(R, pid, season, pt) {
    const rows = R.byPlayer.get(pid);
    if (!rows) return;
    const seasons = [...new Set(rows.map((r) => R.index.season[r]))].sort((a, b) => b - a);
    const s = seasons.includes(season) ? season : seasons[0];
    $('search').value = R.names[pid] || pid;
    $('season').innerHTML = seasons.map((x) => `<option${x === s ? ' selected' : ''}>${x}</option>`).join('');
    if (S.role === 'pitch') {
      const pr = rows.filter((r) => R.index.season[r] === s).sort((a, b) => R.index.sample[b] - R.index.sample[a]);
      $('pitch_field').hidden = false;
      $('pitch').innerHTML = pr.map((r) => { const c = catLabel(R, r, 'pt'); return `<option value="${r}">${esc(PT_NAMES[c] || c)} (${Math.round(R.index.sample[r])})</option>`; }).join('');
      const keep = pr.find((r) => catLabel(R, r, 'pt') === pt);
      S.row = keep !== undefined ? keep : pr[0];
      $('pitch').value = String(S.row);
    } else {
      $('pitch_field').hidden = true;
      S.row = rows.find((r) => R.index.season[r] === s);
    }
  }

  function setupSearch() {
    const input = $('search'), menu = $('search_menu');
    let items = [], active = -1;
    const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    input.addEventListener('input', () => {
      const R = roles[S.role]; if (!R) return;
      const q = input.value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (q.length < 2) return close();
      items = R.players.filter((p) => p.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q)).slice(0, 10);
      menu.innerHTML = items.map((p, i) => `<li role="option" data-i="${i}">${esc(p.name)} <small>${Math.min(...p.rows.map((r) => R.index.season[r]))}–${p.last}</small></li>`).join('');
      menu.hidden = !items.length; input.setAttribute('aria-expanded', String(!!items.length)); active = -1;
    });
    const pick = (i) => { const p = items[i]; if (!p) return; close(); setTargetPlayer(roles[S.role], p.pid, p.last); run(); };
    menu.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
    input.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        menu.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === active));
      } else if (e.key === 'Enter') { e.preventDefault(); pick(active < 0 ? 0 : active); } else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  // ---------- query ----------
  function buildQuery(R) {
    const man = R.manifest, tuned = currentTuned(R);
    const num = (k) => (S.nums[k] !== undefined && S.nums[k] !== '' ? +S.nums[k] : tuned[k]);
    let weights = null;
    if (Object.keys(S.weights).length) weights = man.features.map((f) => (S.weights[f.id] !== undefined ? +S.weights[f.id] : f.w0));
    const K = Math.max(5, Math.round(num('K')));
    return {
      targetRow: S.row, stat: S.stat, mode: S.mode,
      features: { rate: man.features.filter((f) => S.rate.has(f.id)).map((f) => R.fi[f.id]), mix: S.mix, cat: [...S.cat].map((c) => R.ci[c]) },
      groupWeights: S.gw, correlation: S.corr, weights,
      filters: [...S.filters].map((c) => ({ cat: R.ci[c] })),
      options: { K, kh: S.nums.K !== undefined ? Math.max(1, Math.round(K / 2)) : tuned.kh, beta: num('beta'), m: num('m'), ageWindow: num('ageWindow'), minSample: num('minSample'), h0: tuned.h0 },
    };
  }

  let runSeq = 0;
  async function run() {
    const R = roles[S.role];
    if (!R || S.row < 0) return;
    const seq = ++runSeq;
    setStatus('Finding comps…');
    writeHash(R);
    try {
      const m = await ask({ type: 'query', role: S.role, q: buildQuery(R) });
      if (seq !== runSeq) return;
      last = m.result; S.shown = 25;
      render(R, last);
      setStatus(`${last.diagnostics.eligible.toLocaleString()} eligible ${ROW_NOUN[S.role]} scanned in ${last.ms.toFixed(1)} ms.`);
    } catch (e) { setStatus(e.message, true); }
  }

  // ---------- rendering ----------
  function setStatus(t, err) { $('status').textContent = t; $('status').classList.toggle('err', !!err); }

  function render(R, res) {
    const man = R.manifest;
    $('results').hidden = false;
    const t = res.target, sel = res.diagnostics.selRate || [];
    const tags = rowTags(R, t.row);
    const title = S.role === 'pitch' ? `${esc(t.name)}’s ${t.season} ${esc(PT_NAMES[catLabel(R, t.row, 'pt')] || catLabel(R, t.row, 'pt'))}` : `${esc(t.name)}, ${t.season}`;
    const sub = [`Age ${Math.floor(t.age)}`, `${Math.round(t.sample).toLocaleString()} ${man.sampleLabel}`, ...tags].filter(Boolean).join(' · ');
    const within = S.role === 'pitch' ? ` among ${catLabel(R, t.row, 'cls') === 'SL' ? 'sliders and sweepers' : (PT_NAMES[catLabel(R, t.row, 'cls')] || '').toLowerCase() + 's'}` : '';
    $('target_card').innerHTML = `<h2 class="plpd-pane__title">${title}</h2><p class="sub">${sub}</p>` +
      `<div class="chips-vals">${sel.map((f, a) => { const F = man.features[f], v = t.values[a]; return `<div class="val" title="${esc(featTitle(F))}"><span>${esc(F.label)}</span><b>${fmt(F, v.raw)}</b><i>${ord(Math.round(100 * phi(v.z)) || 1)} pct${within}</i></div>`; }).join('')}</div>`;

    renderForecast(R, res);
    renderWarnings(R, res);
    renderComps(R, res);
    $('how').innerHTML = howText(R);
  }

  function renderForecast(R, res) {
    const man = R.manifest, f = res.forecast, st = man.forecastStats.find((s) => s.id === res.stat);
    const card = $('forecast_card');
    if (!f) {
      const top = res.comps.slice(0, 10).map((c) => c.score).sort((a, b) => a - b);
      card.innerHTML = `<h2 class="plpd-pane__title">Style match</h2><p class="sub">Style mode finds similar profiles across every season and age and makes no forecast.</p>` +
        `<dl class="facts"><dt>Closest comp</dt><dd>${res.comps[0] ? res.comps[0].score + ' (' + esc(res.comps[0].name) + ')' : '–'}</dd><dt>Median of top 10</dt><dd>${top.length ? top[top.length >> 1] : '–'}</dd><dt>Eligible</dt><dd>${res.diagnostics.eligible.toLocaleString()}</dd></dl>`;
      return;
    }
    const q = f.quantiles, lo = q[0].value, hi = q[2].value;
    const span = [Math.min(lo, f.baselineValue), Math.max(hi, f.baselineValue)];
    const pad = (span[1] - span[0]) * 0.15 || 0.01, a = span[0] - pad, b = span[1] + pad;
    const x = (v) => ((v - a) / (b - a)) * 100;
    const what = S.role === 'pitch' ? `${res.target.season + 1} ${st.label} of this pitch` : `${res.target.season + 1} ${st.label}`;
    card.innerHTML = `<h2 class="plpd-pane__title">${esc(what)}</h2>` +
      `<div class="hero">${fmtStat(st, f.value)}</div>` +
      `<div class="range">10th–90th percentile: <b>${fmtStat(st, lo)}</b> to <b>${fmtStat(st, hi)}</b></div>` +
      `<div class="fc-bar" role="img" aria-label="Forecast ${fmtStat(st, f.value)}, range ${fmtStat(st, lo)} to ${fmtStat(st, hi)}, Marcel baseline ${fmtStat(st, f.baselineValue)}"><div class="track"></div>` +
      `<div class="band" style="left:${x(lo)}%;width:${x(hi) - x(lo)}%"></div><div class="base" style="left:${x(f.baselineValue)}%"></div><div class="pt" style="left:${x(f.value)}%"></div></div>` +
      `<div class="fc-axis"><span>${fmtStat(st, a)}</span><span>${fmtStat(st, b)}</span></div>` +
      `<div class="fc-key"><span><i style="background:#3987e566"></i>10–90 range</span><span><i style="background:#fff"></i>Forecast</span><span><i style="background:var(--brand-brand-amber)"></i>Marcel baseline</span></div>` +
      `<dl class="facts"><dt>Based on</dt><dd>the equivalent of ${f.nEff.toFixed(0)} comps (weight ${(100 * f.alpha).toFixed(0)}% vs the aging curve)</dd>` +
      `<dt>Marcel baseline</dt><dd>${fmtStat(st, f.baselineValue)}</dd>` +
      `<dt>Comps alone</dt><dd>${fmtStat(st, f.compValue)}</dd><dt>Aging curve alone</dt><dd>${fmtStat(st, f.priorValue)}</dd>` +
      `<dt>Tuned for</dt><dd>${esc(st.label)} (league-relative change from the baseline)</dd></dl>`;
  }

  function renderWarnings(R, res) {
    const d = res.diagnostics, man = R.manifest, out = [];
    for (const w of d.warnings) {
      if (w === 'correlated-features') out.push(`<b class="warn">Correlated stats.</b> Several selected features measure the same skill (effective dimension ${d.dEff.toFixed(1)} of ${d.d}).<button class="plpd-btn" id="fix_corr">Correct for correlated stats</button>`);
      else out.push(`<b class="warn">Note.</b> ${esc(WARN[w] || w)}`);
    }
    if (d.droppedFeatures && d.droppedFeatures.length) out.push(`<b class="warn">Dropped.</b> The target has no ${d.droppedFeatures.map((f) => esc(man.features[f].label)).join(', ')}.`);
    if (S.corr && d.lambdaUsed < 1) out.push(`Correlation correction on (shrinkage λ = ${d.lambdaUsed.toFixed(1)}); per-feature shares below are approximate.`);
    $('warnings').innerHTML = out.join('<br>');
    const fix = $('fix_corr');
    if (fix) fix.onclick = () => { S.corr = true; $('corr').checked = true; run(); };
  }

  function rowTags(R, row) {
    if (S.role === 'hitter') {
      const b = catLabel(R, row, 'bats'), p = catLabel(R, row, 'pos');
      return [p, b ? { R: 'Bats R', L: 'Bats L', S: 'Switch' }[b] : ''];
    }
    const h = catLabel(R, row, 'throws');
    return [catLabel(R, row, 'role'), h ? h + 'HP' : ''];
  }

  function famIndex(R) {
    const fams = R.manifest.families;
    return { fams, of: (f) => fams.indexOf(R.manifest.features[f].family), mix: fams.length, cat: fams.length + (R.manifest.mix ? 1 : 0) };
  }

  function renderComps(R, res) {
    const man = R.manifest, st = man.forecastStats.find((s) => s.id === res.stat), FI = famIndex(R);
    const used = new Set();
    for (const c of res.comps) { for (const s of c.contrib) if (s.share > 0) used.add(FI.of(s.feature)); if (c.groups.mix > 0) used.add(FI.mix); if (c.groups.cat > 0) used.add(FI.cat); }
    const labels = [...FI.fams, ...(man.mix ? [S.role === 'hitter' ? 'Batted balls' : 'Pitch mix'] : []), 'Categories'];
    $('legend').innerHTML = labels.map((l, k) => used.has(k) ? `<span><i class="swatch" style="background:var(${FAM_VARS[k]})"></i>${esc(l)}</span>` : '').join('');
    $('comps_desc').textContent = (S.mode === 'forecast'
      ? `Closest ${ROW_NOUN[S.role]} from earlier seasons, within the age window, that have a next season to learn from. `
      : 'Closest profiles across all seasons and ages. ') +
      'Score is 0–100 on a fixed scale; “Closer than” is the share of random pairs farther apart. The bar is the distance, split by what drove it. Click a row for the feature-by-feature comparison.';
    const maxD = Math.max(1 - Math.exp(-1), ...res.comps.map((c) => c.D));
    const nowHead = S.role === 'pitch' ? `${st.label}` : `${st.label}`;
    let html = `<thead><tr><th>#</th><th>${{ pitch: 'Pitch', pitcher: 'Pitcher', hitter: 'Hitter' }[S.role]}</th><th>Season</th><th class="hide-sm">Age</th><th>Score</th><th class="hide-sm">Closer than</th><th class="hide-sm" title="In the comp's season">${esc(nowHead)}</th><th title="The comp's next season">Next ${esc(st.label)}</th><th class="l bar-cell">What separates them</th></tr></thead><tbody>`;
    res.comps.slice(0, S.shown).forEach((c, i) => {
      const segs = [];
      const fam = new Array(labels.length).fill(0), famFeat = labels.map(() => []);
      for (const s of c.contrib) { const k = FI.of(s.feature); fam[k] += s.share * c.groups.rate; if (s.share > 0.005) famFeat[k].push([man.features[s.feature].label, s.share * c.groups.rate]); }
      if (c.groups.mix) fam[FI.mix] += c.groups.mix;
      if (c.groups.cat) fam[FI.cat] += c.groups.cat;
      fam.forEach((v, k) => {
        if (v <= 0) return;
        const w = (v / maxD) * 100;
        const top = famFeat[k].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, x]) => `${l} ${(100 * x / c.D).toFixed(0)}%`).join(', ');
        const tip = `${labels[k]}: ${(100 * v / c.D).toFixed(0)}% of the distance${top ? ' (' + top + ')' : ''}`;
        segs.push(`<i style="width:${w}%;background:var(${FAM_VARS[k]})" data-tip="${esc(tip)}"></i>`);
      });
      const ptl = S.role === 'pitch' ? ` <span class="muted">${esc(catLabel(R, c.row, 'pt'))}</span>` : '';
      html += `<tr class="main" data-i="${i}" tabindex="0"><td class="muted">${i + 1}</td><td class="name">${esc(c.name)}${ptl}</td><td>${c.season}</td><td class="hide-sm">${Math.floor(c.age)}</td>` +
        `<td><span class="score">${c.score}</span></td><td class="hide-sm">${(100 * c.closerThan).toFixed(1)}%</td>` +
        `<td class="hide-sm">${fmtStat(st, c.statNow)}</td><td>${Number.isNaN(c.statNext) ? '<span class="muted">–</span>' : fmtStat(st, c.statNext)}</td>` +
        `<td class="l bar-cell"><div class="bar" role="img" aria-label="Distance ${c.D.toFixed(2)}">${segs.join('')}</div></td></tr>`;
      html += `<tr class="detail" data-for="${i}" hidden><td colspan="9"></td></tr>`;
    });
    html += '</tbody>';
    $('comps').innerHTML = html;
    $('more').hidden = res.comps.length <= S.shown;
  }

  function renderDetail(R, i) {
    const c = last.comps[i], t = last.target, man = R.manifest, sel = last.diagnostics.selRate || [];
    const cells = sel.map((f, a) => {
      const F = man.features[f], dz = Math.abs(c.values[a].z - t.values[a].z);
      return `<div class="dg" title="${esc(featTitle(F))}"><span>${esc(F.label)}</span><b>${fmt(F, t.values[a].raw)} / ${fmt(F, c.values[a].raw)}</b><em>${Number.isNaN(dz) ? '' : dz.toFixed(1) + ' SD'}</em></div>`;
    });
    if (man.mix && t.mix && c.mix) {
      for (const b of man.mix.blocks) {
        const st = b.start || 0, word = S.role === 'hitter' ? '' : ' usage';
        b.columns.forEach((col, k) => { const a = t.mix[st + k], z = c.mix[st + k]; if (a > 0.005 || z > 0.005) cells.push(`<div class="dg"><span>${esc(b.labels[k])}${word}</span><b>${(100 * a).toFixed(0)}% / ${(100 * z).toFixed(0)}%</b><em></em></div>`); });
      }
    }
    return `<div class="sub" style="margin:0 0 8px">Target / ${esc(c.name)} ${c.season} (${rowTags(R, c.row).filter(Boolean).join(', ')}, ${Math.round(c.sample)} ${man.sampleLabel}). Gaps in season-standardized SD${S.role === 'pitch' ? ' within the pitch class' : ''}.${c.weight !== undefined ? ` Kernel weight ${c.weight.toFixed(2)}.` : ''}</div><div class="detail-grid">${cells.join('')}</div>`;
  }

  function howText(R) {
    const man = R.manifest;
    const base = S.role === 'hitter'
      ? '<p><b>Rows</b> are hitter-seasons with 100+ PA, 2015–2026. Besides results, plate discipline, contact quality, sprint speed, steals and bat tracking (2023 on), the <b>Skills vs PLV</b> family (2021 on) measures each hitter against the PLV pitch model: how much more often he chases, swings in the zone, whiffs and puts contact in play, and how much damage he does, than the model expects of the exact pitches he saw (plv-projections’ residual skills). Batted-ball type and spray direction are compared by cosine similarity.</p>'
      : S.role === 'pitch'
      ? '<p><b>Rows</b> are pitcher-season-pitch types with 50+ pitches. Physical traits come from the Stuff model’s inputs (movement in arm-side terms, so lefties and righties compare); <b>Stuff+</b>, <b>Pitching+ (PLV)</b> and <b>Location+</b> and the outcome probabilities come from the Stuff and PLV models. Each feature is z-scored within its season and pitch class, so a slider is measured against sliders and sweepers.</p>'
      : '<p><b>Rows</b> are pitcher-seasons with 100+ batters faced, 2020–2026. Features combine results and plate discipline, pitcher-level <b>Stuff+</b>, <b>Pitching+ (PLV)</b> and <b>Location+</b>, the PA rates Stuff and PLV imply, and primary-fastball shape and release. Pitch mix is compared by cosine similarity.</p>';
    return base +
      '<p><b>Preprocessing.</b> Noisy rates are shrunk toward the season’s league mean by their measured split-half reliability, put on a logit scale, z-scored within season and clipped at ±4. Default feature weights follow each feature’s year-over-year reliability.</p>' +
      '<p><b>Distance.</b> A reliability-weighted RMS distance over the selected stats, blended with pitch mix and categorical mismatches. Each group is rescaled per query so a random pair scores about the same whatever is selected. “Correct for correlated stats” switches the stat group to a shrunk Mahalanobis distance.</p>' +
      `<p><b>Forecast.</b> Each comp contributes its change from a Marcel baseline (${man.marcel.weights.join('/')}) to its next season, in league-relative terms, weighted by a Gaussian kernel. The result is shrunk toward the aging curve by the effective number of comps; the 10–90 range mixes the comps’ changes with the aging curve’s spread. In backtests against Marcel the ranges cover about 80% of outcomes as intended, and point forecasts beat Marcel by a few percent for K%, HR%, SwStr%, Stuff+ and PLV (not for BB%).</p>`;
  }

  // ---------- URL state ----------
  function writeHash(R) {
    const pid = R.index.playerId[S.row], s = R.index.season[S.row];
    const pt = S.role === 'pitch' ? '/' + catLabel(R, S.row, 'pt') : '';
    history.replaceState(null, '', `#${S.role}/${pid}/${s}${pt}/${S.preset}`);
  }
  function readHash() {
    const p = location.hash.slice(1).split('/');
    if (!p[0] || !ROLE_LABEL[p[0]]) return null;
    return { role: p[0], pid: +p[1], season: +p[2], pt: p[0] === 'pitch' ? p[3] : null, preset: p[0] === 'pitch' ? p[4] : p[3] };
  }

  // ---------- events ----------
  async function switchRole(role, want) {
    S.role = role;
    const R = await loadRole(role);
    const p = (want && R.manifest.presets.find((x) => x.id === want.preset)) || R.manifest.presets[0];
    applyPreset(R, p);
    let pid = want && want.pid;
    if (!pid || !R.byPlayer.has(pid)) { const sk = R.players.find((x) => x.name === DEFAULT_PLAYER[role]); pid = (sk || R.players[0]).pid; }
    setTargetPlayer(R, pid, want && want.season, want && want.pt);
    renderControls(R);
    run();
  }

  document.addEventListener('click', (e) => {
    const R = roles[S.role];
    const rb = e.target.closest('[data-role]');
    if (rb && rb.dataset.role !== S.role) {
      const pid = R && S.row >= 0 ? R.index.playerId[S.row] : null, s = R && S.row >= 0 ? R.index.season[S.row] : null;
      return switchRole(rb.dataset.role, { pid, season: s });
    }
    if (!R) return;
    const pb = e.target.closest('[data-preset]');
    if (pb) { applyPreset(R, R.manifest.presets.find((p) => p.id === pb.dataset.preset)); renderControls(R); return run(); }
    const mb = e.target.closest('[data-mode]');
    if (mb) { S.mode = mb.dataset.mode; renderControls(R); return run(); }
    const tr = e.target.closest('tr.main');
    if (tr) toggleDetail(R, tr);
  });
  function toggleDetail(R, tr) {
    const i = +tr.dataset.i, d = document.querySelector(`tr.detail[data-for="${i}"]`);
    if (d.hidden) d.firstElementChild.innerHTML = renderDetail(R, i);
    d.hidden = !d.hidden; tr.classList.toggle('open', !d.hidden);
  }
  document.addEventListener('keydown', (e) => { const tr = e.target.closest && e.target.closest('tr.main'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleDetail(roles[S.role], tr); } });
  document.addEventListener('change', (e) => {
    const R = roles[S.role]; if (!R) return;
    const el = e.target;
    if (el.id === 'season') { setTargetPlayer(R, R.index.playerId[S.row], +el.value, S.role === 'pitch' ? catLabel(R, S.row, 'pt') : null); return run(); }
    if (el.id === 'pitch') { S.row = +el.value; return run(); }
    if (el.id === 'stat') { S.stat = el.value; S.nums = {}; renderControls(R); return run(); }
    if (el.id === 'corr') { S.corr = el.checked; return run(); }
    if (el.id === 'use_mix') { S.mix = el.checked; if (S.mix && !S.gw.mix) S.gw.mix = 0.15; renderControls(R); return run(); }
    if (el.dataset.feat) { el.checked ? S.rate.add(el.dataset.feat) : S.rate.delete(el.dataset.feat); return run(); }
    if (el.dataset.weight) { S.weights[el.dataset.weight] = Math.max(0, +el.value || 0); return run(); }
    if (el.dataset.cat) { el.checked ? S.cat.add(el.dataset.cat) : S.cat.delete(el.dataset.cat); if (el.checked && !S.gw.cat) S.gw.cat = 0.1; renderControls(R); return run(); }
    if (el.dataset.filter) { el.checked ? S.filters.add(el.dataset.filter) : S.filters.delete(el.dataset.filter); return run(); }
    if (el.dataset.num) { S.nums[el.dataset.num] = el.value; return run(); }
    if (el.dataset.gw) { S.gw[el.dataset.gw] = +el.value; return run(); }
  });
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.gw) { el.style.setProperty('--plpd-range-pct', el.value * 100 + '%'); el.nextElementSibling.textContent = (+el.value).toFixed(2); }
  });
  $('reset').addEventListener('click', () => { const R = roles[S.role]; applyPreset(R, R.manifest.presets.find((p) => p.id === S.preset)); renderControls(R); run(); });
  $('more').addEventListener('click', () => { S.shown += 25; renderComps(roles[S.role], last); });

  // tooltip for bar segments
  const tip = $('tip');
  document.addEventListener('mouseover', (e) => { const s = e.target.closest('[data-tip]'); if (!s) { tip.hidden = true; return; } tip.textContent = s.dataset.tip; tip.hidden = false; });
  document.addEventListener('mousemove', (e) => { if (!tip.hidden) { tip.style.left = Math.min(e.clientX + 14, innerWidth - 330) + 'px'; tip.style.top = e.clientY + 14 + 'px'; } });

  // A link that changes only the hash (the page already open) re-targets the page. writeHash() uses replaceState, which
  // fires no hashchange, so this runs only for navigations the reader makes: a pasted link, back/forward.
  window.addEventListener('hashchange', () => {
    const want = readHash();
    if (!want) return;
    if (want.role !== S.role) { switchRole(want.role, want).catch((e) => setStatus(e.message, true)); return; }
    const R = roles[S.role];
    if (!R || !R.byPlayer.has(want.pid)) return;
    const p = R.manifest.presets.find((x) => x.id === want.preset);
    if (p && p.id !== S.preset) applyPreset(R, p);
    setTargetPlayer(R, want.pid, want.season, want.pt);
    renderControls(R);
    run();
  });

  setupSearch();
  const h = readHash();
  switchRole(h ? h.role : 'pitcher', h).catch((e) => setStatus(e.message, true));
})();
