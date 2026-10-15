// The draft page's inputs, without the DOM, so the page (app.js) and the Node checks
// (page_inputs.mjs) build exactly the same ones:
//
//   settingsFrom(C, form)        the calculator's settings from its saved form (localStorage
//                                "auction-calculator:v1", written by ../app.js), as its readSettings
//                                builds them; the default league when there is no form
//   riskSettingsFrom(form)       the calculator's Risk (beta) settings (payout, playoff teams, ...)
//   buildTable(C, R, H, P, s, files, rs)   the engine's table (table.js) from one calc.js run, with
//                                the risk-aware fields when the risk files are there (risk.js)
//   draftRisk(rs, choices)       risk.js's settings with the draft's payout and playoff teams
//   sessionConfig(choices, s, rs)   the cfg the worker gives py/web_api.Session
//
// C is calc.js and R is risk.js, passed in so the page and Node use one copy of each.
import { draftTable } from "./table.js?v=2";

export const STORE = "auction-calculator:v1";

const SLOT_KEYS = ["C", "1B", "2B", "3B", "SS", "CI", "MI", "OF", "UT"];
const PSLOT_KEYS = ["SP", "RP", "P"];
// the calculator's default league (its index.html inputs): Yahoo 5x5 roto, 12 teams, $260
const DEFAULT_FORM = {
  style: "Categories", bench: "5", teams: "12", min_bid: "1", budget: "260", span: "3", curve: "1.05", weeks: "23", phi: "1", pt_cv: "",
  slot_C: "1", slot_1B: "1", slot_2B: "1", slot_3B: "1", slot_SS: "1", slot_CI: "0", slot_MI: "0", slot_OF: "3", slot_UT: "2",
  pslot_SP: "2", pslot_RP: "2", pslot_P: "4",
  pool: "All", format: "roto", lock: "daily", twoway: "split",
  min_bench: true, include_fa: true, fill_pt: true, specialists: true, split_auto: false,
};
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/** The calculator's settings (calc.js auctionValues' s) from its saved form; form may be null. */
export function settingsFrom(C, form) {
  const f = { ...DEFAULT_FORM, ...(form || {}) };
  const num = (id) => {
    const v = Number(f[id]);
    return f[id] !== "" && Number.isFinite(v) ? v : Number(DEFAULT_FORM[id]);
  };
  const bool = (id) => (typeof f[id] === "boolean" ? f[id] : DEFAULT_FORM[id]);
  const slots = Object.fromEntries(SLOT_KEYS.map((t) => [t, num("slot_" + t)]));
  const pitcherSlots = Object.fromEntries(PSLOT_KEYS.map((t) => [t, num("pslot_" + t)]));
  const style = f.style === "Points" ? "Points" : "Categories";
  const twoWay = f.twoway === "daily" || f.twoway === "weekly" ? "oneslot" : f.twoway;
  const split = typeof f.split === "string" && f.split !== "" && Number.isFinite(Number(f.split)) ? Number(f.split) : style === "Categories" ? 65 : 50;
  const cats = form && form.cats && Array.isArray(form.cats.h) && Array.isArray(form.cats.p) ? form.cats : null;
  const pts = form && form.points && Array.isArray(form.points.h) && Array.isArray(form.points.p) ? form.points : null;
  return {
    slots, pitcherSlots, hitters: total(slots), pitchers: total(pitcherSlots), bench: num("bench"), span: num("span"),
    minimizeBench: bool("min_bench"), style, teams: num("teams"), minBid: num("min_bid"), budget: num("budget"),
    pool: f.pool, includeFa: bool("include_fa"), format: f.format, weeks: num("weeks"), phi: num("phi"),
    // blank, or the old placeholder default: the fitted PT luck
    ptCV: f.pt_cv === "" || f.pt_cv === "0.15" || f.pt_cv == null ? null : num("pt_cv"),
    lock: f.lock, twoWay, fillPT: bool("fill_pt"), specialists: bool("specialists"), curve: num("curve"),
    hitterShare: bool("split_auto") ? null : split / 100,
    hitterCats: cats ? cats.h : [...C.DEFAULT_HITTER_CATS], pitcherCats: cats ? cats.p : [...C.DEFAULT_PITCHER_CATS],
    hitterPoints: pts ? pts.h : C.DEFAULT_HITTER_POINTS.map((r) => r.slice()), pitcherPoints: pts ? pts.p : C.DEFAULT_PITCHER_POINTS.map((r) => r.slice()),
  };
}

/** The calculator's risk settings (risk.js applyRisk's rs) from its saved form */
export function riskSettingsFrom(form) {
  const r = (form && form.risk) || {};
  const int = (v, d) => (v !== undefined && v !== "" && Number.isInteger(Number(v)) ? Number(v) : d);
  return {
    payout: r.risk_payout === "playoffs" ? "playoffs" : "winner",
    playoffTeams: int(r.risk_playoffs, 4),
    transactions: ["daily", "weekly", "limited"].includes(r.risk_txn) ? r.risk_txn : "daily",
    ilSlots: int(r.risk_il, 2),
  };
}

/** risk.js's settings for the draft: the calculator's, with the draft page's payout and playoff teams */
export function draftRisk(rs, choices) {
  return { ...rs, payout: choices.payout || rs.payout, playoffTeams: choices.playoffTeams ?? rs.playoffTeams };
}

/** Why the draft engine can't take this league (null if it can) */
export function unsupported(s) {
  if (s.style === "Points") return "The draft mode scores categories leagues only (roto or head-to-head); this league scores points.";
  return null;
}

/**
 * The engine's table from one calc.js run on the prepared tables H and P, with the risk-aware $
 * (risk.js) when files ({ h, p } from R.parseRiskFile) are given. Returns { result, table, warnings }.
 */
export function buildTable(C, R, H, P, s, files, rs) {
  const warnings = [];
  const result = C.auctionValues(H, P, files ? { ...s, debug: true } : s);
  if (files) {
    try {
      result.risk = R.applyRisk(C, result, H, P, s, files, rs);
      warnings.push(...result.risk.warnings);
    } catch (e) {
      result.risk = null;
      warnings.push(`The risk-aware $ failed: ${e.message || e}`);
    }
  }
  const table = draftTable(result, H, P, s);
  delete result.debug;
  return { result, table, warnings };
}

/**
 * The worker's cfg for web_api.Session. choices: { mode, slot, mock, sims, seed, objective ("payout"
 * | "points"; anything else: the engine's default, roto points in roto and the payout in
 * head-to-head), payout ("winner" | "playoffs"), playoffTeams, autoBelow, dnd }. The format follows
 * the calculator (all-play is played as head-to-head).
 */
export function sessionConfig(choices, s, rs) {
  const format = s.format === "h2h" || s.format === "allplay" ? "h2h" : "roto";
  const payout = choices.payout || rs.payout;
  const sims = Math.max(10, Math.round(Number(choices.sims) || 100));
  return {
    mode: choices.mode === "auction" ? "auction" : "snake",
    slot: Math.round(Number(choices.slot) || 1),
    mock: choices.mock !== false,
    sims,
    chunk: Math.max(5, Math.min(25, Math.round(sims / 8))),
    seed: Math.round(Number(choices.seed) || 20270401),
    format,
    weeks: s.weeks,
    payout,
    playoff_teams: Math.round(Number(choices.playoffTeams ?? rs.playoffTeams) || 4),
    objective: choices.objective === "points" || choices.objective === "payout" ? choices.objective : null,
    auto_below: Math.max(0, Number(choices.autoBelow) || 0),
    dnd: Array.isArray(choices.dnd) ? choices.dnd : [],
  };
}
