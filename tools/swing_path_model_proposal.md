# Proposal: DML swing-path model for swing outcomes (whiff / foul / in play)

**Status:** proposal. Nothing here is implemented yet. The numbers under *Prototype* come from a
10-day 2026 sample, not from the full pipeline.

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
inserted mid-frame), so this check should not be skipped.

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
  * season.

  **g_s(W)** is LightGBM boosted from the PLV offset on W. It corrects PLV on the tracked-swing
  subsample and for any batter-side location effects PLV doesn't model. Expect it to be small.
* **S (treatment):** the seven bat-path fields, in the conventions above. No batter identity,
  hand or pitch inputs.

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
* **observed − PLV expected**, split into the bat-path part (mean `path_effect`) and the
  remainder (luck plus anything the path doesn't capture).
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

## Risks and how to check them

1. **The bat path is measured during the swing, not before it.** A fooled swing has a different
   path: early, pulled and out front. So a large part of the per-swing lift is the model reading
   *"he was fooled"*, which is real but is not purely swing skill.
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

* **Plane matching.** Let D see the pitch's plane: `attack_angle − |VAA|` and
  `attack_direction − HAA`, with the approach angles computed at the plate from
  `vy0`/`vz0`/`ay`/`az`.
  * This stays valid under DML, because step 3 still subtracts E[D | W] (put VAA and HAA in W
    too).
  * It measures *path given pitch*, which is closer to "squared up" than the raw angles.
* **Path profile (hitter "stuff").** Replace per-swing S with the hitter's trailing averages of
  S. That is the analogue of pitch physics for pitchers: fixed traits rather than per-swing
  execution. It separates *approach* (persistent tilt, attack angle and bat speed) from
  *execution* (the deviation from his own norm on this swing). It should stabilize faster and
  is free of the risk-1 problem.
* **Batted-ball stage.** Add the README's in-play KNN target (field out / 1B / 2B / 3B / HR) as
  a third stage. That gives the path score a damage component and a full run value.

## Running (planned interface)

```bash
python fetch_bat_tracking.py --start 2023-03-30 --end 2026-09-30 --out data/bat_tracking.parquet
python dml_swing_path.py --data data/statfast_2023_2025.parquet --bat data/bat_tracking.parquet \
    --plv output/swing_outcome_logit_2325.parquet --link logit --tuned output/tuned_swing_path.json \
    --out output/swing_path_logit_2325.parquet --model output/swing_path_logit_2325.pkl
python evaluate.py --model output/swing_path_logit_2325.pkl --data data/statfast_2026.parquet \
    --bat data/bat_tracking.parquet --plv output/swing_outcome_2026_scored.parquet \
    --out-board output/swing_path_leaderboard_2026.csv
```
