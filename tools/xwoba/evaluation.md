# 3D xwOBA model: evaluation

Fit on 283,132 batted balls (2023–2025, bat tracking only), scored on 118,189 from 2026 that the fit never saw (every 2026 ball in play with bat speed, launch angle, a landing spot and a Savant xwOBA). Parameters: `Params(spray=3.0, launch_angle=1.5, bat_speed=6.0, prior=25.0, widen=2.0, degree=1, ridge=0.01, twice=True, floor=0.5)`. Written by `tools/xwoba/evaluate.py`.

## Batted balls, 2026

RMSE of the predicted against the actual wOBA value of each ball; R² against the test season's own variance; log loss of the five-outcome probabilities; the calibration error, the mean gap between predicted and actual wOBA over 20 equal-count bins of the prediction (lower is better for all three; with 5,909 balls in a bin, about 0.006 of it is noise); and the mean prediction, against an actual 2026 mean of 0.371. Each model's calibration error here also holds how 2026 differs from the seasons it was fit on (see *Season by season*); the out-of-fold comparison after this one is free of that.

| model | RMSE | R² | log loss | calib. error | mean |
|---|--:|--:|--:|--:|--:|
| League average | 0.5724 | -0.0000 | 0.9385 | 0.0096 | 0.373 |
| Launch angle | 0.5111 | 0.2028 | 0.7177 | 0.0075 | 0.373 |
| Spray + launch angle | 0.4701 | 0.3256 | 0.6228 | 0.0090 | 0.377 |
| Launch angle + bat speed | 0.5006 | 0.2350 | 0.6999 | 0.0099 | 0.379 |
| 3D model, one pass (no twicing) | 0.4619 | 0.3489 | 0.6106 | 0.0171 | 0.384 |
| **3D model** | 0.4610 | 0.3514 | 0.6079 | 0.0124 | 0.383 |
| 3D model, saved grid (2° × 1° × 3 mph) | 0.4610 | 0.3513 | 0.6079 | 0.0122 | 0.383 |
| Gradient boosting, same 3 inputs | 0.4612 | 0.3507 | 0.6072 | 0.0109 | 0.381 |
| Savant xwOBA (exit velo + launch angle) | 0.4287 | 0.4390 | – | 0.0118 | 0.360 |

### The saved grid

How far a ball's xwOBA moves when it is read off a saved grid rather than the full 1° × 1° × 1 mph one, and the most any whole degree of launch angle moves on average. Launch angle is recorded in whole degrees, so a 2° step reads every odd degree off a line between its neighbours.

| grid | mean abs. change | 99th pct | worst launch-angle degree |
|---|--:|--:|--:|
| 2° × 2° × 2 mph | 0.0034 | 0.0221 | 0.0138 |
| 2° × 1° × 3 mph | 0.0018 | 0.0090 | 0.0011 |

## Batted balls, out of fold on 2023–2025

Five folds by game on the fit seasons, each fold predicted by a model fit on the other four. With the seasons pooled there is no drift between fit and test, so the calibration error is the model's own (with 14,156 balls in a bin, about 0.004 of it is noise).

| model | RMSE | log loss | calib. error |
|---|--:|--:|--:|
| **3D model** | 0.46299 | 0.61576 | 0.0066 |
| 3D model, one pass (no twicing) | 0.46370 | 0.61757 | 0.0158 |
| Gradient boosting, same 3 inputs | 0.46333 | 0.61490 | 0.0045 |

## Season by season

Mean predicted against actual wOBA on contact: out of fold for 2023–2025, the held-out fit's for 2026. Each season is fit with the others, so a season that hit better or worse than its inputs suggest (the ball, the weather, how squarely bat met ball) shows as a gap; bat speed is the season's mean on balls in play.

| season | balls | wOBA | 3D xwOBA | Savant xwOBA | bat speed |
|---|--:|--:|--:|--:|--:|
| 2023 | 51,543 | 0.387 | 0.374 | 0.370 | 71.21 |
| 2024 | 113,202 | 0.369 | 0.373 | 0.366 | 71.15 |
| 2025 | 118,387 | 0.372 | 0.380 | 0.366 | 71.49 |
| 2026 | 118,189 | 0.371 | 0.383 | 0.360 | 71.72 |

## Calibration in 2026

### By deciles of the model's xwOBA

| decile | balls | xwOBA | wOBA |
|---|--:|--:|--:|
| 1 | 11819 | 0.010 | 0.011 |
| 2 | 11819 | 0.053 | 0.055 |
| 3 | 11819 | 0.100 | 0.099 |
| 4 | 11819 | 0.162 | 0.150 |
| 5 | 11819 | 0.243 | 0.225 |
| 6 | 11818 | 0.335 | 0.312 |
| 7 | 11819 | 0.452 | 0.421 |
| 8 | 11819 | 0.588 | 0.575 |
| 9 | 11819 | 0.762 | 0.762 |
| 10 | 11819 | 1.124 | 1.103 |

### By bat speed (mph)

| bat speed | balls | xwOBA | wOBA |
|---|--:|--:|--:|
| < 60 | 3309 | 0.288 | 0.264 |
| 60–65 | 8333 | 0.285 | 0.280 |
| 65–70 | 26655 | 0.322 | 0.312 |
| 70–75 | 47229 | 0.384 | 0.372 |
| 75–80 | 27157 | 0.459 | 0.446 |
| 80+ | 5506 | 0.491 | 0.481 |

### Outcome mix

| outcome | predicted | actual |
|---|--:|--:|
| out | 0.6644 | 0.6701 |
| single | 0.2162 | 0.2190 |
| double | 0.0645 | 0.0605 |
| triple | 0.0057 | 0.0055 |
| home_run | 0.0493 | 0.0449 |

## Hitters

Mean per hitter-season of each measure on contact. *r with wOBA* is descriptive; the next column is predictive (the season before, against the test season's wOBA on contact); *year-to-year r* is the measure against itself.

395 hitters with 100+ batted balls in 2026; 292 with 100+ in both 2025 and 2026.

| measure | r with 2026 wOBA | 2025 → 2026 wOBA | year-to-year r | sd |
|---|--:|--:|--:|--:|
| wOBA on contact | 1.000 | 0.488 | 0.488 | 0.055 |
| Savant xwOBA | 0.826 | 0.596 | 0.750 | 0.052 |
| 3D xwOBA | 0.743 | 0.494 | 0.659 | 0.038 |
