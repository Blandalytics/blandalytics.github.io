// The draft tool's engine, in a Web Worker: Pyodide runs the same Python the CLI runs.
// Messages in: init, setup, simulate, take, next, undo, auto, board, rosters, final.
// Messages out: status, ready, stop, progress, result, took, board, rosters, final, error.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const PYODIDE_CACHE = "pyodide-v0.28.3";

// Pyodide's files live at versioned, never-changing URLs, so they are kept in Cache Storage and
// served from there on later visits: the runtime, the standard library and numpy (~8 MB) come
// off disk even after the browser has evicted them from its HTTP cache. A new version gets a
// new cache, and the old one is deleted. Files are copied in only once the tool is ready
// (fillPyodideCache), re-read from the HTTP cache the first load just filled, so the first
// visit never waits on the copy.
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
  await pyCacheReady;                    // opened alongside the runtime's own start-up
  if (!pyCache) return baseFetch(input, init);
  const hit = await pyCache.match(url);
  if (hit) return hit;
  missed.add(url);
  return baseFetch(input, init);
};
const PY_FILES = ["league.py", "valuation.py", "boards.py", "draft_sim.py", "pick_engine.py", "draft_tool.py", "web_api.py"];
const DATA_FILES = ["sheet_live.csv", "merged_players.csv"];

let pyodide = null;
let session = null;

const status = (text) => postMessage({ type: "status", text });
self.progress = (json) => postMessage({ type: "progress", result: JSON.parse(json) });
self.pylog = (text) => status(text);

let VERSION = "0";

async function init() {
  status("loading Python runtime");
  pyCacheReady = openPyodideCache();
  importScripts(PYODIDE + "pyodide.js");
  pyodide = await loadPyodide({ indexURL: PYODIDE });
  status("loading numpy");
  await pyodide.loadPackage(["numpy"]);   // the tool is numpy-only: pandas cost ~115 MB and ~1.8 s
  status("loading the draft tool");
  pyodide.FS.mkdirTree("/draft");
  for (const f of PY_FILES) {
    const src = await (await fetch("py/" + f + "?v=" + VERSION)).text();
    pyodide.FS.writeFile("/draft/" + f, src);
  }
  for (const f of DATA_FILES) {
    const src = await (await fetch("data/" + f + "?v=" + VERSION)).text();
    pyodide.FS.writeFile("/draft/" + f, src);
  }
  await pyodide.runPythonAsync(`
import os, sys, json
os.chdir("/draft")
sys.path.insert(0, "/draft")
import web_api
from js import progress, pylog
`);
  const players = JSON.parse(pyodide.runPython("web_api.players_json()"));
  postMessage({ type: "ready", players });
  if (pyCache && missed.size) fillPyodideCache();   // in the background, while the draft is set up
}

function call(expr) {
  return JSON.parse(pyodide.runPython(expr));
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") { VERSION = m.version || VERSION; return await init(); }
    if (m.type === "setup") {
      if (m.sheetText) pyodide.FS.writeFile("/draft/sheet_upload.csv", m.sheetText);
      const cfg = { ...m.cfg, sheet: m.sheetText ? "sheet_upload.csv" : "sheet_live.csv" };
      pyodide.globals.set("cfg_json", JSON.stringify(cfg));
      status("building the board");
      await pyodide.runPythonAsync(`
session = web_api.Session(json.loads(cfg_json), log=pylog)
`);
      session = true;
      return postMessage({ type: "stop", info: call("session.begin_stop()") });
    }
    if (!session) throw new Error("no draft in progress");
    if (m.type === "simulate") {
      const result = call("session.simulate(progress=progress)");
      return postMessage({ type: "result", result });
    }
    if (m.type === "take") {
      // arguments cross as JSON: a JS null would arrive in Python as a JsNull proxy, not None
      pyodide.globals.set("args_json", JSON.stringify({ index: m.index ?? null, text: m.text ?? null }));
      return postMessage({ type: "took", r: call("session.take(**json.loads(args_json))") });
    }
    if (m.type === "auto") return postMessage({ type: "took", r: call("session.auto_pick()") });
    if (m.type === "next") return postMessage({ type: "stop", info: call("session.begin_stop()") });
    if (m.type === "undo") {
      const r = call("session.undo()");
      if (!r.ok) return postMessage({ type: "error", message: r.message });
      return postMessage({ type: "stop", info: call("session.begin_stop()") });
    }
    if (m.type === "board") {
      pyodide.globals.set("args_json", JSON.stringify({ pos: m.pos || null, n: m.n || 15 }));
      return postMessage({ type: "board", pos: m.pos || "", rows: call("session.board(**json.loads(args_json))") });
    }
    if (m.type === "rosters") return postMessage({ type: "rosters", rows: call("session.rosters()") });
    if (m.type === "final") return postMessage({ type: "final", data: call("session.final()") });
  } catch (err) {
    postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
