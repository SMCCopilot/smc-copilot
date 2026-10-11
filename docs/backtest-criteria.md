# Backtest criteria (pre-registered)

Written and committed **before** the first real-data backtest was run, so the final-test period could not influence them (A04 section 15.3). If this file changes after results exist, the change is recorded below with the reason and the results are labelled accordingly.

## What is being tested

The shipped strategy `smc-core v1`, exactly as seeded in migration 0009 (no tuning, no parameter variants). Templates T1 (sweep, CHoCH, retest) and T2 (BOS, pullback to POI). Entry timeframes 5m and 15m, bias timeframes 4h and 1d.

This tests whether the **rules as written** produced a positive net expectancy in history. It does not test whether the rules match a human trader's reading (that is gate G1) and it is not a forecast.

## Data and split

- Series: Binance **spot** BTCUSDT and ETHUSDT, and Binance **perp** BTCUSDT and ETHUSDT, as four separate series (spot and perp are never mixed).
- Period: 2025-10-01 to 2026-10-01 (UTC), 12 months, venue REST history for 5m, 15m, 1h, 4h, 1d.
- Walk-forward split by time, 50% / 25% / 25%:
  - **tune:** 2025-10-01 to 2026-04-01
  - **validate:** 2026-04-01 to 2026-07-01
  - **final test:** 2026-07-01 to 2026-10-01
- No parameter is tuned. The tune and validate periods are reported for information. The final test is evaluated once.

## Costs and fill model (`shadow-v1`)

Limit entry at the zone midpoint, one tick of adverse slippage on entry and on a stop exit, assumed spread of 1 basis point of price inside the stop, taker fee 5 bps per side (round trip 10 bps) charged in R, pessimistic intrabar rule (stop before target when one candle touches both; no target credit on the fill candle), gap through the stop fills at the gap price. Setups never filled, or still open at expiry, are excluded from expectancy and counted separately.

## Acceptance criteria (final test, per template, trades pooled across the four series)

A template **passes** only if all hold:

1. at least **30** filled and resolved trades in the final-test period;
2. the lower bound of the **bootstrap interval of mean net R per trade** is **above 0** (2,000 resamples, seed 1, two-sided at alpha = 0.05 / 2, the multiple-testing adjustment for two templates);
3. mean net R is positive in at least **2 of 3** equal time windows of the final-test period.

Verdict for the strategy:

- `EDGE_SUPPORTED`: at least one template passes.
- `NO_EDGE_DETECTED`: templates have enough trades and none passes.
- `INSUFFICIENT_DATA`: no template reaches 30 trades.

"No edge detected" is a valid, expected-possible result. It is reported as is and changes positioning, not the MVP's success criteria (B01 H9).

## Trials and multiple testing

Trials counted: **2** (one strategy configuration, evaluated for two templates). Any further variant tried on this data (a different window, parameter, timeframe or template) increases the count and widens the interval; it is recorded in the report. Looking at the final-test period to decide a change makes that period unusable for the new version, so a new version needs a new untouched period.

## Known limits (stated in advance)

- One year in one market regime. Crypto majors only. Four series that are strongly correlated with each other, so the effective sample is smaller than the trade count.
- Higher timeframes (4h, 1d) have few candles in a year, so the bias is often unknown (RANGE).
- The entry fill model cannot see order books or queue position; real fills would be worse in fast markets.
- A backtest is in-sample for everything we looked at while designing the engine (rules were refined against worked examples, not against this period, but the designer is not blind to crypto history).

## Change log

_No changes since registration._
