# 00: Audit and Traceability (v2)

**Status:** 2026-10-10. Read this first. It answers your question "are you sure this is concrete enough to deliver what I want?", lists what was wrong or thin in v1, traces every requirement you gave to the documents that satisfy it, and records the result of every check I ran, including the checks I could not run.

---

## 1. The honest answer: is it concrete enough?

**Yes for the backend design, with five things that a document cannot settle and that the plan therefore turns into week-1 tests.**

What "concrete enough" means here: a developer (you) can start building on Monday 2026-10-19 without having to make another architectural decision, and every later decision has a default, an owner document and a test.

| Layer | State | Evidence |
|---|---|---|
| Architecture, stack, hosting, cost | **Concrete.** One choice per concern, rejected alternatives written down, monthly cost per phase | A01, A08, B02; Supabase vs Railway vs self-host scored in A01 section 5.2 |
| Data model | **Executable.** 55 MVP tables (+7 full, +forex migration) as SQL that applies cleanly on PostgreSQL 16; 15 (MVP) and 17 (full) negative tests pass | `set-b/sql/`, A06, B03 |
| API and realtime contracts | **Concrete.** Every endpoint/event/error, with the MVP subset and the build week for each | A07, A02 section 4, B04 |
| SMC engine | **Specified to implementation level** (reducer, lifecycles, config defaults, a worked numeric example with a fixture). The *subjective* parts (order blocks, liquidity tolerances) are config plus a labeling test, not guesses | A04 including section 15.5, week 6 of B05 |
| Safety (human gate, zero retention, licence gating, guardrails) | **Enforced in the database where possible** (voice cannot confirm a gate; no image/audio column; licence view), then in code, then in tests | A04 section 11, A06, B04 section 7 |
| AI layer | **Specified at contract level**: jobs, schemas, validators, routing, budgets, evals. **Not included: final prompt text.** Prompts are written and tuned in weeks 12 to 15 against the eval sets, which is the only honest way to write them | A05, B05 |
| Plan and estimates | **Day by day** with a testable acceptance criterion per day. The 17 weeks are the best case; plan on about 21 (section 5) | B05, A10 |
| Frontend | **Out of scope** by your brief; the contracts are what it builds against | B04 section 8 |
| Legal | **Framework only.** I am not a lawyer; every item that needs one is tagged **[counsel]** and has a checklist | A09 |

### The five things documents cannot settle (each has a spike or gate)

| Unknown | Why a document cannot answer it | How the plan resolves it | When |
|---|---|---|---|
| OCR accuracy on chart screenshots, and speech accuracy on trading jargon, on your testers' devices | Needs measurement on real screenshots and recordings | Spikes S1, S3, S4 (one test page), thresholds and fallbacks written (manual picker, typed chat, server STT) | B05 week 1, gate G0 |
| Whether the free Oracle VM is obtainable, reachable by Binance/Bybit, and stable | Depends on Oracle capacity and venue IP policy on the day | Spikes S2, S7; fallback ladder (second region, a spare machine through the same Tunnel, then a paid VPS only with your approval) | Week 1 |
| Whether venues permit commercial display of derived analytics or raw prices | Needs reading the terms and getting written answers | Spike S5; default is `INTERNAL_ONLY`, so the product works either way (overlays and analysis, no raw prices) | Week 1 reading, answers by week 16 |
| How Supabase creates `auth.users` for Web3 sign-in without an email | Behaviour of a hosted service I cannot run from here | Week 9 day 1 check on a real project; fallback documented (about 2 days) | Week 9 |
| Whether the SMC definitions match *your* eyes | Subjective by nature | Labeling day and precision/recall report, gate G1; definitions are versioned config | Week 6 |

If you want one sentence: **the design is ready to build; the measurements that could change it are the first week of the build, not a surprise in month three.**

---

## 2. What was wrong or thin in v1

| # | v1 gap | Why it mattered | v2 fix |
|---|---|---|---|
| 1 | **Forex-first data design** relied on paid or quote-only licences (the v1 README itself flagged a possible $2k to $25k per month) | Violates your "pay only for Supabase and AI" rule and made public launch depend on a price I did not know | Crypto-first on free venue feeds with cross-checks; forex is a seam plus a tested dark migration (A03 section 2.4, B06 section 3) |
| 2 | **Paid or country-specific infrastructure**: Railway hosting, a merchant-of-record plus a local payment processor, LiveKit, a Nigerian-market framing | Same rule, plus "no country attachments" | Oracle free VM + Cloudflare free + Supabase; on-chain stablecoin billing with no processor; jurisdiction-neutral legal framing; zero country terms (checked, section 4) |
| 3 | **Vision on a timer** (about 60 model calls per hour) to read the chart context, with frames sent to a server | Cost, privacy, and in tension with "zero retention for frames" | On-device OCR sends text only; the vision model is used only inside Explain; one image per request, in memory, discarded |
| 4 | **Email-first identity**, no Sybil design | You want wallet-tied accounts with optional email; free accounts are cheap to farm | Wallet-first Supabase Web3 auth, `wallet_identities` mirror, step-up signatures, invite codes, Turnstile, hashed counters, tiny free budget, global daily AI cap |
| 5 | **Missing features and thin guarantees**: no voice, no Explain, instrument identity ignored spot vs perp, the licence class was a plain column, and the human-gate guarantee lived only in code | Your answers added voice and Explain; correctness needed spot/perp separation; "user always in control" should survive a bug | Voice (browser STT, glossary, forbidden-action rules), Explain (GROUNDED), instrument = (venue, market type, symbol), evidence-driven `instrument_license` view, database constraints on gate confirmation |

Also corrected: the v1 timeline was optimistic (14 weeks, with the engine in three weeks and no time for the new browser work); Mermaid diagrams were never rendered; the SQL had not been tested in an MVP-only configuration.

---

## 3. Requirement traceability

| # | Requirement (source) | Satisfied by | Verified by |
|---|---|---|---|
| R1 | Planning only; no application code (brief) | All documents; SQL is schema and tests only | Review: no service code in the folder |
| R2 | Two separate sets: A01 to A10, B01 to B06 (brief; you liked the structure) | `set-a/`, `set-b/` | File listing; README |
| R3 | TypeScript / NestJS monorepo (brief) | A01 section 6, B02 section 3 | |
| R4 | Choose one of Supabase or MongoDB (brief) | A01 section 5.1 (Supabase) | |
| R5 | Redis only if justified (brief) | A01 section 5.5; MVP has none; Valkey on the VM at M6 | |
| R6 | User always in control; no autonomous trading (brief) | A04 section 11; gate token; DB constraints `confirmed_via='UI_TAP'`, life at most 120 s | Smoke test: voice-confirmed gate fails; B04 section 7 |
| R7 | Probabilistic scenarios with invalidation and confidence, never certainty (brief) | A04 sections 8.4 and 10.2; A05 section 6; plan schema requires invalidation and an alternate scenario | Smoke test and B05 W7/W8 criteria |
| R8 | Tables, code blocks, Mermaid; assumptions, open questions, rejected alternatives, tags (brief) | Every document (section 4 shows the per-document check) | Script and grep |
| R9 | Pay only for Supabase and AI models (v2) | A01 section 1.2; A08 sections 1 and 8; B02 sections 0, 7 and 8 | Paid-term scan (section 4): paid vendors appear only as rejected alternatives or in the future-forex notes |
| R10 | Best free/open-source projects, data and services (v2) | A01 section 4; A03 section 2; A02 sections 3 and 6; A08 | |
| R11 | Supabase vs Railway Postgres comparison, recommend one (v2) | A01 section 5.2 (scored 102 / 74 / 51 / 53), B02 section 8 | Recommendation: hosted Supabase |
| R12 | Crypto-first public launch, forex later (v2) | A03 sections 2 and 2.4; A10 M10-B; B06 section 3; `0011_forex_enable.sql` | Migration applies cleanly and is idempotent; FX rows are `INTERNAL_ONLY` and inactive |
| R13 | International; nothing Nigerian; no country attachments (v2) | A09 (jurisdiction-neutral); all pricing in USD and stablecoins | Zero hits for country and local-processor terms |
| R14 | Voice interaction with good open-source speech-to-text, nothing paid (v2) | A02 section 6; A05 section 14.4; B01 section 3.5; B05 weeks 15 and 1 (spike S3) | Planned evals: 200 phrases, no-audio-on-the-wire test |
| R15 | Zero retention for screen frames (v2) | A02 section 3.5; A06 sections 1 and 10; no image/frame/audio column in the schema; `no-frame-persistence` CI test | Smoke test lists any suspicious column name: none outside the allow-list |
| R16 | "Explain this chart", with screen sharing supported (v2) | A02 sections 3.3 to 3.6; A05 section 8.3; A07 section 6.1; B04 section 4.2; B05 week 14 | Planned eval set of 50 charts |
| R17 | Auth tied to the wallet; email supported but never required (v2) | A06 section 3; A07 section 3; `0001_identity.sql`; B01 section 3.3; B05 week 9 | Smoke test: wallet-only account bootstraps with NULL email |
| R18 | Voice and chat both (v2) | A05 section 7; A02 section 6.5; B04 | |
| R19 | Re-analyse and give the best again (v2) | This audit; the changes in section 6 | |

---

## 4. Checks run (rerun at the end, after the last edit)

| Check | Method | Result |
|---|---|---|
| SQL, full schema | Fresh PG16 database, `apply.sh --with-shims --with-upgrade`, then `tests/b03_smoke_test.sql` | Applies cleanly; **17 of 17** expected failures fired; no unexpected error |
| SQL, MVP only | Same without `--with-upgrade` (the billing section is skipped when `invoices` does not exist) | Applies cleanly; **15 of 15** expected failures fired; no unexpected error |
| Forex migration | Applied on top of the full schema, twice | Clean and idempotent; 2 example FX instruments, both `INTERNAL_ONLY` through `instrument_license`, both inactive; venue disabled |
| Table counts | `pg_class`, partition children excluded | 55 MVP tables; 62 with `0010` |
| Invite grants | New smoke-test block | Redeemer's AI budget becomes $1.00/day; a non-redeemer stays at $0.05/day |
| Doc/SQL drift | A06 and B03 are generated from the SQL files by script | Regenerated after the last SQL change |
| Section cross-references | Script over all 16 documents: every "A0X section N" and own-document "section N" resolved against real headings | **428 references checked; 0 broken** (1 false positive in a list phrase) |
| Mermaid | All **23** diagrams rendered with mermaid-cli in headless Chromium | 2 failed at first (a quote in a node label; a semicolon in a sequence message), both fixed; **23 of 23 render** |
| Calendar | B05 week headers parsed | All 17 weeks run Monday to Friday; Dec 21 to Jan 1 skipped; W17 = Feb 22 to 26, 2027 |
| Cost arithmetic | Recomputed B02 section 7 and A08 section 8 | Closed beta $91 to $141 per month; 100 users $197 to $318 (B02, includes $20 to $40 of evals) vs $177 to $278 (A08, excludes them) |
| Effort arithmetic | A10 table and section 1.1 | M0 to M5: 20.5 person-weeks; cuts 4.5; MVP 16 build weeks; plus 1 beta/buffer week = 17 |
| Country terms | Case-insensitive scan of all docs and SQL | No country or local-processor terms |
| Paid-vendor terms | Same scan | Paid vendors appear only in rejected-alternative tables, the Supabase/Railway comparison, and future-forex research notes |
| Required sections per document | Script over headings | Every document has assumptions and open questions; A02 and A09 were missing an assumptions list and a rejected-alternatives section, now added |

### What I could not check

- **Anything on Supabase itself** (real roles, PostgREST, pooler modes, Web3 `auth.users` rows, `pg_cron`). Local PG16 plus shims only.
- **Any live vendor page.** Prices, limits and terms come from search results dated 2026-10-10; the **[verify]** tags mark which ones need a primary-source check.
- **Browser behaviour** (WebGPU, OCR/STT speed and accuracy). The spikes exist for exactly this.
- **Legal conclusions.** Not a lawyer; **[counsel]** marks every place that needs one.
- **The engine on real data.** The specification has a worked example and a fixture; real fidelity is measured at gate G1.

---

## 5. How long will it really take?

| View | Duration | Closed-beta date |
|---|---|---|
| Best case (B05 as written) | 17 weeks (16 build + 1 beta/buffer) | about 2027-02-22 to 02-26 |
| With 25% contingency (recommended planning figure) | about 21 weeks | late March 2027 |
| Full Set A scope to the same gate (A10 M0 to M5) | 20.5 person-weeks likely, 16 to 29.5 range | later; Set B cuts 4.5 weeks (A10 section 1.1) |
| To public launch (A10 M0 to M6) | 26 person-weeks likely | about 6.5 to 8 months of calendar time from the start |

Where the weeks go: the new browser work (OCR, voice, Explain) is three of the sixteen weeks and is where estimates are least certain. The cut list (B06 section 4) lists, in order, what to drop if you slip; voice is last because you asked for it.

---

## 6. What the recheck changed (beyond the v2 rewrite)

| Change | Why |
|---|---|
| Invite codes now carry `grants`; redeeming merges them into the redeemer's entitlements (default AI budget $1.00/day) | Without it every invited tester had the public free budget of $0.05/day, about 15 minutes of use per day. Found while checking the beta cost numbers; new test added |
| MVP seed turns OKX/Coinbase/Kraken cross-checks, `voice.server_stt` and `explain.approximate` off | The MVP scope cuts them; the seed now matches the documents |
| Smoke test skips the billing section when `0010` is absent | So the MVP schema can be verified on its own |
| `0011_forex_enable.sql` added and tested; `apply.sh --with-forex` | Makes "forex later" a concrete first step instead of a promise |
| A10 spike time-boxes tightened so M0 fits 1.5 weeks; B05 week 1 shows the one-day-per-spike plan | The first draft listed about 10 days of spikes inside 7.5 days |
| L1 is M7 everywhere (A07, A09 said M9); A04 uses exchange/on-chain read-only naming; A01 reference V5 became V7; A02 resume wording matches `session.start { lastSeq }`; `capture-kit` added to the monorepo layout | Cross-document consistency |
| Two Mermaid syntax errors fixed | Found only by rendering |

---

## 7. Assumptions

1. Start date 2026-10-19, one developer, about 30 focused hours per week.
2. You will read the **[verify]** and **[counsel]** items before relying on them.
3. A frontend will be built against B04; none is planned here.

## 8. Open questions

1. **Operator jurisdiction and legal entity.** Default: undecided; the plan stays neutral (A09).
2. **Acceptable date risk.** Default: plan for the 21-week figure and treat 17 as best case.
3. **Paid fallback for the free VM.** Default: none assumed; the first paid step needs your approval.
