"""Crop the captured app PNGs (from grab_app_pngs.py) into uniform tile images.

Every tile is square: cropped from the export, or padded out with the figure's own
background where a crop would cut text at the edges.
Name tiles on the command line to redo only those (make_tiles.py batted-balls); with no
names, every tile is redone from whatever exports are in the cache.

Each tile is written as WebP twice: 900 px wide (tile-NAME.webp) and 720 px
(tile-NAME-720.webp), which index.html offers through srcset. The tiles show at no more
than ~440 CSS px, so 720 covers most screens and 900 the sharper ones; together they are
about a sixth of the PNGs they replaced.

Cloudflare and browsers hold images for hours under their exact URL, so each tile's <img>
in index.html carries a ?v= number, and a tile that comes out different gets its number
bumped here (on both of its URLs). Commit index.html along with the images.
"""
import re
import sys
from pathlib import Path

from PIL import Image

CACHE = Path(__file__).parent / "cache"
IMAGES = Path(__file__).resolve().parents[2] / "images"
INDEX = IMAGES.parent / "index.html"
RATIO = 1.0  # square: the page also holds each tile to 1:1 in CSS (blandalytics.css)
WIDTH = 900
SMALL = 720
WEBP = {"quality": 82, "method": 6}

# Where to anchor each crop: the part of the app output that reads best as a thumbnail.
# None pads the figure out to the tile's shape with its own background colour instead.
CROPS = {
    "pitcher-cards": (0.0, 0.0),     # name, grades, usage and movement plots
    "sequencing-flow": (0.0, 0.5),   # the Sankey body
    "swing-profiles": None,          # padded: a square crop cuts the axis label and the wordmark
    "batted-balls": None,            # padded, not cropped: the wordmark and data credit sit at the edges
    "release-angles": (0.5, 0.0),   # the figure with its title; trims the footer
    "nhl-draft": (0.0, 0.0),         # top of the options table
}


def save(name, tile):
    """Write the tile's two WebPs; bump its ?v= in index.html if either changed."""
    small = tile.resize((SMALL, round(SMALL * tile.height / tile.width)), Image.LANCZOS)
    changed = False
    for path, im in ((IMAGES / f"tile-{name}.webp", tile), (IMAGES / f"tile-{name}-{SMALL}.webp", small)):
        before = path.read_bytes() if path.exists() else None
        im.save(path, "WEBP", **WEBP)
        changed |= path.read_bytes() != before
    if not changed:
        return
    html = INDEX.read_text(encoding="utf-8")
    ver = re.search(rf'images/tile-{re.escape(name)}\.webp\?v=(\d+)', html)
    if ver:
        new = int(ver[1]) + 1
        html = re.sub(rf'(images/tile-{re.escape(name)}(?:-{SMALL})?\.webp\?v=)\d+', rf'\g<1>{new}', html)
        INDEX.write_text(html, encoding="utf-8")
        print(f"  index.html: tile-{name} is new, its ?v= is now {new}")


def crop(name, anchor):
    im = Image.open(CACHE / f"{name}.png").convert("RGB")
    w, h = im.size
    if anchor is None:
        pw, ph = max(w, round(h * RATIO)), max(h, round(w / RATIO))
        padded = Image.new("RGB", (pw, ph), im.getpixel((0, 0)))
        padded.paste(im, ((pw - w) // 2, (ph - h) // 2))
        save(name, padded.resize((WIDTH, round(WIDTH / RATIO)), Image.LANCZOS))
        print(f"tile-{name} from {w}x{h} padded to {pw}x{ph}")
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
    print(f"tile-{name} from {w}x{h} crop {cw}x{ch} at ({x},{y})")


if __name__ == "__main__":
    only = set(sys.argv[1:])
    for name, anchor in CROPS.items():
        if not only or name in only:
            crop(name, anchor)
