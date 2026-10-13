// The lineup-lock and two-way checks from the locks spec (Task 7), against its simulation tables:
// the chance a team's SP spots bind (Table 9.1, within 0.03), the q values of Task 3, the two-way
// values (Table 9.6: one slot under daily locks exact, under weekly ones within 0.12), that a
// simultaneous player is worth at least either role and a one-slot one at least his hitting, more
// the more often lineups lock, that daily locks change nothing, that weekly locks don't shrink the
// pitchers' share of the dollars (with the split from the values), and the order of two-way values
// in the default league (simultaneous ≥ one slot ≥ split hitter, one slot daily ≥ Mon/Fri ≥ weekly).
//
//   node locks_checks.mjs hitters.csv pitchers.csv [position_eligibility.csv]
import { readFileSync } from "node:fs";
import * as C from "../../auction-calculator/calc.js";

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

// Task 3's q values for a 5-man rotation
for (const [days, want] of [[1, 0.17], [3, 0.50], [4, 0.67], [7, 0.95]]) {
  const q = C.qWindow(days);
  check(Math.abs(q - want) < 0.01, `q(${days} days) ${q.toFixed(3)} (spec ${want})`);
}
// Table 9.1: share of lock windows where 6 SP spots bind, by rostered SPs
const TABLE_91 = { 7: [0, 0.04, 0.70], 8: [0, 0.12, 0.94], 9: [0, 0.23, 0.99], 10: [0, 0.37, 1.00] };
for (const [n, row] of Object.entries(TABLE_91)) {
  const got = ["daily", "split", "weekly"].map((lock) => C.pBindLock(lock, Number(n), 6));
  check(got.every((g, j) => Math.abs(g - row[j]) < 0.03), `P(bind), ${n} SPs for 6 spots: ${got.map((g) => g.toFixed(3)).join(" / ")} (table ${row.join(" / ")})`);
}
check(Math.abs(C.pBindLock("split", 8, 6) - 0.118) < 0.002, `P(bind), 8 SPs for 6 spots, Monday/Friday: ${C.pBindLock("split", 8, 6).toFixed(3)} (spec 0.118)`);

// Table 9.6: H = 10, about 24 starts in a 6-man rotation
const TABLE_96 = { 3: [10.00, 11.5, 13.0], 6: [10.10, 14.5, 16.0], 9: [10.78, 17.5, 19.0], 12: [13.15, 20.5, 22.0] };
for (const [P, [weekly, daily, simul]] of Object.entries(TABLE_96)) {
  const w = C.twoWayValue(10, Number(P), "oneslot", 24.3, "weekly"), d = C.twoWayValue(10, Number(P), "oneslot", 24.3, "daily");
  const s = C.twoWayValue(10, Number(P), "simultaneous", 24.3);
  check(Math.abs(w - weekly) < 0.12 && Math.abs(d - daily) < 0.02 && Math.abs(s - simul) < 1e-9,
    `two-way, P = ${P}: one slot weekly ${w.toFixed(2)} (table ${weekly}), daily ${d.toFixed(2)} (${daily}), simultaneous ${s.toFixed(1)} (${simul})`);
}
// Task 7.4 over a grid of H and P
let grid = true;
for (const H of [-2, 0, 3, 10, 20]) for (const P of [-2, 0, 3, 9, 20]) for (const starts of [12, 24, 32]) {
  const s = C.twoWayValue(H, P, "simultaneous", starts);
  const [d, b, w] = ["daily", "split", "weekly"].map((lock) => C.twoWayValue(H, P, "oneslot", starts, lock));
  if (s < Math.max(H, P) - 1e-9 || !(d >= b - 1e-9 && b >= w - 1e-9 && w >= H - 1e-9)) grid = false;
}
check(grid, "two-way: simultaneous ≥ max(H, P), and one slot daily ≥ Mon/Fri ≥ weekly ≥ H, over a grid of H, P and starts");

// The calculator on real projections
const raw = { h: C.readProjections(readFileSync(process.argv[2], "utf8")), p: C.readProjections(readFileSync(process.argv[3], "utf8")) };
// positions from last season's games at Yahoo's thresholds, as on the page, with an eligibility file
const elig = process.argv[4] ? { table: C.readProjections(readFileSync(process.argv[4], "utf8")), rules: C.YAHOO_ELIGIBILITY } : null;
const H = C.prepHitters(raw.h, "All", true, elig), P = C.prepPitchers(raw.p, "All", true, elig);
const base = { slots: { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, OF: 3, UT: 2 }, pitcherSlots: { SP: 2, RP: 2, P: 4 }, hitters: 10, pitchers: 8,
  bench: 5, minimizeBench: true, style: "Categories", format: "roto", weeks: 23, teams: 12, minBid: 1, budget: 260, span: 3, curve: 1.05,
  hitterShare: 0.65, hitterCats: C.DEFAULT_HITTER_CATS, pitcherCats: C.DEFAULT_PITCHER_CATS };
const value = (r) => new Map(r.players.map((p) => [p.type + p.mlbamid + p.name, p.value]));
const plain = value(C.auctionValues(H, P, base)), daily = value(C.auctionValues(H, P, { ...base, lock: "daily" }));
check([...plain].every(([k, v]) => Object.is(v, daily.get(k)) || Math.abs(v - daily.get(k)) < 1e-12), "daily locks: every value unchanged");
// Task 7.5, with the split from the values (a fixed split fixes the pitchers' share)
for (const [name, slots, pitcherSlots, teams] of [["Yahoo", base.slots, base.pitcherSlots, 12], ["NFBC", { C: 2, "1B": 1, "2B": 1, "3B": 1, SS: 1, CI: 1, MI: 1, OF: 5, UT: 1 }, { P: 9 }, 15]]) {
  const fmt = { slots, pitcherSlots, teams, hitters: Object.values(slots).reduce((a, b) => a + b), pitchers: Object.values(pitcherSlots).reduce((a, b) => a + b) };
  const d = 1 - C.auctionValues(H, P, { ...base, ...fmt, hitterShare: null, lock: "daily" }).hitterShare;
  const r = C.auctionValues(H, P, { ...base, ...fmt, hitterShare: null, lock: "weekly" });
  const L = r.lock;
  check(1 - r.hitterShare >= d - 1e-9, `${name} weekly: pitchers' share ${(100 * (1 - r.hitterShare)).toFixed(2)}% ≥ daily ${(100 * d).toFixed(2)}% (typical team ${L.nSP} SPs for ${L.S} spots, bind ${(100 * L.pBind).toFixed(0)}%)`);
}
// The default league's two-way player in each mode, under each lock
for (const lock of ["daily", "split", "weekly"]) {
  const tw = {};
  for (const mode of C.TWO_WAY_MODES) {
    const r = C.auctionValues(H, P, { ...base, lock, twoWay: mode });
    const rows = r.players.filter((p) => r.twoWay.players.includes(p.name) || (mode === "split" && p.name === "Shohei Ohtani"));
    tw[mode] = mode === "split" ? rows.find((p) => p.type === "h").value : rows[0].value;
  }
  check(tw.simultaneous >= tw.oneslot && tw.oneslot >= tw.split - 1e-9,
    `two-way order, ${lock} locks: simultaneous $${tw.simultaneous.toFixed(2)} ≥ one slot $${tw.oneslot.toFixed(2)} ≥ split hitter $${tw.split.toFixed(2)}`);
}

console.log(fails ? `FAIL: ${fails} failing` : "OK");
process.exit(fails ? 1 : 0);
