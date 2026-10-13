// The draft engine's player table, built from a calc.js result. The page calls draftTable() on the
// result it already has and posts the JSON to the draft worker; export_players.mjs does the same
// under Node for the engine's tests and dry runs. No DOM here.
//
//   import * as C from "../calc.js";
//   import { draftTable } from "./draft/table.js";
//   const result = C.auctionValues(H, P, settings);
//   const table = draftTable(result, H, P, settings);   // -> JSON for py/pool.py
//
// table: { version, settings: { teams, slots, pitcherSlots, bench, budget, minBid, format, weeks,
//          hitterCats, pitcherCats, phi }, perSGP, fillTargets: { h: { role: target }, p: {...} },
//          players: [{ type, name, mlbamid, team, pos, value, sgpar, drafted, valuedAt, proj }] }
// proj holds the projection's counts that the draft's categories are built from (the same names
// as the risk file's stats; a pitcher's HD is written as HLD and TBF as BF).

export const PROJ_COLS = {
  h: ["PA", "AB", "H", "2B", "3B", "HR", "R", "RBI", "SB", "CS", "BB", "HBP", "SF", "K", "G"],
  p: ["IP", "BF", "G", "GS", "W", "L", "QS", "SV", "HLD", "BS", "K", "ER", "H", "BB", "HBP", "HR"],
};
const ALIAS = { BF: "TBF", HLD: "HD" };   // the auction CSVs' names for the risk file's stats

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function rowIndex(T) {
  const byId = new Map(), byName = new Map();
  for (let i = 0; i < T.n; i++) {
    const id = T.data.MLBAMID ? T.data.MLBAMID[i] : null;
    if (id !== null && id !== "" && Number.isFinite(Number(id))) byId.set(Number(id), i);
    const name = T.data.Name ? T.data.Name[i] : null;
    if (name && !byName.has(name)) byName.set(name, i);
  }
  return { byId, byName };
}

function projOf(T, i, type) {
  const out = {};
  for (const col of PROJ_COLS[type]) {
    const src = col in T.data ? col : ALIAS[col];
    const v = src && src in T.data ? Number(T.data[src][i]) : NaN;
    out[col] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** The engine's table from one calc.js run: H and P are the prepared tables the run was given. */
export function draftTable(result, H, P, s) {
  const idx = { h: rowIndex(H), p: rowIndex(P) };
  const tables = { h: H, p: P };
  const players = [];
  for (const x of result.players) {
    const type = x.twoWay && x.type === "h" ? "h" : x.type;
    const T = tables[type], ix = idx[type];
    const id = finite(Number(x.mlbamid));
    const i = id !== null && ix.byId.has(id) ? ix.byId.get(id) : ix.byName.get(x.name);
    if (i === undefined || !Number.isFinite(x.value)) continue;
    players.push({
      type, name: x.name, mlbamid: id, team: x.team ?? "", pos: (x.twoWay ? x.twoWay.hPos : x.pos) ?? (type === "p" ? "P" : "UT"),
      value: x.value, sgpar: finite(x.sgpar), drafted: !!x.drafted, valuedAt: x.valuedAt ?? null, proj: projOf(T, i, type),
    });
  }
  const targets = (t) => (t ? Object.fromEntries(Object.entries(t).map(([role, f]) => [role, finite(f.target)])) : null);
  return {
    version: 1,
    settings: {
      teams: s.teams, slots: s.slots, pitcherSlots: s.pitcherSlots, bench: s.bench, budget: s.budget, minBid: s.minBid,
      format: s.format ?? "roto", weeks: s.weeks ?? 23, hitterCats: s.hitterCats, pitcherCats: s.pitcherCats, phi: s.phi ?? 1,
    },
    perSGP: result.perSGP,
    fillTargets: { h: targets(result.fillTargets && result.fillTargets.h), p: targets(result.fillTargets && result.fillTargets.p) },
    players,
  };
}
