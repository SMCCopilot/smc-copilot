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
- **Choice:** no Docker in this project; superseded by D-016 (Railway). Add a proxy only if a second upstream (STT sidecar) needs path routing at M6.

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
- **Choice:** deploy the API to Railway (`railway.json`, Railpack build, no Docker). Supabase stays the database. The Oracle VM, Cloudflare Tunnel,  SOPS-on-VM and the VM-loss runbooks are no longer needed.
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
- Deterministic screens run before the model for chat: personal-advice requests, certainty and profit questions, leverage questions, requests to place or confirm trades, other-user data, and distress signals all get fixed replies. The "should I buy?" reply states what the engine shows (scenarios, invalidation) and that the decision is the reader's, and never reaches a model. If a model flags advice itself, its wording is discarded. These screens are what makes the critical red-team subset (75 prompts) pass at 100%.
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

## D-038: Phase 5 review outcome

Independent review (fresh context, 20 findings, 2 HIGH, none critical). **Fixed:** the number scan now also refuses percentages, any 3-digit-or-longer number, spaced thousands, number words and decimals (only fibonacci constants pass), and all text checks first normalise (fullwidth digits, zero-width and soft-hyphen characters) so obfuscation does not slip past; cache-write tokens were billed twice; the rate limiter's sweep could clear daily counters (each entry now expires by its own window); the socket path took the client-supplied end of `X-Forwarded-For`; parallel Explain requests could all slip under the daily cap (in-flight requests now count, and non-chart uploads count); `<user_message>`, `<user_question>` and the stored chat summary could be broken out of their delimiters, earlier user turns and the Explain question skipped redaction, and wallet addresses were not redacted; the chat summary call skipped the kill switch and budget; a picture-only symbol read with no price to confirm it could be treated as matched to live levels; the feed price had no freshness limit and Explain bypassed the cap on price comparisons; chunk events were stored for replay; follow-up suggestions were not substituted; chat cancel waited behind the message it cancels and disconnect detection did not fire; the second image-processing call lacked size limits; the live evaluation printed a spend cap it did not enforce and aborted on a judge failure; dev-page text was inserted unescaped. Regression tests cover each.

**Accepted, in the backlog:** a timed-out or aborted provider call is recorded at zero cost although the vendor may have billed tokens (the global cap can under-report); a 6 MB upload is buffered before the per-user allowance is checked (the route has its own 12 a minute limit); any signed-in user can trigger a shared narrative for any instrument (at most one a minute per instrument, behind the global cap); a model could still write markup that the dev page now escapes but a future real UI must also escape.

## D-039: Voice (Phase 6)

- **Audio never leaves the device.** Recognition runs in the browser. The server has no endpoint or event that accepts audio (`voice.begin`, `voice.audio`, `voice.end` answer `STT_UNAVAILABLE`), `voice_events` has no audio or text column, the config says `audioLeavesDevice: false`, the browser payload builder refuses binary data, and tests cover each. The only voice data stored is metadata: engine, timings, confidence, outcome, route and command name.
- **One grammar and one glossary, shared.** The closed command grammar, the forbidden-by-voice rules and the transcript correction live in `@smc/contracts` (pure), so the browser and the server behave identically. The grammar can only express view changes, pause, mute, setup navigation, watch, switch market and a journal note. The server re-applies the correction and re-checks the forbidden rules on both the heard and the corrected text, so correction cannot turn an allowed phrase into a forbidden one unnoticed, nor hide one.
- **Forbidden by voice** (confirm or place a trade, confirm the gate, log a trade, change risk or leverage, delete data or the account, pay): refused with the specific action, recorded as `FORBIDDEN_BY_VOICE`, and nothing changes. This is in addition to the database refusing any gate confirmation not made by a tap (invariant 1).
- **Models are pinned.** `model-manifest.json` names Whisper tiny English and Moonshine tiny (quantised ONNX) and the Silero voice detector by repository, commit, SHA-256 and size (about 80 MB in total, public files; `pnpm voice:pin-models`). The server advertises an engine as READY only when every file is pinned; the browser verifies each download and each cached copy and never caches a bad one. Model licences are the model authors' (all permissive as published); the owner should read them before launch.
- **Engine order:** Whisper on WebGPU, then Moonshine on WASM, then typing. An engine that fails is skipped for the session; denied microphone permission and no engine both fall back to typing (`MIC_PERMISSION_DENIED`, `STT_UNAVAILABLE`).
- **Server-side handling of a spoken command:** market switches resolve a spoken name ("ETH perp", "bitcoin") and ask the user to pick when it is ambiguous or unknown rather than guessing; "explain this chart", mute, and watch are handed back to the browser, which holds the capture and the speaker; anything that is not a command is a chat question (with the low-confidence confirmation rule from Phase 5).

## D-040: What was not done in Phase 6, and why

- The recogniser itself (transformers.js or onnxruntime-web running Whisper and Moonshine, a microphone worklet, WebGPU) is browser code that cannot run or be measured here; it plugs into the tested `SttEngine` and `AudioCapture` seams. Word error rate, real command accuracy and latency, and the Playwright network capture are the owner's browser tests (docs/how-to-test-voice.md). The text-only evaluation (200 phrases) passes, but it uses hand-written typical engine output and says nothing about a real engine.
- A nightly workflow was written (`.github/workflows/nightly-evals.yml`): AI harness, voice check, model hash verification, and the no-audio/no-image tests. It has never run, because the repository has no GitHub remote yet.
- Hands-free listening and server-side speech-to-text were never in the MVP and are not built.

## D-041: Phase 6 review outcome

Independent review (fresh context, 17 findings, 1 HIGH, none able to make voice confirm, log, pay or change anything: the grammar has no such command). **Fixed:** the market-switch rule swallowed any "show / open / go to / switch to" phrase ("show me the risks", "go to bed"), and now only a recognised market (written in capitals after correction) counts; the refusal and grammar rules ran on raw text, so zero-width characters, soft hyphens, fullwidth letters and Cyrillic lookalikes could dodge them (all text is now normalised first, in contracts); ordinary words that are also assets ("one", "link", "time") were being rewritten, which broke "show setup one"; "pay attention" was refused as a payment; the resume log stored what was said (it now keeps only that a command happened; the question text of a voice chat is stored like any chat text, 90 days, deletable, and D-039's "no transcript" wording means no transcript in `voice_events`); the push-to-talk controller could open the microphone twice, ignore a release during microphone start-up, hang on a failed stop or on an engine that ignores the abort signal, and retired an engine after one slip (now two in a row); setup navigation did not restart on a market change; the "corrected" flag compared against the wrong text; a burst of voice commands was not slowed; an engine with no files could be reported READY. Regression tests cover each.

**Accepted, in the backlog:** a spoken "boss" is read as BOS and "perk" as perp (the price of correcting common mishearings; the transcript is shown and editable); letter-by-letter spelling of a forbidden word ("t r a d e") is not caught and reaches chat (nothing can be done by it); the pin tool trusts the first download of each file; the server supplies the model addresses and hashes, so a compromised server could point the browser at its own files (a signed manifest is the fix); a journal note by voice is saved without a review step.

## D-042: Hardening and beta preparation (Phase 7)

- **Account deletion (U16).** `DELETE /v1/me` needs a fresh wallet signature and the exact phrase `DELETE MY ACCOUNT`. It blocks the account at once, unlinks wallets, ends sessions and voids open gates; `POST /v1/me/deletion/cancel` works during the grace period (72 hours by default); after it a purge deletes the workspace (and with it sessions, trades, journal, chat, Explain, voice log, notifications) and the profile and sign-in record, and scrubs the audit trail and AI call rows of anything that points at the user. A test searches every text, uuid and json column of every table for the user and workspace ids after a purge and finds none, and checks another user is untouched. Backups keep the data until they expire; the runbook says so plainly.
- **Retention is now enforced.** The SQL function `retention_purge()` existed since the schema but nothing called it. A timer (every 6 hours, first pass a minute after start) now runs it with partition maintenance: resume log 7 days, voice log 30 days, chat and Explain records 90 days, AI call partitions 90 days, audit trail one year. A test shows old rows go and recent ones stay.
- **Proxy handling closes the Phase 4 admin gap.** In production the service trusts exactly one proxy hop, so on Railway `req.ip` is the real caller and the admin address allow-list works (it previously relied on a Cloudflare header only). `TRUST_PROXY_HEADERS` stays for the tunnel case.
- **Metrics and alerts.** `GET /metrics` (Prometheus text) exists only when `METRICS_TOKEN` is set and needs the exact bearer token; it exposes feed state and lag, sockets, HTTP counts by class, AI spend against the cap and breaker state, open sessions, partitions ahead, database size. A test checks the format and that no user id, workspace id, key or token appears. `ops/alerts.yml` encodes the A08 section 5.3 thresholds against these names. Dashboards (Grafana) are not built; the metrics are what they would read.
- **Security pass.** `pnpm audit` (including dev dependencies) found nothing. New tests: log redaction (tokens, keys, cookie, invite code, Turnstile token, secret-like notes never appear in logs), a tenant isolation matrix over every id-bearing route, a scan that every admin controller carries the admin guard, and the 20-session smoke (update to overlay p95 under 500 ms, no gap in any session's sequence numbers, with the model off). Not done: a ZAP baseline scan (needs a deployed target) and k6 (the smoke is a Node test).
- **Other hardening from the backlog:** an idempotency key left by a crashed request is released after 60 seconds; blocking a user voids their gates and ends their sessions; a model call that times out is recorded with the input cost the vendor may have billed. Deferred again: millisecond cursors, journal edits that clear text, per-setup risk-profile loads. A change that rejected oversized uploads before reading them was tried and reverted: answering before the body is read makes browsers see a connection reset instead of the error.
- **Deployment.** `railway.json` (Railpack build, no Docker; run migrations before each release; health check on `/healthz` after review (a venue outage must not block a rollback); one replica). Nothing was deployed.
- **Readiness checker.** `pnpm ops:preflight [--db]` grades configuration and, read-only, the database: production configuration valid, developer client off, admin allow-list set, AI providers usable, migrations applied, the development invite code absent, real invites present, sanctions list loaded, open sign-up off, no kill switch left on, row-level security everywhere, an active strategy, partitions ahead. Its queries run against a real migrated database in tests.
- **Backups.** `tools/ops/src/backup.mjs`: `pg_dump` of the `public` schema encrypted in authenticated chunks (a wrong key, a changed byte or a truncated file fails), restore into a scratch database only. The encryption is tested; the dump and restore steps need `pg_dump` and were not run, so **no restore drill has been done**.
- **Beta pack.** `docs/beta/`: brief, interview script, exit criteria written before the beta, the weekly H1 to H8 queries (validated against the schema and checked read-only), the G3 checklist with honest status per item, and the legal prerequisites page (a fact sheet for counsel; no legal decisions made).

## D-043: Phase 7 independent review

A fresh-context review found no critical issues and ten others. Fixed: a purge re-checks and locks the profile row, so a cancel that races it wins and two purges cannot both run; one failing purge no longer blocks the ones behind it; the audit trail's network address is cleared on purge (and audit rows naming the workspace are scrubbed); the Railway health check is `/healthz`, because `/readyz` includes the venue feed and a venue outage would block a rollback; backup and restore now fail on a non-zero exit of `pg_dump` / `pg_restore` and delete a partial backup file; the restore guard compares host/project and database name against both connection strings, not only an exact string; a damaged backup may already be partly applied to the scratch target, and the header now says so; preflight fails on a `METRICS_TOKEN` under 32 characters, fails `TRUST_PROXY_HEADERS=true` on Railway, and compares the migration count with the files shipped.
Not changed, documented: `abuse_flags` rows keyed by a salted hash of the user stay until they expire (they hold no identifier, but are linkable with the salt); `trust proxy 1` assumes one hop, so putting Cloudflare in front of Railway makes the admin allow-list fail closed until that setting is changed; retention and purge have no cross-instance lock (one replica is configured); AI call partitions are dropped when a whole month is past 90 days, so metadata can live about 120 days.

## D-044 Web wallet sign-in without wagmi or the Solana adapter (F1)

`supabase.auth.signInWithWeb3` takes the wallet provider object directly, and EIP-6963 gives provider discovery for several EVM wallets, so wagmi/viem and the Solana wallet adapter would add bundle weight without adding a capability for sign-in. Decision: use the injected providers directly. Revisit for wallet linking and step-up if they need richer connectors. `@smc/contracts` is marked `sideEffects: false` so web bundles can drop unused schemas.

## D-045 HTML dev client retired (F4)

The web app replaces it. Removed: `/dev` and `/dev/config`, `DEV_CLIENT_ENABLED` (schema, preflight, local runner) and the dev client's admin panel for AI providers (use `PUT /v1/admin/ai/providers/:id`). `dns-override.ts` moved to `apps/api/src/ingest/` because ingest still uses it. Web imports are relative so the dependency checker resolves them.

## D-046 Open sign-up: invite codes and the Turnstile bot check removed (2026-10-18)

The owner decided anyone should be able to use the platform. Removed: the invite gate (`INVITE_REQUIRED`, `POST /v1/me/invite`, `POST /v1/admin/invites`, `invite` in `/v1/me`), the web invite step, `pnpm local invite`, the invite preflight checks, and the Turnstile verifier (API, web widget, `TURNSTILE_*` settings, `X-Turnstile-Token` header), which only ever protected the invite endpoint. Migration 0013 drops `redeem_invite`, `invite_codes`, `invite_redemptions`, `profiles.invite_redeemed_at` and the `signup.open` flag. Gates now: wallet sign-in, the disclaimer, 18+.
Consequences, accepted by the owner: sign-up has no bot protection until captcha is enabled in Supabase Auth; every user gets the default AI budget (`AI_DAILY_BUDGET_DEFAULT_USD`, no $1 invite grant); the Sybil defence is the per-user, per-IP and per-device AI limits plus the global daily cap and kill switches. The `SIGNUP` kill switch now blocks finishing onboarding (`POST /v1/me/disclaimer`), so it stays as an emergency stop. `docs/beta/legal-prerequisites.md` said invited testers only: counsel should review that change.

## D-047 Live prices and speech (2026-10-18)
The owner wants real candles and better voice, not overlay-only. **Prices:** the owner chose live prices in the chart. Options weighed: (a) our servers relay candles (needs a `venue_terms` evidence row per venue, a licensing question the owner has not settled), (b) the browser reads Binance's public market-data endpoints directly (nothing is redistributed by us; the user's own browser talks to Binance, like opening Binance's chart), (c) a TradingView widget (cannot carry our scenario overlays, which are the point of the product; the Charting Library that can needs an approved licence and our own data feed). Chosen: (b), as an opt-out toggle on by default for Binance markets, remembered per browser, with the existing overlays drawn on top and a plain note that prices come straight from Binance. The server path (a) is unchanged and takes precedence where `venue_terms` exist. Users in regions Binance refuses (HTTP 451/403) see that stated and keep the levels view. The user's IP is visible to Binance as on any Binance page. **Speech:** the browser's own on-device recognition (`processLocally`, language pack installed) is used first because it shows words live and is far more accurate than the small on-device model; it is used only when the browser confirms on-device processing, never a cloud mode, so invariant 2 stands. Whisper/Moonshine stay as the fallback. New engine tag `browser-local` (migration 0014).
