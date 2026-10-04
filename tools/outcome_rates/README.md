# Outcome-rate models

Linear models for a pitcher's **K%**, **BB%**, **Hit%** and **PA per inning** from the
share of his pitches ending in each of nine outcomes. Fit on 2023–2026 regular-season
MLB data (through 2026-10-01): one row per pitcher-season, weighted least squares.
`fit.py` builds it; `models.json` holds the result.

```bash
python tools/outcome_rates/fit.py --cache /tmp/mlb --json tools/outcome_rates/models.json
python tools/outcome_rates/fit.py --cache /tmp/mlb --decay 1     # batters faced only
```

## Weights

Each pitcher-season is weighted by **batters faced × a recency weight**,
`decay ^ (newest season − season)`. The default decay is 0.8 (`--decay` changes it):

| season | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|
| recency weight | 0.512 | 0.64 | 0.8 | 1 |

Fit statistics below are weighted by batters faced alone, so they read the same
whatever the decay. The standard errors treat the combined weight as an inverse
variance, which the recency part is not, so they are approximate.

## Inputs

| outcome | pitches counted |
|---|---|
| Ball/HBP | ball, ball in dirt, pitchout, hit by pitch |
| Called strike | called strike |
| Swinging strike | swinging strike (incl. blocked), missed bunt, foul tip |
| Foul strike | foul, foul bunt |
| Field out | in play, not a hit (outs, errors, fielder's choices, sacrifices) |
| Single / Double / Triple / Home run | in play, that hit |

The nine shares sum to one, so the models have no intercept: a pitcher's prediction
is `Σ share × coefficient`. (That is the same fit as an intercept plus eight shares
with one left out.)

## Coefficients

3,457 pitcher-seasons, 731,707 batters faced, 2.85M pitches; decay 0.8.

| outcome | league share | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|---:|
| Ball/HBP | .359 | −0.032 (.008) | 0.618 (.007) | 0.123 (.004) | 7.25 (0.09) |
| Called strike | .163 | 0.894 (.015) | −0.125 (.013) | 0.072 (.007) | 2.13 (0.16) |
| Swinging strike | .121 | 1.369 (.013) | −0.168 (.011) | −0.064 (.006) | 0.96 (0.14) |
| Foul strike | .182 | 0.429 (.014) | −0.043 (.012) | 0.214 (.006) | 3.24 (0.14) |
| Field out | .118 | −0.902 (.020) | −0.546 (.017) | −0.372 (.010) | −5.27 (0.21) |
| Single | .037 | −0.751 (.039) | −0.390 (.033) | 3.060 (.019) | 20.88 (0.40) |
| Double | .011 | −0.868 (.082) | −0.553 (.070) | 3.246 (.039) | 23.06 (0.85) |
| Triple | .001 | −1.538 (.297) | −0.553 (.253) | 3.673 (.141) | 26.81 (3.07) |
| Home run | .008 | −0.826 (.091) | −0.501 (.077) | 3.161 (.043) | 24.32 (0.94) |

The coefficients barely move with the decay: against no recency weight (`--decay 1`)
every one is within a standard error, and even a steep 0.5 moves none by more than
about two, so the relationships are stable across these four seasons.

## Fit

The holdout row refits on 2023–2025 (2025 weighted 1, 2024 0.8, 2023 0.64) and
scores 2026.

| | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|
| R² (all) | .868 | .664 | .938 | .643 |
| R² (BF ≥ 100) | .905 | .675 | .966 | .701 |
| R² (BF ≥ 400) | .919 | .643 | .965 | .664 |
| RMSE | .0198 | .0169 | .0094 | 0.203 |
| MAE | .0136 | .0122 | .0052 | 0.103 |
| R² (2026 holdout) | .856 | .653 | .936 | .615 |

## Definitions and caveats

- **Batters faced** are completed plate appearances; an at-bat that ended on the bases
  (caught stealing, pickoff) is not one. A plate appearance belongs to the pitcher on
  its last pitch.
- **BB%** counts walks, intentional ones included, but automatic intentional walks
  throw no pitch, so they are not in the pitch data at all — neither as walks nor as
  batters faced. In practice this is close to unintentional BB%.
- **Hit%** is singles + doubles + triples + homers over batters faced.
- **Outs** (for PA/IP) are the change in the out count from one plate appearance to
  the next in the half-inning, three at the end of a half-inning, and the play's own
  out at a walk-off; outs on the bases go to the pitcher of the at-bat they happened
  in. Spot checks match official totals exactly (Skubal 2024: 753 BF, 228 K, 35 BB,
  142 H, 192.0 IP), and each season comes to ≈43,080 innings.
- These are within-season descriptive fits, not projections. Hit% is nearly an
  identity (a hit share times pitches per PA); BB% and PA/IP depend on how a
  pitcher's balls and baserunners cluster in counts and innings, which pitch shares
  can't see, hence the lower R².

## Stuff K%

`stuff_k.py` applies the K% coefficients to the Stuff model's outcome predictions.
For every pitch, the Stuff model gives count-neutral probabilities for the same nine
outcomes, over the league's location and count mix. Plugging those into the K% model
gives the strikeout rate of a pitcher whose every pitch had that pitch's stuff. The
model is linear, so a pitch type's Stuff K% comes straight from its mean probabilities.

Nothing is scored here: the means are already in the bucket, in the tables the Model
Drilldown reads. `shap-values/units_stuff_<season>.parquet` holds each pitcher-season-
pitch type's nine `p_<outcome>` targets and Stuff+ (`plus`); `unit_features_<season>`
its name and pitch count.

```bash
python tools/outcome_rates/stuff_k.py --csv stuff_k.csv     # 2023-2026, a few seconds
```

One row per pitcher-season-pitch type with at least 500 scored pitches (regular
season; bunts, pitchouts and pitches missing tracking aren't scored), ranked by Stuff
K%. Pitch types the Stuff model doesn't cover (knuckleballs, eephuses, screwballs)
aren't in the tables.

Stuff K% is a pitch-level number on a pitcher scale: a fastball's 30% means a pitcher
throwing only that fastball, located like the league, would strike out 30% of hitters.
It ignores how pitches play off each other and where the pitcher actually locates.
