// The draft tool's engine, in a Web Worker: Pyodide runs the same Python the CLI runs.
// Messages in: init, setup, simulate, take, next, undo, auto, board, rosters, final.
// Messages out: status, ready, stop, progress, result, took, board, rosters, final, error.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const PY_FILES = ["league.py", "valuation.py", "boards.py", "draft_sim.py", "pick_engine.py", "draft_tool.py", "web_api.py"];
const DATA_FILES = ["sheet_live.csv", "merged_players.csv"];

let pyodide = null;
let session = null;

const status = (text) => postMessage({ type: "status", text });
self.progress = (json) => postMessage({ type: "progress", result: JSON.parse(json) });
self.pylog = (text) => status(text);

async function init() {
  status("loading Python runtime");
  importScripts(PYODIDE + "pyodide.js");
  pyodide = await loadPyodide({ indexURL: PYODIDE });
  status("loading numpy and pandas");
  await pyodide.loadPackage(["numpy", "pandas"]);
  status("loading the draft tool");
  pyodide.FS.mkdirTree("/draft");
  for (const f of PY_FILES) {
    const src = await (await fetch("py/" + f + "?v=" + Date.now())).text();
    pyodide.FS.writeFile("/draft/" + f, src);
  }
  for (const f of DATA_FILES) {
    const src = await (await fetch("data/" + f)).text();
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
}

function call(expr) {
  return JSON.parse(pyodide.runPython(expr));
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") return await init();
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
      pyodide.globals.set("take_index", m.index === undefined ? null : m.index);
      pyodide.globals.set("take_text", m.text === undefined ? null : m.text);
      return postMessage({ type: "took", r: call("session.take(index=take_index, text=take_text)") });
    }
    if (m.type === "auto") return postMessage({ type: "took", r: call("session.auto_pick()") });
    if (m.type === "next") return postMessage({ type: "stop", info: call("session.begin_stop()") });
    if (m.type === "undo") {
      const r = call("session.undo()");
      if (!r.ok) return postMessage({ type: "error", message: r.message });
      return postMessage({ type: "stop", info: call("session.begin_stop()") });
    }
    if (m.type === "board") {
      pyodide.globals.set("board_pos", m.pos || null);
      pyodide.globals.set("board_n", m.n || 15);
      return postMessage({ type: "board", pos: m.pos || "", rows: call("session.board(board_pos, board_n)") });
    }
    if (m.type === "rosters") return postMessage({ type: "rosters", rows: call("session.rosters()") });
    if (m.type === "final") return postMessage({ type: "final", data: call("session.final()") });
  } catch (err) {
    postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
