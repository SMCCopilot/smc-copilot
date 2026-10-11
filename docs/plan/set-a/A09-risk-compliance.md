# A09: Risk, Compliance and Liability

**Set:** A (full product) | **Status:** Planning document, v2.0, 2026-10-10 (jurisdiction-neutral; crypto-specific; adds wallets, voice, screen images, stablecoin payments)
**Depends on:** A01 (principles), A03 (data licensing), A04 (execution scope), A05 (language rules, vendor retention), A06/A08 (retention, security, billing). **Feeds:** A10 (legal gates in the roadmap), B01/B05 (MVP scope and checklist).

> **This is product-risk planning, not legal advice.** I am not a lawyer. Rules differ by country and change quickly, especially for crypto. Items marked **[verify]** or **[counsel]** need confirmation from a qualified lawyer in each jurisdiction you will operate from or serve before you take money from users. The design decisions below are chosen to keep the product on the *safer* side of the lines I can identify, not to certify that it is compliant.
>
> **Jurisdiction-neutral by design.** The product is the same everywhere: no country-specific features, payment rails, languages-by-country or pricing. Where the law forces a difference (excluded territories, tax, age of majority), it is handled by configuration and by counsel's advice for the places you actually choose to operate from and serve, not by a default home country.

---

## 1. Risk register

Likelihood (L) and Impact (I): H/M/L. Owners are roles you will wear.

| # | Risk | L | I | Mitigation (where specified) | Owner |
|---|---|---|---|---|---|
| R1 | Output is classed as **regulated investment advice, crypto-asset advice or a signal service** | M | H | Impersonal, scenario-based wording; no personal recommendations; no imperative language; fixed disclaimers; counsel review (sections 2 and 3; A05 section 6) | Founder + counsel |
| R2 | **Market-data terms violation** (displaying or redistributing venue data) | M | H | Licence classes, raw-data egress gate driven by recorded `venue_terms`, spike S5 (A03 section 2.3) | Founder |
| R3 | Users lose money (especially with leverage) and blame the product | H | M-H | Risk-of-loss messaging, liquidation warnings, no performance claims, honest base rates with CIs, user-controlled execution, ToS limitation of liability (section 4) | Founder |
| R4 | **Model produces overconfident or wrong text** (including in Explain, which reads user screenshots) | M | M-H | Grounding, validators, lexicon, evals, approximate-mode labelling, kill switch (A05) | Engineering |
| R5 | **Engine bug** yields wrong zones/levels | M | H | Golden tests including the worked example, no-lookahead property tests, determinism check, `data_revised` flags (A04 section 15) | Engineering |
| R6 | Bad or stale data drives analysis | M | M | Validation, cross-venue check, stale detection, "analysis paused" behaviour (A03 section 6) | Engineering |
| R7 | **Privacy breach** (journal, chats, exchange keys, accidental screen content, wallet-to-activity linkage) | L-M | H | Zero retention of frames and audio, on-device OCR and STT, encryption, RLS, least privilege, incident plan (section 3.3, A08 section 2) | Engineering |
| R8 | Execution feature (L2) creates regulated activity or loss liability | M if built | H | Not built in v1; strict enablement gate (section 6); wallet-signed orders only, no custody | Founder + counsel |
| R9 | AI cost runaway / free-account farming | M-H | M | Invites, Turnstile, per-account budgets, **global daily AI cap**, kill switch (A05 section 9.3, A08 section 2.3) | Engineering |
| R10 | Vendor dependency (LLM, Supabase, venues, the free compute VM) | M | M-H | Multi-vendor router, provider interface, portable Postgres, reproducible VM, fallback ladder (A01, A05, A08 section 1.3) | Engineering |
| R11 | Third-party platform conflict (users sharing screens of charting sites) | L-M | M | Product reads **the user's own screen locally**, never a vendor's servers; no scraping or DOM extraction; images are not stored; state this plainly in the privacy text **[verify the terms of the charting platforms your users use]** | Founder |
| R12 | Minors or vulnerable users use the product | M | M-H | 18+ attestation gate, responsible-trading features, language rules (section 4.3) | Founder |
| R13 | **Sanctions exposure** (sanctioned wallets or territories) | L-M | H | Wallet blocklist from public lists, territory list in ToS, payment screening on incoming addresses where feasible, counsel (section 3.5) **[counsel]** | Founder |
| R14 | Payment disputes, wrong-amount transfers, reorgs, stablecoin issuer freeze or depeg | M | L-M | Exact-amount invoices, confirmation depth, `MANUAL_REVIEW` instead of guessing, prepaid periods, refund process documented (A08 section 7) | Founder |
| R15 | Misleading marketing | M | H | Marketing checklist (section 3.4) | Founder |
| R16 | Key-person risk (solo builder) | M | M | Documentation (this plan), runbooks, simple stack, disposable VM | Founder |
| R17 | **Wallet phishing and look-alike sites** targeting your users | M | H | Sign-in message contains only the EIP-4361 login statement; the product **never** asks for token approvals or transfers except the plain invoice transfer the user initiates; publish the exact domain; takedown runbook (A08 section 5.5) | Founder |
| R18 | Tax and consumer-law obligations on digital services sold without a merchant of record | M | M | Accountant and counsel before charging; keep invoices and on-chain records (section 3.5) **[accountant/counsel]** | Founder |
| R19 | Seed phrases or private keys pasted into chat or voice | L-M | H (for the user) | Detector blocks before any model or database sees it; UI warning; no storage (A05 section 12) | Engineering |
| R20 | Loss of the free compute VM or its account | M | M | Section 1.3 of A08: reproducible deployment, backups, fallback ladder | Engineering |

---

## 2. Regulatory classification (what could apply, and the design stance)

### 2.1 The central question

Is SMC Copilot **information/education/analytical tooling**, or **investment advice, crypto-asset advice, or a dealing or arranging service**? The answer depends on *what the product says* and *what it does*, not on its name or on a disclaimer.

Evidence I found or know, and what it implies:

| Source | Takeaway for the design |
|---|---|
| *24HR Trading Academy Ltd v FCA* [2021] EWHC 648 (Ch), as summarized by Fieldfisher | UK High Court treated FX "trading signals" sent to retail users as **regulated advice**, and held the educational context did not displace that meaning. Commentary notes that information alone is not advice, but information accompanied by a **comment or value judgment on its relevance to an investment decision** can be |
| UK/EU concept of personal recommendation (MiFID II "investment advice") **[counsel]** | Advice is a *personal recommendation* presented as suitable for a specific person or based on their circumstances. A generic, non-tailored analysis is outside it, but a tailored "take this trade now" is inside it |
| EU Markets in Crypto-Assets Regulation (MiCA), which has applied in full since December 2024 **[verify scope]** | "Providing advice on crypto-assets" is a regulated crypto-asset service in the EU, with a personal-recommendation concept similar to MiFID. The same stance applies: impersonal, non-tailored content **[counsel]** |
| US: investment adviser regulation and the "publisher's exclusion" (*Lowe v. SEC*, 1985); crypto is split across securities and commodities regulators **[counsel; applicability to software tools, to derivatives and to crypto is uncertain]** | Impersonal, general, regularly published material is treated more favourably than personalized advice |
| Derivatives and leverage rules (many jurisdictions restrict marketing of leveraged products to retail) **[counsel]** | We analyse perpetual-futures charts and warn about liquidation; we do not offer, arrange or promote derivatives. Marketing copy must stay on "analysis and explanation" |
| Data protection: GDPR / UK GDPR, and similar laws elsewhere **[counsel]** | Lawful basis, DPIA for the screen-capture feature, cross-border transfer terms, breach notice windows (often 72 hours). **Wallet addresses are pseudonymous but should be treated as personal data** |
| EU AI Act transparency duties for AI interaction **[verify timing and scope]** | Disclose that the user is interacting with AI; label AI-generated content; the voice feature must not imply a human |
| Sanctions law (OFAC, UN, EU, UK) **[counsel]** | Do not knowingly serve sanctioned persons or territories; screening has limits (section 3.5) |

### 2.2 Design stance (what the product commits to)

| Principle | Implementation |
|---|---|
| **Impersonal** | The same analysis is shown to every user watching an instrument. Narratives are shared across users (A05 section 9.1), which is also a *factual* defence that content is not tailored to any individual |
| **Descriptive and conditional, not directive** | "If price closes above X, this scenario weakens." Never "buy here", "you should enter", or "take profit now" (A05 lexicon filter and chat redirect). **This applies equally to voice answers and to Explain** |
| **Explain this chart answers about the chart, not about the user** | A user question like "is this a good long?" is answered as scenarios with invalidation and base rates, never as a recommendation (A05 section 8) |
| **No suitability inputs driving the recommendation** | The user's risk profile is used only for **arithmetic** (position size, fees, liquidation distance), clearly labeled "illustrative calculation". It never changes which setups are shown or ranked **[counsel to confirm that a size calculator tied to a user's balance is acceptable]** |
| **Probabilities are base rates with methodology** | Always with sample size, interval, source, and "not a forecast" (A04 section 8.4). No profit promises, no "win rate" marketing headline. With no history, no number is shown |
| **User makes and executes the decision** | Execution gate (A04 section 11): on-screen tap only (voice can never confirm), L0 only in v1 |
| **No performance-based marketing or "signals" framing** | The product is "analysis, explanation and journaling". Avoid "signal", "alert to buy", "copy trades" |
| **Transparency** | AI-generated label; strategy version and data source shown in a details panel; approximate mode clearly labeled |

### 2.3 Jurisdiction plan

| Step | Action | When |
|---|---|---|
| 1 | Decide **where the operator is established** (a legal-entity and tax question that this plan deliberately does not assume) | Before accepting any payment |
| 2 | One-hour scoping call with a lawyer experienced in fintech/crypto **in that jurisdiction**; bring this document and a prototype | Before beta invites beyond friends |
| 3 | Second opinion from a lawyer in the **largest user jurisdiction you expect** (for example UK/EU or US), focused on advice vs information, crypto-asset advice, and marketing | Before public paid launch |
| 4 | Decide **where you will accept users** (ToS territory list, informed by sanctions law and local crypto rules) and enforce it with the territory notice, the wallet blocklist and Cloudflare country rules if counsel requires | Before launch |
| 5 | Record each venue's data terms (spike S5, A03) | Before launch |
| 6 | Accountant: tax treatment of selling a digital service for stablecoins; VAT/GST/sales tax on digital services by customer location; record-keeping | Before the first paid invoice |
| 7 | Fresh legal review before **any** L1 or L2 feature | Gates G5 (M7) and G6 (M9) in A10 |

Rough legal budget for planning: **a few hundred to a few thousand USD** for scoping calls and document templates; ToS/Privacy drafting from a reputable template plus lawyer review is the usual cost-effective path **[verify local rates]**. This is the one budget line outside the "Supabase and AI only" rule, and it is a professional-services cost, not a service subscription.

### 2.4 Alternatives rejected

| Alternative | Rejected because |
|---|---|
| Pick one launch jurisdiction now and design only for it | The operator's home is undecided and users are international; a jurisdiction-neutral design (impersonal, scenario-based output) is the safest common denominator, and counsel narrows it later |
| Position the product as personalized "signals" or "advice" | The *24HR Trading Academy* and MiCA material in section 2.1 show that content, not labels, decides; personalised calls are the highest-risk category |
| Geo-block by IP as the only territory control | IP checks are easy to evade and do not cover wallets; use the territory notice, the sanctions address blocklist, and ToS together |
| Collect KYC to look "safe" | Adds personal-data liability and cost with no legal need for an analysis tool; the design avoids holding funds or accounts |
| Disclaimers as the main protection | Disclaimers complement but cannot cure advice-like content (section 3.1) |

---

## 3. Product obligations by area

### 3.1 Disclaimers (fixed text, never model-generated)

The API returns **keys**; the frontend renders vetted copy (A07). Each text is versioned (`profiles.disclaimer_version`) and acceptance is recorded.

| Key | Where shown | Purpose |
|---|---|---|
| `NOT_ADVICE` | First-run gate (must accept), footer of analysis, chat header, Explain answers | Educational/analytical tool, not personal advice, not a recommendation to buy or sell |
| `RISK_OF_LOSS` | First-run gate, trade plan card | Trading carries a high risk of loss; leverage and perpetual futures can lose more than expected and can be liquidated |
| `HISTORICAL_NOT_FORECAST` | Next to any base rate | Past frequency of similar setups; no guarantee |
| `AI_GENERATED` | Narratives, chat, Explain, voice replies | Text written by AI from the engine's facts or from an image; may contain errors |
| `SIZE_ILLUSTRATIVE` | Position-size preview | Arithmetic only; liquidation price is approximate |
| `APPROX_MODE` | Approximate mode and Explain on unsupported instruments | Levels read from pixels; not reliable for trading decisions |
| `DATA_STALE_OR_DELAYED` | Whenever feed degraded | Analysis may be out of date |
| `DATA_SOURCE` | Instrument panel | Venue attribution where required |
| `NEVER_SHARE_KEYS` | Wallet sign-in, chat input, voice settings, payment page | We never ask for your seed phrase or private key; never share them with anyone, including this app |
| `SIGN_IN_ONLY` | Wallet sign-in | This signature only logs you in; it cannot move funds |

Disclaimers do **not** cure advice-like content (the *24HR* decision shows the content, not the label, decides). They complement section 2.2.

### 3.2 Legal documents to produce

| Document | Notes |
|---|---|
| Terms of Service | Limitation of liability, no advice, acceptable use, territory restrictions, fair use, payments and refunds (prepaid, on-chain, manual refunds), termination, governing law/forum **[counsel]** |
| Privacy Policy | Data inventory (A06), purposes, sub-processors, international transfers, retention (A06 section 10), rights and request process, **wallet addresses as personal data**, voice and image handling in plain words (what runs on the device, what is sent, what vendors may retain) |
| Cookie/consent | Only if analytics/cookies are used on the frontend (the plan uses none at MVP) |
| Acceptable Use / Responsible Trading page | Plain-language guidance and links to support resources |
| Data Processing Agreement | For team/business customers (later) |
| Sub-processor list | Supabase, Oracle Cloud, Cloudflare, GitHub, LLM vendors (Anthropic, OpenAI, Google, DeepSeek as enabled), Sentry, Grafana Cloud, optional SMTP vendor, public chain RPC providers, exchanges as data sources |
| Security overview page | Optional trust page |

### 3.3 Privacy, screen capture, voice and wallets

| Topic | Decision |
|---|---|
| Lawful basis (GDPR-style) | Contract (providing the service) for core processing; consent for the microphone, for screen sharing and for any optional "improve with my screenshots" dataset (**default off; not built**); legitimate interest for security logs **[counsel]** |
| DPIA | Short DPIA for the screen-capture, OCR and Explain features before beta: purposes, data flow (device OCR, text hints to server, image only on Explain to an AI vendor), minimization, retention (none by us), risks (third-party data on screen), mitigations |
| Capture UX | Browser's native capture picker + persistent on-screen "sharing" indicator + ROI crop + "pause" always visible; explain that OCR runs on the device and an image is sent only when the user presses **Explain** |
| Zero retention, stated honestly | **We store no frames and no audio.** AI vendors may keep a request for a limited time under their own terms (A05 section 12 table). The privacy text says exactly that and offers a **"never send images to AI"** setting that disables Explain's image path (text-only Explain with manual chart context remains) |
| Voice | Speech-to-text runs in the browser by default; audio never leaves the device unless the user's device cannot run it and they accept the server fallback, in which case audio is decoded in memory and discarded. No speaker identification or voiceprints are created. Push-to-talk by default; a persistent mic indicator when hands-free is on. Transcripts are ordinary chat messages (90-day retention, user-deletable) |
| Sensitive content | Users told not to share regions with account numbers, seed phrases or other people's data; client-side redaction rectangles (A02) |
| Wallets | Wallet address and sign-in time are stored; nothing is written on-chain; we do **not** run chain-analytics profiling of users; IP addresses are not stored raw (salted hashes with expiry for abuse control) |
| LLM vendors | Use only inline image input (no vendor file stores); confirm "no training on API inputs" under the chosen plan and enable zero-retention options where offered; the data-class router keeps D2 data away from vendors without suitable terms **[verify per vendor]** |
| Rights | Export (`/v1/journal/export`, Explain history), deletion (`DELETE /v1/me`), correction; response within 30 days. Erasure applies to our database; public blockchain records of the user's own payments cannot be erased and are not linked to the profile after deletion (section 3.5) |
| Breach | Incident plan (section 7); regulator and user notification clocks (often 72 hours) **[counsel]** |
| Children | 18+ only (or the age of majority where higher); self-attestation at signup; ToS prohibits minors. The product cannot verify age and does not claim to |
| Cross-border | Data hosted in the chosen Supabase and VM regions; standard contractual clauses via vendors' DPAs **[counsel]** |

### 3.4 Marketing checklist

- No claims of profit, accuracy, "win rate", or "AI that predicts markets".
- No testimonials implying typical results; no screenshots of cherry-picked winners. If you show examples, show a representative sample including losses and say how it was selected.
- Say "analysis and explanation tool", not "signals".
- State clearly that the product does not execute trades (v1) and does not manage money or hold funds.
- Do not promote buying any particular crypto-asset. Crypto promotion rules in several jurisdictions apply to promotions *of* crypto-assets and can be wider than expected **[counsel]**.
- Do not use finfluencer affiliate schemes tied to trading performance; label any paid promotion.
- Country-specific advertising rules may apply even to non-advice products **[counsel]**.

### 3.5 Crypto payments, sanctions, tax and records

| Topic | Decision |
|---|---|
| What we accept | Stablecoin transfers (USDC, optionally USDT) for **prepaid subscription periods** only. We never custody user funds; the treasury address receives payment for our own service |
| Sanctions screening | `address_blocklist` is loaded daily from public sanctions lists (for example the OFAC SDN list's digital-currency addresses); sign-in and incoming payments from a listed address are refused or held for review. **Limits:** a list check is not chain analytics; it cannot catch unlisted or newly created sanctioned wallets. Counsel decides whether more is needed at your scale **[counsel]** |
| Territory restrictions | ToS list of excluded territories (comprehensively sanctioned jurisdictions at minimum **[counsel]**). IP-based blocking is imprecise and easy to bypass; it is a good-faith control, not a guarantee |
| AML | Selling a software service for crypto is generally not itself a regulated money-transmission activity, but rules differ **[counsel]**. The design avoids anything that looks like exchange, custody, transfer on behalf of others, or conversion |
| Stablecoin issuer risk | USDC and USDT can be frozen by their issuers for specific addresses, and a depeg is possible. Treat received funds as business revenue, convert promptly according to your treasury policy **[accountant]** |
| Tax | VAT/GST/sales tax on digital services depends on the customer's location and your establishment. Without a merchant of record this is **your** responsibility **[accountant]**. Keep every invoice, the on-chain transaction hash, the USD price fixed at invoice time and the date |
| Refunds | Manual on-chain refunds after review; stated in the ToS. Network fees are borne by the payer |
| Records | `invoices` and `onchain_payments` are kept after account deletion (financial records) and are detached from the profile (A06 section 14, question 4) **[counsel on minimum retention]** |

---

## 4. User-harm safeguards (responsible-product design)

### 4.1 Built-in behaviours

| Safeguard | Mechanism |
|---|---|
| Risk first | Every plan shows the stop and invalidation before targets; position size preview defaults to the user's chosen risk percent, warns above their cap (A04 section 10.1) |
| Liquidation honesty | For perps, `LIQUIDATION_BEFORE_STOP` is a prominent warning when an entered leverage puts liquidation before the stop; the approximation is labelled as such |
| No urgency | No countdowns, "trade now" badges, streak mechanics, or leaderboards of P&L |
| Honesty about uncertainty | Confidence label rule-based and shown with sample size; insufficient history stated plainly; approximate mode labelled |
| Weekend/thin-liquidity note | Weekend setups carry a visible note (A04 `weekendLiquidity`) |
| Daily guardrails (user-set) | Optional daily loss/limit warnings; session length reminder after configurable hours (default 3 h) |
| Leverage caution | Warn on high leverage in the size preview (`LEVERAGE_HIGH`) |
| Cooling-off | "Pause analysis for today" button that the user controls |

### 4.2 AI behaviour in sensitive moments

Chat red-team set (A05 section 14.3) includes distress, gambling-like language ("I need to win back my losses"), requests for guarantees, and (new) pasted seed phrases and "should I put my savings in this" questions. Expected behaviour: calm, non-judgmental, no encouragement to trade, no sizing advice that increases risk, point to general support resources, and remind that the decision and the risk are theirs. Voice replies follow the same rules and are short. Helplines depend on the user's country; the product asks for a country only if the user wants local resources and keeps a maintained list in config **[verify and maintain]**.

### 4.3 Eligibility

18+ (or the age of majority where higher); excluded territories per ToS; no service to sanctioned persons or territories **[counsel]**. Age is self-attested at signup (`profiles.age_confirmed_at`).

---

## 5. Data-licence compliance (cross-reference)

Pre-launch checklist (details A03 section 2.3):

- [ ] Every production venue has at least one `venue_terms` row (URL, retrieved date, summary, decision, reviewer, whether counsel reviewed); without it, its instruments stay `INTERNAL_ONLY`.
- [ ] Contract test proves no raw OHLCV for `INTERNAL_ONLY` instruments (per the `instrument_license` view) leaves the API/WS.
- [ ] Binance public market-data endpoints and terms read for commercial use of derived analytics; note the separate Binance Vision *dataset* terms are **non-commercial** and must not be used in production without an agreement. The same question is asked of Bybit, OKX, Coinbase and Kraken (spike S5).
- [ ] Attribution text stored per instrument where a venue requires it.
- [ ] Usage metering (`feed_usage`) in place for audit.
- [ ] Forex remains disabled until a licensed or bring-your-own-feed route exists (A03 section 2.4).

---

## 6. Execution scope: enablement gates (L0, L1, L2)

| Level | Allowed in | Pre-conditions (all required) |
|---|---|---|
| **L0 Manual log** | v1 (MVP) | ToS + disclaimers accepted; no exchange credentials stored |
| **L1 Read-only monitoring** (exchange read-only API keys, or a wallet the user has linked and signed with) | In M7 (after the public launch in M6) | Legal check on data-protection and exchange API terms; encrypted credentials; **read-only scope verified server-side and keys with trade or withdraw rights refused**; revoke UI; fresh-signature step-up; security review/pen test; DPIA update; incident runbook |
| **L2 User-authorized order routing** | Not before the dedicated milestone M9 and only if the business case is clear | **Legal opinion on whether routing/transmitting orders is a regulated activity in each served territory [counsel]**; on-chain venues: **the user's wallet signs every order, we never hold keys**; centralized venues: trade-only keys with withdrawal disabled, only if the venue's terms allow third-party apps; liability allocation in ToS and insurance considered; per-order gate with hard size/risk caps and max daily orders; idempotent submission; kill switch; paper-trading mode first; staged rollout to invited users; monitoring and reconciliation; documented failure handling; pen test |

If counsel advises that L2 requires registration or a licence that is disproportionate for a solo product, **the right decision is not to build it**; the product value (explanation, journaling, learning) does not depend on it.

---

## 7. Incident response

| Incident type | Examples | First actions |
|---|---|---|
| Security/privacy | Token leak, unauthorized access, exposed backup, leaked exchange-key KEK | Contain (rotate keys, revoke sessions), assess scope, preserve logs, notify users/regulators within required windows **[counsel]**, post-mortem |
| Harmful AI output | Certainty language or advice-like text slips through | Enable kill switch for the job, switch to template text, capture the facts hash and prompt version, add to red-team set, fix, re-run evals, publish note if users were affected |
| Data licensing | Venue notice or terms change | Set `venues.enabled=false` or record a `PROHIBITED` terms row (the view downgrades instantly), respond via counsel |
| Engine correctness | Wrong zones shown due to bug | Mark affected setups `data_revised`, hotfix, emit `engine.revision`, notify affected sessions in-app |
| Feed outage or geo-block | Venue down or blocks the VM's IP range | Failover; if all down, analysis paused banner (A03) |
| Payments | Wrong-amount transfer, reorg, issuer freeze, watcher bug | Invoice to `MANUAL_REVIEW`, never guess; pause `payments.enabled` flag if the watcher misbehaves; reconcile against chain explorer; refund by hand if due |
| Phishing / impersonation | Look-alike domain asking for wallet signatures | Publish warning in-app and on the status page, request takedown with the registrar and Cloudflare, rotate nothing (no keys involved) unless evidence says otherwise |
| Infrastructure loss | VM reclaimed or account suspended | Follow the rebuild runbook (A08 section 1.3 and 5.5) |

Keep a lightweight incident log (`audit_log` plus a markdown post-mortem folder).

---

## 8. Governance of the AI and the strategy

| Control | Mechanism |
|---|---|
| Change management | Prompt, model, and strategy changes are versioned, evaluated (A05 section 14, A04 section 15), and recorded; promotion of any rule to `VALIDATED` requires a stored backtest (A04 section 8.5) |
| Model swaps | A challenger replaces a default model only through the replacement rule (A05 section 2) and never for a data class its vendor terms do not suit (A05 section 12) |
| Evidence retention | `ai_calls`, `eval_runs`, `backtest_runs`, `calibration_reports` retained to answer "why did the product say this on date X" (90 days for `ai_calls` detail, longer for aggregates) |
| Human review | Weekly review of a sample of narratives and chat transcripts (with consent/anonymization) during beta |
| Transparency | Strategy version and data source visible in the details panel; AI label on prose and on voice replies |
| No silent learning | No automatic re-weighting from outcomes without a new strategy version (A04) |

---

## 9. Compliance checklist by milestone (feeds A10)

| Before... | Required |
|---|---|
| **Private alpha (you + friends)** | Venue terms read (S5 first pass); frame/audio zero-retention implemented and tested; simple "not advice" screen; no payments |
| **Closed beta (invited testers)** | Short DPIA; Privacy Policy + ToS drafts; disclaimer acceptance flow; 18+ attestation; lawyer scoping call done in the operator's jurisdiction; wallet blocklist loaded; global AI cap and Turnstile on; red-team set passing |
| **Public launch with payments** | Lawyer review in the target markets (including crypto-asset advice and marketing); accountant sign-off on tax; final ToS/Privacy; venue terms recorded for displayed instruments; marketing checklist applied; payment watcher and manual-review runbook tested; incident runbooks; sub-processor list; DSAR process tested; support contact |
| **L1 monitoring** | Section 6 L1 pre-conditions |
| **L2 order routing** | Section 6 L2 pre-conditions |
| **Forex enablement (later)** | A03 section 2.4 gate, new data terms, new counsel review for forex-specific rules |

---

## 10. Assumptions

1. You will not hold client funds, manage accounts, or act as a broker or exchange.
2. Initial customers are retail traders; no institutional/advisor-white-label use.
3. The product is not marketed as a signal service.
4. The operator's legal home is **not decided** in this plan; every step that depends on it is listed in section 2.3.

## 11. Open questions (and questions to ask counsel)

1. **Where is the operator established, and which territories will you exclude?** Default: undecided; launch as a closed beta with a conservative excluded list and decide before taking payment.
2. **Is a personalised position-size calculator acceptable** without advice-regulation consequences in your target markets? Default: keep it, labeled illustrative, behind the disclaimer gate.
3. **Is a shared, impersonal AI narrative, including a voice reply and an Explain answer about a user's own screenshot, acceptable** as "general information" in the UK/EU/US? Default: yes by design, to be confirmed.
4. **Does analytics about crypto perpetuals trigger crypto-asset service, derivatives-marketing or other obligations** in your target markets? Default: treat as an analysis tool; confirm.
5. **Is accepting stablecoins directly acceptable for your entity** (tax, accounting, banking)? Default: yes after accountant review; fall back to a merchant of record if not (that would be a paid vendor, so your approval).
6. **Insurance** (professional indemnity / cyber) at public launch? Default: price it before launch.
7. **Disclosure of backtests** to users: acceptable format and wording (A04 section 15.3).
8. **How much sanctions screening is enough** at your scale (list check only, or a commercial screening service)? Default: list check; a paid service needs your approval.

## Sources

- Fieldfisher, "Straying into regulated territory: more guidance on investment advice and arranging activities", discussing *24HR Trading Academy Ltd v FCA* [2021] EWHC 648 (Ch)
- Binance Vision Dataset Terms (non-commercial licence grant; enterprise licence needed otherwise)
- Supabase documentation on Web3 sign-in (rate-limit and abuse warning) (accessed 2026-10-10)
- *Lowe v. SEC* (1985), MiCA, MiFID II, GDPR, EU AI Act and sanctions-regime references: **from general knowledge, not re-verified in this pass; counsel must confirm**
