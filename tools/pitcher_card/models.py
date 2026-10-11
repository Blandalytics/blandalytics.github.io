"""Expected slugging on contact, from the xSLG model in Blandalytics/player_cards.

The Stuff, Locations and PLV grades come from the pitch-modeling run values instead
(pitch_model.py); this is all that is still read out of the player_cards checkout."""

from __future__ import annotations

import glob
import os

import numpy as np
import pandas as pd
import xgboost as xgb

BIP_FEATURES = ("launch_speed", "launch_angle")


class Models:
    """The xSLG model from a Blandalytics/player_cards checkout, loaded on first use."""

    def __init__(self, root: str):
        self.xslg = xgb.XGBClassifier()
        self.xslg.load_model(max(glob.glob(os.path.join(root, "*_pl_xSLG_model.json"))))

    def xslg_con(self, df: pd.DataFrame) -> pd.Series:
        """Expected total bases per ball in play, from exit velocity and launch angle."""
        X = df[list(BIP_FEATURES)].astype(float)
        ok = X.notna().all(axis=1)
        out = pd.Series(np.nan, index=df.index)
        if ok.any():
            out[ok] = self.xslg.predict_proba(X[ok])[:, 1:] @ np.arange(1, 5)
        return out
