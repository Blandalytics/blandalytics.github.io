// The SHAP tables behind the page, straight from the bucket's shap-values/ folder (written by
// stuff_model's shap_values.py and publish_shap_values.py): per season, one row per pitcher x
// pitch type x target for each model, and the units' mean inputs. Every file is one Parquet row
// group, so a season is read whole and kept; switching pitcher, pitch type or target after that
// costs nothing.
//
// Row names, detail formats and the grouping of features follow shap_values_card.py, the
// script that draws the same waterfall as a PNG.

import { parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm';

// ?data=data/ reads a local copy (model-drilldown/data/shap-values/) instead of the bucket
const LOCAL = new URLSearchParams(location.search).get('data');
export const SOURCE = LOCAL ? new URL(`${LOCAL.replace(/\/?$/, '/')}shap-values/`, location.href).href
  : 'https://data.blandalytics.com/shap-values/';
// The zone keeps objects for hours under their exact URL; an hourly key lets a republish through.
const STAMP = Math.floor(Date.now() / 3.6e6);

export const PITCH_NAMES = {
  FF: 'Four-Seam Fastball', SI: 'Sinker', FC: 'Cutter', SL: 'Slider', ST: 'Sweeper', SV: 'Slurve',
  CU: 'Curveball', KC: 'Knuckle Curve', CH: 'Changeup', FS: 'Splitter', FO: 'Forkball',
};
// the Sequencing Flow palette
export const PITCH_COLORS = {
  FF: '#FF6683', SI: '#F2B24B', FS: '#83D6FF', FC: '#C59C9C', SL: '#CE66FF', ST: '#FFAAF7',
  CU: '#339cff', KC: '#339cff', SV: '#2A98FF', CH: '#6DE95D', FO: '#83D6FF',
};

export const MODELS = {
  stuff: { title: 'Stuff+', short: 'Stuff', blurb: 'count-neutral: shape, release and arsenal' },
  pitching: { title: 'PLV+', short: 'PLV', blurb: 'the pitch as thrown: adds location and count' },
  // PLV minus Stuff at the actual count; split by outcome only (units_location_<season>)
  location: { title: 'Location+', short: 'Location', blurb: 'what the location adds: PLV minus Stuff', outcomesOnly: true },
};
export const OUTCOMES = ['ball', 'called_strike', 'swinging_strike', 'foul', 'field_out', 'single', 'double', 'triple', 'home_run'];
export const TARGET_NAMES = {
  p_ball: 'Ball%', p_called_strike: 'CStr%', p_swinging_strike: 'SwStr%', p_foul: 'Foul%',
  p_field_out: 'In-Play Out%', p_single: 'Single%', p_double: 'Double%', p_triple: 'Triple%',
  p_home_run: 'Home Run%', wobacon: 'wOBAcon', era: 'ERA',
};
export const OUTCOME_NAMES = {
  ball: 'Ball', called_strike: 'Called Strike', swinging_strike: 'Swinging Strike', foul: 'Foul',
  field_out: 'In-Play Out', single: 'Single', double: 'Double', triple: 'Triple', home_run: 'Home Run',
};
// Sequencing Flow's ending colours: walks amber, strikes green, outs blue, hits red, homers pink
export const OUTCOME_COLORS = {
  ball: '#FFC46A', called_strike: '#A6FFC4', swinging_strike: '#65FF9C', foul: '#F4F1EA',
  field_out: '#65BAFF', single: '#F4707C', double: '#F4707C', triple: '#F4707C', home_run: '#FF5EDC',
};
// targets where lower is better for the pitcher: gold and teal swap
export const LOWER_IS_BETTER = new Set(['p_ball', 'p_single', 'p_double', 'p_triple', 'p_home_run', 'wobacon', 'era']);
export const targetGood = (t) => (LOWER_IS_BETTER.has(t) ? -1 : 1);
// 'outcomes' is the plus score split by outcome (shap_values_card.py --by outcome); in the
// figures it is named like the plus score it splits
export const isPlus = (t) => t === 'plus' || t === 'outcomes';
// era: pitch type ERA from the model (model_era.py --by pt), named "PLV ERA" / "Stuff ERA"
export const targetName = (model, t) => (isPlus(t) ? MODELS[model].title
  : t === 'era' ? `${MODELS[model].short} ERA` : TARGET_NAMES[t]);

export const LABELS = {
  velo: 'Velocity', ax_m: 'Horizontal Mvmt', az: 'Induced Vertical Mvmt', rel_x_m: 'Release Side',
  rel_z: 'Release Height', extension: 'Extension', spin_rate: 'Spin Rate', spin_eff: 'Spin Efficiency',
  axis_diff: 'Seam-Shifted Wake', velo_diff: 'Velo vs FB', ax_diff: 'Horizontal Mvmt vs FB',
  az_diff: 'Vertical Mvmt vs FB', is_primary: 'Primary Fastball', lefty: 'Handedness',
  x_b: 'Horizontal Location', z_n: 'Vertical Location', balls: 'Balls', strikes: 'Strikes', season_env: 'Season',
  baseline: 'Pitch Group & Matchup', Location: 'Location', Count: 'Count', Other: 'Other',
};
// the unit's mean input, as the card prints it under the row name
const DETAIL = {
  velo: (v) => `${v.toFixed(1)} mph`,
  ax_m: (v) => `${sgn(v, 1)} ft/s² arm-side`,
  az: (v) => `${sgn(v, 1)} ft/s²`,
  rel_x_m: (v) => `${sgn(v, 2)} ft arm-side`,
  rel_z: (v) => `${v.toFixed(2)} ft`,
  extension: (v) => `${v.toFixed(2)} ft`,
  spin_rate: (v) => `${Math.round(v)} rpm`,
  spin_eff: (v) => `${Math.round(100 * v)}%`,
  axis_diff: (v) => `${sgn(v, 0)}°`,
  velo_diff: (v) => `${sgn(v, 1)} mph`,
  ax_diff: (v) => `${sgn(v, 1)} ft/s²`,
  az_diff: (v) => `${sgn(v, 1)} ft/s²`,
  is_primary: (v) => `${Math.round(100 * v)}%`,
  x_b: (v) => `${sgn(v, 2)} ft, + = away`,
  z_n: (v) => `${Math.round(100 * v)}% of zone height`,
  balls: (v) => `${v.toFixed(2)} before the pitch`,
  strikes: (v) => `${v.toFixed(2)} before the pitch`,
};
// the input's unit, for the axes of the league charts
export const AXIS = {
  velo: 'Velocity (mph)', ax_m: 'Horizontal Mvmt (ft/s², arm side +)', az: 'Induced Vertical Mvmt (ft/s²)',
  rel_x_m: 'Release Side (ft, arm side +)', rel_z: 'Release Height (ft)', extension: 'Extension (ft)',
  spin_rate: 'Spin Rate (rpm)', spin_eff: 'Spin Efficiency', axis_diff: 'Seam-Shifted Wake (°)',
  velo_diff: 'Velo vs FB (mph)', ax_diff: 'Horizontal Mvmt vs FB (ft/s²)',
  az_diff: 'Vertical Mvmt vs FB (ft/s²)', is_primary: 'Share thrown as the primary fastball',
  lefty: 'Handedness (0 = RHP, 1 = LHP)', x_b: 'Horizontal Location (ft, + = away from the batter)',
  z_n: 'Vertical Location (share of zone height)', balls: 'Balls before the pitch', strikes: 'Strikes before the pitch',
  baseline: 'Share of pitches vs same-handed batters', Other: 'Pitches',
};
export const PCT = new Set(['spin_eff', 'is_primary', 'z_n', 'baseline']);  // axis read as a percentage
// features drawn as one row: SHAP is additive, so a row's impact is its features' sum
export const GROUPS = { Location: ['x_b', 'z_n'], Count: ['balls', 'strikes'] };
const TO_OTHER = new Set(['season_env']);  // always folded into Other, whatever its size
export const MIN_IMPACT = { plus: 1, outcomes: 1, wobacon: 0.002, era: 0.05 };  // anything else: 0.1 percentage points
export const minImpact = (t) => MIN_IMPACT[t] ?? 0.1;

function sgn(v, n) {
  const s = Math.abs(v).toFixed(n);
  return (Number(s) === 0 ? '' : v < 0 ? '−' : '+') + s;
}

// ---- reading -----------------------------------------------------------------------------

const seasons = new Map();  // season -> Promise<{ units: {stuff, pitching}, features, pitchers }>
let metaPromise = null;
let fidelityPromise = null;

async function fetchBuffer(name) {
  const r = await fetch(`${SOURCE}${name}?v=${STAMP}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

// hyparquet hands int64 back as BigInt
const plain = (rows) => rows.map((r) => {
  for (const k in r) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
  return r;
});

async function readParquet(name) {
  const file = await fetchBuffer(name);
  return plain(await parquetReadObjects({ file }));
}

export function loadMeta() {
  metaPromise ??= fetch(`${SOURCE}meta.json?v=${STAMP}`).then((r) => {
    if (!r.ok) throw new Error(`meta.json: HTTP ${r.status}`);
    return r.json();
  });
  return metaPromise;
}

// fidelity.csv: each surrogate's R^2 on held-out pitchers, per model x target x group model
export function loadFidelity() {
  fidelityPromise ??= fetch(`${SOURCE}fidelity.csv?v=${STAMP}`).then((r) => (r.ok ? r.text() : '')).then((text) => {
    const [head, ...lines] = text.trim().split(/\r?\n/);
    const cols = head.split(',');
    return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], i >= 3 ? Number(v) : v])));
  }).catch(() => []);
  return fidelityPromise;
}

// The season's pitcher list comes from unit_features alone (0.6 MB), so the controls fill
// while the SHAP tables (7-9 MB each) are still arriving.
export function loadFeatures(season) {
  const s = seasonEntry(season);
  return s.features;
}

export function loadUnits(season, model) {
  const s = seasonEntry(season);
  s.units[model] ??= readParquet(`units_${model}_${season}.parquet`).then(indexUnits);
  return s.units[model];
}

function seasonEntry(season) {
  if (!seasons.has(season)) {
    seasons.set(season, {
      units: {},
      features: readParquet(`unit_features_${season}.parquet`).then(indexFeatures),
    });
  }
  return seasons.get(season);
}

const key = (pitcher, pt) => `${pitcher}|${pt}`;

function indexFeatures(rows) {
  const byUnit = new Map();
  const byPitcher = new Map();
  for (const r of rows) {
    r.p_throws = String(r.p_throws);
    byUnit.set(key(r.pitcher, r.pt), r);
    let p = byPitcher.get(r.pitcher);
    if (!p) byPitcher.set(r.pitcher, (p = { id: r.pitcher, name: r.pitcher_name, hand: r.p_throws, n: 0, pts: [] }));
    p.n += r.n;
    p.pts.push(r);
  }
  for (const p of byPitcher.values()) p.pts.sort((a, b) => b.n - a.n);
  const pitchers = [...byPitcher.values()].sort((a, b) => b.n - a.n);
  return { rows, byUnit, pitchers, byId: byPitcher };
}

// units: { byKey: "pitcher|pt|target" -> row, byTarget: target -> rows }
function indexUnits(rows) {
  const byKey = new Map();
  const byTarget = new Map();
  for (const r of rows) {
    byKey.set(`${r.pitcher}|${r.pt}|${r.target}`, r);
    if (!byTarget.has(r.target)) byTarget.set(r.target, []);
    byTarget.get(r.target).push(r);
  }
  return { byKey, byTarget };
}

// ---- rows of a unit -------------------------------------------------------------------------

// Every row of a unit's decomposition, before any folding: the baseline, each feature (Location
// and Count summed), Season, and the residual. Values are in the target's unit.
export function allRows(meta, model, unit, info) {
  const feats = meta.models[model].features;
  const grouped = new Set(Object.values(GROUPS).flat());
  const rows = [{
    k: 'baseline', label: LABELS.baseline, v: unit.baseline,
    detail: `${info.group} · ${Math.round((100 * info.n_same) / info.n)}% vs Same Hand`,
  }];
  for (const f of feats) {
    if (grouped.has(f)) continue;
    let detail = '';
    if (f === 'lefty') detail = `${info.p_throws}HP`;
    else if (DETAIL[f] && Number.isFinite(info[f])) detail = DETAIL[f](info[f]);
    rows.push({ k: f, label: LABELS[f] || meta.labels[f] || f, v: unit[f], detail, season: TO_OTHER.has(f) });
  }
  for (const [g, fs] of Object.entries(GROUPS)) {
    if (!fs.every((f) => feats.includes(f))) continue;
    const detail = g === 'Location'
      ? `${sgn(info.x_b, 2)} ft, ${Math.round(100 * info.z_n)}% zone ht`
      : `${info.balls.toFixed(2)} B, ${info.strikes.toFixed(2)} S avg`;
    rows.push({ k: g, label: g, v: fs.reduce((a, f) => a + unit[f], 0), detail, group: fs });
  }
  return rows;
}

// The card's rows: impacts of at least min, largest first, then Other (the rest, Season, the
// surrogate residual and, for ERA, the season's calibration constant), so the bars always end
// at the exact value. `all` keeps every row.
export function cardRows(meta, model, unit, info, min, all = false) {
  const rows = allRows(meta, model, unit, info);
  const keep = rows.filter((r) => !r.season && (all || Math.abs(r.v) >= min));
  const rest = rows.filter((r) => !keep.includes(r));
  keep.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const small = rest.filter((r) => !r.season).length;
  const calibration = Number.isFinite(unit.calibration) ? unit.calibration : 0;  // era only
  const other = rest.reduce((a, r) => a + r.v, 0) + unit.residual + calibration;
  const parts = [];
  if (small) parts.push(`${small} smaller impact${small > 1 ? 's' : ''}`);
  if (rest.some((r) => r.season)) parts.push('season');
  parts.push('residual');
  if (calibration) parts.push('calibration');
  keep.push({ k: 'Other', label: 'Other', v: other, detail: parts.join(' + '), folded: rest.map((r) => r.k) });
  return keep;
}

// A row's value for any unit of the same model and target (for the league charts).
export function rowValue(k, unit) {
  if (k === 'Other') return unit.residual;  // the league's Other is the surrogate's error alone
  if (GROUPS[k]) return GROUPS[k].reduce((a, f) => a + unit[f], 0);
  return unit[k];
}

// A row's input for any unit (the x of the dependence chart); null for rows without one.
export function rowInput(k, info) {
  if (k === 'baseline') return info.n_same / info.n;
  if (k === 'Other') return info.n;
  if (GROUPS[k]) return null;
  const v = info[k];
  return Number.isFinite(v) ? v : null;
}

// ---- by outcome (shap_values_card.rows_by_outcome) -------------------------------------------

// Plus = 100 + the nine rv_<outcome> rows (each outcome's predicted rate x its average run value,
// in plus points vs league) + count leverage. Stuff prices outcomes at those average values, so
// its nine sum exactly; Pitching (PLV) prices them at the pitch's count, and the gap is "Count
// Leverage". An exact split, no proxy. Every outcome is shown: nothing folds into Other.
export const OUTCOME_ROWS = {
  ball: 'Balls', called_strike: 'Called Strikes', swinging_strike: 'Swinging Strikes', foul: 'Fouls',
  field_out: 'In-Play Outs', single: 'Singles', double: 'Doubles', triple: 'Triples', home_run: 'Home Runs',
};

// A row's value for one unit, from the units index: rv_<outcome>, or the leverage left over
export function outcomeValue(k, idx, pitcher, pt) {
  const get = (t) => idx.byKey.get(`${pitcher}|${pt}|${t}`);
  if (k === 'leverage') {
    const plus = get('plus');
    if (!plus) return NaN;
    return plus.exact - 100 - OUTCOMES.reduce((a, o) => a + (get(`rv_${o}`)?.exact ?? 0), 0);
  }
  return get(k)?.exact ?? NaN;
}

// A row's input: the unit's predicted rate of that outcome (%), or for Location the change its
// location makes to that rate (dp_<outcome>, pp); for leverage, its average count in the
// pitcher's favour (strikes - balls before the pitch)
export function outcomeInput(k, idx, info) {
  if (k === 'leverage') return info.strikes - info.balls;
  const get = (t) => idx.byKey.get(`${info.pitcher}|${info.pt}|${t}`);
  return (get(`p_${k.slice(3)}`) ?? get(`dp_${k.slice(3)}`))?.exact ?? NaN;
}

const pp1 = (v) => { const r = Math.round(v * 10) / 10; return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(1)}`; };  // +0.0, never −0.0

export function outcomeRows(model, idx, info) {
  const rows = OUTCOMES.map((o) => {
    const p = idx.byKey.get(`${info.pitcher}|${info.pt}|p_${o}`);
    const dp = idx.byKey.get(`${info.pitcher}|${info.pt}|dp_${o}`);  // Location: the rate's change
    return {
      k: `rv_${o}`, label: OUTCOME_ROWS[o], v: outcomeValue(`rv_${o}`, idx, info.pitcher, info.pt),
      detail: model === 'location' ? (dp ? `${pp1(dp.exact)} pp vs ${pp1(dp.league)} pp league` : '')
        : p ? `${p.exact.toFixed(1)}% vs ${p.league.toFixed(1)}% league` : '',
    };
  });
  if (model === 'pitching') {
    rows.push({ k: 'leverage', label: 'Count Leverage', v: outcomeValue('leverage', idx, info.pitcher, info.pt), detail: '' });
  }
  return rows.filter((r) => Number.isFinite(r.v)).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}

export const OUTCOME_AXIS = (k) => (k === 'leverage' ? 'Strikes − balls before the pitch (avg)' : `Predicted ${OUTCOME_ROWS[k.slice(3)].toLowerCase()} rate (%)`);
export const LOCATION_AXIS = (k) => `Location's change in ${OUTCOME_ROWS[k.slice(3)].toLowerCase()} rate (pp)`;

export { sgn };
