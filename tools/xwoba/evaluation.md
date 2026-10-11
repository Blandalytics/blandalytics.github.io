# 3D xwOBA model: evaluation

Fit on 283,132 batted balls (2023–2025, bat tracking only), scored on 118,189 from 2026 that the fit never saw (every 2026 ball in play with bat speed, launch angle, a landing spot and a Savant xwOBA). Parameters: `Params(spray=3.0, launch_angle=1.5, bat_speed=6.0, prior=25.0, widen=2.0, degree=1, ridge=0.01, twice=True, floor=0.5)`. Written by `tools/xwoba/evaluate.py`.

## Batted balls, 2026

RMSE of the predicted against the actual wOBA value of each ball; R² against the test season's own variance; log loss of the five-outcome probabilities; the calibration error, the mean gap between predicted and actual wOBA over 20 equal-count bins of the prediction (lower is better for all three; with 5,909 balls in a bin, about 0.006 of it is noise); and the mean prediction, against an actual 2026 mean of 0.361. Each model's calibration error here also holds how 2026 differs from the seasons it was fit on (see *Season by season*); the out-of-fold comparison after this one is free of that.

| model | RMSE | R² | log loss | calib. error | mean |
|---|--:|--:|--:|--:|--:|
| League average | 0.5708 | -0.0000 | 0.9251 | 0.0098 | 0.363 |
| Launch angle | 0.5068 | 0.2118 | 0.7010 | 0.0071 | 0.363 |
| Spray + launch angle | 0.4650 | 0.3365 | 0.6042 | 0.0090 | 0.367 |
| Launch angle + bat speed | 0.4962 | 0.2444 | 0.6832 | 0.0099 | 0.369 |
| 3D model, one pass (no twicing) | 0.4566 | 0.3601 | 0.5918 | 0.0173 | 0.373 |
| **3D model** | 0.4557 | 0.3628 | 0.5890 | 0.0130 | 0.373 |
| 3D model, saved grid (2° × 1° × 3 mph) | 0.4557 | 0.3627 | 0.5890 | 0.0128 | 0.373 |
| Gradient boosting, same 3 inputs | 0.4560 | 0.3618 | 0.5884 | 0.0106 | 0.370 |
| Savant xwOBA (exit velo + launch angle) | 0.4227 | 0.4516 | – | 0.0068 | 0.360 |

### The saved grid

How far a ball's xwOBA moves when it is read off a saved grid rather than the full 1° × 1° × 1 mph one, and the most any whole degree of launch angle moves on average. Launch angle is recorded in whole degrees, so a 2° step reads every odd degree off a line between its neighbours.

| grid | mean abs. change | 99th pct | worst launch-angle degree |
|---|--:|--:|--:|
| 2° × 2° × 2 mph | 0.0033 | 0.0221 | 0.0139 |
| 2° × 1° × 3 mph | 0.0018 | 0.0091 | 0.0011 |

## Batted balls, out of fold on 2023–2025

Five folds by game on the fit seasons, each fold predicted by a model fit on the other four. With the seasons pooled there is no drift between fit and test, so the calibration error is the model's own (with 14,156 balls in a bin, about 0.004 of it is noise).

| model | RMSE | log loss | calib. error |
|---|--:|--:|--:|
| **3D model** | 0.45763 | 0.59617 | 0.0068 |
| 3D model, one pass (no twicing) | 0.45840 | 0.59816 | 0.0161 |
| Gradient boosting, same 3 inputs | 0.45798 | 0.59536 | 0.0062 |

## Season by season

Mean predicted against actual wOBA on contact: out of fold for 2023–2025, the held-out fit's for 2026. Each season is fit with the others, so a season that hit better or worse than its inputs suggest (the ball, the weather, how squarely bat met ball) shows as a gap; bat speed is the season's mean on balls in play.

| season | balls | wOBA | 3D xwOBA | Savant xwOBA | bat speed |
|---|--:|--:|--:|--:|--:|
| 2023 | 51,543 | 0.376 | 0.364 | 0.370 | 71.21 |
| 2024 | 113,202 | 0.358 | 0.362 | 0.366 | 71.15 |
| 2025 | 118,387 | 0.362 | 0.370 | 0.366 | 71.49 |
| 2026 | 118,189 | 0.361 | 0.373 | 0.360 | 71.72 |

## Calibration in 2026

### By deciles of the model's xwOBA

| decile | balls | xwOBA | wOBA |
|---|--:|--:|--:|
| 1 | 11819 | 0.008 | 0.011 |
| 2 | 11819 | 0.040 | 0.039 |
| 3 | 11819 | 0.079 | 0.080 |
| 4 | 11819 | 0.142 | 0.128 |
| 5 | 11819 | 0.226 | 0.213 |
| 6 | 11818 | 0.323 | 0.295 |
| 7 | 11819 | 0.443 | 0.413 |
| 8 | 11819 | 0.583 | 0.569 |
| 9 | 11819 | 0.759 | 0.759 |
| 10 | 11819 | 1.123 | 1.102 |

### By bat speed (mph)

| bat speed | balls | xwOBA | wOBA |
|---|--:|--:|--:|
| < 60 | 3309 | 0.273 | 0.245 |
| 60–65 | 8333 | 0.271 | 0.268 |
| 65–70 | 26655 | 0.311 | 0.300 |
| 70–75 | 47229 | 0.375 | 0.363 |
| 75–80 | 27157 | 0.450 | 0.437 |
| 80+ | 5506 | 0.481 | 0.471 |

### Outcome mix

| outcome | predicted | actual |
|---|--:|--:|
| out | 0.6757 | 0.6818 |
| single | 0.2048 | 0.2073 |
| double | 0.0645 | 0.0605 |
| triple | 0.0057 | 0.0055 |
| home_run | 0.0493 | 0.0449 |

## Hitters

Mean per hitter-season of each measure on contact. *r with wOBA* is descriptive; the next column is predictive (the season before, against the test season's wOBA on contact); *year-to-year r* is the measure against itself.

395 hitters with 100+ batted balls in 2026; 292 with 100+ in both 2025 and 2026.

| measure | r with 2026 wOBA | 2025 → 2026 wOBA | year-to-year r | sd |
|---|--:|--:|--:|--:|
| wOBA on contact | 1.000 | 0.497 | 0.497 | 0.055 |
| Savant xwOBA | 0.833 | 0.600 | 0.750 | 0.052 |
| 3D xwOBA | 0.749 | 0.503 | 0.663 | 0.039 |
