"""Score pitches with the PLV model set: plvStuff+, PLV+, the stuff / location / PLV game
grades, and expected slugging on contact from the xSLG model.

The models are XGBoost classifiers saved as JSON in Blandalytics/player_cards. Each of the
three kinds (stuff, loc, plv) is a chain per pitch-type bucket: swing decision, take
result, contact, ball in play, launch angle and, per launch-angle band, exit velocity.
Multiplying down the chain gives the probability of every outcome; weighting those by
run expectancy gives the pitch's expected run value, which the grades standardise."""

from __future__ import annotations

import glob
import os

import numpy as np
import pandas as pd
import xgboost as xgb

KINDS = ("stuff", "loc", "plv")
BUCKETS = ("Fastball", "Breaking Ball", "Offspeed")
ANGLES = ("10deg", "10-20deg", "20-30deg", "30-40deg", "40-50deg")
SPEEDS = ("<90mph", "90-95mph", "95-100mph", "100-105mph", "105+mph")
BIP = ("out", "single", "double", "triple", "home_run")
TAKE = ("called_strike", "ball", "hit_by_pitch")  # the take model's class order
PLUS = {"stuff": "plvStuff+", "plv": "PLV+"}
ER_PER_PITCH = 0.028  # baseline run cost of a pitch in the loc and plv models
GRADE_COLUMNS = ("plvStuff+", "PLV+", "stuffGrade_game", "locGrade_game", "plvGrade_game")

# fmt: off
CONSTANTS = {
    "stuff": {"game_mean": -0.02747813136823752, "game_stdev": 0.005869834959077604,
              "type_mean": -0.028738238949820687, "type_stdev": 0.011430978492415197},
    "loc": {"game_mean": 0.02548073942085139, "game_stdev": 0.005903751642468741},
    "plv": {"game_mean": 0.026026814369463608, "game_stdev": 0.0066423118920167805,
            "type_mean": 0.025848696619494765, "type_stdev": 0.013552982352747826},
}
# run value of each outcome in the stuff model, which knows no count, by pitch bucket
STUFF_RE = pd.DataFrame({
    "swinging_strike": [
        -0.1053813621864279, -0.1104318190294043, -0.1145435791680625, -0.0760078083199719,
    ],
    "foul_strike": [
        -0.0462360894289398, -0.0415816524014541, -0.0415531830483154, -0.0560926896377042,
    ],
    "out": [-0.2687157273447406, -0.2510515555787339, -0.2470170992679954, -0.2837690854680377],
    "single": [0.4674164837545079, 0.4831367119447007, 0.4854555297927654, 0.4563555172520269],
    "double": [0.7752658636798753, 0.7915046342126995, 0.7929954112089747, 0.7646084231502644],
    "triple": [1.0478652816999288, 1.0624764710745118, 1.0664637712213845, 1.0399900834408449],
    "home_run": [1.3933632222762573, 1.4082245958731214, 1.4099360454039978, 1.384199438932331],
}, index=[*BUCKETS, "Other"])
# fmt: on

HANDS = ("L", "R")
ONE_HOT = (
    *(f"pitcherHand_{h}" for h in HANDS),
    *(f"hitterHand_{h}" for h in HANDS),
    *(f"balls_before_pitch_{b}" for b in range(4)),
    *(f"strikes_before_pitch_{s}" for s in range(3)),
)


def one_hot(df: pd.DataFrame) -> pd.DataFrame:
    """The categorical model inputs as 0/1 columns, every level present."""
    out = pd.DataFrame(index=df.index)
    for h in HANDS:
        out[f"pitcherHand_{h}"] = (df["hand"] == h).astype(float)
        out[f"hitterHand_{h}"] = (df["stand"] == h).astype(float)
    for b in range(4):
        out[f"balls_before_pitch_{b}"] = (df["balls"] == b).astype(float)
    for s in range(3):
        out[f"strikes_before_pitch_{s}"] = (df["strikes"] == s).astype(float)
    return out


def _load(path: str) -> xgb.XGBClassifier:
    model = xgb.XGBClassifier()
    model.load_model(path)
    return model


class Models:
    """The model files from a Blandalytics/player_cards checkout, loaded on first use."""

    def __init__(self, root: str):
        self.root = root
        self._models: dict[str, xgb.XGBClassifier] = {}
        self.bip = self._bip_matrix(os.path.join(root, "bip_dict.csv"))
        self.re = self._re_table(os.path.join(root, "re_12_vals.csv"))
        self.xslg = _load(max(glob.glob(os.path.join(root, "*_pl_xSLG_model.json"))))

    @staticmethod
    def _bip_matrix(path: str) -> np.ndarray:
        """Outcome shares by (launch angle, exit velocity) cell, popups last."""
        table = pd.read_csv(path).set_index("bb_bucket")
        rows = [f"{a}: {s}" for a in ANGLES for s in SPEEDS] + ["50+deg"]
        return table.loc[rows, list(BIP)].to_numpy()

    @staticmethod
    def _re_table(path: str) -> pd.DataFrame:
        """Run value of each outcome by count; a hit by pitch is worth a ball."""
        table = pd.read_csv(path).pivot(index="count", columns="cleaned_description")["delta_re"]
        table["hit_by_pitch"] = table["ball"]
        return table

    def _proba(self, stage: str, bucket: str, kind: str, X: pd.DataFrame) -> np.ndarray:
        name = f"statcast_{stage}_model_{bucket}_{kind}.json"
        if name not in self._models:
            self._models[name] = _load(os.path.join(self.root, "model_files", name))
        model = self._models[name]
        return model.predict_proba(X[list(model.feature_names_in_)].astype(float))

    def _chain(self, kind: str, bucket: str, X: pd.DataFrame) -> pd.DataFrame:
        """Outcome probabilities for the pitches of one bucket, multiplied down the chain."""
        probs = {}
        if kind == "stuff":
            swing_strike, contact = self._proba("contact", bucket, kind, X).T
        else:
            take, swing = self._proba("swing", bucket, kind, X).T
            probs.update(zip(TAKE, self._proba("take", bucket, kind, X).T * take, strict=True))
            swing_strike, contact = self._proba("contact", bucket, kind, X).T * swing
        foul, in_play = self._proba("in_play", bucket, kind, X).T * contact
        angle = self._proba("launch_angle", bucket, kind, X) * in_play[:, None]
        cells = [self._proba(a, bucket, kind, X) * angle[:, [i]] for i, a in enumerate(ANGLES)]
        bip = np.hstack([*cells, angle[:, [5]]]) @ self.bip
        probs.update(
            swinging_strike=swing_strike, foul_strike=foul, **dict(zip(BIP, bip.T, strict=True))
        )
        return pd.DataFrame(probs, index=X.index)

    def _probs(self, kind: str, df: pd.DataFrame, X: pd.DataFrame) -> pd.DataFrame:
        """Outcome probabilities for every pitch; NaN for buckets the models do not cover."""
        frames = [
            self._chain(kind, b, X[df["bucket"] == b]) for b in BUCKETS if (df["bucket"] == b).any()
        ]
        if not frames:
            return pd.DataFrame(
                index=df.index, columns=[*TAKE, "swinging_strike", "foul_strike", *BIP]
            )
        return pd.concat(frames).reindex(df.index)

    def _delta_re(self, kind: str, df: pd.DataFrame, probs: pd.DataFrame) -> pd.Series:
        """Expected run value of each pitch: outcome probabilities times run expectancies.
        Pitches the models skip take the median probabilities, as the original did."""
        if kind == "stuff":
            re, base = STUFF_RE.reindex(df["bucket"]), 0.0
        else:
            re, base = self.re.reindex(df["count"]), ER_PER_PITCH
        filled = probs.fillna(probs.median()).astype(float)
        return base + (filled.to_numpy() * re[filled.columns].to_numpy()).sum(axis=1)

    def score(self, df: pd.DataFrame) -> pd.DataFrame:
        """plvStuff+, PLV+ and the three game grades for a prepared pitch frame."""
        X = pd.concat([df, one_hot(df)], axis=1)
        out = pd.DataFrame(index=df.index)
        for kind in KINDS:
            dre = self._delta_re(kind, df, self._probs(kind, df, X))
            c = CONSTANTS[kind]
            out[f"{kind}Grade_game"] = -((dre - c["game_mean"]) / c["game_stdev"]) * 10 + 75
            if kind in PLUS:
                out[PLUS[kind]] = -((dre - c["type_mean"]) / c["type_stdev"]) * 15 + 100
        return out[list(GRADE_COLUMNS)]

    def xslg_con(self, df: pd.DataFrame) -> pd.Series:
        """Expected total bases per ball in play, from exit velocity and launch angle."""
        X = df[["launch_speed", "launch_angle"]].astype(float)
        ok = X.notna().all(axis=1)
        out = pd.Series(np.nan, index=df.index)
        if ok.any():
            out[ok] = self.xslg.predict_proba(X[ok])[:, 1:] @ np.arange(1, 5)
        return out
