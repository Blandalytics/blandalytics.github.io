'use strict';
// Loads one role's exported files (pipeline/build.py, spec 4.12) into the typed-array shape comps-core.js expects.
// Works in the Web Worker (fetch) and in Node (fs), through the two reader functions passed in.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./comps-core.js'));
  else root.DataLoader = factory(root.CompsCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  const TYPES = { int32: Int32Array, int16: Int16Array, float32: Float32Array, uint8: Uint8Array };

  function view(buf, meta) {
    const T = TYPES[meta.dtype];
    // slice() copies, so every array is aligned whatever its offset in the file.
    return new T(buf.slice(meta.offset, meta.offset + meta.length * T.BYTES_PER_ELEMENT));
  }

  // readBuf(name) -> ArrayBuffer, readJson(name) -> object. Names are file names inside the role directory.
  async function loadRole(readBuf, readJson) {
    const man = await readJson('manifest.json');
    const F = man.files;
    const want = ['rows.bin', 'rate.bin', 'raw.bin', 'outcomes.bin', 'corr.bin'].concat(F['mix.bin'] ? ['mix.bin'] : []);
    const bufs = await Promise.all(want.map(readBuf));
    const B = Object.fromEntries(want.map((w, i) => [w, bufs[i]]));
    const [names, weights, prior, league] = await Promise.all(
      ['names.json', 'weights.json', 'prior.json', 'league.json'].map(readJson));

    const n = man.n, p = man.p;
    const q = view(B['rate.bin'], F['rate.bin'].z);
    const rate = new Float32Array(p * n);
    const { scale, missing } = man.quantization.rate;
    for (let i = 0; i < q.length; i++) rate[i] = q[i] === missing ? NaN : q[i] * scale;

    const outcomes = {};
    for (const s of man.forecastStats) {
      const o = F['outcomes.bin'];
      outcomes[s.id] = {
        baseline: view(B['outcomes.bin'], o[`${s.id}.baseline`]),
        delta: view(B['outcomes.bin'], o[`${s.id}.delta`]),
        outcomeRaw: view(B['outcomes.bin'], o[`${s.id}.outcome_raw`]),
        outcomeN: view(B['outcomes.bin'], o[`${s.id}.outcome_n`]),
      };
    }

    const data = {
      manifest: man, names, league, priorJson: prior,
      n, p, M: man.M || 0, C: man.categoricals.length,
      playerId: view(B['rows.bin'], F['rows.bin'].playerId),
      season: view(B['rows.bin'], F['rows.bin'].season),
      age: view(B['rows.bin'], F['rows.bin'].age),
      sample: view(B['rows.bin'], F['rows.bin'].sample),
      cat: view(B['rows.bin'], F['rows.bin'].cat),
      rate,
      raw: view(B['raw.bin'], F['raw.bin'].raw),
      corr: view(B['corr.bin'], F['corr.bin'].corr),
      mix: B['mix.bin'] ? view(B['mix.bin'], F['mix.bin'].shares) : null,
      mixNorm: B['mix.bin'] ? view(B['mix.bin'], F['mix.bin'].norm) : null,
      outcomes,
      defaultWeights: Float32Array.from(weights.default),
      learnedWeights: Object.fromEntries(Object.entries(weights.learned || {}).map(([k, v]) => [k, Float32Array.from(v)])),
      prior: Core.makePrior(prior),
    };
    data.mixBlocks = man.mix ? man.mix.blocks.map((b, k) => ({ start: b.start !== undefined ? b.start : 0, width: b.width !== undefined ? b.width : man.M })) : [];
    data.catIndex = Object.fromEntries(man.categoricals.map((c, i) => [c.id, i]));
    data.statMeta = Object.fromEntries(man.forecastStats.map((s) => [s.id, s]));
    data.leagueValue = (stat, t) => league[stat][leagueKey(data, t)];
    // Spec 5.10: forecast = invlogit(logit(league_T) + baseline_T + delta) for logit stats, or the plain sum for
    // plus stats. The current season's league stands in for league_{T+1}.
    data.convert = (stat, t, dl) => {
      const lg = data.leagueValue(stat, t), b = outcomes[stat].baseline[t];
      if (lg === undefined || Number.isNaN(b)) return NaN;
      return data.statMeta[stat].transform === 'logit' ? Core.invlogit(Core.logit(lg) + b + dl) : lg + b + dl;
    };
    return data;
  }

  function leagueKey(data, t) {
    if (data.manifest.leagueKey === 'season') return String(data.season[t]);
    const c = data.catIndex.cls, code = data.cat[c * data.n + t];
    return `${data.season[t]}|${data.manifest.categoricals[c].levels[code]}`;
  }

  return { loadRole, leagueKey };
});
