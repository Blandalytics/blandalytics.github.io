"""Build blandalytics.com/park-factors/ from park_factors_2027.csv.

The CSV holds every leaderboard row (level x batter side x venue) with the date the
factors were generated; the page inlines it, so it makes no data requests.
Usage:
  python tools/park_factors/build_leaderboard.py                 # page from the CSV
  python tools/park_factors/build_leaderboard.py --from-md X.md  # rewrite the CSV from the park
      model's handoff markdown (every table in its section 10), then build the page
"""
import argparse
import csv
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
CSV = HERE / "park_factors_2027.csv"
OUT = ROOT / "park-factors" / "index.html"

TEXT_COLS = {"Level", "Side", "League", "Team", "Org", "Venue", "As Of"}


def parse_md(md):
    """Leaderboard rows from the handoff markdown, as dicts in CSV column order."""
    generated = re.search(r"Generated (\d{4}-\d{2}-\d{2})", md).group(1)
    sec = md[md.index("## 10."):]
    rows, cur, hdr = [], None, None
    for line in sec.splitlines():
        m = re.match(r"### (\S+), batter side (\w+)", line)
        if m:
            cur, hdr = m.groups(), None
            continue
        if not (cur and line.startswith("|")):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells[0] == "Rk.":
            hdr = cells
            continue
        if set(cells[0]) <= {"-"}:
            continue
        rec = dict(zip(hdr, cells))
        del rec["Rk."]
        rows.append({"Level": cur[0], "Side": cur[1], **rec, "As Of": generated})
    return rows


def load(path=CSV):
    """(columns, rows) from the CSV, numbers as ints; the As Of column comes back separately."""
    with open(path, newline="", encoding="utf-8") as f:
        recs = list(csv.DictReader(f))
    cols = [c for c in recs[0] if c != "As Of"]
    rows = [[r[c] if c in TEXT_COLS else int(r[c]) for c in cols] for r in recs]
    return cols, rows, recs[0]["As Of"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-md", help="park model handoff markdown to rewrite the CSV from")
    args = ap.parse_args()
    if args.from_md:
        recs = parse_md(Path(args.from_md).read_text(encoding="utf-8"))
        with open(CSV, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(recs[0]))
            w.writeheader()
            w.writerows(recs)
        print(f"{len(recs)} rows -> {CSV}")
    cols, rows, as_of = load()
    data = json.dumps({"cols": cols, "rows": rows}, separators=(",", ":"))
    html = TEMPLATE.replace("__DATA__", data).replace("__GENERATED__", as_of)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"{len(rows)} rows -> {OUT}")


TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Park Factors · Blandalytics</title>
<meta name="description" content="2027 park factors for MLB and MiLB parks, by batter side: wOBA, runs, hits by type, walks, strikeouts and contact, adjusted for batter and pitcher.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root{
  --ground:#0d1117; --surface:#151b23; --raise:#1b222c;
  --ink:#e3e9f1; --muted:#8a96a6; --faint:#6b7684; --rule:#242c37;
  --accent:#6cb4ff; --good:#7bd88f; --bad:#ff8a80; --warn:#ffd166;
}
*{box-sizing:border-box}
body{margin:0; min-height:100vh; background:var(--ground); color:var(--ink);
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:15px; line-height:1.45;
  -webkit-font-smoothing:antialiased; padding:24px 16px}
main{max-width:1320px; margin:0 auto; display:flex; flex-direction:column; gap:18px}
header{max-width:860px}
h1{margin:0; font-size:30px; font-weight:700; letter-spacing:-.02em; line-height:1.1}
p{margin:0}
.tag{margin:6px 0 0; color:var(--muted); font-size:14px}
a{color:var(--accent)}
a.home{color:var(--muted); text-decoration:none; font-size:14px}
a.home:hover{color:var(--ink)}
.card{background:var(--surface); border:1px solid var(--rule); border-radius:8px; padding:16px 18px}
.controls{display:grid; grid-template-columns:auto repeat(4,minmax(110px,1fr)) auto; gap:12px 14px; align-items:end}
@media (max-width:900px){.controls{grid-template-columns:1fr 1fr} .controls .side,.controls .qual{grid-column:1 / -1}}
label,.field{display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted)}
label b,.field b{color:var(--ink); font-weight:500}
input,select,button{font:inherit; color:var(--ink)}
select{background:var(--ground); border:1px solid var(--rule); border-radius:6px; padding:7px 9px; width:100%}
select:focus,button:focus-visible,input:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.seg{display:inline-flex; align-self:flex-start; border:1px solid var(--rule); border-radius:6px; overflow:hidden; background:var(--ground)}
.seg button{background:transparent; border:0; padding:7px 14px; cursor:pointer; color:var(--muted)}
.seg button + button{border-left:1px solid var(--rule)}
.seg button[aria-pressed=true]{background:var(--accent); color:#0b1320; font-weight:600}
.seg button:hover:not([aria-pressed=true]){color:var(--ink); background:var(--raise)}
.check{flex-direction:row; align-items:center; gap:8px; padding-bottom:8px; white-space:nowrap}
.check input{accent-color:var(--accent); width:16px; height:16px; margin:0}
.row{display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center; justify-content:space-between}
.status{color:var(--muted); font-size:13px}
.legend{display:flex; align-items:center; gap:8px; color:var(--muted); font-size:12px}
.legend .bar{width:160px; height:10px; border-radius:3px; border:1px solid var(--rule)}
.legend .tick{font-family:"JetBrains Mono",monospace; font-size:11px}
button.reset{background:var(--raise); border:1px solid var(--rule); border-radius:6px; padding:5px 10px; cursor:pointer; font-size:13px}
button.reset:hover{border-color:var(--faint)}

.tablewrap{overflow:auto; max-height:calc(100vh - 120px); border:1px solid var(--rule); border-radius:8px; background:var(--surface)}
table{border-collapse:separate; border-spacing:0; width:100%; font-size:13px}
th,td{padding:6px 8px; border-bottom:1px solid var(--rule); white-space:nowrap}
thead th{position:sticky; top:0; z-index:2; background:var(--raise); color:var(--muted); font-weight:600; font-size:12px;
  text-align:right; cursor:pointer; user-select:none}
thead th.txt{text-align:left}
thead th:hover{color:var(--ink)}
thead th[aria-sort=descending]::after{content:" ▾"; color:var(--accent)}
thead th[aria-sort=ascending]::after{content:" ▴"; color:var(--accent)}
td{text-align:right; font-family:"JetBrains Mono",monospace; font-variant-numeric:tabular-nums}
td.txt{text-align:left; font-family:inherit}
td.rk{color:var(--faint)}
td.venue{font-weight:500}
th.venue,td.venue{position:sticky; left:0; z-index:1; background:var(--surface); border-right:1px solid var(--rule)}
thead th.venue{z-index:3; background:var(--raise)}
td.stat{color:var(--ink)}
td.pf{font-weight:600}
td.dim{color:var(--muted)}
th.sep,td.sep{border-left:1px solid var(--rule)}
tbody tr:hover td{box-shadow:inset 0 0 0 999px rgba(255,255,255,.04)}
tbody tr:hover td.venue{background:#1a212a}
.empty td{text-align:center; color:var(--muted); padding:28px; font-family:inherit}

details summary{cursor:pointer; color:var(--ink); font-weight:600}
.method{display:flex; flex-direction:column; gap:10px; margin-top:12px; color:var(--muted); font-size:14px}
.method b{color:var(--ink); font-weight:600}
code{font-family:"JetBrains Mono",monospace; font-size:12.5px; background:var(--ground); border:1px solid var(--rule); border-radius:4px; padding:0 4px; color:var(--ink)}
</style>
</head>
<body>
<main>
  <header>
    <a class="home" href="/">← Blandalytics</a>
    <h1>Park Factors</h1>
    <p class="tag">How much each MLB and MiLB park helps or hurts hitters, by batter side, for 2027. 100 is the level's average park; every factor is the full park effect (not halved), adjusted for who batted and pitched there.</p>
  </header>

  <section class="card">
    <div class="controls">
      <div class="field side"><b>Batter side</b>
        <div class="seg" id="side" role="group" aria-label="Batter side">
          <button type="button" data-v="All" aria-pressed="true">All</button>
          <button type="button" data-v="L" aria-pressed="false">LHB</button>
          <button type="button" data-v="R" aria-pressed="false">RHB</button>
        </div>
      </div>
      <label><b>Level</b><select id="level"></select></label>
      <label><b>League</b><select id="league"></select></label>
      <label><b>Team</b><select id="team"></select></label>
      <label><b>Org</b><select id="org"></select></label>
      <label class="check qual"><input id="qual" type="checkbox" checked><span id="qual_label">Qualified parks</span></label>
    </div>
  </section>

  <div class="row">
    <span id="status" class="status"></span>
    <div class="row" style="gap:14px">
      <div class="legend" aria-hidden="true">
        <span>Worse for hitters</span><span class="tick">90</span><span class="bar" id="legend_bar"></span><span class="tick">110</span><span>Better</span>
      </div>
      <button id="reset" class="reset" type="button">Reset filters</button>
    </div>
  </div>

  <div class="tablewrap">
    <table id="board">
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
  </div>

  <section class="card">
    <details>
      <summary>How it works</summary>
      <div class="method">
        <p><b>Scale:</b> 100 is the average park at that level. <b>Park Factor</b> is the wOBA index and <b>R</b> is runs (BaseRuns). The other columns are indexes for each outcome: <b>BACON</b> is hits per ball in contact (home runs included), <b>wOBACon</b> is wOBA on contact, and <b>HR p10 / p90</b> bound the 80% interval of the HR index.</p>
        <p><b>Colors:</b> centered on 100 and saturated at 90 and 110. Red helps hitters and blue hurts them, so for <b>SO</b> the scale is flipped: more strikeouts shade blue.</p>
        <p><b>Model:</b> one joint Bayesian fit of every plate appearance (MLB 2015–26; AAA, AA, A+ and A 2021–26) with batter, pitcher, league-season, home-field and platoon terms, a per-venue factor that drifts across seasons (with breaks for known dimension changes) and a per-venue left/right split. A venue is shared across levels, so a park's minor-league years inform its MLB factor.</p>
        <p><b>Games:</b> MLB rows use the 2027 schedule (games at the venue that season, neutral sites included); MiLB rows use the 2026 parks. <b>Qualified parks</b> hides venues with 50 or fewer games, pro-rated to each level's home schedule: <span id="thresholds"></span>. <b>PA</b> is the venue's plate appearances at that level in the data.</p>
        <p><b>All levels:</b> every row is still indexed to its own level's average, so a 105 in AA and a 105 in MLB are each 5% above their level, not equal environments. Picking an <b>Org</b> switches to All levels to show the whole system; pick a level after that to narrow it.</p>
        <p>Factors as of __GENERATED__.</p>
      </div>
    </details>
  </section>
</main>
<script>
const DATA = __DATA__;

const LEVELS = ["MLB", "AAA", "AA", "A+", "A"];
// home games in a full season at each level; the qualifying cutoff is 50 of MLB's 81, pro-rated
const HOME_GAMES = {"MLB": 81, "AAA": 75, "AA": 69, "A+": 66, "A": 66};
const MIN_GAMES = lv => 50 * HOME_GAMES[lv] / 81;
const SIDE_LABEL = {All: "all batters", L: "left-handed batters", R: "right-handed batters"};
const LOWER_BETTER = new Set(["SO"]);
const COLORED = ["Park Factor", "R", "OBP", "H", "1B", "2B", "3B", "HR", "BB", "SO", "HBP", "BACON", "wOBACon", "HR p10", "HR p90"];
const TIPS = {
  "Park Factor": "wOBA index", "R": "Runs (BaseRuns) index", "OBP": "On-base index", "H": "Hits index",
  "BB": "Walk index", "SO": "Strikeout index (higher = worse for hitters)", "HBP": "Hit-by-pitch index",
  "BACON": "Hits per contact, HR included", "wOBACon": "wOBA on contact",
  "HR p10": "HR index, 10th percentile", "HR p90": "HR index, 90th percentile",
  "Level": "Each row is indexed to its own level's average",
  "Games": "Games at the venue (MLB: 2027 schedule; MiLB: 2026)", "PA": "PAs at the venue and level in the data"
};
// the Level column only shows on All levels
const showCols = () => ["Rk.", ...(state.level ? [] : ["Level"]), "League", "Team", "Org", "Venue", "Games", ...COLORED, "PA"];
const TXT = new Set(["Level", "League", "Team", "Org", "Venue"]);

const ci = Object.fromEntries(DATA.cols.map((c, i) => [c, i]));
const DEFAULTS = {side: "All", level: "MLB", league: "", team: "", org: "", qual: true, sort: "Park Factor", dir: -1};
const state = {...DEFAULTS};

// diverging scale on the dark surface: blue (worse) – surface – red (better), clipped at 90/110
const SURF = [21, 27, 35], RED = [214, 72, 66], BLUE = [58, 116, 214];
function shade(v, col) {
  let t = Math.max(-1, Math.min(1, (v - 100) / 10));
  if (LOWER_BETTER.has(col)) t = -t;
  const to = t >= 0 ? RED : BLUE, a = Math.abs(t) * 0.9;
  return `rgb(${SURF.map((s, i) => Math.round(s + (to[i] - s) * a)).join(",")})`;
}
document.getElementById("legend_bar").style.background =
  `linear-gradient(90deg, ${[90, 95, 100, 105, 110].map(v => shade(v, "")).join(",")})`;

const $ = id => document.getElementById(id);
const uniq = a => [...new Set(a)].sort((x, y) => x.localeCompare(y));
function fill(sel, values, allLabel, keep) {
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option>${esc(v)}</option>`).join("");
  sel.value = values.includes(keep) ? keep : "";
  return sel.value;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]); }

$("level").innerHTML = `<option value="">All levels</option>` + LEVELS.map(l => `<option>${l}</option>`).join("");
fill($("org"), uniq(DATA.rows.map(r => r[ci.Org])), "All orgs", "");
$("thresholds").textContent = LEVELS.map(l => `${l} more than ${+MIN_GAMES(l).toFixed(1)} (of ${HOME_GAMES[l]} home)`).join(", ");

// leagues in level order (MLB, IL, PCL, EL, …), teams alphabetically within the level, league and org
function refreshOptions() {
  const lv = DATA.rows.filter(r => (!state.level || r[ci.Level] === state.level) && r[ci.Side] === "All");
  const leagues = LEVELS.flatMap(l => uniq(lv.filter(r => r[ci.Level] === l).map(r => r[ci.League])));
  state.league = fill($("league"), [...new Set(leagues)], "All leagues", state.league);
  const inLeague = lv.filter(r => (!state.league || r[ci.League] === state.league) && (!state.org || r[ci.Org] === state.org));
  state.team = fill($("team"), uniq(inLeague.map(r => r[ci.Team])), "All teams", state.team);
}

function head() {
  $("head").innerHTML = showCols().map(c => {
    const cls = [TXT.has(c) ? "txt" : "", c === "Venue" ? "venue" : "", c === "Park Factor" ? "sep" : "", c === "PA" ? "sep" : ""].join(" ").trim();
    const sort = c === state.sort ? (state.dir < 0 ? "descending" : "ascending") : "none";
    return `<th scope="col" data-c="${esc(c)}" class="${cls}" aria-sort="${sort}" title="${esc(TIPS[c] || "")}">${esc(c)}</th>`;
  }).join("");
}

function render() {
  const SHOW = showCols();
  $("qual_label").textContent = state.level
    ? `Qualified parks (more than ${+MIN_GAMES(state.level).toFixed(1)} games)`
    : "Qualified parks (more than 50 games, pro-rated by level)";
  const rows = DATA.rows.filter(r =>
    r[ci.Side] === state.side && (!state.level || r[ci.Level] === state.level) &&
    (!state.league || r[ci.League] === state.league) &&
    (!state.team || r[ci.Team] === state.team) &&
    (!state.org || r[ci.Org] === state.org) &&
    (!state.qual || r[ci.Games] > MIN_GAMES(r[ci.Level])));
  const k = state.sort === "Rk." ? ci["Park Factor"] : ci[state.sort], d = state.sort === "Rk." ? -state.dir : state.dir;
  rows.sort((a, b) => {
    const x = k === ci.Level ? LEVELS.indexOf(a[k]) : a[k], y = k === ci.Level ? LEVELS.indexOf(b[k]) : b[k];
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return c * d || b[ci["Park Factor"]] - a[ci["Park Factor"]] || b[ci.PA] - a[ci.PA];
  });
  head();
  $("body").innerHTML = rows.length ? rows.map((r, i) => "<tr>" + SHOW.map(c => {
    if (c === "Rk.") return `<td class="rk">${i + 1}</td>`;
    const v = r[ci[c]];
    if (TXT.has(c)) return `<td class="txt${c === "Venue" ? " venue" : ""}">${esc(v)}</td>`;
    if (COLORED.includes(c)) return `<td class="stat${c === "Park Factor" ? " pf sep" : ""}" style="background:${shade(v, c)}">${v}</td>`;
    return `<td class="dim${c === "PA" ? " sep" : ""}">${v.toLocaleString()}</td>`;
  }).join("") + "</tr>").join("")
    : `<tr class="empty"><td colspan="${SHOW.length}">No parks match these filters${state.qual ? " — try turning off Qualified parks" : ""}.</td></tr>`;
  $("status").textContent = state.level
    ? `${rows.length} ${state.level} park${rows.length === 1 ? "" : "s"}, ${SIDE_LABEL[state.side]}`
    : `${rows.length} park${rows.length === 1 ? "" : "s"} across all levels, ${SIDE_LABEL[state.side]} (each indexed to its own level)`;
  document.querySelectorAll("#side button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.side));
  $("level").value = state.level; $("org").value = state.org; $("qual").checked = state.qual;
}

$("side").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { state.side = b.dataset.v; render(); } });
$("level").addEventListener("change", e => { state.level = e.target.value; state.league = state.team = ""; refreshOptions(); render(); });
$("league").addEventListener("change", e => { state.league = e.target.value; refreshOptions(); render(); });
$("team").addEventListener("change", e => { state.team = e.target.value; render(); });
// picking an org shows its whole system: every level at once
$("org").addEventListener("change", e => {
  state.org = e.target.value;
  if (state.org) state.level = "";
  refreshOptions(); render();
});
$("qual").addEventListener("change", e => { state.qual = e.target.checked; render(); });
$("reset").addEventListener("click", () => { Object.assign(state, DEFAULTS); refreshOptions(); render(); });
$("head").addEventListener("click", e => {
  const th = e.target.closest("th"); if (!th) return;
  const c = th.dataset.c;
  if (c === state.sort) state.dir = -state.dir;
  else { state.sort = c; state.dir = TXT.has(c) || c === "Rk." ? 1 : -1; }
  render();
});

refreshOptions();
render();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
