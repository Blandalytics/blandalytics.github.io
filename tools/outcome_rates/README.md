# Outcome-rate models

Linear models for a pitcher's **K%**, **BB%**, **Hit%** and **PA per inning** from the
share of his pitches ending in each of nine outcomes. Fit on 2023–2026 regular-season
MLB data (through 2026-10-01), **one fit per season**: one row per pitcher-season,
weighted by batters faced, on deviations from that season's league averages.
`fit.py` builds them; `models.json` holds each season's coefficients and averages.

```bash
python tools/outcome_rates/fit.py --cache /tmp/mlb --json tools/outcome_rates/models.json
python tools/outcome_rates/fit.py --cache /tmp/mlb --weight none   # every pitcher-season the same
```

## The fit

For each season, with the season's batters-faced-weighted averages:

    stat − season avg = Σ coef × (share − season avg share)

A prediction is the season's average plus the deviations times the coefficients. The
shares sum to one, so within a season this is the same fit as the uncentered one with
no intercept (`fit.py` checks that rather than assuming it); the coefficients are
reported in that form, as the stat a pitcher would post if every pitch he threw had
that outcome. Centering matters when the models are applied to something on a
different baseline, such as a pitch model's probabilities (below).

The nine shares:

| outcome | pitches counted |
|---|---|
| Ball/HBP | ball, ball in dirt, pitchout, hit by pitch |
| Called strike | called strike |
| Swinging strike | swinging strike (incl. blocked), missed bunt, foul tip |
| Foul strike | foul, foul bunt |
| Field out | in play, not a hit (outs, errors, fielder's choices, sacrifices) |
| Single / Double / Triple / Home run | in play, that hit |

## Coefficients by season

K% (standard errors in `models.json`, about .02–.03 for the strike outcomes):

| outcome | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|
| Ball/HBP | −0.02 | −0.02 | −0.06 | −0.03 |
| Called strike | 0.90 | 0.95 | 0.89 | 0.87 |
| Swinging strike | 1.35 | 1.36 | 1.38 | 1.38 |
| Foul strike | 0.46 | 0.45 | 0.42 | 0.42 |
| Field out | −0.97 | −0.96 | −0.86 | −0.88 |
| Single | −0.77 | −0.91 | −0.67 | −0.74 |
| Double | −0.94 | −1.11 | −0.78 | −0.78 |
| Triple | −1.35 | −0.48 | −1.37 | −2.41 |
| Home run | −1.07 | −1.20 | −0.73 | −0.63 |
| season K% | 22.8% | 22.6% | 22.3% | 22.2% |

BB%, Hit% and PA/IP are in `models.json` and printed by `fit.py`. Season averages:
BB% 8.4 / 8.0 / 8.2 / 8.7%, Hit% 22.2 / 21.9 / 22.0 / 21.7%, PA/IP 4.28 / 4.24 / 4.26 /
4.28 (2023–2026).

## Fit

R² within each season, weighted by batters faced, and with the previous season's
coefficients centered on this season's averages:

| | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|
| K% | .876 | .881 | .863 | .858 |
| K%, previous season's coefficients | | .880 | .855 | .857 |
| BB% | .694 | .672 | .626 | .667 |
| Hit% | .944 | .957 | .922 | .938 |
| PA/IP | .675 | .579 | .706 | .626 |

Against the earlier pooled versions, scored the same way (pitcher-seasons with 100+
batters faced, weighted by batters faced, all four seasons):

| R² | K% | BB% | Hit% | PA/IP |
|---|---:|---:|---:|---:|
| pooled, batters faced × 0.8 recency | .905 | .675 | .966 | .701 |
| pooled, unweighted | .807 | .565 | .893 | .130 |
| per season, centered (current) | .907 | .680 | .967 | .706 |

Unweighted, the 899 pitcher-seasons with fewer than 50 batters faced count as much as
a full season of starts and pull the coefficients off; weighting by batters faced
fixes that.

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
pitch's predicted outcomes. Each season uses its own models, centered the way they were
fit: the season's actual rate plus the coefficients times the pitch type's
probabilities less the pitch model's own average that season (over every pitch it
scored). The pitch model's average pitch lands on the season's actual rate. The models
are linear, so a pitch type's rates come straight from its mean probabilities.

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
  against 36.1% actual (Stuff: 37.1%), with fouls and field outs correspondingly low.
  Centering on the model's own average cancels this at league level: both models' league
  rates equal the season's actual ones.
- **Pitch types sit outside the fit's range.** The models were fit on whole
  pitcher-seasons, whose ball share runs 30-42% (1st-99th percentile). A single pitch
  type at its actual counts spreads wider (26-49% in 2026), so the extremes are
  extrapolations. Centering moves every PLV pitch type's BB% down, and in 2026 14
  strike-throwing pitch types (mostly sinkers) come out below 0%; their order means
  something, their levels don't.
- **Count usage is baked in.** PLV prices a pitch at the count it was thrown in, so a
  pitch used to get back into counts or to finish hitters carries that role into its
  rates, on top of its quality.
