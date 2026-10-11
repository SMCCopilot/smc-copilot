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
