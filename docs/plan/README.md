# SMC Copilot: Backend Plan (v2)

Planning only (no application code). Schemas, contracts and migrations are included. Revised 2026-10-10.

SMC Copilot is a browser-based, Meet-style Smart Money Concepts assistant. The user connects a wallet, shares a charting window (or uploads a chart), and gets real-time, explainable SMC scenarios with invalidation and honest base rates, by chat or by voice. It never trades on its own and never claims to predict the market.

**Start with `00-AUDIT-AND-TRACEABILITY.md`**: it says what changed from v1, whether the plan is concrete enough (and where it is not), and the results of every check I ran. Then read **Set A** (full product) and **Set B** (the MVP carved out of it). The two sets are separate on purpose.

## What v2 encodes from your answers

| You said | Where it lives |
|---|---|
| Pay only for Supabase and AI models; everything else free or open source | A01 section 1.2, A08 sections 1 and 8, B02 section 7 |
| Supabase vs Railway vs self-hosting | A01 section 5.2 (scored; hosted Supabase wins) |
| Crypto first, forex supported later | A03 section 2.4, A10 M10, B06 section 3, `sql/upgrade/0011_forex_enable.sql` |
| International, nothing country-specific | Jurisdiction-neutral A09; no country terms anywhere (checked) |
| Voice with open-source speech-to-text | A02 section 6, A05 section 14.4, B05 week 15 |
| Zero retention of screen frames | A02 section 3.5, schema has no image/audio column, tests in B04 section 7 |
| "Explain this chart", with screen share | A02 sections 3.3 to 3.6, A05 section 8.3, A07 section 6.1, B05 week 14 |
| Auth tied to the wallet; email optional | A06 section 3, A07 section 3, `sql/0001_identity.sql`, B05 week 9 |

## Set A: Full product backend

| Doc | Covers |
|---|---|
| A01 Architecture overview | Principles, cost policy, system diagram, stack decisions, Supabase vs Railway comparison |
| A02 Realtime and media | Hybrid data decision, on-device OCR, Explain capture, WebSocket protocol, voice |
| A03 Market data layer | Venues, licence gating, validation V1 to V9, aggregation, backfill, the forex seam |
| A04 SMC engine | Deterministic reducer, setups, scoring, execution gate, outcomes, calibration, worked example |
| A05 AI layer | Jobs J1 to J8, models and cost, prompts, schemas, guardrails, data classes, evals |
| A06 Database schema | Full Postgres DDL (embedded from tested `sql/`), RLS, retention |
| A07 API spec | REST and WebSocket contracts, wallet-first auth, Explain, voice, errors, rate limits |
| A08 Platform concerns | Free-tier hosting and fallback ladder, security, Sybil defense, jobs, scaling, observability, crypto billing, cost model |
| A09 Risk and compliance | Risk register, jurisdiction-neutral regulatory stance, disclaimers, privacy, sanctions, enablement gates |
| A10 Milestone roadmap | M0 to M10, gates G0 to G7, spikes S1 to S7 |

## Set B: MVP

| Doc | Covers |
|---|---|
| B01 MVP scope | Hypotheses H1 to H9, in/out of scope, user stories U1 to U18, definition of done, beta plan |
| B02 MVP architecture and stack | Single process on a free VM, seams, monthly cost |
| B03 MVP database schema | Ready-to-run SQL (embedded from `sql/`) and verification results |
| B04 MVP API and events | The MVP subset of A07 with build weeks, contract tests |
| B05 MVP build plan | 17 weeks (16 build + 1 beta/buffer), day by day, with acceptance criteria |
| B06 MVP to full upgrade path | Steps U1 to U14, forex enablement, cut list, triggers |

## SQL (`set-b/sql/`)

| File | Purpose |
|---|---|
| `0001` to `0009` | The MVP schema and seeds (apply in order with `apply.sh`) |
| `upgrade/0010_full_product_additions.sql` | Billing, leases, exchange connections, outbox (M6) |
| `upgrade/0011_forex_enable.sql` | Forex calendar, placeholder venue and instruments, dark flags (M10-B, after gate G7) |
| `0000_dev_shims.sql` | Local testing only (fakes `auth.users` and `auth.uid()`) |
| `tests/b03_smoke_test.sql` | Happy paths plus statements that must fail (15 on the MVP schema, 17 with `0010`) |

Usage: `./apply.sh <database-url> [--with-shims] [--with-upgrade] [--with-forex]`.

## Key decisions
- **Data:** the exchange feed is the source of truth (Binance primary, Bybit and others cross-check, same market type only). The screen share gives context through on-device OCR, and a manual picker always works.
- **Privacy:** text leaves the browser, pixels and audio do not. The one exception is Explain, which sends one image to a one-shot request that is read and discarded.
- **Cost:** Supabase and AI models only. AI is 85 to 99% of the bill, so spend controls (per-user budget, global daily cap, kill switches) are part of the MVP.
- **Database:** hosted Supabase Postgres. Free while building, Pro from the beta.
- **Engine:** deterministic, no look-ahead. The AI explains numbers the engine produced and never invents them.
- **Execution:** L0 manual log in the MVP. Voice can never confirm anything, enforced in the database too. L1 read-only in M7. L2 routing in M9, only if counsel clears it.
- **Plan:** nominal 17 weeks from 2026-10-19 (closed beta around 2027-02-26); plan for about 21 weeks (late March 2027) with a 25% contingency.

## Caveats (read these)
- **Planning only.** Nothing here has been run as an application. The SQL was applied and tested on a local PostgreSQL 16 only (MVP-only and full). Not exercised: Supabase's real roles, PostgREST, `pg_cron`, the pooler, and how Supabase fills `auth.users` for Web3 sign-in without an email. Verify in a scratch project in week 9 (B05).
- **Unmeasured by design:** OCR accuracy, speech accuracy, WebGPU coverage, Oracle free-VM capacity and idle-reclaim behaviour, and venue geo-blocking. Spikes S1 to S4, S7 measure them in week 1, with fallbacks written down.
- **Oracle's free tier is the weakest link.** It can run out of capacity, reclaim an idle instance, or end an account. The fallback ladder is in A08 section 1.3; any paid step needs your approval.
- **Venue terms (spike S5).** Until a `venue_terms` row records permission, every instrument stays `INTERNAL_ONLY` (overlays and analysis, no raw prices to the browser).
- **Vendor retention.** "Zero retention" means we keep nothing; model providers have their own retention terms, documented per vendor in A05 section 12.
- **Free wallet accounts are cheap to farm.** The defenses (invite codes, Turnstile, hashed counters, tiny budget, global cap) bound the cost but do not make abuse impossible.
- **Vendor prices, limits and licence terms** come from secondary research dated 2026-10-10. **[verify]** items need a check against the vendor's own page; **[counsel]** items need a lawyer.
- **Mermaid:** all 23 diagrams were rendered successfully with mermaid-cli.

## Biggest open items
1. Operator jurisdiction and a lawyer scoping call on the scenario-content framing and the crypto-payment flow (A09).
2. Venue terms for Binance and Bybit (spike S5).
3. The browser spikes S1, S3, S4 (OCR, speech, WebGPU) and the region/VM spikes S2, S7, all in week 1.
4. Supabase Web3 behaviour for email-less users (week 9, day 1).
5. A forex data licence, if and when you want forex (gate G7).
