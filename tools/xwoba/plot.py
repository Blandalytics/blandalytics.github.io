"""The fitted model as a picture: tools/xwoba/surface.png.

Three slices of the 3D surface -- xwOBA over spray angle and launch angle -- at a
slow, a typical and a fast swing (the 10th, 50th and 90th percentiles of bat speed
on balls in play), on one colour scale, with the Batted Ball Charts page's guide
lines (pull / centre / oppo at 30 and 60 degrees; ground ball / line drive / fly
ball / pop up at 10, 25 and 50 degrees of launch angle).

    python tools/xwoba/plot.py                       # model.json -> surface.png
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from model import Grid  # noqa: E402

SPEEDS = ((64.6, "Slow swing"), (71.9, "Typical swing"), (77.8, "Fast swing"))
SPRAY = (0.0, 90.0)
LAUNCH = (-40.0, 70.0)
TOP = 1.4  # the scale tops out here; only the heart of the home-run band goes past it

# one hue, light to dark: near zero recedes into the page
BLUES = ["#f3f8fe", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
INK, MUTED, RULE = "#1f2328", "#59636e", "#d1d9e0"


def slice_at(grid: Grid, bat_speed: float, step: float = 0.5) -> np.ndarray:
    """xwOBA on a spray x launch-angle mesh at one bat speed, launch angle down the rows."""
    s = np.arange(SPRAY[0], SPRAY[1] + step, step)
    la = np.arange(LAUNCH[0], LAUNCH[1] + step, step)
    S, L = np.meshgrid(s, la)
    return grid.xwoba(S.ravel(), L.ravel(), np.full(S.size, bat_speed)).reshape(S.shape)


def panel(ax, z: np.ndarray, title: str, cmap):
    im = ax.imshow(
        z,
        origin="lower",
        extent=(*SPRAY, *LAUNCH),
        aspect="auto",
        cmap=cmap,
        vmin=0,
        vmax=TOP,
        interpolation="bilinear",
    )
    for x in (30, 60):
        ax.axvline(x, color="white", lw=0.8, alpha=0.7)
    for y in (10, 25, 50):
        ax.axhline(y, color="white", lw=0.8, alpha=0.7)
    ax.set_title(title, color=INK, fontsize=11, loc="left")
    ax.set_xticks([15, 45, 75], ["Pull", "Centre", "Oppo"])
    ax.tick_params(colors=MUTED, labelsize=9, length=0)
    for side in ax.spines.values():
        side.set_visible(False)
    return im


def draw(grid: Grid, meta: dict, out: Path) -> None:
    cmap = LinearSegmentedColormap.from_list("blues", BLUES)
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.6), sharey=True, layout="constrained")
    for ax, (mph, label) in zip(axes, SPEEDS, strict=True):
        im = panel(ax, slice_at(grid, mph), f"{label}: {mph:.0f} mph", cmap)
    axes[0].set_ylabel("Launch angle (°)", color=MUTED, fontsize=10)
    axes[0].set_yticks([-30, 0, 10, 25, 50, 70])
    bar = fig.colorbar(im, ax=axes, shrink=0.85, pad=0.01, extend="max")
    bar.set_label("xwOBA", color=MUTED)
    bar.ax.tick_params(colors=MUTED, labelsize=9, length=0)
    bar.outline.set_visible(False)
    fig.suptitle(
        "xwOBA by spray direction and launch angle, at three bat speeds",
        color=INK,
        fontsize=13,
        x=0.02,
        ha="left",
    )
    note = (
        f"Fit on {meta['n']:,} MLB batted balls, {meta['from']} to {meta['through']} (Statcast"
        " bat tracking via Baseball Savant). Bat speeds are the 10th, 50th and 90th percentiles"
        " on balls in play."
    )
    fig.text(0.02, -0.03, note, color=MUTED, fontsize=8.5)
    fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--model", default=str(HERE / "model.json"))
    ap.add_argument("--out", default=str(HERE / "surface.png"))
    a = ap.parse_args(argv)
    meta = json.loads(Path(a.model).read_text())
    draw(Grid.from_json(meta), meta, Path(a.out))


if __name__ == "__main__":
    main()
