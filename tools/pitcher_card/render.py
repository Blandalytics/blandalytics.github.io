"""Render a card dict as a standalone HTML page.

The card is one SVG drawn in the original figure's coordinate system (15 x 20 inches at
100 dpi, so 1500 x 2000 units): every panel keeps the matplotlib axes rectangle and data
limits of the card it replaces, and text sizes are the original point sizes. The
comparison-season layers are all present, tagged ``data-cmp="<year>"``; a little script
shows the one the page's ``#cmp=`` hash asks for and can rasterise the card to a PNG."""

from __future__ import annotations

import json
import math
from html import escape

from grades import (
    BACKGROUND,
    GRADE_COLORS,
    LINE,
    LINE_TEXT,
    MARKER_COLORS,
    NAME_GRADIENT,
    TEXT,
    WHITE,
)

W, H = 1500, 2000
PT = 100 / 72  # matplotlib points -> pixels at the figure's 100 dpi
LINE_ALPHA = 2 / 3
MARKER_R = math.sqrt(300) * PT / 2  # scatter s=300 (points squared) -> radius
_ANCHOR = {"left": "start", "center": "middle", "right": "end"}
# baseline shift (em) that lands the first line where matplotlib's alignment would
_SHIFT = {"center": 0.28, "bottom": -0.2, "top": 0.72, "baseline": 0.0}
_LINE_HEIGHT = 1.2
_DASH = (3.7, 1.6)  # matplotlib's '--' pattern, in multiples of the line width


def fx(x: float) -> float:
    return x * W


def fy(y: float) -> float:
    return (1 - y) * H


def esc(s) -> str:
    return escape(str(s), quote=True)


def _fmt(v: float) -> str:
    return f"{v:.1f}"


class Axes:
    """A matplotlib-style axes: a rectangle in figure fractions plus data limits, mapping
    data coordinates to page pixels. ``equal`` shrinks the box to the data's aspect ratio,
    anchored bottom-left, as ``aspect=1`` with the SW anchor does."""

    def __init__(self, rect, xlim, ylim, equal: bool = False):
        x0, y0, w, h = rect
        width, height = w * W, h * H
        dx, dy = xlim[1] - xlim[0], ylim[1] - ylim[0]
        if equal:
            scale = min(width / abs(dx), height / abs(dy))
            width, height = abs(dx) * scale, abs(dy) * scale
        self.left, self.bottom, self.width, self.height = fx(x0), fy(y0), width, height
        self.xlim, self.ylim = xlim, ylim
        self.sx, self.sy = width / dx, height / dy

    def x(self, v: float) -> float:
        return self.left + (v - self.xlim[0]) * self.sx

    def y(self, v: float) -> float:
        return self.bottom - (v - self.ylim[0]) * self.sy

    @property
    def top(self) -> float:
        return self.bottom - self.height

    def clip(self, name: str) -> str:
        return (
            f'<clipPath id="{name}"><rect x="{_fmt(self.left)}" y="{_fmt(self.top)}" '
            f'width="{_fmt(self.width)}" height="{_fmt(self.height)}"/></clipPath>'
        )

    def transform(self) -> str:
        """An SVG transform taking data coordinates to pixels (for paths in data units)."""
        return f"translate({_fmt(self.x(0))},{_fmt(self.y(0))}) scale({self.sx:.4f},{-self.sy:.4f})"


# ---- primitives ---------------------------------------------------------------------
def text(x, y, s, size, color=WHITE, ha="center", va="center", alpha=None, attrs="") -> str:
    """A text element; ``size`` in points, alignment as matplotlib's ha / va."""
    lines = str(s).split("\n")
    shift = _SHIFT[va] - (len(lines) - 1) * _LINE_HEIGHT * {
        "center": 0.5,
        "baseline": 1,
        "bottom": 1,
    }.get(va, 0)
    spans = "".join(
        f'<tspan x="{_fmt(x)}" dy="{shift if i == 0 else _LINE_HEIGHT:.2f}em">{esc(line)}</tspan>'
        for i, line in enumerate(lines)
    )
    opacity = f' opacity="{alpha:.2f}"' if alpha is not None else ""
    return (
        f'<text x="{_fmt(x)}" y="{_fmt(y)}" font-size="{size * PT:.1f}" fill="{color}" '
        f'text-anchor="{_ANCHOR[ha]}"{opacity}{attrs}>{spans}</text>'
    )


def line(x1, y1, x2, y2, color=WHITE, width=1.5, alpha=None, dashed=False, attrs="") -> str:
    w = width * PT
    dash = f' stroke-dasharray="{_DASH[0] * w:.1f} {_DASH[1] * w:.1f}"' if dashed else ""
    opacity = f' opacity="{alpha:.2f}"' if alpha is not None else ""
    return (
        f'<line x1="{_fmt(x1)}" y1="{_fmt(y1)}" x2="{_fmt(x2)}" y2="{_fmt(y2)}" '
        f'stroke="{color}" stroke-width="{w:.1f}" stroke-linecap="round"{dash}{opacity}{attrs}/>'
    )


def border(x1, x2, y1, y2) -> str:
    """One of the card's section rules, in figure fractions."""
    return line(fx(x1), fy(y1), fx(x2), fy(y2), TEXT, 3, LINE_ALPHA)


def circle(cx, cy, r, fill="none", stroke=None, width=1.0, alpha=None, dashed=False) -> str:
    w = width * PT
    dash = f' stroke-dasharray="{_DASH[0] * w:.1f} {_DASH[1] * w:.1f}"' if dashed else ""
    stroke_attr = f' stroke="{stroke}" stroke-width="{w:.1f}"' if stroke else ""
    opacity = f' opacity="{alpha:.2f}"' if alpha is not None else ""
    return (
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(r)}" fill="{fill}"'
        f"{stroke_attr}{dash}{opacity}/>"
    )


def rect(x, y, w, h, fill="none", stroke=None, width=1.0, alpha=None, rx=0.0, ry=None) -> str:
    stroke_attr = f' stroke="{stroke}" stroke-width="{width * PT:.1f}"' if stroke else ""
    opacity = f' opacity="{alpha:.2f}"' if alpha is not None else ""
    radius = f' rx="{_fmt(rx)}" ry="{_fmt(rx if ry is None else ry)}"' if rx else ""
    return (
        f'<rect x="{_fmt(x)}" y="{_fmt(y)}" width="{_fmt(w)}" height="{_fmt(h)}" '
        f'fill="{fill}"{stroke_attr}{radius}{opacity}/>'
    )


def markers(ax: Axes, pitches: list[dict], xkey: str, ykey: str) -> list[str]:
    """The pitches on a plot: one shared marker, placed per pitch and coloured per type."""
    out = []
    for code in dict.fromkeys(p["t"] for p in pitches):
        uses = "".join(
            f'<use href="#m" x="{_fmt(ax.x(p[xkey]))}" y="{_fmt(ax.y(p[ykey]))}"/>'
            for p in pitches
            if p["t"] == code
        )
        out.append(f'<g fill="{MARKER_COLORS.get(code, MARKER_COLORS["UN"])}">{uses}</g>')
    return out


# ---- the header ---------------------------------------------------------------------
_BORDERS = (
    (0.01, 0.11, 0.815, 0.815), (0.205, 0.315, 0.815, 0.815), (0.01, 0.01, 0.715, 0.813),
    (0.305, 0.305, 0.715, 0.813), (0.01, 0.4325, 0.713, 0.713), (0.01, 0.01, 0.59, 0.688),
    (0.435, 0.435, 0.59, 0.813), (0.7725, 0.99, 0.815, 0.815), (0.425, 0.6525, 0.815, 0.815),
    (0.99, 0.99, 0.59, 0.813), (0.01, 0.99, 0.588, 0.588), (0.01, 0.12, 0.565, 0.565),
    (0.325, 0.505, 0.565, 0.565), (0.6425, 0.7825, 0.565, 0.565), (0.92, 0.99, 0.565, 0.565),
    (0.435, 0.435, 0.28, 0.563), (0.7125, 0.7125, 0.28, 0.563), (0.01, 0.01, 0.28, 0.563),
    (0.99, 0.99, 0.28, 0.563), (0.01, 0.99, 0.278, 0.278), (0.01, 0.35, 0.255, 0.255),
    (0.65, 0.99, 0.255, 0.255), (0.01, 0.01, 0.017, 0.253), (0.99, 0.99, 0.017, 0.253),
    (0.01, 0.99, 0.015, 0.015),
)  # fmt: skip


# the Pitcher List mark, as the card page sees it from pitcher-cards/cards/
LOGO = "../PitcherList_Stats_watermark_with_logo.webp"
LOGO_ASPECT = 928 / 178
ICON = "https://res.cloudinary.com/dduabusaf/image/upload/v1772839606/teal_letter_logo_owufaj.png"


def logo(href: str = LOGO) -> str:
    """The Pitcher List Stats mark, filling the width of the original's logo axes and
    sitting on its bottom edge as the image did."""
    w = fx(0.29)
    h = w / LOGO_ASPECT
    return (
        f'<image x="{_fmt(fx(0.69))}" y="{_fmt(fy(0.93) - h)}" width="{_fmt(w)}" '
        f'height="{_fmt(h)}" href="{esc(href)}"/>'
    )


def header(card: dict, logo_href: str = LOGO) -> list[str]:
    """Name, bio line, the game and its box-score line, and the Pitcher List mark."""
    size = min(150.0, 1230 / len(card["name"]))  # the original sized the name by length
    return [
        f'<text x="45" y="130.8" font-size="{size:.1f}" fill="url(#name)">'
        f"{esc(card['name'])}</text>",
        text(57, fy(0.91), card["bio"], 20, LINE, ha="left"),
        text(fx(0.5), fy(0.896), card["title"], 24),
        rect(fx(0.01), fy(0.883), fx(0.98), 86, BACKGROUND, TEXT, 3, LINE_ALPHA, rx=15),
        text(fx(0.5), fy(0.8425 + 0.037 / 2), card["line"], 30, LINE_TEXT),
        logo(logo_href),
    ]


def skills(card: dict) -> list[str]:
    """The Skills (model) and Results (box score) grades."""
    ax = Axes((0.01, 0.705, 0.295, 0.1), (0, 1), (0, 1))
    sg = Axes((0.305, 0.705, 0.13, 0.1), (0, 1), (0, 1))
    g = card["grades"]
    out = [text(fx(0.1575), fy(0.815), "Skills", 30), text(fx(0.37), fy(0.815), "Results", 25)]
    for x, label, key, size in ((0.175, "Stuff", "stuff", 22), (0.5, "Locations", "loc", 20),
                                (0.825, "PLV", "plv", 22)):  # fmt: skip
        out.append(text(ax.x(x), ax.y(0.8), label, size, LINE))
        out.append(text(ax.x(x), ax.y(0.4), g[key], 60, GRADE_COLORS[g[key]]))
    out.append(text(sg.x(0.5), sg.y(0.8), card["label"], 20, LINE))
    out.append(text(sg.x(0.5), sg.y(0.4), g["game"], 60, GRADE_COLORS[g["game"]]))
    return out


def fastball(card: dict) -> list[str]:
    """The primary fastball and its shape, coloured against its type's benchmarks."""
    fb = card["fastball"]
    name = fb["name"] if fb else "None"
    color = MARKER_COLORS[fb["code"]] if fb else MARKER_COLORS["UN"]
    # the rule around the label leaves a gap sized to the fastball's name
    lx, nx, l1, l2 = (
        (0.06, 0.25, 0.04, 0.41) if name == "Four-Seam" else (0.093, 0.283, 0.073, 0.375)
    )
    out = [
        text(fx(lx), fy(0.69), "Primary Fastball:", 24, ha="left"),
        text(fx(nx), fy(0.69), name, 28, color, ha="left"),
        border(0.01, l1, 0.69, 0.69),
        border(l2, 0.4325, 0.69, 0.69),
    ]
    ax = Axes((0.01, 0.6, 0.425, 0.082), (-0.75, 4.75), (0, 1))
    for i, stat in enumerate(fb["stats"] if fb else []):
        out.append(text(ax.x(i), ax.y(0.3), stat["text"], 30, stat["color"]))
        out.append(text(ax.x(i), ax.y(0.55), stat["label"], 24, LINE, va="bottom"))
    return out


# ---- usage --------------------------------------------------------------------------
def _pct(v: float | None) -> str:
    if v is None:
        return "-"
    return f"{v:.0f}%" if v > 0.5 or v == 0 else "< 1%"


def _arrow_spans(card: dict, code: str, key: str) -> str:
    """One usage arrow per comparison season, as tspans shown one at a time."""
    return "".join(
        f'<tspan data-cmp="{c["year"]}">{esc(c["types"].get(code, {}).get(key, ""))}</tspan>'
        for c in card["comparisons"]
    )


def _share(x: float, y: float, label: str, color: str, ha: str, spans: str) -> str:
    """A usage share with its arrows trailing it, as the original annotated them."""
    return (
        f'<text x="{_fmt(x)}" y="{_fmt(y)}" font-size="{20 * PT:.1f}" fill="{color}" '
        f'text-anchor="{_ANCHOR[ha]}"><tspan dy="{_SHIFT["center"]}em">{esc(label)}'
        f"</tspan>{spans}</text>"
    )


def usage(card: dict) -> list[str]:
    """Pitch mix against each side of the plate: bars out from the middle, the type and
    its overall usage in the gap, arrows against the comparison season."""
    types, compared = card["types"], bool(card["comparisons"])
    n = len(types)
    vs_r, vs_l = [t["vsR"] or 0 for t in types], [t["vsL"] or 0 for t in types]
    bar_lim = max(vs_r + vs_l) * 4 / 3
    fw = bar_lim / 3
    lo, hi = -(max(vs_l) + fw), max(vs_r) + fw
    xl = (max(-lo, hi) + 0.05 * (hi - lo)) * 4 / 3
    ax = Axes((0.445, 0.598, 0.535, 0.19), (-xl, xl), (n - 0.5, -0.5))
    rx, ry = 2.5 * ax.sx, 0.25 * -ax.sy
    out = [
        text(fx(0.7125), fy(0.815), "Usage", 30),
        text(fx(0.6525), fy(0.798), f"vs LHB ({card['n_vl']})", 20, LINE, ha="right"),
        text(fx(0.7725), fy(0.798), f"vs RHB ({card['n_vr']})", 20, LINE, ha="left"),
    ]
    for i, t in enumerate(types):
        color = MARKER_COLORS.get(t["code"], "#c7c7c7")
        top, height = ax.y(i - 0.4), 0.8 * -ax.sy
        out.append(rect(ax.x(0), top, (vs_r[i] + fw) * ax.sx, height, color, rx=rx, ry=ry))
        out.append(
            rect(ax.x(-(vs_l[i] + fw)), top, (vs_l[i] + fw) * ax.sx, height, color, rx=rx, ry=ry)
        )
        out.append(rect(ax.x(-fw), top, 2 * fw * ax.sx, height, BACKGROUND))
        size = min(t["usage"] or 0, 33) / 33 * 15 + 16 if n > 1 else 25
        out.append(text(ax.x(0), ax.y(i + 0.05), f"{t['code']} {t['usage']:.0f}%", size, color))
        xr = ax.x(vs_r[i] + bar_lim / 2.75)
        arrows = _arrow_spans(card, t["code"], "vsR_arrow")
        out.append(_share(xr, ax.y(i), _pct(t["vsR"]), color, "left", arrows))
        # the left share is right-aligned, so its arrows sit in their own element after it
        xl_i = ax.x(-(vs_l[i] + bar_lim / (2.2 if compared else 2.5)))
        out.append(_share(xl_i, ax.y(i), _pct(t["vsL"]), color, "right", ""))
        arrows = _arrow_spans(card, t["code"], "vsL_arrow")
        out.append(_share(xl_i, ax.y(i), "", color, "left", arrows))
    for c in card["comparisons"]:
        note = f"Arrows are vs\n{c['year']} Usage"
        out.append(text(fx(0.98), fy(0.595), note, 12, ha="right", va="baseline", alpha=0.5,
                        attrs=f' data-cmp="{c["year"]}"'))  # fmt: skip
    return out


# ---- movement -----------------------------------------------------------------------
def _rings(ax: Axes, lim: int) -> list[str]:
    """Concentric inch rings: dashed minor rings on the sixes, solid major on the twelves."""
    out = []
    for k in range(1, int((lim + 6) / 12) + 1):
        out.append(circle(ax.x(0), ax.y(0), (12 * k - 6) * ax.sx, "none", WHITE, 2, 0.1, True))
    for k in range(1, int(lim / 12) + 1):
        out.append(circle(ax.x(0), ax.y(0), 12 * k * ax.sx, "none", WHITE, 2, 0.5))
    return out


def _ring_labels(ax: Axes, lim: int) -> list[str]:
    """Each major ring's radius, on both axes."""
    out = []
    for k in range(1, int(lim / 12) + 1):
        d = 12 * k
        label, y_label = f'{d}"', d - 0.25 - 0.25 * int((lim + 6) / 12)
        spots = ((d - 0.25, -0.5, "right", "top"), (-d + 0.5, -0.5, "left", "top"),
                 (0.5, y_label, "left", "top"), (0.5, -d + 0.75, "left", "bottom"))  # fmt: skip
        for x, y, ha, va in spots:
            out.append(text(ax.x(x), ax.y(y), label, 14, WHITE, ha, va, 0.75))
    return out


def _arm_ray(ax: Axes, card: dict, lim: int) -> tuple[float, float] | None:
    """Where the arm-angle ray ends, in data units, or None without an arm angle."""
    if card["arm_angle"] is None:
        return None
    a, sign = math.radians(card["arm_angle"]), 1 if card["hand"] == "R" else -1
    return math.cos(a) * sign * lim, math.sin(a) * lim


def _arm_lines(ax: Axes, card: dict, lim: int) -> list[str]:
    """The arm-angle ray, stopping short of its label, mirrored faintly through the origin."""
    end = _arm_ray(ax, card, lim)
    if end is None:
        return []
    xv, yv = end
    short = 4 / lim  # leave room for the label at the tip
    return [
        line(
            ax.x(0),
            ax.y(0),
            ax.x(xv * (1 - short)),
            ax.y(yv * (1 - short)),
            WHITE,
            1.5,
            dashed=True,
        ),  # fmt: skip
        line(ax.x(0), ax.y(0), ax.x(-xv), ax.y(-yv), WHITE, 1.5, 0.1, dashed=True),
    ]


def _arm_label(ax: Axes, card: dict, lim: int) -> list[str]:
    end = _arm_ray(ax, card, lim)
    if end is None:
        return []
    label, size = f"{card['arm_angle']:.0f}°", 16 * PT
    w, h = (0.6 * len(label) + 0.7) * size, 1.5 * size
    return [
        rect(ax.x(end[0]) - w / 2, ax.y(end[1]) - h / 2, w, h, BACKGROUND, WHITE, 1, 0.75, rx=6),
        text(ax.x(end[0]), ax.y(end[1]), label, 16),
    ]


def _shapes(ax: Axes, card: dict) -> list[str]:
    """The comparison seasons' movement regions, one group per season."""
    out = []
    for c in card["comparisons"]:
        paths = "".join(
            f'<path d="{d}" fill="{MARKER_COLORS.get(code, "#c7c7c7")}"/>'
            for code, ds in c["shapes"].items()
            for d in ds
        )
        out.append(f'<g data-cmp="{c["year"]}" opacity="0.25" transform="{ax.transform()}">'
                   f"{paths}</g>")  # fmt: skip
    return out


def movement(card: dict) -> list[str]:
    """Horizontal against induced vertical break, with the comparison season's regions.
    Marks are clipped to the plot as matplotlib clips them; text is not, as it does not."""
    lim = card["chart_lim"]
    ax = Axes((0.03, 0.275, 0.423, 0.287), (-lim - 2, lim + 2), (-lim - 2, lim + 2), equal=True)
    right, left = "Arm\nSide", "Glove\nSide"
    if card["hand"] == "L":
        right, left = left, right
    marks = [
        line(ax.x(0), ax.y(-(lim - 4)), ax.x(0), ax.y(lim - 4), WHITE, 2, 0.5),
        line(ax.x(-(lim - 4)), ax.y(0), ax.x(lim - 4), ax.y(0), WHITE, 2, 0.5),
        *_rings(ax, lim),
        *_shapes(ax, card),
        *markers(ax, [p for p in card["pitches"] if p["hb"] is not None], "hb", "ivb"),
        *_arm_lines(ax, card, lim),
    ]
    labels = [
        *_ring_labels(ax, lim),
        text(ax.x(lim), ax.y(0), right, 16),
        text(ax.x(-lim), ax.y(0), left, 16),
        text(ax.x(0), ax.y(lim - 2), "Rise", 16),
        text(ax.x(0), ax.y(-(lim - 2)), "Drop", 16),
        *_arm_label(ax, card, lim),
    ]
    notes = [
        text(
            fx(0.02),
            fy(0.285),
            f"Shaded Regions are\n{c['year']} Shapes translated\nto current Velo",
            12,
            ha="left",
            va="baseline",
            alpha=0.5,
            attrs=f' data-cmp="{c["year"]}"',
        )  # fmt: skip
        for c in card["comparisons"]
    ]
    title = text(fx(0.2225), fy(0.565), "Movement", 30)
    return [title, ax.clip("mv"), '<g clip-path="url(#mv)">', *marks, "</g>", *labels, *notes]


# ---- locations ----------------------------------------------------------------------
SZ_BOT, SZ_TOP = 19.5 / 12, 40.5 / 12
_PLATE_Y = -0.25
_PLATE = (  # the five edges of home plate, in feet
    (-8.5 / 12, _PLATE_Y, 8.5 / 12, _PLATE_Y),
    (-8.5 / 12, _PLATE_Y, -8.25 / 12, _PLATE_Y + 0.15),
    (8.5 / 12, _PLATE_Y, 8.25 / 12, _PLATE_Y + 0.15),
    (8.28 / 12, _PLATE_Y + 0.15, 0, _PLATE_Y + 0.25),
    (-8.28 / 12, _PLATE_Y + 0.15, 0, _PLATE_Y + 0.25),
)


def _zone(ax: Axes) -> list[str]:
    """The strike zone in thirds, each line shadowed in the background colour, and the plate."""
    third = (SZ_TOP - SZ_BOT) / 3
    out = []
    for color, width, hx, dy in ((BACKGROUND, 3.5, 8 / 12, 0.05), (WHITE, 2, 8.5 / 12, 0.025)):
        vw = width if color == BACKGROUND else 3
        for k in (1, 2):
            y = ax.y(SZ_BOT + k * third)
            out.append(line(ax.x(-hx), y, ax.x(hx), y, color, width, 0.5))
        for x in (8.5 / 36, -8.5 / 36):
            out.append(line(ax.x(x), ax.y(SZ_BOT + dy), ax.x(x), ax.y(SZ_TOP - dy), color, vw, 0.5))
    w, h = 17 / 12 * ax.sx, 21 / 12 * ax.sy
    out.append(rect(ax.x(-8.5 / 12), ax.y(SZ_TOP), w, h, "none", BACKGROUND, 3, 0.5))
    out.append(rect(ax.x(-8.5 / 12), ax.y(SZ_TOP), w, h, "none", WHITE, 2, 0.5))
    out += [line(ax.x(x1), ax.y(y1), ax.x(x2), ax.y(y2), WHITE, 2) for x1, y1, x2, y2 in _PLATE]
    return out


def location(card: dict, stand: str, x0: float, grade_x0: float, grade: str, count: int):
    """Pitch locations against one side of the plate, on the standardised zone."""
    ax = Axes((x0, 0.275, 0.2675, 0.287), (-2, 2), (-0.5, 5.5), equal=True)
    name = f"loc{stand}"
    out = [ax.clip(name), f'<g clip-path="url(#{name})">', *_zone(ax)]
    shown = [p for p in card["pitches"] if p["stand"] == stand and p["x"] is not None]
    out += markers(ax, shown, "x", "z")
    out.append("</g>")
    if count:
        g = Axes((grade_x0, 0.48, 0.1, 0.1), (0, 1), (0, 1))
        out.append(text(g.x(0.5), g.y(0.7), "Locations", 15, LINE))
        out.append(text(g.x(0.5), g.y(0.45), grade, 50, GRADE_COLORS[grade]))
    return out


def locations(card: dict) -> list[str]:
    g = card["grades"]
    return [
        text(fx(0.57375), fy(0.565), "vs LHB", 30),
        text(fx(0.85125), fy(0.565), "vs RHB", 30),
        *location(card, "L", 0.445, 0.435, g["loc_vl"], card["n_vl"]),
        *location(card, "R", 0.7225, 0.7125, g["loc_vr"], card["n_vr"]),
    ]


# ---- the metrics table --------------------------------------------------------------
_HEADERS = (
    (0.085, "Type"), (0.235, "#"), (0.42, "IVB"), (0.49, "HB"), (0.57, "Str%"), (0.645, "SwStr%"),
    (0.7225, "CSW%"), (0.8025, "xSLGcon"), (0.8825, "plvStuff+"), (0.955, "PLV+"),
)  # fmt: skip
_WIDTHS = (("Velo", 0), ("IVB", 0.9), ("HB", 0.65), ("Str%", 0.75), ("SwStr%", 0.75),
           ("CSW%", 0.75), ("xSLGcon", 0.75), ("plvStuff+", 0.75), ("PLV+", 0.7))  # fmt: skip


def _velo_cell(card: dict, t: dict, ax: Axes, x: float, y: float) -> list[str]:
    """The velocity cell: coloured on its own, white with the coloured change beside it
    when a comparison season is showing."""
    cell = t["cells"]["Velo"]
    out = [text(ax.x(x), y, cell["text"], 20, cell["color"], attrs=' data-cmp="0"')]
    for c in card["comparisons"]:
        diff = c["types"].get(t["code"], {}).get("velo")
        span = (f'<tspan font-size="{16 * PT:.1f}" fill="{diff["color"]}">{esc(diff["text"])}'
                "</tspan>" if diff else "")  # fmt: skip
        out.append(
            f'<text x="{_fmt(ax.x(x - 0.15))}" y="{_fmt(y)}" font-size="{20 * PT:.1f}" '
            f'fill="{WHITE}" text-anchor="middle" data-cmp="{c["year"]}">'
            f'<tspan dy="{_SHIFT["center"]}em">{esc(cell["text"])}</tspan>{span}</text>'
        )
    return out


def metrics(card: dict) -> list[str]:
    """One row per pitch type: the colour swatch, name and count, then the stats."""
    types, n = card["types"], len(card["types"])
    out = [text(fx(0.5), fy(0.255), "Pitch Type Metrics", 30)]
    if card["missing_data"]:
        out.append(text(fx(0.632), fy(0.2575), "*", 18, alpha=0.5))
        out.append(
            text(fx(0.97), fy(0.005), "*Some pitches missing data", 12, ha="right", alpha=0.5)
        )
    out += [text(fx(x), fy(0.23), label, 16, LINE) for x, label in _HEADERS]
    out.append(text(fx(0.335), fy(0.23), "Velo", 16, LINE, attrs=' data-cmp="0"'))
    out += [text(fx(0.335), fy(0.23), f"Velo (vs '{str(c['year'])[-2:]})", 16, LINE,
                 attrs=f' data-cmp="{c["year"]}"') for c in card["comparisons"]]  # fmt: skip
    hdr = Axes((0.01, 0.015, 0.25, 0.205), (0, 1), (n - 0.5, -0.5))
    tbl = Axes((0.26, 0.015, 0.73, 0.205), (-0.5, 6.5), (n - 0.5, -0.5))
    bw = max(0.5, min(0.8, 2 / n))
    for i, t in enumerate(types):
        color, y = MARKER_COLORS.get(t["code"], "#c7c7c7"), hdr.y(i)
        out.append(rect(hdr.x(0.1), hdr.y(i - bw / 2), 0.075 * hdr.sx, bw * -hdr.sy, color, rx=4))
        out.append(text(hdr.x(0.225), y, t["name"], 20, color, ha="left"))
        out.append(text(hdr.x(0.9), y, f"{t['n']:,}", 20))
        x = 0.15
        for stat, width in _WIDTHS:
            x += width
            cell = t["cells"][stat]
            if stat == "Velo":
                out += _velo_cell(card, t, tbl, x, y)
            else:
                out.append(text(tbl.x(x), y, cell["text"], 20, cell["color"]))
    return out


# ---- the page -----------------------------------------------------------------------
def svg(card: dict, logo_href: str = LOGO) -> str:
    """The whole card as one SVG."""
    body = [
        rect(0, 0, W, H, BACKGROUND),
        *header(card, logo_href),
        *skills(card),
        *fastball(card),
        *usage(card),
        *movement(card),
        *locations(card),
        *metrics(card),
        *[border(*b) for b in _BORDERS],
    ]
    return (
        f'<svg id="card" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
        'role="img" aria-label="PLV pitcher game card">'
        "<style>text{font-family:'DM Sans',system-ui,sans-serif;font-weight:700}</style>"
        '<defs><linearGradient id="name" x1="0" y1="1" x2="0" y2="0">'
        f'<stop offset="0" stop-color="{NAME_GRADIENT[0]}"/>'
        f'<stop offset="1" stop-color="{NAME_GRADIENT[1]}"/></linearGradient>'
        f'<circle id="m" r="{_fmt(MARKER_R)}" stroke="{BACKGROUND}" stroke-width="{0.5 * PT:.1f}"/>'
        "</defs>" + "".join(body) + "</svg>"
    )


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>%(title)s</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@700&display=swap">
<link rel="icon" href="%(icon)s">
<style>
html,body{margin:0;background:%(bg)s}
body{display:flex;justify-content:center;min-height:100vh}
svg{display:block;width:100%%;max-width:1500px;height:auto}
#png{position:fixed;right:14px;bottom:14px;font:600 13px "DM Sans",system-ui,sans-serif;
  color:#fff;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.35);border-radius:6px;
  padding:7px 11px;cursor:pointer}
#png:hover{background:rgba(0,0,0,.7)}
#png[hidden]{display:none}
</style>
</head>
<body>
%(svg)s
<button id="png" type="button" hidden>Save PNG</button>
<script>
(function () {
  var years = %(years)s, filename = %(filename)s;
  function chosen() {
    var m = /cmp=(-?\\d+)/.exec(location.hash), y = m ? +m[1] : (years[0] || 0);
    return (y && years.indexOf(y) < 0) ? (years[0] || 0) : y;
  }
  function apply() {
    var y = String(chosen());
    document.querySelectorAll('[data-cmp]').forEach(function (el) {
      el.style.display = el.getAttribute('data-cmp') === y ? '' : 'none';
    });
  }
  window.addEventListener('hashchange', apply);
  apply();

  // ---- Save PNG: embed the font, serialise the SVG, draw it on a canvas at 2x ----
  var FONT = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@700&display=swap';
  function b64(buf) {
    var s = '', b = new Uint8Array(buf);
    for (var i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function fontCss() {
    return fetch(FONT).then(function (r) { return r.text(); }).then(function (css) {
      var urls = css.match(/url\\([^)]+\\)/g) || [];
      return Promise.all(urls.map(function (u) {
        return fetch(u.slice(4, -1).replace(/["']/g, ''))
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) {
            css = css.replace(u, 'url(data:font/woff2;base64,' + b64(buf) + ')');
          });
      })).then(function () { return css; });
    }).catch(function () { return ''; });
  }
  // an SVG drawn to a canvas cannot load external images, so embed the logo too
  function inlineImages(svg) {
    return Promise.all([].map.call(svg.querySelectorAll('image'), function (im) {
      return fetch(im.getAttribute('href')).then(function (r) { return r.blob(); })
        .then(function (blob) {
          return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onload = function () { im.setAttribute('href', reader.result); resolve(); };
            reader.readAsDataURL(blob);
          });
        }).catch(function () { im.remove(); });
    }));
  }
  window.savePng = function () {
    var svg = document.getElementById('card').cloneNode(true);
    svg.querySelectorAll('[data-cmp]').forEach(function (el) {
      if (el.style.display === 'none') el.remove();
    });
    return Promise.all([fontCss(), inlineImages(svg)]).then(function (got) {
      var css = got[0];
      var style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = css + " text{font-family:'DM Sans',sans-serif;font-weight:700}";
      svg.insertBefore(style, svg.firstChild);
      svg.setAttribute('width', '1500'); svg.setAttribute('height', '2000');
      var xml = new XMLSerializer().serializeToString(svg);
      var url = URL.createObjectURL(new Blob([xml], {type: 'image/svg+xml;charset=utf-8'}));
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas');
          c.width = 3000; c.height = 4000;
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          c.toBlob(function (blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = filename; a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
            resolve();
          }, 'image/png');
        };
        img.onerror = reject;
        img.src = url;
      });
    });
  };
  var btn = document.getElementById('png');
  btn.hidden = window.self !== window.top;   // the picker page has its own button
  btn.addEventListener('click', function () { window.savePng(); });
})();
</script>
</body>
</html>
"""


def page_title(card: dict) -> str:
    at = "vs" if card["home"] else "@"
    return f"{card['name']} — {card['date']} {at} {card['opp']} — PLV Pitcher Game Card"


def render_html(card: dict, logo_href: str = LOGO) -> str:
    """The standalone page for one card. ``logo_href`` is the Pitcher List mark as the
    page will see it: relative from pitcher-cards/cards/, absolute from the bucket."""
    stem = f"{card['name'].replace(' ', '_')}_{card['date']}_{card['team']}_{card['opp']}"
    return _PAGE % {
        "title": esc(page_title(card)),
        "bg": BACKGROUND,
        "icon": ICON,
        "svg": svg(card, logo_href),
        "years": json.dumps([c["year"] for c in card["comparisons"]]),
        "filename": json.dumps(f"{stem}_PLV_card.png"),
    }
