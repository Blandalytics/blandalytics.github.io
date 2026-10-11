"""Run plv_viz auction_calc.py headless on local projection CSVs; print every player's score
(its unadjusted_value: the summed z-scores, or the points) as JSON.

    python run_ref.py auction_calc.py hitters.csv pitchers.csv > ref.json

Settings come from ST_OVERRIDES, a JSON object keyed by widget label (as in the
script, e.g. {"League Type": "Points", "Number of Teams": 15}); "h" and "p" hold
the points tables as [[category, points], ...]. Anything unset takes the script's default.
"""
import io
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "stub"))
import pandas as pd  # noqa: E402
import streamlit  # noqa: E402,F401  (the stub, in place of the real one)
from PIL import Image  # noqa: E402

script, hcsv, pcsv = sys.argv[1:4]
urllib.request.urlopen = lambda url: io.BytesIO()   # the logos
Image.open = lambda f: None
_read = pd.read_csv


def read_csv(src, *a, **k):
    # the script's default projections are Google Sheet exports: read the local files instead
    if isinstance(src, str) and "docs.google.com" in src:
        return _read(hcsv if "1029181665" in src else pcsv, encoding="utf-8-sig")
    return _read(src, *a, **k)


pd.read_csv = read_csv
scope = {"__name__": "__main__"}
exec(compile(Path(script).read_text(), script, "exec"), scope)
rows = []
for side, df in (("h", scope["projections_hitters"]), ("p", scope["projections_pitchers"])):
    for name, team, score in zip(df["Name"], df["Team"], df["unadjusted_value"]):
        rows.append({"name": name, "team": team if isinstance(team, str) else "", "side": side, "score": float(score)})
print(json.dumps(rows))
