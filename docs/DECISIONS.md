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

## D-021: How setups, plans and shadow outcomes behave (Phase 3)

- **A setup is created one bar after its structure break.** The fair value gap that confirms the displacement only exists on the next bar, and the A04 section 15.5 worked example creates its T1 candidate exactly then (08:00, after the 07:45 CHoCH). The engine records recent internal breaks and creates candidates for the break that closed on the previous bar.
- **Templates.** T2 (BOS, pullback to POI) is created from an internal BOS on an entry timeframe (5m, 15m) and is rejected with `HTF_COUNTER_BIAS` when the bias timeframes oppose it. T1 (sweep, CHoCH, retest) needs a confirmed opposite-side sweep within `setups.sweepLookbackBars` (default 20 bars) before the CHoCH; without one the break is simply not a T1. POI = the order block created by the break, else the latest same-direction FVG in the leg. Premium/discount is measured on the entry timeframe's internal-scale dealing range (the leg that made the break), which is what the worked example does.
- **Plan.** Stop = invalidation (sweep extreme for T1, far edge of the POI for T2) minus `stopBufferAtrMult` x ATR minus the assumed spread. Targets are levels from the engine's own pools and **unswept swings** (a wick through a swing sweeps it) on timeframes at least as high as the entry timeframe: TP1 = nearest giving at least `minRR`, TP2 = the next higher-timeframe level, else the next level of any kind. RR is derived from the levels. A plan always has an invalidation and an alternate scenario (the schema enforces it).
- **Hard filters** record every failing code, not only the first (journal basis). Rejected setups are events and rows, with no plan and no outcome. New additive config fields with defaults, so the seeded v1 JSON still parses: `risk.assumedSpreadBps` (1 bp of price, because there is no order book), `setups.sweepLookbackBars` (20), `setups.resolveBarsMult` (1).
- **Fee semantics (backlog item resolved).** `takerFeeBps` is **per side** (A04). The stored `fees_r` is the **round trip** expressed in R (B03). Both are true: round-trip fee in price units = `takerFeeBps / 10000 x (fill + exit)`.
- **Shadow outcome rules `shadow-v1`** (pure, incremental, same code live and in replay): a limit entry fills when price trades through the zone midpoint, paying one tick of adverse slippage; the stop exit also pays one tick; a gap through the stop fills at the gap price; one candle touching both stop and TP1 counts as the stop and is flagged ambiguous; **no TP credit on the fill candle itself** (the order of the two is unknown); a target that trades before any fill ends the idea as `NO_FILL` (`TARGET_REACHED_FIRST`); no fill by `expiryBars` is `NO_FILL`; a filled trade unresolved after `expiryBars x resolveBarsMult` is `EXPIRED_OPEN` and has no R. `INVALIDATED_BEFORE_FILL` exists for completeness but is mostly unreachable (a close through the invalidation implies the entry traded first). TP2 is not tracked after TP1 resolves the outcome (`r_tp2` stays null).
- **Probability.** `plan.stats` is filled only from a cohort with n >= 30 (resolved trades only; no-fills and open expiries are excluded), preferring live shadow over backtest and an exact-direction cohort over both-directions. A cohort whose live rate drifts outside its backtest interval by more than 5 points becomes `UNDER_REVIEW`, shows nothing, and stays there until an admin releases it. Outcomes flagged `data_revised` are left out of cohort statistics.
- **Persistence.** Engine events are the source of truth; setup tables are a projection applied only for events that are newly inserted, so a restart or retry never duplicates a transition. A rebuild never rewrites a RESOLVED setup (it flags `data_revised`) and closes setups whose candidate vanished as `INVALIDATED` with reason `DATA_REVISED`.
- **Feed health.** `dataQuality` reaches the engine only for candles at the live edge (within three bars of now), never while replaying history, so a past outage cannot reject past setups. Candle flags (`SPIKE_SUSPECT`, `CROSSCHECK_DIVERGENCE`) now reach the engine and fail `DATA_SUSPECT` when the break, sweep or POI candle carries one (this closes the D-020 flags item at setup level).

## D-022: Statistics, risk and backtest maths live in `@smc/analytics`

- Calibration needs a logarithm, which the pure engine package deliberately bans (transcendental `Math` is architecture dependent). A separate package depending only on `@smc/contracts` holds Wilson intervals, cohort summaries, risk sizing and the liquidation warning, calibration, and backtest evaluation (walk-forward split, seeded bootstrap, drawdown, pre-registered criteria, trials haircut). It is allow-listed in the boundary checker and has no Node types. Sums are taken in sorted order so results do not depend on input order.

## D-023: Supabase connection and wallet identity (Phase 4)

- Hosted Supabase PostgreSQL 17. The direct host is IPv6-only and does not resolve from every network, so both URLs use the pooler: session pooler (port 5432) for migrations (`DATABASE_URL_SESSION`), transaction pooler (port 6543) for the app (`DATABASE_URL`, `prepare: false`). Credentials live only in `.env.local`.
- Token verification uses the project JWKS; the real key is ES256, which resolves D-009 (asymmetric, no shared secret in the API).
- **Wallets are mirrored, not fetched.** The API reads `auth.identities` through its own database role on the first authenticated request and upserts `wallet_identities`. No service-role key is held by the API. The exact `identity_data` shape of a Web3 sign-in is **unverified until a real wallet signs in**; the parser accepts three shapes (`custom_claims`, flat, subject-only) and ignores anything else.
- Unlinking a wallet deletes its `auth.identities` row as well as the mirror, otherwise the next request would re-mirror it. Whether Supabase tolerates that direct delete is unverified; the owner's wallet test covers it.
- Seed migrations insert a dev invite code; the migrate CLI removes it automatically unless `--shims` is used (local throwaway Postgres). The owner mints invites with `POST /v1/admin/invites`.

## D-024: Access classes and the gates

- Classes: `USER*` (valid token and account, before gates: `/v1/me` and gate-completion routes), `USER` (plus invite, disclaimer and 18+), step-up (token issued under 5 minutes ago), `ADMIN` (role claim, IP allow-list, `X-Admin-Confirm: yes`). Every `/v1` route must carry a guard; `routes.e2e.test.ts` scans every controller and fails on an unguarded route (this replaces a generated OpenAPI check for now, see D-027).
- Kill switches and flags are rows in `feature_flags` (`kill.<SCOPE>`), cached 3 s. Rate limits are in memory (single process until M6) and return `Retry-After`.
- Turnstile is fail-closed when enforced. `TURNSTILE_DISABLED=true` is the explicit opt-out for closed beta; production without a secret and without the opt-out refuses to boot.

## D-025: Execution gate (invariant 1)

- REST only. There is no socket event that confirms a gate or logs a trade (exact-set test in contracts, plus a socket test that sends `gate.confirm` and `trade.open` and observes nothing happens).
- Issue: latest plan version of an `ARMED`/`TRIGGERED` setup and a non-stale feed; a new issue voids the previous open gate for that plan. The 256-bit token is returned once; only its SHA-256 is stored. Confirm is one conditional `UPDATE` (right user, token hash, plan hash, `ISSUED`, not expired), so a token wins at most once; afterwards the plan must still be the newest version and the setup still actionable, else the gate is voided (`PLAN_CHANGED`). The database sets `confirmed_via = 'UI_TAP'` and its CHECK constraints reject any other channel; a request marked as voice (`X-Input-Mode`) is refused earlier with `VOICE_FORBIDDEN_ACTION`.
- A confirmed gate must be spent on a trade within 60 s, for the same plan, once: the trade insert locks the gate row and checks that no trade already references it. A trade that follows a plan cannot be created without it; a free-form trade needs no gate.
- Nothing places an order anywhere; the trade log records what the user did elsewhere. `PATCH` changes stop, targets and notes only.

## D-026: Realtime channel

- Socket.IO attached to the HTTP server at `/ws`; authenticated by the 5-minute HMAC `wsToken` bound to one session and one user. One controller per session: a second connection gets `SESSION_CONTROLLER_TAKEN` unless it connects with `auth.takeover = true`, which disconnects the old one.
- Every outbound event is numbered per session and written to `session_events` (7-day retention); a reconnect with `lastSeq` replays what it missed. Large `analysis.update` payloads are logged in compact form, so a resume re-sends a fresh snapshot rather than replaying them. Handlers are registered synchronously and processed one at a time per session (a client may emit the instant it connects).
- `analysis.update` carries the full snapshot, sent only when its `snapshotId` changed (true diffs are in the backlog). A slow socket (over 100 queued packets) skips pushes and is brought current by the next change or `analysis.request`. Events are driven by the in-process bus (`engine.updated`, `feed.status`); with the worker split (M6) the same events arrive through the bus seam.
- Chat, explain and voice events return `AI_TEMPORARILY_UNAVAILABLE` until Phase 5; the reserved audio and frame events return `STT_UNAVAILABLE`.

## D-027: Deferrals made in Phase 4

- **OpenAPI document and generated client** are not produced; the Zod contracts are the source of truth and the route-scan test enforces guards. Generating a document from Zod and a typed client is in the backlog.
- **Notification preferences** are not stored (no column exists in the canonical schema and the MVP channel is in-app only); all in-app types are on.
- **Position events** are evaluated on 1-minute closes. Each event type fires at most once per trade.
- **Win rate in the journal summary** is null until 30 closed trades with a measurable R (invariant 5).

## D-028: Developer client

- `GET /dev` (a single HTML page) exists only with `DEV_CLIENT_ENABLED=true`; `GET /dev/config` returns only the public Supabase URL and anon key. The page sets its own narrow Content-Security-Policy (inline script plus jsdelivr, for the Supabase and Socket.IO browser libraries), leaving the global policy untouched elsewhere. It never shows candles or exchange prices.

## D-029: Phase 4 review outcome and accepted limits

Independent review (fresh context, 23 findings, 2 HIGH). **Fixed:** double spend of one gate under concurrency and non-atomic gate issue (serialised with transaction-scoped advisory locks, statements re-read after the lock); concurrent session creation exceeding the limit; realised R measured against a moved stop (now the opening stop is kept in the journal); `PATCH` on a just-closed trade; missing `trust proxy` in production (rate limits, abuse flags and audit saw the proxy IP); a user stacking several invite codes; ended or blocked users keeping a socket; sequence numbers colliding while a session loads; position events judged on a bar that started before entry (now only bars from the entry on); concurrent first `/v1/me` calls racing on the wallet insert. Regression tests cover the concurrency cases.

**Accepted, documented:**
- **The server cannot tell a human tap from a scripted call.** The gate guarantees: REST only, no socket event, single use, 60 s, plan-hash bound, audited, and the database refuses any non-`UI_TAP` channel. A client that omits the voice marker header and calls the three endpoints in sequence is indistinguishable from a tap. A dwell-time or per-gate nonce rule is a product decision, in the backlog.
- **Levels in analysis and plans are shown for INTERNAL_ONLY instruments.** The product shows analysis (swings, zones, plan levels) but never candles or a price stream; the candles route stays behind the licence guard. Whether swing and open levels count as raw exchange prices is a `[counsel]` item for the owner.
- Idempotency keys orphaned by a crash block retries for up to 24 h; cursor pagination uses millisecond timestamps; `PATCH` of a journal entry cannot clear notes; the `/dev` page's CSP is loose by design and the page is off by default. All in the backlog.

## D-030: Owner-switchable AI providers (Phase 5)

- Three providers are wired (Anthropic, OpenAI, Gemini) behind one `ProviderAdapter` interface using plain HTTPS calls, no vendor SDKs. The owner decides which are active: an `*_ENABLED` env flag is the starting state, and a row in `feature_flags` (`ai.provider.<id>`, with `rules` holding order and data classes) overrides it within seconds, so no deploy is needed. `PUT /v1/admin/ai/providers/:id` writes it (audited); the developer client has a panel for it.
- The router tries only enabled providers that have a key and a model, in the owner's order; a data-class check runs before any request leaves (`PROVIDER_BLOCKED_BY_POLICY` is recorded). With none usable every feature serves deterministic template text. Retry once on 429/5xx/timeout, then the next provider; per provider-and-model circuit breaker (5 failures in 60 s opens it, one probe after 30 s).
- **Data-class defaults:** Anthropic D0, D1, D2; OpenAI and Gemini D0 and D2 only. Images (D1) go to a provider other than Anthropic only after the owner reviews its retention terms and ticks D1. This is the conservative reading of A05 section 12.2 and is an owner decision.
- Model ids are configuration, a "fast" and a "strong" model per provider. OpenAI and Gemini have no default id; a provider with one id uses it for both. **Prices are configuration too** (`AI_PRICES_JSON`); a model without a price is billed at a high fallback (5 / 25 USD per million tokens), so a missing entry makes the limits trip early. The plan's own model prices are marked "verify", so none are baked in.
- Request shapes for the three vendors follow their public documentation as known when written and are covered by unit tests with a fake `fetch`; they have **not been exercised against the live APIs** (that costs money and needs keys). The first live run is the owner's session-hour or eval run.

## D-031: Spend controls and the ledger

- Every provider attempt is a row in `ai_calls` (tokens, cost, latency, outcome, data class, prompt version, facts hash; never a prompt or an answer). Workspace and user come from an async context, never from the model package. Spend is added to the workspace's daily ledger and to the global daily ledger in the same call.
- `AiGate` runs in front of every model use: kill switches (`AI`, plus `CHAT`, `EXPLAIN`, `IMAGE_READ`), the global cap, then the user's daily budget. At 80% of the budget chat moves to the fast model (soft); at 100% chat and Explain refuse with `BUDGET_EXCEEDED` while overlays and templates continue. When the global cap is reached the ledger row is stamped, an audit entry is written, and all model use stops until the next UTC day.
- Per-user chat and Explain rate limits are separate; per-IP and per-device counters are shared across accounts, so a farm of free accounts shares one small allowance. The device id is client-supplied and therefore only a speed bump.

## D-032: Guardrails (A05 section 6)

- Every text job passes the same pipeline: schema, reference check (every `{{L:id}}`, `{{Z:id}}`, `{{V:id}}`, setup id and invalidation id must exist in the facts, and the invalidation must be the engine's), a number scan (no price-like literal outside a placeholder), a banned-language check, then one repair retry that tells the model what was wrong, then the template. Numbers enter text only by server substitution at the instrument's precision. The base-rate sentence is built by the server from the stored statistic; a model-written `history_line` is rejected.
- **Output is validated before any of it is sent**, so the chat protocol never needs to retract. The model is called without provider streaming and the validated answer is then delivered in pieces; true token streaming with retraction is in the backlog. `chat.retract` stays in the contract.
- Deterministic screens run before the model for chat: personal-advice requests, certainty and profit questions, leverage questions, requests to place or confirm trades, other-user data, and distress signals all get fixed replies. The "should I buy?" reply states what the engine shows (scenarios, invalidation) and that the decision is the reader's, and never reaches a model. If a model flags advice itself, its wording is discarded. These screens are what makes the critical red-team subset (88 prompts) pass at 100%.
- A seed-phrase and private-key detector (12 or more consecutive BIP-39 words; hex, WIF, extended and Solana keys; PEM; vendor keys) refuses text before it is stored or sent, in chat, Explain questions, journal notes, trade notes and feedback.

## D-033: Narratives are shared

- A narrative depends on the facts and the prompt version, not the user: one generation per instrument per distinct facts, cached in `narratives`, at most one per instrument per minute, only while a session is watching it, and only when a provider and the budget allow. The template is returned instantly and replaced when the model text is ready (`narrative.done`). Only model-written text is cached. Prose written by a model is labelled `aiGenerated` for the UI.

## D-034: Explain this chart

- Two model calls with different inputs: a reader sees the picture (D1, fast model, escalating once to the strong model when symbol or price confidence is low) and may answer only in enumerations and fractions (strict schema); the writer (D2) never sees pixels and receives only enumerations plus the engine facts. Strings read from pixels are parsed and resolved by the server and then dropped, which is what stops prompt injection through chart text.
- The image is handled in memory only: multer memory storage with tight limits, `sharp` format and size checks (PNG, JPEG, WebP; 6 MB; at most 2,400 px a side; too small is not a chart), then a resize and re-encode that strips metadata; the buffer is zeroed when the request ends. `explain_requests` keeps size, dimensions, the market, outcome and the text answer, and has no column that could hold an image. Tests scan the schema for image-like columns and, after a real request, search every text column, the logs and the temp directory for the image.
- Modes: **GROUNDED** when the market is resolved and the picture agrees with the feed (a live capture only needs to not disagree; an upload must positively match); otherwise **APPROXIMATE**, which uses only the picture, labels every level as read from the image and approximate, and has no plan, statistic or engine invalidation. Prices drawn on the picture are converted only when at least three axis labels fit a straight line to within 0.1% of the range.
- Resolution order: manual pick, then on-device text, then the reader, then the session's own market. A price mismatch yields a warning and a suggested market name, never the price. Because comparing a screen price with the feed reveals a little about the price, comparisons are capped at 60 an hour per user and the price itself is never returned (an accepted limit under the "analysis only" rule).
- `context.hint`: text only; the server re-derives symbol, venue and timeframe, ignores free text, and applies a change only after two consecutive agreeing hints so a flapping read never moves the view. Daily Explain allowance 3 (entitlement `explain_per_day`).

## D-035: Capture-kit and what is still a browser test

- `@smc/capture-kit` holds everything that can be proven without a browser: frame gate (rate cap, change detection from a 576-byte signature, never the frame), region-of-interest crop, text classification into the strict `OcrContext`, a capability report, a capture loop that runs one recognition at a time and drops extra ticks, a worker message protocol with deadlines, and a client-side `assertNoPixels` check. The recogniser itself (PaddleOCR on onnxruntime-web, WebGPU with WASM fallback) sits behind the `OcrEngine` seam and is part of spike S1, tested in a real browser at the end.

## D-036: Evaluation harness and its limits

- `pnpm ai:eval` runs 100 frozen fixtures (including stale data, no bias, no setups, with and without a statistic) through the narrative pipeline. Offline it uses a deliberately misbehaving stand-in, to prove the guardrails release nothing unsafe; the report says plainly that this is a harness check and not a model result. `--live` prints a cost estimate and sends nothing without `--yes`; the judge must be a different vendor. `pnpm ai:session-hour` measures the cost of a replayed hour the same way. **No live evaluation has been run**, so faithfulness, first-pass validity and measured cost are unmeasured; the owner runs them (docs/how-to-enable-ai.md).

## D-037: Deferred from the Phase 5 plan

- Not built: J4 "why no trade" explanations and J5 batch reviews (no weeks assigned in B05), translation of answers into other languages, the 5% sampled online judge, server-side speech (voice belongs to week 15; only the voice command guard and the typed/voice chat path exist), provider token streaming, a database write of eval results (`eval_runs`), and the OCR eval on 100 crops (needs the browser and the S1 model).
- Owner-only items from the plan, not done by me: switching Supabase to Pro (a paid change), and the lawyer scoping call.
