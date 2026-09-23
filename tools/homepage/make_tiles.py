"""Crop the captured app PNGs (from grab_app_pngs.py) into uniform tile images.

Phantom sizes each tile from its image's aspect ratio, so every crop shares one ratio.
Name tiles on the command line to redo only those (make_tiles.py batted-balls); with no
names, every tile is redone from whatever exports are in the cache.

Cloudflare and browsers hold images for hours under their exact URL, so each tile's <img>
in index.html carries a ?v= number, and a tile that comes out different gets its number
bumped here. Commit index.html along with the image.
"""
import re
import sys
from pathlib import Path

from PIL import Image

CACHE = Path(__file__).parent / "cache"
IMAGES = Path(__file__).resolve().parents[2] / "images"
INDEX = IMAGES.parent / "index.html"
RATIO = 353 / 326  # the template's original tile aspect ratio
WIDTH = 900

# Where to anchor each crop: the part of the app output that reads best as a thumbnail.
# None pads the figure out to the tile's shape with its own background colour instead.
CROPS = {
    "pitcher-cards": (0.0, 0.0),     # name, grades, usage and movement plots
    "sequencing-flow": (0.0, 0.5),   # the Sankey body
    "swing-profiles": (0.5, 0.0),
    "batted-balls": None,            # padded, not cropped: the wordmark and data credit sit at the edges
    "release-angles": (0.5, 0.0),   # the figure with its title; trims the footer
    "nhl-draft": (0.0, 0.0),         # top of the options table
}


def save(name, tile):
    path = IMAGES / f"tile-{name}.png"
    before = path.read_bytes() if path.exists() else None
    tile.save(path, optimize=True)
    if path.read_bytes() == before:
        return
    html = INDEX.read_text(encoding="utf-8")
    pattern = rf'(src="images/tile-{re.escape(name)}\.png\?v=)(\d+)(")'
    html, n = re.subn(pattern, lambda m: f"{m[1]}{int(m[2]) + 1}{m[3]}", html)
    if n:
        INDEX.write_text(html, encoding="utf-8")
        print(f"  index.html: tile-{name}.png is new, its ?v= bumped")


def crop(name, anchor):
    im = Image.open(CACHE / f"{name}.png").convert("RGB")
    w, h = im.size
    if anchor is None:
        pw, ph = max(w, round(h * RATIO)), max(h, round(w / RATIO))
        padded = Image.new("RGB", (pw, ph), im.getpixel((0, 0)))
        padded.paste(im, ((pw - w) // 2, (ph - h) // 2))
        save(name, padded.resize((WIDTH, round(WIDTH / RATIO)), Image.LANCZOS))
        print(f"tile-{name}.png from {w}x{h} padded to {pw}x{ph}")
        return
    ax, ay = anchor
    if w / h > RATIO:
        cw, ch = round(h * RATIO), h
    else:
        cw, ch = w, round(w / RATIO)
    x = round((w - cw) * ax)
    y = round((h - ch) * ay)
    tile = im.crop((x, y, x + cw, y + ch)).resize((WIDTH, round(WIDTH / RATIO)), Image.LANCZOS)
    save(name, tile)
    print(f"tile-{name}.png from {w}x{h} crop {cw}x{ch} at ({x},{y})")


only = set(sys.argv[1:])
for name, anchor in CROPS.items():
    if not only or name in only:
        crop(name, anchor)
