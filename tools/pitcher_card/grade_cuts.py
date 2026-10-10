"""Cut points for the card's Stuff, Location and PLV letter grades, fitted to a target
share of each letter.

Every MLB pitcher-game in the bucket's data files is scored as its card is (the values a
game scored alone gets, blank where the tracking the models need is missing) and averaged
into the card's three game grades: stuffGrade_game, locGrade_game and plvGrade_game. Each
grade's cuts are the quantiles of those outing means at the target's cumulative shares,
with every outing weighted by its pitches, so the share of pitches thrown in, say, B+
outings is the target's share of B+.

    python grade_cuts.py                       # every season in the data files
    python grade_cuts.py --seasons 2022 2025   # a span of seasons
    python grade_cuts.py --starts              # starters' outings only

A season's outing means are cached beside the data files (grade_games_<year>.parquet);
--rescore scores them again. Prints the cuts as grades.py and build.js spell them, and
the share of each letter they give."""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

import numpy as np
import pandas as pd

from card import DEFAULT_CACHE  # first: it puts the scraper on sys.path

import fetch  # noqa: E402
import pitch_model  # noqa: E402
import prep  # noqa: E402
from grades import GRADE_CUTS, LETTERS  # noqa: E402

# percent of graded pitches in each letter, F to A+: the modeled grade distribution of
# every 2022-2025 start
TARGET = (6.2, 4.7, 5.6, 5.9, 5.7, 8.3, 8.6, 10.2, 10.9, 11.0, 9.8, 9.7, 3.4)
GRADES = {"stuff": "stuffGrade_game", "loc": "locGrade_game", "plv": "plvGrade_game"}
FIRST_SEASON = 2020  # the first season the data files and the plus scale cover


def scored(pm: pitch_model.PitchModel, df: pd.DataFrame, workers: int) -> pd.DataFrame:
    """pitch_model.PitchModel.score for many games at once, with the values a card gets.

    The scorer measures each pitch against the outing's primary fastball, falling back on
    the pitcher's fastball across everything it was given when the outing threw none. A
    card scores its game alone, where there is nothing else to fall back on, so the
    fallback is turned off here; what is left of the scorer works pitch by pitch or outing
    by outing, and gives a card's values to the last bit."""
    sp, models, mix, values, by_count, env, _ = pm._load()
    own = sp._primary_fastballs

    def outing_only(frame, keys):
        return own(frame.iloc[:0] if keys == ["pitcher", "season"] else frame, keys)

    sp._primary_fastballs = outing_only
    try:
        pitches, _ = sp.score(pm._plain(df), models, mix, values, by_count, env=env,
                              workers=workers)  # fmt: skip
    finally:
        sp._primary_fastballs = own
    return pitches[[*pitch_model.KEYS, *pitch_model.VALUES]].set_index(list(pitch_model.KEYS))


def outings(df: pd.DataFrame, values: pd.DataFrame, pm: pitch_model.PitchModel) -> pd.DataFrame:
    """Each pitcher-game: pitches thrown and the mean of each game grade, as
    build_data.scored_pitches blanks them and grade_summary averages them."""
    p = prep.base(df)
    keys = pd.MultiIndex.from_arrays([p["game_pk"], p["abi"], p["pitch_no"]])
    v = pm.columns(values)[list(GRADES.values())].reindex(keys).to_numpy()
    tracking = p[list(prep.TRACKING)].isna().any(axis=1).to_numpy()
    v[tracking, 0] = v[tracking, 2] = np.nan  # stuff and PLV
    v[p[list(prep.LOCATION)].isna().any(axis=1).to_numpy(), 1] = np.nan
    frame = pd.DataFrame(v, columns=list(GRADES))
    for c in ("game_pk", "pitcher", "game_type"):
        frame[c] = df[c].astype(str if c == "game_type" else int).to_numpy()
    agg = {g: (g, "mean") for g in GRADES}
    out = frame.groupby(["game_pk", "pitcher"]).agg(
        game_type=("game_type", "first"), pitches=("stuff", "size"), **agg
    )
    return out.reset_index()


def _home_pitchers(game: pd.DataFrame) -> set:
    """Everyone who pitched for the side that threw the game's first pitch. A pitcher only
    faces the other side's batters, so pitchers -> the batters they faced -> the pitchers
    who faced those batters, until nobody new turns up."""
    home = {game["pitcher"].iat[0]}
    while True:
        faced = game.loc[game["pitcher"].isin(home), "batter"]
        more = set(game.loc[game["batter"].isin(faced), "pitcher"])
        if more <= home:
            return home
        home |= more


def starters(df: pd.DataFrame) -> pd.MultiIndex:
    """(game_pk, pitcher) of each game's starters: each side's first pitcher, the one its
    box score lists first. Matches statsapi's games started for every 2025 pitcher."""
    ab = df.drop_duplicates(["game_pk", "at_bat_index"]).sort_values(["game_pk", "at_bat_index"])
    out = []
    for pk, game in ab[["game_pk", "pitcher", "batter"]].groupby("game_pk", sort=False):
        away = game.loc[~game["pitcher"].isin(_home_pitchers(game)), "pitcher"]
        out += [(pk, p) for p in (game["pitcher"].iat[0], *away.iloc[:1])]
    return pd.MultiIndex.from_tuples(out, names=["game_pk", "pitcher"])


def score_season(store: fetch.DataStore, year: int, workers: int) -> pd.DataFrame:
    """Every pitcher-game of a season in the data files, scored a month at a time."""
    end = min(dt.date(year, 12, 31), store.last_finalized)
    df = store.stored(dt.date(year, 1, 1), end)
    pm = pitch_model.PitchModel(store.dir, store.s)
    months = [m for _, m in df.groupby(df["game_date"].dt.month)]
    out = pd.concat([outings(m, scored(pm, m, workers), pm) for m in months], ignore_index=True)
    start = starters(df)
    out["start"] = pd.MultiIndex.from_frame(out[["game_pk", "pitcher"]]).isin(start)
    out.insert(0, "season", year)
    return out


def season_games(store: fetch.DataStore, year: int, workers: int, rescore: bool) -> pd.DataFrame:
    path = os.path.join(store.dir, f"grade_games_{year}.parquet")
    if rescore or not os.path.exists(path):
        print(f"{year}: scoring", file=sys.stderr)
        score_season(store, year, workers).to_parquet(path, index=False)
    return pd.read_parquet(path)


def fit(values: np.ndarray, weights: np.ndarray, shares: np.ndarray) -> np.ndarray:
    """Weighted quantiles: for each share, the smallest value with at least that share of
    the weight at or below it (a card's bins are closed on the right)."""
    order = np.argsort(values, kind="stable")
    cum = np.cumsum(weights[order]) / weights.sum()
    return values[order][np.searchsorted(cum, shares)]


def letter_shares(values: np.ndarray, weights: np.ndarray, cuts) -> np.ndarray:
    """Percent of the weight in each letter, binned as grades.bin_index bins."""
    bins = np.searchsorted(np.asarray(cuts), values, side="left")
    return 100 * np.bincount(bins, weights, minlength=len(LETTERS)) / weights.sum()


def report(games: pd.DataFrame) -> None:
    shares = np.cumsum(TARGET)[:-1] / 100
    fitted = pd.DataFrame({"target": TARGET}, index=list(LETTERS))
    now = fitted.copy()
    for g, column in GRADES.items():
        ok = games[g].notna()
        values, weights = games.loc[ok, g].to_numpy(), games.loc[ok, "pitches"].to_numpy(float)
        cuts = np.round(fit(values, weights, shares), 1)
        fitted[g] = letter_shares(values, weights, cuts)
        now[g] = letter_shares(values, weights, GRADE_CUTS[g])
        print(f"{column}: {ok.sum():,} outings, {weights.sum():,.0f} pitches")
        print(f'  grades.py  "{g}": ({", ".join(f"{c:g}" for c in cuts)}),')
        print(f"  build.js   {g}: [{', '.join(f'{c:g}' for c in cuts)}],")
    print("\npercent of pitches in each letter with the fitted cuts:")
    print(fitted.round(1).to_string())
    print("\n...and with the cuts in grades.py:")
    print(now.round(1).to_string())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seasons", type=int, nargs=2, metavar=("FIRST", "LAST"),
                    help="a span of seasons (default: every one in the data files)")  # fmt: skip
    ap.add_argument("--starts", action="store_true", help="starters' outings only")
    ap.add_argument("--rescore", action="store_true", help="score cached seasons again")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="the data-file / model cache")
    a = ap.parse_args(argv)
    os.environ.setdefault("OMP_NUM_THREADS", "1")  # the scorer's processes are the parallelism
    store = fetch.DataStore(a.cache, fetch.session())
    first, last = a.seasons or (FIRST_SEASON, store.last_finalized.year)
    games = pd.concat(
        [season_games(store, y, a.workers, a.rescore) for y in range(first, last + 1)],
        ignore_index=True,
    )
    if a.starts:
        games = games[games["start"]]
    print(f"seasons {first}-{last}: {len(games):,} pitcher-games\n")
    report(games)
    return 0


if __name__ == "__main__":
    sys.exit(main())
