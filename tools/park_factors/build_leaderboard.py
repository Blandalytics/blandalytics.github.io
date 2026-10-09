"""Build blandalytics.com/park-factors/ from park_factors_2027.csv.

park_factors_2027.csv holds the current board (level x batter side x venue) with the date the
factors were generated: each level's most recent year, MLB 2027 (on the 2027 schedule) and the
minors 2026. park_factors_history.csv (from build_history.py) adds every earlier season, all
batters. The page inlines both, so it makes no data requests.
Usage:
  python tools/park_factors/build_leaderboard.py                 # page from the CSV
  python tools/park_factors/build_leaderboard.py --from-md X.md  # rewrite the CSV from the park
      model's handoff markdown (every table in its section 10), then build the page
"""
import argparse
import csv
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
CSV = HERE / "park_factors_2027.csv"
HIST = HERE / "park_factors_history.csv"
OUT = ROOT / "park-factors" / "index.html"

TEXT_COLS = {"Level", "Side", "League", "Team", "Org", "Venue", "As Of"}
SHOW_AS = {"H": "AVG", "SO": "K"}  # page names for the model's columns
# each level's most recent year is the current board's; earlier seasons come from the history
LATEST = {"MLB": 2027, "AAA": 2026, "AA": 2026, "A+": 2026, "A": 2026}
HOME_GAMES = {"MLB": 81, "AAA": 75, "AA": 69, "A+": 66, "A": 66}  # a full season's home games
# parks with a new name for 2027, applied to the board's MLB rows (the 2027 season); earlier
# seasons keep the name they had then
NAMES_2027 = {"Comerica Park": "Fifth Third Park"}


def parse_md(md):
    """Leaderboard rows from the handoff markdown, as dicts in CSV column order."""
    generated = re.search(r"Generated (\d{4}-\d{2}-\d{2})", md).group(1)
    sec = md[md.index("## 10."):]
    sec = sec[:sec.index("\n## 11.")] if "\n## 11." in sec else sec
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
    recs = [{**r, "Venue": NAMES_2027.get(r["Venue"], r["Venue"])} if r["Level"] == "MLB" else r for r in recs]
    cols = [c for c in recs[0] if c != "As Of"]
    rows = [[r[c] if c in TEXT_COLS else int(r[c]) for c in cols] for r in recs]
    return cols, rows, recs[0]["As Of"]


def load_history(cols, path=HIST):
    """Seasons before each level's most recent year (all batters), in the page's column order."""
    with open(path, newline="", encoding="utf-8") as f:
        recs = [r for r in csv.DictReader(f) if int(r["Year"]) < LATEST[r["Level"]]]
    return [[{**r, "Side": "All"}[c] if c in TEXT_COLS else int(r[c]) for c in cols] for r in recs]


def min_games(cols, rows):
    """The qualifying cutoff by level and year: more than 50 of MLB's 81 home games, pro-rated to
    the level's home schedule. Past seasons take theirs from the median games per venue, so the
    short ones (MLB 2020, the minors' 2021) scale down."""
    li, yi, gi = cols.index("Level"), cols.index("Year"), cols.index("Games")
    games = defaultdict(list)
    for r in rows:
        games[(r[li], r[yi])].append(r[gi])
    out = defaultdict(dict)
    for (lv, yr), g in sorted(games.items()):
        full = HOME_GAMES[lv] if yr == LATEST[lv] else statistics.median(g)
        out[lv][yr] = round(50 * full / 81, 1)
    return out


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
    cols = ["Level", "Year"] + cols[1:]
    rows = [[r[0], LATEST[r[0]]] + r[1:] for r in rows] + load_history(cols)
    mins = min_games(cols, rows)
    cols = [SHOW_AS.get(c, c) for c in cols]
    renamed = {new: f"{old} through 2026" for old, new in NAMES_2027.items()}
    data = json.dumps({"cols": cols, "rows": rows, "latest": LATEST, "minGames": mins, "renamed": renamed},
                      separators=(",", ":"))
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
<title>Park Factors</title>
<meta name="description" content="Park factors for MLB and MiLB parks, by batter side: wOBA, runs, hits by type, walks, strikeouts and contact quality, adjusted for batter and pitcher.">
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
.controls{display:grid; grid-template-columns:auto repeat(5,minmax(100px,1fr)) auto; gap:12px 14px; align-items:end}
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
.seg button:hover:not([aria-pressed=true]):not(:disabled){color:var(--ink); background:var(--raise)}
.seg button:disabled{opacity:.4; cursor:default}
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
    <h1>Park Factors</h1>
    <p class="tag">How each park affects outcomes going into 2027. 100 is the level's average park, and a factor above 100 shows the park increases that result. Stats are color-coded for how they benefit a hitter (Red = better for the hitter). Every factor uses observed results, adjusted for who batted and pitched there.</p>
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
      <label><b>Year</b><select id="year"></select></label>
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
      <button id="copy" class="reset" type="button">Copy link</button>
      <button id="csv" class="reset" type="button">Download CSV</button>
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
        <p><b>Scale:</b> 100 is the average park at that level. <b>Park Factor</b> is the wOBA index and <b>R</b> is runs (<a href="https://en.wikipedia.org/wiki/Base_runs">BaseRuns</a>). The other columns are indexes for each outcome: <b>BACON</b> is Batting Average on CONtact (home runs included), <b>wOBACon</b> is wOBA on Contact, and <b>HR p10 / p90</b> factors provide an 80% Confidence Interval for the park's HR true factor. The spread is wider for newer parks or those with recent renovations (Ex: <a href="https://www.mlb.com/news/royals-moving-outfield-walls-at-kauffman-stadium">Kauffman Stadium</a> in 2026).</p>
        <p><b>Colors:</b> centered on 100 and saturated at 90 and 110. Red helps hitters and blue hurts them, so for <b>K</b> the scale is flipped: more strikeouts shade blue.</p>
        <p><b>Model:</b> one joint Bayesian fit of every plate appearance (MLB 2015–26; AAA, AA, A+ and A 2021–26) with batter, pitcher, league-season, home-field and platoon terms, a per-venue factor that drifts across seasons (with breaks for known dimension changes) and a per-venue left/right split. If a park is used across multiple leagues (Ex: Sutter Health Park has hosted both AAA and MLB games), the data from all leagues informs that park factor.</p>
        <p><b>Games:</b> MLB 2027 rows use the 2027 schedule (games at the venue that season, neutral sites included); every other year counts the venue's completed regular-season games that season. <b>Qualified parks</b> hides venues with 50 or fewer games, pro-rated to each level's home schedule, so shortened seasons scale down: <span id="thresholds"></span>. <b>PA</b> is the venue's plate appearances at that level in the data: that season's for past years, and every season's for each level's most recent year.</p>
        <p><b>All levels:</b> every row is still indexed to its own level's average, so a 105 in AA and a 105 in MLB are each 5% above their level, not equal environments. Picking an <b>Org</b> switches to All levels to show the whole system; pick a level after that to narrow it.</p>
        <p><b>Years:</b> each level opens on its most recent year: 2027 for MLB, built on the 2027 schedule, and 2026 for the minors. Earlier seasons (MLB from 2015, the minors from 2021) come from the same fit, indexed to that season's average park at that level, for all batters; the LHB/RHB split covers each level's most recent year. Venue names, teams, leagues and orgs are as they were that season, from MLB's StatsAPI, with 2021's interim minor-league names shown as the leagues' current ones (Triple-A East as IL, and so on). MLB 2027 uses the names parks carry in 2027, so Comerica Park appears as Fifth Third Park. <b>All years</b> lists every season at once, one row per park and season; with a Team or Org picked, it follows a park through the years.</p>
        <p>Factors as of __GENERATED__.</p>
      </div>
    </details>
  </section>
</main>
<script>
const DATA = __DATA__;

const LEVELS = ["MLB", "AAA", "AA", "A+", "A"];
// the qualifying cutoff by level and year (50 of MLB's 81 home games, pro-rated; short seasons scale down)
const minGames = (lv, yr) => DATA.minGames[lv][yr];
// the year on screen for a level: the one picked, else the level's most recent; "all" is every year
const ALL = "all";
const yearOf = lv => state.year && state.year !== ALL ? +state.year : DATA.latest[lv];
const yearOk = r => state.year === ALL || r[ci.Year] === yearOf(r[ci.Level]);
const SIDE_LABEL = {All: "all batters", L: "left-handed batters", R: "right-handed batters"};
const LOWER_BETTER = new Set(["K"]);
const COLORED = ["Park Factor", "R", "OBP", "AVG", "1B", "2B", "3B", "HR", "BB", "K", "HBP", "BACON", "wOBACon", "HR p10", "HR p90"];
const TIPS = {
  "Park Factor": "wOBA factor", "R": "Runs (BaseRuns) factor", "OBP": "On-base factor", "AVG": "Batting average factor",
  "BB": "Walk factor", "K": "Strikeout factor (higher = worse for hitters)", "HBP": "Hit-by-pitch factor",
  "BACON": "Batting average on contact", "wOBACon": "wOBA on contact",
  "HR p10": "HR index, 10th percentile", "HR p90": "HR index, 90th percentile",
  "Level": "Each row is indexed to its own level's average", "Year": "Each level's most recent year: MLB 2027, the minors 2026",
  "Games": "Games at the venue (MLB 2027: the 2027 schedule; other years: completed games that season)",
  "PA": "PAs at the venue and level (past years: that season's; most recent year: every season's)"
};
// the Level column only shows on All levels, and Year on All years or when All levels mixes the
// levels' most recent years
const showCols = () => ["Rk.", ...(state.level ? [] : ["Level"]),
  ...(state.year === ALL || !(state.level || state.year) ? ["Year"] : []), "League", "Team", "Org", "Venue", "Games", ...COLORED, "PA"];
const TXT = new Set(["Level", "League", "Team", "Org", "Venue"]);

const ci = Object.fromEntries(DATA.cols.map((c, i) => [c, i]));
const DEFAULTS = {side: "All", level: "MLB", year: "", league: "", team: "", org: "", qual: true, sort: "Park Factor", dir: -1};
const state = {...DEFAULTS};
let shown = [];  // the rows on screen, in order, for the CSV download

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
  values = values.filter(v => v !== "");
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option>${esc(v)}</option>`).join("");
  sel.value = values.includes(keep) ? keep : "";
  return sel.value;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]); }

$("level").innerHTML = `<option value="">All levels</option>` + LEVELS.map(l => `<option>${l}</option>`).join("");
const ORGS = uniq(DATA.rows.map(r => r[ci.Org]));
fill($("org"), ORGS, "All orgs", "");
$("thresholds").textContent = LEVELS.map(l => `${l} ${DATA.latest[l]} more than ${minGames(l, DATA.latest[l])}`).join(", ") +
  `; for example MLB 2020 more than ${minGames("MLB", 2020)} and AAA 2021 more than ${minGames("AAA", 2021)}`;

// years newest first ("" is the level's most recent); leagues in level order (MLB, IL, PCL, EL, …);
// teams alphabetically within the level, year, league and org
function refreshOptions() {
  const atLevel = DATA.rows.filter(r => (!state.level || r[ci.Level] === state.level) && r[ci.Side] === "All");
  const newest = state.level ? DATA.latest[state.level] : null;
  const years = [...new Set(atLevel.map(r => r[ci.Year]))].sort((a, b) => b - a).filter(y => y !== newest).map(String);
  $("year").innerHTML = `<option value="">${newest || "Most recent"}</option><option value="${ALL}">All years</option>` +
    years.map(y => `<option>${y}</option>`).join("");
  if (state.year !== ALL && !years.includes(state.year)) state.year = "";
  $("year").value = state.year;
  const lv = atLevel.filter(yearOk);
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
  // batter-side splits only exist for each level's most recent year, so not on All years
  const splits = state.year !== ALL && DATA.rows.some(r => r[ci.Side] !== "All" && (!state.level || r[ci.Level] === state.level) && yearOk(r));
  if (!splits) state.side = "All";
  document.querySelectorAll("#side button").forEach(b => {
    b.disabled = !splits && b.dataset.v !== "All";
    b.title = b.disabled ? "Batter-side splits cover each level's most recent year" : "";
  });
  const SHOW = showCols();
  $("qual_label").textContent = state.level && state.year !== ALL
    ? `Qualified parks (more than ${minGames(state.level, yearOf(state.level))} games)`
    : `Qualified parks (more than 50 games, pro-rated by ${state.level ? "season" : "level and season"})`;
  const rows = DATA.rows.filter(r =>
    r[ci.Side] === state.side && (!state.level || r[ci.Level] === state.level) && yearOk(r) &&
    (!state.league || r[ci.League] === state.league) &&
    (!state.team || r[ci.Team] === state.team) &&
    (!state.org || r[ci.Org] === state.org) &&
    (!state.qual || r[ci.Games] > minGames(r[ci.Level], r[ci.Year])));
  const k = state.sort === "Rk." ? ci["Park Factor"] : ci[state.sort], d = state.sort === "Rk." ? -state.dir : state.dir;
  rows.sort((a, b) => {
    const x = k === ci.Level ? LEVELS.indexOf(a[k]) : a[k], y = k === ci.Level ? LEVELS.indexOf(b[k]) : b[k];
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return c * d || b[ci["Park Factor"]] - a[ci["Park Factor"]] || b[ci.Year] - a[ci.Year] || b[ci.PA] - a[ci.PA];
  });
  shown = rows;
  head();
  $("body").innerHTML = rows.length ? rows.map((r, i) => "<tr>" + SHOW.map(c => {
    if (c === "Rk.") return `<td class="rk">${i + 1}</td>`;
    const v = r[ci[c]];
    const was = c === "Venue" && DATA.renamed[v];  // a park renamed for 2027
    if (TXT.has(c)) return `<td class="txt${c === "Venue" ? " venue" : ""}"${was ? ` title="${esc(was)}"` : ""}>${esc(v)}</td>`;
    if (COLORED.includes(c)) return `<td class="stat${c === "Park Factor" ? " pf sep" : ""}" style="background:${shade(v, c)}">${v}</td>`;
    return `<td class="dim${c === "PA" ? " sep" : ""}">${c === "Year" ? v : v.toLocaleString()}</td>`;
  }).join("") + "</tr>").join("")
    : `<tr class="empty"><td colspan="${SHOW.length}">No parks match these filters${state.qual ? " — try turning off Qualified parks" : ""}.</td></tr>`;
  const n = rows.length, unit = (state.year === ALL ? "park season" : "park") + (n === 1 ? "" : "s");
  const years = rows.map(r => r[ci.Year]);
  const when = state.year === ALL ? (n ? `, ${Math.min(...years)}–${Math.max(...years)}` : "")
    : state.level ? ` in ${yearOf(state.level)}` : state.year ? ` in ${state.year}` : " in each level's most recent year";
  $("status").textContent = state.level
    ? `${n} ${state.level} ${unit}${when}, ${SIDE_LABEL[state.side]}`
    : `${n} ${unit} across all levels${when}, ${SIDE_LABEL[state.side]} (each indexed to its own level)`;
  document.querySelectorAll("#side button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.side));
  $("level").value = state.level; $("year").value = state.year; $("org").value = state.org; $("qual").checked = state.qual;
  const h = toHash();
  if (location.hash.slice(1) !== h) {
    try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch (e) {}
  }
}

// the filters live in the link hash (#org=SEA&side=L&sort=HR…), defaults left out;
// with an org picked, All levels is the default level
const levelDefault = () => state.org ? "" : "MLB";
function toHash() {
  const p = new URLSearchParams();
  if (state.side !== DEFAULTS.side) p.set("side", state.side);
  if (state.level !== levelDefault()) p.set("level", state.level || "all");
  if (state.year) p.set("year", state.year);
  for (const k of ["league", "team", "org"]) if (state[k]) p.set(k, state[k]);
  if (!state.qual) p.set("qual", "0");
  if (state.sort !== DEFAULTS.sort || state.dir !== DEFAULTS.dir) {
    p.set("sort", state.sort);
    p.set("dir", state.dir < 0 ? "desc" : "asc");
  }
  return p.toString();
}
function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, DEFAULTS);
  if (["L", "R"].includes(p.get("side"))) state.side = p.get("side");
  if (ORGS.includes(p.get("org"))) state.org = p.get("org");
  const lv = p.get("level");
  state.level = lv === "all" ? "" : LEVELS.includes(lv) ? lv : levelDefault();
  state.year = p.get("year") || "";  // "all", or a year; refreshOptions drops one the level doesn't have
  state.league = p.get("league") || "";  // refreshOptions drops a league or team that isn't there
  state.team = p.get("team") || "";
  if (p.get("qual") === "0") state.qual = false;
  if (showCols().includes(p.get("sort"))) {
    state.sort = p.get("sort");
    state.dir = p.get("dir") === "asc" ? 1 : -1;
  }
}

$("side").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { state.side = b.dataset.v; render(); } });
$("level").addEventListener("change", e => { state.level = e.target.value; state.league = state.team = ""; refreshOptions(); render(); });
$("year").addEventListener("change", e => { state.year = e.target.value; refreshOptions(); render(); });
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
// the Clipboard API where it's allowed, else the older select-and-copy
function copyText(text) {
  return navigator.clipboard.writeText(text).catch(() => {
    const ta = Object.assign(document.createElement("textarea"), {value: text});
    ta.style.cssText = "position:fixed; opacity:0";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove();
    if (!ok) throw new Error("copy failed");
  });
}
// the table as shown (filters and sort), with Level, Year and Side always included so the file says what it is
const CSV_COLS = ["Rk.", "Level", "Year", "Side", "League", "Team", "Org", "Venue", "Games", ...COLORED, "PA"];
const csvCell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
$("csv").addEventListener("click", () => {
  const lines = [CSV_COLS, ...shown.map((r, i) => CSV_COLS.map(c => c === "Rk." ? i + 1 : r[ci[c]]))];
  const text = lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const blob = new Blob(["\ufeff" + text], {type: "text/csv;charset=utf-8"});  // BOM so Excel reads UTF-8
  const year = state.year === ALL ? "all-years" : state.level ? yearOf(state.level) : state.year || "most-recent";
  const name = ["park_factors", year, state.level || "all-levels", state.org, state.league, state.team,
    state.side === "All" ? "" : state.side + "HB"].filter(Boolean).join("_").replace(/\+/g, "plus");
  const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(blob), download: name + ".csv"});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("copy").addEventListener("click", () => {
  copyText(location.href).then(() => "Copied", () => "Copy failed").then(t => {
    $("copy").textContent = t;
    setTimeout(() => { $("copy").textContent = "Copy link"; }, 1500);
  });
});
window.addEventListener("hashchange", () => { fromHash(); refreshOptions(); render(); });
$("head").addEventListener("click", e => {
  const th = e.target.closest("th"); if (!th) return;
  const c = th.dataset.c;
  if (c === state.sort) state.dir = -state.dir;
  else { state.sort = c; state.dir = TXT.has(c) || c === "Rk." ? 1 : -1; }
  render();
});

fromHash();
refreshOptions();
render();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
