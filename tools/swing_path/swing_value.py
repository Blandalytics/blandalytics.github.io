"""Swing value: one run value per swing from the bat path, split into contact and damage, at a
location-, count- and pitch-quality-neutral level.

Each swing's path is played against the league's swung-at pitches in every count:

* **Location and pitch quality.** At each of 300 draws j from the league's swings in the same
  season, count, pitch group and platoon cell, the stage terms come from the draw pitch: its
  location, its PLV prediction (location + stuff) and the average path's projection there.
  The swing contributes only its path, theta_c (D(i) - r(j)), as in neutral.py.
* **Count.** This is repeated in all 12 counts, with that count's theta, valued with that
  count's run values, and weighted by the league's swing count mix.

At a draw in count c (run values from the hitter's side, pitch-modeling's run_values_by_count):

    p1 = P(whiff), p2 = P(foul | contact), w = E[wOBAcon | in play] for this path
    value  = p1 RV(whiff, c) + (1 - p1) p2 RV(foul, c) + (1 - p1)(1 - p2) RV_bip(w, c)
    RV_bip(w, c) = a_c + b_c w      (fit on the KNN batted-ball classes; R^2 >= .9995 per count)

    contact = the same with w replaced by the league-average path's w at that draw
    damage  = value - contact = (1 - p1)(1 - p2) b_c theta_c (D(i) - r(j))

so `rv_contact` is what the swing's whiff / foul / in-play profile is worth with average damage,
and `rv_damage` is what its contact quality adds on the balls it would put in play. Each is
centred on the season's league mean swing, so 0 is an average swing and + is good for the
hitter. Calibration matches neutral.py: per season, log-odds shifts on the two logit stages and
an additive shift on damage make league means equal the observed whiff and foul shares and the
KNN wOBAcon, at each swing's own count.

    python swing_value.py --scored pooled.parquet --bip bip.parquet \
        --run-values run_values_by_count.csv --out swing_value.parquet

writes the per-swing file and `<out>_hitters.csv`: value, contact and damage per 100 committed
swings and their plus scales per hitter-season-hand (200+ swings), with observed vs PLV per 100.
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd

try:
    from numba import njit, prange
except ImportError:  # pure-python fallback: same results, much slower
    prange = range

    def njit(*_a, **_k):
        return lambda f: f


DRAWS = 300
CELL = ["season", "group", "platoon"]  # plus count
BIP_CLASSES = ["field_out", "single", "double", "triple", "home_run"]
STAGES = ("whiff", "foul", "damage")
COUNTS = [f"{b}-{s}" for b in range(4) for s in range(3)]


def bip_line(run_values: pd.DataFrame, bip: pd.DataFrame) -> np.ndarray:
    """Per count, (a_c, b_c) with RV of a ball in play = a_c + b_c * wOBAcon, fitted on the
    KNN class probabilities."""
    x = bip[[f"x_{c}" for c in BIP_CLASSES]].to_numpy()
    design = np.column_stack([np.ones(len(bip)), bip["x_wobacon"].to_numpy()])
    out = np.zeros((12, 2))
    for k, c in enumerate(COUNTS):
        y = x @ run_values.loc[BIP_CLASSES, c].to_numpy()
        out[k] = np.linalg.lstsq(design, y, rcond=None)[0]
    return out


def thetas(info: dict, s: pd.DataFrame) -> np.ndarray:
    """theta[stage, count] for each swing's model: shape (rows, 3, 12)."""
    out = np.zeros((len(s), 3, 12))
    for k, stage in enumerate(STAGES):
        for grp in s["group"].unique():
            m = (s["group"] == grp).to_numpy()
            out[m, k] = np.asarray(info[f"{grp}/{stage}"]["theta"])
    return out


def draw_tables(s: pd.DataFrame, rng) -> tuple[dict, np.ndarray, np.ndarray]:
    """Common draws per (season, group, platoon, count) cell: each draw's l + r and r for the
    three stages, as arrays (cells, 3, DRAWS), and the cell index per (base cell, count)."""
    base = s.groupby(CELL).ngroup().to_numpy()
    groups = s.groupby([base, s["count_idx"].to_numpy()]).indices
    lr_all = np.stack([(s[f"l_{st}"] + s[f"r_{st}"]).to_numpy() for st in STAGES])
    r_all = np.stack([s[f"r_{st}"].to_numpy() for st in STAGES])
    cell_of = np.full((base.max() + 1, 12), -1)
    lr, r = [], []
    for k, ((b, c), pos) in enumerate(groups.items()):
        idx = pos[rng.integers(0, len(pos), DRAWS)]
        lr.append(lr_all[:, idx])
        r.append(r_all[:, idx])
        cell_of[b, c] = k
    return {"base": base, "cell_of": cell_of}, np.asarray(lr), np.asarray(r)


@njit(parallel=True, cache=True)
def _kernel(d, th, lr, r, cell_of, base, counts, shift, rv, line, out):  # noqa: C901
    """For each swing and each count in `counts`: mean over draws of (p_whiff, p_foul,
    p_in_play, w, value, contact). `counts[i, k]` < 0 skips."""
    n = d.shape[0]
    for i in prange(n):
        for k in range(counts.shape[1]):
            c = counts[i, k]
            if c < 0:
                continue
            cell = cell_of[base[i], c]
            if cell < 0:
                continue
            acc = np.zeros(6)
            for j in range(lr.shape[2]):
                e1 = lr[cell, 0, j] + th[i, 0, c] * (d[i, 0] - r[cell, 0, j]) + shift[0]
                e2 = lr[cell, 1, j] + th[i, 1, c] * (d[i, 1] - r[cell, 1, j]) + shift[1]
                avg = lr[cell, 2, j] + shift[2]
                w = avg + th[i, 2, c] * (d[i, 2] - r[cell, 2, j])
                p1 = 1.0 / (1.0 + np.exp(-e1))
                p2 = 1.0 / (1.0 + np.exp(-e2))
                pin = (1 - p1) * (1 - p2)
                rest = p1 * rv[c, 0] + (1 - p1) * p2 * rv[c, 1]
                acc[0] += p1
                acc[1] += (1 - p1) * p2
                acc[2] += pin
                acc[3] += w
                acc[4] += rest + pin * (line[c, 0] + line[c, 1] * w)
                acc[5] += rest + pin * (line[c, 0] + line[c, 1] * avg)
            for m in range(6):
                out[i, k, m] = acc[m] / lr.shape[2]


def evaluate(s, tabs, lr, r, th, counts, shift, rv, line) -> np.ndarray:
    d = s[[f"D_{st}" for st in STAGES]].to_numpy()
    out = np.zeros((len(s), counts.shape[1], 6))
    _kernel(d, th, lr, r, tabs["cell_of"], tabs["base"], counts, shift, rv, line, out)
    return out


def calibrate(s, tabs, lr, r, th, rv, line) -> np.ndarray:
    """Per-season shifts at each swing's own count: whiff and foul log-odds, damage additive."""
    shift = np.zeros(3)
    own = s["count_idx"].to_numpy()[:, None].astype(np.int64)
    contact, bip = s["contact"].to_numpy(), s["bip"].to_numpy()
    target = (s["whiff"].mean(), s.loc[contact, "foul"].mean(), s.loc[bip, "x_wobacon"].mean())
    for _ in range(6):
        o = evaluate(s, tabs, lr, r, th, own, shift, rv, line)[:, 0]
        p_w, p_f, p_i = o[:, 0].mean(), o[:, 1].mean(), o[:, 2].mean()
        shift[0] += np.log(target[0] / (1 - target[0])) - np.log(p_w / (1 - p_w))
        share = p_f / (p_f + p_i)
        shift[1] += np.log(target[1] / (1 - target[1])) - np.log(share / (1 - share))
        shift[2] += target[2] - o[bip, 3].mean()
    return shift


def season_values(s, info, rv, line, mix, seed) -> pd.DataFrame:
    """Count-neutral value, contact and damage per swing for one season, league-centred."""
    tabs, lr, r = draw_tables(s, np.random.default_rng(seed))
    th = thetas(info, s)
    shift = calibrate(s, tabs, lr, r, th, rv, line)
    all_counts = np.tile(np.arange(12, dtype=np.int64), (len(s), 1))
    o = evaluate(s, tabs, lr, r, th, all_counts, shift, rv, line)
    w = mix / mix.sum()
    value, contact = o[:, :, 4] @ w, o[:, :, 5] @ w
    out = pd.DataFrame({"rv_value": value - value.mean(), "rv_contact": contact - contact.mean()},
                       index=s.index)  # fmt: skip
    out["rv_damage"] = out["rv_value"] - out["rv_contact"]
    for k, name in enumerate(("p_whiff_cn", "p_foul_cn", "p_in_play_cn", "wobacon_cn")):
        out[name] = o[:, :, k] @ w
    print(f"season {int(s['season'].iloc[0])}: shifts {np.round(shift, 4)}", flush=True)
    return out


def observed_vs_plv(s: pd.DataFrame, rv: np.ndarray, line: np.ndarray) -> pd.DataFrame:
    """Per swing, the run value of what happened minus PLV's expectation at the actual count,
    split like the model: `obs_contact` values the outcome class with PLV's expected wOBAcon on
    balls in play, `obs_damage` is the ball in play's KNN expected wOBAcon over PLV's, in runs.
    Balls in play are valued by expected wOBAcon, so this is contact quality, not luck."""
    c = s["count_idx"].to_numpy()
    a, b = line[c, 0], line[c, 1]
    q1, q2, qw = s["q_whiff"].to_numpy(), s["q_foul"].to_numpy(), s["q_wobacon"].to_numpy()
    plv = q1 * rv[c, 0] + (1 - q1) * q2 * rv[c, 1] + (1 - q1) * (1 - q2) * (a + b * qw)
    cls = np.where(s["whiff"] == 1, rv[c, 0], np.where(s["foul"] == 1, rv[c, 1], a + b * qw))
    damage = np.where(s["bip"], b * (s["x_wobacon"].to_numpy() - qw), 0.0)
    out = pd.DataFrame({"obs_contact": cls - plv, "obs_damage": damage}, index=s.index)
    out["obs_vs_plv"] = out["obs_contact"] + out["obs_damage"]
    return out


def plus(x: pd.Series, w: pd.Series) -> pd.Series:
    mean = np.average(x, weights=w)
    sd = np.sqrt(np.average((x - mean) ** 2, weights=w))
    return 100 + 15 * (x - mean) / sd


def _wslope(x: pd.Series, y: pd.Series, w: pd.Series) -> float:
    mx, my = np.average(x, weights=w), np.average(y, weights=w)
    return np.average((x - mx) * (y - my), weights=w) / np.average((x - mx) ** 2, weights=w)


def hitter_values(s: pd.DataFrame, calib_before: int, min_swings: int = 200):
    """Per batter-season-hand: value, contact and damage per 100 committed swings (+ = good for the
    hitter) and observed vs PLV per 100 swings (all swings), with its contact / damage split.

    `cal100` rescales each part by the slope of its observed counterpart on it, fitted on
    seasons before `calib_before` (swing-weighted): the raw contact part overstates observed
    contact differences and the raw damage part understates observed damage differences, so
    the raw sum leans toward contact. Every value gets a 100 / 15 plus scale per season,
    swing-weighted over hitters with `min_swings`+ swings."""
    k = ["batter", "season", "stand"]  # a switch hitter is two units per season
    out = s[~s["fooled"]].groupby(k)[["rv_value", "rv_contact", "rv_damage"]].mean() * 100
    out.columns = ["rv100", "contact100", "damage100"]
    obs = s.groupby(k)[["obs_vs_plv", "obs_contact", "obs_damage"]].mean() * 100
    obs.columns = ["obs_vs_plv100", "obs_contact100", "obs_damage100"]
    info = s.groupby(k).agg(name=("player_name", "first"), swings=("whiff", "size"),
                            fooled=("fooled", "mean"))  # fmt: skip
    out = info.join(out).join(obs)
    out = out[out["swings"] >= min_swings].reset_index()
    tr = out[out["season"] < calib_before]
    slopes = {
        p: _wslope(tr[f"{p}100"], tr[f"obs_{p}100"], tr["swings"]) for p in ("contact", "damage")
    }
    out["cal100"] = slopes["contact"] * out["contact100"] + slopes["damage"] * out["damage100"]
    for col in ("rv100", "contact100", "damage100", "cal100"):
        out[col.replace("100", "_plus")] = out.groupby("season", group_keys=False).apply(
            lambda g, col=col: plus(g[col], g["swings"])
        )
    return out, slopes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scored", required=True, help="dml_swing_path.py output (pooled)")
    ap.add_argument("--bip", required=True, help="batted_ball.py output")
    ap.add_argument("--run-values", required=True, help="pitch-modeling run_values_by_count.csv")
    ap.add_argument("--calib-before", type=int, help="fit cal100 slopes on earlier seasons")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    keep = ["batter", "player_name", "stand", "game_pk", "season", "count_idx", "group", "platoon",
            "whiff", "foul", "contact", "bip", "fooled", "x_wobacon", "q_whiff", "q_foul",
            "q_wobacon", *[f"{c}_{st}" for st in STAGES for c in ("l", "r", "D")]]  # fmt: skip
    s = pd.read_parquet(a.scored, columns=keep)
    with open(a.scored.replace(".parquet", "_theta.json")) as f:
        info = json.load(f)
    rv_table = pd.read_csv(a.run_values, index_col=0)
    rv = rv_table.loc[["swinging_strike", "foul"], COUNTS].to_numpy().T.copy()
    line = bip_line(rv_table, pd.read_parquet(a.bip))
    mix = np.bincount(s["count_idx"], minlength=12).astype(float)  # league swing count mix
    vals = [season_values(g, info, rv, line, mix, int(y)) for y, g in s.groupby("season")]
    s = s.join(pd.concat(vals))
    s = s.join(observed_vs_plv(s, rv, line))
    s.drop(columns=[f"{c}_{st}" for st in STAGES for c in ("l", "r", "D")]).to_parquet(a.out)
    hitters, slopes = hitter_values(s, a.calib_before or int(s["season"].max()))
    hitters.to_csv(a.out.replace(".parquet", "_hitters.csv"), index=False)
    print(f"calibration slopes (observed per model run): {slopes}")
    print(s[["rv_value", "rv_contact", "rv_damage"]].describe().round(4))


if __name__ == "__main__":
    main()
