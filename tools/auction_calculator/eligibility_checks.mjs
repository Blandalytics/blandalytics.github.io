// Checks the position eligibility rule: on made-up players, that a hitter qualifies at a position
// with the starts or the games there (a blank threshold skipped), a pitcher at SP with the starts and
// RP with the relief appearances, that one short everywhere goes where he played most (UT for a DH),
// and that a player the file doesn't have (or who didn't play on that side) keeps the projections'
// positions; then, on the eligibility file itself, that Yahoo's thresholds (5 GS or 10 G, SP 3 GS,
// RP 5 relief) never give a position the file's Y! Pos doesn't list (Yahoo's own positions, which also
// carry over from the season before) and that loosening any of them by one does. With projections,
// it reports whose positions the games change.
//
//   node eligibility_checks.mjs position_eligibility.csv [hitters.csv pitchers.csv]
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const Y = C.YAHOO_ELIGIBILITY;

// Made-up players: [MLBAMID, games by position as "<pos> G" / "<pos> GS"]
const POS = ["C", "1B", "2B", "3B", "SS", "OF", "DH", "P"];
const made = [
  [1, { "2B G": 6, "2B GS": 5 }],                           // 5 starts
  [2, { "SS G": 10, "SS GS": 0 }],                          // 10 games
  [3, { "3B G": 9, "3B GS": 4, "1B G": 3, "1B GS": 1 }],    // short everywhere: 3B, where he played most
  [4, { "DH G": 112, "DH GS": 106, "OF G": 2, "OF GS": 1 }],  // a DH: UT
  [5, { "1B G": 3, "1B GS": 2, "OF G": 3, "OF GS": 2 }],    // a tie: both
  [6, { "1B G": 4, "1B GS": 2, "DH G": 4, "DH GS": 2 }],    // a tie with DH: the fielding position
  [7, { "C G": 40, "C GS": 35, "1B G": 12, "1B GS": 3, "DH G": 30, "DH GS": 30 }],  // two positions, no UT
  [8, { "P G": 3, "P GS": 3 }],                             // SP
  [9, { "P G": 5, "P GS": 0 }],                             // RP
  [10, { "P G": 20, "P GS": 8 }],                           // both
  [11, { "P G": 3, "P GS": 2 }],                            // short: SP, more starts than relief
  [12, { "P G": 5, "P GS": 1 }],                            // short: RP
  [13, {}],                                                 // no games at all
];
const E = { columns: ["MLBAMID", "Season", ...POS.flatMap((p) => [`${p} G`, `${p} GS`])], n: made.length, data: {} };
for (const col of E.columns) E.data[col] = made.map(([id, g]) => (col === "MLBAMID" ? id : col === "Season" ? 2026 : g[col] ?? 0));
const want = { 1: "2B", 2: "SS", 3: "3B", 4: "UT", 5: "1B,OF", 6: "1B", 7: "C,1B", 8: "SP", 9: "RP", 10: "SP,RP", 11: "SP", 12: "RP" };
for (const [i, [id]] of made.entries()) {
  const side = id >= 8 ? "p" : "h";
  const e = C.eligibilityOf(E, i, side, Y);
  check(id === 13 ? e === null : e && e.pos === want[id] && e.season === 2026, `player ${id}: ${e ? e.pos + (e.most ? " (most played)" : "") : "no games"}${id === 13 ? "" : ` (want ${want[id]})`}`);
}
check(C.eligibilityOf(E, 0, "h", { ...Y, gs: null }).pos === "2B" && C.eligibilityOf(E, 0, "h", { ...Y, gs: null }).most,
  "a blank GS threshold skips the starts test: 5 starts and 6 games is 2B only as the most played");
check(C.eligibilityOf(E, 0, "p", Y) === null, "a hitter with no pitching has no pitcher eligibility");
check(C.eligibilityOf(E, 2, "h", { gs: null, g: null, sp: null, rp: null }).pos === "3B", "with every test skipped, everyone goes where he played most");

// The table: by MLBAM id (a text id too), the projections' positions for the rest, the table untouched
const T = { columns: ["Name", "MLBAMID", "Y! Pos"], n: 4, data: { Name: ["a", "b", "c", "d"], MLBAMID: [4, "7", 99, NaN], "Y! Pos": ["OF", "C", "SS", null] } };
const t = C.withEligibility(T, E, "h", Y);
check(JSON.stringify(t.data["Y! Pos"]) === JSON.stringify(["UT", "C,1B", "SS", null]) && t.data.Eligibility[2] === null && t.data.Eligibility[0].most,
  `positions by id: ${JSON.stringify(t.data["Y! Pos"])} (a text id matches; one not in the file and one with no id keep the projections')`);
check(JSON.stringify(T.data["Y! Pos"]) === JSON.stringify(["OF", "C", "SS", null]) && !("Eligibility" in T.data), "the projections passed in are left as they are");

// The file: Yahoo's thresholds against Yahoo's own positions
const F = C.readProjections(readFileSync(process.argv[2], "utf8"));
const listed = (i) => new Set((F.data["Y! Pos"][i] ?? "").split(","));
// positions a rule gives that the file's Y! Pos doesn't list (only where the player qualifies)
const extra = (rules) => {
  let n = 0;
  for (let i = 0; i < F.n; i++) for (const side of ["h", "p"]) {
    const e = C.eligibilityOf(F, i, side, rules);
    if (e && !e.most) n += e.pos.split(",").filter((p) => !listed(i).has(p)).length;
  }
  return n;
};
check(extra(Y) === 0, `Yahoo's thresholds (5 GS or 10 G, SP 3 GS, RP 5 relief) give no position the file's Y! Pos doesn't list, over ${F.n} players`);
for (const [k, label] of [["gs", "GS"], ["g", "G"], ["sp", "SP GS"], ["rp", "RP G"]]) {
  const n = extra({ ...Y, [k]: Y[k] - 1 });
  check(n > 0, `${label} ${Y[k] - 1}: ${n} positions Yahoo doesn't list`);
}

// The projections: whose positions the games change
if (process.argv[4]) {
  for (const [side, path, prep] of [["h", process.argv[3], C.prepHitters], ["p", process.argv[4], C.prepPitchers]]) {
    const raw = C.readProjections(readFileSync(path, "utf8"));
    const own = prep(raw, "All", true), games = prep(raw, "All", true, { table: F, rules: Y });
    const from = games.data.Eligibility.filter(Boolean).length;
    const moved = [];
    for (let i = 0; i < own.n; i++) if ((own.data["Y! Pos"][i] ?? "") !== (games.data["Y! Pos"][i] ?? "")) moved.push(`${own.data.Name[i]} ${own.data["Y! Pos"][i]} → ${games.data["Y! Pos"][i]}`);
    console.log(`     ${side === "h" ? "hitters" : "pitchers"}: ${from} of ${own.n} from games, ${moved.length} changed${moved.length ? ` (${moved.slice(0, 8).join(", ")}${moved.length > 8 ? ", …" : ""})` : ""}`);
  }
}

console.log(fails ? `FAIL: ${fails} failing` : "OK");
process.exit(fails ? 1 : 0);
