# Backlog

Anything not in `docs/plan/set-b/B01` section 3 goes here with a reason. Nothing here is scheduled.

| Item | Why deferred | Revisit |
|---|---|---|
| Bybit spot cross-check for the 3 Binance spot series and SOL perp | MVP V7 has a peer only for BTC/ETH perps (B01). Series without a peer report `NO_PEER`, never "verified" | After G1 if cross-check coverage matters |
| NestJS 12 / TypeScript 7 / Vitest 5 | Plan and owner specify NestJS 11 and TypeScript 5 (D-005) | After closed beta |
| Domain for the Cloudflare Tunnel | Owner priority is a working system (see memory: main focus) | Before staging deploy |
| Fee semantics: "5 bps taker" per side vs round trip | A04 says per side, B03 says round trip; resolve in Phase 3 | Phase 3 |
| `feed_usage` request counters (A03 section 2.3 audit) | not needed to prove the data path; no terms question depends on it yet | before venue terms are negotiated |
| Resolve by price needs a price within 24 h; cold instruments resolve by key only | acceptable at MVP | Phase 7 (OCR) |
| Request paths are logged in full | no route carries wallet addresses or codes yet | before Phase 4 identity routes |
| Cross-check divergence flag is not propagated to an already-closed higher-timeframe candle | the 1m row carries it; the engine reads the 1m flag for sweep decisions | Phase 2 if G1 shows it matters |
| `RateLimitedError.retryAfterMs` is ignored by the queue retry (30 s backoff) | harmless at current volume | when backfill volume grows |
| A live candle lost to a handler error heals only through next-minute gap detection | at most one minute of delay | Phase 9 hardening |
| ManagedConnection can briefly hold three sockets if the active one drops during a rotation | self-corrects within the rotation window | Phase 9 |
| Venue flag changes need a restart to reach the running feed (the API says so) | rare operator action | M6 |
| Engine: detect holes in a timeframe's candle sequence (permanent gaps) | pivots/FVG/ATR treat neighbours across a hole as adjacent; repairable holes are fixed by rebuild (D-020) | Phase 9 |
| Engine: candle flags (SPIKE_SUSPECT, divergence) into sweep decisions | needs flags through the runner; matters once setups use sweeps (A04 6.2) | Phase 3 |
| DST-aware sessions (IANA zones) | needs a time-zone table as data because the engine has no `Intl` (D-018) | when a strategy version wants New York-clock killzones |
| Engine state is about 250 KB per instrument (spec estimated tens of KB) | bounded; retention keeps about 19 snapshots per instrument. Could shrink windows or compress | Phase 9 if Supabase storage is tight |
| `displacement.requireFvg`, FVG per-timeframe expiry multiplier | config fields without behaviour yet | with the G1 labeled comparison |
| Oldest FVGs/OBs/pools are dropped silently at the caps (40/24/40) | bounded state; no event for the drop | if G1 shows missing old zones matter |
| `buildFacts` describes the latest engine state only (throws if asOf is older) | historical facts need state at a past time (snapshot + replay) | Phase 3 backtest harness |
