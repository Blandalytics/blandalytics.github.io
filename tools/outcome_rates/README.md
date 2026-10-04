# Outcome-rate models

Linear models for a pitcher's **K%**, **BB%**, **Hit%** and **PA per inning** from the
share of his pitches ending in each of nine outcomes. Fit on 2023–2026 regular-season
MLB data (through 2026-10-01): one row per pitcher-season, weighted least squares
with batters faced as the weight. `fit.py` builds it; `models.json` holds the result.

```bash
python tools/outcome_rates/fit.py --cache /tmp/mlb --json tools/outcome_rates/models.json
```

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

3,457 pitcher-seasons, 731,707 batters faced, 2.85M pitches. Standard errors in
parentheses.

| outcome | league share | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|---:|
| Ball/HBP | .359 | −0.030 (.008) | 0.618 (.007) | 0.123 (.004) | 7.25 (0.09) |
| Called strike | .163 | 0.898 (.015) | −0.128 (.013) | 0.070 (.007) | 2.10 (0.16) |
| Swinging strike | .121 | 1.366 (.013) | −0.165 (.011) | −0.064 (.006) | 0.97 (0.14) |
| Foul strike | .182 | 0.434 (.013) | −0.044 (.011) | 0.211 (.006) | 3.22 (0.14) |
| Field out | .118 | −0.912 (.020) | −0.540 (.017) | −0.372 (.010) | −5.18 (0.21) |
| Single | .037 | −0.759 (.039) | −0.400 (.033) | 3.075 (.018) | 20.70 (0.40) |
| Double | .011 | −0.893 (.082) | −0.560 (.069) | 3.277 (.039) | 23.02 (0.84) |
| Triple | .001 | −1.423 (.294) | −0.535 (.251) | 3.590 (.139) | 27.44 (3.02) |
| Home run | .008 | −0.876 (.091) | −0.514 (.077) | 3.176 (.043) | 24.20 (0.93) |

## Fit

Weighted by batters faced. The holdout row refits on 2023–2025 and scores 2026.

| | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|
| R² (all) | .869 | .664 | .938 | .643 |
| R² (BF ≥ 100) | .906 | .676 | .967 | .704 |
| R² (BF ≥ 400) | .919 | .648 | .966 | .673 |
| RMSE | .0198 | .0169 | .0094 | 0.203 |
| MAE | .0136 | .0121 | .0051 | 0.102 |
| R² (2026 holdout) | .856 | .654 | .936 | .616 |

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
