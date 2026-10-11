# Engine fidelity (gate G1)

**Status: waiting for the owner's labels.** The tooling is built and tested; no human labels exist yet, so there is no measured agreement. Nothing in this file is a result until the table below is filled in by `pnpm engine:fidelity`.

## What G1 measures

How closely the engine's detections match what a human trader marks by hand on the same candles (A04 section 15.4). It measures **faithfulness to SMC definitions**, not profitability. Targets (agreement, the F1 score of one-to-one matches):

| Family | Target | Tolerance (bars) |
|---|---|---|
| Swings (internal and external pooled) | 90% | 1 |
| Structure (BOS and CHoCH) | 90% | 1 |
| Fair value gaps | 95% | 0 (exact middle candle) |
| Order blocks | 70% | 1 |

G1 may end as **adjust**: if a family misses, we change the rule or its config (a new strategy version), not the target, and re-run. Order blocks are the likeliest to need it because teachers disagree on the definition (A04 section 5.2).

## How to label (about 20 charts, 1 to 2 hours)

1. Build a pack from real candles. Either from a candles file, or from the dev database once live ingest has run:
   ```bash
   pnpm build
   pnpm engine:label-pack --db --instrument BINANCE:SPOT:BTCUSDT --from 2026-08-01 --to 2026-10-01 \
       --tfs 15m,1h,4h --per-tf 7 --bars 200 --out label-pack      # needs DATABASE_URL
   pnpm engine:label-pack --candles candles.json --out label-pack  # or from a file
   ```
2. Open `label-pack/label.html` in a browser. It works offline and never shows engine output, so your labels are independent. Pick a tool (keys 1 to 6), pick direction and scale, click candles. Labels autosave in the browser; **Export labels.json** when done.
   - **Swing high/low**: click the pivot candle. *Internal* = small pivots, *external* = the major swings you would call the structure.
   - **BOS / CHoCH**: click the candle whose **close** breaks the level. BOS = continuation, CHoCH = change of character. Choose up/down and scale.
   - **FVG**: click the **middle** candle of the three-candle gap, bullish or bearish.
   - **Order block**: click the order-block candle (the last opposite-colour candle before the move that broke structure).
   - Skip anything you are unsure about. The first 25 bars of each chart are ignored (the engine has no left context there).
3. Score it:
   ```bash
   pnpm engine:fidelity --pack label-pack/charts.json --labels labels.json --report docs/engine-fidelity.md
   ```
   The report lists every label the engine missed and every detection you did not label, which is what we tune from.

The pack is built from the owner's own venue data for internal use only (`INTERNAL_ONLY`); do not publish a pack.

## Results

_None yet._
