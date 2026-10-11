"""Render the home-page tile for the park factor leaderboard (images/tile-park-factors*.webp).

Lays the tile out as HTML (DM Sans from Google Fonts, Pitcher List Stats colors),
screenshots it with headless Edge at 900x900, then writes the 900 and 720 WebPs.
Usage: python tools/park_factors/build_tile.py   (reads park_factors_2027.csv)
(tile_logo.png is the PITCHERLIST STATS wordmark, cropped from the Series Win tile)
"""
import base64
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

from build_leaderboard import ROOT, load

HERE = Path(__file__).parent
OUT = ROOT / "images"
LOGO = HERE / "tile_logo.png"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

BG, RED, BLUE = (41, 44, 66), (188, 48, 57), (0, 47, 134)
COLS = ["Park Factor", "R", "HR", "2B", "3B", "BB", "SO"]
HEADS = ["PF", "R", "HR", "2B", "3B", "BB", "SO"]
N = 7  # parks shown from each end


def shade(v, col):
    t = max(-1, min(1, (v - 100) / 10)) * (-1 if col == "SO" else 1)
    to, a = (RED if t >= 0 else BLUE), abs(t)
    return "rgb({},{},{})".format(*(round(b + (c - b) * a) for b, c in zip(BG, to)))


def rows_html(rows, ci):
    out = []
    for r in rows:
        cells = "".join(f'<td style="background:{shade(r[ci[c]], c)}">{r[ci[c]]}</td>' for c in COLS)
        out.append(f'<tr><th>{r[ci["Venue"]]}</th>{cells}</tr>')
    return "".join(out)


def main():
    cols, rows, _ = load()
    ci = {c: i for i, c in enumerate(cols)}
    mlb = [r for r in rows if r[ci["Level"]] == "MLB" and r[ci["Side"]] == "All" and r[ci["Games"]] > 50]
    mlb.sort(key=lambda r: -r[ci["Park Factor"]])
    logo_uri = "data:image/png;base64," + base64.b64encode(LOGO.read_bytes()).decode()
    gap = f'<tr class="gap"><th>⋮</th>{"<td></td>" * len(COLS)}</tr>'
    html = TEMPLATE.format(
        logo=logo_uri,
        head="".join(f"<td>{h}</td>" for h in HEADS),
        body=rows_html(mlb[:N], ci) + gap + rows_html(mlb[-N:], ci),
    )
    OUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        page, png = Path(tmp) / "tile.html", Path(tmp) / "tile.png"
        page.write_text(html, encoding="utf-8")
        subprocess.run([EDGE, "--headless", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=5000",
                        f"--screenshot={png}", "--window-size=900,900", page.as_uri()], check=True)
        im = Image.open(png).convert("RGB").crop((0, 0, 900, 900))
    im.save(OUT / "tile-park-factors.webp", quality=88, method=6)
    im.resize((720, 720), Image.LANCZOS).save(OUT / "tile-park-factors-720.webp", quality=88, method=6)
    print("wrote", OUT / "tile-park-factors.webp", OUT / "tile-park-factors-720.webp")


TEMPLATE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=block">
<style>
html,body{{margin:0; width:900px; height:900px; overflow:hidden; background:rgb(41,44,66); font-family:"DM Sans",sans-serif; color:#fff}}
.wrap{{position:relative; padding:28px 40px 0 90px; height:900px; box-sizing:border-box}}
h1{{margin:0; font-size:36px; font-weight:700; color:rgb(4,209,249); letter-spacing:-.01em}}
.sub{{margin-top:4px; font-size:21px; color:#9aa0b8}}
.logo{{position:absolute; top:27px; right:32px; width:236px}}
table{{margin-top:30px; border-collapse:separate; border-spacing:4px; width:780px; margin-left:-48px}}
thead td{{color:#c0c4d3; font-size:17px; text-align:center; padding-bottom:4px}}
tbody th{{text-align:right; font-weight:500; font-size:17px; padding-right:12px; white-space:nowrap; color:#e8eaf2}}
tbody td{{width:62px; height:37px; text-align:center; font-size:18px; font-weight:500; border-radius:3px}}
tr.gap th{{text-align:right; padding-right:12px; color:#9aa0b8; height:14px; padding:0; font-size:15px; line-height:14px}}
tr.gap td{{height:14px; background:none}}
.note{{position:absolute; left:90px; bottom:24px; font-size:15px; color:#9aa0b8; line-height:1.35}}
</style></head><body><div class="wrap">
<h1>MLB Park Factors</h1>
<div class="sub">2027 Schedule, All Batters</div>
<img class="logo" src="{logo}">
<table><thead><tr><td></td>{head}</tr></thead><tbody>{body}</tbody></table>
<div class="note">100 = league-average park. Red helps hitters, blue hurts them<br>(SO flipped). Adjusted for batter and pitcher.</div>
</div></body></html>"""

if __name__ == "__main__":
    main()
