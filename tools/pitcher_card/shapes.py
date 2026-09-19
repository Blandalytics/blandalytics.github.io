"""The shaded regions on the movement plot: where a comparison season's pitches of each
type landed, drawn as the region holding 90% of their probability mass.

Mirrors seaborn's bivariate ``kdeplot(levels=[0.1, 1], bw_adjust=2.5, cut=2)``: a Gaussian
KDE per pitch type with Scott's bandwidth widened 2.5x, each type's density scaled by its
share of the pitches so one threshold is shared, and that threshold set where 90% of the
total mass lies above it. The regions come back as SVG path data in break inches."""

from __future__ import annotations

import contourpy
import numpy as np
from scipy.stats import gaussian_kde

GRIDSIZE = 100
CUT = 2
BW_ADJUST = 2.5
MASS = 0.9
_MOVE = 1  # matplotlib's MOVETO code, which contourpy reuses
THIN = 0.35  # inches: vertices closer than this to the last kept one are dropped


def _grid(xy: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """(x grid, y grid, density) for one pitch type, or None if a KDE cannot be fit."""
    if len(xy) < 3:
        return None
    try:
        kde = gaussian_kde(xy.T)
    except np.linalg.LinAlgError:
        return None
    kde.set_bandwidth(kde.factor * BW_ADJUST)
    bw = np.sqrt(np.diag(kde.covariance))
    lo, hi = xy.min(axis=0) - bw * CUT, xy.max(axis=0) + bw * CUT
    gx, gy = np.linspace(lo[0], hi[0], GRIDSIZE), np.linspace(lo[1], hi[1], GRIDSIZE)
    xx, yy = np.meshgrid(gx, gy)
    return gx, gy, kde(np.vstack([xx.ravel(), yy.ravel()])).reshape(xx.shape)


def _level(densities: list[np.ndarray], mass: float) -> float:
    """The density below which ``1 - mass`` of the pooled mass lies."""
    values = np.sort(np.concatenate([d.ravel() for d in densities]))[::-1]
    cumulative = np.cumsum(values) / values.sum()
    return float(values[min(np.searchsorted(cumulative, mass), len(values) - 1)])


def _tenths(v: float) -> str:
    """An integer count of tenths as a compact decimal: 123 -> '12.3', -40 -> '-4'."""
    return f"{v / 10:.1f}".rstrip("0").rstrip(".")


def _ring(points: np.ndarray) -> str:
    """One closed ring as path data: absolute start, then relative moves in tenths of an
    inch, dropping vertices that move less than ``THIN`` from the last one kept."""
    pts = np.round(points * 10).astype(int)
    parts, last = [f"M{_tenths(pts[0, 0])},{_tenths(pts[0, 1])}"], pts[0]
    for pt in pts[1:]:
        if np.hypot(*(pt - last)) >= THIN * 10:
            parts.append(f"l{_tenths(pt[0] - last[0])},{_tenths(pt[1] - last[1])}")
            last = pt
    return " ".join(parts) + "Z"


def _paths(gx: np.ndarray, gy: np.ndarray, z: np.ndarray, level: float) -> list[str]:
    """SVG path data for the filled region where the density exceeds ``level``: one
    string per outer boundary, with its holes as further rings."""
    gen = contourpy.contour_generator(gx, gy, z, fill_type=contourpy.FillType.OuterCode)
    out = []
    for points, codes in zip(*gen.filled(level, float(z.max()) + 1), strict=True):
        starts = [i for i, c in enumerate(codes) if c == _MOVE]
        rings = [points[a:b] for a, b in zip(starts, [*starts[1:], len(points)], strict=True)]
        out.append(" ".join(_ring(r[:-1]) for r in rings))  # the last point closes the ring
    return out


def shapes(points: dict[str, np.ndarray]) -> dict[str, list[str]]:
    """Path data of every pitch type's region, from {type: (n, 2) array of (HB, IVB)}."""
    total = sum(len(v) for v in points.values())
    grids = {}
    for t, xy in points.items():
        g = _grid(xy)
        if g is not None:
            grids[t] = (g[0], g[1], g[2] * len(xy) / total)
    if not grids:
        return {}
    level = _level([g[2] for g in grids.values()], MASS)
    return {t: _paths(gx, gy, z, level) for t, (gx, gy, z) in grids.items() if z.max() > level}
