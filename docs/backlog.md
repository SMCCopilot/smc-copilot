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
