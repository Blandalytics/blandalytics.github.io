// The draft mode's page (the risk plan's R8): the calculator's league, the draft's settings, then a
// console driven by the worker (worker.js -> py/web_api.py). The league and the payout come from the
// calculator's saved settings (setup.js); the projections and the risk files load as the calculator
// loads them (?data=<base>, ?riskdata=<base>).
import * as C from "../calc.js?v=17";
import * as R from "../risk.js?v=2";
import { STORE, buildTable, draftRisk, riskSettingsFrom, sessionConfig, settingsFrom, unsupported } from "./setup.js?v=3";

const VERSION = "3";   // bump with every deploy: it busts the cache on the worker and the Python files
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const f1 = (v) => (isNum(v) ? v.toFixed(1) : "-");
const f2 = (v) => (isNum(v) ? v.toFixed(2) : "-");
const pct = (v) => (isNum(v) ? (100 * v).toFixed(1) + "%" : "-");
const usd = (v) => (isNum(v) ? (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(1) : "-");
const whole = (v) => (isNum(v) ? (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)) : "-");   // bids and prices
const signedCell = (v, digits = 1) => {
  if (!isNum(v)) return `<td class="zero">-</td>`;
  const s = (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(digits);
  return `<td class="${v > 0.05 ? "posv" : v < -0.05 ? "neg" : "zero"}">${s}</td>`;
};

// ---- the inputs ------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const slash = (u) => u.replace(/\/?$/, "/");
const DATA = slash(new URL(params.get("data") || "https://data.blandalytics.com/projections/", location.href).href);
const RISK_DATA = slash(new URL(params.get("riskdata") || DATA, location.href).href);
const FILES = { h: "hitters_auction_ev.csv", p: "pitchers_auction_ev.csv" };
const RISK_FILES = { h: "hitters_risk_ev.bin", p: "pitchers_risk_ev.bin" };

let form = null;
try { form = JSON.parse(localStorage.getItem(STORE)); } catch { form = null; }
const S = settingsFrom(C, form);
const RS = riskSettingsFrom(form);
const data = { h: null, p: null, risk: null, buf: null, error: null, riskError: null, loaded: false };

const worker = new Worker("worker.js?v=" + VERSION);
let engineReady = false;
let pool = [];            // the engine's players (pool index, name, pos, team, $, risk $)
let poolKey = new Map();  // the datalist's label -> pool index
let stop = null;          // the current stop
let result = null;        // the current simulation result
let riskObjective = null; // risk.js's M, S, H before the draft (an average team)
let busy = false;

function setStatus(text, kind) { const s = $("status"); s.textContent = text; s.className = "status" + (kind ? " " + kind : ""); }
function msg(text, err) { const m = $("msg"); m.textContent = text || ""; m.className = "status" + (err ? " err" : ""); }
const BUTTONS = ["enter_pick", "resim", "undo", "auto", "show_board", "show_rosters"];
function setBusy(b) {
  busy = b;
  for (const id of BUTTONS) $(id).disabled = b;
  document.querySelectorAll("#options button, #action button").forEach((el) => { el.disabled = b; });
  if (!b && stop) $("auto").disabled = !hasDecision();
}
const lastLine = (t) => String(t).trim().split("\n").filter(Boolean).pop() || String(t);

// ---- the league ------------------------------------------------------------------------------

function slotText(slots) {
  return Object.entries(slots).filter(([, n]) => n > 0).map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(" ");
}
function renderLeague() {
  const fmt = { roto: "roto", h2h: "head-to-head", allplay: "head-to-head all-play (played as head-to-head)" }[S.format] || S.format;
  const cats = S.style === "Points" ? "points" : `${S.hitterCats.join(" ")} / ${S.pitcherCats.join(" ")}`;
  $("league").innerHTML = `<b>Your league</b> (the calculator's settings${form ? "" : ": none saved, so its default"}; <a href="../">change them there</a>): `
    + `<b>${S.teams}</b> teams, ${esc(fmt)}, ${esc(cats)} · ${esc(slotText(S.slots))} · ${esc(slotText(S.pitcherSlots))} · bench ${S.bench} · $${S.budget} budget, $${S.minBid} min bid`
    + (S.pool !== "All" ? ` · ${esc(S.pool)}` : "");
  $("slot").max = S.teams;
  $("playoffs").max = Math.max(1, S.teams - 1);
  $("payout").value = RS.payout;
  $("playoffs").value = Math.min(RS.playoffTeams, S.teams - 1);
  // the default objective (R8 part 3, 952 mock drafts): roto points in roto, the payout in head-to-head
  $("objective").value = S.format === "h2h" || S.format === "allplay" ? "payout" : "points";
  showFields();
}
function showFields() {
  $("playoffs_field").hidden = $("payout").value !== "playoffs";
  $("auto_field").hidden = $("mode").value !== "auction" || $("mock").value !== "1";
  const h2h = S.format === "h2h" || S.format === "allplay";
  $("payout_note").textContent = $("payout").value === "winner"
    ? (h2h ? "Pays on title% (the head-to-head winner)" : "Pays on win%: first place in the roto standings")
    : (h2h ? "Pays on playoff%" : "Pays on the share of seasons in the paid places");
}
for (const id of ["payout", "mode", "mock"]) $(id).addEventListener("change", showFields);

async function loadData() {
  const blocked = unsupported(S);
  try {
    const [h, p] = await Promise.all(["h", "p"].map(async (k) => {
      const r = await fetch(DATA + FILES[k], { cache: "default" });
      if (!r.ok) throw new Error(`${FILES[k]}: HTTP ${r.status}`);
      return C.readProjections(await r.text());
    }));
    data.h = h; data.p = p;
  } catch (e) { data.error = e.message || String(e); }
  try {
    const bufs = await Promise.all(["h", "p"].map(async (k) => {
      const r = await fetch(RISK_DATA + RISK_FILES[k], { cache: "default" });
      if (!r.ok) throw new Error(`${RISK_FILES[k]}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }));
    const files = { h: R.parseRiskFile(bufs[0]), p: R.parseRiskFile(bufs[1]) };
    for (const k of ["h", "p"]) if (files[k].side !== k || files[k].head.basis !== "ev") throw new Error(`${RISK_FILES[k]} is for ${files[k].side}, basis ${files[k].head.basis}`);
    data.risk = files; data.buf = { h: bufs[0], p: bufs[1] };
  } catch (e) { data.riskError = e.message || String(e); }
  data.loaded = true;
  if (blocked) return setStatus(blocked, "err");
  if (data.error) return setStatus(`The projections didn't load (${data.error}).`, "err");
  ready();
}
function ready() {
  if (!engineReady || !data.loaded || data.error || unsupported(S)) return;
  $("start").disabled = false;
  setStatus(data.risk ? `ready: ${data.h.n + data.p.n} projected players and their outcome draws (draft mode v${VERSION})`
    : `ready, without the outcome draws (${data.riskError}): every season plays at the projections and the risk columns are empty`, data.risk ? "" : "warn");
}

// ---- starting --------------------------------------------------------------------------------

function choices() {
  const n = (id) => Number($(id).value);
  return {
    mode: $("mode").value, slot: n("slot"), mock: $("mock").value === "1", sims: n("sims"), seed: n("seed"),
    objective: $("objective").value, payout: $("payout").value, playoffTeams: n("playoffs"), autoBelow: n("auto_below"),
    dnd: $("dnd").value.split(",").map((x) => x.trim()).filter(Boolean),
  };
}

$("start").onclick = () => {
  const ch = choices();
  if (!(Number.isInteger(ch.slot) && ch.slot >= 1 && ch.slot <= S.teams)) return setStatus(`Your seat must be 1 to ${S.teams}`, "err");
  if (ch.payout === "playoffs" && !(Number.isInteger(ch.playoffTeams) && ch.playoffTeams >= 1 && ch.playoffTeams < S.teams)) {
    return setStatus(`Playoff teams must be 1 to ${S.teams - 1}`, "err");
  }
  if (!(ch.sims >= 10 && ch.sims <= 2000)) return setStatus("Simulated drafts per option: 10 to 2000", "err");
  $("start").disabled = true;
  $("setup").querySelectorAll("input,select,button").forEach((el) => { el.disabled = true; });
  setStatus("pricing the players (the calculator and the risk-aware $)…");
  setTimeout(() => {   // let the status paint first
    try {
      const H = C.prepHitters(data.h, S.pool, S.includeFa), P = C.prepPitchers(data.p, S.pool, S.includeFa);
      const rs = draftRisk(RS, ch);
      const { table, warnings } = buildTable(C, R, H, P, S, data.risk, rs);
      riskObjective = table.risk ? table.risk.objective : null;
      if (warnings.length) msg(warnings.join(" "));
      setStatus("building the player pool and the outcome draws…");
      worker.postMessage({ type: "setup", cfg: sessionConfig(ch, S, rs), table: JSON.stringify(table), riskH: data.buf ? data.buf.h : null, riskP: data.buf ? data.buf.p : null });
      setBusy(true);
    } catch (e) {
      setStatus(`Couldn't start: ${e.message || e}`, "err");
      $("setup").querySelectorAll("input,select,button").forEach((el) => { el.disabled = false; });
    }
  }, 30);
};

// ---- the stop --------------------------------------------------------------------------------

const isAuction = () => stop && stop.mode === "auction";
function hasDecision() {
  if (!stop || stop.done) return false;
  return (stop.kind === "pick" && stop.mine) || stop.kind === "nominate" || (stop.kind === "bid" && stop.mock);
}
function wantsSimulation() {
  if (!stop || stop.done || !stop.options.length) return false;
  return (stop.kind === "pick" && stop.mine) || stop.kind === "nominate" || stop.kind === "bid";
}
const player = (p) => `${esc(p.name)} <span class="dim">${esc(p.pos)} ${esc(p.mlb)}</span>`;
const teamName = (t) => (stop && t === stop.user_team ? "you" : "team " + t);

function renderClock() {
  const info = stop;
  let head;
  if (info.done) head = `<span class="pick">Draft complete</span>`;
  else if (info.mode === "snake") {
    head = `<span class="pick">Round ${info.round}, pick ${info.overall - (info.round - 1) * info.teams} <span class="dim" style="font-weight:400;font-size:15px">(overall ${info.overall} of ${info.total})</span></span>`
      + `<span class="who ${info.mine ? "mine" : ""}">${info.mine ? "YOUR PICK" : `team ${info.team} on the clock${info.mock ? "" : ": enter their pick below"}`}</span>`;
  } else {
    const lot = `Lot ${info.made + 1} of ${info.total}`;
    if (info.kind === "bid") head = `<span class="pick">${lot}: ${player(info.lot)}</span><span class="who mine">on the block, nominated by ${teamName(info.nominator)}</span>`;
    else if (info.kind === "nominate") head = `<span class="pick">${lot}</span><span class="who mine">YOUR NOMINATION</span>`;
    else head = `<span class="pick">${lot}</span><span class="who">team ${info.nominator} nominates: enter the player below</span>`;
  }
  const facts = [];
  const label = info.objective === "points" ? "mean roto points" : info.objective_label;
  facts.push(`<span>payout <b>${info.payout === "winner" ? "winner take all" : `playoffs (${info.playoff_teams} teams)`}</b>, options ranked by <b>${esc(label)}</b></span>`);
  if (info.mode === "auction" && !info.done) {
    facts.push(`<span>your budget <b>$${info.budget}</b>, max bid <b>$${info.max_bid}</b>, <b>${info.open_spots}</b> spots open</span>`);
    facts.push(`<span title="The money above the min bids left in the room, over the calculator's $ above the min bid of the players still available. Above 1, prices run above the values">room inflation <b>${f2(info.inflation)}</b></span>`);
  } else if (!info.done) facts.push(`<span><b>${info.open_spots}</b> roster spots open</span>`);
  const t = result && result.target;
  if (t && isNum(t.M)) {
    const tip = `The engine's O1-O3 at this stop, from the drafts where you ${info.mode === "snake" ? "skip this pick (the seat filled from waivers at the end)" : info.kind === "nominate" ? "make the rule's nomination" : "pass on this lot"}: `
      + `M and S, the mean and SD of your team's total; H, the mean total of the ${t.place === 1 ? "winner" : "team in place " + t.place}; z = (M − H)/S. `
      + `CE now uses them${riskObjective ? `; before the draft risk.js used an average team: M ${f1(riskObjective.M)}, S ${f1(riskObjective.S)}, H ${f1(riskObjective.H)} (${riskObjective.unit})` : ""}`;
    facts.push(`<span title="${esc(tip)}">your team now: M <b>${f1(t.M)}</b>, S <b>${f1(t.S)}</b>; H <b>${f1(t.H)}</b>; z <b>${f2(t.z)}</b> <span class="dim">(${esc(t.unit)})</span></span>`);
  }
  let html = `<div class="clock">${head}</div><div class="facts">${facts.join("")}</div>`;
  if (info.roster.length) {
    html += `<h3>your roster</h3><div class="tbl"><table><thead><tr><th class="l">slot</th><th class="l">player</th><th>$</th><th title="risk.js's risk-aware $ before the draft">risk $</th>${isAuction() ? "<th>paid</th>" : ""}</tr></thead><tbody>`
      + info.roster.map((r) => `<tr><td class="l">${esc(r.slot)}</td><td class="l">${player(r)}</td><td>${usd(r.value)}</td><td>${usd(r.risk)}</td>${isAuction() ? `<td>${whole(r.price)}</td>` : ""}</tr>`).join("")
      + `</tbody></table></div>`;
  }
  if (info.between.length) {
    html += `<h3>${info.mode === "snake" ? "picks" : "sales"} since your last</h3><pre class="picks">` + info.between.map((p) =>
      `${String(p.n).padStart(3)}  ${(p.you ? "you" : "team " + p.team).padEnd(8)} ${p.name.padEnd(26)} ${String(p.pos).padEnd(10)} $${f1(p.value).padStart(5)}${p.price !== null && p.price !== undefined ? `  sold $${p.price}` : ""}`).map(esc).join("\n") + `</pre>`;
  }
  $("clock").innerHTML = html;
}

// The objective's columns: [key, label, tooltip], the ranking measure first
function measureCols(res) {
  const h2h = (res.format || stop.format) === "h2h";
  const obj = res.objective;
  const W = ["win", "win%", "Share of seasons finishing first in the roto standings"];
  const PO = ["playoff", h2h ? "playoff%" : `top-${stop.playoff_teams}%`, h2h ? "Share of seasons in the head-to-head playoffs" : `Share of seasons in the top ${stop.playoff_teams} of the roto standings`];
  const TI = ["champ", "title%", "Share of seasons winning the head-to-head playoffs"];
  const PT = ["roto", "roto pts", "Mean roto standings points of your team"];
  const star = ([k, l, t]) => [k, l + " ★", t + ". The ranking measure"];
  if (obj === "points") return [star(PT), ...(h2h ? [PO, TI] : [W])];
  if (obj === "win") return [star(W), PT];
  if (obj === "champ") return [star(TI), PO, PT];
  return [star(PO), ...(h2h ? [TI] : [W]), PT];
}
const measureCell = (key, v) => (key === "roto" ? `<td>${f1(v)}</td>` : `<td>${pct(v)}</td>`);
const gapCell = (res, v) => (res.objective === "points" ? signedCell(v, 1) : signedCell(isNum(v) ? 100 * v : v, 1));

function progressText(res) {
  if (!res) return "";
  return res.sims < res.of ? ` <span class="status">simulating… ${res.sims} of ${res.of} drafts</span>` : ` <span class="status">${res.of} simulated drafts per option, the same worlds for every option</span>`;
}

function renderOptions() {
  const res = result;
  const el = $("options");
  if (stop.done) { el.innerHTML = ""; return; }
  if (stop.kind === "enter") { el.innerHTML = `<h2>Enter the nomination</h2><p class="note">A rival puts a player on the block: enter him below, then the engine prices your maximum bid.</p>`; return; }
  if (!res) {   // the options before (or without) a simulation
    const rows = stop.options.filter((o) => o.kind === "pick");
    el.innerHTML = `<h2>${stop.kind === "bid" ? "The lot" : "Your options"}${wantsSimulation() ? ` <span class="status">simulating…</span>` : ""}</h2>`
      + (rows.length ? `<div class="tbl"><table><thead><tr><th>#</th><th class="l">option</th><th class="l">player</th><th>$</th><th>risk $</th><th></th></tr></thead><tbody>`
        + rows.map((o, k) => `<tr><td>${k + 1}</td><td class="l">${esc(o.why)}</td><td class="l">${player(o)}</td><td>${usd(o.value)}</td><td>${usd(o.risk)}</td><td>${actionButton(o)}</td></tr>`).join("")
        + `</tbody></table></div>` : "")
      + (stop.kind === "pick" && !stop.mine ? `<p class="note">Not your pick: Re-simulate prices these options as if you were on the clock now.</p>` : "");
    wireButtons(el);
    return;
  }
  if (res.kind === "bid") return renderLot(res);
  const cols = measureCols(res);
  let html = `<h2>${res.kind === "nominate" ? "Your nomination" : "Your options"}${progressText(res)}</h2><div class="tbl"><table><thead><tr><th>#</th><th class="l">option</th><th class="l">player</th>`
    + `<th title="The calculator's $">$</th><th title="risk.js's risk-aware $ before the draft (an average team)">risk $</th>`
    + `<th title="CE now: risk.js's EffValue and Var_eff for him, with your team's M, S and H at this stop (the header), in the calculator's $">CE $</th><th title="The order by CE now">CE#</th>`
    + (res.kind === "nominate" ? `<th title="The room's expected price">room $</th><th title="Your own price for him: his risk-aware $ at your inflation, the bench share if he would not start">your $</th><th title="Share of the drafts where you bought him (you bid your own price)">you buy</th>` : "")
    + cols.map(([, l, t]) => `<th title="${esc(t)}">${esc(l)}</th>`).join("")
    + `<th title="10th percentile of your roto points">p10</th><th title="90th percentile">p90</th><th title="Mean finish in the roto standings">finish</th>`
    + `<th title="The ranking measure against the best option (percentage points, or roto points)">vs best</th><th title="Share of the simulated drafts where this option was the best">best%</th><th></th></tr></thead><tbody>`;
  res.options.forEach((o, k) => {
    const isBase = o.kind === "skip";
    const chosen = res.best_row && o.i === res.best_row.i && !isBase;
    html += `<tr class="${chosen ? "best" : isBase ? "baseline" : ""}"><td>${k + 1}</td><td class="l">${isBase ? "waiver fill (the baseline)" : esc(o.why)}${o.rule ? " ◆" : ""}</td>`
      + `<td class="l">${isBase ? "" : player(o)}</td><td>${isBase ? "" : usd(o.value)}</td><td>${isBase ? "" : usd(o.risk)}</td><td class="ce">${isBase ? "" : usd(o.ce_usd)}</td><td>${o.ce_rank ?? ""}</td>`
      + (res.kind === "nominate" ? `<td>${whole(o.expected_price)}</td><td>${whole(o.own_price)}</td><td>${pct(o.got)}</td>` : "")
      + cols.map(([key]) => measureCell(key, o[key])).join("")
      + `<td>${f1(o.p10)}</td><td>${f1(o.p90)}</td><td>${f2(o.finish)}</td>${gapCell(res, o.gap)}<td>${isBase ? "" : pct(o.best)}</td><td>${isBase ? "" : actionButton(o)}</td></tr>`;
  });
  html += `</tbody></table></div>`;
  if (res.ce_order) {
    const c = res.ce_order;
    html += `<p class="note${c.agree ? "" : " flag"}">${c.agree ? `The engine and CE now agree on the top option (${esc(c.engine_top)}).`
      : `The engine ranks ${esc(c.engine_top)} first; CE now ranks ${esc(c.ce_top)} first. The engine simulates the rest of the draft and the season (the specification's full Monte Carlo method); CE is its one-player normal approximation, blind to your roster's fit and to what the rivals take next.`}</p>`;
  }
  if (res.kind === "nominate" && res.nomination) {
    const n = res.nomination;
    html += `<p class="note">◆ The nomination rule: nominate the dearest <i>drain</i>, a player whose price to you (his risk-aware $ at your inflation; the bench share if he would not start) is $2 or more below the room's expected price, so a rival likely buys him and the money leaves the rivals' budgets; with no drain, the dearest player you would start. `
      + (n.chosen === "rule" ? `Recommended: the rule's ${esc(n.rule_name)}${n.engine !== n.rule ? ` (the engine's best, ${esc(n.engine_name)}, gains ${gapText(res, n.gain)} ± ${gapText(res, n.se)}: within the noise)` : ""}.`
        : `Recommended: the engine's ${esc(n.engine_name)}, better than the rule's ${esc(n.rule_name)} by ${gapText(res, n.gain)} (more than twice its standard error ${gapText(res, n.se)}).`) + `</p>`;
  }
  el.innerHTML = html;
  wireButtons(el);
}
const gapText = (res, v) => (res.objective === "points" ? f2(v) + " pts" : (100 * v).toFixed(2) + " pp");

function actionButton(o) {
  if (!stop || stop.done || o.kind !== "pick") return "";
  if (stop.kind === "pick") return `<button class="take" data-act="take" data-i="${o.i}"${stop.mine ? "" : ` title="Team ${stop.team} takes him"`}>${stop.mine ? "take" : "taken"}</button>`;
  if (stop.kind === "nominate") return `<button class="take" data-act="nominate" data-i="${o.i}">nominate</button>`;
  return "";
}
function wireButtons(root) {
  root.querySelectorAll("button[data-act]").forEach((b) => b.onclick = () => send({ type: b.dataset.act, index: Number(b.dataset.i) }));
  if (busy) root.querySelectorAll("button").forEach((b) => { b.disabled = true; });
}

function renderLot(res) {
  const lot = res.lot, be = res.break_even || {}, bid = res.bid || {};
  const main = be[res.objective] || {}, pts = res.objective !== "points" ? be.points : null;
  const label = res.objective === "points" ? "roto points" : res.objective_label;
  const cols = measureCols(res);
  const capNote = bid.cap === "value" ? " The break-even is noisy, and a bidder wins the lots it overrates, so the maximum bid is capped at the value bid (it paid off in 952 mock drafts)." : "";
  let html = `<h2>The maximum bid${progressText(res)}</h2><div class="lot">`
    + `<div class="key" title="The most to bid: the break-even on ${esc(label)}${bid.cap === "value" ? ", capped at the value bid" : ""}.${capNote}"><span>max bid${bid.capped ? " (capped)" : ""}</span><b>${whole(bid.amount ?? main.max_bid)}</b></div>`
    + `<div title="The break-even price on ${esc(label)}: buying him at this price is as good as passing (forced buys at five prices, each paired with the pass in the same worlds; the line through their gains crosses zero here). p* ${f1(main.p_star)}"><span>break-even on ${esc(label)}</span><b>${whole(main.max_bid)}</b></div>`
    + (pts ? `<div title="The same break-even on mean roto points. p* ${f1(pts.p_star)}"><span>break-even on roto points</span><b>${whole(pts.max_bid)}</b></div>` : "")
    + (bid.value_bid !== undefined ? `<div title="The calculator's $ at your inflation (the bench share if he would not start)"><span>value bid</span><b>${whole(bid.value_bid)}</b></div>` : "")
    + `<div class="ce" title="The specification's maximum bid (6.5): CE now (risk.js's EffValue and Var_eff with your team's M, S, H; ${f2(lot.ce)} SGP) in the calculator's $, at your inflation, the bench share if he would not start"><span>CE max bid</span><b>${whole(lot.ce_bid)}</b></div>`
    + `<div title="The calculator's $"><span>calculator $</span><b>${usd(lot.value)}</b></div>`
    + `<div title="risk.js's risk-aware $ before the draft"><span>risk-aware $</span><b>${usd(lot.risk)}</b></div>`
    + `<div title="The calculator's $ at the room's inflation"><span>room's expected price</span><b>${whole(lot.expected_price)}</b></div>`
    + `</div>`;
  html += `<div class="tbl"><table><thead><tr><th class="l">option</th><th title="Share of the drafts where you got him">got</th><th title="Mean price when you got him">paid</th>`
    + cols.map(([, l, t]) => `<th title="${esc(t)}">${esc(l)}</th>`).join("")
    + `<th>p10</th><th>p90</th><th>finish</th><th title="Against passing">vs pass</th></tr></thead><tbody>`;
  for (const o of res.options) {
    const name = o.kind === "buy" ? `buy at $${o.amount}` : o.amount > 0 ? `open at $${o.amount} (you nominated him)` : "pass";
    html += `<tr class="${o.kind === "bid" ? "baseline" : ""}"><td class="l">${esc(name)}</td><td>${pct(o.got)}</td><td>${usd(o.paid)}</td>`
      + cols.map(([key]) => measureCell(key, o[key])).join("") + `<td>${f1(o.p10)}</td><td>${f1(o.p90)}</td><td>${f2(o.finish)}</td>${gapCell(res, o.gap)}</tr>`;
  }
  html += `</tbody></table></div><p class="note">Each buy forces you to buy him at that price; the rest of the auction then plays out against the rivals' simulated bids. The break-even is where buying stops beating passing${isNum(main.slope) ? ` (the gain falls ${gapText(res, -main.slope)} per $1)` : ""}${bid.cap === "value" ? "; the maximum bid is the lower of the break-even and the value bid" : ""}.</p>`;
  $("options").innerHTML = html;
}

// The action under the options: a bid (mock auction), a result (live auction), a nomination entry
function renderAction() {
  const el = $("action");
  el.innerHTML = "";
  if (!stop || stop.done) return;
  const teams = Array.from({ length: stop.teams }, (_, k) => k + 1);
  const teamSelect = (id, sel) => `<select id="${id}"><option value="">team…</option>${teams.map((t) => `<option value="${t}"${t === sel ? " selected" : ""}>${t === stop.user_team ? `you (team ${t})` : "team " + t}</option>`).join("")}</select>`;
  if (stop.kind === "bid" && stop.mock) {
    const best = result && result.best_row ? result.best_row.amount : stop.own_price;
    el.innerHTML = `<div class="act"><b>Your maximum bid</b> $<input id="bid_amt" type="number" min="0" max="${stop.max_bid}" value="${best ?? 0}" style="width:90px"><button id="bid_go" class="primary">Bid</button><button id="bid_pass">Pass</button><span class="status">the mock room bids against it; the highest bid wins at the second-highest + $1</span></div>`;
    $("bid_go").onclick = () => send({ type: "bid", amount: Math.max(0, Math.floor(Number($("bid_amt").value) || 0)) });
    $("bid_pass").onclick = () => send({ type: "bid", amount: 0 });
  } else if (stop.kind === "bid") {
    el.innerHTML = `<div class="act"><b>Sold to</b> ${teamSelect("rec_team")} <b>for</b> $<input id="rec_price" type="number" min="${0}" max="${stop.budget}" style="width:90px"><button id="rec_go" class="primary">Record the sale</button></div>`;
    $("rec_go").onclick = () => send({ type: "record", team: Number($("rec_team").value) || null, price: $("rec_price").value === "" ? null : Number($("rec_price").value) });
  } else if (stop.kind === "enter" || (stop.kind === "nominate" && !stop.mock)) {
    const lead = stop.kind === "enter" ? "<b>On the block</b>" : "<b>Or a rival's nomination</b>";
    el.innerHTML = `<div class="act">${lead} <input id="blk_who" type="text" list="avail" placeholder="the player's name" style="flex:1 1 240px"> <b>by</b> ${teamSelect("blk_team", stop.kind === "enter" ? stop.nominator : null)}<button id="blk_go" class="primary">Put him on the block</button></div>`;
    $("blk_go").onclick = () => send({ type: "block", ...who($("blk_who").value), team: Number($("blk_team").value) || null });
  }
  if (busy) el.querySelectorAll("button").forEach((b) => { b.disabled = true; });
}

function renderCats() {
  const res = result, el = $("cats");
  if (!res || !res.options.length || stop.done) { el.innerHTML = ""; return; }
  const base = res.baseline, cats = res.cats;
  const total = (a) => a.reduce((x, y) => x + (y || 0), 0);
  const label = (o) => (o.kind === "skip" ? "waiver fill" : o.kind === "buy" ? `buy at $${o.amount}` : o.kind === "bid" ? (o.amount > 0 ? "open bid" : "pass") : esc(o.name));
  const baseText = res.kind === "pick" ? "this pick skipped, the seat filled from waivers at the end"
    : res.kind === "nominate" ? `nominating ${base.name}, the rule's choice` : base.amount > 0 ? "opening at the min bid" : "passing on him";
  let html = `<h2>Expected category points (of ${stop.teams})</h2><p class="note" style="margin-top:0">Your team's standings points in each category: the baseline (${esc(baseText)}), then what each option adds (one season of each simulated draft).</p>`
    + `<div class="tbl"><table><thead><tr><th class="l">option</th>${cats.map((c) => `<th>${esc(c)}</th>`).join("")}<th>total</th></tr></thead><tbody>`
    + `<tr class="baseline"><td class="l">baseline</td>${base.cats.map((v) => `<td>${f1(v)}</td>`).join("")}<td>${f1(total(base.cats))}</td></tr>`;
  for (const o of res.options) {
    if (o.kind === base.kind && (o.i ?? null) === (base.i ?? null) && (o.amount ?? null) === (base.amount ?? null)) continue;   // the baseline itself
    const lift = o.cats.map((v, k) => (isNum(v) && isNum(base.cats[k]) ? v - base.cats[k] : NaN));
    html += `<tr><td class="l">${label(o)}</td>${lift.map((v) => signedCell(v, 1)).join("")}${signedCell(total(lift), 1)}</tr>`;
  }
  el.innerHTML = html + `</tbody></table></div>`;
}

function renderStandings() {
  const res = result, el = $("standings");
  if (!res || stop.done) { el.innerHTML = ""; return; }
  let html = `<h2>The league's course</h2><p class="note" style="margin-top:0">Mean simulated standings points by category for every team, from the baseline's drafts (sorted by total).</p>`
    + `<div class="tbl"><table><thead><tr><th class="l">team</th>${isAuction() ? "<th>$ left</th>" : ""}${res.cats.map((c) => `<th>${esc(c)}</th>`).join("")}<th>total</th></tr></thead><tbody>`;
  for (const t of res.standings) {
    html += `<tr class="${t.you ? "you" : ""}"><td class="l">${t.you ? "you" : "team " + t.team}</td>${isAuction() ? `<td>${whole(stop.money[t.team - 1])}</td>` : ""}${t.cats.map((v) => `<td>${f1(v)}</td>`).join("")}<td>${f1(t.total)}</td></tr>`;
  }
  el.innerHTML = html + `</tbody></table></div>`;
}

function renderAll() {
  renderClock();
  renderOptions();
  renderCats();
  renderStandings();
}

// ---- the players ------------------------------------------------------------------------------

const labelOf = (p) => `${p.name} · ${p.pos} · ${p.mlb || "FA"}`;
function fillAvailable() {
  const gone = new Set(stop.gone);
  const rows = pool.filter((p) => !gone.has(p.i));
  $("avail").innerHTML = rows.map((p) => `<option value="${esc(labelOf(p))}"></option>`).join("");
}
// a name from an input: the datalist's label gives the pool index; anything else goes as text
function who(text) {
  const t = String(text || "").trim();
  return poolKey.has(t) ? { index: poolKey.get(t) } : { text: "p " + t };
}

// ---- commands -----------------------------------------------------------------------------------

function send(m) {
  if (busy) return;
  setBusy(true);
  msg("");
  worker.postMessage(m);
}
function simulate() {
  if (!stop || stop.done || !stop.options.length) return;
  setBusy(true);
  worker.postMessage({ type: "simulate" });
}
$("enter_pick").onclick = () => {
  const t = $("who").value.trim();
  if (!t || !stop || stop.done) return;
  if (stop.mode === "snake") send({ type: "take", ...who(t) });
  else if (stop.kind === "nominate") send({ type: "nominate", ...who(t) });
  else msg("In an auction, enter a nomination or a sale in the box under the options.", true);
  $("who").value = "";
};
$("who").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("enter_pick").click(); } });
$("resim").onclick = () => { if (!busy) simulate(); };
$("undo").onclick = () => send({ type: "undo" });
$("auto").onclick = () => send({ type: "auto" });
$("show_board").onclick = () => send({ type: "board", n: 25 });
$("show_rosters").onclick = () => send({ type: "rosters" });

function renderBoard(rows) {
  let html = `<h3>best available (by the calculator's $)</h3><div class="tbl"><table><thead><tr><th>#</th><th class="l">player</th><th>$</th><th>risk $</th><th>SGP</th><th>fits</th><th></th></tr></thead><tbody>`;
  for (const r of rows) html += `<tr><td>${r.rank}</td><td class="l">${player(r)}</td><td>${usd(r.value)}</td><td>${usd(r.risk)}</td><td>${f2(r.sgpar)}</td><td>${r.legal ? "yes" : "no"}</td><td>${actionButton({ ...r, kind: "pick" })}</td></tr>`;
  $("panel").innerHTML = html + `</tbody></table></div>`;
  wireButtons($("panel"));
}
function renderRosters(rows) {
  let html = `<h3>rosters</h3>`;
  for (const t of rows) {
    const bySlot = {};
    for (const r of t.players) (bySlot[r.slot] = bySlot[r.slot] || []).push(r.name + (r.price !== null && r.price !== undefined ? ` $${r.price}` : ""));
    const txt = Object.keys(bySlot).length ? Object.entries(bySlot).map(([s, n]) => `<b>${esc(s)}</b> ${n.map(esc).join(", ")}`).join(" &nbsp;|&nbsp; ") : "(empty)";
    html += `<p class="note" style="color:var(--ink)"><b style="color:${t.you ? "var(--good)" : "var(--muted)"}">${t.you ? "you" : "team " + t.team}</b>${t.budget !== null ? ` <span class="dim">($${t.budget} left)</span>` : ""} ${txt}</p>`;
  }
  $("panel").innerHTML = html;
}
function renderFinal(d) {
  const h2h = d.format === "h2h";
  const head = `<th class="l">team</th><th>roto</th><th>finish</th><th>win%</th>${h2h ? "<th>playoff%</th><th>title%</th>" : d.payout === "playoffs" ? `<th>${esc(d.objective_label)}</th>` : ""}<th>team $</th>${d.standings[0].spent !== null ? "<th>spent</th>" : ""}${d.cats.map((c) => `<th>${esc(c)}</th>`).join("")}`;
  const me = d.standings.findIndex((r) => r.you) + 1;
  let html = `<h2>Draft complete: your team is ${me} of ${d.standings.length} by mean roto points</h2>`
    + `<div class="tbl"><table><thead><tr><th class="l">slot</th><th class="l">player</th><th>$</th><th>risk $</th>${d.standings[0].spent !== null ? "<th>paid</th>" : ""}</tr></thead><tbody>`
    + d.roster.map((r) => `<tr><td class="l">${esc(r.slot)}</td><td class="l">${player(r)}</td><td>${usd(r.value)}</td><td>${usd(r.risk)}</td>${d.standings[0].spent !== null ? `<td>${whole(r.price)}</td>` : ""}</tr>`).join("")
    + `</tbody></table></div><h3>every team over ${d.sims} simulated seasons</h3><div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>`;
  for (const t of d.standings) {
    html += `<tr class="${t.you ? "you" : ""}"><td class="l">${t.you ? "you" : "team " + t.team}</td><td>${f1(t.roto)}</td><td>${f2(t.finish)}</td><td>${pct(t.win)}</td>`
      + (h2h ? `<td>${pct(t.playoff)}</td><td>${pct(t.champ)}</td>` : d.payout === "playoffs" ? `<td>${pct(t.playoff)}</td>` : "")
      + `<td>${usd(t.team_value)}</td>${t.spent !== null ? `<td>${whole(t.spent)}</td>` : ""}${t.cats.map((v) => `<td>${f1(v)}</td>`).join("")}</tr>`;
  }
  $("final").innerHTML = html + `</tbody></table></div>`;
  $("final").hidden = false;
}

// ---- the worker ------------------------------------------------------------------------------

function onStop(info) {
  stop = info;
  result = null;
  $("draft").hidden = false;
  const det = $("setup_details");
  det.open = false;
  det.querySelector("summary").innerHTML = `<b>Draft settings</b><span>${info.mode} draft, you are team ${info.user_team}, ${info.mock ? "mock" : "live"}, ${info.sims} drafts per option (click to review)</span>`;
  setStatus(`draft in progress: you are team ${info.user_team} (draft mode v${VERSION})`);
  fillAvailable();
  $("panel").innerHTML = "";
  renderAll();
  renderAction();
  if (info.done) { $("cats").innerHTML = ""; $("standings").innerHTML = ""; setBusy(true); worker.postMessage({ type: "final" }); return; }
  if (wantsSimulation()) simulate();
  else setBusy(false);
}

function did(action, r) {
  if (!r.ok) { setBusy(false); msg(r.message, true); return; }
  const x = r.pick || r.result || r.lot;
  if (r.pick) msg(`${r.pick.you ? "you take" : "team " + r.pick.team + " takes"} ${x.name} (${x.pos})`);
  else if (r.result) msg(`${r.result.you ? "you buy" : "team " + r.result.team + " buys"} ${x.name} for $${r.result.price}`);
  else if (r.lot) msg(`${x.name} goes on the block${r.nominator ? ` (team ${r.nominator})` : ""}`);
  worker.postMessage({ type: "next" });
}

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "status") { if (!stop) setStatus(m.text); return; }
  if (m.type === "error") {
    setBusy(false);
    const text = lastLine(m.message);
    msg(text, true);
    if (!stop) {
      setStatus(text, "err");
      $("setup").querySelectorAll("input,select,button").forEach((el) => { el.disabled = false; });
    }
    return;
  }
  if (m.type === "ready") { engineReady = true; ready(); if (!data.loaded) setStatus("the engine is ready; loading the projections…"); return; }
  if (m.type === "pool") { pool = m.rows; poolKey = new Map(pool.map((p) => [labelOf(p), p.i])); return; }
  if (m.type === "stop") { onStop(m.info); return; }
  if (m.type === "progress" || m.type === "result") {
    result = m.result;
    renderAll();
    if (m.type === "result") { setBusy(false); renderAction(); }
    return;
  }
  if (m.type === "did") { did(m.action, m.r); return; }
  if (m.type === "board") { setBusy(false); renderBoard(m.rows); return; }
  if (m.type === "rosters") { setBusy(false); renderRosters(m.rows); return; }
  if (m.type === "final") { setBusy(false); renderFinal(m.data); return; }
};
worker.onerror = (e) => setStatus(`The engine failed to start (${e.message || "worker error"}).`, "err");

renderLeague();
worker.postMessage({ type: "init", version: VERSION });
loadData();
