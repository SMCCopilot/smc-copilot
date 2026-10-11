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
