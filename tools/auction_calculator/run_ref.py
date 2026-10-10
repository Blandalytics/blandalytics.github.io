"""Run plv_viz auction_calc.py headless on local projection CSVs; print its table as JSON.

    python run_ref.py auction_calc.py hitters.csv pitchers.csv > ref.json

Settings come from ST_OVERRIDES, a JSON object keyed by widget label (as in the
script, e.g. {"League Type": "Points", "Number of Teams": 15}); "h" and "p" hold
the points tables as [[category, points], ...]. Anything unset takes the script's default.
"""
import io
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "stub"))
import pandas as pd  # noqa: E402
import streamlit as st  # noqa: E402  (the stub)
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
exec(compile(Path(script).read_text(), script, "exec"), {"__name__": "__main__"})
print(st.RESULT["df"].to_json(orient="records"))
