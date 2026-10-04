# Proposal: DML swing-path model for swing outcomes (whiff / foul / in play)

**Status:** implemented and fitted on 2024–26 (see the two *Results* sections). The pieces are:

* `swing_path/features.py`: location mirroring, the convention check, the attack-angle match and
  the fooled-swing filter;
* `swing_path/batted_ball.py`: the KNN expected wOBAcon target for the damage stage;
* `swing_path/dml_swing_path.py`: the model;
* `swing_path/neutral.py`: the location-neutral probabilities;
* `swing_path/swing_value.py`: contact and damage combined in runs, count-neutral, calibrated;
* `swing_path/evaluate.py`: the evaluation.

The numbers under *Prototype* come from a 10-day 2026 sample, without PLV. The numbers under
*Attack-angle match* and *Fooled-swing filter* come from June 2026 (52,918 tracked swings), using
`features.py`'s own output, with a location stand-in for PLV.

This is the hitter-side mirror of the swing-outcome model in `model_README.md`. That model asks
*how much does the pitch's stuff move whiff / foul / in play, at a fixed location and count?* This
one asks *how much does the hitter's swing path move them, at a fixed location, count and pitch
difficulty?* Pitch difficulty is the PLV model's own prediction for that swing.

The goal is a per-swing and per-hitter **swing-path score**. It credits a hitter for the
outcomes his bat path earns, after removing what the pitch, its location and the count already
implied.

## Target and sample

| | |
|---|---|
| Rows | Swings with bat tracking: 2023 (from mid-season, when tracking starts) through 2025 to train; 2026 out of time. Bunts and pitchouts are dropped, as in `model_README.md`. |
| Classes | The `swing_outcome` map from `model_README.md`. **whiff** is S, W, M, O, T (foul tips count as whiffs). **foul** is F, L. **in_play** is X, D, E. |
| Link | Sequential logit, two stages: whiff vs contact over all swings, then foul vs in play over contact. |

**Untracked swings are dropped.** Untracked swings are about 3–4% of all swings and 24% of
bunts. Tracking is slightly class-dependent: 97.5% of whiffs, 96.9% of fouls and 95.6% of balls
in play are tracked. The model therefore conditions on "tracked". Report a check that
P(tracked) depends on W and not on the class once W is held fixed.

**Outliers are clipped and flagged, not dropped.** Clip to the 0.5–99.5th percentiles and keep a
`path_outlier` flag. In the sample:

* |attack_direction| > 60° is 0.46% of swings, with a maximum of 178°;
* swing_path_tilt > 70° is 0.06%;
* |attack_angle| > 50° is 0.12%.

## Data and joins

* **Bat path.** Savant `statcast_search/csv?all=true&type=details`, pulled per day to stay under
  its 25,000-row cap. Every column below is populated on every tracked swing from 2023 onward.
* **Pitch side.** statfast, joined on `game_pk`, `at_bat_number = at_bat_index + 1` and
  `pitch_number`. This is the same key `arm_angle.py` uses.
* **Count.** Use the pre-pitch count the PLV pipeline already rebuilds. Savant's `balls` and
  `strikes` are pre-pitch too, so they can serve as a cross-check on the join.
* **PLV likelihoods** come from the swing-outcome model's location-aware predictions
  `p_whiff_full`, `p_foul_full` and `p_in_play_full`:
  * 2023–25: the leave-one-pitcher-out training output (`swing_outcome_logit_2325.parquet`);
  * 2026: the scored output (`swing_outcome_2026_scored.parquet`).

## Coordinate conventions: flip the location, not the bat path

The task is to put every hitter on one inside/outside scale. Checked on 17,141 tracked 2026
swings, **only the pitch location needs mirroring.** Savant already reports both horizontal
bat-path fields relative to the batter.

| Variable | Convention | Flip? | Evidence (RHB / LHB) |
|---|---|---|---|
| `plate_x` | Catcher's view, + = 1B side | **Yes:** `x_in = −plate_x` for RHB, `+plate_x` for LHB, so + = inside. This is the README's `x_b`. | — |
| `attack_direction` | **Already batter-relative:** + = opposite field, − = pull | **No.** Flipping it for one hand would break it. | Correlation with spray angle (+ = RF) is +0.27 / −0.27. League mean is −1.0° / −1.0°. |
| `intercept_ball_minus_batter_pos_x_inches` | **Already batter-relative:** lateral distance from the batter, + = away from the body | **No.** | Correlation with `x_in` is −0.93 / −0.90. Means are 36.9 / 36.3 in. |
| `intercept_ball_minus_batter_pos_y_inches` | Depth from the batter, + = toward the pitcher (out front) | No (not horizontal) | — |
| `attack_angle`, `swing_path_tilt` | Vertical angles | No | — |
| `bat_speed`, `swing_length` | Scalars | No | — |
| Pitch movement in W | Mirrored to the pitcher, as in the README | As in the README | — |

**Make the conventions an assertion, not an assumption.** At load time, compute the per-hand
correlations above (attack_direction vs spray on balls in play, and intercept_x vs `x_in`).
Fail if a sign differs between hands. Savant has changed columns before (`miss_distance` was
inserted mid-frame), so this check should not be skipped. `features.check_conventions` does
this and raises if either sign is not clearly positive for both hands.

## Method

There is one model per pitch group (Fastball / Breaking / Offspeed, with the README's cutter
roles), so three models:

* **Hands are pooled.** After `x_in`, every input is batter-relative. Platoon (same/opposite
  hand) goes into W.
* **Split by pitch group** because the mapping from bat path to outcome depends on the pitch's
  plane. For example, the attack angle that squares up a riding fastball is not the one that
  squares up a curveball.
* **Ablation:** a six-model hand-split version, as in the README.

For each stage s:

```
logit P(stage s | S, W, PLV) = logit q_s^PLV + g_s(W) + theta_{s,c} · D_s(S)

q_1^PLV = p_whiff_full
q_2^PLV = p_foul_full / (1 − p_whiff_full)
```

* **PLV offset.** The pitch's predicted stage probability enters as a fixed offset, so pitch
  difficulty is controlled for without being re-learned. It already carries location, count and
  stuff.
* **W (nuisance):**
  * `x_in`;
  * `z_n` (0 = bottom of the zone, 1 = top);
  * pre-pitch balls and strikes;
  * platoon;
  * the pitch's vertical approach angle `vaa`;
  * season.

  **g_s(W)** is LightGBM boosted from the PLV offset on W. It corrects PLV on the tracked-swing
  subsample and for any batter-side location effects PLV doesn't model. Expect it to be small.
* **S (treatment):** the seven bat-path fields, in the conventions above, plus `aa_match` (see
  *Attack-angle match*). No batter identity, hand or pitch inputs.
  * `aa_match` is the one input that mixes in a pitch property. That is still valid under DML:
    `vaa` is in W, so step 3 removes the part of D that `vaa` alone explains.
  * What remains is the bat's plane *relative to* the pitch's, which D cannot build from the raw
    attack angle once it is barred from seeing the pitch.
* **Sample:** D_s and theta are fitted on **committed swings only**, with fooled swings removed
  (see *Fooled-swing filter*). Every swing is still scored. Fooled swings get their own term in
  the hitter decomposition (*Outputs*).

Steps, following the README's logit link:

1. **l_s(W)** = PLV offset + g_s(W). Its log-odds are the boosting offset for D.
2. **D_s(S)** is LightGBM boosted from that offset on S only. It is a log-odds swing-path index.
3. **r_s(W)** is the projection of D on W (and the PLV logits), weighted by p(1 − p). This step
   matters more here than for stuff. In the prototype, W explains:
   * 83% of the variance in intercept_x;
   * 38–45% of the variance in tilt, intercept_y, attack direction and swing length;
   * 26% of attack angle and 15% of bat speed.

   A naive model would credit the swing for the pitch's location.
4. **theta** comes from an offset logistic regression `y ~ offset(logit l + r) + theta_c (D − r)`:
   * the README's count pooling (adjacent-count penalty, λ chosen by CV);
   * standard errors clustered by **batter**.

**Cross-fitting** is by **batter**, with a batter's group being all of his seasons. This is the
mirror of the README's pitcher grouping, so no batter is scored by a model that saw his swings.
Use Leave-One-Group-Out for the final run, and 10-fold `GroupKFold` by batter during development.

**Small leak to note.** PLV's location models were cross-fitted by pitcher, not batter. Each
batter's own swings are therefore a share of roughly 1/700 of the l(W) that produced his offset.
That is negligible, but it is not zero.

## Outputs

**Per swing**

| column | meaning |
|---|---|
| `p_<class>_path` | **Main output.** Location-, count- and pitch-neutral. The chained stage probabilities are averaged over 300 league draws of (W, PLV offset) from swings in the same season, count cell and pitch group, then shifted so league means equal the observed shares. This is what the swing's path would earn against the average swung-at pitch. |
| `x<class>_plus` | `100 × p_<class>_path / cell mean` |
| `p_<class>_full` | PLV offset + g + theta(D − r), at the actual pitch. Used for evaluation. |
| `p_<class>_plv` | The PLV likelihood alone |
| `path_effect_<class>` | `p_<class>_full − p_<class>_(PLV + g)`: the outcome shift attributed to the bat path on this swing |

**Per hitter** (season, plus `_vSame` / `_vOpp` and pitch-group splits):

* swing-weighted `p_<class>_path` and `x<class>_plus`, on the 100 / 15 scale;
* **observed − PLV expected**, split three ways:
  * **path:** the mean `path_effect` over committed swings;
  * **fooled:** the fooled share × (observed − PLV on fooled swings). This is recognition and
    timing, kept apart from swing quality;
  * **remainder:** luck, plus anything the path doesn't capture.
* fooled%, with the `early` / `late` / `decel` shares (see *Fooled-swing filter*).
* **Optional run-value view:** a count-neutral run value per 100 swings, using
  `runvalue.py`'s weights. Price whiff and foul directly. Price in play at the league in-play
  value until a batted-ball stage is added (see *Extensions*).

## Prototype (10 days of 2026, 17,141 tracked non-bunt swings)

This is a quick multiclass LightGBM, five folds grouped by batter. W is a stand-in for PLV:

* location (`x_in`, `z_n`);
* count;
* platoon;
* pitch group;
* velocity and mirrored movement.

It is not the DML pipeline and not the real PLV offset. Its numbers only size the problem.

| inputs | log loss | AUC whiff | AUC foul | AUC in play |
|---|---|---|---|---|
| class prior | 1.080 | — | — | — |
| W (location, count, pitch) | 0.980 | .758 | .589 | .669 |
| W + bat path | **0.807** | **.874** | **.707** | **.798** |
| bat path only | 0.868 | .835 | .676 | .759 |

**W alone matches the real location model's 2026 numbers** (0.974 log loss, .756 whiff AUC in
the README), so the stand-in is reasonable.

**Bat path cuts log loss by 0.17.** That is about 15 times the 0.011 that stuff adds over
location. Increase in log loss when each feature is dropped:

| feature dropped | log-loss increase |
|---|---|
| bat speed | .023 |
| attack direction | .022 |
| attack angle | .021 |
| tilt | .010 |
| intercept y | .008 |
| intercept x | .003 |
| swing length | ≈ 0 (redundant given bat speed and the others) |

Mean feature values by class show *how* the path separates the classes:

| | whiff | foul | in play |
|---|---|---|---|
| attack_direction | −5.9° (pulled) | +1.0° | +0.2° |
| intercept_y | 33.1 in (out front) | 28.5 in | 30.1 in |
| attack_angle | 13.0° | 7.7° | 8.1° |
| bat_speed | 68.3 mph | 69.5 mph | 71.4 mph |

So whiffs are early and around the ball: pulled, out front and steep.

## Attack-angle match (`features.add_attack_angle_match`)

```
vaa      = vertical approach angle at the front of the plate (negative = descending)
aa_match = attack_angle + vaa
```

* **Meaning.** A pitch arriving at −6° is met exactly on its plane by a +6° attack angle, which
  gives `aa_match` = 0. Positive values are steeper than the pitch (uppercut through it);
  negative values are flatter (chopping across it).
* **No mirroring.** Both angles are vertical, so neither is flipped.
* **VAA calculation.** `vaa` is the same calculation as `pitcher_card/prep.py`'s
  `approach_angles`, on Savant's `vy0`/`vz0`/`ay`/`az`.
  * Per-type means look right: SI −5.7°, FC −6.1°, CH −7.2°, SL −7.5°, CU −9.5°.
  * VAA changes by under 0.1° per foot of depth, so the plate-front value stands in for the
    contact point.

**Hitters partly match the plane already:** attack angle correlates −0.41 with VAA. The two
binnings show the difference (June 2026, all tracked swings):

| attack_angle | ≤ −5° | −5–0 | 0–5 | 5–10 | 10–15 | 15–20 | 20–25 | > 25° |
|---|---|---|---|---|---|---|---|---|
| whiff | .243 | .215 | .194 | .173 | .181 | .246 | .386 | .637 |
| in play / contact | .317 | .426 | .502 | .575 | .585 | .512 | .365 | .229 |

| aa_match | ≤ −10° | −10–−5 | −5–0 | 0–5 | 5–10 | 10–15 | 15–20 | > 20° |
|---|---|---|---|---|---|---|---|---|
| whiff | .228 | .205 | .188 | .187 | .213 | .304 | .439 | .646 |
| in play / contact | .352 | .458 | .518 | .562 | .558 | .467 | .339 | .233 |

**Best results come with the bat slightly steeper than the pitch.** Whiffs are fewest at
`aa_match` −5 to +5, and contact is most often fair at 0 to +10.

**Does it add anything?** This was tested in the DML structure. D was boosted from a cross-fitted
offset of W + `vaa` (five folds grouped by batter), once with the seven bat-path fields and once
with `aa_match` added. The gain is the drop in log loss; the z uses batter-clustered SEs.

| stage | sample | gain | z | share of the path's lift |
|---|---|---|---|---|
| whiff vs contact | all swings | .0005 | 1.9 | 0.5% |
| | committed swings | .0001 | 0.3 | 0.1% |
| foul vs in play | all swings | .0022 | **6.1** | 4.1% |
| | committed swings | .0021 | **5.3** | 4.6% |

* **It decides fair vs foul, not hit vs miss.** That fits being on plane: whether the bat meets
  the ball is mostly timing and direction, but whether the contact stays fair depends on
  matching the ball's plane.
* **A model that sees both angles gains nothing from it.** In a plain multiclass classifier with
  W, `vaa` and the raw angles (an earlier pass over the same month), the trees learn the
  interaction themselves: log loss .7909 without the match feature, .7916 with it. It
  only matters because D is barred from seeing the pitch.
* **Horizontal match** (`attack_direction` against the pitch's horizontal approach angle) is left
  as an extension.

## Fooled-swing filter (`features.add_fooled`)

A fooled swing is one whose timing or bat speed departs sharply from what that pitch, location
and count usually get. Each swing is measured against the league and against the hitter's own
norm. The flag uses the bat path and the pitch only, never the outcome.

1. **Expected swing.** E[intercept_y | W] and E[bat_speed | W] are Huber LightGBM fits on W, the
   same pitch-side inputs as the model plus `vaa`. They are cross-fitted in five folds grouped by
   batter.
   * W explains 44% of intercept_y and 16% of bat speed.
   * Count is in W, so an ordinary two-strike shortened swing is not flagged.
2. **The hitter's norm.** Subtract the hitter's shrunk mean residual for the season (residual sum
   / (swings + 50)). A hitter who always meets the ball deep is then not "late" on every swing.
3. **Robust z.** Divide by 1.4826 × MAD of the residual: 7.4 in for timing and 3.9 mph for bat
   speed.
4. **Flags** (threshold `FOOLED_Z` = 2):

| flag | rule | share of swings |
|---|---|---|
| `early` | `z_timing` ≥ 2: met far out front, ahead of a slower pitch | 3.0% |
| `late` | `z_timing` ≤ −2: met far behind, beaten | 3.6% |
| `decel` | `z_speed` ≤ −2: bat far slower than usual, i.e. checked up, lunged or defended | 6.7% |
| `fooled` | any of the three | 11.2% |

**Outside checks: signals the flag never sees.**

| | early | late | decel | fooled |
|---|---|---|---|---|
| Velo change from the previous pitch, ≤ −8 mph | 5.1% | 3.9% | 8.9% | 15.3% |
| … −3 to +3 mph | 2.9% | 3.3% | 6.9% | 11.2% |
| … ≥ +8 mph | 1.2% | 3.2% | 4.8% | 7.8% |
| Fastball / Breaking / Offspeed | 1.3 / 4.8 / 4.7% | 2.9 / 4.6 / 3.6% | 5.2 / 9.1 / 6.2% | 7.8 / 15.5 / 12.5% |
| Hitter-level r with chase rate (154 hitters, 150+ swings) | **.22** | −.02 | −.14 | .02 |
| Hitter-level r with whiff rate | **.27** | .02 | .04 | .15 |
| Split-half reliability within the month (174 hitters, Spearman-Brown) | .41 | .46 | .34 | .56 |
| Share of whiffs / fouls / balls in play flagged | 8.1 / 1.6 / 0.8% | 6.8 / 3.6 / 1.4% | 11.9 / 6.3 / 3.4% | 22.3 / 9.6 / 5.1% |

* **`early` is the well-validated component.** It quadruples after a big velocity drop, is rare
  on fastballs, and tracks a hitter's chase rate. That is the pitch-recognition signature.
* **`late` and `decel` behave like real, repeatable traits** (split-half .46 and .34 within a
  month), but they have no outside confirmation. They are kept in `fooled` because they mark
  swings whose path is not the hitter's intended one. `decel` especially catches check-ups and
  lunges.
* **The threshold and the components are parameters.** In exploration, tightening `fooled` to
  `early` alone changed the results below very little.

**What filtering does to the model** (the same DML-style test as above; D includes
`aa_match`). Hitter rows split the month by game; a hitter needs 40+ swings in each half.

| stage | sample | lift over W | hitter split-half r of D | D → other half's obs − exp | obs − exp → itself |
|---|---|---|---|---|---|
| whiff vs contact | all swings | .102 | .90 | .48 | .57 |
| | committed swings | .084 | **.92** | .46 | .59 |
| foul vs in play | all swings | .056 | .82 | .15 | .32 |
| | committed swings | .049 | .80 | .14 | .30 |

* **Fooled swings are 11% of swings but carry an outsized share of the whiff-stage lift.** That
  share is the "he was fooled" reading that risk 1 describes. Most of the lift (.084) survives on
  committed swings, so the path score is not mainly a fooled detector.
* **Filtering makes the whiff-stage hitter score a little more reliable** (.90 → .92), and no
  less predictive within a month.
* **The case for it is interpretive.** The path score then describes committed swings, and
  recognition (fooled%) is reported on its own instead of being folded in. Whether it improves
  year-over-year prediction is an open question for the full-season evaluation.

## Results: 2024–26 with PLV offsets

**Inputs**

* **PLV:** `score_pitches.py --probs`, with the published 2023–25 models, on the bucket's
  regular-season pitches: 2.11M pitches scored.
* **PLV for 2024–25 is in-sample.** Those models trained on those seasons, and the
  leave-one-pitcher-out training output isn't in the bucket. 2026 is out of time.
* **Bat path:** Savant, joined on `game_pk` / `at_bat_index + 1` / `pitch_number`. 99.5% of
  tracked swings match. Rows whose Savant class disagrees with PLV's observed outcome (~0.05%)
  are dropped.
* **Sample:** 964,732 swings, 11.2% of them fooled. Three pitch groups × two stages.
  * Nuisances are cross-fitted in five batter-grouped folds.
  * A second pass fits on 2024–25 and scores 2026.

**2026 out of time** (log loss per swing; the 3-class loss splits exactly into the two stages):

| | PLV | PLV + g(W) | + bat path |
|---|---|---|---|
| whiff vs contact (327k swings) | 0.466 (AUC .770) | 0.466 (.770) | **0.368 (.867)** |
| foul vs in play (244k contacts) | 0.666 (.630) | 0.664 (.633) | **0.601 (.733)** |
| 3-class | 0.962 | 0.960 | **0.816** |

* **PLV alone reproduces the README's 2026 number** (0.963, location + stuff).
* **g(W) adds almost nothing**, as expected.
* **The bat path cuts the 3-class log loss by 0.144.** That is 13 times what stuff adds over
  location (0.011).
* **The gain holds on committed swings** (0.960 → 0.823), so it is not driven by fooled swings.

**Theta** is 0.98–1.12 for every group, stage and count. Rare counts, such as 3-0 with an SE of
0.3–0.5, are pooled to their neighbours: CV chose heavy pooling (λ from 1e2 to 1.6e4). The
index D is on the right scale without rescaling. Unlike stuff, the count barely changes how
much the bat path matters.

**Hitters** (hitter-seasons with 200+ swings: 1,329):

| | contact added | in-play added | fooled% |
|---|---|---|---|
| SD across hitter-seasons (log-odds) | 0.53 | 0.21 | — |
| split-half reliability within a season | .985 | .958 | .60 |
| year to year, self (805 pairs, 100+ swings) | .92 | .88 | .69 |
| same-season r with observed vs PLV | .61 | .20 | — |
| r with mean `x_in` / `z_n` / PLV logit | −.01 / **.23** / −.09 | .02 / −.01 / .06 | — |

**Next season's observed contact vs PLV** (log-odds, all swings; weighted r; pairs 2024→25 and
2025→26):

| swings | contact added | observed vs PLV | raw whiff% |
|---|---|---|---|
| 100–250 | .52 | **.71** | −.64 |
| 250–500 | .62 | **.82** | −.77 |
| 500+ | .59 | **.88** | −.81 |

Adding the path score to observed vs PLV raises the next-season R² only from .732 to .736.
For in-play vs foul the path score predicts .12, against .65 for the observed rate.

**Reading it**

* **The bat path explains swings very well and is extremely stable, but it is not the better
  forecaster.** A hitter's own contact rate over PLV is itself very stable (r .88 at 500+
  swings), more so than the pitcher-side rates the stuff model beats. The path score carries
  about half of that stable variance and adds almost nothing beyond it.
  * Unlike Stuff for pitchers, this is not a faster-stabilizing stand-in for results.
  * It is a **description of how** a hitter makes or misses contact.
* **In-play added is a stable trait** (.88 year to year) that barely relates to fair-contact
  results (.20 same season, .12 next season). Foul vs fair at the hitter level is mostly
  something other than the bat path.
* **Leakage:** contact added correlates .23 with the mean height of the pitches a hitter swings
  at. Hitters who swing at higher pitches score as better contact paths. That is either real
  (flat, high-pitch swings) or the location residual the projection doesn't remove.
  * **Next step:** within-pitch-group leakage, and adding the hitter's swing-location mix to W.
* **2026 environment:** league whiffs per swing were 25.5% against PLV's 27.3%. That is the
  README's calibration shift, carried as a constant in g(W)'s season term.

**2026 leaders in this first run** (200+ swings): contact added runs from Steven Kwan (+1.54),
Keibert Ruiz, Luis Arraez and Ke'Bryan Hayes down to Spencer Jones (−1.51) and Nick Kurtz
(−1.50). The second run, below, supersedes this ordering.

## Results, second run: leakage fix, horizontal match, damage stage, hand split, neutral probabilities

The same 964,732 swings; 346,509 balls in play carry the damage target.

* **Leakage fix.** W gains each hitter's season swing-location mix: mean `x_in`, mean `z_n`, and
  the share of swings outside the zone (`features.add_swing_mix`). These are location only,
  never outcome.
* **Horizontal match.**
  * `haa_b` is the ball's reversed path at the plate front, in the batter frame (+ = opposite
    field). It goes into W.
  * `ad_match` = `attack_direction` − `haa_b` goes into S.
  * In a 2025 ablation, `ad_match` adds 1.2% of the path's lift on foul vs in play (z = 5.8) and
    nothing on whiffs (z = 1.0). That is small, because `haa_b` has an SD of 2.3° against about
    15° for attack direction.
* **Damage stage.** E[x_wobacon | ball in play] is a linear partially linear model, offset by
  PLV's batted-ball probabilities as wOBAcon. x_wobacon is `batted_ball.py`'s out-of-fold KNN
  expected wOBAcon (k = 100, batter folds; .363 expected vs .365 actual).
* **Every swing is scored for every stage,** so whiffs also carry the foul and damage effect
  their path would have had on contact.

**2026 out of time** (pooled model):

| | PLV | PLV + g | + bat path |
|---|---|---|---|
| whiff (log loss, AUC) | 0.466, .770 | 0.465, .770 | **0.368, .868** |
| foul vs in play | 0.666, .630 | 0.664, .633 | **0.601, .734** |
| 3-class log loss | 0.962 | 0.960 | **0.815** |
| damage (MSE, R² vs KNN xwOBAcon) | .1590, .023 | .1591, .022 | **.1496, .080** |

* **The bat path more than triples the explained variance in contact quality** over PLV,
  though it stays small in absolute terms (R² .08). Contact quality is mostly what the swing
  does at impact, which the path only partly describes.
* **Theta** is 1.0–1.14 for the logit stages, 0.98–1.02 for Fastball and Breaking damage, and
  0.85–0.92 for Offspeed damage.

**Hand split (six models) vs pooled** (2026 out of time, split − pooled per swing,
batter-clustered SE):

| stage | difference | z |
|---|---|---|
| whiff | +.00014 | +0.5 |
| foul | +.00144 | **+5.7** |
| damage (MSE) | +.00092 | **+6.8** |

* **The split is worse** on foul and damage and ties on whiffs.
* **Its hitter scores barely differ:** they correlate .977–.988 with the pooled ones, with the
  same reliabilities.
* **Pooled stays the default.** All inputs are batter-relative, so splitting halves the data
  without adding information.

**Leakage fix** (hitter-seasons with 200+ swings; first run → second run):

| contact added | first run | second run |
|---|---|---|
| r with mean `z_n` | .23 | **.03** |
| r with mean `x_in` / PLV logit | −.01 / −.09 | .01 / −.07 |
| split-half reliability | .985 | .984 |
| year to year with itself | .92 | .82 |
| predicting next contact vs PLV (100+ swings) | .57 | .51 |
| same-season r with contact vs PLV | .61 | .55 |

* **The fix removes the location correlation** at the cost of about a tenth of the year-to-year
  stability and predictiveness. Part of what it removed was a stable, real trait: hitters who
  swing at higher pitches make more contact for their path.
* **This is the README's DML-vs-baseline trade-off again.** `contact_added` is now the direct
  effect of the path at a given location. `p_whiff_path` (below) keeps the hitter's own path
  value, measured against league locations.

**Hitter scores, second run.** From here on the hitter unit is the **batter × season × batting
side**, so a switch hitter is two units per season. There are 1,387 hitter-season-hands with
200+ swings, 72 of them switch-hitter seasons with 200+ swings from both sides. The model's own
hitter inputs (the swing-location mix in W and the fooled-swing norms) are still per
batter-season.

| | contact added | in-play added | damage added |
|---|---|---|---|
| SD | 0.53 log-odds | 0.21 log-odds | .020 wOBAcon |
| split-half reliability | .984 | .951 | .899 |
| year to year with itself | .82 | .83 | .72 (591 pairs, 100+ BIP) |
| predicting next season's observed vs PLV | .51 | .09 | .55 |
| that observed rate predicting itself | **.85** | **.64** | **.69** |
| same-season r with observed vs PLV | .55 | .18 | .57 |

**Damage added is the most useful of the three.** It explains .57 of same-season xwOBAcon over
PLV and predicts next season's at .55, against .69 for the rate itself. The pattern holds: the
path describes results well, but never out-predicts the results themselves.

**Location-neutral probabilities** (`neutral.py`):

* **Method.** Each swing's path is averaged over 300 league draws from its season × count ×
  group × platoon cell. The stages are chained per draw.
* **Calibration.** Each season gets one shift per stage so league means equal the observed
  whiff and foul shares: whiff +.02 to +.06 log-odds, foul −.07 to −.08. The damage stage gets
  an additive +.005 to +.013 so its ball-in-play mean equals the KNN mean.
* **Probabilities** average .255 / .384 / .360 for whiff / foul / in play, and sum to 1 on
  every swing.
* **Agreement:** hitter `p_whiff_path` correlates −.91 with contact added.
* **It carries the location habit** the orthogonal score removes: −.29 with mean `z_n`.
* **It predicts next contact vs PLV at .55**, between the two versions of contact added.

**2026 leaders** (pooled, 200+ swings; xWhiff+ = 100 × p_whiff_path / cell mean, so lower is
better):

| | contact added (log-odds) | xWhiff+ | | damage added (wOBAcon) | neutral wOBAcon |
|---|---|---|---|---|---|
| 1 | Keibert Ruiz +1.69 | 46 | | Cal Raleigh +.075 | .386 |
| 2 | Steven Kwan +1.45 | 33 | | Spencer Jones +.070 | .419 |
| 3 | J.P. Crawford +1.43 | 44 | | Nelson Velázquez +.063 | .378 |
| 4 | Tyler Heineman +1.40 | 53 | | Kyle Schwarber +.056 | .384 |
| 5 | Ke'Bryan Hayes +1.23 | 43 | | Miguel Vargas +.051 | .382 |
| last | Spencer Jones −1.41 | 212 | | Hyeseong Kim −.058 | .314 |
| 2nd last | Francisco Alvarez −1.30 | 159 | | Tyler Heineman −.055 | .301 |

In-play added runs from Ke'Bryan Hayes (+0.67), Corbin Carroll and Elly De La Cruz down to Drew
Millas (−0.57) and Paul Goldschmidt (−0.56). Spencer Jones is the clearest trade-off: the worst
contact path and the second-best damage path. Tyler Heineman and Keibert Ruiz are the reverse.

## Swing value: contact and damage in runs (`swing_value.py`)

**One run value per swing,** at a location-, count- and pitch-quality-neutral level.

* **Location and pitch quality.** Each swing's path is played against 300 league swings drawn
  from its season × count × pitch group × platoon cell. At each draw, the location, PLV
  prediction and average-path projection come from the draw pitch; the swing contributes only
  θ_c (D − r).
* **Count.** Each swing is evaluated in all 12 counts, with that count's θ and run values
  (pitch-modeling's `run_values_by_count.csv`), and weighted by the league's swing count mix.
* **Pricing balls in play.** At every count, a ball in play's run value is linear in expected
  wOBAcon: RV = a_c + b_c · wOBAcon, with b_c ≈ 0.80–0.87 and R² ≥ .9995 on the KNN classes.
  So the damage stage is priced exactly.
* **Calibration** matches `neutral.py`. Log-odds shifts on whiff and foul and an additive shift on
  damage hit the observed shares and the KNN wOBAcon.

**The split** (hitter side, centred on the season's average swing):

```
value   = p1 RV(whiff) + (1 − p1) p2 RV(foul) + (1 − p1)(1 − p2) (a_c + b_c w)
contact = the same with w set to the average path's damage at that draw
damage  = value − contact = (1 − p1)(1 − p2) b_c θ_c (D_damage − r_damage)
```

`contact` is the whiff / foul / in-play profile with average contact quality. `damage` is what
the path's contact quality adds on the balls it would put in play. Per swing the SDs are .044
runs for value, .031 for contact and .032 for damage.

**Observed counterpart** (per hitter-season, all swings, actual counts):

* run value minus PLV's expectation, with balls in play at their KNN expected wOBAcon;
* split the same way: `obs_contact` uses PLV's expected wOBAcon for the outcome class,
  `obs_damage` is (x_wobacon − PLV's) × b_c on balls in play.

**Hitters** (1,387 hitter-season-hands with 200+ swings; per 100 committed swings):

| | value | contact | damage |
|---|---|---|---|
| SD across hitter-season-hands (runs / 100) | 0.90 | 0.99 | 0.61 |
| split-half reliability | .93 | .976 | .92 |
| year to year with itself (707 pairs) | .88 | .92 | .85 |
| same-season r with its observed part | — | .51 | .68 |
| predicts next season's observed part | — | .47 | **.65** |
| that observed part predicting itself | — | .80 | .67 |

* **Contact and damage trade off** (r −.45 across hitter-season-hands; observed −.37).
* **Damage is the standout.** It predicts next season's contact quality over PLV about as well
  as contact quality itself (.65 vs .67), and better at small samples: .42 vs .36 at 100–250
  swings, .63 vs .56 at 250–500.

**The raw sum is mis-weighted.**

* Observed contact moves only **0.46** runs per model run of contact; observed damage moves
  **1.75** runs per model run of damage. These slopes are fitted on 2024–25, swing-weighted.
* So the bat path overstates contact differences and understates damage differences. The
  damage stage explains only R² .08 of contact quality, so its effects are shrunk; the contact
  stages are sharp.
* The raw value therefore leans toward contact hitters. Its same-season r with observed run
  value over PLV is only .15.

**`cal100`** rescales each part by its slope (fitted on seasons before `--calib-before`):

| r with observed run value over PLV | raw value | calibrated | observed itself |
|---|---|---|---|
| same season (all hitter-season-hands) | .15 | **.36** | 1 |
| 2026, slopes from 2024–25 | .19 | **.35** | 1 |
| next season, 100+ swings (707 pairs) | .10 | **.32** | .59 |
| next season, 100–250 swings (79 pairs) | .33 | .25 | .35 |
| 2025→26 only, 100+ swings | .17 | .34 | .57 |

* **The calibrated value roughly triples the raw one.** At 100–250 swings it trails observed
  results (.25 vs .35); damage alone leads there.
* **Over full seasons, results predict results better.** Adding `cal100` to observed run value
  over PLV raises next-season R² only from .345 to .358.

**2026 leaders** (calibrated plus, raw in brackets; switch hitters marked by side):

* **Top:** James Wood 152 (140), Pete Crow-Armstrong 147 (138), Cole Carrigg (L) 144 (137), Elly
  De La Cruz (R) 143 (151), Roman Anthony 142 (143), Elly De La Cruz (L) 141 (150).
* **Bottom:** Tyler Heineman (L) 60 (90), Isiah Kiner-Falefa 65 (91), Jake Meyers 66 (87), Adam
  Frazier 66 (75), Brayan Rocchio (R) 66 (88), Hyeseong Kim 66 (78).
* **Sides can differ a lot:** Cole Carrigg is 144 as a lefty and 118 as a righty; Brayan Rocchio
  89 and 66.
* **Calibration mostly moves hitters on the contact-vs-damage axis.**
  * Keibert Ruiz (left side) goes from 114 raw to 79 calibrated: elite contact, weak damage.
  * Nick Kurtz goes from 67 to 104, and Spencer Jones from 68 to 110: the reverse.
  * Paul Goldschmidt (57 raw) and George Springer (59) are last on raw value, with the weakest
    contact paths and average damage.

## Risks and how to check them

1. **The bat path is measured during the swing, not before it.** A fooled swing has a different
   path: early, pulled and out front. So part of the per-swing lift is the model reading
   *"he was fooled"*, which is real but is not purely swing skill.
   * **Addressed by the fooled-swing filter:** D is fitted on committed swings, and fooled swings
     get their own term. Without fooled swings, the whiff-stage lift per swing falls from .102 to
     .084, so most of the lift is not this effect.
   * **Judge the model at the hitter level, not by pitch-level log loss**, which will look
     excellent almost regardless.
   * The questions that matter are:
     * Is a hitter's `x<class>_plus` stable (split-half, Cronbach's alpha, swings to 0.5)?
     * Does it predict next season's *observed − PLV* rates better than those rates predict
       themselves?

     These are the README's year-over-year tables, with batters in place of pitchers.
2. **The measurement point differs by class.** Contact rows are measured at impact. Whiff rows
   are measured at the closest approach ("whether or not contact"). Some separation could
   therefore be definitional.
   * **Check:** compare foul tips (contact that is labelled as a whiff) with swinging strikes at
     matched W.
   * If foul tips' paths look like contact rows, the features describe the swing rather than the
     label.
   * Swing length and tilt are defined over the pre-contact window, so they are least exposed.
3. **Location leakage.** Report the R² of the hitter-level score on his mean `x_in` / `z_n` and
   mean PLV, naive vs DML, as in the README's leakage rows. Expect intercept_x to contribute
   little after orthogonalization. What remains of it is plate coverage and box position.
4. **2026 environment.** The README's 2026 zone-definition change moves `z_n`, and PLV inherits
   it. g_s(W) uses the frozen last training season, so refit the league shifts on 2026 (the
   `calibrate` step) before quoting absolute rates. `x<class>_plus` comparisons are unaffected to
   first order.
5. **Small samples early in 2023.** Bat tracking starts mid-2023, so the first training season is
   about half as large. Fine for pooled fits; flag it in per-season reliability.

## Evaluation (mirrors `model_README.md`)

* **Pitch level, 2026 out of time:**
  * log loss and AUC: PLV → PLV + g → + path, per model and class;
  * calibration plots and ECE.
* **Leakage:** the naive vs DML hitter-level R² on location and on PLV.
* **Reliability:** split-half, Cronbach's alpha, the chronological split and M. Report each
  overall and within pitch group.
* **Year over year** (2023→24, 24→25, 25→26). For each class, the 2025 predictors against the
  2026 *observed − PLV* rate, by sample-size bucket:
  * observed;
  * observed − PLV;
  * `p_<class>_path`.
* **SHAP** on each D_s, with dependence plots for attack angle × pitch group and attack
  direction × platoon.

## Extensions (ablations, after the base model)

* **Done in the second run:** horizontal plane matching, the hand split (worse; pooled stays
  the default) and the batted-ball stage (as expected wOBAcon).
* **Fooled-filter thresholds.** Try `FOOLED_Z` 1.5–2.5 and `early` alone, judged on
  year-over-year prediction rather than within-month numbers.
* **Path profile (hitter "stuff").** Replace per-swing S with the hitter's trailing averages of
  S. That is the analogue of pitch physics for pitchers: fixed traits rather than per-swing
  execution. It separates *approach* (persistent tilt, attack angle and bat speed) from
  *execution* (the deviation from his own norm on this swing). It should stabilize faster and
  is free of the risk-1 problem.
* **Done:** the full run value (`swing_value.py`; damage priced through the near-exact wOBAcon
  line rather than five class stages).
* **Damage stage strength.** The damage stage explains R² .08 and needs a 1.74 calibration
  slope. Richer S (bat speed × attack angle interactions, intercept depth × direction) or a
  direct exit-velocity / launch-angle target may sharpen it.

## Running

Built (`pip install -r swing_path/requirements.txt`; about 12 s for a month):

```bash
python swing_path/features.py --start 2026-06-01 --end 2026-06-30 --out swings_2026_06.parquet
python swing_path/features.py --csv 'data/savant/*.csv' --out swings.parquet   # already downloaded
```

This fetches Savant day by day, keeps tracked non-bunt swings, adds every feature and flag, runs
the convention check, and prints the flag-validation tables. Run it on whole seasons, because
the hitter norms need each hitter's swings.

The full pipeline, as run for 2024–26 (Savant days saved as one parquet per day; the scorer
and models from the bucket's `pitch-modeling/`; pitches from `data/mlb/`):

```bash
# PLV probabilities per season (about 2 min each on 4 cores with numba)
python score_pitches.py in_2026.parquet --probs --out plv/scored_2026.parquet
# the damage target (about 30 s)
python swing_path/batted_ball.py --pitches 'in_*.parquet' --out bip.parquet
# the model: cross-fit over all seasons, plus a 2024-25 -> 2026 out-of-time pass (about 30 min)
python swing_path/dml_swing_path.py --savant 's2[456]/*.parquet' --plv 'plv/scored_*.parquet' \
    --bip bip.parquet --test-season 2026 --out pooled.parquet          # --split-hand for six models
# location-neutral probabilities (about 1.5 min), then the evaluation
python swing_path/neutral.py --scored pooled.parquet --out neutral.parquet
python swing_path/evaluate.py --scored pooled.parquet --neutral neutral.parquet --out-board board.csv
# swing value in runs (about 1 min): writes swing_value.parquet and swing_value_hitters.csv
python swing_path/swing_value.py --scored pooled.parquet --bip bip.parquet \
    --run-values pitch-modeling/constants/run_values_by_count.csv --calib-before 2026 \
    --out swing_value.parquet
```
