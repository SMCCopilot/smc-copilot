# B06: MVP to Full Product Upgrade Path

**Set:** B (shippable MVP) | **Status:** Planning document, v2.0, 2026-10-10
**Purpose:** Show exactly what changes between the MVP (B01 to B05) and the full product (A01 to A10), how each change is made without a rewrite, and how forex is added later without touching the engine. Also holds the **cut list** for when the build slips.
**Read with:** A10 (milestones M6 to M10), B02 (the seams), B03 (schema), B05 (weeks).

---

## 1. What changes, in one table

| Area | MVP | Full product | How it changes | A10 |
|---|---|---|---|---|
| Processes | One (`APP_ROLE=all`) | `api` and `worker` | Env switch + Compose service split (section 2, U1) | M6 |
| Event bus / jobs / rate limits | In-memory bus, `pg-boss`, in-memory buckets | Valkey streams, BullMQ, Valkey limiter | Swap implementations behind `EventBus`, `JobQueue`, `RateLimiter` (U2) | M6 |
| Stream ownership | Process owns all | Leases per stream | `stream_leases` table (0010) + `StreamOwnership` impl (U3) | M6 |
| Venues | Binance + Bybit | + OKX, Coinbase, Kraken | Adapters; flip `crosscheck_enabled` (U5) | M6 |
| Speech-to-text | Browser only | + server sidecar (Parakeet / whisper.cpp) | New container, flag `voice.server_stt`, `voice.begin/audio/end` events (U6) | M6 (earlier if S3 fails) |
| Explain | GROUNDED only | + APPROXIMATE | Flag `explain.approximate` (U7) | M6/M8 |
| Billing | None (invite beta) | On-chain stablecoin invoices | Apply `upgrade/0010`, add watcher and endpoints (U4) | M6 |
| Sybil defense | Invite codes, Turnstile, hashed counters, tiny budget, global cap | + verified-human step | Config + one endpoint (U4) | M6 |
| Position sources | Manual log (L0) | + read-only exchange keys / linked wallet (L1) | `exchange_connections` (0010) + `PortfolioReadPort` (U8) | M7 |
| Research | CLI + SQL | Sweeps, calibration dashboards, labeling tool, strategy v2 | Additive tooling (U9) | M8 |
| Order routing | Not present | L2, conditional on legal | `OrderPort` behind a feature flag (U11) | M9 |
| Spoken replies | Not present | Kokoro TTS, opt-in | Client + validated-output hook (U12) | M10-A |
| Forex | Not present | Supported | Section 3 (U14) | M10-B |
| Hosting | Free VM + Supabase | Same until limits bite; paid nodes with your approval | Fallback ladder (U13) | M6+ |

---

## 2. Upgrade steps (runbooks)

### U1: Split `api` and `worker`

1. Build two Compose services from the same image: `api` with `APP_ROLE=api`, `worker` with `APP_ROLE=worker` (the entrypoint `apps/worker/main.ts` already exists).
2. Until Valkey exists, both roles still share nothing in memory, so do U2 **first**.
3. Verify: the gateway receives events published by the worker (needs U2), and `/readyz` on the API no longer depends on engine warm-up.

### U2: Introduce Valkey (bus, queue, rate limits, socket adapter)

1. Add a Valkey container to the same Compose project (memory budget in A08 section 1.1).
2. Implement `RedisEventBus`, `BullJobQueue`, `RedisRateLimiter`; keep job names and payload schemas identical to the `pg-boss` ones.
3. Add the Socket.IO Redis adapter at gateway bootstrap.
4. Migrate scheduled jobs one by one (outcomes, cohort stats, backfill, retention) with a feature flag per job; leave `pg-boss` running for one release as a rollback.
5. Verify: kill the `api` process mid-session; sockets reconnect to a new one and `session.start { lastSeq }` replays the missing events.

### U3: Stream leases and sharding

1. Apply `upgrade/0010` (creates `stream_leases`).
2. Implement `LeaseStreamOwnership`: a worker claims a stream key with a TTL and renews it; the key space is hashed by instrument.
3. Verify with two workers: each stream is owned exactly once; killing a worker moves its streams within the lease TTL, and the gap is backfilled.

### U4: Crypto billing, plans and the verified-human step

1. Apply `upgrade/0010` (creates `subscriptions`, `invoices`, `onchain_payments`, `chain_cursors`, `outbox`, plus the partial unique index that stops two open invoices sharing an exact amount).
2. Run **spike S6** on testnets before any mainnet address exists.
3. Implement the invoice endpoints (A07 section 7), the watcher with chain cursors and reorg handling, `MANUAL_REVIEW` for over/underpayments, and the entitlement mapping.
4. Turn on `payments.enabled` for a small allowlist first; pay your own invoice on mainnet with a dust amount.
5. Add the optional verified-human step to the free tier (A08 section 2.3) if free-account farming shows up in `abuse_flags`.
6. Counsel reviews the flow before public launch (A09 section 3.5).

### U5: More venues and instruments

1. Write the adapter (CCXT for REST metadata and backfill; direct WS for 1m candles; Coinbase polls REST).
2. Set `venues.crosscheck_enabled = true`, add `instrument_aliases` rows of role `CROSSCHECK`, and record `venue_terms` evidence before any raw-price display.
3. Run the 72-hour soak for the new venue before promoting it.

### U6: Server speech-to-text (Tier 2)

1. Add the `apps/stt` container (Parakeet TDT 0.6B v3 via sherpa-onnx, or whisper.cpp; decided by spike S3).
2. Turn on `voice.server_stt`; `GET /v1/voice/config` then lists the server tiers; the browser uses them only when Tier 1 cannot run.
3. Enable `voice.begin/audio/end`; add the CPU limiter (A08) and a dedicated daily limit.
4. Update the privacy notice: on Tier 2 only, audio of one utterance reaches our server, is transcribed in memory and discarded.

### U7: Explain APPROXIMATE mode

1. Turn on `explain.approximate`; the UI shows the `APPROX_MODE` disclaimer.
2. Extend the evals with an approximate-mode set (levels read from pixels are never presented as facts).

### U8: Read-only monitoring (L1)

1. Apply `upgrade/0010` if not yet applied; implement `PortfolioReadPort` for exchange read-only keys and for a wallet the user has linked and signed with.
2. Keys with trade or withdraw rights are refused at connect time (`KEY_TOO_PERMISSIVE`); secrets are envelope-encrypted and decrypted only inside the worker.
3. Gate G5: security review, canary-key test, pen test.

### U9: Research platform

Backtest sweeps with trial counting, bootstrap CIs, calibration dashboards, labeling tool, strategy v2 (T3), challenger-model bake-offs. Everything is additive because strategy versions are immutable rows and evals are code.

### U10: Weekly AI review, journal export, transactional email

1. `POST /v1/journal/export` (async job), weekly review job (batch), and an email channel for notifications **only for users who linked an email** (wallet-only users get in-app notifications).
2. Use free SMTP; confirm sender limits before enabling.

### U11: Order routing (L2), conditional

Only after counsel clears it (G6): `OrderPort`, adapters, a router constrained by a `ConfirmedGateRequest` type, per-order caps, paper trading, reconciliation, kill switch. For on-chain venues each order is signed by the user's wallet; we never hold keys. If counsel says registration is required and disproportionate, **do not build it**.

### U12: Spoken replies (TTS)

Kokoro (open source) in the browser, opt-in, fed **only** the validated output text (never raw model output), with a visible mute control.

### U13: Observability and resilience

1. Second-region VM image and a scripted DR drill; Upptime status page; synthetic keep-alive load if utilization trends under the reclaim threshold.
2. If a single VM cannot carry 250 sessions at the SLO, apply the fallback ladder (A08 section 1.3). **Any paid node needs your approval.**

### U14: Forex enablement (M10-B)

See section 3 in full. Prerequisite: gate G7 (a data licence that allows display and that you approved).

---

## 3. Forex later: the seam and the migration

### 3.1 Why forex is cheap to add

The MVP already contains the seams (verified in the tested schema):

| Seam | Where | State at MVP |
|---|---|---|
| `instruments.asset_class` includes `'FX'`, `pip_size` column | B03 `0002_market.sql` | Present, no FX rows |
| `market_calendars` is a generic table | B03 | Only `CRYPTO_24_7` seeded |
| `venues.kind` includes `FX_STUB`; stub venue is **disabled** | B03 seed | Adapter throws `NOT_ENABLED` |
| Licence view `instrument_license` | B03 | Applies to every asset class; no terms row means `INTERNAL_ONLY` |
| `candles.volume_kind` (`REAL`/`TICK`/`NONE`) | B03 | Forex uses `TICK` |
| `setup_outcomes.fees_r`, `risk_profiles.taker_fee_bps` | B03 | Forex uses a spread/commission model via the same columns |
| Engine config-driven sessions and opens | A04 | Crypto sessions are UTC-fixed; FX sessions are defined in config |

### 3.2 What must be true first (gate G7)

1. A data source whose licence allows what you display (a paid licence is an external cost: **you decide**).
2. Counsel confirms forex content stays impersonal and scenario-based in your chosen jurisdiction (A09).
3. The M2 labeling exercise and M3 outcome studies are re-run on FX data; FX cohorts start at n = 0, so FX probabilities do not appear for a long time.

### 3.3 The migration and code changes

| Step | Change | Where |
|---|---|---|
| 1 | Run `upgrade/0011_forex_enable.sql`: relaxes `venues.kind`, adds the `FX_24_5` calendar (New York 17:00 rollover as a calendar rule), a placeholder `FX_PROVIDER` venue (disabled, `INTERNAL_ONLY`), two inactive example instruments, and dark feature flags `fx.enabled`, `engine.fx_templates`. Tested on PG16: applies cleanly, idempotent, forex instruments come out `INTERNAL_ONLY` | `set-b/sql/upgrade/0011_forex_enable.sql` |
| 2 | `aggregate()` reads the rollover from the calendar rule (DST-aware) instead of a fixed UTC hour; add DST-week fixtures | `packages/market-data` |
| 3 | FX adapter replaces `fx-stub`; maps provider symbols; handles market-closed periods (`feed: 'CLOSED'` becomes real) and weekend gaps (no backfill alarms) | `packages/market-data` |
| 4 | Risk service: pips, lot sizes, pip value in account currency; forex has no liquidation model for spot, so the `LIQUIDATION_BEFORE_STOP` filter is skipped by asset class | `smc-engine` risk module |
| 5 | Sessions: FX Asia/London/NY definitions in config; `weekendLiquidity` weighting does not apply | strategy config (new immutable version) |
| 6 | News/event filter becomes more important for FX; decide whether to add it (A04) | M8-style work |
| 7 | Evals: OCR set gets FX screenshots (TradingView, MT5), voice glossary gets pair names ("euro dollar", "cable", "gold") | `packages/testing` |
| 8 | Flip `fx.enabled` for an allowlist, then everyone, after the golden replay shows crypto outputs unchanged | feature flags |

**Acceptance for the forex upgrade (A10 M10-B):** no change to the engine's pure core except config and the calendar-driven rollover; crypto golden hashes unchanged; FX instruments stay `INTERNAL_ONLY` until a `venue_terms` row says otherwise.

---

## 4. Cut list (use when the B05 variance exceeds 3 days)

Apply in order. Each cut is chosen to preserve the MVP's ability to test the hypotheses in B01 section 1 for as long as possible. "Restore via" names the upgrade step or the original B05 week.

| # | Cut | Days saved | What you lose | Hypotheses affected | Restore via |
|---|---|---|---|---|---|
| 1 | **Nightly HTF reconcile** and the `dq_incidents` workflow (keep gap backfill and the stale watchdog) | 1 | Early detection of aggregation drift | none (data quality) | U13 |
| 2 | **Calibration job** (keep cohort stats) | 1 | Reliability tables | H9 (informational) | U9 |
| 3 | **Eval sample sizes** (100 to 50 each; OCR, narrative, chat) | 1.5 | Statistical power of the safety checks | safety margin | expand before public launch |
| 4 | **OpenAPI/TS client generation** (hand-write DTO types from `contracts`) | 1 | Contract-drift detection | none | B05 W10 D5 |
| 5 | **Grafana dashboards beyond three** (feed lag, AI cost, VM utilization) and **Upptime** | 1.5 | Visual monitoring | none | U13 |
| 6 | **Position monitor** (keep gate + manual log + journal) | 2 | In-app trade alerts | U13 story | B05 W11 D4 |
| 7 | **OCR assist** (manual picker only; Explain still accepts an `instrumentHint`) | 3 | Auto-detect convenience; H2 not testable | H2 | B05 W14 D1 to D3 |
| 8 | **T1 template** (ship T2 only) | 2 | Reversal setups | H1 breadth | B05 W7 D2 |
| 9 | **Bybit cross-check** (Binance only; keep V1 to V6 and spot/perp sanity checks) | 2 | Independent venue agreement | data trust (H1 indirectly) | U5 |
| 10 | **Chat in the beta** (keep narratives, templates, Explain) | 4 | Q&A and follow-ups, and the text path for voice questions | H3 (partly), H7 | B05 W13 D1 to D2 |
| 11 | **Voice** (typed chat only; push-to-talk ships in M6) | 5 | Hands-free interaction; H7 not testable | H7 | B05 W15 |

Do **not** cut: determinism and no-look-ahead tests, gate invariants (including the database constraints that stop voice confirming), the licence guard, kill switches, the global daily AI cap, disclaimer/age/invite gates, cross-tenant tests, the no-frame/no-audio persistence tests, secret detection, backups. These protect the product's core promises and your liability (A09).

If cuts 1 to 7 are all taken the MVP still validates H1, H3 (via narratives and Explain), H4, H5 and H8, and saves about 11 days. Cutting voice (row 11) is the largest single saving, and it is the one you asked for explicitly, so it is last.

---

## 5. Upgrade triggers (watch these, then act)

| Signal | Threshold | Action |
|---|---|---|
| Concurrent sessions | Above 60 sustained, or p95 overlay latency above 500 ms | U1 + U2 (split and Valkey) |
| Event-loop lag p99 | Above 100 ms for 5 minutes | U1 early; check Explain concurrency |
| VM memory | Above 70% for a day | Move staging off the VM or apply the fallback ladder |
| Oracle utilization (CPU, network, memory) | All trending under 20% | Synthetic load; consider the pay-as-you-go conversion Oracle documents (needs a card; your call) |
| Venue outage or geo-block | Binance feed DEGRADED more than 15 minutes in a week | U5 (a second analysis venue) |
| Testers' devices fail Tier 1 speech | More than 15% of utterances fall back to typed | U6 (server STT) |
| Free-account abuse | `abuse_flags` rising, or the global cap hit on 3 days in a week | U4 step 5 (verified-human), tighten the free budget |
| Beta H6 positive | At least 25% "definitely would pay" | Start U4 and the public-launch sequence |
| AI cost per session-hour | Above 1.5x estimate | Gating/routing changes before anything else |
| Supabase DB size | Above 70% of the plan allowance | Retention tightening; partition drops (B03 section 7) |

---

## 6. Sequence from beta exit to public launch (A10 M6, about 5.5 weeks)

| Week | Focus |
|---|---|
| 1 | U2 (Valkey), U1 (split), U3 (leases); load-test harness |
| 2 | U5 (remaining venues), U6 if triggered; Sybil step; admin console basics |
| 3 | U4 steps 1 to 3 (spike S6, invoices, watcher) |
| 4 | U4 steps 4 to 6 (mainnet dust test, counsel review); entitlements enforced |
| 5 | Load test (250 sessions), restore drill, Upptime, second-region image; legal docs final |
| 5.5 | G4 review, launch checklist (A09 section 9), launch |

## 7. Risks of the upgrade path

| Risk | Mitigation |
|---|---|
| Interfaces were skipped to save time | The B05 rule: each seam exists on day one (B02 section 2); a CI check asserts the interfaces have a single DI binding |
| Valkey and the split introduce ordering bugs | Idempotent handlers; the golden replay and soak run against the split deployment before cutover |
| Payments edge cases | Exact-amount matching, `MANUAL_REVIEW`, BTCPay Server as the exit path (A08 section 7) |
| Free VM limits reached earlier than modeled | Fallback ladder; the first paid step is a decision for you, not an assumption |
| Forex licence cost or terms | Forex stays optional and last (M10-B, gate G7) |

## 8. Assumptions

1. Beta exit decision is "continue to the public path".
2. The upgrade steps are done by the same developer in the order shown, ahead of any new feature work.
3. Cost stays within the $0-plus-Supabase-plus-AI rule until you approve a specific paid step.

## 9. Open questions

1. **Public launch region(s) and legal entity** (jurisdiction-neutral until you decide; A09 section 11).
2. **Pro price points** in USD for stablecoin billing (default: decide after the H6 survey; the break-even in A08 section 8.3 gives the floor).
3. **Forex timing:** default is after public launch and only with a licence you approve.
