# Backtest and outcomes report (gate G2)

Strategy `smc-core v1 (unmodified)`. Criteria were pre-registered in `docs/backtest-criteria.md` (commit 15f0252) before this run. Generated 2026-10-11.

**This is a historical simulation, not a forecast.** It tests whether the rules as written had a positive net expectancy in this data, after costs.

## Verdict: **NO_EDGE_DETECTED**

Both templates had enough trades and neither met the pre-registered criteria. This is reported as is.

## Data

| Series | Candles by timeframe |
|---|---|
| BINANCE:SPOT:BTCUSDT | 5m: 113760, 15m: 37920, 1h: 9480, 4h: 2370, 1d: 395 |
| BINANCE:PERP:BTCUSDT | 5m: 113760, 15m: 37920, 1h: 9480, 4h: 2370, 1d: 395 |
| BINANCE:SPOT:ETHUSDT | 5m: 113760, 15m: 37920, 1h: 9480, 4h: 2370, 1d: 395 |
| BINANCE:PERP:ETHUSDT | 5m: 113760, 15m: 37920, 1h: 9480, 4h: 2370, 1d: 395 |

Evaluated period 2025-10-01 to 2026-10-01 (UTC). Candles from 2025-09-01 warm up the engine; setups created before the evaluated period are not counted.

Split: tune 2025-10-01 to 2026-04-01, validate to 2026-07-01, final test to 2026-10-01.
Trials counted: 4; adjusted alpha 0.0125; bootstrap seed 1.

## Setup funnel (evaluated period)

- candidates: 35661
- rejected by hard filters: 26722
- armed: 8939
- of those, still live when the data ended (no outcome yet, excluded from every statistic): 7
- triggered (touched the POI then a confirming break): 1786
- armed by template: T2 6806, T1 2133
- rejection reasons: WRONG_PD_SIDE 14845, HTF_COUNTER_BIAS 7684, STOP_TOO_TIGHT 4590, NO_POI 4132, VOL_EXTREME 3698, POI_MITIGATED 1729, STOP_TOO_WIDE 1154, SPREAD_WIDE 822, NO_TARGET 287, RR_TOO_LOW 8
- outcomes: SL_FIRST 4208, NO_FILL 3972, TP1_FIRST 626, EXPIRED_OPEN 126
- ambiguous intrabar (stop assumed first): 36 (0.7% of resolved)

### Final test (evaluated against the criteria, looked at once)

| Group | Trades | Win rate | Mean net R | CI of mean (adjusted) | Max drawdown R | Windows positive | Result |
|---|---|---|---|---|---|---|---|
| ALL | 1209 | 11.2% | -1.506 | [-1.806, -1.132] | 1824.59 | 0/3 | FAIL |
| T1 | 325 | 17.5% | -0.836 | [-1.111, -0.525] | 271.56 | 0/3 | FAIL |
| T2 | 884 | 8.9% | -1.752 | [-2.110, -1.298] | 1553.03 | 0/3 | FAIL |

- ALL: expectancy lower bound is not above 0 R; positive in 0 of 3 windows (need 2)
- T1: expectancy lower bound is not above 0 R; positive in 0 of 3 windows (need 2)
- T2: expectancy lower bound is not above 0 R; positive in 0 of 3 windows (need 2)

### Cost breakdown (final test)

Gross R is before costs; fees are the round-trip taker fee expressed in R (5 bps per side). Tight stops make a fixed fee a large fraction of R.

| Group | Trades | Mean gross R | Mean fees R | Mean net R |
|---|---|---|---|---|
| ALL | 1209 | -0.340 | 1.166 | -1.506 |
| T2 | 884 | -0.345 | 1.408 | -1.752 |
| T1 | 325 | -0.327 | 0.508 | -0.836 |

### Validate (information only)

| Group | Trades | Win rate | Mean net R | CI of mean (adjusted) | Max drawdown R | Windows positive | Result |
|---|---|---|---|---|---|---|---|
| ALL | 1195 | 13.2% | -1.422 | [-1.678, -1.170] | 1699.06 | 0/3 | - |
| T1 | 301 | 21.9% | -0.741 | [-1.045, -0.381] | 223.07 | 0/3 | - |
| T2 | 894 | 10.3% | -1.651 | [-1.944, -1.305] | 1477.69 | 0/3 | - |

### Tune (information only)

| Group | Trades | Win rate | Mean net R | CI of mean (adjusted) | Max drawdown R | Windows positive | Result |
|---|---|---|---|---|---|---|---|
| ALL | 2430 | 13.7% | -1.126 | [-1.307, -0.944] | 2757.13 | 0/3 | - |
| T1 | 575 | 24.0% | -0.541 | [-0.768, -0.284] | 321.68 | 0/3 | - |
| T2 | 1855 | 10.5% | -1.308 | [-1.513, -1.080] | 2446.22 | 0/3 | - |

## Cohorts over the whole evaluated period

| Template | Grade | Setups | Resolved | Win rate | 95% CI (Wilson) | Mean net R | Fill rate | Enough history |
|---|---|---|---|---|---|---|---|---|
| T1 | A | 631 | 355 | 21.4% | [17.5%, 26.0%] | -0.660 | 59.4% | yes |
| T1 | B | 1280 | 742 | 21.7% | [18.9%, 24.8%] | -0.657 | 61.5% | yes |
| T1 | C | 216 | 104 | 23.1% | [16.0%, 32.0%] | -0.810 | 53.7% | yes |
| T2 | A | 1009 | 538 | 9.5% | [7.3%, 12.2%] | -1.186 | 54.6% | yes |
| T2 | B | 3927 | 2133 | 9.8% | [8.6%, 11.1%] | -1.518 | 54.8% | yes |
| T2 | C | 1869 | 962 | 11.0% | [9.2%, 13.2%] | -1.638 | 52.3% | yes |

## Limits

- One year in one market regime, crypto majors only. The four series are strongly correlated, so the effective sample is smaller than the trade count.
- Higher-timeframe bias is often unknown (few 4h and 1d candles in a year); bias-dependent scoring then falls back to the neutral value.
- The fill model cannot see order books or queue position; real fills in fast markets would be worse.
- In-sample risk: the designer is not blind to crypto history. A pass would justify a live shadow period, not trust.
## Run history (nothing hidden)

| Run | Measurement | Trials | Final-test trades | Mean net R | Mean gross R | Verdict |
|---|---|---|---|---|---|---|
| 1 | as pre-registered (commit 15f0252) | 2 | 938 | -1.324 | -0.228 | NO_EDGE_DETECTED |
| 2 (this report) | corrected after independent review, see the change log in `docs/backtest-criteria.md` | 4 | 1209 | -1.506 | -0.340 | NO_EDGE_DETECTED |

Run 1 is in `docs/backtest-report-run1.md`. The strategy rules and the acceptance thresholds were identical in both runs; the corrections made the cost model less flattering, removed targets that had already traded, resampled whole days for the confidence interval, and split at the exact registered dates.

## What this means

- The shipped `smc-core v1` rules, taken as written, **lost money in every period and for both templates**, with the loss concentrated in costs: gross R is slightly negative (about -0.3 R per trade) and round-trip fees take about 1.2 R per trade, because the stops are tight (as little as 0.3 ATR on 5m and 15m) against a 10 bps round-trip fee.
- Win rates are low (T1 about 17%, T2 about 9% in the final test) because most plans target 3R or more from a tight stop.
- This is evidence about these rules on this data, not about SMC as a discipline and not about what a human trader reading the same charts would do. Gate G1 (does the engine see what you see) is still the open question that decides whether the rules or the definitions need to change.
- No parameter was tuned on this data. Any change to the rules is a new strategy version and needs a new untouched test period (forward shadow results on the live feed are the natural one).
- Cost is the first thing to look at: a rule that rejects setups whose round-trip fee exceeds a fraction of R, and maker fees on limit entries, are the obvious candidates for a v2. They are listed in the backlog, not applied.
