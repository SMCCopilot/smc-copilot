# Progress

Running state. A fresh session should be able to resume from this file and `CLAUDE.md` alone.

- **Current phase:** 1 (Market data core) built and verified locally; awaiting the owner's approval of Phase 2
- **Owner priority:** build the tech and make it work through live testing; defer everything else.
- **Branch:** everything is on `main` (owner decision: one branch until told otherwise)

## Phase 0 steps

| Step | Scope | Status |
|---|---|---|
| 1 | Monorepo scaffold, tooling, boundaries, env schema, contracts | done (review round 1 fixed) |
| 2 | `packages/db`: migrations runner, SQL smoke test on real Postgres, CI workflow | done locally; CI UNVERIFIED (no remote) |
| 3 | `apps/api` skeleton (health, readiness, logging, problem+json, JWT guard) | done (review round 1 fixed) |
| 4 | Dockerfile + Compose | written; packaging (`pnpm deploy` + boot) proven locally; image UNVERIFIED (no Docker daemon) |
| 5 | Spike tooling: S2 venue probe (run), S4 browser page (built, needs owner's browsers), S5 sheet | S1/S3 pages NOT built (need owner's screenshots/recordings) |

## Acceptance criteria (Phase 0)

- [x] `pnpm turbo run build lint typecheck test --force` green (38 tasks) (A10 M0 AC1, locally)
- [x] Importing an app from a package fails lint (`tools/boundaries/test`, 57 tests incl. depcruise negative cases)
- [x] SQL apply + smoke test on a real Postgres: 55 tables, 15 expected failures (MVP), 62 tables / 17 failures (full), idempotent, race-safe (`packages/db/test`)
- [x] Clean clone (fresh `git clone`, `pnpm install --frozen-lockfile`, `turbo run build lint typecheck test`, `pnpm lint`) green locally: 42 tasks, 202 tests
- [ ] CI green on GitHub: workflow written, needs a remote
- [x] `GET /healthz` 200; invalid JWT gives problem+json 401 (api e2e tests and the real built server)
- [ ] Spikes S1-S5, S7 have recorded numbers and a decision (gate G0): S2 measured (dev machine), S5/S1/S3/S4/S7 need the owner

## Step log

### Steps 1-2: scaffold, tooling, db
- Local gates: `pnpm turbo run build lint typecheck test --force` (38 tasks), `pnpm lint` (Biome, boundary check, depcruise). Tests: contracts 36, config 28, boundaries 57, db 35 (real embedded Postgres 17.10, plus psql 18 client for the smoke script).
- Independent review round 1 (fresh-context subagent) found 18 issues; all valid ones fixed:
  - acceptance command lacked a turbo `lint` task; `pnpm lint` failed when `apps/` was empty; turbo cache hid failures (root files not in the hash)
  - purity scan was a bypassable line regex -> replaced with a TypeScript AST scan (Date/Intl/Math.random/transcendental Math/globals/imports allow-list), manifests checked for third-party and aliased workspace deps
  - depcruise core-module list incomplete -> bans every Node core module in pure packages, plus `not-to-unresolvable`
  - secret scanning: gitleaks was not installed so the hook silently skipped -> pinned, checksum-verified local install (`node tools/hooks/install-gitleaks.mjs`), no blanket allowlists, canary token proven detected
  - env schema failed open (default NODE_ENV was development) -> default is now production; blank values uniformly unset; origins and admin IPs validated; minimum secret lengths
  - contracts: client WS events are Zod payload schemas with an exact-set test; `HistoricalStat` rejects n < 30 in the schema; facts strict and bounded; candle OHLC check; problem status tied to code; canonical ids upper-case only
- Found by our own tests: concurrent migration runners raced on `create schema if not exists` (fixed with a transaction advisory lock).

### Step 3: api skeleton (review round 1, all valid findings fixed)
- Error logging reduced to type/code/frames (message and properties can embed secrets); correlation id survives rejected bodies; urlencoded 64 KB limit; library errors with a `status` are no longer mistaken for client errors; anonymous/future-iat/non-authenticated tokens refused; JWKS outage is 503; /readyz single-flight with a 1 s cache and logged failures; real AuthModule wiring tested against a local JWKS server; HS256 test now proves the allow-list; prepare:false asserted.
- Real server run: `/healthz` 200, `/readyz` 503 NOT_READY without a database, production start without secrets exits 1 listing variable names only.

### Spike S2 (dev machine, 2026-10-11)
- Router DNS does not resolve the Binance/Bybit API hosts (public DNS does). Binance perp WebSocket moved to a `/market` path (old path sends no frames). Bybit raw lag 72-82 ms (uncorrected). Lag is unmeasurable here (clock/RTT); must be measured on the VM. See docs/spikes.md and DECISIONS.

## Open items for the owner

- **GitHub remote** (private recommended) so CI can run. Until then CI is UNVERIFIED.
- **`.gitignore` lines `.claude` and `docs/*`** were added by someone after I wrote the file. I kept them and un-ignored only the process docs (`DECISIONS`, `PROGRESS`, `backlog`, `spikes`, `engine-fidelity`). `docs/plan/` is already committed on this branch; say if you want the plan untracked.
- Supabase dev project credentials in `.env.local` (never in chat); key names are in `.env.example`.
- Spike inputs: 40 chart screenshots, 200 recorded phrases, device list.

## Phase 1: market data core (branches `phase-1/*`, cumulative on `phase-1/step-1-validation-aggregation`)

- `packages/market-data` (122 tests): normalisation and validation V1-V9, UTC aggregation (property-tested against a reference), Binance spot/perp + Bybit providers, self-healing connection (backoff, jitter, silence watchdog, rotation without a gap), replay + FX stub, feed-status watchdog, instrument resolver, stream registry.
- `apps/api` (118 tests on real Postgres): ingest pipeline (atomic 1m + higher-timeframe writes, events after commit, quarantine, gaps, backfill via pg-boss, V7 both directions, INCOMPLETE handling), seeding, nightly reconcile, feed monitor, markets and admin endpoints, licence guard.
- Live run on this machine (DNS override): Binance spot + perp and Bybit connected; history seeded; all 8 feeds OK; recorded frames replay to the same candles as REST (7/7 on each venue, 0 differences).
- Not yet done: 24 h and 72 h soak and the p95 feed-lag figure (need the VM), Supabase run (needs credentials), CI on GitHub (needs a remote).

## Owner decisions after Phase 1
- Host the backend on **Railway** (D-016). Browser tests (S1/S3/S4) happen after all phases, using Claude Desktop. The owner will fill the credentials after all phases; `.env.example` lists every variable with where to get it.

## Phase 2: SMC engine (all on `main`)

**Status: built and reviewed; gate G1 (labeled agreement) is waiting for the owner's labels.**

- [x] `StrategyConfig` Zod schema in contracts; parses the seeded `smc-core v1` JSON; refuses non-UTC sessions, bias timeframes that are not analysed, inverted OTE.
- [x] Pure engine `packages/smc-engine`: `step()` / `feed()` reducer, pure SHA-1 event ids, Wilder ATR14, swings (internal 3/3, external 10/10, tie rule, confirmation time), close-based BOS/CHoCH with protected levels, multi/gap-break flags, FVG and order-block lifecycles, EQH/EQL pools, previous day/week and session levels, open prices, sweep vs run, dealing range with premium/discount and OTE, UTC sessions and killzones, multi-timeframe snapshots with `htfAt`/`biasAt`, canonical close-order feeding, `ChartFacts` builder (MarketFacts v0), stream hash.
- [x] A04 section 15.5 worked example reproduced exactly (swings at the right confirmation times, EQL pool 64020, sweep 07:15 extreme 63960, CHoCH 07:45 at 2.6 ATR, OB [64040, 64110], FVG [64110, 64270], range 63960-64400 with OTE [64052.4, 64127.2], entry in discount at 0.26).
- [x] Properties: no look-ahead (1,000 random datasets, plus altered futures), determinism, scale/shift invariance, unique event ids, **mirror symmetry** (a price-flipped dataset yields the mirrored events, which exercises the whole bear side), arrival-order invariance for multi-timeframe, JSON snapshot round trip, bounded state.
- [x] Golden hashes pinned (worked example and a seeded 20-day multi-timeframe dataset). They should be identical on any machine because only IEEE +,-,*,/ and comparisons are used (verified on this x64 machine only; arm64 unverified). Real-venue goldens stay out of git (raw exchange data); regenerate with `pnpm engine:replay --db ... --export-candles`.
- [x] Performance: step p50 0.025 ms, p95 0.08 ms, max 2.3 ms over 12,420 steps (budget 20 ms for 4 instruments x 4 timeframes; the test asserts it).
- [x] Worker runner (`apps/api/src/engine`): consumes `candle.closed`, writes `engine_events` and hourly `engine_snapshots` in one transaction, restarts without duplicates, rebuilds on `candle.backfilled`. 12 integration tests on real Postgres.
- [x] `pnpm engine:replay` (file or DB, `--facts`, `--expect-hash`), `pnpm engine:label-pack` (blind labeling page; rendering verified in headless Edge), `pnpm engine:fidelity` (scoring and report). Workflow in `docs/engine-fidelity.md`.
- [x] Independent review (fresh-context subagent, 21 findings, none critical or high). Fixed: OB displacement ignoring candle direction; previous day/week levels appearing a period late on 4h/1d; failure flag never clearing; failed rebuild never retried; cold-start rebuild retracting older events; snapshot retention and versioning; `asOf` published as an open time; pool-cap eviction, unbounded pool members, close-beyond-pool never counting as a run; locale-dependent sorting; config validation; label-tool bugs (`$` patterns, unvalidated import, index mapping across gaps, end-of-chart margin). Documented as accepted limits: D-020. Found earlier by our own tests: duplicate order-block identity, repeated-touch and pool ids reused (D-017).
- [ ] **Gate G1 (owner input, blocking):** about 20 labeled charts; targets swings 90%, structure 90%, FVG 95%, order blocks 70%. May end as "adjust".
- Unverified: engine behaviour on live venue data over days (needs the deployed worker), GitHub CI, the label page's click/export flow in a real browser (rendering only was verified), golden hash on arm64.

Totals after Phase 2: config 29, contracts 40, market-data 123, db 35, boundaries 57, spikes 11, smc-engine 72, tool-engine 19, api 137.

## Phase 3: setups, scoring, outcomes, stats, risk, backtest (all on `main`)

**Status: built, independently reviewed, fixed. G2 passes by its own definition (look-ahead tests green, live/replay equivalence holds, report exists). The backtest verdict is NO_EDGE_DETECTED.**

- [x] **Setups T1 and T2** in the pure engine: created the bar after the structure break (matches the A04 section 15.5 worked example, which reproduces exactly: candidate 08:00, entry 64075, stop 63945, TP1 64450 at RR 2.88, grade A, score 78.74, triggered 09:15, TP1 at 09:30 with fill 64075.1 and net 2.388 R). Hard filters record every failing code; rejected setups are events and rows. Soft score with the hypothesis weights; grade by cuts.
- [x] **Trade plan** (`TradePlan` contract; invalidation and alternate scenario required by the schema): targets are levels (pools and unswept swings), RR is derived, never chosen. Plans are projected into `trade_plans` with the plan hash the gate will bind.
- [x] **Shadow outcomes `shadow-v1`**: pessimistic fill model (stop before target, no TP credit on the fill candle, gap through the stop at the gap price, trade-through by half the spread, slippage, round-trip fees in R). Property and unit tests, long/short mirror tests.
- [x] **`@smc/analytics`**: Wilson interval, cohort summaries, n >= 30 gating, confidence label, risk sizing with fee adjustment and the approximate liquidation warning, calibration (reliability, Brier, log loss), walk-forward backtest evaluation (seeded day-clustered bootstrap, drawdown, pre-registered criteria, trials haircut). Spec cases pass: n = 29 gives no number, n = 40 with 16 wins gives 0.400 with CI 0.26 to 0.55.
- [x] **Persistence and jobs**: engine events are the source of truth; `setups`, `setup_transitions`, `trade_plans`, `setup_outcomes` are a projection applied only for newly inserted events (restart and retry do not duplicate). Base rate attaches to a plan only from a sufficient, ACTIVE cohort; a cohort under review shows nothing. Hourly cohort refresh and daily calibration (idempotent, in-process timers). 26 integration tests on real Postgres.
- [x] **Backtest tooling**: `engine:fetch-history` (public klines, raw data stays out of git), `engine:backtest` (report, JSON, optional `backtest_runs`). **Criteria were pre-registered and committed before any real-data run** (`docs/backtest-criteria.md`, commit 15f0252).
- [x] **Real backtest**: 4 series (Binance spot and perp BTCUSDT and ETHUSDT), 12 months, 164k candles each. **Run 1: NO_EDGE_DETECTED. Run 2 (after review fixes, trials counted as 4): NO_EDGE_DETECTED**, final test 1,209 trades, mean net R -1.51 (gross -0.34, fees 1.17), 0 of 3 windows positive for either template. Full tables in `docs/backtest-report.md`; Run 1 kept in `docs/backtest-report-run1.md`; every change between runs is in the change log of the criteria file.
- [x] **Independent review** (fresh-context subagent, 19 findings, 4 HIGH). Fixed: non-numeric `--trials` could produce a pass; an UNDER_REVIEW live cohort fell back to a backtest rate; a missing entry candle silently dropped a setup; plans published with a TP1 that had already traded; near-duplicate trades treated as independent in the bootstrap; haircut saturating at 100 trials; cost model more flattering than A04 13.2; split dates not matching the registration; stale outcomes not flagged after a rebuild and a second RESOLVED transition; cohort job overflow and stale rows; calibration double counting; setups dropped at the cap without an outcome; unknown tick size silently meaning zero slippage; backtest dropping unresolved setups without saying so; cohort publishing not transactional or opt-in. Accepted and documented: D-021, backlog (replayed history in live cohorts, no `setup_displays` writer until Phase 5, filter semantics).
- [ ] Unverified: live behaviour on the deployed worker over days; `setup_displays` and calibration with real displays (Phase 5); GitHub CI.

Totals after Phase 3 (fresh clone, 51 tasks, lint and boundaries clean): config 29, contracts 40, market-data 123, analytics 30, smc-engine 130, db 35, boundaries 57, spikes 11, tool-engine 27, api 155 = 637 tests.

## Phase 4: identity, APIs, realtime, gate, trades, journal (all on `main`)

**Status: built, independently reviewed (23 findings, 2 HIGH, fixed; D-029).**

- [x] **W9 identity and gates**: wallet-first accounts (EVM and Solana, EIP-55 checksum, wallet mirror from `auth.identities`), invite, disclaimer version, 18+ attestation, address blocklist, step-up, wallet link/primary/unlink, optional email, abuse flags (salted hashes, no raw IPs), Turnstile, admin operations (invites, blocklist, entitlements, block, flags, kill switches, strategy versions, DQ incidents), all audited.
- [x] **W10 read APIs**: venues, instruments, analysis snapshot (ETag/304, `snapshotId` = hash of the content), setups (list, one, history, rejected), cohort stats (only sufficient cohorts), sessions with idempotency keys (replay and conflict), risk profile and sizing.
- [x] **W11 realtime and trading records**: Socket.IO `/ws` with resume, execution gate, trade log with realised R net of fees, position monitor, in-app notifications, journal (auto entries for setups shown, gates and trades; notes and tags; summary), feedback, HTML dev client.
- [x] No test data in the owner's database: automated tests run on throwaway embedded Postgres; the real Supabase database holds reference rows only.
- Tests: api 219 (real Postgres, real sockets), including concurrency regressions.
- [ ] **Unverified until the owner's live test**: a real wallet sign-in (the `identity_data` shape, unlink behaviour), Web3 providers enabled in Supabase Auth, the dev client in a browser, the realtime flow against live engine output, Railway deployment.

## Phase 5: AI layer (all on `main`)

**Status: built; independent review pending.**

- [x] **W12 router, guardrails, narratives, budgets**: `@smc/ai` with Anthropic, OpenAI and Gemini adapters, an owner-switchable `LlmRouter` (order, data classes, retries, circuit breakers, cost on every call), prompt versions, the output pipeline (schema, references, number scan, language, one repair retry, template), seed-phrase and key detector, template narratives, shared narrative service with a facts-hash cache, per-user and global ledgers with an automatic global cap, kill switches, admin endpoints for providers, spend and costs.
- [x] **W13 chat, data classes, cost**: grounded chat over the socket and as server-sent events, deterministic screens (advice, certainty, leverage, trade placement, other users, distress), red-team set (75 critical prompts at 100%, 25 injection prompts against a hostile model), data-class policy per provider, per-IP and per-device shared allowances, voice-command guard (confirm, log, risk, delete and pay refused by voice, recorded), session-hour cost script.
- [x] **W14 OCR and Explain**: `@smc/capture-kit` (logic complete and tested), server `context.hint` (two-hint rule, feed reconcile, mismatch suggestion without prices), Explain with a reader and a writer, in-memory image handling, grounded and approximate modes, no-frame-persistence tests (schema scan, every table, logs, temp directory).
- [x] Evaluation harness with 100 fixtures; developer client extended (narrative, chat, chart upload, provider switches).
- Tests: ai 274, capture-kit 21, ai-eval 7, api 259.
- [ ] **Not measured, because it costs money or needs a browser**: live provider calls (request shapes are covered by tests with a fake network only), narrative faithfulness and first-pass validity, cost per session-hour, OCR accuracy on real screenshots, image-read accuracy. All are in docs/how-to-enable-ai.md with cost estimates.
