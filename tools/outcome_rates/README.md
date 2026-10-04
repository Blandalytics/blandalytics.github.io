# Outcome-rate models

Linear models for a pitcher's **K%**, **BB%**, **Hit%** and **PA per inning** from the
share of his pitches ending in each of nine outcomes. Fit on 2023–2026 regular-season
MLB data (through 2026-10-01): one row per pitcher-season, ordinary least squares
with every pitcher-season counting the same. `fit.py` builds it; `models.json` holds
the result.

```bash
python tools/outcome_rates/fit.py --cache /tmp/mlb --json tools/outcome_rates/models.json
python tools/outcome_rates/fit.py --cache /tmp/mlb --weight bf --decay 0.8   # the earlier weighted fit
```

## Weights

None by default. `--weight bf` weights each pitcher-season by batters faced, and
`--decay` adds a recency weight, `decay ^ (newest season − season)`. Fit statistics use
the base weight alone (equal, or batters faced), so they read the same whatever the
decay.

The earlier fit used batters faced × 0.8 per season back. Dropping both weights makes
every rate fit worse. Scoring both coefficient sets the same way (pitcher-seasons with
100+ batters faced, weighted by batters faced):

| R² | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|
| batters faced × 0.8 recency | .905 | .675 | .966 | .701 |
| unweighted (current) | .807 | .565 | .893 | .130 |

899 of the 3,457 pitcher-seasons have fewer than 50 batters faced. Unweighted, their
noise counts as much as a full season of starts, which pulls the coefficients off;
PA/IP, a ratio that explodes on a handful of outs, suffers most.

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

3,457 pitcher-seasons, 731,707 batters faced, 2.85M pitches; unweighted. Standard
errors in parentheses.

| outcome | league share | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|---:|
| Ball/HBP | .359 | −0.011 (.009) | 0.612 (.008) | 0.123 (.006) | 9.24 (0.18) |
| Called strike | .163 | 0.598 (.018) | −0.098 (.016) | 0.137 (.012) | 1.33 (0.35) |
| Swinging strike | .121 | 1.246 (.019) | −0.157 (.017) | −0.019 (.012) | −1.32 (0.36) |
| Foul strike | .182 | 0.289 (.016) | −0.129 (.014) | 0.275 (.010) | 2.04 (0.30) |
| Field out | .118 | −0.394 (.016) | −0.421 (.014) | −0.337 (.010) | −5.47 (0.30) |
| Single | .037 | −0.472 (.030) | −0.309 (.027) | 2.430 (.020) | 20.55 (0.58) |
| Double | .011 | −0.716 (.069) | −0.506 (.062) | 2.958 (.046) | 24.51 (1.32) |
| Triple | .001 | −1.822 (.329) | −0.350 (.294) | 3.438 (.217) | 56.38 (6.25) |
| Home run | .008 | −0.231 (.074) | −0.528 (.066) | 2.557 (.049) | 23.25 (1.40) |

## Fit

Unweighted, so not comparable with the weighted table above. The holdout row refits
on 2023–2025 and scores 2026.

| | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|
| R² (all) | .745 | .570 | .877 | .496 |
| R² (BF ≥ 100) | .796 | .611 | .892 | .311 |
| R² (BF ≥ 400) | .824 | .399 | .893 | −.282 |
| RMSE | .0432 | .0386 | .0285 | 0.822 |
| MAE | .0290 | .0237 | .0160 | 0.316 |
| R² (2026 holdout) | .719 | .604 | .886 | .434 |

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

## K%, BB% and Hit% from the Stuff and PLV models

`pitch_rates.py` applies the K%, BB% and Hit% coefficients to a pitch model's outcome
predictions. For every pitch, the pitch models give probabilities for the same nine
outcomes:

- **Stuff** (`--model stuff`, the default): count-neutral, over the league's location
  and count mix.
- **PLV** (`--model plv`, the tables' `pitching` model): at the pitch's actual location
  and count.

Plugging those into the models gives the rates of a pitcher whose every pitch had that
pitch's predicted outcomes. The models are linear, so a pitch type's rates come
straight from its mean probabilities.

Nothing is scored here: the means are already in the bucket, in the tables the Model
Drilldown reads. `shap-values/units_<stuff|pitching>_<season>.parquet` holds each
pitcher-season-pitch type's nine `p_<outcome>` targets and its plus score (`plus`:
Stuff+ or PLV+); `unit_features_<season>` its name and pitch count.

```bash
python tools/outcome_rates/pitch_rates.py --seasons 2026               # Stuff, top and bottom 10
python tools/outcome_rates/pitch_rates.py --seasons 2026 --model plv   # PLV
python tools/outcome_rates/pitch_rates.py --csv stuff_rates.csv        # 2023-2026, every row
```

It prints the top and bottom 10 on each rate among pitch types with at least 500
scored pitches (`--top`, `--min-pitches`); "top" is the pitcher's best end, the highest
K% and the lowest BB% and Hit%. Pitches are the regular-season ones the pitch models
score (bunts, pitchouts and pitches missing tracking aren't), and pitch types they
don't cover (knuckleballs, eephuses, screwballs) aren't in the tables. The tables are
rebuilt on their own schedule, so the current season's can lag a few days.

These are pitch-level numbers on a pitcher scale: a fastball's 30% Stuff K% means a
pitcher throwing only that fastball, located like the league, would strike out 30%
of hitters. They ignore how pitches play off each other. Stuff BB% in particular is
only what the pitch's shape does to the league's ball and take rates, not command.

Caveats for PLV:

- **Its ball rate runs high.** Over 2026 the PLV probabilities average 38.7% balls
  against 36.1% actual (Stuff: 37.1%), with fouls and field outs correspondingly low,
  so PLV BB% reads high at league level (11.4% against 8.6% with the unweighted
  coefficients; K% and Hit% are within a point). The models are linear, so this shifts every pitch type by
  the same amount and leaves the rankings alone.
- **Pitch types sit outside the fit's range.** The models were fit on whole
  pitcher-seasons, whose ball share runs 30-42% (1st-99th percentile). A single pitch
  type at its actual counts spreads wider (26-49% in 2026), so the extremes are
  extrapolations, and a strike-throwing sinker can come out below 0% BB%.
- **Count usage is baked in.** PLV prices a pitch at the count it was thrown in, so a
  pitch used to get back into counts or to finish hitters carries that role into its
  rates, on top of its quality.
