# Decision records

Short records of choices that deviate from, resolve, or extend the plan in `docs/plan/`. Newest last.

## D-001: The original "Auto Pilot" PRD is lineage, not scope

- **Context:** `docs/plan/set-a|set-b/0-first_proj_scope_smc_copilot_app.md` (identical copies) describes an autonomous trading system with PAPER/LIVE modes and broker adapters. A01 section 1.1 deliberately inverts it: SMC Copilot assists a human and never trades on its own.
- **Options:** (a) build the PRD as written; (b) reuse its process ideas only.
- **Choice:** (b). Reused: hard filters vs soft scores, reason codes, strategy versioning, decision journal including rejects, no silent learning, replay without look-ahead. Not built: PAPER/LIVE modes, broker adapters, any automated order path.
- **Consequences:** invariant 1 stands. A01 still cites the stale name `0-first_prd_smc_copilot_app.md` ("SNC Pilot"); harmless.

## D-002: Schema ownership and migration numbering

- **Context:** `docs/plan/set-b/sql/` is canonical, but Drizzle cannot express partitions, views, triggers or functions. Files `0010` and `0011` are reserved for the upgrade path, so a new MVP migration cannot take the next free number.
- **Choice:** `packages/db/migrations/` holds a verbatim copy of `0001`-`0009`, with a CI test that its checksums equal the files in `docs/plan/set-b/sql/`. The Drizzle schema is hand-written for typed queries and checked against the live schema in CI. New MVP migrations use a separate series starting at `0100_`; `upgrade/0010` and `0011` stay as the plan has them.
- **Consequences:** `B03` and `A06` are generated from the SQL, so any change to canonical SQL must regenerate them; do not hand-edit tables elsewhere.

## D-003: Browser spike page lives in `tools/spike-web`

- **Context:** spikes S1, S3, S4 need one browser test page that is not in the A01 monorepo layout.
- **Choice:** `tools/spike-web`, a static Vite app, outside `apps/` and `packages/` and excluded from the package boundary rules. Reusable parts move into `packages/capture-kit` in Phase 7.

## D-004: Separate Binance spot and perp hosts

- **Context:** B02 lists one `BINANCE_WS_URL` defaulting to `data-stream.binance.vision`, which is the market-data-only host for spot. USD-M perpetuals are on a different host.
- **Choice:** four variables (`BINANCE_WS_URL`, `BINANCE_REST_URL`, `BINANCE_PERP_WS_URL`, `BINANCE_PERP_REST_URL`) with defaults; current perp endpoint paths are re-verified against Binance docs in Phase 1 **[verify]**.

## D-005: Toolchain versions

- **Context:** the registry is ahead of the plan (NestJS 12, TypeScript 7, Vitest 5 exist). The plan and the product owner specify NestJS 11 and TypeScript 5. `nestjs-zod` 5.5 declares support for Nest 10/11 and `@nestjs/swagger` up to 11.
- **Choice:** NestJS 11.x, `@nestjs/swagger` 11.x, TypeScript 5.9, Zod 4, Vitest 4, Biome 2.5, Turborepo 2, pnpm 10. Node: `engines >=22.18`, CI on 22 and 24, production image on Node 24 LTS (Node 22 is in maintenance).
- **Consequences:** revisit NestJS 12 and TypeScript 7 after the closed beta; not in scope now.

## D-006: How package boundaries are enforced

- **Choice:** three layers: (1) `tools/boundaries` checks every `packages/*/package.json` against an explicit allow-list and scans `smc-engine` source for clocks, randomness, I/O and framework imports; (2) `dependency-cruiser` checks real imports (no app imports, no cross-package relative paths, no Node builtins or Nest in the engine, capture-kit and contracts); (3) `tsconfig` for `smc-engine`, `capture-kit` and `contracts` sets `types: []` so Node globals do not exist at all. Negative tests prove each rule fails when violated.
- **Consequences:** a new package must be added to the allow-list deliberately. `smc-engine` cannot use `node:crypto`; event ids (`sha1`) need a pure hash implementation in Phase 2.

## D-007: Database environments

- **Choice:** hosted Supabase dev project for integration runs (credentials in `.env.local`, no Docker for Supabase); a plain local Postgres with the dev shims (`0000_dev_shims.sql`) for the SQL smoke test; CI runs the smoke test on Postgres 16 and 17 (Supabase may default to 17; the plan only tested 16).

## D-004 update: measured Binance perp WebSocket path (S2, 2026-10-11)

The USD-M perp host now splits WebSocket paths. `wss://fstream.binance.com/stream?streams=...` accepts the connection but
delivers **zero frames**; `wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m` delivers kline frames. The
default `BINANCE_PERP_WS_URL` is therefore `wss://fstream.binance.com/market` (the adapter appends `/stream?streams=`).
Re-verify from the VM region in Phase 1 **[verify]**.

## D-008: No Caddy in front of the API

- **Context:** B02 lists Caddy, cloudflared and Alloy on the VM. Cloudflare terminates TLS and `cloudflared` reaches the API over the container network.
- **Choice:** Compose runs `api` and an optional `cloudflared` (profile `tunnel`). Add Caddy if a second upstream (STT sidecar) needs path routing at M6.

## D-009: Only asymmetric JWT algorithms are accepted

- **Context:** Supabase projects can sign with a shared secret (legacy HS256) or asymmetric keys published at a JWKS URL.
- **Choice:** `ES256`, `RS256`, `EdDSA` only. Anonymous users, non-`authenticated` roles and tokens issued in the future are refused. A JWKS outage is `503 AUTH_UNAVAILABLE`, not `401`.
- **Consequences:** if the real project signs with HS256, the Phase 4 identity check must revisit this before sign-in can work **[verify]**.

## D-010: Problem types and catalogue additions

- **Choice:** problem `type` is a URN (`urn:smc-copilot:error:<code>`) because no docs domain exists yet. Added codes `PAYLOAD_TOO_LARGE` (413), `NOT_READY` (503) and `AUTH_UNAVAILABLE` (503) to the A07 catalogue. Framework 4xx errors other than 401/403/404/409/413/429 are reported as `VALIDATION_FAILED` (422). Startup does not require the database; `/readyz` reports it (the B02 section 9 self-test lives there).

## D-011: Bybit instruments are stored as their own series

- **Context:** A03 says a cross-check feed never writes candles, but B03 seeds `BYBIT:PERP:BTCUSDT` and `ETHUSDT` as instruments ("cross-check series") with a PRIMARY alias.
- **Choice:** Bybit candles go through the same pipeline and are stored (1m plus aggregated higher timeframes). `venues.analysis_enabled = false` keeps them out of `GET /v1/instruments` and away from the engine. They serve as the V7 peer for the Binance perps (BTC, ETH). Peers only count on venues with `crosscheck_enabled`, so the seeded Coinbase/Kraken/OKX peers are ignored until M6.
- **Consequences:** about 2 more series of storage; promoting Bybit to an analysis venue later needs no data migration.

## D-012: Warm-up history comes from the venues' native candles

- **Context:** the engine needs 400 daily, 500 4h, 800 1h and 1000 15m/5m bars (A03 section 7). Aggregating those from 1m would mean about 576,000 rows per instrument, far over Supabase Free (500 MB).
- **Choice:** seed 5m/15m/1h/4h/1d from the venue's own candles (UTC boundaries match ours), flagged BACKFILLED, and keep only 2,880 minutes (2 days) of 1m. Live aggregation continues from the next bucket; the nightly reconcile (03:00 UTC) compares ours with the venue's native 1h/4h/1d and opens a `RECONCILE` incident on difference, never overwriting.

## D-013: Backfills announce once, not per candle

- A backfill publishes one `candle.backfilled {fromMs,toMs}` when it finishes; per-candle `candle.closed` events are for live data only. Consumers recompute from the range (A04 section 12). Without this a 2,880-minute seed would flood the bus.

## D-014: Candle partitions are created on demand for history

- `candles` is partitioned by month and the schema pre-creates only the current month plus three. Backfill and seeding call `ensure_candle_partition` for every month they touch; `maintain_partitions` also runs at boot and every 6 hours. (Found by a test: seeding a year of daily candles failed with "no partition of relation".)

## D-015: Development database without Docker

- `node tools/dev/src/dev-db.mjs` runs a persistent embedded Postgres 17 under `.dev-pg/` (git-ignored) with the auth shims applied. It is not Supabase and exists only for local live runs; Supabase remains the real database (decision D-007).

## D-016: Production host is Railway, not the Oracle free VM

- **Context:** the plan (A01, A08, B02) hosts on Oracle's free VM behind a Cloudflare Tunnel to honour "only Supabase and AI cost money". The owner decided to host on Railway.
- **Choice:** deploy the API image to Railway (`railway.toml`, `infra/Dockerfile`). Supabase stays the database. The Oracle VM, Cloudflare Tunnel, Compose-on-VM, SOPS-on-VM and the VM-loss runbooks are no longer needed; Compose stays only as an optional local/alternative path.
- **Consequences:**
  - Railway is paid and metered (roughly $5-20 a month for one small always-on service; **[verify]** current pricing). This is a deliberate exception to the $0 rule, approved by the owner.
  - Pick a **non-US region** (Binance blocks US IPs) close to the Supabase region. Spike S2 and S7 are re-run on Railway once deployed: the lag, 24 h and 72 h checks happen there.
  - Railway terminates TLS and gives a public URL, so no tunnel. Railway forwards the client address in `X-Forwarded-For`; the admin allow-list currently reads the Cloudflare header only when `TRUST_PROXY_HEADERS=true`. Admin calls are refused in production until Phase 9 adds proper `X-Forwarded-For` handling (fail closed).
  - Secrets are Railway service variables (the names in `.env.example`), not SOPS files.
  - No idle-reclaim risk, so the A08 "keep-alive load" mitigation is dropped.

## D-017: Engine events have per-occurrence ids; state is versioned

- **Context:** event ids key idempotent storage (`engine_events.event_id` is the primary key). Our own database integration test found that repeated order-block touches, strength-growing equal-level pools and re-formed pools reused one id, so the database kept one row where the pure replay produced several.
- **Choice:** an id is `sha1(instrument | tf | type:scale | anchor + discriminator | strategyVersion)`. The discriminator is the zone id (plus the touching candle for repeatable tests), or the pool id plus its strength, or the formation close time. A property test (300 random datasets) asserts that ids are unique within a run, and the integration test asserts the database holds exactly the ids a pure replay produces.
- `EngineState.v` is now `STATE_VERSION` (currently 2). A snapshot with a different version is discarded and the instrument cold-starts, so a deploy that changes engine rules can never resume from an incompatible state.

## D-018: Sessions are fixed UTC windows; non-UTC configs are refused

- The pure engine has no `Date` or `Intl`, so DST-aware zones are impossible inside it. `StrategyConfigSchema` rejects any session or `sessionsTz` other than `UTC` instead of silently treating it as UTC. A DST-aware option needs a time-zone table passed in as data; deferred (backlog).

## D-019: How the engine runner works

- Triggered by `candle.closed`, but it always reads the database: per-timeframe cursor, closed candles only, merged in canonical close order (higher timeframe first on equal close). A missed or reordered notification cannot lose data or change the result; the integration test proves the stored events equal a pure replay.
- Events and the snapshot are written in one transaction; in-memory state advances only after the commit; ids make a retry idempotent. One chain of work per instrument.
- Snapshots are written on whole-hour closes only, after every candle of that close is applied. Retention: the last 12 hourly plus one per UTC day for 7 days (a snapshot is about 250 KB, so unbounded hourly snapshots would be about 2 GB per instrument per year).
- Cold start (no valid snapshot) replays the newest 3,000 candles per timeframe. A rebuild after `candle.backfilled` starts from the last snapshot at or before the repaired range, bumps `revision` on changed events and sets `retracted` on events that no longer exist. It never retracts events older than what it replayed (per-timeframe bound). A failed rebuild stays pending and runs before the next drain.
- Readiness reports the engine unhealthy only while an instrument's latest job is failing; the next success clears it.

## D-020: Known engine limitations, accepted for now (found by the independent review)

- **Holes in a timeframe are not detected inside the engine.** If a candle is permanently missing (venue hole, `UNRESOLVABLE` gap), pivots, gaps and ATR treat its neighbours as adjacent. A repairable hole is fixed by the backfill rebuild. Whether a permanent hole should reset that timeframe's analysis (costly on 1d) is a Phase 9 decision.
- **Candle quality flags do not reach the engine yet**, so "a SPIKE_SUSPECT candle cannot be the sole basis of a sweep" (A04 section 6.2) is not implemented. The runner reads the flags; wiring them in belongs with setups (Phase 3), where the rule matters.
- **Protected level after a CHoCH** is the extreme of the whole leg since the previous protected level, which is what the A04 worked example computes (63960). Some traders use only the last swing before the break; the labeled comparison (G1) decides whether to change it.
- **Config fields present but not yet used by the engine:** `displacement.requireFvg`, `context.openLevels`, `context.openLevelsAsTargets` (used by setups), and a per-timeframe FVG expiry multiplier (expiry uses `ob.maxAgeBars`).
