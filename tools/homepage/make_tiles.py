"""Crop the captured app PNGs (from grab_app_pngs.py) into uniform tile images.

Every tile is square: cropped from the export, or padded out with the figure's own
background where a crop would cut text at the edges. Model Drilldown's is put together from
its 16:9 card: the card's header and its waterfall tile only (waterfall_tile).
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

import numpy as np
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
    "series-win": None,              # square already: the title and wordmark sit at the edges
    "model-drilldown": "waterfall",  # the card's header over its waterfall tile (waterfall_tile)
    "auction-calculator": (0.0, 0.0),  # top of the values table: names, dollars, the first stats
    "nhl-draft": (0.0, 0.0),         # top of the options table
    "projection-drilldown": None,        # padded: the player's card over the whole waterfall card
    "playing-time-risk": (0.0, 0.0),     # top of the leaderboard
    "promotion-timelines": (0.0, 0.0),   # top of the leaderboard
    "lineup-sims": (0.0, 0.0),           # the KPIs and the comparison strips
    "game-sim": None,                    # square already: the score grid's share image
    "created-runs": (0.0, 0.0),          # the title over the top of the leaderboard: names, CR and the batting columns
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


# Model Drilldown's card (model-drilldown/card.js) is 1280 x 720 in its own units; the export
# is a multiple of that. Its header runs to y 124, the tiles from y 133 to 663, and the
# waterfall tile ends at x 810 (its left edge moves with the width of the arsenal tile).
CARD_W, HEAD_B, TILE_T, TILE_B, WATERFALL_R = 1280, 124, 133, 663, 810


def waterfall_tile(name):
    """A square of the card's ground: the card's header (the pitcher, pitch type and season on
    the left, the score on the right) over its waterfall tile, centred, and the wordmark in the
    corner, each cut from the export at its own size."""
    im = Image.open(CACHE / f"{name}.png").convert("RGB")
    w, h = im.size
    k = w / CARD_W
    ground = im.getpixel((4, 4))

    arr = np.asarray(im, dtype=np.int16)
    off = np.abs(arr - np.array(ground, dtype=np.int16)).sum(axis=2)  # distance from the ground

    def ink(x0, y0, x1, y1):
        """The box of everything that is not the ground in a region."""
        ys, xs = np.nonzero(off[y0:y1, x0:x1] > 40)
        return (x0 + xs.min(), y0 + ys.min(), x0 + xs.max() + 1, y0 + ys.max() + 1) if len(xs) else None

    # the waterfall tile: from the right edge, back along a row just inside its top to the ground
    y = round((TILE_T + 6) * k)
    x = round((WATERFALL_R - 4) * k)
    while x > 0 and off[y, x] > 12:
        x -= 1
    panel = im.crop((x + 1, round(TILE_T * k), round(WATERFALL_R * k), round(TILE_B * k)))
    # the header: the title block on the left, the score (without its divider) on the right
    head = ink(0, 0, round(w * 0.7), round(HEAD_B * k))
    score = ink(round(w * 0.78), 0, w, round(HEAD_B * k))
    # the wordmark: the ink under the tiles, right of the waterfall's edge
    mark = ink(round((WATERFALL_R + 12) * k), round((TILE_B + 2) * k), w, h)
    n = h  # the square: as tall as the card
    tile = Image.new("RGB", (n, n), ground)
    margin = round(34 * k)
    tile.paste(im.crop((0, 0, head[2], head[3])), (0, 0))
    sx = n - margin - (score[2] - score[0])
    if sx < head[2] + margin:
        raise ValueError(f"{name}: the title runs into the score")
    tile.paste(im.crop((score[0], 0, score[2], score[3])), (sx, 0))
    tile.paste(panel, ((n - panel.width) // 2, round(TILE_T * k)))
    # the wordmark at the card's own distance from the corner
    tile.paste(im.crop(mark), (n - (w - mark[0]), n - (h - mark[1])))
    save(name, tile.resize((WIDTH, WIDTH), Image.LANCZOS))
    print(f"tile-{name} from {w}x{h}: header, waterfall tile {panel.width}x{panel.height}, wordmark on {n}x{n}")


def crop(name, anchor):
    if anchor == "waterfall":
        return waterfall_tile(name)
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
