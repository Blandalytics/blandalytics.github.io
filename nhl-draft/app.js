// The draft tool's page: settings, then a console driven by the worker (worker.js -> web_api.py).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f1 = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "-" : Number(v).toFixed(1);
const f2 = (v) => (v === null || v === undefined) ? "-" : Number(v).toFixed(2);
const pct = (v) => Math.round(100 * v) + "%";
const signed = (v) => { const s = (v > 0 ? "+" : "") + Number(v).toFixed(1); return `<td class="${v > 0.05 ? "posv" : v < -0.05 ? "neg" : "zero"}">${s}</td>`; };

const VERSION = "4";                     // bump with every deploy: it busts the cache on the worker and the Python files
const worker = new Worker("worker.js?v=" + VERSION);
let players = [];
let dnd = [];
let stop = null;          // the current stop's info
let result = null;        // the current simulation result
let busy = false;

function setStatus(text, err) { const s = $("status"); s.textContent = text; s.className = "status" + (err ? " err" : ""); }
function msg(text, err) { const m = $("msg"); m.textContent = text || ""; m.className = "status" + (err ? " err" : ""); }
function setBusy(b) { busy = b; for (const id of ["send", "resim", "undo", "auto", "show_board", "show_rosters"]) $(id).disabled = b; }
function player(p) { return `${esc(p.name)} <span style="color:var(--muted)">${esc(p.pos)} ${esc(p.nhl)}</span>`; }

// ---- settings ----------------------------------------------------------------

function renderChips() {
  $("dnd_chips").innerHTML = dnd.map((n, k) => `<span class="chip">${esc(n)}<button title="remove" data-k="${k}">×</button></span>`).join("");
  $("dnd_chips").querySelectorAll("button").forEach((b) => b.onclick = () => { dnd.splice(+b.dataset.k, 1); renderChips(); });
}
function addDnd() {
  const t = $("dnd_input").value.trim().toLowerCase();
  if (!t) return;
  const hits = players.filter((p) => p.name.toLowerCase().includes(t));
  const exact = hits.filter((p) => p.name.toLowerCase() === t);
  const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  if (!pick) { setStatus(hits.length ? `${hits.length} players match "${t}" — be more specific` : `nobody matches "${t}"`, true); return; }
  if (!dnd.includes(pick.name)) dnd.push(pick.name);
  $("dnd_input").value = ""; setStatus(""); renderChips();
}
$("dnd_add").onclick = addDnd;
$("dnd_input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addDnd(); } });

function cfg() {
  const num = (id) => Number($(id).value);
  return { slot: num("slot"), teams: num("teams"), slots: $("slots").value.trim(), bench: num("bench"), sims: num("sims"),
           seed: num("seed"), my_weight: num("my_weight"), w_lo: num("w_lo"), w_hi: num("w_hi"), per_pos: num("per_pos"),
           board: num("board"), mock: $("mock").value === "1", calib_sims: num("calib_sims"), dnd: dnd.slice() };
}

$("start").onclick = async () => {
  const c = cfg();
  if (c.slot < 1 || c.slot > c.teams) return setStatus("your slot must be 1 … teams", true);
  if (c.w_lo > c.w_hi) return setStatus("rival VOR weight low must not exceed high", true);
  if (c.per_pos + c.board < 1) return setStatus("need at least one option", true);
  let sheetText = null;
  const f = $("sheet").files[0];
  if (f) sheetText = await f.text();
  $("start").disabled = true;
  $("setup").querySelectorAll("input,select,button").forEach((el) => el.disabled = true);
  setStatus("building the board…");
  worker.postMessage({ type: "setup", cfg: c, sheetText });
};

// ---- the draft ---------------------------------------------------------------

function renderClock(info) {
  const mine = info.mine;
  let html;
  if (info.done) html = `<div class="clock"><span class="pick">Draft complete</span></div>`;
  else html = `<div class="clock"><span class="pick">Round ${info.round}, pick ${info.pick} <span style="color:var(--muted);font-weight:400">(overall ${info.overall} of ${info.teams * info.rounds})</span></span>
    <span class="who ${mine ? "mine" : ""}">${mine ? "YOUR PICK" : `team ${info.team} on the clock`}${info.mock || mine ? "" : " — enter their pick with <kbd>p name</kbd>"}</span></div>`;
  const bySlot = {};
  for (const r of info.roster) (bySlot[r.slot] = bySlot[r.slot] || []).push(r.name);
  const rosterTxt = Object.keys(bySlot).length ? Object.entries(bySlot).map(([s, n]) => `<b>${s}</b> ${n.map(esc).join(", ")}`).join(" &nbsp;|&nbsp; ") : "(empty)";
  html += `<div class="roster"><b>you have</b> ${rosterTxt}</div>`;
  if (info.between.length) html += `<h3>picks since your last</h3><pre class="picks">` + info.between.map((p) =>
    `${String(p.round).padStart(2)}.${String(p.pick).padStart(2, "0")}  team ${String(p.team).padEnd(2)}  ${esc(p.name.padEnd(24))} ${p.pos.padEnd(7)} ${p.nhl.padEnd(4)}${(p.w !== null && p.w !== undefined) ? "  (w " + p.w.toFixed(2) + ")" : ""}`).join("\n") + `</pre>`;
  if (info.dnd && info.dnd.length) html += `<p class="note">do not draft: ${info.dnd.map((p) => esc(p.name)).join(", ")}${info.unknown_dnd.length ? ` · not matched: ${info.unknown_dnd.map(esc).join(", ")}` : ""}</p>`;
  $("clock").innerHTML = html;
}

function renderOptions(res) {
  if (!res) { $("options").innerHTML = `<h2>Options</h2><p class="note">No pick left for you; the board is below.</p>`; return; }
  const mine = stop && stop.mine;
  const star = (m) => res.measure === m ? m + " ★" : m;
  const cats = res.cats;
  const prog = res.sims < res.of ? ` <span class="status">simulating … ${res.sims} of ${res.of} finishes</span>` : ` <span class="status">${res.of} simulated finishes per option, shared draws</span>`;
  let html = `<h2>Your options${prog}</h2><div class="tbl"><table><thead><tr>
    <th>#</th><th class="l">option</th><th class="l">player</th><th>rank</th><th>adp</th><th>${star("roto pts")}</th><th>${star("team vorp")}</th>
    <th>finish</th><th>win%</th><th>p10</th><th>p90</th><th>vs best</th><th>best%</th>${mine ? "<th></th>" : ""}</tr></thead><tbody>`;
  res.options.forEach((o, k) => {
    html += `<tr class="${k === 0 ? "best" : ""}"><td>${k + 1}</td><td class="l">${esc(o.why)}</td><td class="l">${player(o)}</td><td>${o.rank}</td><td>${f1(o.adp)}</td>
      <td>${f1(o.roto)}</td><td>${f1(o.vorp)}</td><td>${f2(o.finish)}</td><td>${pct(o.win)}</td><td>${f1(o.p10)}</td><td>${f1(o.p90)}</td>
      <td>${o.gap === 0 ? "best" : (o.gap > 0 ? "+" : "") + f1(o.gap)}</td><td>${pct(o.best)}</td>${mine ? `<td><button class="take" data-i="${o.i}">take</button></td>` : ""}</tr>`;
  });
  html += `</tbody></table></div>`;
  if (res.measure === "team vorp") html += `<p class="note">★ ranked on the roster's total VORP: none of these can reach a starting slot, so roto pts is the same team whichever you take.</p>`;
  html += `<h3>expected category points (of ${stop.teams}) — your team with this seat filled from waivers, then what each option adds</h3>
    <div class="tbl"><table><thead><tr><th>#</th><th class="l">option</th><th class="l">player</th>${cats.map((c) => `<th>${c}</th>`).join("")}<th>total</th></tr></thead><tbody>`;
  html += `<tr class="baseline"><td></td><td class="l"></td><td class="l">waiver fill</td>${res.baseline.cats.map((v) => `<td>${f1(v)}</td>`).join("")}<td>${f1(res.baseline.total)}</td></tr>`;
  res.options.forEach((o, k) => {
    html += `<tr><td>${k + 1}</td><td class="l">${esc(o.why)}</td><td class="l">${player(o)}</td>${o.lift.map(signed).join("")}${signed(o.total)}</tr>`;
  });
  html += `</tbody></table></div>`;
  $("options").innerHTML = html;
  $("options").querySelectorAll("button.take").forEach((b) => b.onclick = () => take({ index: +b.dataset.i }));
}

function renderStandings(res) {
  if (!res) { $("standings").innerHTML = ""; return; }
  let html = `<h2>Average simulated standings points, by category</h2><p class="note">this pick skipped, your seat filled from waivers — the league's current trajectory</p>
    <div class="tbl"><table><thead><tr><th class="l">team</th>${stop.mock ? "<th>w</th>" : ""}${res.cats.map((c) => `<th>${c}</th>`).join("")}<th>total</th></tr></thead><tbody>`;
  for (const t of res.standings) {
    html += `<tr class="${t.you ? "you" : ""}"><td class="l">${t.you ? "you" : "team " + t.team}</td>${stop.mock ? `<td>${t.w === null ? "-" : f2(t.w)}</td>` : ""}${t.cats.map((v) => `<td>${f1(v)}</td>`).join("")}<td>${f1(t.total)}</td></tr>`;
  }
  $("standings").innerHTML = html + `</tbody></table></div>`;
}

function renderBoard(pos, rows) {
  let html = `<h3>best available${pos ? " " + esc(pos) : ""} (your blend)</h3><div class="tbl"><table><thead><tr><th>#</th><th class="l">player</th><th>vor_rk</th><th>adp_rk</th><th>adp</th><th>vorp</th><th>value</th>${stop && stop.mine ? "<th></th>" : ""}</tr></thead><tbody>`;
  for (const r of rows) html += `<tr><td>${r.rank}</td><td class="l">${player(r)}</td><td>${r.vor_rk}</td><td>${r.adp_rk}</td><td>${f1(r.adp)}</td><td>${f2(r.vorp)}</td><td>${f2(r.value)}</td>${stop && stop.mine ? `<td><button class="take" data-i="${r.i}">take</button></td>` : ""}</tr>`;
  $("panel").innerHTML = html + `</tbody></table></div>`;
  $("panel").querySelectorAll("button.take").forEach((b) => b.onclick = () => take({ index: +b.dataset.i }));
}

function renderRosters(rows) {
  let html = `<h3>rosters</h3>`;
  for (const t of rows) {
    const bySlot = {};
    for (const r of t.players) (bySlot[r.slot] = bySlot[r.slot] || []).push(r.name);
    const txt = Object.keys(bySlot).length ? Object.entries(bySlot).map(([s, n]) => `<b>${s}</b> ${n.map(esc).join(", ")}`).join(" &nbsp;|&nbsp; ") : "(empty)";
    html += `<div class="roster"><b style="color:${t.you ? "var(--good)" : "var(--muted)"}">${t.you ? "you" : "team " + t.team}</b> ${txt}</div>`;
  }
  $("panel").innerHTML = html;
}

function renderFinal(d) {
  const bySlot = d.roster.map((r) => `<tr><td class="l">${r.slot}</td><td class="l">${player(r)}</td><td>${f2(r.vorp)}</td><td>${f2(r.value)}</td></tr>`).join("");
  let html = `<h2>Draft complete — you finish ${d.place} of ${d.standings.length}</h2><div class="tbl"><table><thead><tr><th class="l">slot</th><th class="l">player</th><th>vorp</th><th>value</th></tr></thead><tbody>${bySlot}</tbody></table></div>
    <h3>every team, by roto points (category points, best = ${d.standings.length})</h3><div class="tbl"><table><thead><tr><th class="l">team</th><th>w</th><th>vorp</th>${d.cats.map((c) => `<th>${c}</th>`).join("")}<th>total</th></tr></thead><tbody>`;
  for (const t of d.standings) html += `<tr class="${t.you ? "you" : ""}"><td class="l">${t.you ? "you" : "team " + t.team}</td><td>${t.w === null ? "-" : f2(t.w)}</td><td>${f1(t.vorp)}</td>${t.cats.map((v) => `<td>${f1(v)}</td>`).join("")}<td>${f1(t.total)}</td></tr>`;
  $("final").innerHTML = html + `</tbody></table></div>`;
  $("final").hidden = false;
}

// ---- commands ----------------------------------------------------------------

function take(what) {
  if (busy) return;
  setBusy(true); msg("");
  worker.postMessage({ type: "take", ...what });
}

function command(text) {
  const t = text.trim();
  if (!t || busy) return;
  const [cmd, ...rest] = t.split(/\s+/);
  const arg = rest.join(" ");
  const c = cmd.toLowerCase();
  if (c === "b") {
    const pos = rest.find((w) => !/^\d+$/.test(w));
    const n = rest.find((w) => /^\d+$/.test(w));
    setBusy(true); worker.postMessage({ type: "board", pos: pos ? pos.toUpperCase() : null, n: n ? +n : (pos ? 25 : 15) });
  } else if (c === "r") { setBusy(true); worker.postMessage({ type: "rosters" }); }
  else if (c === "s") simulate();
  else if (c === "u") { setBusy(true); worker.postMessage({ type: "undo" }); }
  else if (/^\d+$/.test(c)) take({ text: c });
  else take({ text: c === "p" ? "p " + arg : t });
  $("cmd").value = "";
}

function simulate() {
  if (!stop || stop.done || !stop.has_pick || !stop.options.length) return;
  setBusy(true);
  worker.postMessage({ type: "simulate" });
}

$("send").onclick = () => command($("cmd").value);
$("cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); command($("cmd").value); } });
$("resim").onclick = () => command("s");
$("undo").onclick = () => command("u");
$("auto").onclick = () => { if (!busy) { setBusy(true); worker.postMessage({ type: "auto" }); } };
$("show_board").onclick = () => command("b");
$("show_rosters").onclick = () => command("r");

// ---- the worker --------------------------------------------------------------

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "status") { setStatus(m.text); return; }
  if (m.type === "error") { setBusy(false); msg(m.message, true); setStatus(m.message, true); return; }
  if (m.type === "ready") {
    players = m.players;
    $("players").innerHTML = players.map((p) => `<option value="${esc(p.name)}">${esc(p.pos)} ${esc(p.nhl)}</option>`).join("");
    $("start").disabled = false;
    setStatus(`${players.length} players loaded — set the draft up and start`);
    return;
  }
  if (m.type === "stop") {
    stop = m.info; result = null;
    $("draft").hidden = false;
    const det = $("setup_details");
    det.open = false;
    det.querySelector("summary").innerHTML = `<b>Settings</b><span>draft in progress — you are team ${stop.user_team}, ${stop.sims} finishes per option, ${stop.mock ? "mock draft" : "following a real draft"}${stop.dnd.length ? ", " + stop.dnd.length + " do-not-draft" : ""} (click to review)</span>`;
    setStatus(`draft in progress — you are team ${stop.user_team}`);
    renderClock(stop);
    $("panel").innerHTML = "";
    setBusy(false);
    $("auto").disabled = !stop.mine;
    if (stop.done) { $("options").innerHTML = ""; $("standings").innerHTML = ""; worker.postMessage({ type: "final" }); return; }
    if (stop.has_pick && stop.options.length) { renderOptions({ sims: 0, of: stop.sims, measure: "roto pts", cats: [], options: [], baseline: { cats: [], total: 0 }, standings: [] }); simulate(); }
    else { renderOptions(null); renderStandings(null); }
    return;
  }
  if (m.type === "progress" || m.type === "result") {
    result = m.result;
    if (result) { renderOptions(result); renderStandings(result); }
    if (m.type === "result") setBusy(false);
    return;
  }
  if (m.type === "took") {
    if (!m.r.ok) { setBusy(false); msg(m.r.message, true); return; }
    const p = m.r.pick;
    msg(`${m.r.mine ? "you take" : "team " + p.team + " takes"} ${p.name} (${p.pos} ${p.nhl})`);
    worker.postMessage({ type: "next" });
    return;
  }
  if (m.type === "board") { setBusy(false); renderBoard(m.pos, m.rows); return; }
  if (m.type === "rosters") { setBusy(false); renderRosters(m.rows); return; }
  if (m.type === "final") { setBusy(false); renderFinal(m.data); return; }
};

worker.postMessage({ type: "init", version: VERSION });
