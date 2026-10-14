// The draft engine's player table from two auction CSVs, with the calculator's own model, built as
// the draft page builds it (setup.js: the calculator's settings from its saved form, calc.js, the
// risk-aware $ of risk.js when the risk files are given, table.js). For the engine's tests, the dry
// runs and the page check (page_check.py).
//
//   node export_players.mjs hitters_auction_ev.csv pitchers_auction_ev.csv out.json ['<settings JSON>']
//        [--risk hitters_risk_ev.bin pitchers_risk_ev.bin] [--form form.json] [--payout winner|playoffs]
//        [--cfg '<choices JSON>' cfg_out.json]
//
// --form: the calculator's saved form (its localStorage "auction-calculator:v1"); default: its default
// league (Yahoo 5x5 roto). The settings JSON overrides fields of the settings built from it.
// --cfg: also write the worker's Session cfg for these choices (setup.js sessionConfig), as the page sends it;
// the choices' payout and playoff teams also go to risk.js, as on the page (setup.js draftRisk).
import { readFileSync, writeFileSync } from "node:fs";
import * as C from "../calc.js?v=17";
import * as R from "../risk.js?v=2";
import { buildTable, draftRisk, riskSettingsFrom, sessionConfig, settingsFrom } from "./setup.js?v=3";

const argv = process.argv.slice(2);
const opt = (name, n = 1) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv.slice(i + 1, i + 1 + n);
  argv.splice(i, n + 1);
  return n === 1 ? v[0] : v;
};
const risk = opt("--risk", 2), formPath = opt("--form"), payout = opt("--payout"), cfg = opt("--cfg", 2);
const [hPath, pPath, outPath, extra] = argv;
if (!outPath) {
  console.error("usage: node export_players.mjs hitters.csv pitchers.csv out.json ['<settings JSON>'] [--risk h.bin p.bin] [--form form.json] [--payout p] [--cfg '<choices>' cfg.json]");
  process.exit(2);
}
const read = (p) => C.readProjections(readFileSync(p, "utf8"));
const form = formPath ? JSON.parse(readFileSync(formPath, "utf8")) : null;
const s0 = { ...settingsFrom(C, form), ...JSON.parse(extra || "{}") };
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const s = { ...s0, hitters: total(s0.slots), pitchers: total(s0.pitcherSlots) };
const choices = cfg ? JSON.parse(cfg[0]) : {};
const rs = draftRisk(riskSettingsFrom(form), { ...choices, ...(payout ? { payout } : {}) });
const H = C.prepHitters(read(hPath), s.pool, s.includeFa);
const P = C.prepPitchers(read(pPath), s.pool, s.includeFa);
const files = risk ? { h: R.parseRiskFile(readFileSync(risk[0])), p: R.parseRiskFile(readFileSync(risk[1])) } : null;
const t0 = Date.now();
const { table, warnings } = buildTable(C, R, H, P, s, files, rs);
writeFileSync(outPath, JSON.stringify(table));
if (cfg) writeFileSync(cfg[1], JSON.stringify(sessionConfig(choices, s, rs)));
console.log(`${table.players.length} players${table.risk ? ", with the risk-aware $" : ""}, calc.js${files ? " + risk.js" : ""} ${Date.now() - t0} ms -> ${outPath}`);
for (const w of warnings) console.log("  " + w);
