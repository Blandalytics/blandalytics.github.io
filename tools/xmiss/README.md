# xMiss data

`build.py` writes the data behind `/xmiss/`: every pitcher's 1-SD miss ellipses (the whole
mix and each pitch type) for every level and season in the bucket's pitch data (`data/`,
see `tools/data/README.md`). The workflow `xmiss.yml` runs it after each successful run of the data
workflow ("Build data files") and rebuilds only the level-seasons whose source files
changed (or all of them when `FORMAT` in `build.py` is bumped). Its docstring has the keys and
the file format.

The model is xMiss from the `open_command` project (`xctrl_oc/`): a 9-feature XGBoost model
of Open Command's catcher-target miss distance that needs only Statcast fields, with five
companion models of the miss vector's moments. It ships as one file, `xmiss.py`, kept in the
bucket at `xmiss/models/<sha8>/xmiss.py` and pinned by `MODEL_KEY` and `MODEL_SHA256` in
`build.py`. To change the model, upload the new file under its own hash prefix, update both
constants, and run the workflow with `force`.

By hand (wrangler's login in `website\site_logistics\tools\live`):

    python tools/xmiss/build.py --out out_dir                 # build to a folder
    python tools/xmiss/build.py --wrangler <that folder>      # build and upload
    python tools/xmiss/build.py --only mlb/2026 --force       # one level-season again
