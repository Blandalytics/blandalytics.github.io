"""The three-dimensional xwOBA model: spray angle x launch angle x bat speed -> wOBA value.

A batted ball's wOBA value is one of five numbers (CLASSES / WEIGHTS), so the
model estimates the probability of each at every point of a regular 3D grid, and a
ball's xwOBA is the weighted sum of its five probabilities, read off the grid by
trilinear interpolation.

Each grid node's probabilities come from the batted balls around it, weighted by a
Gaussian kernel with one width per input: a local-linear fit (a kernel-weighted
plane through the outcomes, read at the node) rather than a plain weighted average.
The plain average is biased wherever the balls thin out: around a 80 mph swing
there are many more 75 mph swings than 85 mph ones, so it would drag the fastest
swings' home-run rate toward the slower ones'. A plane fit cancels that first-order
pull. It is computed the fast way -- the balls are counted into a histogram per
outcome on a 1-unit grid, and the sums a weighted least-squares fit needs at every
node are blurs of those histograms with a Gaussian and its derivatives
(scipy.ndimage.gaussian_filter) -- and the probabilities are then

    p_c = (N * f_c + m * q_c) / (N + m)

where f_c is the node's local-linear estimate (clipped to 0-1), N the kernel-weighted
count of balls around it (each ball weighing 1 at its own node), and q_c a prior: a
plain kernel average at `widen` times the width, itself shrunk the same way to the
league's outcome mix. Where balls are plentiful the prior disappears; where they are
scarce -- a 70-degree pop up off a 45 mph swing -- the estimate leans on its wider
neighbourhood instead of a handful of balls. degree=0 in Params uses the plain
average throughout (Nadaraya-Watson), for comparison.

A kernel of any width still flattens what is sharp: the line-drive peak at 12-13
degrees of launch angle, the dip just above it where liners carry to the
outfielders, the edges of the home-run band. Squared error barely notices (the
outcome of a single ball is mostly noise), but a hitter's xwOBA averages hundreds of
balls, so a flattened peak shortchanges the hitters who live on it. So the fit is
made twice (Tukey's "twicing"): the residuals of the first pass -- each ball's
outcome less its node's estimate -- are smoothed the same way and added back, which
restores much of what the first pass flattened. A probability the correction would
push down is kept to at least `floor` of its first-pass value, so no outcome the
first pass allowed is ever ruled out.

Inputs beyond the grid are clamped to its edge: a ball caught behind the plate is
read at the edge of foul territory, a 25 mph swing at 30 mph.

    grid = fit(df, Params())                                  # df from savant.batted_balls
    grid.xwoba(df["spray"], df["launch_angle"], df["bat_speed"])
    Grid.from_json(json.load(open("tools/xwoba/model.json")))
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np
from scipy import ndimage

# Savant's wOBA value of a ball in play is one of five numbers, the same every
# season: an out (or a sac fly), a single (also an error or a fielder's choice the
# batter reaches on), a double, a triple, a home run. The model predicts the
# probability of each; xwOBA is their weighted sum.
CLASSES = ("out", "single", "double", "triple", "home_run")
WEIGHTS = np.array([0.0, 0.90, 1.25, 1.60, 2.00])

INPUTS = ("spray", "launch_angle", "bat_speed")
TRUNCATE = 3.5  # the kernel is cut off this many widths out


@dataclass(frozen=True)
class Axis:
    """A grid axis: nodes from lo to hi in steps of step."""

    name: str
    lo: float
    hi: float
    step: float = 1.0

    @property
    def n(self) -> int:
        return int(round((self.hi - self.lo) / self.step)) + 1

    def nodes(self) -> np.ndarray:
        return self.lo + self.step * np.arange(self.n)

    def coord(self, x) -> np.ndarray:
        """Fractional node index of each x, clamped to the grid."""
        return np.clip((np.asarray(x, dtype=float) - self.lo) / self.step, 0, self.n - 1)


# Spray from 45 degrees foul of the pull line to 45 foul of the opposite line, every
# launch angle, and bat speeds from a check swing to the fastest in the league.
AXES = (Axis("spray", -45, 135), Axis("launch_angle", -90, 90), Axis("bat_speed", 30, 90))


@dataclass(frozen=True)
class Params:
    """Kernel widths in each input's own units; the prior's weight in balls and how
    much wider its kernel is; 1 for local-linear fits, 0 for plain averages; the ridge
    that steadies a fit's slopes where the balls are few or one-sided (as a share of
    the kernel's own spread); and whether to twice the fit, with the share of a
    first-pass probability the second pass keeps at least. The defaults are what
    cross-validation chose on squared error, log loss and calibration together (see
    build.py)."""

    spray: float = 3.0
    launch_angle: float = 1.5
    bat_speed: float = 6.0
    prior: float = 25.0
    widen: float = 2.0
    degree: int = 1
    ridge: float = 0.01
    twice: bool = True
    floor: float = 0.5

    def widths(self, axes) -> tuple[float, ...]:
        return tuple(getattr(self, a.name) for a in axes)


# ---- fitting -------------------------------------------------------------------------------
def histogram(df, axes=AXES) -> np.ndarray:
    """Balls per outcome per grid node, each ball at its nearest node: (classes, *axes)."""
    idx = [np.rint(a.coord(df[a.name])).astype(np.int64) for a in axes]
    shape = tuple(a.n for a in axes)
    flat = np.ravel_multi_index(idx, shape)
    outcome = np.asarray(df["outcome"], dtype=np.int64)
    size = math.prod(shape)
    counts = np.bincount(outcome * size + flat, minlength=len(CLASSES) * size)
    return counts.reshape((len(CLASSES), *shape)).astype(float)


def _gauss(a: np.ndarray, sigma: tuple[float, ...], order=0) -> np.ndarray:
    """a under a Gaussian of these widths (in nodes), or one of its derivatives,
    scaled so a ball weighs 1 at its own node."""
    scale = math.prod(math.sqrt(2 * math.pi) * s for s in sigma)
    blurred = ndimage.gaussian_filter(a, sigma, order=order, mode="constant", truncate=TRUNCATE)
    return blurred * scale


def _blur(hist: np.ndarray, sigma: tuple[float, ...]) -> np.ndarray:
    """Kernel-weighted counts of each class around every node."""
    return np.stack([_gauss(h, sigma) for h in hist])


def _shrink(counts: np.ndarray, prior: np.ndarray, m: float) -> np.ndarray:
    """(S_c + m q_c) / (N + m), with q broadcast against S."""
    return (counts + m * prior) / (counts.sum(axis=0) + m)


def _moments(a: np.ndarray, sigma: tuple[float, ...]) -> list[np.ndarray]:
    """Around every node x0, sum K(u) a and sum K(u) a u_j for each axis j, u = x - x0
    in nodes. The derivative of a Gaussian blur is the blur against -g'(u) = u g / s^2."""
    d = len(sigma)
    first = [s * s * _gauss(a, sigma, [int(i == j) for i in range(d)]) for j, s in enumerate(sigma)]
    return [_gauss(a, sigma), *first]


def _second(n: np.ndarray, s0: np.ndarray, sigma: tuple[float, ...], j: int, k: int) -> np.ndarray:
    """Sum K(u) n u_j u_k around every node: u^2 g = s^4 g'' + s^2 g along one axis,
    and u_j u_k K = s_j^2 s_k^2 times the mixed derivative across two."""
    order = [int(i == j) + int(i == k) for i in range(len(sigma))]
    out = sigma[j] ** 2 * sigma[k] ** 2 * _gauss(n, sigma, order)
    return out + sigma[j] ** 2 * s0 if j == k else out


def _intercept(a: list[list], b: list) -> np.ndarray:
    """x_0 of a x = b at every node at once, for a symmetric positive definite a given
    as (1 + d) x (1 + d) grids and b as 1 + d grids with a leading class axis: the last
    unknowns are eliminated into the first, so no back-substitution is needed."""
    for i in range(len(a) - 1, 0, -1):
        for r in range(i):
            f = a[r][i] / a[i][i]
            for c in range(i):
                a[r][c] = a[r][c] - f * a[i][c]
            b[r] = b[r] - f * b[i]
    return b[0] / a[0][0]


def _design(n: np.ndarray, sigma: tuple[float, ...], ridge: float) -> list[list]:
    """The left side of every node's weighted least squares, as (1 + d) x (1 + d) grids:
    the kernel-weighted count of balls N, their first and second moments about the node,
    and a ridge of ridge * N * s_j^2 on each slope."""
    d = len(sigma)
    s = _moments(n, sigma)
    a = [[s[0] + 1e-9, *s[1:]]] + [[s[j + 1]] + [None] * d for j in range(d)]
    for j in range(d):
        for k in range(j, d):
            a[j + 1][k + 1] = a[k + 1][j + 1] = _second(n, s[0], sigma, j, k)
        # an empty neighbourhood solves to zero
        a[j + 1][j + 1] = a[j + 1][j + 1] + ridge * s[0] * sigma[j] ** 2 + 1e-9
    return a


def _local_linear(y: np.ndarray, design: list[list], sigma: tuple[float, ...]) -> np.ndarray:
    """Each class's local-linear estimate at every node, (classes, *grid), from per-class
    sums on the grid: a histogram of outcomes, or of residuals."""
    per_class = [_moments(h, sigma) for h in y]
    b = [np.stack([m[i] for m in per_class]) for i in range(len(sigma) + 1)]
    return _intercept([row[:] for row in design], b)


def _normalise(p: np.ndarray) -> np.ndarray:
    return p / p.sum(axis=0)


def smooth(hist: np.ndarray, axes, params: Params) -> np.ndarray:
    """Outcome probabilities on the grid, (classes, *axes), from a histogram."""
    sigma = tuple(w / a.step for w, a in zip(params.widths(axes), axes, strict=True))
    league = hist.sum(axis=tuple(range(1, hist.ndim))) / hist.sum()
    league = league.reshape((-1,) + (1,) * (hist.ndim - 1))
    wide = _shrink(_blur(hist, tuple(s * params.widen for s in sigma)), league, params.prior)
    if params.degree == 0:
        return _shrink(_blur(hist, sigma), wide, params.prior)
    n = hist.sum(axis=0)
    design = _design(n, sigma, params.ridge)
    count = design[0][0]
    est = np.clip(_local_linear(hist, design, sigma), 0, 1)
    p = _normalise(_shrink(count * est, wide, params.prior))
    if params.twice:
        # the residuals' fit, trusted as far as the first pass trusts its own
        fix = _local_linear(hist - n * p, design, sigma) * (count / (count + params.prior))
        p = _normalise(np.maximum(p + fix, params.floor * p))
    return p


def fit(df, params: Params | None = None, axes=AXES) -> Grid:
    params = params or Params()
    return Grid(axes, smooth(histogram(df, axes), axes, params), params)


# ---- the fitted model ------------------------------------------------------------------------
class Grid:
    """Outcome probabilities on a grid over some of INPUTS (all three for the model;
    fewer for the ablations in evaluate.py)."""

    def __init__(self, axes, probs: np.ndarray, params: Params | None = None):
        self.axes = tuple(axes)
        self.probs = probs
        self.params = params

    def predict(self, *inputs) -> np.ndarray:
        """(n, classes) probabilities for inputs given in the order of the axes."""
        coords = np.vstack([a.coord(x) for a, x in zip(self.axes, inputs, strict=True)])
        return np.column_stack(
            [ndimage.map_coordinates(p, coords, order=1, mode="nearest") for p in self.probs]
        )

    def predict_frame(self, df) -> np.ndarray:
        return self.predict(*(df[a.name] for a in self.axes))

    def xwoba(self, *inputs) -> np.ndarray:
        return self.predict(*inputs) @ WEIGHTS

    def surface(self) -> np.ndarray:
        """xwOBA at every grid node."""
        return np.tensordot(WEIGHTS, self.probs, axes=1)

    def coarsen(self, strides: tuple[int, ...]) -> Grid:
        """Every k-th node of each axis, k per axis (the end kept when it falls on a k)."""
        axes = tuple(
            Axis(a.name, a.lo, a.lo + a.step * k * ((a.n - 1) // k), a.step * k)
            for a, k in zip(self.axes, strides, strict=True)
        )
        sl = tuple(slice(None, None, k) for k in strides)
        return Grid(axes, self.probs[(slice(None), *sl)], self.params)

    # Probabilities are stored as integers in units of 1/SCALE; the out class is
    # whatever is left, so a stored node always sums to one.
    SCALE = 10_000

    def to_json(self, meta: dict) -> dict:
        hits = np.rint(self.probs[1:] * self.SCALE).astype(int)
        return {
            **meta,
            "inputs": [a.name for a in self.axes],
            "axes": {a.name: {"lo": a.lo, "hi": a.hi, "step": a.step, "n": a.n} for a in self.axes},
            "classes": list(CLASSES),
            "weights": WEIGHTS.tolist(),
            "params": asdict(self.params) if self.params else None,
            "scale": self.SCALE,
            "layout": "row-major over inputs, the last fastest; out = scale - sum of the others",
            "probs": {c: hits[i].ravel().tolist() for i, c in enumerate(CLASSES[1:])},
        }

    @classmethod
    def from_json(cls, obj: dict) -> Grid:
        axes = tuple(
            Axis(name, **{k: v for k, v in obj["axes"][name].items() if k != "n"})
            for name in obj["inputs"]
        )
        shape = tuple(a.n for a in axes)
        hits = (
            np.stack(
                [
                    np.asarray(obj["probs"][c], dtype=float).reshape(shape)
                    for c in obj["classes"][1:]
                ]
            )
            / obj["scale"]
        )
        probs = np.concatenate([1.0 - hits.sum(axis=0, keepdims=True), hits])
        params = Params(**obj["params"]) if obj.get("params") else None
        return cls(axes, probs, params)
