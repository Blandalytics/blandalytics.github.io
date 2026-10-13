"""Render the home-page tile for the League Calendar (images/tile-league-calendar*.webp).

MLB wOBA week by week, as the page's All years chart draws it: the model's calendar curve (2027
schedule), every actual week of 2015-2026 as a dot sized by plate appearances, and their
plate-appearance-weighted average by date. Laid out as HTML in the style of the Park Factors tile
(DM Sans, Pitcher List Stats colors and wordmark), screenshotted with headless Edge at 900x900,
then written as the 900 and 720 WebPs.
Usage: python tools/park_factors/build_calendar_tile.py   (reads league-calendar/data.json)
"""
import base64
import json
import subprocess
import tempfile
from datetime import date
from pathlib import Path

from PIL import Image

from build_leaderboard import ROOT
from build_tile import EDGE, LOGO, OUT

DATA = ROOT / "league-calendar" / "data.json"
STAT = "wOBA"
CYAN, GOLD, DOT = "rgb(4,209,249)", "rgb(255,209,102)", "#9aa0b8"
# the chart's box on the 900 x 900 tile
L, R, T, B = 118, 862, 176, 742
LO, HI, STEP = 92, 108, 4


def day(md):
    """A "MM-DD" as a day of a common year, so that seasons line up by date."""
    return (date(2023, int(md[:2]), int(md[3:])) - date(2023, 1, 1)).days


def mid(w):
    return (day(w[0]) + day(w[1])) / 2


def main():
    d = json.loads(DATA.read_text(encoding="utf-8"))
    c = d["cols"].index(STAT)
    mlb = d["series"]["MLB"]
    model = mlb[str(max(d["years"]["MLB"]))]
    # the seasons the page pools in All years: past seasons that began by mid-April (not 2020)
    years = [y for y in d["years"]["MLB"] if mlb[str(y)]["obs"] and day(mlb[str(y)]["weeks"][0][0]) <= day("04-15")]
    dots = [(mid(w), o[c] / 10, pa) for y in years for w, o, pa in zip(mlb[str(y)]["weeks"], mlb[str(y)]["obs"], mlb[str(y)]["pa"]) if o]
    line = [(mid(w), v[c] / 10) for w, v in zip(model["weeks"], model["model"])]
    # their average by date: each actual week to the nearest model week, weighted by PA
    acc = [[0.0, 0] for _ in line]
    for x, v, pa in dots:
        k = min(range(len(line)), key=lambda i: abs(line[i][0] - x))
        acc[k][0] += v * pa
        acc[k][1] += pa
    avg = [(line[i][0], s / n) for i, (s, n) in enumerate(acc) if n]
    x0, x1 = min(p[0] for p in line + dots) - 3, max(p[0] for p in line + dots) + 3

    def X(x):
        return L + (x - x0) / (x1 - x0) * (R - L)

    def Y(v):
        return T + (HI - min(HI, max(LO, v))) / (HI - LO) * (B - T)

    svg = []
    for v in range(LO, HI + 1, STEP):
        base = v == 100
        svg.append(f'<line x1="{L}" x2="{R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="{"#6d7290" if base else "#3a3e5a"}" stroke-width="{2 if base else 1}"/>')
        svg.append(f'<text x="{L - 14}" y="{Y(v) + 6:.1f}" text-anchor="end" class="ax">{v}</text>')
    for mo, name in zip(range(4, 11), ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]):
        x = day(f"{mo:02d}-01")
        if x0 <= x <= x1:
            svg.append(f'<line x1="{X(x):.1f}" x2="{X(x):.1f}" y1="{T}" y2="{B}" stroke="#33374f" stroke-width="1"/>')
            svg.append(f'<text x="{X(x) + 7:.1f}" y="{B + 30}" class="ax">{name}</text>')
    for x, v, pa in dots:
        r = max(2.5, min(7.0, 7 * (pa / 7000) ** 0.5))
        svg.append(f'<circle cx="{X(x):.1f}" cy="{Y(v):.1f}" r="{r:.1f}" fill="{DOT}" opacity="{0.42 if pa >= 1500 else 0.22}"/>')
    pts = " ".join(f"{X(x):.1f},{Y(v):.1f}" for x, v in avg)
    svg.append(f'<polyline points="{pts}" fill="none" stroke="{GOLD}" stroke-width="3.5" stroke-dasharray="11 8" stroke-linejoin="round"/>')
    pts = " ".join(f"{X(x):.1f},{Y(v):.1f}" for x, v in line)
    svg.append(f'<polyline points="{pts}" fill="none" stroke="{CYAN}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>')
    # the curve's low and high, labeled
    for (x, v), dy in ((min(line, key=lambda p: p[1]), 34), (max(line, key=lambda p: p[1]), -20)):
        svg.append(f'<circle cx="{X(x):.1f}" cy="{Y(v):.1f}" r="8" fill="{CYAN}" stroke="rgb(41,44,66)" stroke-width="3"/>')
        # the label on a slight shade of the ground, so it reads over the dots (DM Sans Bold
        # at 19 px: about 11 px a digit, 5 px the point, 14 px above the baseline)
        text, ty = f"{v:.1f}", Y(v) + dy
        w = 11 * sum(ch.isdigit() for ch in text) + 5 * text.count(".")
        svg.append(f'<rect x="{X(x) - w / 2 - 6:.1f}" y="{ty - 18:.1f}" width="{w + 12}" height="22" rx="5" fill="rgba(41,44,66,0.8)"/>')
        svg.append(f'<text x="{X(x):.1f}" y="{ty:.1f}" text-anchor="middle" class="lab">{text}</text>')

    logo = "data:image/png;base64," + base64.b64encode(LOGO.read_bytes()).decode()
    html = TEMPLATE.format(logo=logo, svg="".join(svg), first=min(years), last=max(years), cyan=CYAN, gold=GOLD, dot=DOT)
    OUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        page, png = Path(tmp) / "tile.html", Path(tmp) / "tile.png"
        page.write_text(html, encoding="utf-8")
        subprocess.run([EDGE, "--headless", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=5000",
                        f"--screenshot={png}", "--window-size=900,900", page.as_uri()], check=True)
        im = Image.open(png).convert("RGB").crop((0, 0, 900, 900))
    im.save(OUT / "tile-league-calendar.webp", quality=88, method=6)
    im.resize((720, 720), Image.LANCZOS).save(OUT / "tile-league-calendar-720.webp", quality=88, method=6)
    print("wrote", OUT / "tile-league-calendar.webp", OUT / "tile-league-calendar-720.webp")


TEMPLATE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=block">
<style>
html,body{{margin:0; width:900px; height:900px; overflow:hidden; background:rgb(41,44,66); font-family:"DM Sans",sans-serif; color:#fff}}
.wrap{{position:relative; padding:28px 40px 0 90px; height:900px; box-sizing:border-box}}
h1{{margin:0; font-size:36px; font-weight:700; color:rgb(4,209,249); letter-spacing:-.01em}}
.sub{{margin-top:4px; font-size:21px; color:#9aa0b8}}
.logo{{position:absolute; top:27px; right:32px; width:236px}}
svg{{position:absolute; left:0; top:0}}
svg text{{font-family:"DM Sans",sans-serif}}
.ax{{fill:#c0c4d3; font-size:17px}}
.lab{{fill:#fff; font-size:19px; font-weight:700}}
.key{{position:absolute; left:90px; top:794px; display:flex; gap:26px; font-size:16px; color:#c0c4d3; align-items:center}}
.key span{{display:inline-flex; align-items:center; gap:9px}}
.key i{{display:inline-block}}
.note{{position:absolute; left:90px; bottom:24px; font-size:15px; color:#9aa0b8; line-height:1.35}}
</style></head><body><div class="wrap">
<h1>MLB wOBA Factor, by Week</h1>
<div class="sub">{first}&ndash;{last}</div>
<img class="logo" src="{logo}">
</div>
<svg width="900" height="900" viewBox="0 0 900 900">{svg}</svg>
<div class="key">
<span><i style="width:30px;height:6px;border-radius:3px;background:{cyan}"></i>Model curve</span>
<span><i style="width:12px;height:12px;border-radius:50%;background:{dot};opacity:.7"></i>Actual weeks</span>
<span><i style="width:30px;height:4px;background:repeating-linear-gradient(90deg,{gold} 0 11px,transparent 11px 19px)"></i>Their average</span>
</div>
<div class="note">100 = MLB Season Average</div>
</body></html>"""

if __name__ == "__main__":
    main()
