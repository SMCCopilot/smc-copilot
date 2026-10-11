# B01: MVP Scope

**Set:** B (shippable MVP) | **Status:** Planning document, v2.0, 2026-10-10
**Relationship to Set A:** The MVP is a strict subset of the Set A design. Nothing here contradicts A01 to A10; where the MVP simplifies something, the Set A seam (interface, table, event, flag) is still built so that B06's upgrade path is configuration and additive work, not a rewrite.
**Read with:** B02 (stack and cost), B03 (schema), B04 (API/events), B05 (build plan), B06 (upgrade path).

> **Decisions this scope encodes (from your answers).** Crypto first, built so forex can be added later. International users, nothing country-specific. Wallet-first identity; email optional. Voice and chat both, with speech-to-text done by open-source models in the browser. "Explain this chart" included, with screen sharing and image upload. Zero retention of screen frames. Only Supabase and AI models cost money.

---

## 1. What the MVP must prove

An MVP is a bundle of **hypotheses to test cheaply**, not a smaller product. It exists to answer these, in this order:

| # | Hypothesis | How the MVP tests it | Evidence that it holds |
|---|---|---|---|
| H1 | **Engine fidelity:** a deterministic engine produces SMC structure and zones that experienced SMC traders agree with | Detector agreement vs hand-labeled charts (A04 section 15.4); overlay thumbs from beta users | At least 90% agreement on swings/BOS/CHoCH, 95% FVG, 70% OB on the labeled sample; overlay thumbs-up rate at least 70% |
| H2 | **Hybrid context works:** on-device OCR plus the manual picker gives the right instrument and timeframe with little friction | OCR lock accuracy; manual-picker fallback rate; time to first useful overlay | Symbol and timeframe correct at least 90% when OCR is used (or users happily use the picker); median time to first overlay under 20 s |
| H3 | **Explanations add value:** traders value plain-language, grounded explanations, "Explain this chart" and the "why not" reasons, not only overlays | Narrative thumbs, chat usage, Explain usage, journal usage | At least 60% of weekly active testers open an explanation, run Explain or ask a question; thumbs-up at least 70% |
| H4 | **Honesty is acceptable:** users accept "scenario + invalidation + base rate (or 'not enough history')" instead of confident calls | Interviews; feedback on `INSUFFICIENT_HISTORY` | Fewer than 25% of interviewees say the missing certainty makes it useless |
| H5 | **Unit economics:** AI cost per session-hour is near the A05 model | `ai_calls` aggregates | Measured cost per session-hour at most 1.5x the $0.20 to $0.25 estimate |
| H6 | **Retention and intent:** testers return and would pay (in stablecoin, no card) | D7/D30 return, short survey | At least 30% of activated testers have 3+ sessions in 2 weeks; at least 25% say "definitely would pay" at a stated price |
| H7 | **Voice is worth having:** testers use speech, and on-device transcription is accurate enough | `voice_events` aggregates, glossary-corrected command accuracy, typed-correction rate | At least 25% of weekly active testers use voice at least 5 times; transcripts corrected by the user in under 15% of utterances |
| H8 | **Wallet-first sign-up is workable:** testers can sign in with a wallet and do not need an email | Sign-up funnel from `profiles`, `wallet_identities`, email-link rate | At least 85% of invited testers complete wallet sign-in without operator help; no feature requires email |
| H9 (informational) | **Is there any measurable statistical edge** in the v1 templates? | Shadow outcomes + backtest cohorts | Not a launch criterion. Reported honestly either way (A04 section 8.4). "No edge detected" changes positioning, not the MVP's success on H1 to H8 |

The thresholds are starting targets, adjusted at the first review; the point is to decide *in advance* what would count as success.

---

## 2. Target users and primary use case

- **Primary:** discretionary crypto traders who already use SMC/ICT-style concepts, chart in TradingView (or an exchange chart) on desktop, and are comfortable with a wallet. Beta size: 20 to 50 invited testers, worldwide.
- **Use case:** "I'm watching BTC on my chart. Show me what the structure says, where the zones and liquidity are, whether a setup meets my rules, and let me ask why, by typing or speaking. If I'm unsure about a chart, let me hand it over and have it explained. After the trade, help me journal it honestly."
- **Out of target for MVP:** beginners with no SMC knowledge (the glossary helps, but education is not the MVP), institutional users, mobile-first users, forex traders (supported later).

---

## 3. In scope

### 3.1 Markets and data

| Item | MVP |
|---|---|
| Instruments | Binance **spot and USD-M perpetual** for **BTCUSDT, ETHUSDT, SOLUSDT** (6 instruments). Spot and perp are separate series. Bybit perpetuals for BTC and ETH exist as cross-check series |
| Timeframes | Base 1m (ingested); derived 5m, 15m, 1h, 4h, 1d (00:00 UTC rollover) |
| Venues | **Binance** (analysis venue) + **Bybit** (cross-check, same market type). `replay` adapter for tests and demos. OKX, Coinbase, Kraken rows are seeded but disabled; their adapters arrive in M6 |
| Data safeguards | Validation V1 to V9 (including V7 same-market-type cross-check), quarantine, gap detection and backfill, stale detection, nightly HTF reconcile (basic) |
| Licensing posture | Every instrument defaults to `INTERNAL_ONLY` until a `venue_terms` evidence row exists. The view `instrument_license` is the only thing egress code reads. **Unconfirmed venues mean overlays and analysis only, no raw price ticks or candles to the browser**; the product still works because users chart on their own platform |
| Forex | Not enabled. The seam exists (`FX_STUB` venue disabled, generic calendar table, `asset_class` column) and returns `NOT_ENABLED` (B06 section 3) |

### 3.2 Engine and setups

| Item | MVP |
|---|---|
| Engine | Swings (internal/external), BOS/CHoCH (close-based), FVG lifecycle, order blocks, EQH/EQL, session and previous-day/week highs/lows, daily/weekly/monthly opens, sweeps, premium/discount + OTE, MTF bias, UTC-fixed sessions, weekend liquidity weighting |
| Setups | **T1 Sweep-CHoCH-Retest** and **T2 BOS-Pullback-to-POI** |
| Scoring | Hard filters with reason codes (including `LIQUIDATION_BEFORE_STOP`), soft features, grade A/B/C |
| Plan | Entry zone, stop, TP1/TP2 from liquidity, primary + alternate scenario, invalidation, 5 bps taker fee in net R |
| Probability | Base rates from backtest and live shadow; shown only when n >= 30, else "not enough history" |
| Outcomes | Shadow outcomes for every ARMED setup (pessimistic intrabar rule); nightly cohort stats (Wilson/Beta) |
| Strategy | One immutable `strategy_versions` row (`smc-core v1`), rule statuses `HYPOTHESIS` |

### 3.3 Identity and access

| Item | MVP |
|---|---|
| Sign-in | **Wallet-first** through Supabase Auth Web3: Ethereum (EIP-4361) and Solana. The account is tied to the wallet used; no email is required, ever |
| Optional email | Link or unlink an email to an existing account for recovery and optional notifications. Nothing is gated on it |
| Wallet management | Link a second wallet, choose a primary, unlink (never the last login method). Linking and unlinking need a **fresh signature** (step-up, within 5 minutes) |
| Gates | Invite code (closed beta), disclaimer acceptance with version, 18+ self-attestation, sanctions/abuse address blocklist |
| Abuse resistance | Turnstile on sign-up, hashed per-IP/device counters, tiny free AI budget, **global daily AI cap**, invite codes (A08 section 2.3) |
| Entitlements | `entitlements` table; invited testers get a raised daily AI budget through the invite code's `grants` |
| Payments | None in the MVP |

### 3.4 Session experience (API/WebSocket only; the frontend is separate)

| Item | MVP |
|---|---|
| Session | Create/pause/end, resume with `session.start { lastSeq }`, single controller rule |
| Context | **Manual symbol/timeframe picker (always works)** + **on-device OCR** assist (PaddleOCR in the browser) sending **text-only** `context.hint`s, reconciled against the feed price with `FEED_MISMATCH` |
| Live updates | `analysis.update` diffs, `setup.event`, `feed.status`, `warning`, `narrative.done`, chat streaming |
| Capture | Client-side screen sampler, ROI crop, diff gating. **No frame leaves the device** except in Explain |

### 3.5 AI, voice and Explain

| Item | MVP |
|---|---|
| Narrative | Event-driven, shared per (instrument, facts hash), strong text model, fully validated, template fallback |
| Chat | Cheap router model + stronger answering model, streaming, capped per day, typed or spoken |
| **Voice** | Push-to-talk (default), Silero VAD, **Whisper in the browser (WebGPU) with Moonshine/Whisper-WASM fallback**, glossary correction for symbols and SMC terms, command grammar, transcript always visible and editable. **Audio never leaves the device and is never stored.** Voice can never confirm a gate, log a trade, change risk, delete data or pay |
| **Explain this chart** | `SHARE` (current frame of the shared window) and `UPLOAD` (paste/drop/pick an image). One-shot `POST /v1/explain` over SSE. **GROUNDED** mode for supported instruments (engine facts + image read, writer never sees pixels). Image is processed in memory and discarded |
| Guardrails | Grounded refs, number scan, lexicon filter, seed-phrase detector, retraction, kill switches, per-user daily budget, global daily cap |
| Evals | OCR (about 100 crops), speech (200 phrases), narrative (about 100 fixtures), Explain (about 50 charts), chat red-team (about 100 prompts), run in CI on a schedule |

### 3.6 Human-in-the-loop and journal

| Item | MVP |
|---|---|
| Gate | Full gate flow (token, plan hash, 60 s expiry, REST-only, UI tap only) for **L0 manual trade logging**. Enforced by DB constraints as well as code |
| Trades | Manual log (entry, stop, targets, leverage, fees), update record, close, realized R |
| Position monitor | In-app events (near stop/target, TP/SL hit, thesis degraded, invalidated, stale, liquidation risk) |
| Journal | Auto entries (setups shown, rejected, gate decisions, trades, Explain answers) + notes + tags |
| Risk | `PUT /risk-profile`, `POST /risk/size` preview (illustrative arithmetic, with leverage and liquidation distance) |

### 3.7 Platform

| Item | MVP |
|---|---|
| Observability | Pino logs, Sentry free, Grafana Cloud free, a status endpoint, Upptime page if time allows (else M6) |
| Admin | Minimal admin API: kill switches, flags, strategy version activate, feed status, venue terms, blocklist, AI cap, invites; Supabase Studio for data |
| Ops | One Docker Compose project on the Oracle free VM (api+worker in one Nest app), Supabase Free while building and Pro from the beta, daily encrypted `pg_dump` to R2 |

---

## 4. Explicitly out of scope (with where it returns)

| Out of MVP | Why cut | Returns in (A10) |
|---|---|---|
| Valkey, BullMQ, Socket.IO adapter, multi-worker leases | A single process is enough for tens of testers; `pg-boss` and the in-memory bus sit behind interfaces | M6 |
| Split `api`/`worker` processes | Not needed below about 100 concurrent sessions | M6 |
| OKX, Coinbase, Kraken adapters | One cross-check venue (Bybit) is enough to prove the validation design | M6 |
| Server-side speech-to-text (Tier 2 sidecar), hands-free voice mode | Tier 1 in the browser is the privacy-preserving default; Tier 2 is needed only if testers' devices fail | M6 (earlier if spike S3 fails) |
| Explain APPROXIMATE mode (instrument with no feed) | Needs extra UX and risk language; supported-instrument GROUNDED mode tests the idea | M6/M8 |
| Spoken replies (TTS) | Text replies are enough to test voice input | M10 |
| Billing, plans, invoices, chain watcher | No payments in a free beta; tables are in `upgrade/0010` | M6 |
| Verified-human Sybil step, full admin console | Invite codes and daily caps suffice for 50 testers | M6 |
| Forex (data, calendar, templates, display) | Crypto first; needs a licence decision | M10 |
| Bring-your-own-feed, exchange read-only keys (L1), wallet-linked position monitoring, order routing (L2) | Credentials and regulation | M7 / M9 |
| Backtest UI, parameter sweeps, calibration dashboards, labeling tool | CLI + SQL are enough to answer H1/H9 | M8 |
| Weekly AI review, journal export, email notifications | Nice-to-have | M6 / M8 |
| T3 template, breaker blocks, news filter, additional languages (UI and voice glossary) | Scope control | M8 |
| Team workspaces, sharing, public profiles | | later |
| Equities/indices | Licensing cost | later |
| PITR backups, read replicas, formal k6 load programme (smoke script only) | | M6 |
| Mobile support | Desktop Chromium first | later |

---

## 5. Key user stories and acceptance criteria

Stories are written from the API consumer's point of view (the frontend), because the backend is the deliverable. Build weeks refer to B05.

| ID | Story | Acceptance criteria | Built in |
|---|---|---|---|
| U1 | As a new tester I sign in with my wallet (Ethereum or Solana), redeem an invite code, and accept the disclaimer and the 18+ confirmation before anything else | Invalid/used code rejected; `INVITE_REQUIRED`, `DISCLAIMER_REQUIRED`, `AGE_CONFIRMATION_REQUIRED` on feature endpoints until satisfied; acceptance recorded with version and time; a wallet-only account works end to end | W9 |
| U2 | I can link a second wallet, choose my primary one, and optionally add an email, without losing my history | `POST /v1/me/wallets` mirrors the identity from my JWT, never from a body address; adding/removing email never changes `user.id`; unlinking the last login method returns `LAST_LOGIN_METHOD`; sensitive actions need a fresh signature (`STEP_UP_REQUIRED`) | W9 |
| U3 | I pick BTCUSDT perpetual / 15m and instantly see the latest analysis | `POST /v1/sessions` returns `initial` analysis within 500 ms p95 (cache/DB); no OCR or AI needed | W10 |
| U4 | I share my chart and the system detects my symbol and timeframe from text read on my own device | Within 2 accepted hints the context locks, or `LOW_OCR_CONFIDENCE`/`FEED_MISMATCH` is sent with the nearest candidate; manual picker always overrides; **no pixels are sent** (network capture test) | W14 |
| U5 | I see structure, zones, liquidity, bias on my instrument and they update when a candle closes | `analysis.update` diff within 500 ms p95 of the venue's candle close; ids stable across updates; spot and perp are never mixed | W11 |
| U6 | I see a setup with grade, reason codes (if rejected), plan, invalidation, alternate scenario | Schema-enforced; plans without invalidation/alternate are impossible; a `LIQUIDATION_BEFORE_STOP` warning appears when leverage makes the stop unreachable | W10 |
| U7 | I read what history says about similar setups, or that there is not enough | `historical` present only if n >= 30; includes n, CI, source, window, "not a forecast" key | W10 |
| U8 | I ask "why is this a bearish setup?" and get a grounded answer | Chat answer references only ids in facts; no price literals outside placeholders; includes alternate scenario and invalidation | W13 |
| U9 | I ask "should I buy?" | Response states what the engine shows and that the decision is mine; no imperative; scope flagged `PERSONAL_ADVICE_REQUEST` | W13 |
| U10 | I hold a key and speak a question; I see my transcript and can fix it before or after it is sent | Transcript produced on-device; glossary fixes "bee tee see" to BTC; the message is sent as `inputMode:'voice'` with engine tag and confidence; no audio bytes reach the server (network capture test); spoken "confirm the trade" returns `VOICE_FORBIDDEN_ACTION` | W15 |
| U11 | I ask Explain about a chart (shared window or an uploaded image) | `POST /v1/explain` streams stages then an answer; every number traces to engine facts or a placeholder; the writer stage never receives pixels; the image is not stored anywhere (schema + runtime test); unsupported chart returns a clear message instead of a guess | W14 |
| U12 | I log a trade from a plan | Requires a CONFIRMED gate created by a UI tap on REST; stale/changed plan blocks with an explicit error; nothing is sent to any exchange or wallet | W11 |
| U13 | I get in-app alerts while a logged trade approaches stop/target or the thesis degrades | `position.event` and `notification` delivered, with `seq` replay after reconnect | W11 |
| U14 | I review my journal, including rejected setups and why | `GET /v1/journal` lists entries with reason codes and plan snapshots | W11 |
| U15 | When data is stale or the AI is down, I am told, and nothing misleading is shown | Overlays grey with "as of"; no new setups; template text replaces narrative; banners via `warning`; a cross-check venue disagreement shows `DEGRADED` not silence | W3, W12 |
| U16 | I can delete my account and data | `DELETE /v1/me` (needs a fresh wallet signature) starts the deletion job; journal, chat, trades and wallet mirror rows are deleted within 30 days | W16 |
| U17 | As the operator I can switch AI, Explain, voice-related AI, chat and sign-up off instantly | Admin kill switch effective in under 10 s without redeploy | W12 |
| U18 | As the operator I cannot be bankrupted by free accounts | Global daily AI cap trips the kill switch automatically; per-user budgets hold; Turnstile and the invite code gate sign-up | W12 |

---

## 6. Definition of done for the MVP (closed-beta gate G3)

The MVP is done when **all** of the following are true:

1. All acceptance criteria for the A10 gates G0 to G3 are met for the MVP scope (A10 section 3, with the cuts in A10 section 1.1).
2. 72-hour soak on the six Binance instruments (plus Bybit cross-check) with no duplicate or unexplained-gap candles; nightly determinism check green for 7 consecutive days.
3. Cross-tenant tests, gate invariant tests (including "voice cannot confirm" at the API and database level), licence-guard tests, and the no-frame/no-audio persistence tests are green in CI.
4. AI evals meet A05 thresholds; with the kill switch on, a session still functions (overlays, plans, stats, template text).
5. OCR and speech meet the spike thresholds on the reference devices, or the manual picker/typed chat are the declared primary paths.
6. Measured AI cost per session-hour within 1.5x of estimate.
7. Legal prerequisites for beta done: disclaimer flow, ToS/Privacy drafts, age gate, sanctions blocklist loaded, lawyer scoping call held, venue-terms evidence recorded for every instrument (A09 section 9).
8. Runbooks for feed outage, AI outage, VM loss, rollback exist; Sentry and alerts configured; backup restore tested once.
9. Written beta plan: who, how many, what to ask, how feedback is collected (section 7).

---

## 7. Beta plan and metrics

| Item | Plan |
|---|---|
| Cohort | 20 to 50 invited SMC traders (communities you know; invite codes handed out manually; no email needed) |
| Duration | 4 weeks, weekly check-in call or form |
| Instrumentation | Events: session start/end, context lock method (OCR/manual), overlay thumbs, narrative thumbs, chat messages (typed/voice), Explain runs, gate issued/confirmed/declined, trade logged, journal notes, errors. Stored in existing tables plus `user_feedback` |
| Weekly review | One 30-minute review: H1 to H8 dashboard (SQL queries committed in the repo), top bugs, top confusions |
| Interview script | 5 questions: what did you trust, what did you ignore, what was wrong, what would you pay for, what made you stop |
| Safety | Weekly sample of narratives/chats reviewed by you with tester consent; red-team additions |
| Exit decision | After 4 weeks: continue to M6 (public path), pivot (for example journaling-first), or stop. Decision rules written before the beta starts |

---

## 8. Assumptions

1. 20 to 50 testers, up to about 10 concurrent sessions; the single free VM is enough.
2. Binance and Bybit public market data may be used for derived analytics in a free beta (to be recorded in writing in `venue_terms`, spike S5); if not confirmed, instruments stay `INTERNAL_ONLY`, which the product tolerates.
3. Testers use a recent desktop Chromium-based browser; OCR and speech run locally (WebGPU where available).
4. You (or a collaborator) build a thin frontend on the contracts from B04; the backend ships a small HTML test client for development.
5. Testers hold an Ethereum or Solana wallet. Email sign-in exists only as an optional link to an existing account.

## 9. Open questions (defaults used)

1. **Which venue is "the" chart venue for testers?** Default: Binance spot and perp. If most testers chart elsewhere (Bybit, Coinbase), promote that venue to an analysis venue (venue row flag plus M6 adapter work).
2. **Explain for unsupported charts in the beta?** Default: not supported (APPROXIMATE mode is off); the user gets a clear "not available for this market yet" message.
3. **Chat in the MVP?** Default: yes, capped (A05 open question 1).
4. **Beta invite mechanism:** codes in `invite_codes` (B03) with manual issuance. Alternative: allowlist by wallet address.
5. **Should hands-free voice be tested in the beta?** Default: no; push-to-talk only.
