"""Render a card dict as a standalone HTML page.

The page is a shell around the dict: it carries it as JSON and has pitcher-cards/card.js
draw it, as one SVG in the original figure's coordinate system (card.js formats, colours
and lays out every panel). A little script shows the comparison season the page's
``#cmp=`` hash asks for and copies the card as a PNG."""

from __future__ import annotations

import json
from html import escape

# card.js as every page loads it, wherever the page itself is served from
SCRIPT = "https://blandalytics.com/pitcher-cards/card.js"
ICON = "https://res.cloudinary.com/dduabusaf/image/upload/v1772839606/teal_letter_logo_owufaj.png"
BACKGROUND = "#292C42"  # the card's own, around it

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
<button id="png" type="button" hidden>Copy PNG</button>
<script id="card-data" type="application/json">%(card)s</script>
<script src="%(script)s"></script>
<script>
(function () {
  var card = JSON.parse(document.getElementById('card-data').textContent);
  document.body.insertAdjacentHTML('afterbegin', PitcherCard.svg(card, %(opts)s));
  var svg = document.getElementById('card');
  function apply() {
    var m = /cmp=(-?\\d+)/.exec(location.hash);
    PitcherCard.show(svg, PitcherCard.comparisonYear(card, m ? +m[1] : null));
  }
  window.addEventListener('hashchange', apply);
  apply();

  // the button only shows once there is a card to copy; copyPng is started inside the
  // click, which the clipboard needs (see card.js)
  var btn = document.getElementById('png');
  btn.hidden = false;
  btn.addEventListener('click', function () {
    var label = btn.textContent;
    btn.disabled = true;
    var done = function (text) {
      btn.textContent = text;
      setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 1500);
    };
    PitcherCard.copyPng(svg, PitcherCard.filename(card)).then(done, function () {
      done('Copy failed');
    });
  });
})();
</script>
</body>
</html>
"""


def page_title(card: dict) -> str:
    at = "vs" if card["home"] else "@"
    return f"{card['name']} — {card['date']} {at} {card['opp']} — PLV Pitcher Game Card"


def _script_json(data) -> str:
    """JSON to sit inside a <script>: with no '<' in it at all, nothing in the data can
    close the element (or open a comment). NaN is refused, as JSON.parse would."""
    text = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return text.replace("<", "\\u003c")


def render_html(card: dict, script_src: str = SCRIPT, logo: str | None = None) -> str:
    """The standalone page for one card, drawn by card.js from ``script_src``. ``logo``
    is the Pitcher List mark's URL as the page will see it, when not card.js's own."""
    return _PAGE % {
        "title": escape(page_title(card), quote=True),
        "bg": BACKGROUND,
        "icon": ICON,
        "card": _script_json(card),
        "script": escape(script_src, quote=True),
        "opts": _script_json({"logo": logo} if logo else {}),
    }
