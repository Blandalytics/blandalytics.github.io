"""Render scorecard.json to a standalone, dark-only HTML scorecard."""
import io
import json
import sys
from html import escape

# the scorecard dict the helpers below read; render_html() sets it per game
d = None
INN = list(range(1, 10))

# diamond geometry, centred on (50,50) so the notation sits dead centre of it
H, F, S, T = (50, 82), (82, 50), (50, 18), (18, 50)
LEGS = [(H, F), (F, S), (S, T), (T, H)]          # home->1st->2nd->3rd->home

# club primary colours by MLB abbreviation; the two variants each page needs
# (a light accent for text on the dark ground, a solid band that carries white
# text) are derived from these rather than hand-tuned per team.
TEAM_HEX = {
    "ARI": "#a71930", "AZ": "#a71930", "ATH": "#003831", "ATL": "#ce1141", "BAL": "#df4601",
    "BOS": "#bd3039", "CHC": "#0e3386", "CIN": "#c6011f", "CLE": "#00385d",
    "COL": "#33006f", "CWS": "#27251f", "CHW": "#27251f", "DET": "#0c2340",
    "HOU": "#002d62", "KC": "#004687", "LAA": "#ba0021", "LAD": "#005a9c",
    "MIA": "#00a3e0", "MIL": "#12284b", "MIN": "#002b5c", "NYM": "#002d72",
    "NYY": "#003087", "OAK": "#003831", "PHI": "#e81828", "PIT": "#fdb827",
    "SD": "#2f241d", "SEA": "#0c2c56", "SF": "#fd5a1e", "STL": "#c41e3a",
    "TB": "#092c5c", "TEX": "#003278", "TOR": "#134a8e", "WSH": "#ab0003",
}
GROUND = "#0d1117"


def _rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def _lum(h):
    def f(c):
        c /= 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = _rgb(h)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def _contrast(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _mix(a, b, t):
    return "#%02x%02x%02x" % tuple(round(x + (y - x) * t)
                                   for x, y in zip(_rgb(a), _rgb(b)))


def _toward(base, target, want, against):
    """Blend base toward target until it reads clearly against `against`."""
    for i in range(0, 101):
        c = _mix(base, target, i / 100.0)
        if _contrast(c, against) >= want:
            return c
    return target


def team_colours(abbr):
    """(accent for text on the dark page, solid band that carries white text)."""
    base = TEAM_HEX.get((abbr or "").upper(), "#7f8c99")
    return _toward(base, "#ffffff", 4.5, GROUND), _toward(base, "#000000", 4.5, "#ffffff")


ONES = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
        6: "six", 7: "seven", 8: "eight", 9: "nine"}
WORD_ORD = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
            6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth"}


def big_inning(side):
    """The team's largest scoring inning, as (runs, ordinal) or None."""
    best = max(((i[side] or 0), i["num"]) for i in d["linescore"]["innings"])
    return best if best[0] else None


def blurb():
    parts = []
    for side in ("away", "home"):
        b = big_inning(side)
        if b:
            parts.append("%s %s-run %s %s" % ("a" if ONES[min(b[0], 9)][0] != "e" else "an",
                                              ONES.get(b[0], str(b[0])),
                                              d[side]["nickname"], WORD_ORD.get(b[1], ordinal(b[1]))))
    lead = ("Every plate appearance of " + " and ".join(parts) + ", scored the long way."
            if parts else "Every plate appearance of the game, scored the long way.")
    return (lead + " Each box draws only the bases that batter actually reached, coloured by "
            "what the outcome was worth, with the count on the deciding pitch and the exit "
            "velocity in the corners. Hover any box for the full play.")


# outcome colours for the notation and the basepaths, never a cell background.
# reaching without a hit shares the walk colour; every out stays white.
OUT_COLOUR = "#ffffff"
OUTCOME_COLOUR = {
    "walk": "#93cde6", "intent_walk": "#93cde6",
    "hit_by_pitch": "#93cde6", "catcher_interf": "#93cde6",
    "single": "#2d99c8", "double": "#54d29b",
    "triple": "#ffe066", "home_run": "#f04542",
}

BB_NAME = {"BRL": "barrel", "SLD": "solid contact", "FLR": "flare",
           "BRN": "burner", "UND": "poorly under", "TOP": "poorly topped",
           "WEAK": "poorly weak", "UNC": "unclassified"}

# batted ball quality, brightest for the best contact
BB_TIER = {"BRL": "t1", "SLD": "t1", "FLR": "t2", "BRN": "t2",
           "UND": "t3", "TOP": "t3", "WEAK": "t3", "UNC": "t3"}


def shade(event_type):
    return OUTCOME_COLOUR.get(event_type, OUT_COLOUR)


def woba(s):
    """Same weights as the colour scale, over plate appearances."""
    pa = s["pa"]
    if not pa:
        return 0.0
    singles = s["h"] - s["double"] - s["triple"] - s["hr"]
    return (0.7 * (s["bb"] + s["hbp"] + s["ci"]) + 0.9 * singles
            + 1.25 * s["double"] + 1.6 * s["triple"] + 2.0 * s["hr"]) / pa


def fmt_woba(v):
    return ("%.3f" % v).lstrip("0") if v else ".000"


def pa_index(side):
    """(batter, inning) -> that batter's plate appearances in the inning, in order."""
    half = "top" if side == "away" else "bottom"
    idx = {}
    for p in d["pas"]:
        if p["half"] == half:
            idx.setdefault((p["batter"], p["inning"]), []).append(p)
    for v in idx.values():
        v.sort(key=lambda p: p["abi"])
    return idx


def ordinal(n):
    return "%d%s" % (n, "th" if 11 <= n % 100 <= 13
                     else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def inning_pas():
    """side|inning -> the half inning's plate appearances, in order."""
    out = {}
    runs = {(i["num"], sd): i[sd] for i in d["linescore"]["innings"] for sd in ("away", "home")}
    for side in ("away", "home"):
        half = "top" if side == "away" else "bottom"
        names = {p["id"]: p["name"] for slot in d[side]["lineup"] for p in slot}
        nick = d[side]["name"].split()[-1]
        for pa in sorted([p for p in d["pas"] if p["half"] == half],
                         key=lambda p: (p["inning"], p["abi"])):
            key = "%s|%d" % (side, pa["inning"])
            out.setdefault(key, {"team": nick, "inn": ordinal(pa["inning"]),
                                 "runs": runs.get((pa["inning"], side)) or 0,
                                 "pas": []})
            out[key]["pas"].append([
                names.get(pa["batter"], "?"), pa["notation"], shade(pa["eventType"]),
                1 if (pa["notation"] == "K" and pa.get("k_looking")) else 0])
    return out


def diamond(reached, colour, cls="dia", earned=None):
    """Only the legs the runner actually covered, and nothing inside them.
    Legs taken on the plate appearance itself are full strength; bases advanced
    afterwards are faded. Four legs drawn means the run scored."""
    if not reached:
        return ""
    earned = reached if earned is None else earned
    out = []
    for i, (a, b) in enumerate(LEGS):
        if i < reached:
            out.append('<line class="dia-leg%s" x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s"/>'
                       % ("" if i < earned else " adv", *a, *b, colour))
    return ('<svg class="%s" viewBox="0 0 100 100" aria-hidden="true">%s</svg>'
            % (cls, "".join(out)))


def count_squares(balls, strikes):
    """One white box per ball and per strike on the deciding pitch, stacked upward."""
    def col(n, cls):
        return '<span class="col %s">%s</span>' % (cls, "<i></i>" * n)
    return '<span class="cnt">%s%s</span>' % (col(balls, "b"), col(strikes, "s"))


def note_html(pa):
    if pa["notation"] == "K" and pa.get("k_looking"):
        return '<i class="flip">K</i>'                       # backwards K = called
    text = pa["notation"]
    if " " in text:                                          # e.g. "FC 6-2"
        prefix, rest = text.split(" ", 1)
        note = '<i class="pre">%s</i>%s' % (escape(prefix), escape(rest))
    else:
        note = escape(text)
    if pa.get("dp_label"):                                   # DP / TP on its own line
        note += '<i class="dp">%s</i>' % pa["dp_label"]
    return note


def hover_attrs(pa):
    meta = ["%d-%d count on the last pitch" % (pa.get("cnt_b", 0), pa.get("cnt_s", 0)),
            "%d pitches" % pa.get("pitches", 0)]
    if pa.get("final_pitch"):
        meta.append("ended on %s at %.1f mph" % (pa["final_pitch"], pa["final_velo"]))
    if pa.get("ev") is not None:
        hit = "%.1f mph off the bat, %d° launch" % (pa["ev"], pa["la"])
        if pa.get("dist"):
            hit += ", %d ft" % pa["dist"]
        meta.append(hit)
        meta.append(BB_NAME.get(pa.get("bb_label"), ""))
    # no title attribute: the native browser tooltip would double up on the panel
    return ('tabindex="0" data-abi="%d" data-desc="%s" data-meta="%s"'
            % (pa["abi"], escape(pa["desc"]), escape(" · ".join(meta))))


def boundary_marks(pas):
    """White brackets on the corners: upper left opens the half inning,
    bottom right closes it."""
    m = ""
    if any(p.get("inning_start") for p in pas):
        m += '<span class="mark-start"></span>'
    if any(p.get("inning_end") for p in pas):
        m += '<span class="mark-end"></span>'
    return m


def split_cell(pas):
    """Two trips in one inning: a diagonal divide, first PA upper left."""
    halves = ""
    for i, pa in enumerate(pas[:2]):
        colour = shade(pa["eventType"])
        rbi = '<span class="rbi-s">%d RBI</span>' % pa["rbi"] if pa["rbi"] else ""
        halves += ('<div class="half h%d" %s><span class="mini">%s'
                   '<span class="note%s" style="color:%s">%s</span></span></div>'
                   % (i + 1, hover_attrs(pa), rbi,
                      " rot" if pa.get("clock_violation") else "", colour, note_html(pa)))
    extra = '<span class="more">+%d</span>' % (len(pas) - 2) if len(pas) > 2 else ""
    marks = boundary_marks(pas)
    return ('<td class="pa"><div class="box split">'
            '<svg class="divider" viewBox="0 0 100 100" preserveAspectRatio="none"'
            ' aria-hidden="true"><line x1="0" y1="100" x2="100" y2="0"/></svg>'
            '%s%s%s</div></td>' % (halves, extra, marks))


def cell(pas):
    if not pas:
        return '<td class="pa"><div class="box empty"></div></td>'
    if len(pas) > 1:
        return split_cell(pas)
    pa = pas[0]
    colour = shade(pa["eventType"])
    note = note_html(pa)

    bits = []
    if pa.get("bb_label"):
        bits.append('<span class="bbq %s">%s</span>'
                    % (BB_TIER[pa["bb_label"]], pa["bb_label"]))
    bits.append(count_squares(pa.get("cnt_b", 0), pa.get("cnt_s", 0)))
    if pa.get("ev") is not None:
        hard = " hard" if pa["ev"] >= 95 else ""
        bits.append('<span class="ev%s">%.0f</span>' % (hard, pa["ev"]))
    if pa["rbi"]:
        bits.append('<span class="rbi">%d RBI</span>' % pa["rbi"])
    bits.append(boundary_marks([pa]))

    return ('<td class="pa"><div class="box" %s>%s'
            '<span class="note%s" style="color:%s">%s</span>%s</div></td>'
            % (hover_attrs(pa), diamond(pa["reached"], colour, earned=pa.get("reached_pa")),
               " rot" if pa.get("clock_violation") else "", colour, note, "".join(bits)))


AGG = ("PA", "K", "BB", "HR", "SB", "wOBA")


def batting_table(side):
    team = d[side]
    idx = pa_index(side)
    runs = {i["num"]: i[side] for i in d["linescore"]["innings"]}

    head_inn = "".join('<th class="in">%d</th>' % i for i in INN)
    head_agg = "".join('<th class="st%s">%s</th>' % (" wide" if a == "wOBA" else "", a)
                       for a in AGG)
    # inning-by-inning runs, sitting directly under the inning numbers
    # a blank cell means the team never batted that inning, which is not the
    # same as batting and not scoring
    runrow = "".join('<td class="rn%s" tabindex="0" data-inn="%s|%d">%s</td>'
                     % (" got" if runs.get(i) else "", side, i,
                        "" if runs.get(i) is None else ("—" if runs[i] == 0 else runs[i]))
                     for i in INN)

    rows = []
    for n, slot in enumerate(team["lineup"], 1):
        for p in slot:
            cells = "".join(cell(idx.get((p["id"], i), [])) for i in INN)
            rows.append(
                '<tr class="%s">'
                '<th class="slot">%s</th>'
                '<th class="who"><span class="nm">%s</span><span class="pos">%s</span></th>'
                '%s'
                '<td class="st">%d</td><td class="st">%d</td><td class="st">%d</td>'
                '<td class="st">%d</td><td class="st">%d</td>'
                '<td class="st wide">%s</td></tr>'
                % ("sub" if p["sub"] else "starter",
                   "&#8627;" if p["sub"] else str(n),
                   escape(p["name"]), escape(p["pos"]), cells,
                   p["pa"], p["k"], p["bb"], p["hr"], p["sb"], fmt_woba(woba(p))))

    t = team["totals"]
    tt = {"pa": t["plateAppearances"], "h": t["hits"], "bb": t["baseOnBalls"],
          "hbp": t["hitByPitch"], "ci": t["catchersInterference"],
          "double": t["doubles"], "triple": t["triples"], "hr": t["homeRuns"]}
    foot = ('<tr class="tot"><th colspan="2">Team</th>'
            '<td class="blank" colspan="%d"></td>'
            '<td class="st">%d</td><td class="st">%d</td><td class="st">%d</td>'
            '<td class="st">%d</td><td class="st">%d</td>'
            '<td class="st wide">%s</td></tr>'
            % (len(INN), t["plateAppearances"], t["strikeOuts"], t["baseOnBalls"],
               t["homeRuns"], t["stolenBases"], fmt_woba(woba(tt))))

    return ('<div class="scroll"><table class="grid">'
            '<thead>'
            '<tr><th class="slot"></th><th class="who">Batter</th>%s%s</tr>'
            '<tr class="runs"><th class="slot"></th><th class="who">Runs</th>%s'
            '<td class="blank" colspan="%d"></td></tr>'
            '</thead><tbody>%s</tbody><tfoot>%s</tfoot></table></div>'
            % (head_inn, head_agg, runrow, len(AGG), "".join(rows), foot))


def pitching_table(side):
    rows = []
    for p in d[side]["pitchers"]:
        mix = "".join(
            '<span class="chip"><b>%s</b>%d%%<i>%.1f</i></span>' % (m["type"], m["pct"], m["velo"])
            for m in p["mix"])
        note = ' <span class="dec">%s</span>' % escape(p["note"].strip("()")) if p["note"] else ""
        rows.append(
            '<tr><th class="who"><span class="nm">%s</span>%s</th>'
            '<td class="st">%s</td><td class="st">%d</td><td class="st">%d</td>'
            '<td class="st">%d</td><td class="st">%d</td><td class="st">%d</td>'
            '<td class="st">%d</td><td class="st">%d</td>'
            '<td class="st">%d<span class="sub-n">/%d</span></td>'
            '<td class="st">%.1f</td><td class="st">%.1f</td>'
            '<td class="mix">%s</td></tr>'
            % (escape(p["name"]), note, p["ip"], p["h"], p["r"], p["er"], p["bb"],
               p["k"], p["hr"], p["bf"], p["strikes"], p["pitches"],
               p["avg_velo"], p["max_velo"], mix))
    return ('<div class="scroll"><table class="pitch">'
            '<thead><tr><th class="who">Pitcher</th>'
            '<th class="st">IP</th><th class="st">H</th><th class="st">R</th>'
            '<th class="st">ER</th><th class="st">BB</th><th class="st">K</th>'
            '<th class="st">HR</th><th class="st">BF</th>'
            '<th class="st">Str<span class="sub-n">/P</span></th>'
            '<th class="st">Avg</th><th class="st">Max</th>'
            '<th class="mix">Pitch mix (share, avg mph)</th></tr></thead>'
            '<tbody>%s</tbody></table></div>' % "".join(rows))


def team_block(side):
    team = d[side]
    rec = team["record"]
    ls = d["linescore"]["totals"][side]
    other = d["linescore"]["totals"]["home" if side == "away" else "away"]
    verdict = "Win" if ls["r"] > other["r"] else "Loss"
    return (
        '<section class="team team--%s">'
        '<header class="band">'
        '<div class="band-id"><span class="club">%s</span>'
        '<span class="meta">%s · %d-%d</span></div>'
        '<div class="band-line"><span class="ls"><b>%d</b>R</span>'
        '<span class="ls"><b>%d</b>H</span><span class="ls"><b>%d</b>E</span>'
        '<span class="verdict">%s</span></div></header>'
        '%s'
        '<h3 class="pitch-title">%s pitching</h3>%s</section>'
        % (side, escape(team["name"]),
           "Away" if side == "away" else "Home",
           rec.get("wins", 0), rec.get("losses", 0),
           ls["r"], ls["h"], ls["e"], verdict,
           batting_table(side), escape(team["name"].split()[-1]), pitching_table(side)))


def linescore():
    inn = d["linescore"]["innings"]
    head = "".join("<th>%d</th>" % i["num"] for i in inn)
    rows = ""
    for side in ("away", "home"):
        t = d["linescore"]["totals"][side]
        cells = "".join('<td class="%s" tabindex="0" data-inn="%s|%d">%s</td>'
                        % ("got" if (i[side] or 0) else "", side, i["num"],
                           i[side] if i[side] is not None else "–")
                        for i in inn)
        rows += ('<tr class="team--%s"><th>%s</th>%s'
                 '<td class="tt">%d</td><td class="tt">%d</td><td class="tt">%d</td></tr>'
                 % (side, escape(d[side]["name"]), cells, t["r"], t["h"], t["e"]))
    return ('<div class="scroll"><table class="line"><thead><tr><th></th>%s'
            '<th class="tt">R</th><th class="tt">H</th><th class="tt">E</th>'
            '</tr></thead><tbody>%s</tbody></table></div>' % (head, rows))


# dark only: one palette, no media query and no theme stamps
CSS = """
:root{
  --ground:#0d1117; --surface:#151b23; --raise:#1b222c;
  --ink:#e3e9f1; --muted:#8a96a6; --faint:#6b7684;
  --rule:#242c37; --rule-soft:#1e252f;
  --away:__AWAY__; --home:__HOME__;
  --band-away:__BAND_AWAY__; --band-home:__BAND_HOME__;
  --hard:#ec9094;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.7);
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--ground); color:var(--ink);
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:15px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1180px; margin:0 auto; padding:36px 20px 0; display:flex; flex-direction:column; gap:34px}
.scroll{overflow-x:auto; -webkit-overflow-scrolling:touch}

/* ---------- masthead ---------- */
.mast{display:flex; flex-direction:column; gap:18px}
.eyebrow{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:11px;
  letter-spacing:.16em; text-transform:uppercase; color:var(--muted);
  display:flex; flex-wrap:wrap; gap:6px 14px;
}
.eyebrow span{white-space:nowrap}
.score{display:flex; flex-wrap:wrap; align-items:baseline; gap:10px 18px}
.score h1{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:600;
  font-size:clamp(30px,5.2vw,48px); line-height:1.02; margin:0;
  letter-spacing:-.005em; text-wrap:balance;
}
.score h1 .at{color:var(--faint); font-weight:500; padding:0 .12em}
.score h1 em{font-style:normal; font-variant-numeric:tabular-nums}
.score h1 .away{color:var(--away)}
.score h1 .home{color:var(--home)}
.blurb{max-width:62ch; color:var(--muted); margin:0; font-size:15px}

table{border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums}
.cnt,.bbq,.ev,.rbi,.rbi-s,.note,.pl-row,.chip{font-variant-numeric:tabular-nums}
.line{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:13px; min-width:560px}
.line th,.line td{border-bottom:1px solid var(--rule-soft); padding:7px 0; text-align:center; font-weight:500}
.line thead th{color:var(--faint); font-size:11px; letter-spacing:.08em; font-weight:500}
.line tbody th{
  text-align:left; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:500; font-size:15px;
  padding-right:20px; white-space:nowrap;
}
.line tbody tr.team--away th{color:var(--away)}
.line tbody tr.team--home th{color:var(--home)}
.line td{color:var(--faint); width:38px}
.line td.got{color:var(--ink); font-weight:600}
.line .tt{color:var(--ink); font-weight:600; border-left:1px solid var(--rule-soft)}
.line tbody tr:last-child th,.line tbody tr:last-child td{border-bottom:none}

/* ---------- team blocks ---------- */
.team{display:flex; flex-direction:column; gap:0}
.team--away{--band:var(--band-away)}
.team--home{--band:var(--band-home)}
.band{
  display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between;
  gap:10px 20px; padding:12px 16px;
  background:var(--band); color:#fff; border-radius:7px 7px 0 0;
}
.band-id{display:flex; align-items:baseline; gap:12px; flex-wrap:wrap}
.club{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:600; font-size:23px; letter-spacing:.01em}
.band .meta{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:11px; letter-spacing:.1em;
  text-transform:uppercase; opacity:.82;
}
.band-line{display:flex; align-items:baseline; gap:16px; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:11px; letter-spacing:.1em}
.ls b{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:20px; letter-spacing:0; margin-right:3px}
.verdict{
  text-transform:uppercase; border:1px solid rgba(255,255,255,.55);
  border-radius:3px; padding:2px 7px; font-size:10px;
}

/* ---------- batting grid ---------- */
.grid,.pitch,.pitch-title{background:var(--surface)}
.grid{min-width:1050px}
.grid thead th{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:500; font-size:11px;
  letter-spacing:.1em; color:var(--muted); text-transform:uppercase;
  padding:9px 6px; border-bottom:1px solid var(--rule);
}
.grid thead th.in{color:var(--ink); font-size:13px; letter-spacing:0}
.grid thead th.wide{text-transform:none; letter-spacing:.04em}
.grid th.slot{
  width:30px; text-align:center; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:14px; color:var(--faint); font-weight:500;
}
.grid th.who{width:190px; text-align:left; padding-left:14px}
.grid tbody th.who{border-right:1px solid var(--rule)}
.nm{display:block; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:500; font-size:15px; letter-spacing:.005em; white-space:nowrap}
.pos{
  display:block; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:10px;
  letter-spacing:.1em; color:var(--faint); text-transform:uppercase;
}
.grid tbody tr{border-bottom:1px solid var(--rule-soft)}
.grid tbody tr.sub th.slot{font-size:15px}
.grid tbody th{font-weight:400; padding:0 6px}
.grid td.st,.grid th.st{
  width:38px; text-align:center; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:13px; color:var(--muted);
}
.grid td.st.wide,.grid th.st.wide{width:54px}
.grid tbody td.st{border-left:1px solid var(--rule-soft); color:var(--ink)}
.grid tbody td.st:first-of-type{border-left:1px solid var(--rule)}
.grid td.pa{padding:0; border-left:1px solid var(--rule-soft); vertical-align:top}

/* runs by inning, directly under the inning numbers */
.grid tr.runs th.who{
  text-align:right; padding:0 12px 0 6px; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:10px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--muted); border-right:1px solid var(--rule);
}
.grid tr.runs td{
  text-align:center; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:13px;
  padding:5px 0; border-bottom:1px solid var(--rule);
  border-left:1px solid var(--rule-soft); color:var(--faint);
}
.grid tr.runs td.got{color:var(--ink); font-weight:600; font-size:15px}
.grid td.blank{border-bottom:1px solid var(--rule)}

.box{
  position:relative; width:84px; height:74px; margin:0 auto; overflow:visible;
  display:flex; align-items:center; justify-content:center;
}
/* innings the batter did not come up */
.box.empty{background:rgba(102,102,102,.1)}
/* square viewBox filling the cell, so the diamond centre is the cell centre
   and the notation lands dead centre of the basepaths */
.dia{position:absolute; inset:0; width:100%; height:100%; overflow:visible}
.dia-leg{stroke-width:5; stroke-linecap:round}
/* bases taken after the plate appearance itself */
.dia-leg.adv{stroke-opacity:.25}
.dia-s .dia-leg{stroke-width:8}
.note{
  position:relative; z-index:2; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-weight:600; font-size:12.5px; letter-spacing:-.01em; white-space:nowrap;
  line-height:1; text-align:center;
}
.flip{display:inline-block; transform:scaleX(-1); font-style:normal}
/* the pitch clock, not a pitch, ended this plate appearance */
.note.rot{display:inline-block; transform:rotate(90deg)}
.dp{display:block; font-style:normal; font-size:9px; letter-spacing:.1em;
    text-align:center; margin-top:1px}
.pre{display:block; font-style:normal}
.bbq,.ev,.rbi,.cnt{position:absolute; z-index:2}
.bbq,.ev,.rbi{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:9.5px; line-height:1}
.ev{right:6px; bottom:5px; color:var(--muted)}
.ev.hard{color:var(--hard); font-weight:600}
.rbi{left:5px; top:4px; color:var(--ink); font-weight:600; letter-spacing:.02em}
/* batted ball class, brightest for the best contact */
.bbq{right:5px; top:4px; font-size:9px; letter-spacing:.04em; font-weight:500}
.bbq.t1{color:var(--ink); font-weight:600}
.bbq.t2{color:var(--muted)}
.bbq.t3{color:var(--faint)}
/* the deciding pitch's count: balls stacked left, strikes right, bottom up */
.cnt{left:5px; bottom:5px; display:flex; gap:3px; align-items:flex-end}
.cnt .col{display:flex; flex-direction:column-reverse; gap:2px}
.cnt i{display:block; width:5px; height:5px}
.cnt .b i{background:#60c27f}
.cnt .s i{background:#ce6664}
/* half-inning boundaries: a bracket over a quarter of the cell's width and height */
.mark-start,.mark-end{position:absolute; width:25%; height:25%; z-index:3; pointer-events:none}
.mark-start{left:0; top:0; border-top:2px solid #666; border-left:2px solid #666}
.mark-end{right:0; bottom:0; border-bottom:2px solid #666; border-right:2px solid #666}

/* two trips to the plate in one inning: a diagonal divide, first PA upper left */
.box.split{display:block}
.divider{position:absolute; inset:0; width:100%; height:100%; z-index:1}
.divider line{stroke:var(--muted); stroke-width:1; vector-effect:non-scaling-stroke}
.half{position:absolute; inset:0; z-index:2}
.half.h1{clip-path:polygon(0 0, 100% 0, 0 100%)}
.half.h2{clip-path:polygon(100% 0, 100% 100%, 0 100%)}
.half:hover{background:rgba(255,255,255,.07)}
.half:focus-visible{outline:2px solid var(--ink); outline-offset:-3px}
.mini{
  position:absolute; width:36px; height:30px; transform:translate(-50%,-50%);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
}
.rbi-s{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:9px; line-height:1.1;
  color:var(--ink); font-weight:600; letter-spacing:.02em; white-space:nowrap;
}
.half.h1 .mini{left:33.3%; top:33.3%}
.half.h2 .mini{left:66.7%; top:66.7%}
.dia-s{position:absolute; inset:0; width:100%; height:100%; overflow:visible}
.mini .note{font-size:10.5px}
.more{
  position:absolute; left:3px; bottom:3px; z-index:3;
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:9px; color:var(--faint);
}

.box[tabindex]{cursor:default}
.box[tabindex]:hover{box-shadow:inset 0 0 0 1px var(--muted)}
.box[tabindex]:focus-visible{outline:2px solid var(--ink); outline-offset:-2px}

.grid tfoot .tot th{
  text-align:right; padding:8px 14px 8px 6px; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);
  border-top:1px solid var(--rule); border-right:1px solid var(--rule);
}
.grid tfoot td{
  border-top:1px solid var(--rule); text-align:center;
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:13px; padding:8px 0;
}
.grid tfoot td.st{color:var(--ink); font-weight:600; border-left:1px solid var(--rule-soft)}

/* ---------- pitching ---------- */
.pitch-title{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:10.5px; font-weight:500;
  letter-spacing:.14em; text-transform:uppercase; color:var(--muted);
  margin:0; padding:16px 14px 0; border-top:1px solid var(--rule);
}
.pitch{min-width:940px; border-radius:0 0 7px 7px}
.pitch thead th{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:500; font-size:11px;
  letter-spacing:.08em; color:var(--muted); text-transform:uppercase;
  padding:8px 4px; border-bottom:1px solid var(--rule); text-align:center;
}
.pitch th.who{text-align:left; padding-left:14px; width:200px}
.pitch tbody tr{border-bottom:1px solid var(--rule-soft)}
.pitch tbody tr:last-child{border-bottom:none}
.pitch tbody th{font-weight:400; padding:9px 6px 9px 14px; text-align:left}
.pitch td.st{
  width:44px; text-align:center; font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:13px; color:var(--ink);
}
.sub-n{color:var(--faint)}
.dec{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:9.5px; letter-spacing:.1em;
  text-transform:uppercase; color:var(--muted); border:1px solid var(--rule);
  border-radius:3px; padding:1px 4px; margin-left:7px; white-space:nowrap;
}
td.mix,th.mix{padding:6px 14px 6px 10px; text-align:left !important; white-space:nowrap}
.chip{
  display:inline-flex; align-items:baseline; gap:4px; margin-right:5px;
  border:1px solid var(--rule); border-radius:3px; padding:2px 6px;
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:10.5px; color:var(--muted);
}
.chip b{color:var(--ink); font-weight:600; letter-spacing:.04em}
.chip i{font-style:normal; color:var(--faint)}

/* ---------- readout + legend ---------- */
/* pitch-by-pitch panel, fixed so the table's scroll container cannot clip it */
.pitchlist{
  position:fixed; z-index:50; display:none;
  min-width:252px; max-width:340px;
  background:var(--raise); border:1px solid var(--rule); border-radius:6px;
  box-shadow:var(--shadow); padding:8px 0 7px;
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:11px;
}
.pl-head{
  padding:0 12px 7px; margin-bottom:5px; border-bottom:1px solid var(--rule);
  color:var(--muted); font-size:10px; letter-spacing:.1em; text-transform:uppercase;
}
.pl-head.desc{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:12px;
  letter-spacing:0; text-transform:none; color:var(--ink); line-height:1.35;
}
.pl-row{
  display:grid; grid-template-columns:12px 74px 40px 1fr; gap:8px;
  padding:2.5px 12px; align-items:baseline;
}
.pl-n{color:var(--faint); text-align:right}
/* pitch numbers link to the pitch's video */
a.pl-n{color:var(--muted); text-decoration:underline; text-underline-offset:2px;
       text-decoration-color:var(--rule)}
a.pl-n:hover{color:var(--ink); text-decoration-color:var(--ink)}
a.pl-n:focus-visible{outline:2px solid var(--ink); outline-offset:1px; border-radius:2px}
.pl-t{color:var(--ink)}
.pl-v{color:var(--muted); text-align:right; font-variant-numeric:tabular-nums}
.pl-r{font-size:10.5px; white-space:nowrap}
/* the pitch that ended the plate appearance */
.pl-r.last{font-weight:600}
/* an automatic ball or strike: no number, no pitch to report */
.pl-row.auto{grid-template-columns:12px 1fr}
.pl-auto{font-size:10.5px; line-height:1.3}
.pl-auto.last{font-weight:600}

.il-row{
  display:grid; grid-template-columns:1fr auto; gap:14px;
  padding:2.5px 12px; align-items:baseline;
}
.il-name{color:var(--ink); font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:12px; white-space:nowrap}
.il-note{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:600; font-size:11px}
[data-inn]{cursor:default}
.grid tr.runs td[data-inn]:hover,.line td[data-inn]:hover{background:var(--raise)}
[data-inn]:focus-visible{outline:2px solid var(--ink); outline-offset:-2px}

.readout{
  position:sticky; bottom:0; z-index:6; margin-top:6px;
  background:var(--surface); border-top:1px solid var(--rule);
  box-shadow:var(--shadow); padding:11px 16px;
  display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 16px; min-height:44px;
}
.d-play{font-size:14px; font-weight:500}
.d-meta{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:11.5px; color:var(--muted)}
.legend{
  display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr));
  gap:14px 34px; padding:0 0 40px; font-size:13.5px; color:var(--muted);
}
.legend b{color:var(--ink); font-weight:600}
.legend p{margin:0; max-width:60ch; line-height:1.65}
.legend code{
  font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:12px; font-weight:600;
  color:var(--ink); background:var(--raise); border:1px solid var(--rule);
  border-radius:3px; padding:0 4px;
}
.legend a{color:var(--ink); text-underline-offset:2px}
.key{display:inline-flex; align-items:center; gap:5px; white-space:nowrap; margin-right:4px}
.key .sw{width:11px; height:11px; display:inline-block}
.key .bar{width:16px; height:3px; border-radius:2px; display:inline-block}
.key b{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; font-size:11.5px; color:var(--ink)}

@media (max-width:640px){
  .wrap{padding:24px 12px 0}
  .band{border-radius:6px 6px 0 0}
}
@media print{.readout{display:none} .team{break-inside:avoid}}
"""

JS = """
var PITCH_NAME = {"FF":"Four-Seam","SI":"Sinker","FT":"Two-Seam","FC":"Cutter","SL":"Slider","ST":"Sweeper","SV":"Slurve","CU":"Curveball","KC":"Knuckle Cv","CS":"Slow Curve","CH":"Changeup","FS":"Splitter","FO":"Forkball","SC":"Screwball","KN":"Knuckler","EP":"Eephus","PO":"Pitchout"};
var VIDEO = "https://baseballsavant.mlb.com/sporty-videos?playId=";
var RESULT_NAME = {"Swinging Strike (Blocked)":"Swinging Strike",
  "In play, out(s)":"In play, out", "In play, no out":"In play",
  "In play, run(s)":"In play, run", "Ball In Dirt":"Ball in dirt"};
var PA_COLOUR = %s;
var PITCHES = %s;
var INNINGS = %s;

(function(){
  var bar=document.getElementById('readout'), panel=document.getElementById('pitchlist');
  if(!bar||!panel) return;
  var play=bar.querySelector('.d-play'), meta=bar.querySelector('.d-meta');
  var idle=play.textContent, idleMeta=meta.textContent;

  function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

  function place(el){
    var r=el.getBoundingClientRect(), pw=panel.offsetWidth, ph=panel.offsetHeight, pad=8;
    var left=r.right+pad, top=r.top;
    if(left+pw>window.innerWidth-pad) left=r.left-pw-pad;   // flip to the left edge
    if(left<pad) left=pad;
    if(top+ph>window.innerHeight-pad) top=window.innerHeight-ph-pad;
    if(top<pad) top=pad;
    panel.style.left=left+'px'; panel.style.top=top+'px';
  }

  function show(el){
    play.textContent=el.dataset.desc; meta.textContent=el.dataset.meta;
    var seq=PITCHES[el.dataset.abi];
    if(!seq||!seq.length){ hide(); return; }
    var noteEl=el.querySelector('.note');
    var paColour=(noteEl&&noteEl.style.color)||'#ffffff';
    var html='<div class="pl-head desc">'+esc(el.dataset.desc)+'</div>';
    for(var i=0;i<seq.length;i++){
      var p=seq[i], res=RESULT_NAME[p[3]]||p[3];
      if(p.length>5){                       // put in play: show what it went for
        res=p[5]+': '+p[6].toFixed(1)+' @ '+p[7]+'°';
      }
      var last=(i===seq.length-1);
      var style=' style="color:'+(last?paColour:'#ffffff')+'"';
      if(p[0]===null){                      // an automatic call, not a pitch
        html+='<div class="pl-row auto"><span class="pl-n"></span>'
            +'<span class="pl-auto'+(last?' last':'')+'"'+style+'>'+esc(p[3])+'</span></div>';
        continue;
      }
      // the pitch number is the link to that pitch's video on Baseball Savant
      var num=p[4]
        ? '<a class="pl-n" href="'+VIDEO+encodeURIComponent(p[4])+'" target="_blank" rel="noopener">'+p[0]+'</a>'
        : '<span class="pl-n">'+p[0]+'</span>';
      html+='<div class="pl-row">'+num
          +'<span class="pl-t">'+esc(PITCH_NAME[p[1]]||p[1])+'</span>'
          +'<span class="pl-v">'+p[2].toFixed(1)+'</span>'
          +'<span class="pl-r'+(last?' last':'')+'"'+style+'>'+esc(res)+'</span></div>';
    }
    panel.innerHTML=html;
    panel.style.display='block';
    panel.setAttribute('aria-hidden','false');
    place(el);
  }
  function hide(){
    panel.style.display='none';
    panel.setAttribute('aria-hidden','true');
    play.textContent=idle; meta.textContent=idleMeta;
  }
  // links live in the panel, so give the cursor a moment to cross the gap to it
  var hideTimer=null;
  function scheduleHide(){ clearTimeout(hideTimer); hideTimer=setTimeout(hide,220); }
  function cancelHide(){ clearTimeout(hideTimer); }
  panel.addEventListener('mouseenter',cancelHide);
  panel.addEventListener('mouseleave',scheduleHide);

  function showInning(el){
    var g=INNINGS[el.dataset.inn];
    if(!g||!g.pas.length){ return; }
    var html='<div class="pl-head">'+esc(g.team)+' &middot; '+g.inn+' &middot; '
             +g.runs+' run'+(g.runs===1?'':'s')+'</div>';
    for(var i=0;i<g.pas.length;i++){
      var a=g.pas[i], note=a[3]?'<i class="flip">K</i>':esc(a[1]);
      html+='<div class="il-row"><span class="il-name">'+esc(a[0])+'</span>'
          +'<span class="il-note" style="color:'+a[2]+'">'+note+'</span></div>';
    }
    panel.innerHTML=html;
    panel.style.display='block';
    panel.setAttribute('aria-hidden','false');
    place(el);
  }

  function bind(sel, fn){
    document.querySelectorAll(sel).forEach(function(el){
      el.addEventListener('mouseenter',function(){ cancelHide(); fn(el); });
      el.addEventListener('focus',function(){ cancelHide(); fn(el); });
      el.addEventListener('mouseleave',scheduleHide);
      el.addEventListener('blur',scheduleHide);
    });
  }
  bind('[data-abi]', show);
  bind('[data-inn]', showInning);
  window.addEventListener('scroll',hide,true);
})();
"""

def render_html(data):
    """Build the standalone scorecard page for one game, as a string."""
    global d
    d = data
    PITCHES = {p["abi"]: p["seq"] for p in d["pas"] if p.get("seq")}
    PANEL_HEX = {"1B": OUTCOME_COLOUR["single"], "2B": OUTCOME_COLOUR["double"],
                 "3B": OUTCOME_COLOUR["triple"], "HR": OUTCOME_COLOUR["home_run"],
                 "Out": OUT_COLOUR}
    js = JS % (json.dumps(PANEL_HEX, separators=(",", ":")),
               json.dumps(PITCHES, separators=(",", ":")),
               json.dumps(inning_pas(), separators=(",", ":"), ensure_ascii=False))

    w = d["weather"]
    away, home = d["linescore"]["totals"]["away"], d["linescore"]["totals"]["home"]

    acc_away, band_away = team_colours(d["away"]["abbr"])
    acc_home, band_home = team_colours(d["home"]["abbr"])
    css = (CSS.replace("__AWAY__", acc_away).replace("__HOME__", acc_home)
              .replace("__BAND_AWAY__", band_away).replace("__BAND_HOME__", band_home))

    nick_away, nick_home = d["away"]["nickname"], d["home"]["nickname"]
    # the title reads winner first, the way a final score is written
    _w, _l = ((nick_away, away["r"]), (nick_home, home["r"])) if away["r"] >= home["r"]     else ((nick_home, home["r"]), (nick_away, away["r"]))
    PAGE_TITLE = "%s %d, %s %d" % (_w[0], _w[1], _l[0], _l[1])
    GAME_DATE = "%s %d, %s" % (
        ["January", "February", "March", "April", "May", "June", "July", "August",
         "September", "October", "November", "December"][int(d["date"][5:7]) - 1],
        int(d["date"][8:10]), d["date"][:4])

    html = """<title>%s</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap">
    <style>%s</style>
    <main class="wrap">
      <header class="mast">
        <div class="eyebrow">
          <span>%s</span><span>%s</span><span>Game %d</span>
          <span>%s, %s&deg;F</span><span>Wind %s</span><span>%d pitches tracked</span>
        </div>
        <div class="score">
          <h1><span class="away">%s <em>%d</em></span><span class="at">/</span><span class="home">%s <em>%d</em></span></h1>
        </div>
        <p class="blurb">%s</p>
        %s
      </header>

      %s
      %s

      <div class="pitchlist" id="pitchlist" role="tooltip" aria-hidden="true"></div>

      <div class="readout" id="readout">
        <span class="d-play">Hover or tab through any box to read the play.</span>
        <span class="d-meta">Counts, exit velocity and pitch types come from Statcast tracking.</span>
      </div>

      <div class="legend">
        <p><b>Reading a box.</b> The basepaths are drawn only as far as the batter got, so a batter
          who made an out draws none at all and a closed diamond is a run scored. The legs earned on the plate appearance itself are full strength; bases taken later are faded. Their colour
          is the outcome: <span class="key"><span class="bar" style="background:#93cde6"></span><b>BB</b></span> <span class="key"><span class="bar" style="background:#2d99c8"></span><b>1B</b></span> <span class="key"><span class="bar" style="background:#54d29b"></span><b>2B</b></span> <span class="key"><span class="bar" style="background:#ffe066"></span><b>3B</b></span> <span class="key"><span class="bar" style="background:#f04542"></span><b>HR</b></span>, and white for an out.
          Bottom left is the count facing the last pitch, one box per pitch of it:
          <span class="key"><span class="sw" style="background:#60c27f"></span>balls</span>
          <span class="key"><span class="sw" style="background:#ce6664"></span>strikes</span>,
          filling upward. A bracket on the upper-left corner marks the plate appearance that opened
          the half inning, and one on the bottom-right the plate appearance that closed it. Bottom right is exit velocity in mph, flagged at 95+.</p>

        <p><b>Contact quality.</b> Top right of each box is how the ball was struck, from its exit
          velocity and launch angle, using Tango&rsquo;s
          <a href="https://tangotiger.com/index.php/site/comments/statcast-lab-barrels#37">barrel
          classification</a>: <code>BRL</code> barrel, <code>SLD</code> solid contact,
          <code>FLR</code> flare, <code>BRN</code> burner, <code>UND</code> poorly under,
          <code>TOP</code> poorly topped, <code>WEAK</code> poorly weak, <code>UNC</code>
          unclassified. Flares and burners are the same class in the original; burners are the flat
          ones, at 20&deg; or less. Strikeouts and walks have no batted ball, so no label.</p>
        <p><b>Notation.</b> <code>K</code> swinging, <code class="flip">K</code> called,
          <code>6-3</code> shortstop to first, <code>F8</code> fly to center,
          <code>L7</code> line out to left, <code>P6</code> pop to short,
          <code>3U</code> unassisted at first, <code>FC</code> fielder&rsquo;s choice.
          wOBA uses the same weights as the basepath colour, over plate appearances.</p>
        <p><b>Source.</b> Pitch-level data pulled with
          <a href="https://github.com/Blandalytics/statcast_scraper">Blandalytics/statcast_scraper</a>
          (<code>mlb_day("%s")</code>, game_pk %d) and joined to the MLB Stats API play-by-play.
          All %d tracked pitches reconcile with the official pitches-strikes line. Winning pitcher
          %s; losing pitcher %s.</p>
      </div>
    </main>
    <script>%s</script>
    """ % (escape(PAGE_TITLE), css,
           GAME_DATE, escape(d["venue"]), d["game_pk"],
           escape(w.get("condition", "")), escape(w.get("temp", "")),
           escape(w.get("wind", "")), d["pitch_count"],
           escape(nick_away), away["r"], escape(nick_home), home["r"],
           blurb(),
           linescore(),
           team_block("away"), team_block("home"),
           d["date"], d["game_pk"], d["pitch_count"],
           escape(next((p["name"] for p in d["away"]["pitchers"] + d["home"]["pitchers"]
                        if "W" in p["note"]), "—")),
           escape(next((p["name"] for p in d["away"]["pitchers"] + d["home"]["pitchers"]
                        if "L" in p["note"] and "W" not in p["note"]), "—")),
           js)
    return html


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    game_pk = int(argv[0]) if argv else 824638
    out = argv[1] if len(argv) > 1 else (
        "scorecard.html" if game_pk == 824638 else "scorecard_%d.html" % game_pk)
    data = json.load(open("scorecard_%d.json" % game_pk, encoding="utf-8"))
    html = render_html(data)
    io.open(out, "w", encoding="utf-8").write(html)
    print("wrote %s  %.1f KB" % (out, len(html.encode("utf-8")) / 1024))


if __name__ == "__main__":
    main()
