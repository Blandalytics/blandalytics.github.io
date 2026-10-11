"""Just enough of streamlit to run auction_calc.py headless: widgets return their
default (or OVERRIDES[label]) and st.dataframe captures the result."""
import contextlib, json, os
OVERRIDES = json.loads(os.environ.get("ST_OVERRIDES", "{}"))
RESULT = {}
session_state = {}
class _Stop(Exception): pass
def cache_data(*a, **k):
    if a and callable(a[0]): return a[0]
    return lambda f: f
def _noop(*a, **k): return None
set_page_config = markdown = image = write = download_button = header = _noop
def error(msg): raise RuntimeError(msg)
def warning(msg): print("WARNING", msg, file=__import__("sys").stderr)
def stop(): raise _Stop()
@contextlib.contextmanager
def _ctx(): yield
class _Sidebar:
    def __enter__(self): return self
    def __exit__(self, *a): return False
sidebar = _Sidebar()
def columns(spec): return [_Sidebar() for _ in range(spec if isinstance(spec, int) else len(spec))]
def number_input(label, min_value=None, max_value=None, value=None, **k): return OVERRIDES.get(label, value)
def checkbox(label, value=False, **k): return OVERRIDES.get(label, value)
def radio(label, options, **k): return OVERRIDES.get(label, options[0])
def selectbox(label, options, **k): return OVERRIDES.get(label, options[0])
def multiselect(label, options, default=None, **k): return OVERRIDES.get(label, default)
def file_uploader(label, **k): return None
def data_editor(df, **k):
    import pandas as pd
    o = OVERRIDES.get(k.get("key") or ("h" if "AB" in list(df["Category"]) or "PA" in list(df["Category"]) else "p"))
    return pd.DataFrame(o, columns=["Category", "Points"]) if o is not None else df
def dataframe(df, **k): RESULT["df"] = df
class column_config:
    NumberColumn = TextColumn = SelectboxColumn = staticmethod(lambda *a, **k: None)
