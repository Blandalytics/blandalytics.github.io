// The draft mode's engine in a Web Worker: Pyodide runs the same Python as the tests and dry runs
// (py/web_api.py), as nhl-draft/worker.js does.
// Messages in: init, setup, simulate, take, nominate, block, bid, record, auto, next, undo, board,
// rosters, final. Messages out: status, ready, pool, stop, progress, result, did, board, rosters,
// final, error.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const PYODIDE_CACHE = "pyodide-v0.28.3";

// Pyodide's files live at versioned, never-changing URLs, so they are kept in Cache Storage and
// served from there on later visits (the same cache as the NHL draft tool's: one copy for both).
// Files are copied in only once the engine is ready, from the HTTP cache the first load filled.
const baseFetch = self.fetch.bind(self);
let pyCache = null, pyCacheReady = null;
const missed = new Set();
async function openPyodideCache() {
  try {
    for (const k of await caches.keys()) if (k.startsWith("pyodide-") && k !== PYODIDE_CACHE) await caches.delete(k);
    pyCache = await caches.open(PYODIDE_CACHE);
  } catch (e) { pyCache = null; }   // no Cache Storage here (some private windows): plain fetch
}
async function fillPyodideCache() {
  for (const url of missed) {
    try { await pyCache.add(url); } catch (e) { /* next visit tries again */ }
  }
  missed.clear();
}
self.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(PYODIDE)) return baseFetch(input, init);
  await pyCacheReady;
  if (!pyCache) return baseFetch(input, init);
  const hit = await pyCache.match(url);
  if (hit) return hit;
  missed.add(url);
  return baseFetch(input, init);
};
const PY_FILES = ["league.py", "pool.py", "engine.py", "draft.py", "ce.py", "web_api.py"];

let pyodide = null;
let session = false;
let VERSION = "0";

const status = (text) => postMessage({ type: "status", text });
self.progress = (json) => postMessage({ type: "progress", result: JSON.parse(json) });
self.pylog = (text) => status(text);

async function init() {
  status("loading the Python runtime");
  pyCacheReady = openPyodideCache();
  importScripts(PYODIDE + "pyodide.js");
  pyodide = await loadPyodide({ indexURL: PYODIDE });
  status("loading numpy");
  await pyodide.loadPackage(["numpy"]);   // the engine is numpy only
  status("loading the draft engine");
  pyodide.FS.mkdirTree("/draft");
  for (const f of PY_FILES) {
    const r = await fetch("py/" + f + "?v=" + VERSION);
    if (!r.ok) throw new Error(`py/${f}: HTTP ${r.status}`);
    pyodide.FS.writeFile("/draft/" + f, await r.text());
  }
  await pyodide.runPythonAsync(`
import os, sys, json
os.chdir("/draft")
sys.path.insert(0, "/draft")
import web_api
from js import progress, pylog
`);
  postMessage({ type: "ready" });
  if (pyCache && missed.size) fillPyodideCache();   // in the background, while the draft is set up
}

const call = (expr) => JSON.parse(pyodide.runPython(expr));
// arguments cross as JSON: a JS null would arrive in Python as a JsNull proxy, not None
function callWith(method, args) {
  pyodide.globals.set("args_json", JSON.stringify(args));
  return call(`session.${method}(**json.loads(args_json))`);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") { VERSION = m.version || VERSION; return await init(); }
    if (m.type === "setup") {
      // the table and the risk files go through the file system: no proxies for the large inputs
      pyodide.FS.writeFile("/draft/table.json", m.table);
      for (const [k, buf] of [["h", m.riskH], ["p", m.riskP]]) {
        const path = `/draft/risk_${k}.bin`;
        if (buf) pyodide.FS.writeFile(path, new Uint8Array(buf));
        else if (pyodide.FS.analyzePath(path).exists) pyodide.FS.unlink(path);
      }
      pyodide.globals.set("cfg_json", JSON.stringify(m.cfg));
      status("building the player pool and the outcome draws");
      await pyodide.runPythonAsync(`
def _read(p):
    return open(p, "rb").read() if os.path.exists(p) else None
session = web_api.Session(json.loads(cfg_json), open("table.json", encoding="utf-8").read(), _read("risk_h.bin"), _read("risk_p.bin"), log=pylog)
`);
      session = true;
      postMessage({ type: "pool", rows: call("session.pool_json()") });
      return postMessage({ type: "stop", info: call("session.begin_stop()") });
    }
    if (!session) throw new Error("no draft in progress");
    if (m.type === "simulate") return postMessage({ type: "result", result: call("session.simulate(progress=progress)") });
    if (m.type === "take") return postMessage({ type: "did", action: "take", r: callWith("take", { index: m.index ?? null, text: m.text ?? null }) });
    if (m.type === "nominate") return postMessage({ type: "did", action: "nominate", r: callWith("nominate", { index: m.index ?? null, text: m.text ?? null }) });
    if (m.type === "block") return postMessage({ type: "did", action: "block", r: callWith("block", { index: m.index ?? null, text: m.text ?? null, team: m.team ?? null }) });
    if (m.type === "bid") return postMessage({ type: "did", action: "bid", r: callWith("bid", { amount: m.amount }) });
    if (m.type === "record") return postMessage({ type: "did", action: "record", r: callWith("record", { index: m.index ?? null, text: m.text ?? null, team: m.team ?? null, price: m.price ?? null }) });
    if (m.type === "auto") return postMessage({ type: "did", action: "auto", r: call("session.auto()") });
    if (m.type === "next") return postMessage({ type: "stop", info: call("session.begin_stop()") });
    if (m.type === "undo") {
      const r = call("session.undo()");
      if (!r.ok) return postMessage({ type: "error", message: r.message });
      return postMessage({ type: "stop", info: call("session.begin_stop()") });
    }
    if (m.type === "board") return postMessage({ type: "board", pos: m.pos || "", rows: callWith("board", { pos: m.pos || null, n: m.n || 20 }) });
    if (m.type === "rosters") return postMessage({ type: "rosters", rows: call("session.rosters()") });
    if (m.type === "final") return postMessage({ type: "final", data: call("session.final()") });
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
