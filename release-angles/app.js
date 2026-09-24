// The Release Angles page: season, pitcher, game-type and date controls over the figure in
// angles.js. The data is the bucket's release-angles/ files, built nightly by
// tools/release_angles/build_data.py: a seasons index, one season's pitcher list, and the
// season's pitches as Parquet sorted by pitcher -- one pitcher is read out of it by range
// request, using the row-group statistics on `pitcher` to find the one or two groups
// holding them.

import { parquetMetadataAsync, parquetReadObjects } from "https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm";
import { compressors } from "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/+esm";

const RA = window.ReleaseAngles;
const $ = (id) => document.getElementById(id);
const el = {
  form: $("form"), season: $("season"), player: $("player"), suggest: $("suggest"),
  from: $("from"), to: $("to"), clearDates: $("clear_dates"), status: $("status"), through: $("through"),
  out: $("out"), fig: $("fig"), note: $("note"), views: $("views"), play: $("play"),
  copyPng: $("copy_png"), copyGif: $("copy_gif"), dlAll: $("dl_all"), dlStatus: $("dl_status"),
  nStd: $("n_std"), minRows: $("min_rows"), minSeg: $("min_seg"), numbers: $("numbers"),
};

// ?data=<base> reads a local build instead of the bucket
// (python tools/release_angles/build_data.py --out release-angles/data, then ?data=data/)
const params = new URLSearchParams(location.search);
const DATA = new URL(params.get("data") || "https://data.blandalytics.com/", location.href).href;
const DEFAULT_PITCHER = "Nolan McLean";

let index = null;
const seasons = new Map();   // season -> pitcher list file
const files = new Map();     // season -> { file, metadata }
const pitchCache = new Map();
let chosen = null;           // the picked pitcher's list entry
let model = null, view = 0, mark = null;

function status(msg, kind = "") { el.status.textContent = msg; el.status.className = "status " + kind; }

async function fetchJson(path) {
  const r = await fetch(DATA + path, { cache: "default" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
function once(map, key, make) {
  if (!map.has(key)) map.set(key, make().catch((e) => { map.delete(key); throw e; }));
  return map.get(key);
}
const loadSeason = (year) => once(seasons, year, () => fetchJson(`release-angles/${year}.json`));

// A season's Parquet as hyparquet's AsyncBuffer, over ranges fetched ahead of time: opening it
// is one suffix request (the footer, and the file's length from Content-Range -- no HEAD), and
// a pitcher is one request for the span of their row groups, so hyparquet reads from memory.
const FOOTER_GUESS = 1 << 17;
async function rangeFetch(url, range, cache = "default") {
  const r = await fetch(url, { headers: { Range: `bytes=${range}` }, cache });
  if (r.status !== 206) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number((r.headers.get("Content-Range") || "").split("/")[1]);
  return { total, buf: await r.arrayBuffer() };
}
async function prefetchedFile(url, cache = "default") {
  const { total, buf } = await rangeFetch(url, `-${FOOTER_GUESS}`, cache);
  const chunks = [{ start: total - buf.byteLength, buf }];
  const find = (start, end) => chunks.find((c) => start >= c.start && end <= c.start + c.buf.byteLength);
  return {
    byteLength: total,
    async prefetch(start, end) {
      if (find(start, end)) return;
      chunks.push({ start, buf: (await rangeFetch(url, `${start}-${end - 1}`, cache)).buf });
    },
    async slice(start, end = total) {
      let c = find(start, end);
      if (!c) { await this.prefetch(start, end); c = find(start, end); }
      return c.buf.slice(start - c.start, end - c.start);
    },
  };
}
// The season's Parquet is rebuilt nightly under the same name, and a browser holding byte ranges
// of the old file could splice them into the new one. The URL carries the build stamp from the
// season's list, so a rebuilt file is a new URL; a footer that still fails to parse is fetched
// once more past the cache.
const openSeason = (year) => once(files, year, async () => {
  const { built = "" } = await loadSeason(year);
  const url = `${DATA}release-angles/${year}.parquet?v=${encodeURIComponent(built)}`;
  const open = async (cache) => {
    const file = await prefetchedFile(url, cache);
    return { file, metadata: await parquetMetadataAsync(file, { initialFetchSize: FOOTER_GUESS }) };
  };
  try {
    return await open("default");
  } catch (e) {
    console.warn(`${url}: ${e.message}; refetching past the cache`);
    return open("reload");
  }
});
const COLUMNS = ["pitcher", "game_date", "pitch_type", "HRA", "VRA"];

const isoDate = (v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return new Date(v * 86400000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
// One pitcher's season: the rows of the row groups whose pitcher range covers them.
function readPitcher(year, id) {
  return once(pitchCache, `${year}-${id}`, async () => {
    const { file, metadata } = await openSeason(year);
    const names = metadata.schema.slice(1).map((s) => s.name), colIdx = names.indexOf("pitcher");
    let row = 0, rowStart = null, rowEnd = null, byteStart = Infinity, byteEnd = 0;
    for (const rg of metadata.row_groups) {
      const st = rg.columns[colIdx].meta_data.statistics || {};
      const lo = Number(st.min_value ?? st.min), hi = Number(st.max_value ?? st.max), n = Number(rg.num_rows);
      if (lo <= id && id <= hi) {
        if (rowStart === null) rowStart = row;
        rowEnd = row + n;
        // the byte span of the columns read, so the whole pitcher is one request
        rg.columns.forEach((c, j) => {
          if (!COLUMNS.includes(names[j])) return;
          const md = c.meta_data, from = Number(md.dictionary_page_offset ?? md.data_page_offset);
          byteStart = Math.min(byteStart, from);
          byteEnd = Math.max(byteEnd, from + Number(md.total_compressed_size));
        });
      }
      row += n;
    }
    if (rowStart === null) return [];
    await file.prefetch(byteStart, byteEnd);
    const rows = await parquetReadObjects({ file, metadata, compressors, rowStart, rowEnd, columns: COLUMNS });
    return rows.filter((r) => Number(r.pitcher) === id)
      .map((r) => ({ t: r.pitch_type, x: Number(r.HRA), y: Number(r.VRA), d: isoDate(r.game_date) }));
  });
}

// ---- the pitcher field -------------------------------------------------------------------
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
let pitchers = [];
function setPitchers(data) {
  pitchers = data.pitchers.map((p) => ({ ...p, full: fold(p.name), sur: fold(p.name.split(" ").slice(1).join(" ") || p.name) }));
}
function suggestions(query) {
  const q = fold(query);
  if (!q) return pitchers.slice().sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const scored = [];
  for (const h of pitchers) {
    let score;
    if (h.full.startsWith(q)) score = 0;
    else if (h.sur.startsWith(q)) score = 1;
    else if (h.full.includes(q) || String(h.id).startsWith(q)) score = 2;
    else continue;
    scored.push([score, h]);
  }
  scored.sort((a, b) => a[0] - b[0] || b[1].n - a[1].n);
  return scored.map((x) => x[1]);
}
let active = -1, shown = [], committed = true;
function showSuggestions() {
  shown = suggestions(el.player.value);
  active = -1;
  el.suggest.replaceChildren(...shown.map((h, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.index = String(i);
    const name = document.createElement("span"); name.textContent = h.name;
    const meta = document.createElement("small"); meta.textContent = `${h.team} · ${h.throws}HP · ${h.n.toLocaleString()} pitches`;
    li.append(name, meta);
    return li;
  }));
  el.suggest.hidden = !shown.length;
  el.player.setAttribute("aria-expanded", shown.length ? "true" : "false");
}
function hideSuggestions() { el.suggest.hidden = true; el.player.setAttribute("aria-expanded", "false"); shown = []; active = -1; }
function setActive(i) {
  active = i;
  [...el.suggest.children].forEach((li, k) => li.classList.toggle("active", k === i));
  if (i >= 0) el.suggest.children[i].scrollIntoView({ block: "nearest" });
}
function pick(h) {
  chosen = h; el.player.value = h.name; committed = true;
  hideSuggestions(); syncControls(); show();
}
function startSearch() {
  if (committed && el.player.value) { el.player.value = ""; committed = false; }
  showSuggestions();
}

// ---- controls ------------------------------------------------------------------------------
function syncControls() {
  const p = chosen;
  for (const d of [el.from, el.to]) { d.min = p ? p.first : ""; d.max = p ? p.last : ""; }
}
const numberOr = (input, dflt) => { const v = Number(input.value); return input.value !== "" && Number.isFinite(v) ? v : dflt; };
function selection() {
  return {
    season: Number(el.season.value), id: chosen?.id ?? null,
    from: el.from.value || null, to: el.to.value || null,
    nStd: Math.max(0.1, numberOr(el.nStd, 1.0)), minRows: Math.max(3, Math.round(numberOr(el.minRows, 20))),
    minSeg: Math.max(0, numberOr(el.minSeg, 0.10)),
  };
}
function hash(sel) {
  const extra = [];
  if (sel.from) extra.push(`from=${sel.from}`);
  if (sel.to) extra.push(`to=${sel.to}`);
  if (sel.nStd !== 1) extra.push(`sd=${sel.nStd}`);
  if (sel.minRows !== 20) extra.push(`min=${sel.minRows}`);
  if (sel.minSeg !== 0.1) extra.push(`seg=${sel.minSeg}`);
  if (view) extra.push(`view=${RA.TAGS[view]}`);
  return `#${sel.season}-${sel.id}` + extra.map((e) => "&" + e).join("");
}
function parseHash() {
  const [head, ...rest] = location.hash.replace(/^#/, "").split("&");
  const m = /^(\d{4})-(\d+)$/.exec(head || "");
  if (!m) return null;
  const kv = Object.fromEntries(rest.map((s) => s.split("=")));
  return { season: Number(m[1]), id: Number(m[2]), ...kv };
}

// ---- the figure ------------------------------------------------------------------------------
function displayDpi() {
  const css = el.fig.parentElement.clientWidth || 820;
  return Math.min(RA.DPI_PNG, Math.max(60, Math.round((css * (window.devicePixelRatio || 1)) / 11.6)));
}
function paint(mw, tw = mw) { if (model) RA.draw(el.fig, model, displayDpi(), mw, tw, mark); }
function setView(i) {
  stopLoop();
  view = i;
  [...el.views.querySelectorAll("button[data-view]")].forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.view) === i)));
  paint(RA.still(i));
  if (model && chosen) history.replaceState(null, "", hash(current));
}

let loop = null;
function stopLoop() {
  if (!loop) return;
  cancelAnimationFrame(loop.raf); loop = null;
  el.play.textContent = "▶ Play loop"; el.play.setAttribute("aria-pressed", "false");
}
function startLoop() {
  if (!model) return;
  [...el.views.querySelectorAll("button[data-view]")].forEach((b) => b.setAttribute("aria-pressed", "false"));
  const total = RA.STATES * (RA.HOLD + RA.TRANS);
  const offset = view * (RA.HOLD + RA.TRANS);
  const t0 = performance.now();
  let last = -1;
  loop = { raf: 0 };
  const tick = (now) => {
    const f = (offset + Math.floor(((now - t0) / 1000) * RA.FPS)) % total;
    if (f !== last) {
      const k = f % (RA.HOLD + RA.TRANS);
      // holds are static; only redraw when entering one or while fading
      if (k >= RA.HOLD || k === 0 || last < 0) paint(RA.weights(f), RA.swapWeights(f));
      last = f;
    }
    if (loop) loop.raf = requestAnimationFrame(tick);
  };
  loop.raf = requestAnimationFrame(tick);
  el.play.textContent = "❚❚ Pause"; el.play.setAttribute("aria-pressed", "true");
}

let current = null, drawing = 0;
async function show() {
  const sel = selection();
  if (sel.id == null) return;
  const ticket = ++drawing;
  status("loading pitches…");
  try {
    const all = await readPitcher(sel.season, sel.id);
    if (ticket !== drawing) return;
    let pts = all;   // regular season only: the build keeps nothing else
    if (sel.from) pts = pts.filter((p) => p.d >= sel.from);
    if (sel.to) pts = pts.filter((p) => p.d <= sel.to);
    if (!pts.length) { status("no pitches in that selection", "warn"); return; }
    status("drawing…");
    await new Promise((r) => setTimeout(r, 0));
    const m = RA.build(pts, {
      pitcher: chosen.name, start: sel.from, end: sel.to,
      nStd: sel.nStd, minRows: sel.minRows, minSegArea: sel.minSeg,
    });
    if (ticket !== drawing) return;
    model = m; current = sel;
    const wasLooping = Boolean(loop);
    stopLoop();
    el.out.hidden = false;
    if (wasLooping) startLoop(); else setView(view);
    history.replaceState(null, "", hash(sel));
    setTimeout(() => { if (model === m) renderNumbers(m); }, 0);   // after the chart is on screen
    const kept = m.order.reduce((s, p) => s + m.counts.get(p), 0);
    el.note.textContent = `${m.total.toLocaleString()} pitches in ${m.games} game${m.games === 1 ? "" : "s"}` +
      `${sel.from || sel.to ? "" : ` through ${chosen.last}`}; ${kept.toLocaleString()} in the ${m.order.length} pitch types drawn.` +
      (m.skipped.length ? ` Too few to draw (under ${sel.minRows}): ${m.skipped.join(", ")}.` : "");
    status("");
  } catch (e) {
    console.error(e);
    if (ticket === drawing) status(`could not draw: ${e.message}`, "err");
  }
}

// the printed report, as tables
function renderNumbers(m) {
  const r = RA.report(m);
  const f = (v, d = 2) => v.toFixed(d);
  const cell = (tag, s, cls = "") => `<${tag}${cls ? ` class="${cls}"` : ""}>${s}</${tag}>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const head = ["Pitch", "Pitches", "Usage", "Area (sq°)", "Mean depth", "Mean share", "Excl. self"];
  const body = r.rows.map((x) => `<tr>${cell("td", `<i style="background:${RA.HUES[x.type] || RA.HUES.UN}"></i>${esc(x.pitch)}`)}${cell("td", x.n.toLocaleString(), "n")}${cell("td", f(x.usage, 1) + "%", "n")}${cell("td", f(x.area), "n")}${cell("td", f(x.meanDepth), "n")}${cell("td", f(x.meanShare, 1) + "%", "n")}${cell("td", f(x.exclSelf, 1) + "%", "n")}</tr>`).join("");
  const segs = r.segments.slice(0, 8).map((s) => `<tr${s.solid ? "" : ' class="clip"'}>${cell("td", f(s.dens, 1), "n")}${cell("td", s.n.toLocaleString(), "n")}${cell("td", f(s.area), "n")}${cell("td", esc(s.members.join(" + ")) + (s.solid ? "" : " *"))}</tr>`).join("");
  const clippedArea = r.clipped.reduce((s, x) => s + x.area, 0), clippedN = r.clipped.reduce((s, x) => s + x.n, 0);
  el.numbers.innerHTML = `
    <div class="tablewrap"><table><thead><tr>${head.map((h, i) => cell("th", h, i ? "n" : "")).join("")}</tr></thead><tbody>${body}</tbody></table></div>
    <dl class="facts">
      <div><dt>Usage-weighted mean depth</dt><dd>${f(r.weighted, 3)}</dd></div>
      <div><dt>Union mean depth</dt><dd>${f(r.unionDepth, 3)}</dd></div>
      <div><dt>Union area</dt><dd>${f(r.unionArea)} sq°</dd></div>
      <div><dt>Max depth</dt><dd>${r.DMAX}</dd></div>
      <div><dt>Peak weighted share</dt><dd>${f(r.SMAX * 100, 1)}% <small>(${r.peakTypes.length} types: ${esc(r.peakTypes.join(", "))})</small></dd></div>
    </dl>
    <h3>Top segments, by pitch concentration</h3>
    <div class="tablewrap"><table><thead><tr>${cell("th", "Per sq°", "n")}${cell("th", "Pitches", "n")}${cell("th", "Area (sq°)", "n")}${cell("th", "Pitch types")}</tr></thead><tbody>${segs}</tbody></table></div>
    ${r.clipped.length ? `<p class="note">* ${r.clipped.length} segment${r.clipped.length === 1 ? "" : "s"} under ${m.minSegArea.toFixed(2)} sq°, left out of the concentration scale and clipped into its top: ${f(clippedArea)} sq°, ${clippedN.toLocaleString()} pitches.</p>` : ""}`;
}

// ---- downloads ------------------------------------------------------------------------------
function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function pngOf(m, i) {
  const c = document.createElement("canvas");
  RA.draw(c, m, RA.DPI_PNG, RA.still(i), RA.still(i), mark);
  return new Promise((res) => c.toBlob(res, "image/png"));
}
const dlStatus = (msg, kind = "") => { el.dlStatus.textContent = msg; el.dlStatus.className = "status " + kind; };
// The loop is encoded once per chart and shared by Copy GIF and Download All.
const gifs = new WeakMap();
function gifOf(m) {
  if (!gifs.has(m)) {
    gifs.set(m, RA.gif(m, mark, (p) => { if (model === m) dlStatus(`encoding GIF… ${Math.round(p * 100)}%`); })
      .catch((e) => { gifs.delete(m); throw e; }));
  }
  return gifs.get(m);
}
// The ClipboardItem is made in the click itself, around the promise of the image, so the copy
// keeps the click's permission while the image is drawn (Safari insists on it).
function copyImage(type, blobPromise) {
  return navigator.clipboard.write([new ClipboardItem({ [type]: blobPromise })]);
}
el.copyPng.addEventListener("click", async () => {
  if (!model) return;
  const m = model, i = loop ? 0 : view;
  try {
    await copyImage("image/png", pngOf(m, i));
    dlStatus(`copied the ${["pitch types", "overlap count", "usage share", "concentration"][i]} PNG`);
  } catch (e) {
    console.error(e);
    save(await pngOf(m, i), `${RA.stem(m)}_${RA.TAGS[i]}.png`);
    dlStatus("couldn't copy to the clipboard here, so the PNG was downloaded", "warn");
  }
});
// No mainstream browser puts a GIF on the clipboard yet (only PNG is supported), so this copies
// where the browser can and otherwise downloads the file, ready to drag into a post.
el.copyGif.addEventListener("click", async () => {
  if (!model) return;
  const m = model;
  el.copyGif.disabled = true;
  try {
    if (window.ClipboardItem?.supports?.("image/gif")) {
      await copyImage("image/gif", gifOf(m));
      dlStatus("copied the GIF");
    } else {
      const blob = await gifOf(m);
      save(blob, `${RA.stem(m)}.gif`);
      dlStatus(`browsers can't copy GIFs yet, so it was downloaded (${(blob.size / 1e6).toFixed(1)} MB)`, "warn");
    }
  } catch (e) {
    console.error(e);
    dlStatus(`GIF failed: ${e.message}`, "err");
  } finally {
    el.copyGif.disabled = false;
  }
});
el.dlAll.addEventListener("click", async () => {
  if (!model) return;
  const m = model, stem = RA.stem(m);
  el.dlAll.disabled = true;
  try {
    const { zipSync } = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm");
    const files = {};
    for (let i = 0; i < RA.STATES; i++) files[`${stem}_${RA.TAGS[i]}.png`] = new Uint8Array(await (await pngOf(m, i)).arrayBuffer());
    files[`${stem}.gif`] = new Uint8Array(await (await gifOf(m)).arrayBuffer());
    // PNG and GIF are compressed already: stored, not deflated
    save(new Blob([zipSync(files, { level: 0 })], { type: "application/zip" }), `${stem}.zip`);
    dlStatus("downloaded the four PNGs and the GIF");
  } catch (e) {
    console.error(e);
    dlStatus(`download failed: ${e.message}`, "err");
  } finally {
    el.dlAll.disabled = false;
  }
});

// ---- wiring ----------------------------------------------------------------------------------
async function switchSeason(year, keepId = chosen?.id) {
  status("loading the season…");
  const data = await loadSeason(year);
  setPitchers(data);
  chosen = pitchers.find((h) => h.id === keepId) || pitchers.find((h) => h.name === DEFAULT_PITCHER) || suggestions("")[0] || null;
  el.player.value = chosen ? chosen.name : "";
  committed = true;
  el.from.value = ""; el.to.value = "";
  el.through.textContent = `Through ${data.through}`;
  syncControls();
  status("");
}

async function init() {
  status("loading…");
  [index, mark] = await Promise.all([fetchJson("release-angles/index.json"), RA.loadAssets()]);
  const years = Object.keys(index.seasons).map(Number).sort((a, b) => b - a);
  el.season.replaceChildren(...years.map((y) => new Option(String(y), String(y))));
  const link = parseHash();
  const year = link && index.seasons[String(link.season)] ? link.season : years[0];
  el.season.value = String(year);
  await switchSeason(year, link?.id);
  if (link) {
    if (link.from) el.from.value = link.from;
    if (link.to) el.to.value = link.to;
    if (link.sd) el.nStd.value = link.sd;
    if (link.min) el.minRows.value = link.min;
    if (link.seg) el.minSeg.value = link.seg;
    if (link.view) view = Math.max(0, RA.TAGS.indexOf(link.view));
    syncControls();
  }
  await show();
}

el.season.addEventListener("change", async () => { await switchSeason(Number(el.season.value)); show(); });
for (const d of [el.from, el.to]) d.addEventListener("change", show);
for (const d of [el.nStd, el.minRows, el.minSeg]) d.addEventListener("change", show);
el.clearDates.addEventListener("click", () => { el.from.value = ""; el.to.value = ""; show(); });
el.views.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(Number(b.dataset.view));
});
el.play.addEventListener("click", () => (loop ? (stopLoop(), setView(view)) : startLoop()));
el.form.addEventListener("submit", (e) => { e.preventDefault(); if (shown.length) pick(shown[Math.max(active, 0)]); });

el.player.addEventListener("input", () => { committed = false; showSuggestions(); });
el.player.addEventListener("focus", startSearch);
el.player.addEventListener("click", () => { if (el.suggest.hidden) startSearch(); });
el.player.addEventListener("blur", () => setTimeout(() => {
  hideSuggestions();
  if (!el.player.value.trim() && chosen) { el.player.value = chosen.name; committed = true; }
}, 150));
el.player.addEventListener("keydown", (e) => {
  if (el.suggest.hidden) {
    if (e.key === "ArrowDown") { e.preventDefault(); showSuggestions(); if (shown.length) setActive(0); }
    return;
  }
  if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % shown.length); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + shown.length) % shown.length); }
  else if (e.key === "Enter") { e.preventDefault(); pick(shown[Math.max(active, 0)]); }
  else if (e.key === "Escape") hideSuggestions();
});
el.suggest.addEventListener("pointerdown", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  e.preventDefault();
  pick(shown[Number(li.dataset.index)]);
});
el.suggest.addEventListener("pointermove", (e) => { const li = e.target.closest("li"); if (li) setActive(Number(li.dataset.index)); });

let resizeTimer = 0;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!loop) paint(RA.still(view)); }, 150); });
window.addEventListener("hashchange", () => {
  if (current && hash(current) === location.hash) return;
  if (parseHash()) init();
});

init().catch((e) => { console.error(e); status(`could not load: ${e.message}`, "err"); });
