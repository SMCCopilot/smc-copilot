# Spikes (Phase 0, gate G0)

One section per spike with a recorded number and a decision. A spike with no number is not done.
Plan: A10 section 2, B05 week 1.

| Spike | Question | Status |
|---|---|---|
| S1 OCR | symbol + timeframe accuracy, last-price parse, ms per crop | **needs the owner's devices** (browser page not built yet) |
| S2 Venues | reachability, geo-block, close-to-receive lag | measured from the dev machine; **must be repeated from the candidate VM region** |
| S3 Speech | WER and command accuracy per engine/device | **needs the owner's recordings** |
| S4 Capture/WebGPU | capability matrix | **needs the owner's browsers** |
| S5 Venue terms | may we show derived analytics / raw candles? | **owner reads and decides** (sheet below) |
| S7 VM capacity | memory/CPU headroom, DB round trip | needs the Oracle VM |

## S2: venue reachability and lag

Tool: `node tools/spikes/src/s2-venue-probe.mjs --minutes 4 [--dns 1.1.1.1]` (records raw frames under `.recordings/`, which is git-ignored).
For the 24 h fixture recording run it on the VM with `--minutes 1440`.

### Finding 1: DNS on the dev machine

On the owner's home network the router's DNS does not resolve `api.binance.com`, `fapi.binance.com`, `api.bybit.com`
(resolution fails), while `data-api.binance.vision` and `data-stream.binance.vision` resolve. The same names resolve
through 1.1.1.1. This is a local network condition, not a venue geo-block, and it does not apply to the VM.
**Consequence:** for live testing on this machine set the system DNS to 1.1.1.1 / 8.8.8.8 (or use a VPN); the probe has
`--dns` to measure through a public resolver without changing the machine.

### Result (dev machine, via 1.1.1.1)

Run 2026-10-11, 3-4 minutes each, `--dns 1.1.1.1`. **Dev-machine numbers only: they show the endpoints work, not what the VM will see.**

| Venue | REST | WebSocket | Closed candles seen | Raw receive lag p50 / p95 |
|---|---|---|---|---|
| Binance spot (`data-stream.binance.vision`) | 200 | connects, frames flow | 3-4 | -329 / -328 ms (see Finding 3) |
| Binance USD-M perp | 200 | `/stream` connects but sends **0 frames**; `/market/stream` works | 2 | -118 / -79 ms (see Finding 3) |
| Bybit v5 linear perp | 200 | connects, frames flow | 4 | 72 / 82 ms (raw, uncorrected) |

No HTTP 451/403 from any venue on this machine.

### Finding 2: Binance perp WebSocket path changed

The old combined path delivers nothing; kline streams live under `/market`. Recorded in DECISIONS (D-004 update) and the env default.

### Finding 3: the dev machine cannot measure lag

The local clock is behind the venues by several hundred milliseconds (negative raw lag), and REST round trips here take 1-3 s, so the
probe's offset estimate is itself uncertain. The p95 < 3 s feed-lag budget must be measured on the VM with NTP running.
**Action:** keep Windows time sync on; run `chrony` or `systemd-timesyncd` on the VM.

## S5: venue terms sheet (owner reads and decides)

For each venue (Binance, Bybit; OKX/Coinbase/Kraken are seeded but disabled in the MVP) find the current terms that
cover public market data and API use, and record: URL, date retrieved, a two-line summary, and a decision.

Questions to answer from the text (or by email to the venue's API support):

1. May a commercial product use the public WebSocket/REST market data to compute **derived** analytics shown to users?
2. May it show **raw prices or candles** to users (a chart or quote)? Is attribution required?
3. Any limit on the number of end users, or on redistribution "in any form"?
4. Is the `*.binance.vision` market-data-only host covered by the same terms as the standard API host?
5. Is the Binance Vision bulk dataset (data.binance.vision) usable commercially, or for local testing only?

Record each answer as a `venue_terms` row (decision `DISPLAY_OK`, `INTERNAL_ONLY`, `BYO_ONLY` or `PROHIBITED`) through
`POST /v1/admin/venues/{id}/terms` once that endpoint exists (Phase 1). Until a row exists every instrument stays
`INTERNAL_ONLY`: overlays and analysis only, no raw prices to the browser. The product works either way.
