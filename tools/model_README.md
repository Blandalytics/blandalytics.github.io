# DML Stuff models: swing and whiff likelihood

`dml_stuff_swing.py` estimates, for every pitch, the probability of a **swing** or a **whiff**
that its **stuff** earns. It uses the pitch's physical traits, with location removed as far as
possible. It is a double/debiased machine learning (DML) partially linear model, fit separately
for each pitch group **and matchup** (vs Same Hand, vs Opposite Hand): six models. Location
is mirrored to the batter (+ = inside) and movement to the pitcher (glove side negative), so
RHP-vs-RHB and LHP-vs-LHB are mirror images and share a model. Every nuisance model is
cross-fitted by **Leave-One-Group-Out with pitchers as the groups**. A pitcher's group is all
of his seasons, so multi-season training never scores a pitcher with a model that saw him.

| Target (`--target`) | Rows | Y = 1 | Y = 0 |
|---|---|---|---|
| `swing` | swing/take decisions (bunts, pitchouts, automatic and intentional calls dropped) | swing | take |
| `whiff` | swings only | swinging_strike, swinging_strike_blocked, missed_bunt, bunt_foul_tip, foul_tip | foul, foul_bunt, hit_into_play |
| `swing_outcome` (multiclass, `--link logit`) | swings only | classes: **whiff** (S, W, M, O, T, so both kinds of foul tip), **foul** (F, L), **in_play** (X, D, E) | |

The whiff map uses statsapi call codes S, W, M, O, T → 1 and F, L, X/D/E → 0. Pitchout swings
are excluded.

| Group    | Pitch types        |
|----------|--------------------|
| Fastball | FF, SI, **primary** FC |
| Breaking | SL, SV, ST, KC, CU, **secondary** FC |
| Offspeed | CH, FS, FO         |
| Other    | everything else (not fit by default; `--groups ... Other`) |

A cutter is **primary** in a game where it is the pitcher's most-used pitch of FF, SI and FC.
Otherwise it is **secondary**: used less than his FF or SI that day. Ties go to the harder
pitch. Usage is counted over every tracked pitch, before any outcome filter, and the pitch type
stays `FC` in both groups.

## Method

Within each (group, matchup) model:

```
Y = g(W) + theta_c' phi(S) + e
```

* **Y**: the target (see above).
* **W** (nuisance): plate location relative to the batter (x mirrored so + = inside) and to
  his zone (z scaled so 0 is the bottom and 1 the top), pre-pitch count, and pitcher and
  batter hand.
* **S** (stuff): velocity, mirrored ax, az with gravity removed (az + 32.174 ft/s², the
  induced vertical acceleration: + = ride; the saved models were converted without a refit by
  `migrate_az_gravity.py`, which shifts their az split thresholds, and reproduce every 2026
  prediction exactly), the true release point (propagated back from
  the y=50 ft fit point to 60.5 minus extension), extension, spin rate, estimated spin
  efficiency, seam-shifted-wake axis differential, deltas from the same-game primary
  fastball, a primary-fastball flag, and platoon. Location-leaking inputs (plate_x/z,
  vx0/vz0, raw approach angles) are never used. **Pitch type is not a feature in any model.**
  It only defines the groups and the primary-fastball reference, and it labels the reports.
* **phi(S)**: the model's stuff index D(S), interacted with the count (all 12 balls-strikes
  cells). Theta is one stuff slope per count.
* **Season** is an input to both the stuff and location models when training spans several
  seasons. A later season is scored as the last training season.

Steps (cross-fitted by leave-one-pitcher-out):

1. **l(W) = E[Y | W]** is LightGBM on location, count and hands only, refit once per
   held-out pitcher. An earlier version used a kernel smoother on a plate grid. Its
   leave-one-out was exact and cheap, but it was miscalibrated where data is sparse: on
   far-from-zone swings it predicted a 52.7% whiff rate against an actual 65.5%.
2. **D(S)** is a LightGBM model on the location-residual target Y − l(W), with stuff inputs
   only, refit once per held-out pitcher. The residuals use the cross-fitted l, so the
   held-out pitcher reaches D's labels only through his tiny share of the other pitchers'
   l fits.
3. **m(W) = E[phi(S) | W]** is LightGBM on W, one booster per basis column, refit once per
   held-out pitcher. It partials location out of the stuff basis.
4. **theta** is an OLS fit of (Y − l) on (phi − m), the Neyman-orthogonal score. Standard
   errors are clustered by pitcher. A leave-one-pitcher-out theta is computed exactly for
   every row. Theta measures how swing rate moves with stuff *at a fixed location and count*,
   so directions of D that only proxy for location are down-weighted.

## Logit link (`--link logit`)

This link puts the model on the log-odds scale, as a sequential logit. Stage s is a binary
logistic partially linear model on the rows still at risk (class ≥ s), so whiff vs contact
over all swings, then foul vs in-play over contact:

```
logit P(class = s | class ≥ s, S, W) = theta_c · D_s(S) + g_s(W)
P(whiff) = q1,   P(foul) = (1 − q1) q2,   P(in_play) = (1 − q1)(1 − q2)
```

Every fit below is refit once per held-out pitcher:

1. **l_s(W)** is a location-only stage probability. Its log-odds serve as a boosting offset.
2. **D_s(S)** is LightGBM boosted from that offset on stuff inputs only. That makes it a
   log-odds stuff index.
3. **r_s(W)** is the projection of D on W, weighted by p(1 − p). These weights are what make
   the logit score insensitive to errors in the location model.
4. **theta** comes from an offset logistic regression, `y ~ offset(logit l + r) + theta_c
   (D − r)`, with standard errors clustered by pitcher. The leave-one-pitcher-out theta is a
   one-step Newton update.

A sequential logit's likelihood splits into separate stage likelihoods, so each stage's binary
fit remains exact for the whole multiclass model.

**Location-neutral probabilities.** For each pitch, the chained stage probabilities are
averaged over 300 locations drawn from the league swings in the same season, count and hands
cell (same matchup). The
product is averaged, not each stage separately. The results are valid probabilities that sum
to 1 by construction. One league-wide log-odds shift per stage makes their means equal the
observed whiff, foul and in-play shares. `x<class>_plus` is `100 × p_<class>_stuff`
divided by the model's cell mean.

`python leaderboard.py --preds <output> --data <pull> --out <csv> [--season YYYY]` builds the
per pitcher-pitch type table for every class, with `_vSame` / `_vOpp` columns, standardized to
swing-weighted 100 / 15.

## Tuning (`tune.py`)

The three LightGBM kinds are tuned with Optuna (TPE sampler, defaults as the first trial) on
the training seasons only:
- **loc:** l(W).
- **stuff:** D(S), boosted from the tuned l's out-of-fold offsets.
- **proj:** r(W), fit on the tuned D.

Each kind is tuned for its own out-of-sample loss. DML's Neyman orthogonality makes theta
insensitive to small errors in these models, so that is the right target. The folds are 3-fold
`GroupKFold` by pitcher, with all of a pitcher's seasons together. Tree counts come from early
stopping on an inner pitcher-grouped split and are saved as (training rows, trees) anchors.
`GBMConfig` fits a line in log(rows) through the anchors, so each model's leave-one-out fits
get a size-appropriate count. The settings are shared across models: they are tuned on
Fastball vs Same Hand and Offspeed vs Opposite Hand, both stages. Pass `--tuned
output/tuned_params.json` to the main script.

## Out-of-time evaluation (`evaluate.py`)

The model trained on 2023–25 scores 2026 with no refitting. The saved model keeps its location
models, so 2026 gets location-only and location + stuff probabilities as well as stuff-only.
The script reports:
- pitch-level log loss and AUC per model;
- year-over-year prediction: 2025 observed rates, location-adjusted rates and x+ (from the
  leave-one-pitcher-out training output) against 2026 observed and location-adjusted rates,
  per pitcher-pitch type;
- the 2026 leaderboard.

## Outputs (per pitch)

Column names carry the target; `<t>` is `swing` or `whiff`.

| column | meaning |
|---|---|
| `<t>` | the observed label |
| `model` | the model that scored the pitch, e.g. `Breaking vs Opposite Hand` |
| `p_<t>_stuff` | **main output**. It is `p_bar + theta'phi(S) −` the mean of that term over the model's count and hand cell. It depends only on stuff plus count and hand context. |
| `x<t>_plus` | `100 * p_<t>_stuff / p_bar`. 100 is the average pitch of that group and matchup. |
| `p_bar_neutral` | the model's rate at the **league-wide** location mix for the count and hands cell: its full-data l(W) averaged over every eligible pitch in that matchup (all pitches for swing, all swings for whiff). A group that usually lives out of the zone isn't penalized for it. |
| `p_bar` | `p_bar_neutral` times one league-wide factor chosen so the league mean of `p_<t>_stuff` equals the observed rate. |
| `p_<t>_orth` | `p_bar + theta'(phi − m(W))`. Strictly mean-independent of location, but it reads the pitch's own location through m(W). |
| `p_<t>_full` | `l(W) + theta'(phi − m(W))`. The location-aware prediction, used for evaluation. |
| `p_loc`, `p_cell`, `stuff_index`, `p_naive` | nuisance and baseline pieces, for diagnostics |

All per-pitch values in the output file are out-of-group: the pitcher's own pitches never
trained the models that scored them.

## Running

```bash
python tune.py --data data/statfast_2023_2025.parquet --out output/tuned_params.json
python dml_stuff_swing.py --data data/statfast_2023_2025.parquet --target swing_outcome --link logit --tuned output/tuned_params.json --out output/swing_outcome_logit_2325.parquet --model output/swing_outcome_logit_2325.pkl
python evaluate.py --model output/swing_outcome_logit_2325.pkl --train-preds output/swing_outcome_logit_2325.parquet --data data/statfast_2026.parquet --out-scored output/swing_outcome_2026_scored.parquet --out-board output/swing_outcome_leaderboard_2026.csv
```

Data comes from `statfast.mlb_season` (path set by `STATFAST_DIR`). Useful flags:

* `--groups Fastball Breaking` fits only some groups.
* `--start/--end` sets a date range instead of a season.
* `--tuned` loads per-kind settings from `tune.py`. Without it: `--trees` (stuff index),
  `--loc-trees` (location models). `--jobs` (worker processes) and `--threads`
  (LightGBM threads per worker) set compute. The GPU was benchmarked and isn't faster for
  this workload: XGBoost CUDA on an RTX 3060 Ti manages 1.14 folds/s, against 1.11 for the
  12-core CPU.
* `--max-train-rows` subsamples each fold.
* `--naive` adds a plain stuff-only GBM for comparison.

To score new pitches with the saved model (no location enters the score):

```python
from dml_stuff_swing import load_model  # either link
scored = load_model("output/swing_outcome_logit_2325.pkl").score(statfast_frame)  # swings only
```

## Nine-outcome Stuff estimates (`combine.py`)

The four logit models are chained into per-pitch location-neutral probabilities of nine
outcomes, which sum to exactly 1 on every pitch. The in-play outcome is split into its
batted-ball results using the in-play model (below):

```
P(ball/HBP)        = P(take)  × P(ball | take)
P(called strike)   = P(take)  × P(called strike | take)
P(swinging strike) = P(swing) × P(whiff | swing)       (foul tips count as whiffs)
P(foul)            = P(swing) × P(foul | swing)
P(<batted ball>)   = P(swing) × P(in play | swing) × P(<batted ball> | in play)
                     for field_out, single, double, triple, home_run
```

The batted-ball factor is fitted to the batted-ball KNN's expected outcome, so these are
expected results given contact quality, not luck on balls in play. Every swing/take decision is
scored by all four models, so bunts are excluded. By Bayes' rule, each conditional model's
reference locations (league takes, swings, or balls in play) are the all-pitch mix reweighted by
a league-average pitch's probability of reaching that population, so the products approximate
the joint location-neutral distribution.

2026 results: 693,820 pitches; the 709 in "Other" aren't modeled. Observed balls in play are
split by their event. Errors, fielder's choices, sacrifices and double plays count as field
outs, as in the in-play model.

| | ball/HBP | called strike | swinging strike | foul | field out | 1B | 2B | 3B | HR |
|---|---|---|---|---|---|---|---|---|---|
| observed share | 36.3% | 16.3% | 12.0% | 18.2% | 11.8% | 3.59% | 1.05% | 0.09% | 0.77% |
| mean stuff estimate (as used) | 36.8% | 16.1% | 12.1% | 17.8% | 11.6% | 3.60% | 1.09% | 0.10% | 0.82% |
| mean count-neutral | 37.1% | 16.0% | 12.1% | 17.8% | 11.5% | 3.58% | 1.08% | 0.10% | 0.81% |

Chaining the location-aware predictions the same way lowers nine-outcome log loss on actual
2026 outcomes from 1.176 (location only) to 1.164 (location + stuff). The one-vs-rest AUC
improves for all nine outcomes.

**Count-neutral estimates (the main `p_<outcome>` columns).** As-used estimates are evaluated in
the count the pitch was actually thrown in, so their averages carry count usage. Across
pitcher × pitch types, `p_called_strike` correlated −0.83 with the share thrown with two
strikes, so sinkers topped the called-strike list for being thrown early.

The stuff index D(S) has no count input. So each pitch is evaluated at all 12 counts, with
θ_c · D(S) averaged over that count's league location draws, the nine outcomes are chained at
that count, and the results are weighted by the league count mix (the share of each count among
all 2023–25 pitches). The batted-ball split therefore uses the same count as its P(in play),
rather than a product of separately count-averaged rates. That makes a pitch's value independent
of its own count:

- Within a pitcher × pitch type, the pitch-level correlation with "thrown with two strikes"
  falls from −0.69–0.53 (as used) to at most 0.06.
- Across pitch types, the correlations with two-strike usage (as used → count-neutral) change
  as follows.

  | Outcome | As used | Count-neutral |
  |---|---|---|
  | Called strike | −0.83 | −0.17 |
  | Foul | +0.34 | +0.06 |
  | Swinging strike | +0.53 | +0.42 |
  | Single | −0.26 | −0.43 |
  | Home run | +0.21 | +0.30 |

- What remains across pitch types is pitch selection, not count bias: pitchers save their best
  whiff stuff for two strikes, and those pitches allow fewer singles and more home runs per
  pitch.

The nine still sum to 1 on every pitch, and league means stay within 1 point of observed. The
count-conditional values are kept as `p_<outcome>_asused`.

Outputs:
- `output/pitch_outcomes_2026.parquet`: per pitch, the stuff, location-only and full
  probabilities, plus the observed outcome;
- `output/pitch_outcomes_leaderboard_2026.csv`: per pitcher × pitch type, for all nine outcomes
  (ball, called_strike, swinging_strike, foul, field_out, single, double, triple, home_run):
  - count-neutral predicted rates `p_<outcome>`, combined and `_vSame` / `_vOpp`;
  - as-used predicted rates `p_<outcome>_asused`, combined;
  - observed rates `<outcome>_rate`, combined and `_vSame` / `_vOpp`;
  - run value per 100 pitches, from the pitcher's side (positive = good for the pitcher), using
    the linear weights from `runvalue.py` (below):
    - `rv100` (count-neutral), combined and `_vSame` / `_vOpp`: −100 · Σ_o p_o · RV_o;
    - `rv100_asused`, combined: the as-used probabilities times each outcome's run value in the
      count the pitch was thrown in;
    - `rv100_observed`, combined and `_vSame` / `_vOpp`: the actual outcome's run value in its
      count;
    - `rv100_balls`, `rv100_strikes` and `rv100_bbe`, combined and `_vSame` / `_vOpp`: the
      count-neutral `rv100` split by outcome. Balls are balls/HBP, strikes are called strikes,
      whiffs and fouls, and bbe is the five batted-ball outcomes. Each is that group's
      contribution per 100 pitches, and the three sum to `rv100`;
    - **plus scale**: every `rv100*` column has a `<column>_plus` right after it.
      * The formula is 100 + 15 · (value − mean) / SD.
      * The mean and SD are taken across all pitcher × pitch types in that season. There is no
        grouping by pitch type or pitch group.
      * They are weighted by pitches thrown; for a `_vSame` / `_vOpp` split, by pitches thrown
        in that matchup.
      * So each split is scored against the league average for that matchup. In 2026 that is
        +0.21 runs per 100 pitches vs same hand and −0.40 vs opposite hand.
      * Each season's scale is saved as `output/plus_scale_<season>.json`.

  No minimum is applied, and rows are sorted by `p_swinging_strike`. All rates are per pitch.
- `output/stuff_leaderboard_2026.csv`, **the Stuff leaderboard**. Its columns are
  `pitcher_name`, `pt` and `thrown`, then `rv100`, `rv100_vSame`, `rv100_vOpp`,
  `rv100_balls`, `rv100_strikes` and `rv100_bbe`, each followed by its `_plus` version. That is count-neutral run value per
  100 pitches from the pitcher's side, sorted best first, with no minimum. A split is blank
  when the pitch type was never thrown in that matchup.

  The three parts are not centred, because each group has a typical sign. In 2026 the
  pitch-weighted league means are:

  | Part | League mean | SD across pitch types with 500+ thrown |
  |---|---|---|
  | `rv100_balls` | −2.27 (balls cost the pitcher) | 0.14 |
  | `rv100_strikes` | +3.06 | 0.27 |
  | `rv100_bbe` | −0.93 | 0.24 |

  `rv100` has a mean of −0.15 and an SD of 0.44. So compare each part with its league mean,
  or use the `_plus` columns; most of the spread comes from strikes.

  In 2026 the pitch-weighted SD across pitcher × pitch types is 0.47 for `rv100`, 0.44 for
  `rv100_asused` and 1.68 for `rv100_observed`. The league means are −0.15, −0.06 and +0.03.
  The count-neutral mean sits slightly below 0 because the count-neutral probabilities have
  0.8 points more balls than observed. Among pitch types with 500+ pitches, `rv100` correlates
  0.95 with `rv100_asused` and 0.35 with `rv100_observed`, since observed outcomes carry
  sequencing and batted-ball luck.
- `output/pitching_leaderboard_<season>.csv` and `output/location_leaderboard_<season>.csv`:
  **Pitching** and **Location**, with the Stuff leaderboard's exact layout.

### Pitching and Location

* **Pitching** (`rv100_pitching` on the main board): run value from the location-aware
  nine-outcome probabilities `p_<outcome>_full`. Each stage is the location model l(W) plus
  the orthogonal stuff effect, at the pitch's actual location and count. Each outcome is valued
  in the pitch's actual count, like `rv100_asused`.
* **Location** (`rv100_location`): `rv100_pitching − rv100_asused`, both at the actual count.
  It is what the pitch's actual location added to (or took from) its stuff, against the league
  location mix.
* **Splits and scales.** Both have the balls / strikes / bbe split and `_vSame` / `_vOpp`
  matchups. Each column gets its own plus scale (pitch-weighted, all pitcher × pitch types),
  saved in `plus_scale_<season>.json` with the rest.
* **Rebuild without rescoring:** `combine.py --from-pitches output/pitch_outcomes_<season>.parquet`
  (with `--data` for pitches thrown). The Stuff outputs are unchanged by it.

2023–26 per pitcher × pitch type, pitch-weighted Pearson r (year-to-year pairs weighted by the
harmonic mean of pitches):

| | same-season observed RV | next-season observed RV | year to year (self) | 2026 SD |
|---|---|---|---|---|
| Stuff (count-neutral) | 0.19 | 0.17 | 0.91 | 0.47 |
| Stuff (as used) | 0.21 | 0.19 | 0.89 | 0.44 |
| Pitching | 0.35 | 0.20 | 0.58 | 0.60 |
| Location | 0.20 | 0.06 | 0.55 | 0.55 |
| Observed | 1 | 0.15 | 0.15 | 1.78 |

* **Pitching describes the season best** and predicts next season's results slightly better
  than Stuff. It is half as stable, because location (command, plus whatever the count and
  batter asked for) varies from year to year.
* **Location barely predicts.** Its year-to-year r of 0.55 is real skill, but its spread is
  mostly noise against next season's outcomes.
* **Stuff and Location are negatively related** (2026 r = −0.28, as-used Stuff): nastier
  pitches are thrown more often to chase locations.
* **Caveat for 2023–25:** those seasons are in the training window, so their location
  predictions are in-sample. In 2026 the league mean `rv100_location` is −0.13, the 2026
  environment shift seen in the calibration plots.

### Per-pitch values (`pitch_values.py`)

```bash
python pitch_values.py pitches.parquet --out values.csv
```

The input is a statfast-format file (.parquet or .csv), scored with the saved models through
`combine.score_pitches`. `--season 2026` reads an already-scored season instead, with no model
run. Output is one row per swing/take decision, with ids, count, location and observed outcome.

* **Values** (runs per pitch, pitcher side; × 100 for rv100):
  * `stuff_rv`: count-neutral Stuff.
  * `stuff_rv_asused`: Stuff at the actual count.
  * `pitching_rv`: actual location and count.
  * `location_rv`: `pitching_rv − stuff_rv_asused`.
  * `observed_rv`: the actual outcome's value.
* **Options:**
  * `--parts` adds each value's balls / strikes / bbe split.
  * `--probs` adds the nine outcome probabilities behind each value.
  * `--pitcher`, `--start` and `--end` filter. With a file, `--pitcher` scores only those
    pitchers' pitches.
* **Arsenal inputs:** the primary-fastball and arsenal deltas come from the pitches passed in,
  so pass whole outings.

### Midseason team changes (`team_change.py`)

Each pitch's team comes from the MLB Stats API schedule (`data/schedule_<season>.csv`) and the
gamestate half-inning. The sample is 493 moves (2023–26): 1,058 pitch types of 296 pitchers
with 25+ pitches of the type on both sides.

The control is every stayer's pitch types split at the same weeks (weighted to the movers'
switch dates), so seasonal drift cancels. Units are weighted by the harmonic mean of their
before and after pitches, with pitcher-clustered SEs.

| change after the move | movers | stayers | difference (SE) | r(before, after), movers / stayers |
|---|---|---|---|---|
| Stuff (count-neutral), per 100 | −0.004 | −0.003 | −0.001 (0.008) | 0.94 / 0.95 |
| Pitching | +0.032 | +0.007 | +0.025 (0.023) | 0.51 / 0.61 |
| Location | +0.036 | +0.010 | +0.026 (0.021) | 0.45 / 0.55 |
| observed RV | +0.056 | −0.228 | +0.28 (0.10) | 0.09 / 0.14 |
| velo (mph) | +0.12 | +0.12 | −0.00 (0.04) | 0.99 / 0.99 |
| vert. accel (ft/s²) | −0.04 | −0.09 | +0.05 (0.05) | 0.99 / 0.99 |

* **Stuff travels unchanged.** The mean change is the same as for stayers, and velo,
  movement, spin, release and extension do not move either. A pitch's Stuff on the new team
  correlates 0.94 with its Stuff on the old one (stayers: 0.95).
* **The observed-RV gain is regression to the mean.** Movers were below average before the
  move (−0.15 per 100, against +0.29 for stayers). Against stayers with the same before
  levels the gain is −0.10 (SE 0.08).
* **Movers' changes look more spread out, but only because of sample size.** Matched on
  sample size, the SD of the Stuff change is 0.20 against 0.19.
* **What does change is the pitch mix.** The total variation distance of usage is 0.175 for
  movers against 0.125 for stayers. The new team changes how pitches are used, not what they
  are.

### Pitcher-season K-BB%, FIP and ERA (`pitcher_seasons.py`)

Each measure is averaged per 100 pitches over a pitcher-season's modeled pitches. It is
compared with MLB Stats API season lines (`data/pitching_stats_<season>.csv`, all teams
combined; FIP with each season's league constant).

* **Weights:** "Describe" is the same season, weighted by batters faced. "Predict" is season
  Y against Y+1 (2023→24, 24→25, 25→26), weighted by the harmonic mean of batters faced.
* **Sign:** ERA and FIP are negated, so + always means better measure, better stat.

Pitchers with 100+ batters faced (2,084 pitcher-seasons, 1,055 pairs):

| | describe K-BB% | FIP | ERA | predict K-BB% | FIP | ERA |
|---|---|---|---|---|---|---|
| Stuff (count-neutral) | 0.47 | 0.39 | 0.29 | 0.44 | 0.39 | 0.30 |
| Stuff (used count) | 0.44 | 0.39 | 0.29 | 0.41 | 0.38 | 0.29 |
| Pitching | 0.62 | 0.50 | 0.36 | 0.48 | 0.39 | 0.28 |
| Location | 0.26 | 0.17 | 0.12 | 0.11 | 0.04 | 0.01 |
| Actual RV | 0.63 | 0.82 | 0.87 | 0.36 | 0.28 | 0.25 |
| the stat itself | | | | 0.58 | 0.39 | 0.20 |

* **Next-season ERA:** count-neutral Stuff predicts it better than ERA itself or Actual RV,
  and matches FIP at predicting FIP.
* **Pitching** is the best measure for K-BB% in both directions, but still trails K-BB%
  itself as a predictor.
* **Location** describes a little and predicts almost nothing.
* **2025→26 alone** (out of time for the models; 359 pairs at 100+ batters faced): Stuff
  0.47 / 0.45 / 0.34 for next K-BB% / FIP / ERA, against 0.55 / 0.38 / 0.21 for the stats
  themselves.

All pitchers, weighted by batters faced (default run, 3,276 pitcher-seasons, 1,774 pairs):

| | describe K-BB% | FIP | ERA | predict K-BB% | FIP | ERA |
|---|---|---|---|---|---|---|
| Stuff (count-neutral) | 0.42 | 0.30 | 0.19 | 0.38 | 0.28 | 0.18 |
| Stuff (used count) | 0.39 | 0.30 | 0.19 | 0.35 | 0.28 | 0.17 |
| Pitching | 0.60 | 0.46 | 0.32 | 0.43 | 0.32 | 0.21 |
| Location | 0.32 | 0.24 | 0.19 | 0.13 | 0.08 | 0.07 |
| Actual RV | 0.54 | 0.70 | 0.70 | 0.28 | 0.22 | 0.18 |
| the stat itself | | | | 0.49 | 0.28 | 0.14 |

With starters and relievers pooled, **Pitching is the best forecaster** of next FIP and ERA,
ahead of Stuff and of FIP and ERA themselves. Stuff's edge appears only among full-workload
pitchers (below).

**By role** (`--by-role`). A starter has games started ≥ half of games pitched. A pair counts
only if the role is the same in both seasons (188 of 1,774 pairs switched). No floor,
weighted by batters faced. Predicting next K-BB% / FIP / ERA:

| | SP (989 seasons, 504 pairs) | RP (2,287 seasons, 1,082 pairs) |
|---|---|---|
| Stuff (count-neutral) | 0.52 / 0.43 / 0.31 | 0.31 / 0.21 / 0.15 |
| Pitching | 0.56 / 0.43 / 0.32 | 0.32 / 0.25 / 0.18 |
| Location | 0.17 / 0.08 / 0.08 | 0.10 / 0.09 / 0.08 |
| Actual RV | 0.42 / 0.35 / 0.31 | 0.21 / 0.15 / 0.14 |
| the stat itself | 0.61 / 0.44 / 0.26 | 0.39 / 0.20 / 0.11 |

* **Within a role, Stuff and Pitching are about even.** For starters, both about match FIP on
  next FIP and beat ERA on next ERA. For relievers, both beat FIP and ERA on themselves.
* **The pooled gap is a role effect.** Relievers' count-neutral Stuff is 0.22 runs per 100
  better than starters' (BF-weighted +0.06 vs −0.16). Their K-BB% (13.7% vs 14.1%), FIP (4.20
  vs 4.25) and ERA (4.26 vs 4.26) are not better. Location offsets it (relievers −0.10,
  starters +0.13), so Pitching is level across roles (+0.03 vs +0.05) and ranks the pooled
  population better.
* **Relievers are much noisier across the board**, with small samples even for the stats
  themselves.

60+ IP (180 outs) in each season (`--min-ip 60`: 1,106 pitcher-seasons, 489 pairs):

| | describe K-BB% | FIP | ERA | predict K-BB% | FIP | ERA |
|---|---|---|---|---|---|---|
| Stuff (count-neutral) | 0.54 | 0.47 | 0.36 | 0.54 | 0.50 | 0.42 |
| Stuff (used count) | 0.52 | 0.48 | 0.37 | 0.50 | 0.49 | 0.40 |
| Pitching | 0.64 | 0.53 | 0.37 | 0.54 | 0.45 | 0.34 |
| Location | 0.22 | 0.14 | 0.06 | 0.09 | −0.00 | −0.03 |
| Actual RV | 0.65 | 0.83 | 0.89 | 0.45 | 0.38 | 0.35 |
| the stat itself | | | | 0.64 | 0.49 | 0.30 |

* **Among 60-inning pitchers, Stuff is the best predictor of next FIP and ERA.** It beats
  FIP itself on FIP (0.50 vs 0.49) and ERA itself on ERA (0.42 vs 0.30).
* **2025→26 alone** (171 pairs): 0.55 / 0.56 / 0.44 for Stuff, against 0.62 / 0.50 / 0.30
  for the stats themselves.
* **Unweighted** (`--unweighted`, every pitcher-season equal): the same picture. Stuff
  predicts next K-BB% / FIP / ERA at 0.54 / 0.51 / 0.44, against 0.64 / 0.48 / 0.30 for the
  stats themselves. Pitching is at 0.52 / 0.44 / 0.35 and Location at 0.05 / −0.02 / −0.06.
* **100+ IP, unweighted** (`--min-ip 100 --unweighted`: 521 pitcher-seasons, 228 pairs):
  * Stuff 0.62 / 0.56 / 0.43 for next K-BB% / FIP / ERA.
  * Pitching 0.62 / 0.47 / 0.34.
  * Location 0.15 / −0.01 / −0.02.
  * Actual RV 0.48 / 0.40 / 0.35.
  * The stats themselves 0.66 / 0.55 / 0.31.

  At this sample size an r has an SE near 0.045, so gaps under about 0.1 are not
  distinguishable.

**K% and wOBA against** (`--stats kwoba`; wOBA uses FanGraphs' 2024 weights for every
season). Predicting next K% / wOBA:

| | all, BF-weighted (1,774 pairs) | 100+ IP, unweighted (228 pairs) | SP (504) | RP (1,082) |
|---|---|---|---|---|
| Stuff (count-neutral) | 0.51 / 0.32 | 0.67 / 0.52 | 0.59 / 0.42 | 0.41 / 0.25 |
| Pitching | 0.34 / 0.32 | 0.54 / 0.43 | 0.47 / 0.41 | 0.23 / 0.28 |
| Location | −0.10 / 0.06 | −0.03 / −0.01 | −0.03 / 0.07 | −0.09 / 0.10 |
| Actual RV | 0.30 / 0.25 | 0.45 / 0.43 | 0.41 / 0.39 | 0.21 / 0.18 |
| the stat itself | 0.61 / 0.25 | 0.73 / 0.43 | 0.68 / 0.38 | 0.55 / 0.18 |

* **Stuff is the best measure for K%**, both describing it (0.56–0.66) and predicting it. It
  trails only K% itself.
* **Stuff predicts next wOBA better than wOBA itself** in every cut except relievers, where
  Pitching leads (0.28 vs 0.25). At 100+ IP it is 0.52 against 0.43.
* **Location has no relationship with K%** (−0.1 to 0.05). It describes wOBA a little and
  predicts it not at all.
* **Actual RV is essentially wOBA** in the same season (r = 0.99 at 100+ BF).

**Stuff ERA** (`stuff_era.py`) puts count-neutral Stuff on an ERA scale:

    Stuff ERA = lgERA − rv100 / 100 × pitches / IP × 9

The minus is because rv is pitcher-side (+ = runs saved). `pitches` is all tracked pitches.

At 100+ IP, unweighted, predicting the next season (228 pairs; RMSE in runs per 9):

| predictor | next ERA r | next ERA RMSE | next FIP r | next FIP RMSE |
|---|---|---|---|---|
| Stuff ERA | 0.41 | 0.93 | 0.53 | 0.73 |
| Pitching ERA | 0.31 | 0.92 | 0.43 | 0.73 |
| FIP | 0.40 | 0.92 | 0.55 | 0.71 |
| ERA | 0.31 | 1.06 | 0.36 | 0.93 |
| league ERA | — | 0.97 | — | 0.81 |

* **Pitching ERA** (the same conversion of `rv100_pitching`) describes the same season better
  than Stuff ERA: r 0.38 / 0.55 and RMSE 0.88 / 0.63 against same-season ERA / FIP. It predicts
  worse (r 0.31 / 0.43), in line with Location adding nothing forward. Its league level also
  moves more: IP-weighted 3.79 against a league 4.08 in 2024, and 4.45 against 4.18 in 2026.
* **Stuff ERA matches FIP** as a forecaster of both ERA and FIP, and beats ERA. In 2025→26
  alone it is 0.44 / 0.97 and 0.63 / 0.77, slightly ahead of FIP.
* **Its spread is compressed.** The SD among 100-IP pitchers is 0.43, against 0.94 for ERA.
* **Its level runs high in 2025–26.** The IP-weighted mean is 4.38–4.40 against a league ERA
  of 4.16–4.18, because league count-neutral rv100 is −0.15 there. Centering rv100 on the
  league mean cuts next-FIP RMSE to 0.72 but lowers r slightly.
* **The conversion costs a little correlation.** rv100 itself correlates 0.43 / 0.56 with next
  ERA / FIP. The pitches-per-inning factor mixes in efficiency, which predicts less well.

## Scoring new pitches (`score_stuff.py`)

This scores the Stuff leaderboard (`rv100`, `_vSame`, `_vOpp`) on any pitches with the trained
models. It needs no location, count or outcome:

```bash
python score_stuff.py pitches.parquet --out stuff.csv --out-pitches scored.parquet
```

* **Required:** `pitcher pitch_type p_throws release_speed release_extension release_pos_x
  release_pos_y release_pos_z vx0 vy0 vz0 ax ay az release_spin_rate spin_axis`. These are
  Statcast's pitch-fit velocities and accelerations at y = 50 ft.
* **Optional (fallback when missing):**
  * `stand`: without it, the pitch is scored against both hands at half weight each.
  * `game_pk`: the primary-fastball reference falls back from pitcher-game to pitcher-season.
  * `game_date` or `season`: without them, pass `--season`. Seasons after 2025 are scored as
    2025.
  * `home_team`: park elevation for spin efficiency. Without it, or for an unknown park, the
    league average of 517 ft (the pitch-weighted mean over 2023–26, rounded).
  * `pitcher_name`.
* **Plus scale.** Pass `--plus-scale output/plus_scale_2026.json` to put new pitches on the
  2026 league scale. Without it, the `_plus` columns are standardized over the input's own
  pitcher × pitch types, which is only right when the input is a full league season. On all
  of 2026 that matches `combine.py` within 1.5 points for pitch types with 100+ thrown.
* **Whole arsenals.** The primary fastball and each pitch's velo and movement differences to it
  come from the pitches passed in, so pass each pitcher's whole outing or season.
* **Standalone.** It imports only numpy, pandas and lightgbm (plus numba if installed), and no
  project modules. The model
  pickles are plain dicts of numpy arrays and LightGBM model strings. The feature engineering
  and count-neutral scoring are copies of the `dml_stuff_swing.py` / `combine.py` functions,
  each naming the function it mirrors, so keep them in sync if those change. On all 2026
  pitches its output is identical to the version that imported them.
* **Speed.** Almost all the time goes to averaging over each count's 300 league location
  samples.
  * With numba (the default when installed), that is a compiled loop, exact in float64, with
    rows spread over all cores in one process.
  * Without numba, `--kernel numpy` is float32 numpy with preallocated buffers, within 5e-9 runs
    per pitch, run across one process per core (`--workers`).

  Full 2026 season (707,519 pitches):

  | setup | time |
  |---|---|
  | numba, threaded (default) | 33 s |
  | numpy, 12 processes | 39 s |
  | numpy, 1 process | 66 s |
  | before these changes | 6 min 15 s |

  Both kernels reproduce the earlier output: the leaderboards are identical.
* **Files it reads:** the four model pickles, `output/run_values.csv`, and the league count
  mix. The count mix is cached as the 12-weight `output/count_mix.json`, so the large training
  output isn't needed to score.

On all 2026 pitches, per-pitch `rv` matches `combine.py` exactly (0.01% of pitches differ, by
at most 0.0008 runs). The leaderboards agree within 0.021 `rv100` for pitch types with 100+
pitches. The small differences arise because `score_stuff.py` also scores bunted pitches and
pitches missing a plate location, which `combine.py` drops. Those extra pitches can also shift a
pitcher's primary-fastball reference.

## SHAP: what drives the swing and whiff stuff indices (`shap_analysis.py`)

These are exact TreeSHAP values (LightGBM `pred_contrib`) for the stuff index D(S) of each
group × matchup model:

* **Swing:** the swing/take model's swing stage, on 2026 pitches.
* **Whiff:** the swing-outcome model's whiff-vs-contact stage, on 2026 swings.

Up to 40,000 pitches are explained per model. D(S) is conditional on location, since it is
boosted on top of l(W), so each effect is that of stuff at a fixed location. At count c the
effect on the stage log-odds is θ_c × SHAP. Platoon is constant within a matchup model.

Outputs:

* `output/shap_importance.csv` (mean |SHAP|)
* `output/shap_{swing,whiff}_beeswarm.png`
* `output/shap_{swing,whiff}_dependence.png`

**Swing.** The mean |D − E[D]| is 0.11–0.23 log-odds.

* **Fastballs:** driven by horizontal movement (20–28% of |SHAP|). Heavy arm-side run
  (sinker shape) draws fewer swings, about −0.65 at the extreme; cut draws more. Next come
  spin efficiency, vertical movement and velocity. Harder pitches and higher efficiency draw
  more swings. More ride draws fewer swings at the same location.
* **Breaking balls:**
  * Spin efficiency is the largest driver (17–24%): true-spin curveballs and sweepers draw
    more swings than gyro sliders (+0.45 vs −0.15).
  * Big glove-side sweep draws far fewer swings (−0.7), as does a big-drop vertical shape.
* **Offspeed:** vertical movement leads (20–25%): more drop draws more swings. Then come the
  horizontal differences from the fastball.

**Whiff.** The mean |D − E[D]| is 0.15–0.31 log-odds.

* **Fastballs:** velocity (up to +0.35 at 99+ mph), ride, and a low release height (+0.22 at
  4.5 ft vs −0.18 at 6.4 ft). Low release plus ride is the flat-approach profile. Vs same
  hand, spin-axis deviation is the top feature (29%): positive deviations of +10° to +30° add
  up to +0.4 log-odds. Vs opposite hand, high spin efficiency (> 1) adds up to +0.35.
* **Breaking balls and offspeed:** the velocity gap to the primary fastball dominates (23–32%).
  A 12–18 mph gap adds +0.2 to +0.4; a 2–4 mph gap costs −0.2 to −0.45.
  * Breaking balls: harder is better in absolute terms too (+0.24 at 90+ vs −0.3 at 75–78
    mph), and so is less drop, i.e. firmer, gyro-ish sliders over loopy curves.

**Caveats.** Correlated inputs share credit. For example, velocity and the velocity gap to the
fastball overlap, as do vertical movement and its difference from the fastball. Read features
in groups, and read the dependence curves as marginal associations, not causal effects. The
2026 season input is fixed at 2025, so it only shifts the level; that is visible in the small
Offspeed vs Same Hand model.

## SHAP on the overall rv100_plus (`shap_rv100.py`)

Count-neutral `rv100` chains eight stuff boosters through θ_c, league location draws, the
count mix and run values, so it is not a single tree model. Instead:

* A LightGBM surrogate per group × matchup model reproduces each pitch's exact value from the
  stuff features plus pitcher hand. It is trained on 2023–26.
* Exact TreeSHAP is taken from the surrogate, in **rv100_plus points**.
* A unit's plus score splits into its model's baseline plus the mean SHAP of each feature.

**Fidelity.** Per pitch, R² on held-out pitchers is 0.79–0.96. The surrogate omits the
season input and hit the 5,000-tree cap. Per pitcher × pitch type, it correlates 0.997 with
the exact `rv100_plus`, with a mean |error| of 1.8 points (SD 15). So the unit-level
attributions are reliable; single pitches are approximate.

**Model baselines** (points vs league):

| Model | Baseline |
|---|---|
| Breaking vs same hand | +22 |
| Offspeed vs same hand | +24 |
| Fastball vs same hand | +5 |
| Breaking vs opposite hand | +3 |
| Offspeed vs opposite hand | −7 |
| Fastball vs opposite hand | −11 |

**Feature shares** (share of pitch-weighted mean |SHAP|):

| Feature | Share |
|---|---|
| Velocity | 19% |
| Spin-axis deviation | 14% |
| Spin efficiency | 12% |
| Vertical movement | 7% |
| Velocity gap to the primary fastball | 7% |
| Horizontal movement | 7% |
| Spin rate | 7% |
| Handedness | 6% |
| Release height | 6% |
| Everything else | ≤ 4% each |

**What drives it:**

* **Velocity.** Fastballs run from −15 points at 88 mph to +16–27 at 99+. Breaking balls run
  from −13 at 75–78 mph to +20 at 93.
* **Spin-axis deviation (fastballs).** It is U-shaped: an axis that matches the movement
  (≈ 0°) is worst, at −17 vs same hand, and ±30° of deviation adds +20–30. That points to
  seam-shifted-wake movement being valuable.
* **Velocity gap (offspeed and breaking).** A 12–14 mph gap is worth +10–16; a 2–3 mph gap
  costs −17 to −20.
* **Spin efficiency.** Breaking balls gain with efficiency, up to +10–12 at 0.85. Fastballs
  vs opposite hand are U-shaped: pure backspin (> 1.1) gives +25, very low efficiency +14,
  and ~0.75 gives −13.
* **Movement.** Heavy arm-side run hurts fastballs (−9 at the extreme), while cut helps (+16
  vs same hand). Elite ride helps same-hand fastballs (+11). Big-drop breaking balls lose up
  to −10.

`output/shap_rv100_units.csv` has every 2026 pitcher × pitch type split into its baseline and
feature contributions. Some examples:

* **Chase Burns SL (132.1):** a +11 slider baseline, and velocity +16.7.
* **Jacob Misiorowski FF (126.7):** velocity +25.9 and spin rate +6.6.
* **Mason Fluharty FC (130.0):** spin-axis deviation +18.4 and cut +9.3, despite velocity −8.7.

Outputs:

* `output/shap_rv100_importance.csv`
* `output/shap_rv100_units.csv`
* `output/shap_rv100_{beeswarm,dependence}.png`

## DML vs a baseline stuff model (`baseline.py`)

The baseline has the same inputs, targets, groups and stages as the DML model, with the DML
step removed. Each sequential stage is fit directly as
P(stage | stuff features S, balls, strikes), with no location model, orthogonalization or θ.
It uses LightGBM `cross_entropy` with the tuned stuff settings and early stopping on held-out
pitchers. In-play stages use the same cross-fitted KNN soft labels. Scoring is identical:
count-neutral over the league count mix, or as-used at the actual count, with the same
linear weights, from the pitcher's side. Both models were trained on 2023–25, so 2026 is out
of time.

Units are pitcher × pitch type × season; correlations are weighted Spearman. Location
leakage is the weighted Pearson correlation with the unit's location-only expected run value.

| | DML rv100 | baseline | DML as-used | baseline as-used | observed RV |
|---|---|---|---|---|---|
| Descriptive, 2026 | .185 | .241 | .217 | .265 | 1 |
| Predictive, Y → Y+1 observed (pooled) | .182 | .235 | .202 | .254 | .175 |
| Predictive, 2025 → 26 | .181 | .228 | .205 | .245 | .172 |
| Reliability, Y → Y+1 self | **.887** | .843 | .853 | .816 | .175 |
| In-season alpha @ 10 pitches | **.911** | .863 | .831 | .732 | .015 |
| Chronological split @ 10 / 100 | **.86 / .93** | .80 / .89 | .78 / .91 | .68 / .86 | .00 / .10 |
| Pitches to reliability 0.5 (M) | **1.2** | 1.8 | 2.5 | 4.2 | 631 |
| Location leakage, 2026 | −.04 | −.02 | −.03 | .00 | .22 |

These are paired bootstrap estimates (resampling pitchers) of baseline minus DML:

| Measure | Baseline − DML | SE |
|---|---|---|
| Descriptiveness, 2026 | +.055 | .013 |
| Predictiveness, pooled (count-neutral and as-used) | +.053 | .010 |
| Year-to-year reliability | −.043 | .005 |

The two scores correlate .78 across 2026 units (.82 within pitch type).

**Reading it.** Neither model picks up pitcher-specific command: leakage is about 0 for both.
The difference is which stuff effect each measures.

* **DML** isolates the direct effect of stuff at a given location, i.e. how good the pitch is
  wherever it is thrown. That is more stable but less tied to results.
* **The baseline** measures the total effect, including what stuff does through where it ends
  up. A sweeper's break carries it off the plate, and a sinker's shape keeps it low. Those
  tendencies are persistent and matter for results.

So the DML step trades about .05 of descriptiveness and predictiveness for about .04 of
year-to-year reliability, and faster in-season stabilization. A middle ground would keep
DML's direct effect but average each pitch over locations predicted from its stuff, E[W | S],
instead of league-wide location draws. That puts back the location that stuff causes, while
still excluding command.

## Calibration (`calibration.py`)

These plots compare predicted with observed outcomes, one panel per class, for each model:

* `output/calibration_swing_take.png`
* `output/calibration_take_outcome.png`
* `output/calibration_swing_outcome.png`
* `output/calibration_in_play.png`
* `output/calibration_nine_outcomes.png`

Predictions are grouped into 20 equal-count bins and plotted with ±2 SE. ECE, the
count-weighted |observed − predicted|, is in `output/calibration_ece.csv`. Each panel has
three lines:

* **2026 location + stuff (out of time)**: the full pitch-level prediction.
* **2026 stuff only**: location-neutral, in the actual count. It is compressed by design: a
  pitch in the dirt and one down the middle get the same value, most visibly for ball.
* **2023–25 cross-fitted location + stuff**: leave-one-pitcher-out predictions.

**Training seasons.** The cross-fitted predictions are well calibrated, with ECE ≤ 0.005
for every class of every model.

**2026.** The ECE is 3–10× larger for the swing, take and swing-outcome models, and it is
mostly a shift in the league environment. Against the models' predictions:

| 2026 vs model | Change |
|---|---|
| Swing rate | 47.5% vs 45.4% |
| Called strikes per take | 31.0% vs 29.8% |
| Whiffs per swing | 25.1% vs 27.2% |
| Balls in play per swing | 36.5% vs 35.0% |

One log-odds shift per class roughly halves the ECE (whiffs 0.021 → 0.005). Batted-ball
classes barely moved: in-play ECE is 0.0006–0.0069, and the shifts are under 0.07 log-odds.

`rv100_plus` compares pitches with each other, so a league-wide shift largely washes out of
it. Absolute 2026 rates would need the league shifts refit on 2026 (the `calibrate` step)
before use.

## In-season reliability of rv100_plus and rv100_asused (`reliability.py --metric ...`)

Each unit is a pitcher × pitch type × season. `rv100_plus` is a fixed linear transform of the
unit's mean per-pitch `rv`, so every correlation-based reliability is the same for `rv100`
and `rv100_plus`. Observed run value (`rv100_observed`) is the baseline. The "within pitch
type" versions subtract the season's pitch-type mean from every pitch. That keeps sliders
vs sinkers from inflating the spread between units, so only slider-vs-slider differences count.

The table shows 2026 (out of time); 2023–25, the in-sample training seasons, are
within 0.01. "Pitches to reach 0.5 / 0.7 / 0.8" is per half for the split methods. Random
samples are averaged over 20 permutations.

| method | metric | r @ 10 | r @ 50 | r @ 100 | pitches to reach 0.5 / 0.7 / 0.8 |
|---|---|---|---|---|---|
| FanGraphs Cronbach's alpha | rv100_plus | .91 | .98 | .99 | ≤2 / 2 / 4 |
| | within pitch type | .86 | .97 | .98 | ≤2 / 4 / 7 |
| | observed RV | .01 | .05 | .07 | not within 1,000 |
| BP split-half (random) | rv100_plus | .91 | .98 | .99 | ≤2 / 2 / 4 |
| | observed RV | .01 | .04 | .09 | 673 / – / – |
| chronological split (first n vs next n) | rv100_plus | .86 | .92 | .93 | ≤2 / ≤2 / 5 |
| | within pitch type | .80 | .88 | .90 | ≤2 / 4 / 10 |
| variance components, n / (n + M) | rv100_plus (M = 1.2) | .89 | .98 | .99 | 1 / 3 / 5 |
| | within pitch type (M = 1.8) | .85 | .97 | .98 | 2 / 4 / 8 |
| | observed RV (M = 631) | .02 | .07 | .14 | 631 / 1,470 / 2,520 |

**Speed.** `rv100_plus` stabilizes almost immediately: a pitch's physical characteristics
barely vary from throw to throw, so a handful of pitches pins down the unit's stuff score.

**Drift.** The chronological split plateaus at about 0.93, or 0.92 within pitch type, even
at 200–400 pitches per half, while the random splits approach 1. Random splits hide
in-season drift: velocity and shape changes, the per-game primary-fastball reference, and
fatigue. So early-season stuff describes late-season stuff at about r = 0.93, not 0.99.

**Predicting results.**

* **Rest of the same season.** `rv100_plus` over the first 10 pitches correlates 0.11–0.15
  with observed run value over the rest of the season, or 0.15 within pitch type. Observed
  run value over the first 10 pitches correlates 0.04. Observed run value only catches up
  after about 200–400 pitches.
* **BP next-season curve.** This takes n random pitches in season Y and correlates them with
  observed run value over all of Y+1, using weighted Spearman pooled over the 2023–26 pairs.
  `rv100_plus` reaches r = 0.2 after **53 pitches** (85 for 2025→26 alone); BP reports 27
  for StuffPro. Observed run value needs **346** (318 for 2025→26); BP reports about 500.

**BP tables by pitch type** (weighted Spearman, 2023–26):

| | FF | SI | SL | CH | CU | FC | ST | FS | KC |
|---|---|---|---|---|---|---|---|---|---|
| Descriptiveness | .29 | .21 | .24 | .29 | .27 | .19 | .16 | .27 | .28 |
| Reliability | .85 | .83 | .76 | .87 | .81 | .72 | .71 | .81 | .84 |
| Predictiveness | .25 | .19 | .23 | .26 | .23 | .15 | .18 | .17 | .19 |

* **Descriptiveness:** same season, vs observed run value, weighted by pitches.
* **Reliability:** next season vs itself, weighted by the average pitches over the two seasons.
* **Predictiveness:** next season vs observed run value, with the same weights.

StuffPro's published ranges are .24–.57 for descriptiveness, .67–.84 for reliability and
.20–.51 for predictiveness (2020–23). So `rv100_plus` matches or beats StuffPro on
reliability and is lower on descriptiveness.

**rv100_asused** (`--metric rv100_asused`) is the same stuff model in the count each pitch was
actually thrown in. Every per-pitch value carries its count's run value, so the pitches in a
unit vary more.

| 2026 (out of time) | rv100_plus | rv100_asused |
|---|---|---|
| FanGraphs alpha @ 10 / 50 pitches | .91 / .98 | .83 / .96 |
| pitches to alpha 0.8 (within pitch type) | 4 (7) | 9 (12) |
| chronological split @ 10 / 100 per half | .86 / .93 | .78 / .91 |
| variance components M (within pitch type) | 1.2 (1.8) | 2.5 (3.4) |
| early 10 pitches vs rest-of-season observed RV | .11 | .14 |
| BP next-season curve: pitches to r = 0.2 (2025→26 alone) | 53 (85) | 14 (28) |

**BP tables, rv100_asused:**

| | FF | SI | SL | CH | CU | FC | ST | FS | KC |
|---|---|---|---|---|---|---|---|---|---|
| Descriptiveness | .29 | .18 | .27 | .27 | .28 | .23 | .19 | .28 | .31 |
| Reliability | .83 | .81 | .74 | .87 | .81 | .67 | .72 | .82 | .81 |
| Predictiveness | .24 | .17 | .26 | .25 | .26 | .15 | .17 | .16 | .13 |

**Comparison.**

* **Stability.** The as-used version is a little less stable in-season: about twice the
  pitches for the same reliability, though still under 10 pitches to 0.8 overall.
* **Next-season results.** It reaches r = 0.2 with next season's results much sooner, because
  deployment by count (how often a pitch is thrown ahead or behind) carries over between
  seasons along with the stuff.
* **By pitch type.** Year-to-year reliability and predictiveness are about the same as
  rv100_plus. It is better for breaking balls (SL, CU) and worse for FS/KC.

### Pitching and Location (`--metric rv100_pitching`, `--metric rv100_location`)

2026 (out of time), pitcher × pitch type:

| | M (pitches to 0.5) | alpha @ 50 / 100 / 400 | chronological @ 100 | BP next-season r = 0.2 | early vs rest (obs) @ 100 |
|---|---|---|---|---|---|
| Stuff (rv100_plus) | 1.2 | 0.98 / 0.99 / 1.00 | 0.93 | 53 pitches | 0.14 |
| Pitching | 78 | 0.39 / 0.54 / 0.80 | 0.44 | 96 pitches | 0.13 |
| Location | 99 | 0.34 / 0.49 / 0.76 | 0.43 | never | 0.02 |
| observed RV | 631 | 0.05 / 0.07 / 0.24 | 0.10 | 346 pitches | 0.12 |

* **Pitching needs about 80 pitches to reach 0.5**, against 1 for Stuff and 630 for observed
  RV. Its next-season predictive curve crosses 0.2 at 96 pitches, and at 100+ pitches it
  predicts about as well as Stuff.
* **Location is as reliable in-season as Pitching** (M = 99) but predicts neither the rest of
  the season (r ≈ 0) nor the next season (never above 0.09). Its stable part is a consistent
  location tendency the location model values, which does not show up in later results.
* **By pitch type** (2023–26, weighted Spearman):
  * Pitching is more descriptive than Stuff for every type (FF 0.42 vs 0.29), less reliable
    year to year (0.37–0.62 vs 0.71–0.87), and about as predictive (FF 0.28 vs 0.25; weaker
    for SL and CU).
  * Location's year-to-year reliability is 0.38–0.55, with predictiveness of 0.15 at best
    (FF) and ≤ 0 for SL, CU and SV.

Outputs:

* `output/reliability_curves_<metric>.csv`, with every curve;
* `output/reliability_<metric>.log`;
* `output/reliability_<metric>.png`.

## Year-to-year predictiveness of rv100 (`yoy_rv.py`)

Each season was scored with the same 2023–25 models, count mix and run values. The inputs are
`output/pitch_outcomes_leaderboard_<season>.csv` and `output/stuff_leaderboard_<season>.csv`.

Pairs are pitcher × pitch types thrown in consecutive seasons. Each pair is weighted by the
harmonic mean of its pitches thrown in the two years, and SEs come from a pitcher-clustered
bootstrap. 2023–25 are training seasons, so their scores are in-sample; 2026 is out of time.

| weighted r | 2023→24 | 2024→25 | 2025→26 |
|---|---|---|---|
| rv100 → next rv100 (stability) | .913 | .894 | .911 |
| rv100 → next observed RV | .193 | .139 | .166 |
| rv100_asused → next observed RV | .210 | .156 | .189 |
| observed RV → next observed RV | .148 | .151 | .131 |

**Stability.** `rv100` is very stable: r ≈ 0.91 overall, 0.92 vs same hand and 0.91 vs
opposite hand in 2025→26. The out-of-time pair matches the in-sample pairs, so fitting on those
seasons does not visibly inflate stability.

**Predicting next season's results.** `rv100` beats last season's results in two of three
pairs:

* 2023→24: +0.044 (SE 0.024);
* 2024→25: −0.012 (SE 0.022);
* 2025→26: +0.035 (SE 0.024).

The as-used version does better: +0.062, +0.005 and +0.058. That is because future results
also depend on how a pitch is deployed across counts, which persists, and `rv100` removes it by
design.

**Ceiling.** Every r against observed RV is low, because pitch-type observed run value is
dominated by noise (pitch-weighted SD 1.68 vs 0.47 for `rv100`).

**By pitch family, 2025→26.**

| Family | Stability | Next-year observed | Observed → observed |
|---|---|---|---|
| Fastball | .886 | .224 | .160 |
| Breaking | .882 | .202 | .111 |
| Offspeed | .896 | .174 | .126 |
| Cutter | .761 | .130 | .096 |

Cutters are least stable. Their primary or secondary role, and so their model, can change
between seasons.

## Run values of the nine outcomes (`runvalue.py`)

Linear-weight run values for each nine-outcome class. They are count-neutral, so they apply to
the count-neutral `p_<outcome>` columns. The inputs are 2023–26 game state from statfast (outs,
runners, score), saved as `data/gamestate_<season>.parquet`. Seasons are weighted **2023:1,
2024:2, 2025:3, 2026:4**. Each season sums to its weight, so a partial season is not
down-weighted by size.

1. **RE24.** Expected runs from each base-out state to the end of the half-inning. It uses
   innings 1–8 only, which avoids walk-off truncation and the extra-inning runner. For example,
   bases empty with 0 outs is 0.502 runs and bases loaded with 0 outs is 2.459.
2. **Linear weights.** A plate appearance's value is RE(after) − RE(before) + runs scored. Each
   terminal event's weight is its mean over plate appearances:

   | Event | Runs |
   |---|---|
   | BB | +0.338 |
   | HBP | +0.357 |
   | K | −0.270 |
   | field out | −0.256 |
   | 1B | +0.471 |
   | 2B | +0.763 |
   | 3B | +1.035 |
   | HR | +1.386 |

   A field out includes errors, fielder's choices, sacrifices and double plays, as in the
   in-play model.
3. **Count values.** V(c) is the mean plate-appearance value from count c. It ranges from
   −0.097 at 0-2 and 0.000 at 0-0 to +0.216 at 3-0.
4. **Pitch run value by count.** RV(o, c) is V(count after) − V(count before). When the pitch
   ends the plate appearance, it is instead the plate appearance's value − V(count before).
   So a two-strike foul is 0, a three-ball ball is a walk, and a two-strike strike is a
   strikeout. The full grid is in `output/run_values_by_count.csv`.
5. **Count-neutral value.** RV_o is RV(o, c) averaged with weights mix[c] × P_league(o | c).
   Here mix[c] is the league count mix used by the count-neutral leaderboard. This makes
   Σ_o p_o · RV_o a pitch's count-neutral expected run value. The league-average pitch comes
   to +0.0001 runs.

| outcome | run value (batting side) | league share |
|---|---|---|
| ball/HBP | +0.0613 | 36.1% |
| called strike | −0.0646 | 16.3% |
| swinging strike | −0.1168 | 11.9% |
| foul | −0.0342 | 18.0% |
| field out | −0.2471 | 12.0% |
| single | +0.4812 | 3.68% |
| double | +0.7680 | 1.09% |
| triple | +1.0428 | 0.09% |
| home run | +1.3828 | 0.80% |

A swinging strike is worth almost twice a called strike. Whiffs are much more common with two
strikes, where a strike is a strikeout (−0.18 to −0.33), while called strikes cluster early
(−0.04 to −0.07). A foul is 0 with two strikes, so its average is small. Positive values
favour the hitter, so flip the sign for pitcher value. Outputs: `output/run_values.csv` and
`output/run_values_by_count.csv`.

## In-play model: batted-ball outcomes (`--target in_play`, `inplay.py`)

**Target.** A KNN on (hitter hand, exit velocity, launch angle, spray angle) gives each ball
in play its expected P(field_out, single, double, triple, home_run).

* The hand match is exact; the three continuous features are standardized.
* k is chosen by pitcher-grouped CV log loss: k = 100 (0.445), with k = 50 at 0.449 and
  k = 200 at 0.449.
* Probabilities are smoothed toward the class prior.
* Training uses out-of-fold KNN probabilities, so no ball in play sees its own outcome.

**DML stage.** These soft labels feed the same DML process as the other targets. Balls in
play (bunts excluded) are the sample: 364,904 in 2023–25. The pipeline is:

* the location model l(W);
* the stuff index boosted from the logit l(W) offset;
* the orthogonal θ for each of the 12 counts, pooled across neighbouring counts;
* location-neutral probabilities, calibrated to the league.

The sequential link uses soft-label stages. Each stage is weighted by P(class ≥ s) and
fitted to P(s) / P(≥ s) with LightGBM's `cross_entropy` objective.

**Count-neutral 2026 estimates** (`inplay.py`). Every 2026 pitch is scored at all 12
counts, then weighted by the league in-play count mix. That mix is 16% at 0-0, 0.2% at 3-0
and 8% at 3-2. There are 693,820 pitches, and the five probabilities sum to 1 on each.

| | actual (BIP) | KNN expected | count-neutral stuff |
|---|---|---|---|
| field_out | .681 | .682 | .675 |
| single | .208 | .208 | .210 |
| double | .061 | .061 | .063 |
| triple | .006 | .006 | .006 |
| home_run | .045 | .044 | .047 |

**2026 out-of-time fit** (sequential; cross-entropy against the KNN target):

| predictor | loss |
|---|---|
| count/hands shares | 0.920 |
| count/hands + stuff, no location | 0.917 |
| location only | 0.908 |
| location + stuff | 0.904 |

Location + stuff is best in all six group × matchup models. The split-half reliability of
x<class>+ is 0.96–0.99.

Outputs:

* `output/in_play_stuff_2026.parquet`
* `output/in_play_leaderboard_2026.csv`, one row per pitcher × pitch type
* `output/in_play_leaderboard_2025.csv`

### Sequential (4 binary stages) vs one multinomial softmax (`compare_inplay.py`)

**The softmax link** (`--link softmax`) fits one soft-label multiclass booster for each
nuisance: l(W), and the stuff index D(S) boosted from the log l(W) offset.

* It uses a custom softmax objective, which starts from the log class priors. Without them,
  custom objectives start from uniform probabilities.
* θ is fitted by a multinomial Newton step with a block Hessian, using the same count
  pooling.
* The r(W) projection is orthogonalized per class, which is a diagonal approximation.

Both models were trained on 2023–25 with the same tuned settings. They are compared on the
same 119,256 balls in play from 2026:

| 2026 loss (sequential − softmax) | vs actual | z | vs KNN | z |
|---|---|---|---|---|
| location only | −0.00039 | −5.0 | −0.00031 | −6.6 |
| location + stuff | −0.00083 | −6.4 | −0.00073 | −8.6 |
| stuff only (count-neutral) | −0.00029 | −2.8 | −0.00025 | −3.7 |

Negative means the sequential model is better. The z values use pitcher-clustered SEs.

The other checks:

* **Year over year.** Year-over-year correlations of 2025 count-neutral estimates with 2026
  rates (461 pitcher × pitch types with at least 50 balls in play in each season) are mixed
  and within noise. Examples:
  * singles: .420 sequential vs .410 softmax against the KNN rate;
  * home runs: .327 vs .311;
  * triples: .275 vs .331.
* **Split-half reliability.** Split-half reliability is 0.95–0.99 for both, with sequential
  marginally higher in most cells.
* **Agreement.** The two models' 2026 estimates per pitcher and pitch type correlate
  0.93–0.99.

**Verdict.** The sequential model is more accurate on every pitch-level measure, and the
difference is statistically clear. It is also very small, about 0.1% of the loss, and the
two produce nearly the same rankings.

The sequential model stays the default for these reasons:

* It is exact under DML: each stage is a binary partially linear logit with its own
  orthogonal score. The softmax version needs the diagonal orthogonalization approximation.
* It is slightly more accurate.
* It shares the code path with the other targets.

## Current models: count-pooled θ, trained 2023–25, tested on 2026 (`run_all.sh`)

**Count pooling.** Each stage's θ is penalized by λ · Σ over adjacent counts of (θ_c − θ_c′)²,
where adjacent means one ball or one strike apart. λ is chosen per stage by pitcher-grouped
5-fold CV, as a multiple of the mean per-count Fisher information. The chosen λ follows the data
volume: 0.03–0.3 for fastball and whiff stages, up to 10–30 for the thin offspeed foul stages and
the breaking/offspeed opposite-hand called-strike stages. The unstable rare-count slopes (e.g.
−11.0 and 7.55 at 3-0) now sit at 0.65–1.25, while well-populated counts barely move. The
pooled standard errors are optimistic (they ignore smoothing bias).

Outputs per target `<T>`:
- `output/<T>_logit_2325.parquet` / `.pkl`: training output and model;
- `output/<T>_2026_scored.parquet`: 2026 scored;
- `output/<T>_leaderboard_2025.csv` and `_2026.csv`: leaderboards;
- `output/eval_<T>_2026.log`: the evaluation report;
- `output/tuned_<T>.json`: the tuned settings.

The unpooled whiff run is kept as `output/unpooled_*`.

| | Whiffs (`swing_outcome`) | Called strike given take (`take_outcome`) | Swing/take (`swing_take`) |
|---|---|---|---|
| rows (2023–25) | 1.01M swings | 1.10M takes | 2.11M pitches |
| training time | 2.8 h | 2.1 h | 7.9 h |
| 2026 log loss, location → + stuff | 0.974 → 0.963 | 0.1408 → 0.1406 | 0.483 → 0.478 |
| 2026 AUC of main class, location → + stuff | whiff .756 → .770 | .9863 → .9863 | .846 → .850 |
| split-half r of x+ (pitcher × type) | 0.97–0.99 | 0.98–0.99 | 0.96–0.99 |

**Year over year: 2025 predictor vs 2026 location-adjusted rate** (r, per pitcher × pitch type,
by the smaller season's sample size):

| sample size | Swing: observed / obs−loc / p_stuff | Called strike: observed / obs−loc / p_stuff |
|---|---|---|
| 25–50 | .22 / **.31** / .19 | **.14** / .09 / .04 |
| 50–100 | .26 / **.33** / .11 | **.21** / −.03 / .15 |
| 100–200 | .35 / **.49** / .24 | **.21** / .09 / .17 |
| 200–400 | .54 / **.66** / .33 | .25 / .04 / **.25** |

* **Whiffs:** stuff matters most here. The results match the earlier unpooled run (see the
  next section): the stuff score out-predicts results at small and medium samples.
* **Swing/take:** stuff adds a little on top of location (log loss −0.006). The pitcher's
  location-adjusted swing rate is the better year-over-year predictor at every sample size. A
  lot of what makes hitters swing is persistent pitcher-specific skill beyond pitch physics:
  deception, tunneling, sequencing, count usage.
* **Called strikes:** almost entirely location and count (AUC 0.986). The stuff score is
  reliable (0.98) but barely predictive (log loss −0.0002). Location-adjusted called-strike
  rate is not a stable pitcher trait from year to year (r ≈ 0); catchers, umpires and 2026's
  ABS challenge system dominate it. xCalledStrike+ is best read as a small, stable shape effect
  (e.g. deceptive movement getting takes called), not a meaningful skill.

## Whiff model, unpooled θ (superseded by the pooled run above; trained 2023–25, tested on 2026)

Training data is 1.01M swings from 2023–25. There are six matchup models, θ varies over all 12
counts, and every model uses the tuned settings. Held-out groups are pitchers across all their
seasons. Training took 2.8 hours. Outputs:
- `output/swing_outcome_logit_2325.parquet` / `.pkl`: training output and model;
- `output/swing_outcome_2026_scored.parquet`: 2026 scored with no refitting;
- `output/swing_outcome_leaderboard_2026.csv`: the 2026 leaderboard;
- `output/eval_2026.log`: the evaluation report.

**Tuning** (`output/tuned_params.json`, 60 Optuna trials in about 40 minutes) improved
cross-validated loss by only 0.03–0.07% over the defaults. The tree counts it found matter
more: the stuff index needs about 75–200 trees (it was 300, overfitting), the location model
about 230–725 (it was 200), and the projection about 50–145.

**2026 out of time, pitch level** (330k swings, 710 pitchers). Adding stuff to location lowers
log loss in every model:

| | log loss, location → + stuff | AUC whiff | AUC foul | AUC in play |
|---|---|---|---|---|
| all | 0.974 → 0.963 | .756 → .770 | .609 → .615 | .671 → .688 |

**Year over year: 2025 → 2026, pitcher × pitch type.** Targets are 2026 rates net of location
expectation, and each entry is the correlation r, split by the smaller of the two seasons'
swing counts:

| swings | whiff: observed / obs−loc / p_stuff | foul: observed / obs−loc / p_stuff | in play: observed / obs−loc / p_stuff |
|---|---|---|---|
| 10–25 | .30 / .27 / **.32** | .05 / .05 / .04 | .26 / .26 / **.32** |
| 25–50 | .36 / .35 / **.41** | −.01 / .01 / **.12** | .22 / .19 / **.27** |
| 50–100 | .46 / .50 / **.56** | .04 / .04 / **.15** | .43 / .44 / .44 |
| 100–200 | .53 / **.56** / .51 | .08 / .11 / **.20** | **.55** / .54 / .54 |
| 200+ | .58 / **.67** / .56 | .28 / .36 / **.44** | .65 / **.66** / .55 |

* **Where the stuff score wins:** it predicts next season's location-adjusted whiff and
  in-play rates better than the pitcher's own results up to about 50–100 swings. For fouls it
  wins at nearly every sample size.
* **Where results win:** at 200+ swings, location-adjusted results take over for whiff and in
  play. They carry persistent pitcher skill the stuff score deliberately excludes (deception,
  sequencing, command within the zone).
* **Raw 2026 rates:** observed rates win on raw 2026 rates, which also carry location habits
  and pitch mix. x+ is centred within each model, so use `p_<class>_stuff` for cross-group
  prediction.
* **θ over 12 counts:** the whiff slopes are mostly 0.8–1.5 and significant, smallest with two
  strikes (0-2: 0.72–0.98). Counts with few swings (3-0, 3-1) give unstable, non-significant
  slopes. The foul stage in Offspeed vs Opposite Hand is the worst: −11.0 at 3-0. Pooling rare
  counts toward their neighbours would fix this.
* **Location residuals:** Fastball vs Same Hand foul stuff correlates with pitchers' mean
  height (pitcher-level r = 0.73, within-type 0.32), since riding four-seamers are both fouled
  off and thrown up. Offspeed's within-type height residual on whiffs remains (+0.37 to
  +0.40).

## 2025 swing-outcome results (logit link: whiff / foul / in-play)

`output/swing_outcome_logit_2025.parquet` / `.pkl`. The leaderboard is in
`output/swing_outcome_leaderboard_2025.csv`. 335k swings, 6 models × 2 stages, 53 minutes.

Class probabilities sum to 1 on every pitch (range 0.07–0.61). After the league shifts (+0.134
and +0.037 log-odds), their means equal the observed shares exactly: 25.33% whiff, 37.94% foul,
36.73% in play. The location models are calibrated far from the zone too: 65.2% / 22.3% /
12.5% predicted vs 65.5% / 22.3% / 12.2% actual.

| | FB vs RHH | FB vs LHH | BRK vs RHH | BRK vs LHH | OFF vs RHH | OFF vs LHH |
|---|---|---|---|---|---|---|
| theta, whiff stage (0K / 1K / 2K) | .88 / .86 / .73 | .87 / .77 / .63 | .67 / .66 / .52 | .62 / .51 / .51 | .56 / .42 / .26 | .44 / .46 / .37 |
| theta, foul stage (0K / 1K / 2K) | .70 / .80 / .67 | .62 / .67 / .64 | .19 / .30 / .30 | .14 / .27 / .08 | .09 / .17 / .08 | .17 / .25 / .22 |
| log loss: location → + stuff | .992 → .981 | .998 → .987 | .936 → .933 | .938 → .935 | .997 → .996 | 1.003 → 1.001 |
| AUC whiff / foul / in-play (full) | .724 / .550 / .672 | .708 / .546 / .662 | .802 / .640 / .696 | .794 / .639 / .707 | .736 / .623 / .672 | .733 / .591 / .663 |
| split-half r, x+ whiff / foul / in-play | .98 / .96 / .98 | .97 / .93 / .98 | .97 / .96 / .97 | .97 / .96 / .97 | .96 / .93 / .96 | .96 / .93 / .95 |

* **Whiff agrees with the linear model.** At the pitcher × pitch type × model level (50+
  swings), logit and linear xWhiff+ correlate 0.985.
* **Foul vs in-play depends on stuff mainly for fastballs.** The foul-stage theta is 0.6–0.8
  for fastballs but only 0.08–0.30 for breaking and offspeed, where some are not significant.
  For secondary pitches, whether contact is fouled off or put in play is mostly location and
  count.
* **xFoul+ has little raw spread.** Its swing-weighted SD is 3.3 before the leaderboard's
  100/15 standardization, so differences in xFoul+ are smaller in probability terms than
  equal differences in xWhiff+ (raw SD 11.7) or xInPlay+ (raw SD 8.0).
* **The leaders are plausible.** Whiff: Tanner Scott FF, Edwin Díaz FF, Josh Hader SI. Foul:
  riding four-seamers such as Rodón, Estrada and Stanek. In play: sinkers from Hendricks,
  Irvin, Holmes and Bassitt.
* **Offspeed keeps its location residual in every class.** Within a type, pitchers who work
  higher have higher whiff scores (+0.32) and lower foul and in-play scores (−0.26 to −0.33).

## 2025 whiff results (linear link, hand-split, LightGBM location model, no pitch-type features, rescaled)

`output/whiff_stuff_2025_hand.parquet` / `.pkl`. 335k swings, 6 models, 41 minutes with the
naive comparison. The league baseline factor is 1.084, and the mean `p_whiff_stuff` equals the
observed 25.33%.

| | FB vs RHH | FB vs LHH | BRK vs RHH | BRK vs LHH | OFF vs RHH | OFF vs LHH |
|---|---|---|---|---|---|---|
| swings | 95,660 | 73,682 | 68,342 | 48,269 | 23,556 | 25,394 |
| theta 0K / 1K / 2K | .90 / .88 / .69 | .86 / .79 / .58 | .69 / .65 / .46 | .59 / .50 / .49 | .54 / .37 / .23 | .41 / .45 / .32 |
| AUC l(W) → + stuff | .706 → .724 | .690 → .709 | .799 → .802 | .791 → .794 | .733 → .737 | .731 → .736 |
| score variance from location, naive → DML | .103 → .022 | .046 → .003 | .099 → −.006 | .145 → −.003 | −.003 → −.009 | −.001 → −.002 |
| pitcher R² on location, naive → DML | .35 → .12 | .17 → .06 | .17 → .00 | .32 → .01 | .06 → .10 | .03 → .08 |
| within-type corr(score, height), DML | −.03 | +.05 | −.01 | −.11 | +.32 | +.32 |
| xWhiff+ split-half r | .971 | .968 | .972 | .972 | .963 | .966 |

* **The location model is calibrated now.** It predicts a 65.2% whiff rate on
  far-from-zone swings against an actual 65.5%; the old kernel predicted 52.7%. Its league
  mean matches the observed rate.
* **Every theta is significant** (z = 3.5–19) and smaller with two strikes. Fastball slopes
  are about 0.9, so the index is close to calibrated. Offspeed slopes are 0.2–0.5.
* **Offspeed remains the one location residual.** Within a type, pitchers who keep their
  changeups or splitters higher score higher (r ≈ +0.32 for both batter hands).

The section below is from the earlier model (kernel location model, pitch-type features,
pooled batter hands). It is kept for comparison.

## 2025 whiff results, earlier model (all regular season, leave-one-pitcher-out, cutters split by role)

335k swings with a 25.3% whiff rate. The run took 26 minutes and includes the naive
comparison model.

| | Fastball | Breaking | Offspeed |
|---|---|---|---|
| swings / pitchers | 169,342 / 723 | 116,611 / 719 | 48,950 / 596 |
| AUC: count only → + DML stuff (no location) | 0.541 → 0.613 | 0.552 → 0.586 | 0.553 → 0.572 |
| AUC: location+count → + DML stuff | 0.693 → 0.715 | 0.793 → 0.797 | 0.733 → 0.741 |
| share of score variance explained by location, naive → DML | 0.096 → 0.030 | 0.158 → 0.003 | 0.013 → −0.007 |
| pitcher × type: corr(score, mean height), naive → DML | +0.50 → +0.26 | −0.51 → −0.12 | +0.10 → +0.20 |
| same, within pitch type | +0.04 → −0.03 | −0.24 → −0.05 | +0.19 → +0.32 |
| split-half r: xWhiff+ vs observed whiff − l(W) | 0.98 vs 0.56 | 0.98 vs 0.50 | 0.98 vs 0.65 |
| xWhiff+ SD (pitch level) | 30.5 | 15.6 | 17.8 |

* **Stuff matters far more for whiffs than for swings.** For fastballs, stuff alone lifts AUC
  from 0.54 to 0.61 without any location. Theta is 0.6–1.1 and strongly significant for most
  types (four-seam z ≈ 20).
* **The naive model is heavily location-driven for whiffs.** Its pitcher-level location R² is
  0.33 for Fastball and 0.31 for Breaking. The DML score removes most of it, and within fastball
  and breaking types its correlation with location is about 0.
* **Offspeed is the exception.** Within a type, pitchers whose changeups or splitters sit
  higher score *higher* (r = +0.32). This comes from the stuff index itself (D: +0.30), not
  from the DML step, so it is either real (pitchers with elite drop can work higher) or
  shape-driven location that the model can't separate out.
* **Cutters.** Primary cutters whiff 23.4%, above the Fastball average, so they average
  xWhiff+ 125. Secondary cutters whiff 21.7%, below the Breaking average, so they average 91.
* **Extrapolation.** Leave-one-pitcher-out means a pitcher with a one-of-a-kind release is
  scored by models that never saw that slot. The Breaking leader is Tyler Rogers' submarine
  slider (145), which should be read with that in mind.

## 2025 swing results (all regular season, leave-one-pitcher-out)

These results come from the earlier grouping, with every FC in Fastball. Rerun with
`--target swing` to apply the cutter roles.

699k swing decisions. The run took 56 minutes on 12 cores (6 workers × 2 threads) and
includes the naive comparison model.

| | Fastball | Breaking | Offspeed |
|---|---|---|---|
| pitches / pitchers | 384,537 / 722 | 217,348 / 710 | 96,111 / 616 |
| log loss: location+count → + DML stuff | 0.4838 → 0.4813 | 0.5074 → 0.5049 | 0.4799 → 0.4791 |
| AUC: location+count → + DML stuff | 0.849 → 0.852 | 0.829 → 0.832 | 0.857 → 0.858 |
| share of score variance explained by location, naive → DML | 0.057 → 0.017 | 0.061 → 0.021 | 0.050 → −0.002 |
| pitcher × type: corr(score, mean height), naive → DML | +0.21 → −0.05 | +0.01 → −0.05 | −0.08 → −0.09 |
| same, within pitch type | +0.00 → −0.18 | −0.09 → −0.12 | −0.07 → −0.06 |
| split-half r: xSwing+ vs observed swing − l(W) | 0.98 vs 0.57 | 0.98 vs 0.45 | 0.96 vs 0.40 |
| xSwing+ SD (pitch level) | 10.2 | 10.7 | 3.5 |

What the run shows:

* **Theta is about 1 for fastballs** (0.74–1.09 across types and counts, all z > 7). The
  fastball stuff index is well calibrated at a fixed location. **Offspeed theta is
  0.1–0.6**: most of the offspeed index's variation doesn't move swings once location is held
  fixed, so DML shrinks it (SD 3.5). With two strikes, slider theta falls to 0.30 while
  sweepers stay at 0.87.
* **Stuff adds a small but consistent amount beyond location.** Swing decisions are mostly
  location and count.
* **Location invariance.** The DML score's pitch-level dependence on location is a third of
  the naive model's or less. At the pitcher level it removes the naive model's
  "fastballs thrown up get swung at" leak (+0.21 → −0.05). One residual remains: *within*
  fastball types, pitchers who work higher score about −0.18 lower. That fits pitchers
  choosing locations to suit their shape (for example, ride up and sink down), which no
  location adjustment can tell apart from leakage. An adversarial or intended-location
  approach would be the next step if it matters.
* **Limitation.** The additive probability scale can clip in 3-0 counts, where the baseline is
  about 9%. That produces xSwing+ values far outside the 1st–99th percentile range (67–130).

## Standardizing release position by pitcher height (`height_release.py`)

Pitcher heights come from the MLB Stats API (`data/pitcher_heights.csv`; all 1,487 pitchers
from 2023–26, mean 6'2", SD 2.4"). Three stuff designs were refit in the DML stuff step D(S)
of every stage of all four targets and six models, each boosted from the cached cross-fitted
location offset l(W). Fits used the tuned settings and 5-fold pitcher-grouped CV on 2023–25.

* `raw`: the current design.
* `per_height`: `rel_z`, `rel_x_m` and `extension` divided by height.
* `rel_z/height`: only `rel_z` divided by height (`--designs rel_z/height --tag _relz`).
* `raw+height`: the current design plus height as a feature.

The score is held-out stuff lift: deviance explained beyond location and count.

**Height explains little of the release point.** At the pitcher level its correlation with
release height is 0.20–0.25, with release side 0.03–0.07, and with extension 0.33–0.38.

**Neither design beats raw.** Change in held-out lift vs raw, as % of raw's lift (z in
parentheses, from pitcher-clustered SEs):

| stage | per_height | rel_z/height | raw+height |
|---|---|---|---|
| swing | +1.2% (1.2) | +0.4% (0.5) | −2.7% (−3.2) |
| called strike | −6.9% (−2.0) | −5.4% (−2.1) | +0.8% (0.3) |
| whiff | 0.0% (0.0) | +0.1% (0.3) | −0.6% (−1.4) |
| foul | −0.6% (−0.9) | +0.6% (1.0) | −0.4% (−0.7) |
| in play: field out | +7.8% (1.1) | +4.7% (0.8) | −3.3% (−0.5) |
| in play: single | +2.1% (2.6) | +1.4% (2.3) | +1.8% (2.5) |
| in play: double | −9.1% (−2.1) | −3.2% (−0.9) | −2.1% (−0.5) |
| in play: triple | −1.0% (−0.1) | −4.8% (−0.5) | +1.9% (0.2) |

The wins and losses cancel. Scaling only `rel_z` is the closest to neutral: smaller
swings either way, but the same pattern (a little better on singles, worse on called
strikes). Height as its own feature mostly hurts: across held-out
pitchers it acts as a near pitcher identifier, which the trees memorize.

**It would still reshuffle leaderboards a little.** Unit-level D(S) correlates 0.95–0.99
between raw and per_height (0.97–0.996 for rel_z/height). The shift is 14–31% of D's SD
(9–24% for rel_z/height) and correlates ±0.1–0.4 with height, so short and tall pitchers move without any accuracy gain. Raw feet stay in the
model: the batter sees the absolute release point.

## Arm angle (`arm_angle.py`, `height_release.py --designs raw+arm_angle raw+arm_angle_savant`)

The estimate is the adopted OLS form from `../arm_angle/arm_angle_estimator.py`, refit to
Savant's measured `arm_angle` (`data/savant_arm_angle.parquet`, 2.6M labeled pitches from
2023 to 2026-08-02; join key `at_bat_number = at_bat_index + 1`).

* **Inputs are this project's back-propagated release point.** It matches Savant's
  `release_pos_x/z` to 0.003 ft. statfast's raw `release_pos_z` sits at the 50 ft fit point,
  0.1 ft low, so it is not used.
* **Fit:**
  `arm_angle = 32.39 − 23.13·height + 6.49·extension − 3.09·rel_x_m + 19.78·rel_z`
  (`output/arm_angle_ols.json`).
* **Accuracy:** pitcher-grouped CV per pitch gives R² 0.76 and MAE 4.9°. Pitcher-season means
  track the measured values at r = 0.90.

Refit in the D(S) harness above (change in held-out lift vs raw, % of raw's lift, z in
parentheses):

| stage | raw + estimate | raw + Savant measured |
|---|---|---|
| swing | +0.1% (0.1) | +1.5% (1.6) |
| called strike | −2.2% (−0.8) | +0.5% (0.2) |
| whiff | +0.8% (1.8) | +2.7% (4.6) |
| foul | +0.3% (0.5) | +2.2% (3.5) |
| in play: field out | +4.8% (0.7) | +11.2% (1.6) |
| in play: single | +1.1% (1.5) | +2.7% (3.2) |
| in play: double | −5.1% (−1.2) | +2.0% (0.5) |
| in play: triple | +0.9% (0.1) | +4.9% (0.4) |

* **The estimate adds nothing reliable.** It improves 22 of 48 model stages and none
  significantly. It is a linear function of inputs the trees already have, plus height.
* **Measured arm angle helps consistently.** It improves every stage type (32 of 48 stages,
  6 significantly), about +2–3% on whiff, foul and single. Body tracking carries something the
  ball's release point does not.
* **Using it would need a retrain and a Savant source.** statfast has no arm angle, so new
  pitches would need Savant's value or fall back to the estimate. Unit-level D(S) correlates
  0.96–0.99 with raw.

## Post-All-Star-break Pitching+ (`post_asb_pitching.py`)

2026 games from July 16 (the All-Star Game was July 14), scored by `score_pitches.py`.
`output/pitching_post_asb_2026.csv` has one row per pitcher: Pitching+ over all their pitches on
the pitch-modeling `pitcher_season` scale, then one `<pt> Pitching+` column per pitch type on the
`pitcher_season_pitch_type` scale. A type's cell is blank below 10 pitches (`--min-type`). No
pitcher minimum; filter on `Pitches`.

## Stuff and Pitching SHAP per pitcher-season-pitch type (`shap_values.py`)

The `shap_rv100.py` surrogate method applied to `score_pitches.py`, for two models: Stuff (the
count-neutral `stuff_rv` and its nine count-neutral outcome probabilities) and Pitching
(`pitching_rv` and its nine location-aware probabilities). Each model x target x group-matchup
model gets its own surrogate: XGBoost on the GPU, depth 6, at most 1,000 trees. TreeSHAP time
grows with trees x leaves x depth², so LightGBM's CPU TreeSHAP on 127-leaf models (~170 pitches/s)
was far too slow for 2.8M pitches x 22 targets. The inputs are the stuff features, hand and
season, plus the location (`x_b`, `z_n`) and the count for Pitching. Without season, 2023-24
units sat about 3 Stuff+ points above what the surrogate predicted and 2025-26 units about 2.5
below (the models' season terms). Plus targets are on the pitch-modeling
`pitcher_season_pitch_type` scale.

Held-out-pitcher R² is 0.965-0.987 for Stuff+ and 0.985-0.987 for Pitching+, and at least 0.906
for every probability. Unit residuals (100+ pitches) have a 5-95% range of ±0.5 points for Stuff+
and ±1.4 for Pitching+, and ±0.25 percentage points or less for the probabilities.

Mean |SHAP| per pitch:

- Stuff+: velocity 7.5, seam-shifted wake 5.4, spin efficiency 4.8, season 3.4.
- Pitching+: horizontal location 42.9, vertical location 39.4, balls 18.6, strikes 14.8, velocity
  5.2.

A twelfth target, `wobacon`, puts each model's batted-ball probabilities on one scale:
(0.9 single + 1.25 double + 1.6 triple + 2 home_run) / P(in play), with field outs 0. Its proxy is
trained with P(in play) weights, and a unit averages its pitches with the same weights, so the
result is per ball in play (league .368 for Stuff). Held-out R² for the Stuff proxy is
0.973-0.990, and the 5-95% range of unit residuals is ±.0006.

Nine more targets, `rv_<outcome>`, turn each predicted outcome into plus points: probability x
the outcome's average (count-neutral) run value on the plus scale, minus the league mean. That
makes `rv_<outcome>` = `p_<outcome>` x -15 x weight / sd, so its SHAP rows are exact scaled
copies of the probability rows, with no new proxies for either model. For Stuff the nine sum
exactly to Stuff+ - 100. Pitching+ prices outcomes at the pitch's actual count, so for Pitching
the remainder is count leverage: 0 on average, SD 5.6 points for units with 300+ pitches (-15 to
+22). `--by outcome` on the card draws the split, with count leverage as its own bar. The
in-play outcomes offset each other: a pitch that allows fewer balls in play gives up fewer hits
(plus) and also records fewer in-play outs (minus). `unit_values_<season>.parquet` has every unit's exact values for both models in one
row.

Published to R2 `shap-values/` (`publish_shap_values.py`). `shap_values_card.py` draws a
waterfall for any unit, model and target from there.

## Pitches per inning from predicted outcome rates (`pitches_per_inning.py`)

IP-weighted linear model of official pitches per inning (MLB Stats API `numberOfPitches` / IP)
on a pitcher-season's per-pitch outcome rates. Intercept plus 8 rates (ball dropped; the 9 sum
to 1). The innings-weighted SD of pitches per inning is 1.34.

With observed rates, held-out R² is:
- 0.61 in 5-fold CV grouped by pitcher
- 0.53 trained on 2023-24, tested on 2025
- 0.51 trained on 2023-25, tested on 2026

RMSE is 0.84-0.95. Change in pitches per inning per +1 point of pitches moved from balls:
- in-play out: -0.66
- swinging strike: -0.31
- called strike: -0.24
- foul: -0.12
- hits: about 0 (a hit ends the at-bat but brings up another batter)

A one-SD higher rate of in-play outs is worth -1.18, and of swinging strikes -0.81.

With predicted rates, held-out R² is 0.20-0.28 for Pitching (2023-25) and about 0.04 for Stuff.
The predicted rates vary less than the observed ones and are highly collinear (field out and
single r = 0.92, double and HR r = 0.86), so their hit-type coefficients have unstable signs.

**2026 zone definition changed.** statfast's `sz_top` averages 3.22 ft in 2026, against 3.44 ft
in 2025, and zone height went from 1.83 ft to 1.59 ft. `z_n`, the zone-normalised height the
location models use, moves up: mean 0.447 vs 0.39, and 60.7% of pitches in [0, 1] vs 65.3%.
The Pitching model, trained on 2023-25 zones, therefore predicts 38.7% balls in 2026, against
36.3% observed. In 2023-25 prediction and observation match within 0.3 points. Every 2026
Pitching and Location value inherits this. Stuff (37.1%) is essentially unaffected.

## Model ERA with modelled pitches per inning (`model_era.py`)

For each model (PLV = Pitching, and Stuff), apply the observed-rate pitches-per-inning formula
to the pitcher-season's average predicted outcome probabilities. Then:
- runs saved per 9 = average per-pitch run value x P/IP x 9
- model ERA = C_season - runs saved per 9

C_season makes the IP-weighted league mean model ERA equal that season's league ERA. The
constants for PLV / Stuff are:

| Season | League ERA | PLV C | Stuff C |
|---|---|---|---|
| 2023 | 4.33 | 4.49 | 4.41 |
| 2024 | 4.08 | 4.37 | 4.10 |
| 2025 | 4.16 | 4.24 | 3.93 |
| 2026 | 4.18 | 3.90 | 3.95 |

For pitcher-seasons with 40+ IP, IP-weighted, correlation with each target:

| Target | PLV ERA | Stuff ERA | Actual ERA | Actual FIP |
|---|---|---|---|---|
| Same-season ERA | 0.39 | 0.36 | — | — |
| Same-season FIP | 0.56 | 0.48 | — | — |
| Next-season ERA | 0.29 | 0.35 | 0.22 | 0.32 |
| Next-season FIP | 0.40 | 0.43 | 0.25 | 0.45 |

Modelled P/IP correlates 0.52 with actual P/IP for PLV and 0.16 for Stuff (actual IP-weighted
SD 1.0; modelled 0.8 and 0.37). 2026 PLV P/IP averages 17.37 against 16.59 actual, because of
the 2026 zone-definition shift. The season constant absorbs the level; spreads are unaffected
to first order.

### Pitch type ERA (`model_era.py --by pt`)

The same method per pitcher x season x pitch type. P/IP comes from that pitch type's own average
probabilities, and C_season is set so the pitch-weighted league average matches league ERA.

Pitch-weighted means for pitch types with 300+ pitches:

| Pitch type | PLV ERA | Stuff ERA |
|---|---|---|
| Sinker (SI) | 3.96 | 4.64 |
| Four-seam (FF) | 4.05 | 4.45 |
| Slider (SL) | 3.72 | 3.49 |
| Sweeper (ST) | 4.01 | 3.63 |
| Curveball (CU) | 4.53 | 4.13 |

Year-to-year r (300+ pitches both seasons, 1,339 pairs) is 0.66 for PLV ERA and 0.90 for Stuff
ERA. `output/model_era_pitch_type.csv` has every pitcher-season-pitch type.

The ERAs are season-neutral. The models carry season terms, so run values and probabilities
shift by season. The season feature's part (its SHAP in the plus and p_<outcome> rows) is
removed from the run value and from P/IP before multiplying, so the season constant C alone
carries the season.

Their SHAP breakdown is `era`, the 21st target in `shap_values.py`. It uses no new proxies:
ERA = C - 9 R P, where R (mean run value) is split by the plus rows and P (modelled P/IP, linear
in the probabilities) by the p_<outcome> rows. The product is split exactly:

    RP - R_ref P_ref = sum_c [dR_c (P_ref + P)/2 + dP_c (R_ref + R)/2]

That is the Shapley value of a product of two sums. The rows reproduce
`model_era_pitch_type.csv` to 1e-4. Across all units, the 5-95% residual range is +/-0.05
runs/9 for Stuff and +/-0.2 for PLV.

Each part is then taken relative to the season's average pitch (its pitch-weighted league mean
that season subtracted). That leaves `season_env` at 0 and `calibration` at 0 (within 1e-6) in
every season. Before this, the season feature and the calibration largely cancelled: net
-0.06 to +0.02 for Stuff, -0.21 to +0.16 for PLV. PLV's leftover was vertical location, whose
league-wide contribution moved from -0.12 (2023) to -0.28 (2025) and +0.14 (2026, the zone
definition change). It now goes to the season's league ERA.

### Location+ by outcome (`shap_values.py location`)

Location+ (Pitching minus Stuff at the actual count) per pitcher x season x pitch type, split by
outcome only, with no feature SHAP and no proxy. Both models price outcomes at the pitch's
count, so per pitch:

    location_rv = sum_o -(p_o,pitching - p_o,stuff_asused) x RV(o, count)

exactly. On the plus scale, minus each term's pooled league mean, the nine `rv_<outcome>` sum to
Location+ - 100 (checked to 1e-6). `dp_<outcome>` is location's change in the probability, in
percentage points. `shap_values.py inputs` now also keeps the as-used Stuff probabilities and
`location_rv`. Tables are in `units_location_<season>.parquet` and in the `location_*` columns
of `unit_values`. The card is `--model location --by outcome`.

## Data caveats found while building

* statfast's `balls`/`strikes` are the count **after** the pitch (statsapi `playEvents`).
  The model rebuilds the pre-pitch count from the previous pitch in the plate appearance.
  Used as-is, the count leaks the outcome (a post-pitch 0-0 is always a ball in play) and
  drops every ball-four and strike-three pitch.
* statfast's `release_pos_x/z` are the 9-parameter-fit coordinates at y = 50 ft, not the
  release point. `release_pos_y` is that reference plane: always 50.000–50.010 ft, no
  release information, and uncorrelated with `release_extension` (r = 0.02).
* Pitch-clock automatic balls have no pitch data, so the pre-pitch count after one is off
  by a ball (rare).
