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

### 2026-10-11, after Run 1 (before Run 2)

**Run 1** used the criteria above exactly (commit 15f0252) and gave **NO_EDGE_DETECTED**: final test 938 trades, mean net R -1.324 (T1 -0.697, T2 -1.614), mean gross R -0.228, fees 1.096 R per trade, 0 of 3 windows positive for every group. The report is kept in `docs/backtest-report-run1.md`.

An independent review of the code then found defects in the **measurement**, not in the pre-registered thresholds. They were fixed and the backtest was re-run (**Run 2**). The strategy rules (the `smc-core v1` config) and every threshold (30 trades, lower bound above 0, 2 of 3 windows, alpha 0.05 / trials) are **unchanged**. What changed, and why:

1. **Bootstrap resamples whole UTC days** instead of single trades. Setups on the same structure (spot and perp, 5m and 15m, BTC and ETH) are not independent, so trade-level resampling made the interval too narrow. The number of resamples now scales with alpha (a tiny alpha was being clipped to the extreme resample).
2. **Split at the exact dates written above** (2026-04-01 and 2026-07-01). Run 1 split at 50/25/25 of the span, which put the boundaries at 12:00 UTC on those days.
3. **Cost model made less flattering, as A04 13.2 requires:** a limit order now fills only when price trades THROUGH its level by half the assumed spread, TP1 is credited only when price trades through it by half the spread, the stop triggers half a spread early and pays the half spread on exit.
4. **Targets already traded through by the current candle are no longer offered as TP1** (Run 1 published plans whose TP1 had already traded, which then ended as no-fills).
5. **A missing entry-timeframe candle delays a setup instead of silently dropping it**, and setups removed at the live-set cap are resolved, not dropped.
6. Input validation (a non-numeric `--trials` could have produced a pass).

**Trials:** Run 2 looks at the same final-test period a second time, so the count is raised from 2 to **4** (adjusted alpha 0.0125) even though these are measurement fixes and not rule changes. The verdict of Run 2 is the one reported; Run 1 stays on record.
