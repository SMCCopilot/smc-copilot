# B04: MVP API and Events

**Set:** B (shippable MVP) | **Status:** Planning document, v2.0, 2026-10-10
**Relationship to Set A:** This is the **MVP subset of A07 (REST) and A02 section 4 (WebSocket)**. Shapes are identical to Set A, so the generated OpenAPI/TypeScript client does not change when the full product ships; this document says *which* endpoints and events exist in the MVP, in *which build week* (B05), which user story (B01) each serves, and what is deliberately absent.
**Read with:** A07 (full contract and TypeScript shapes), A02 section 4 (envelope and events), B01 (stories), B03 (tables), B05 (weeks).

> Types are Zod-first in `packages/contracts`; OpenAPI is generated from them. Where this document and A07 disagree, **A07 wins** for shapes and this document wins for *what is in the MVP*.

---

## 1. Conventions (unchanged from A07 section 1)

Base URL `https://api.<domain>/v1`; auth by Supabase JWT from **wallet sign-in** (Ethereum or Solana, EIP-4361 style) or a linked email; WebSocket uses a 5-minute `wsToken`; times are ISO-8601 UTC on REST and epoch ms on the socket; prices are JSON numbers at instrument precision; token amounts (not in MVP) would be strings; errors are `application/problem+json`; cursor pagination; `Idempotency-Key` required on side-effecting POSTs; `X-Correlation-Id` always returned; ETag on analysis reads; additive-only changes within `v1`; unknown fields ignored by clients.

**Access classes in the MVP:** `PUBLIC`, `USER*` (valid JWT; works before invite/disclaimer), `USER` (valid JWT + invite redeemed + disclaimer accepted + age confirmed), `USER+FEATURE:<flag>`, `ADMIN` (role claim + IP allowlist + second header + audit log).

**Step-up:** unlink wallet, add a wallet, delete account require a JWT issued within the last 5 minutes; otherwise `401 STEP_UP_REQUIRED` and the client repeats the wallet signature.

---

## 2. REST endpoints in the MVP

"Wk" is the B05 week in which the endpoint ships; "Story" is the B01 user story it serves.

| Area | Method and path | Class | Wk | Story |
|---|---|---|---|---|
| Health | `GET /healthz`, `GET /readyz` | PUBLIC | 1 | |
| Status | `GET /v1/status` | PUBLIC | 3 | U15 |
| Me | `GET /v1/me` (bootstrap, wallet mirror upsert, blocklist check) | USER* | 9 | U1 |
| | `PATCH /v1/me` (locale, timezone, display name) | USER* | 9 | |
| | `POST /v1/me/invite` (Turnstile header) | USER* | 9 | U1 |
| | `POST /v1/me/disclaimer`, `POST /v1/me/age-confirmation` | USER* | 9 | U1 |
| | `DELETE /v1/me` (step-up) | USER | 16 | U16 |
| Wallets | `GET /v1/me/wallets` | USER | 9 | U2 |
| | `POST /v1/me/wallets` (step-up; no address in body) | USER | 9 | U2 |
| | `POST /v1/me/wallets/{id}/primary` | USER | 9 | U2 |
| | `DELETE /v1/me/wallets/{id}` (step-up; `LAST_LOGIN_METHOD`) | USER | 9 | U2 |
| Email | `GET /v1/me/email` (`{ linked, verified }` only) | USER | 9 | U2 |
| Markets | `GET /v1/venues` | USER | 10 | U3 |
| | `GET /v1/instruments`, `GET /v1/instruments/resolve`, `GET /v1/instruments/{id}`, `GET /v1/instruments/{id}/status` | USER | 3, 10 | U3, U4 |
| | `GET /v1/instruments/{id}/candles` (always registered; returns `403 FEED_LICENSE_RESTRICTED` unless the `instrument_license` view says `DISPLAY_OK`) | USER | 10 | |
| Analysis | `GET /v1/instruments/{id}/analysis`, `GET /v1/instruments/{id}/analysis/events` | USER | 10 | U5 |
| Setups | `GET /v1/setups`, `GET /v1/setups/{id}`, `GET /v1/setups/{id}/history`, `GET /v1/setups/rejected` | USER | 10 | U6 |
| Stats | `GET /v1/stats/cohorts` | USER | 10 | U7 |
| Sessions | `POST /v1/sessions`, `GET /v1/sessions`, `GET /v1/sessions/{id}`, `POST /v1/sessions/{id}/ws-token`, `POST /v1/sessions/{id}/end` | USER | 10 | U3 |
| Explain | `POST /v1/explain` (multipart, SSE response) | USER+FEATURE:explain | 14 | U11 |
| | `GET /v1/explain`, `GET /v1/explain/{id}`, `DELETE /v1/explain/{id}` | USER | 14 | U11 |
| Voice | `GET /v1/voice/config`, `GET /v1/voice/glossary` | USER+FEATURE:voice | 15 | U10 |
| Risk | `GET/PUT /v1/risk-profile`, `POST /v1/risk/size` | USER | 10 | U6 |
| Gate | `POST /v1/plans/{planId}/gate`, `POST /v1/gates/{gateId}/confirm`, `POST /v1/gates/{gateId}/decline` | USER | 11 | U12 |
| Trades | `POST /v1/trades`, `GET /v1/trades`, `GET /v1/trades/{id}`, `PATCH /v1/trades/{id}`, `POST /v1/trades/{id}/close`, `GET /v1/trades/{id}/events` | USER | 11 | U12, U13 |
| Journal | `GET/POST /v1/journal`, `GET/PATCH/DELETE /v1/journal/{id}`, `GET /v1/journal/summary` | USER | 11 | U14 |
| Chat | `GET /v1/chat/threads`, `GET /v1/chat/threads/{id}/messages`, `DELETE /v1/chat/threads/{id}`, `POST /v1/chat/threads/{id}/messages` (SSE fallback) | USER | 13 | U8, U9 |
| Feedback | `POST /v1/feedback` | USER | 11 | H1, H3 |
| Notifications | `GET /v1/notifications`, `POST /v1/notifications/{id}/read`, `GET/PUT /v1/notification-prefs` (in-app channel only) | USER | 11 | U13 |
| Admin | `GET /v1/admin/feeds`, `GET /v1/admin/dq-incidents`, `POST /v1/admin/dq-incidents/{id}/close` | ADMIN | 3, 16 | U15 |
| | `POST /v1/admin/venues/{id}/terms`, `PATCH /v1/admin/venues/{id}` | ADMIN | 2 | |
| | `POST /v1/admin/strategy-versions`, `POST /v1/admin/strategy-versions/{id}/activate` | ADMIN | 6 | |
| | `GET /v1/admin/ai-costs`, `GET /v1/admin/ai-spend`, `PUT /v1/admin/ai-spend/cap` | ADMIN | 12 | U18 |
| | `POST /v1/admin/flags/{key}`, `POST /v1/admin/kill-switch` | ADMIN | 12 | U17 |
| | `POST /v1/admin/blocklist/import`, `POST /v1/admin/blocklist` | ADMIN | 9 | |
| | `GET /v1/admin/users/{id}`, `POST /v1/admin/users/{id}/entitlements`, `POST /v1/admin/users/{id}/block` | ADMIN | 9 | |
| | `POST /v1/admin/invites` | ADMIN | 9 | U1 |

### 2.1 Present in A07 but **not** in the MVP

| A07 item | MVP behaviour | Returns |
|---|---|---|
| `/v1/billing/*`, `/v1/admin/invoices*` | Routes not registered (404). Flag `payments.enabled` is off. Tables are in `upgrade/0010` | M6 |
| `/v1/exchange-connections` | Not registered. `entitlements.features.exchange_readonly` is false | M7 |
| `POST /v1/journal/export` | Not registered; `DELETE /v1/me` and `GET /v1/journal` cover the MVP | M6 |
| `/v1/admin/instruments`, `/v1/admin/backtests*`, `/v1/admin/calibration`, `/v1/admin/cohorts/*` | Use SQL, seeds and the backtest CLI | M8 |
| Email notification channel | The channel can be selected only when an email is linked, and the MVP sends no email | M6 |
| Explain `mode: 'APPROXIMATE'` | Flag `explain.approximate` is off; an unsupported instrument returns an `ApiProblem` with code `INSTRUMENT_NOT_ENTITLED` and a human message | M6/M8 |
| Voice `tiers` with `kind:'SERVER'` | `GET /v1/voice/config` lists browser tiers only; `server.available=false` | M6 |
| Forex instruments | `assetClass:'FX'` is never returned | M10 |
| `venues` OKX/Coinbase/Kraken | Returned with `status:'DOWN'`, `analysis:false` only if `?includeDisabled=true`; otherwise omitted | M6 |

---

## 3. WebSocket events in the MVP

Envelope, auth and ordering are exactly A02 section 4 (`seq`, `type`, `at`, `correlationId`, `payload`; Socket.IO v4, WebSocket-only transport, namespace `/ws`).

**Client to server**

| Event | In MVP | Notes |
|---|---|---|
| `session.start` (first connect and resume via `lastSeq`), `session.pause`, `session.end` | Yes | One controller per session (`SESSION_CONTROLLER_TAKEN` otherwise) |
| `context.set` (manual), `context.hint` (text-only `OcrContext`) | Yes | Hint rate limit: 1 accepted per 2 s; resolved only after 2 agreeing hints or 1 hint with confidence at least 0.9 and a price inside tolerance |
| `explain.request`, `explain.cancel` | Yes | Same service as `POST /v1/explain`; bytes are in memory only |
| `chat.send` (with `inputMode`, `sttConfidence`, `sttEngine`), `chat.cancel` | Yes | |
| `voice.command` | Yes | Text only; the router classifies; forbidden actions return `VOICE_FORBIDDEN_ACTION` |
| `analysis.request`, `setup.watch` | Yes | |
| `frame.submit` | **No** | The "let AI read the chart" fallback is the Explain path in the MVP |
| `voice.begin`, `voice.audio`, `voice.end` | **No** | Server speech-to-text (Tier 2) arrives in M6; the events are reserved and return `STT_UNAVAILABLE` |

**Server to client**

| Event | In MVP |
|---|---|
| `session.state`, `context.updated`, `analysis.update`, `setup.event`, `feed.status`, `engine.revision`, `warning`, `budget.update`, `error` | Yes |
| `narrative.done` | Yes (single event with content; `narrative.chunk` is not used) |
| `explain.stage`, `explain.chunk`, `explain.done` | Yes |
| `chat.chunk`, `chat.done`, `chat.retract` | Yes |
| `position.event`, `gate.state`, `notification` | Yes |
| `voice.final` | Yes (emitted when the client reports a browser transcript so the server log and UI stay in sync); `voice.partial` is not used |
| `price.tick`, `candle.update` | Only for instruments whose effective class is `DISPLAY_OK` (default: none until S5 evidence exists) |
| `frame.result`, `invoice.state` | No |

**There is no client event that confirms a gate, logs a trade, changes risk, deletes data or pays.** These are REST calls, and the database rejects a gate confirmation that did not come from a UI tap (`gate_decisions.confirmed_via = 'UI_TAP'`, token life at most 120 s).

---

## 4. Contract examples (the shapes frontends will copy)

### 4.1 Wallet-only bootstrap (U1)

```text
GET /v1/me           Authorization: Bearer <JWT from wallet sign-in>
200  {
  "user":   { "id": "…", "displayName": null, "locale": "en", "timezone": "UTC", "createdAt": "…" },
  "wallets":[ { "id": "…", "chain": "evm", "address": "0xAbC…", "primary": true, "linkedAt": "…" } ],
  "email":  null,
  "workspace": { "id": "…", "plan": "free" },
  "entitlements": { "limits": { "chat_per_day": 40, "explain_per_day": 3, "voice_per_day": 60, "daily_ai_budget_usd": 0.05, … },
                    "features": { "beta": true, "voice": true, "explain": true, "approx_mode": true, "exchange_readonly": false } },
  "invite":     { "required": true,  "redeemed": false },
  "disclaimer": { "required": true,  "currentVersion": "2026-10-01", "acceptedVersion": null },
  "ageConfirmed": false
}
```

`entitlements.features.approx_mode` is true in the default row but has no effect in the MVP: **effective = feature flag AND entitlement**, and the flag `explain.approximate` is off.

After `POST /v1/me/invite {code}` succeeds, the invite's `grants` are merged into `entitlements.limits` (default `daily_ai_budget_usd: 1.00`), which `GET /v1/me` reflects on the next call.

### 4.2 Explain, streamed (U11)

```text
POST /v1/explain      Idempotency-Key: 7b1c…     Content-Type: multipart/form-data
  image: <png|jpeg|webp, ≤ 3 MB, ≤ 2,400 px>      meta: {"ocr":{…},"question":"what is price doing here?","inputMode":"voice"}

200 text/event-stream
event: stage  data: {"stage":"RESOLVING"}
event: stage  data: {"stage":"FACTS_READY","instrumentId":"BINANCE:PERP:BTCUSDT"}
event: stage  data: {"stage":"READING_IMAGE"}
event: stage  data: {"stage":"WRITING"}
event: chunk  data: {"delta":"Price swept the equal highs near {{L:L7}} and then closed back below…"}
event: done   data: {"explainId":"…","mode":"GROUNDED","feedMatch":{"status":"MATCH","deltaPct":0.04},
                     "refs":[{"id":"L7","kind":"LEVEL"}],"content":{…},"usage":{…},"disclaimerKey":"AI_GENERATED"}
```

Errors on this route: `IMAGE_TOO_LARGE` 413, `UNSUPPORTED_IMAGE` 415, `NOT_A_CHART` 422, `DAILY_LIMIT_REACHED` 429, `BUDGET_EXCEEDED` 402, `SECRET_DETECTED` 422 (question text), `INSTRUMENT_NOT_ENTITLED` 403, `AI_TEMPORARILY_UNAVAILABLE` 503, `KILL_SWITCH_ACTIVE` 503. The image never appears in logs, the database or object storage (A02 section 3.5).

### 4.3 Voice (U10)

```text
GET /v1/voice/config
200 { "tiers":[ {"id":"whisper-web","kind":"BROWSER","model":"…","url":"…","sha256":"…","langs":["en"]},
                {"id":"moonshine-web","kind":"BROWSER", … } ],
      "server":{"available":false,"maxUtteranceSec":30}, "limits":{"utterancesPerDay":60}, "pushToTalkDefault":true }
```

The browser downloads the model once, verifies the `sha256`, transcribes locally, applies the glossary (`GET /v1/voice/glossary`), shows the transcript, and then sends **text** with `chat.send { inputMode:'voice', sttEngine:'whisper-web', sttConfidence }` or `voice.command`. A `voice_events` row stores engine, duration, confidence and outcome, never audio and never the transcript text (the text lives only in `chat_messages` when it was sent as a chat message, 90-day retention).

### 4.4 Gate and trade log (U12)

Exactly A07 section 6.3: issue (60 s token, shown once, stored as a hash) → review on screen → `POST /v1/gates/{gateId}/confirm {token, planHash}` by a tap → `POST /v1/trades {gateId, …}`. `409 PLAN_CHANGED` with a diff, `410 GATE_TOKEN_EXPIRED`, `409 FEED_STALE` are the failure paths. Nothing is sent to any exchange or wallet.

---

## 5. Errors in the MVP

The full catalogue is A07 section 11. Codes that **cannot occur** in the MVP: `INVOICE_EXPIRED`, `INVOICE_NOT_PAYABLE`, `KEY_TOO_PERMISSIVE`. All other codes can. Codes the frontend must handle on day one: `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `STEP_UP_REQUIRED`, `ADDRESS_BLOCKED`, `INVITE_REQUIRED`, `DISCLAIMER_REQUIRED`, `AGE_CONFIRMATION_REQUIRED`, `KILL_SWITCH_ACTIVE`, `FEED_LICENSE_RESTRICTED`, `FEED_STALE`, `PLAN_CHANGED`, `SECRET_DETECTED`, `DAILY_LIMIT_REACHED`, `BUDGET_EXCEEDED`, `AI_TEMPORARILY_UNAVAILABLE`, `RATE_LIMITED`, `VOICE_FORBIDDEN_ACTION`, `SESSION_CONTROLLER_TAKEN`.

---

## 6. Rate limits in the MVP

A07 section 10 applies unchanged (in-memory token buckets; one process). The numbers a tester will actually feel: chat 10/min and 40/day on the free plan, Explain 6/min and 3/day, voice 30/min and 60/day, session create 10/hour, gate issue 20/hour. Invited testers get higher daily AI budgets through invite `grants`, not through higher request limits.

---

## 7. Contract tests (run in CI from the week shown)

| Test | Proves | Wk |
|---|---|---|
| OpenAPI snapshot diff | A breaking contract change fails CI | 10 |
| Route scan | No route can return raw candles except through `FEED_LICENSE_RESTRICTED` logic reading `instrument_license`; no route accepts an image except `POST /v1/explain` | 10 |
| Wallet-only e2e | Sign-in with a test wallet, bootstrap, invite, disclaimer, session, setup, gate, trade, journal, all without an email | 11 |
| Gate invariants | Single-use token, expiry, plan-changed, stale-feed block; no `trade_records.plan_id` without a CONFIRMED gate; `confirmed_via='UI_TAP'` enforced in the database | 11 |
| Voice cannot act | Every forbidden voice command returns `VOICE_FORBIDDEN_ACTION`; no WS event path reaches the gate service | 15 |
| Resume | Disconnect mid-stream, `session.start { lastSeq }` replays missed persisted events exactly once | 11 |
| Cross-tenant | User A cannot read B's journal via API or via PostgREST | 11 |
| No persistence of media | The schema smoke test finds no image/frame/audio/blob column outside the allow-list; a runtime test uploads an image to Explain and finds it nowhere on disk or in the DB | 14 |
| No audio on the wire | Playwright test with network capture during a spoken question in Tier 1: zero audio payloads | 15 |

---

## 8. Frontend integration notes

1. Generate the TypeScript client from the OpenAPI document in CI; import event types from `packages/contracts`.
2. Reducers are idempotent and keyed by id plus `seq`; after a reconnect, expect a fresh `analysis.update` with full `facts`.
3. Never display a price from `analysis` as a "live quote" for a restricted instrument: raw prices come from the user's own chart; the API supplies analysis levels.
4. Always render the fixed disclaimer text for each `disclaimerKey`; the model never writes disclaimers.
5. Capture-kit runs in a Web Worker; it exposes `onContextHint`, `onTranscript` and `explainFromShare()`; the frontend owns permissions UI (screen share, microphone) and the consent copy (A09 section 3.3).

## 9. Assumptions

1. The frontend is built against this subset first; Set A additions are additive.
2. Wallet connection UI (library choice) is a frontend concern; the backend verifies standard sign-in messages only.

## 10. Open questions

1. **Public API for third parties?** Default: no; every endpoint is first-party.
2. **Expose `GET /v1/instruments/{id}/candles` at all in the MVP?** Default: yes, as a guarded route that returns 403 until licence evidence exists; it keeps the contract identical to Set A.
