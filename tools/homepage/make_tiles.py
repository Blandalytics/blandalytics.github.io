"""Crop the captured app PNGs (from grab_app_pngs.py) into uniform tile images.

Phantom sizes each tile from its image's aspect ratio, so every crop shares one ratio.
Each box is (left, top, right, bottom) as fractions of the source image.
"""
from pathlib import Path

from PIL import Image

CACHE = Path(__file__).parent / "cache"
IMAGES = Path(__file__).resolve().parents[2] / "images"
RATIO = 353 / 326  # the template's original tile aspect ratio
WIDTH = 900

# Where to anchor each crop: the part of the app output that reads best as a thumbnail.
CROPS = {
    "pitcher-cards": (0.0, 0.0),     # name, grades, usage and movement plots
    "sequencing-flow": (0.0, 0.5),   # the Sankey body
    "swing-profiles": (0.5, 0.0),
    "batted-balls": (0.5, 0.0),
    "nhl-draft": (0.0, 0.0),         # top of the options table
}


def crop(name, ax, ay):
    im = Image.open(CACHE / f"{name}.png").convert("RGB")
    w, h = im.size
    if w / h > RATIO:
        cw, ch = round(h * RATIO), h
    else:
        cw, ch = w, round(w / RATIO)
    x = round((w - cw) * ax)
    y = round((h - ch) * ay)
    tile = im.crop((x, y, x + cw, y + ch)).resize((WIDTH, round(WIDTH / RATIO)), Image.LANCZOS)
    tile.save(IMAGES / f"tile-{name}.png", optimize=True)
    print(f"tile-{name}.png from {w}x{h} crop {cw}x{ch} at ({x},{y})")


for name, (ax, ay) in CROPS.items():
    crop(name, ax, ay)
