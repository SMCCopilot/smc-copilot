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
Trials counted: 2; adjusted alpha 0.025; bootstrap seed 1.

## Setup funnel (evaluated period)

- candidates: 35661
- rejected by hard filters: 26699
- armed (got a shadow outcome): 8962
- triggered (touched the POI then a confirming break): 1388
- armed by template: T2 6829, T1 2133
- rejection reasons: WRONG_PD_SIDE 14845, HTF_COUNTER_BIAS 7684, STOP_TOO_TIGHT 4590, NO_POI 4132, VOL_EXTREME 3698, POI_MITIGATED 1729, STOP_TOO_WIDE 1154, SPREAD_WIDE 822, NO_TARGET 368, RR_TOO_LOW 79
- outcomes: NO_FILL 5095, SL_FIRST 3139, TP1_FIRST 624, EXPIRED_OPEN 97
- ambiguous intrabar (stop assumed first): 120 (3.2% of resolved)

### Final test (evaluated against the criteria, looked at once)

| Group | Trades | Win rate | Mean net R | CI of mean (adjusted) | Max drawdown R | Windows positive | Result |
|---|---|---|---|---|---|---|---|
| ALL | 938 | 15.7% | -1.324 | [-1.486, -1.139] | 1241.82 | 0/3 | FAIL |
| T1 | 297 | 19.9% | -0.697 | [-0.922, -0.439] | 206.96 | 0/3 | FAIL |
| T2 | 641 | 13.7% | -1.614 | [-1.827, -1.385] | 1034.87 | 0/3 | FAIL |

- ALL: expectancy lower bound is not above 0 R; positive in 0 of 3 windows (need 2)
- T1: expectancy lower bound is not above 0 R; positive in 0 of 3 windows (need 2)
- T2: expectancy lower bound is not above 0 R; positive in 0 of 3 windows (need 2)

### Cost breakdown (final test)

Gross R is before costs; fees are the round-trip taker fee expressed in R (5 bps per side). Tight stops make a fixed fee a large fraction of R.

| Group | Trades | Mean gross R | Mean fees R | Mean net R |
|---|---|---|---|---|
| ALL | 938 | -0.228 | 1.096 | -1.324 |
| T2 | 641 | -0.228 | 1.387 | -1.614 |
| T1 | 297 | -0.229 | 0.468 | -0.697 |

### Validate (information only)

| Group | Trades | Win rate | Mean net R | CI of mean (adjusted) | Max drawdown R | Windows positive | Result |
|---|---|---|---|---|---|---|---|
| ALL | 908 | 17.2% | -1.281 | [-1.438, -1.128] | 1166.79 | 0/3 | - |
| T1 | 270 | 25.6% | -0.589 | [-0.816, -0.372] | 159.22 | 0/3 | - |
| T2 | 638 | 13.6% | -1.575 | [-1.765, -1.355] | 1007.81 | 0/3 | - |

### Tune (information only)

| Group | Trades | Win rate | Mean net R | CI of mean (adjusted) | Max drawdown R | Windows positive | Result |
|---|---|---|---|---|---|---|---|
| ALL | 1917 | 16.7% | -1.030 | [-1.151, -0.910] | 1996.66 | 0/3 | - |
| T1 | 533 | 26.5% | -0.440 | [-0.611, -0.264] | 242.33 | 0/3 | - |
| T2 | 1384 | 13.0% | -1.258 | [-1.409, -1.089] | 1765.71 | 0/3 | - |

## Cohorts over the whole evaluated period

| Template | Grade | Setups | Resolved | Win rate | 95% CI (Wilson) | Mean net R | Fill rate | Enough history |
|---|---|---|---|---|---|---|---|---|
| T1 | A | 609 | 316 | 23.1% | [18.8%, 28.1%] | -0.581 | 55.2% | yes |
| T1 | B | 1282 | 690 | 24.2% | [21.2%, 27.5%] | -0.541 | 57.4% | yes |
| T1 | C | 236 | 94 | 30.9% | [22.4%, 40.8%] | -0.464 | 44.5% | yes |
| T2 | A | 861 | 346 | 17.1% | [13.5%, 21.4%] | -0.865 | 40.5% | yes |
| T2 | B | 3736 | 1547 | 12.4% | [10.9%, 14.1%] | -1.463 | 41.7% | yes |
| T2 | C | 2231 | 770 | 13.5% | [11.3%, 16.1%] | -1.582 | 34.8% | yes |

## Limits

- One year in one market regime, crypto majors only. The four series are strongly correlated, so the effective sample is smaller than the trade count.
- Higher-timeframe bias is often unknown (few 4h and 1d candles in a year); bias-dependent scoring then falls back to the neutral value.
- The fill model cannot see order books or queue position; real fills in fast markets would be worse.
- In-sample risk: the designer is not blind to crypto history. A pass would justify a live shadow period, not trust.
