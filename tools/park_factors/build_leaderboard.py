"""Build blandalytics.com/park-factors/ from park_factors_2027.csv.

park_factors_2027.csv holds the current board (level x batter side x venue) with the date the
factors were generated: each level's most recent year, MLB 2027 (on the 2027 schedule) and the
minors 2026. park_factors_history.csv (from build_history.py) adds every earlier season, all
batters. The page inlines both. The Seasonal view's data (park-factors/seasonal/<level>_<year>.json,
from build_seasonal.py) is fetched when that view opens on a level and year; the page lists which
years each level has.
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
SEASONAL = ROOT / "park-factors" / "seasonal"
OUT = ROOT / "park-factors" / "index.html"

TEXT_COLS = {"Level", "Side", "League", "Team", "Org", "Venue", "As Of"}
SHOW_AS = {"H": "AVG", "SO": "K"}  # page names for the model's columns
# each level's most recent year is the current board's; earlier seasons come from the history
LATEST = {"MLB": 2027, "AAA": 2026, "AA": 2026, "A+": 2026, "A": 2026}
HOME_GAMES = {"MLB": 81, "AAA": 75, "AA": 69, "A+": 66, "A": 66}  # a full season's home games
# parks with a new name for 2027, applied to the board's MLB rows (the 2027 season); earlier
# seasons keep the name they had then
NAMES_2027 = {"Comerica Park": "Fifth Third Park"}
# a venue with fewer games at a level that season than this share of a full home schedule there
# is a neutral site, no club's home (London Stadium, Tokyo Dome, Field of Dreams, Rickwood Field, …)
NEUTRAL_SHARE = 0.1
NEUTRAL = "League"  # their Team and Org


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
    with open(path, newline="", encoding="utf-8-sig") as f:
        recs = list(csv.DictReader(f))
    recs = [{**r, "Venue": NAMES_2027.get(r["Venue"], r["Venue"])} if r["Level"] == "MLB" else r for r in recs]
    cols = [c for c in recs[0] if c != "As Of"]
    rows = [[r[c] if c in TEXT_COLS else int(r[c]) for c in cols] for r in recs]
    return cols, rows, recs[0]["As Of"]


def load_history(cols, path=HIST):
    """Seasons before each level's most recent year (all batters), in the page's column order."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        recs = [r for r in csv.DictReader(f) if int(r["Year"]) < LATEST[r["Level"]]]
    return [[{**r, "Side": "All"}[c] if c in TEXT_COLS else int(r[c]) for c in cols] for r in recs]


def seasonal_years():
    """level -> the years with a Seasonal view file (build_seasonal.py)."""
    out = defaultdict(list)
    for f in sorted(SEASONAL.glob("*.json")):
        level, year = f.stem.rsplit("_", 1)
        out[level.replace("plus", "+")].append(int(year))
    return out


def full_schedule(cols, rows):
    """(level, year) -> a full season's home games: the level's schedule for its most recent year,
    else the median games per venue that season, so the short ones (MLB 2020, the minors' 2021)
    scale down."""
    li, yi, gi = cols.index("Level"), cols.index("Year"), cols.index("Games")
    games = defaultdict(list)
    for r in rows:
        games[(r[li], r[yi])].append(r[gi])
    return {(lv, yr): HOME_GAMES[lv] if yr == LATEST[lv] else statistics.median(g) for (lv, yr), g in games.items()}


def min_games(cols, rows):
    """The qualifying cutoff by level and year, in whole games: more than 50 of MLB's 81 home games,
    pro-rated to the level's full home schedule that season (full_schedule) and rounded to the
    nearest game, halves up (AAA 46 of 75, AA 43 of 69, A+ and A 41 of 66, MLB 2020 19)."""
    out = defaultdict(dict)
    for (lv, yr), full in sorted(full_schedule(cols, rows).items()):
        out[lv][yr] = int(50 * full / 81 + 0.5)
    return out


def neutral_sites(cols, rows):
    """Credit neutral sites to their level: a venue with fewer games at a level that season than
    NEUTRAL_SHARE of a full home schedule (full_schedule) is no club's home, so its Team and Org
    become NEUTRAL ("League") instead of the club that was home in those games. Returns the
    (level, year, venue) reclassified."""
    full = full_schedule(cols, rows)
    li, yi, gi, ti, oi, vi = (cols.index(c) for c in ("Level", "Year", "Games", "Team", "Org", "Venue"))
    out = set()
    for r in rows:
        if r[gi] < NEUTRAL_SHARE * full[(r[li], r[yi])]:
            r[ti] = r[oi] = NEUTRAL
            out.add((r[li], r[yi], r[vi]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-md", help="park model handoff markdown to rewrite the CSV from")
    args = ap.parse_args()
    if args.from_md:
        recs = parse_md(Path(args.from_md).read_text(encoding="utf-8"))
        with open(CSV, "w", newline="", encoding="utf-8-sig") as f:  # a BOM: Excel reads the accents
            w = csv.DictWriter(f, fieldnames=list(recs[0]))
            w.writeheader()
            w.writerows(recs)
        print(f"{len(recs)} rows -> {CSV}")
    cols, rows, as_of = load()
    cols = ["Level", "Year"] + cols[1:]
    rows = [[r[0], LATEST[r[0]]] + r[1:] for r in rows] + load_history(cols)
    mins = min_games(cols, rows)
    neutral = neutral_sites(cols, rows)
    print(f"{len(neutral)} neutral park seasons credited to {NEUTRAL}")
    cols = [SHOW_AS.get(c, c) for c in cols]
    renamed = {new: f"{old} through 2026" for old, new in NAMES_2027.items()}
    data = json.dumps({"cols": cols, "rows": rows, "latest": LATEST, "minGames": mins, "renamed": renamed,
                       "seasonal": seasonal_years()}, separators=(",", ":"))
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
.controls{display:grid; grid-template-columns:auto auto repeat(5,minmax(100px,1fr)) auto; gap:12px 14px; align-items:end}
@media (max-width:1280px){.controls{grid-template-columns:auto auto repeat(3,minmax(100px,1fr))}}
@media (max-width:900px){.controls{grid-template-columns:1fr 1fr} .controls .view,.controls .side,.controls .qual{grid-column:1 / -1}}
label,.field{display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted)}
label b,.field b{color:var(--ink); font-weight:500}
input,select,button{font:inherit; color:var(--ink)}
select{background:var(--ground); border:1px solid var(--rule); border-radius:6px; padding:7px 9px; width:100%}
select:focus,button:focus-visible,input:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
select:disabled{opacity:.45; cursor:default}
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
.seasonbar{display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:10px 18px; align-items:center;
  margin-top:14px; padding-top:14px; border-top:1px solid var(--rule)}
.seasonbar[hidden]{display:none}
@media (max-width:900px){.seasonbar{grid-template-columns:auto minmax(0,1fr)} .seasonbar .base{grid-column:1 / -1}}
button.play{width:38px; height:38px; border-radius:50%; border:1px solid var(--rule); background:var(--raise); cursor:pointer;
  font-size:13px; line-height:1; padding:0}
button.play:hover{border-color:var(--accent); color:var(--accent)}
.slider{display:flex; flex-direction:column; gap:2px; min-width:0}
.slider .now{display:flex; flex-wrap:wrap; justify-content:space-between; gap:2px 14px; font-size:13px; color:var(--muted)}
.slider .now b{color:var(--ink); font-weight:600; font-size:14px}
.slider input[type=range]{width:100%; margin:6px 0 2px; accent-color:var(--accent); cursor:pointer}
.months{position:relative; height:15px; font-size:11px; color:var(--faint); margin:0 8px}
.months span{position:absolute; transform:translateX(-50%); white-space:nowrap}
tr.league td{background:var(--raise); color:var(--muted); font-style:italic}
tr.league td.venue{background:var(--raise)}

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
      <div class="field view"><b>View</b>
        <div class="seg" id="view" role="group" aria-label="View">
          <button type="button" data-v="season" aria-pressed="true" title="Each park's factor for the whole season">Full season</button>
          <button type="button" data-v="seasonal" aria-pressed="false" title="Each level and year's parks week by week">Seasonal</button>
        </div>
      </div>
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
    <div class="seasonbar" id="seasonbar" hidden>
      <button type="button" id="play" class="play" aria-label="Play through the season" title="Play through the season">▶</button>
      <div class="slider">
        <div class="now"><span><b id="wk_label"></b></span><span id="lg_note"></span></div>
        <input type="range" id="week" min="0" step="1" aria-label="Week of the season">
        <div class="months" id="months" aria-hidden="true"></div>
      </div>
      <div class="field base"><b>Compared to</b>
        <div class="seg" id="base" role="group" aria-label="Compared to">
          <button type="button" data-v="season" aria-pressed="true" title="100 = the average park over the whole season: the league's own calendar (cold April, summer heat) is included">Season average</button>
          <button type="button" data-v="week" aria-pressed="false" title="100 = the average park that week: only the park's own seasonal pattern remains">Same week</button>
        </div>
      </div>
    </div>
  </section>

  <div class="row">
    <span id="status" class="status"></span>
    <div class="row" style="gap:14px">
      <div class="legend" aria-hidden="true">
        <span>Pitcher-Friendly</span><span class="bar" id="legend_bar"></span><span>Hitter-Friendly</span>
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
        <p><b>Neutral sites:</b> a park with fewer games at a level that season than a tenth of a home schedule is no club's home (London Stadium, Tokyo Dome, Estadio Alfredo Harp Helú, Field of Dreams, Rickwood Field, the Little League Classic in Williamsport, …), so its Team and Org show League instead. Pick League as the Team or Org to list them. With so few games, they are hidden while Qualified parks is on.</p>
        <p><b>Games:</b> MLB 2027 rows use the 2027 schedule (games at the venue that season, neutral sites included); every other year counts the venue's completed regular-season games that season. <b>Qualified parks</b> hides venues with 50 or fewer games, pro-rated to each level's home schedule, so shortened seasons scale down: <span id="thresholds"></span>. <b>PA</b> is the venue's plate appearances at that level in the data: that season's for past years, and every season's for each level's most recent year.</p>
        <p><b>Seasonal:</b> each level and year's parks week by week: MLB 2015–2027 (2027 on its schedule, the earlier seasons from the games played) and AAA, AA, A+ and A 2021–2026. They come from a second fit of the same model with two curves by date added: each level's own calendar (every park together: cold April air, summer heat, September call-ups) and each park's deviation from it (a curve for its roof type plus its own), one shape per park across all its seasons. Drag the slider or press ▶ to move through the season; switching the year keeps the same point in the calendar. <b>Compared to Season average</b> sets 100 at the level's average park over the whole season, so the factors carry the calendar too (MLB home runs run about 8% below average in early April): how the park played or will play that week. <b>Same week</b> sets 100 at that week's average park, which leaves only the park's own pattern (roofed parks such as American Family Field play relatively better in April, before the summer lift elsewhere). The <b>average</b> row is the league that week against its season average. The <a href="/league-factors/">League Factors</a> page charts it for every stat, next to what each week produced. Past seasons are all batters; each level's most recent year has the LHB/RHB split. Most parks move only a point or two over a season, home runs the most, so this view shows one decimal. A park's seasonal factors average out to about its Full season factor (the two fits can differ by a point).</p>
        <p><b>All levels:</b> every row is still indexed to its own level's average, so a 105 in AA and a 105 in MLB are each 5% above their level, not equal environments. Picking an <b>Org</b> switches to All levels to show the whole system; pick a level after that to narrow it.</p>
        <p><b>Years:</b> each level opens on its most recent year: 2027 for MLB, built on the 2027 schedule, and 2026 for the minors. Earlier seasons (MLB from 2015, the minors from 2021) come from the same fit, indexed to that season's average park at that level, for all batters; the LHB/RHB split covers each level's most recent year. Venue names, teams, leagues and orgs are as they were that season, from MLB's StatsAPI, with 2021's interim minor-league names shown as the leagues' current ones (Triple-A East as IL, and so on). <b>All years</b> lists every season at once, one row per park and season; with a Team or Org picked, it follows a park through the years.</p>
        <p>Factors as of __GENERATED__.</p>
      </div>
    </details>
  </section>
</main>
<script>
const DATA = __DATA__;

const LEVELS = ["MLB", "AAA", "AA", "A+", "A"];
// the qualifying cutoff by level and year, in whole games (50 of MLB's 81 home games, pro-rated and
// rounded to the nearest game; short seasons scale down)
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
// the Level column only shows on All levels, Year on All years or when All levels mixes the
// levels' most recent years, and Org off MLB (where it repeats Team)
const showCols = () => ["Rk.", ...(state.level ? [] : ["Level"]),
  ...(state.year === ALL || !(state.level || state.year) ? ["Year"] : []), "League", "Team",
  ...(state.level === "MLB" ? [] : ["Org"]), "Venue", "Games", ...COLORED, "PA"];
const TXT = new Set(["Level", "League", "Team", "Org", "Venue"]);

const ci = Object.fromEntries(DATA.cols.map((c, i) => [c, i]));
// the Seasonal view: one level and year's parks week by week, fetched the first time it is shown
// (seasonal/<level>_<year>.json: weeks [first "MM-DD", last, label]; cols; per side, each venue's
// index columns x 10 by week, 100 = the level's parks in use that week, and the league that week
// x 10 against its season average). DATA.seasonal lists the years each level has.
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TODAY = (d => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)(new Date());
const seasonalCache = new Map();  // "<level>_<year>" -> the data, "loading" or "failed"
function seasonalData() {
  const year = yearOf(state.level), key = `${state.level}_${year}`;
  if (!(DATA.seasonal[state.level] || []).includes(year)) return "none";
  if (!seasonalCache.has(key)) {
    seasonalCache.set(key, "loading");
    fetch(`seasonal/${key.replace("+", "plus")}.json`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { seasonalCache.set(key, d); render(); }, () => { seasonalCache.set(key, "failed"); render(); });
  }
  return seasonalCache.get(key);
}
const ready = d => d !== null && typeof d === "object";
// the week on screen: the one holding the picked date (state.wk, "MM-DD"; before the season the
// first week, after it the last); with none picked, this week's if the season is on, else opening week
function weekIndex(d) {
  const W = d.weeks, md = state.wk || TODAY;
  if (!state.wk && (md < W[0][0] || md > W[W.length - 1][1])) return 0;
  let i = 0;
  while (i + 1 < W.length && W[i + 1][0] <= md) i++;
  return i;
}
const isSeasonal = () => state.view === "seasonal";
const DEFAULTS = {view: "season", wk: "", base: "season",
  side: "All", level: "MLB", year: "", league: "", team: "", org: "", qual: true, sort: "Park Factor", dir: -1};
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
// neutral sites' Team and Org (no club's home): listed right after the All option
const NEUTRAL = "League";
function fill(sel, values, allLabel, keep) {
  values = values.filter(v => v !== "");
  values = [...values.filter(v => v === NEUTRAL), ...values.filter(v => v !== NEUTRAL)];
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

// years: All years on top, then newest first ("" is the level's most recent, and the default);
// leagues in level order (MLB, IL, PCL, EL, …); teams alphabetically within the level, year, league and org
function refreshOptions() {
  const atLevel = DATA.rows.filter(r => (!state.level || r[ci.Level] === state.level) && r[ci.Side] === "All");
  const newest = state.level ? DATA.latest[state.level] : null;
  const years = [...new Set(atLevel.map(r => r[ci.Year]))].sort((a, b) => b - a).filter(y => y !== newest).map(String);
  $("year").innerHTML = `<option value="${ALL}">All years</option><option value="">${newest || "Most recent"}</option>` +
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

// the board's rows for the level, year and side with week wi's index columns: against that week's
// average park (base week), or times the league's own index that week (base season: against the season's)
function seasonalRows(d, wi) {
  const S = d.sides[state.side] || d.sides.All, si = Object.fromEntries(d.cols.map((c, i) => [c, i])), lg = S.league[wi];
  return DATA.rows.filter(r => r[ci.Level] === d.level && r[ci.Year] === d.year && r[ci.Side] === state.side && S.venues[r[ci.Venue]])
    .map(r => {
      const w = S.venues[r[ci.Venue]][wi], out = r.slice();
      for (const c of COLORED) out[ci[c]] = state.base === "week" ? w[si[c]] / 10 : Math.round(w[si[c]] * lg[si[c]] / 1000) / 10;
      return out;
    });
}
// the Seasonal view shows one level and one year
function seasonalScope() {
  if (!isSeasonal()) return;
  if (!state.level) state.level = "MLB";
  if (state.year === ALL) state.year = "";
}
const fmt = (v, c) => isSeasonal() && COLORED.includes(c) ? v.toFixed(1) : v;

function render() {
  seasonalScope();
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
  const sd = isSeasonal() ? seasonalData() : null, wi = ready(sd) ? weekIndex(sd) : 0;
  const rows = (isSeasonal() ? (ready(sd) ? seasonalRows(sd, wi) : []) : DATA.rows).filter(r =>
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
  // Seasonal against the season average: the league's own row that week on top
  const si = ready(sd) ? Object.fromEntries(sd.cols.map((c, i) => [c, i])) : {};
  const lg = ready(sd) ? (sd.sides[state.side] || sd.sides.All).league[wi] : null;
  const league = lg && state.base === "season" && rows.length ? "<tr class=\"league\">" + SHOW.map(c =>
    c === "Venue" ? `<td class="txt venue" title="The league that week against its season average">${esc(sd.level)} average</td>`
    : COLORED.includes(c) ? `<td class="${c === "Park Factor" ? "sep" : ""}">${(lg[si[c]] / 10).toFixed(1)}</td>`
    : `<td class="${c === "PA" ? "sep" : ""}${TXT.has(c) ? " txt" : ""}"></td>`).join("") + "</tr>" : "";
  const none = isSeasonal() && !ready(sd)
    ? {loading: "Loading the seasonal factors…", failed: "The seasonal factors didn't load. Reload the page to try again.",
       none: "No seasonal factors for this level and year."}[sd] : "";
  $("body").innerHTML = rows.length ? league + rows.map((r, i) => "<tr>" + SHOW.map(c => {
    if (c === "Rk.") return `<td class="rk">${i + 1}</td>`;
    const v = r[ci[c]];
    const was = c === "Venue" && DATA.renamed[v];  // a park renamed for 2027
    if (TXT.has(c)) return `<td class="txt${c === "Venue" ? " venue" : ""}"${was ? ` title="${esc(was)}"` : ""}>${esc(v)}</td>`;
    if (COLORED.includes(c)) return `<td class="stat${c === "Park Factor" ? " pf sep" : ""}" style="background:${shade(v, c)}">${fmt(v, c)}</td>`;
    return `<td class="dim${c === "PA" ? " sep" : ""}">${c === "Year" ? v : v.toLocaleString()}</td>`;
  }).join("") + "</tr>").join("")
    : `<tr class="empty"><td colspan="${SHOW.length}">${none || `No parks match these filters${state.qual ? " — try turning off Qualified parks" : ""}.`}</td></tr>`;
  const n = rows.length, unit = (state.year === ALL ? "park season" : "park") + (n === 1 ? "" : "s");
  const years = rows.map(r => r[ci.Year]);
  const when = state.year === ALL ? (n ? `, ${Math.min(...years)}–${Math.max(...years)}` : "")
    : state.level ? ` in ${yearOf(state.level)}` : state.year ? ` in ${state.year}` : " in each level's most recent year";
  const wk = ready(sd) ? sd.weeks[wi] : null;
  $("status").textContent = isSeasonal()
    ? (wk ? `${n} ${state.level} ${unit}, ${wk[2]}, ${sd.year}, ${SIDE_LABEL[state.side]}, against ${state.base === "week" ? "that week's" : "the season's"} average park` : none)
    : state.level
    ? `${n} ${state.level} ${unit}${when}, ${SIDE_LABEL[state.side]}`
    : `${n} ${unit} across all levels${when}, ${SIDE_LABEL[state.side]} (each indexed to its own level)`;
  $("seasonbar").hidden = !isSeasonal();
  $("play").disabled = $("week").disabled = !wk;
  $("wk_label").textContent = wk ? `${wk[2]}, ${sd.year}` : none;
  $("lg_note").textContent = lg ? `League that week vs its season: wOBA ${(lg[si["Park Factor"]] / 10).toFixed(1)} · HR ${(lg[si.HR] / 10).toFixed(1)} · K ${(lg[si.K] / 10).toFixed(1)}` : "";
  if (wk) {
    const nw = sd.weeks.length;
    $("week").max = nw - 1; $("week").value = wi;
    $("months").innerHTML = sd.weeks.map((w, i) => i && w[0].slice(0, 2) !== sd.weeks[i - 1][0].slice(0, 2)
      ? `<span style="left:${(100 * i / (nw - 1)).toFixed(2)}%">${MONTHS[+w[0].slice(0, 2)]}</span>` : "").join("");
  }
  // one level and one year at a time in the Seasonal view
  $("level").options[0].disabled = isSeasonal();
  const allYears = $("year").querySelector(`option[value="${ALL}"]`);
  if (allYears) allYears.disabled = isSeasonal();
  $("level").title = $("year").title = isSeasonal() ? "The Seasonal view shows one level and one year at a time" : "";
  document.querySelectorAll("#view button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.view));
  document.querySelectorAll("#base button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.base));
  document.querySelectorAll("#side button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.side));
  $("level").value = state.level; $("year").value = state.year; $("org").value = state.org; $("qual").checked = state.qual;
  const h = toHash();
  if (location.hash.slice(1) !== h) {
    try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch (e) {}
  }
}

// the filters live in the link hash (#org=SEA&side=L&sort=HR…), defaults left out;
// with an org picked, All levels is the default level (but not in the Seasonal view, one level at a time)
const levelDefault = () => state.org && !isSeasonal() ? "" : "MLB";
function toHash() {
  const p = new URLSearchParams();
  if (isSeasonal()) {
    p.set("view", "seasonal");
    if (state.wk) p.set("wk", state.wk);  // the picked week's first day, MM-DD
    if (state.base !== DEFAULTS.base) p.set("base", state.base);
  }
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
  if (p.get("view") === "seasonal") state.view = "seasonal";
  if (/^\d\d-\d\d$/.test(p.get("wk") || "")) state.wk = p.get("wk");
  if (p.get("base") === "week") state.base = "week";
  if (["L", "R"].includes(p.get("side"))) state.side = p.get("side");
  if (ORGS.includes(p.get("org"))) state.org = p.get("org");
  const lv = p.get("level");
  state.level = lv === "all" ? "" : LEVELS.includes(lv) ? lv : levelDefault();
  state.year = p.get("year") || "";  // "all", or a year; refreshOptions drops one the level doesn't have
  state.league = p.get("league") || "";  // refreshOptions drops a league or team that isn't there
  state.team = p.get("team") || "";
  if (p.get("qual") === "0") state.qual = false;
  seasonalScope();
  if (showCols().includes(p.get("sort"))) {
    state.sort = p.get("sort");
    state.dir = p.get("dir") === "asc" ? 1 : -1;
  }
}

$("side").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { state.side = b.dataset.v; render(); } });
$("view").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  state.view = b.dataset.v;
  if (isSeasonal()) seasonalScope(); else stop();
  refreshOptions(); render();
});
$("base").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { state.base = b.dataset.v; render(); } });
$("week").addEventListener("input", e => {
  stop();
  const d = seasonalData();
  if (ready(d)) state.wk = d.weeks[+e.target.value][0];
  render();
});
// ▶ steps a week at a time to the end of the season (from opening week again once at the end)
let timer = null;
function stop() {
  clearInterval(timer); timer = null;
  $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play through the season");
}
$("play").addEventListener("click", () => {
  if (timer) return stop();
  const d = seasonalData();
  if (!ready(d)) return;
  if (weekIndex(d) >= d.weeks.length - 1) { state.wk = d.weeks[0][0]; render(); }
  $("play").textContent = "❚❚"; $("play").setAttribute("aria-label", "Pause");
  timer = setInterval(() => {
    const d = seasonalData(), i = ready(d) ? weekIndex(d) : -1;
    if (i < 0 || i >= d.weeks.length - 1) return stop();
    state.wk = d.weeks[i + 1][0]; render();
  }, 650);
});
$("level").addEventListener("change", e => { state.level = e.target.value; state.league = state.team = ""; refreshOptions(); render(); });
$("year").addEventListener("change", e => { state.year = e.target.value; refreshOptions(); render(); });
$("league").addEventListener("change", e => { state.league = e.target.value; refreshOptions(); render(); });
$("team").addEventListener("change", e => { state.team = e.target.value; render(); });
// picking an org shows its whole system: every level at once
$("org").addEventListener("change", e => {
  state.org = e.target.value;
  if (state.org && !isSeasonal()) state.level = "";
  refreshOptions(); render();
});
$("qual").addEventListener("change", e => { state.qual = e.target.checked; render(); });
$("reset").addEventListener("click", () => { stop(); Object.assign(state, DEFAULTS); refreshOptions(); render(); });
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
// (the Seasonal view adds its week and baseline)
const CSV_COLS = ["Rk.", "Level", "Year", "Side", "League", "Team", "Org", "Venue", "Games", ...COLORED, "PA"];
const csvCell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
$("csv").addEventListener("click", () => {
  const sd = isSeasonal() ? seasonalData() : null, wk = ready(sd) ? sd.weeks[weekIndex(sd)] : null;
  const cols = isSeasonal() ? [...CSV_COLS.slice(0, 3), "Week", "Compared to", ...CSV_COLS.slice(3)] : CSV_COLS;
  const extra = {"Week": wk ? wk[2] : "", "Compared to": state.base === "week" ? "Same week" : "Season average"};
  const lines = [cols, ...shown.map((r, i) => cols.map(c => c === "Rk." ? i + 1 : c in extra ? extra[c] : r[ci[c]]))];
  const text = lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const blob = new Blob(["\ufeff" + text], {type: "text/csv;charset=utf-8"});  // BOM so Excel reads UTF-8
  const year = state.year === ALL ? "all-years" : state.level ? yearOf(state.level) : state.year || "most-recent";
  const name = ["park_factors", year, state.level || "all-levels",
    wk ? `seasonal_wk${wk[0]}_vs-${state.base === "week" ? "week" : "season"}` : "",
    state.org, state.league, state.team,
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
window.addEventListener("hashchange", () => { stop(); fromHash(); refreshOptions(); render(); });
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
