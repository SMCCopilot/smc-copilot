# How to complete Gate G1 (about 1 to 2 hours, no coding)

**What G1 is for:** it checks whether the engine marks the same things on a chart that you would mark by hand: swings, breaks of structure, fair value gaps (FVG) and order blocks (OB). Everything built on top (setups, plans, explanations) uses those marks, so if they do not match how you read charts, the rules need adjusting. Only you can say what a correct mark looks like.

**It does not block anything.** The product keeps being built while this waits. Do it whenever you have the time.

## What is already prepared for you

A labeling pack of **21 real charts** (BTCUSDT spot, 15m / 1h / 4h, 200 candles each, taken from public Binance history already downloaded on this machine) is in the folder `label-pack/` at the project root. The page shows candles only, **never what the engine found**, so your marks are independent.

If the folder is missing, rebuild it (needs `pnpm build` once):

```bash
pnpm engine:label-pack --candles data/history/BINANCE_SPOT_BTCUSDT.ndjson --tfs 15m,1h,4h --per-tf 7 --bars 200 --out label-pack
```

(`data/history/` and `label-pack/` hold raw exchange data. They stay on your machine, are never committed, and are for internal use only.)

## Step 1: label the charts

1. Open `label-pack/label.html` in your browser (double-click it). It works offline.
2. Pick a tool on the right (or press keys **1 to 6**), choose direction and scale if they are enabled, then **click the candle** on the chart. Click the same spot again to remove a mark. Arrow keys switch charts. Your work **autosaves in the browser**.

| Tool | Key | What to click | Extra choice |
|---|---|---|---|
| Swing high | 1 | the candle that is the pivot high (its high is the peak) | scale: internal = small pivots, external = the major swings you would call the structure |
| Swing low | 2 | the pivot low candle | same |
| BOS | 3 | the candle whose **close** breaks the level, continuing the trend | UP or DOWN, plus scale |
| CHoCH | 4 | the candle whose **close** breaks the level against the trend (change of character) | UP or DOWN, plus scale |
| FVG | 5 | the **middle** candle of the three-candle gap | BULL or BEAR |
| Order block | 6 | the order-block candle: the last opposite-colour candle before the move that broke structure | BULL or BEAR |

Rules of thumb:
- **Label what you would mark on your own chart. Skip anything you are unsure about.** A missing mark is better than a guess.
- The **first 25 and last 10 candles** of each chart are ignored when scoring, so do not worry about them.
- You do not need to label every chart perfectly. About **15 to 20 charts** is enough. Use all 21 if you have the time.
- Internal vs external: if you only think in one scale, use **external** for everything and ignore internal. The score for internal swings will then just be skipped as unlabeled.

## Step 2: export your labels

Press **Export labels.json** (right panel). Your browser saves a file named `labels.json`, normally in Downloads. Move it into the project folder (next to `label-pack/`).

## Step 3: score it

```bash
pnpm engine:fidelity --pack label-pack/charts.json --labels labels.json --report docs/engine-fidelity.md
```

This prints a report and writes `docs/engine-fidelity.md`. The gate table shows, per family, how often the engine and you agree (the score is the F1 of matches):

| Family | Target |
|---|---|
| Swings | 90% |
| Structure (BOS and CHoCH) | 90% |
| Fair value gaps | 95% |
| Order blocks | 70% |

The report also lists **every mark you made that the engine missed** and **every engine mark you did not make**, with the chart and candle number. That list is what we tune from.

## Step 4: tell me the result

Reply with "G1 done" (or paste the gate table). Then:
- **All families pass:** G1 is recorded as PASS.
- **Some fail (likely order blocks first):** that is a normal outcome called "adjust". I change the definition or settings for those families (a new strategy version) using your list of disagreements, re-score, and we repeat if needed. Nothing is wasted.

## Optional: a second pass

If you want to double-check yourself, label 8 charts again a day later and rerun step 3 with the second file. The plan asks for at least 90% agreement with your first pass, which tells us your own marks are consistent enough to use as the reference.

## Troubleshooting

- *The page is blank or the chart does not draw:* use a current Chrome, Edge or Firefox, and open the file from disk (not from a preview pane).
- *"labels were made for pack ..."*: you exported labels from a different pack than `charts.json`. Rebuild the pack **before** labeling, and do not rebuild it afterwards (rebuilding with the same command gives the same pack id).
- *I labeled in the wrong browser:* labels autosave per browser. Use **Export** in the same browser you labeled in.

## Optional: hand the labeling to an AI agent

You can have a browser-capable AI agent (for example Claude Desktop with browser control, or Claude in Chrome) do Step 1 and Step 2 for you. Read this caveat first.

**What this does and does not prove.** G1 measures whether the engine agrees with a trader's reading of the chart. If an AI labels the charts, the score measures agreement with **that AI's reading of the SMC definitions**, which is useful as a sanity check (it catches outright bugs and definition mismatches) but is **not your judgment**. The engine was written from the same definitions, so an AI will tend to agree with it more than you might. Recommended: let the agent label, then **spot-check 5 to 6 charts yourself** in the same page (the labels import back into it) and fix what you disagree with before you score. Record in `docs/engine-fidelity.md` whose labels were used.

### The prompt to paste into the agent

```text
You are helping complete "gate G1" for a trading-analysis project: hand-labeling candlestick charts so a rule-based
detector can be scored against the labels. Work carefully and independently. You are NOT shown what the detector found.

SETUP
1. Open the local file label-pack/label.html in the browser (path:
   C:\Users\ASUS\Documents\Codes\Quinance\smc-copilot\label-pack\label.html). It is a self-contained offline page with
   21 charts (BTCUSDT, 15m, 1h and 4h candles, 200 bars each). Use the Prev/Next buttons or the arrow keys to move
   between charts. Do not edit any file and do not open any other site.
2. Tools are on the right (keys 1 to 6): Swing high, Swing low, BOS, CHoCH, FVG, Order block. Direction buttons (UP/DOWN or
   BULL/BEAR) and scale buttons (internal/external) enable depending on the tool. Click a candle on the chart to place a
   label; clicking the same label again removes it. The status line under the chart shows the bar index and OHLC of the
   candle under the cursor. Labels autosave.

DEFINITIONS (Smart Money Concepts, use exactly these)
- Swing high / low (pivot): a candle whose high (low) is strictly above (below) the highs (lows) of the 3 candles
  before it and not exceeded by the 3 candles after it for "internal"; use 10 candles each side for "external". Click the
  pivot candle itself. External swings are the major turning points; internal are small pivots inside them.
- Trend: higher highs and higher lows = bullish; lower highs and lower lows = bearish.
- BOS (break of structure, continuation): in a bullish trend, a candle that CLOSES above the latest swing high (bearish
  trend: closes below the latest swing low). Click the candle that closes beyond the level. UP for a break above, DOWN below.
- CHoCH (change of character, reversal): in a bullish trend, the first candle that CLOSES below the protected swing low
  (the low that produced the latest higher high); in a bearish trend, the first close above the protected swing high.
  A wick through the level without a close beyond it is NOT a break (it is a liquidity sweep). Click the breaking candle.
- FVG (fair value gap): three consecutive candles where the low of the 3rd is above the high of the 1st (bullish) or the
  high of the 3rd is below the low of the 1st (bearish), leaving a gap, and the gap is at least about 10% of a typical
  candle range. Click the MIDDLE (2nd) candle. BULL or BEAR.
- Order block: the LAST opposite-colour candle before an impulsive move (large-bodied candle or a gap) that then broke
  structure. Bullish OB = the last bearish (down) candle before an up-move that broke structure; bearish OB = the last
  bullish candle before a down-move that broke structure. Click that candle. BULL or BEAR.

RULES
- Label only what you are confident about; skip ambiguous cases. A missing label is better than a guess.
- Ignore the first 25 and last 10 candles of each chart (they are not scored).
- On each chart, first decide the trend and the major swings, then add structure breaks, then FVGs, then order blocks.
- Use scale "external" for major swings and breaks, "internal" for the small ones. If unsure which, use external.
- Do not label anything that you cannot point to on the chart by candle index.
- Work through ALL 21 charts. Aim for roughly 6 to 20 labels per chart.

FINISH
1. Press "Export labels.json". Save the downloaded file as labels.json in
   C:\Users\ASUS\Documents\Codes\Quinance\smc-copilot\ (the project root, next to the label-pack folder).
2. Reply with: how many charts you completed, the total number of labels per tool, and any chart where you were unsure.
3. Do not run the scoring command and do not modify any project file.
```

### After the agent finishes

1. Open `label-pack/label.html` yourself and look through at least 5 charts. The agent's labels are in that browser profile if the same browser was used; otherwise use **Import** and pick `labels.json`. Fix or remove marks you disagree with, then **Export** again.
2. Run Step 3 (the scoring command) and send me the result.
