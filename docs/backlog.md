# Backlog

Anything not in `docs/plan/set-b/B01` section 3 goes here with a reason. Nothing here is scheduled.

| Item | Why deferred | Revisit |
|---|---|---|
| Bybit spot cross-check for the 3 Binance spot series and SOL perp | MVP V7 has a peer only for BTC/ETH perps (B01). Series without a peer report `NO_PEER`, never "verified" | After G1 if cross-check coverage matters |
| NestJS 12 / TypeScript 7 / Vitest 5 | Plan and owner specify NestJS 11 and TypeScript 5 (D-005) | After closed beta |
| Domain for the Cloudflare Tunnel | Owner priority is a working system (see memory: main focus) | Before staging deploy |
| Fee semantics: "5 bps taker" per side vs round trip | A04 says per side, B03 says round trip; resolve in Phase 3 | Phase 3 |
| `feed_usage` request counters (A03 section 2.3 audit) | not needed to prove the data path; no terms question depends on it yet | before venue terms are negotiated |
| Resolve by price needs a price within 24 h; cold instruments resolve by key only | acceptable at MVP | Phase 7 (OCR) |
| Request paths are logged in full | no route carries wallet addresses or codes yet | before Phase 4 identity routes |
| Cross-check divergence flag is not propagated to an already-closed higher-timeframe candle | the 1m row carries it; the engine reads the 1m flag for sweep decisions | Phase 2 if G1 shows it matters |
| `RateLimitedError.retryAfterMs` is ignored by the queue retry (30 s backoff) | harmless at current volume | when backfill volume grows |
| A live candle lost to a handler error heals only through next-minute gap detection | at most one minute of delay | Phase 9 hardening |
| ManagedConnection can briefly hold three sockets if the active one drops during a rotation | self-corrects within the rotation window | Phase 9 |
| Venue flag changes need a restart to reach the running feed (the API says so) | rare operator action | M6 |
| Engine: detect holes in a timeframe's candle sequence (permanent gaps) | pivots/FVG/ATR treat neighbours across a hole as adjacent; repairable holes are fixed by rebuild (D-020) | Phase 9 |
| Engine: candle flags (SPIKE_SUSPECT, divergence) into sweep decisions | needs flags through the runner; matters once setups use sweeps (A04 6.2) | Phase 3 |
| DST-aware sessions (IANA zones) | needs a time-zone table as data because the engine has no `Intl` (D-018) | when a strategy version wants New York-clock killzones |
| Engine state is about 250 KB per instrument (spec estimated tens of KB) | bounded; retention keeps about 19 snapshots per instrument. Could shrink windows or compress | Phase 9 if Supabase storage is tight |
| `displacement.requireFvg`, FVG per-timeframe expiry multiplier | config fields without behaviour yet | with the G1 labeled comparison |
| Oldest FVGs/OBs/pools are dropped silently at the caps (40/24/40) | bounded state; no event for the drop | if G1 shows missing old zones matter |
| `buildFacts` describes the latest engine state only (throws if asOf is older) | historical facts need state at a past time (snapshot + replay) | Phase 3 backtest harness |
| Fee semantics ("5 bps taker" per side vs round trip) | resolved in D-021: per side in config, round trip in R | done |
| T3 (HTF POI reaction) and per-template rule status beyond HYPOTHESIS | MVP ships T1 and T2 only (B01) | post-MVP |
| Probabilities by segment (SPOT/PERP) and asset class | needs n; `segment` is always `ALL` at launch | when n allows |
| TP2 outcome tracking after TP1 (`r_tp2`) | outcomes resolve at TP1; extra tracking adds a second state machine | if G2 shows it matters |
| Lower-timeframe resolution of intrabar ambiguity | a 5m series exists in the DB; the resolver currently assumes stop first and flags the ambiguity | after G2, if the ambiguity rate is high |
| Position monitor events (`position.*`) and the trade journal rows | need user trades (Phase 4/5) | Phase 5 |
| `setup_displays` rows are written when a plan is shown to a user | the read API does not exist yet; the calibration job already consumes them | Phase 5 |
| Calibration and cohort jobs run on in-process timers (hourly, daily) | idempotent, so a missed run is harmless; move to pg-boss with the worker split | M6 |
| `smc-core v2` candidates from the G2 finding: a hard filter on fee/risk (reject when the round-trip fee exceeds a fraction of R), maker fees on limit entries, a wider minimum stop | G2 (NO_EDGE_DETECTED) shows fees take about 1.2 R per trade at 0.3 ATR stops; any change is a new strategy version tested on fresh data (forward shadow) | after G1 |
| LIVE_SHADOW cohorts include setups created while replaying history (cold start, rebuilds), and `plan.stats` for those uses today's cohorts | a replayed plan should not carry a base rate that includes its own future; mark replayed setups and exclude them from live cohorts | Phase 9 |
| BACKTEST cohort rows are in-sample (tune+validate+test pooled) and are written only with `--publish-cohorts` | they feed plan statistics, so publishing is deliberate | decide with the owner |
| Calibration needs `setup_displays` rows, written when a plan is shown to a user | no production writer until the read API exists (Phase 5); the job returns null until then | Phase 5 |
| Hard filters looser than A04 wording: POI_MITIGATED fires on FILLED/INVERTED only (a TESTED zone passes and scores lower), HTF_COUNTER_BIAS only when every bias timeframe opposes | matches the shipped table semantics ("not mitigated"); revisit with G1 | with G1 |
| OpenAPI document generated from the Zod contracts and a typed client | D-027: the route-scan test enforces guards for now | Phase 8 |
| `analysis.update` sends full snapshots; true diffs | bandwidth is small at MVP scale | if bandwidth matters |
| Notification preferences per type | no column in the canonical schema; MVP is in-app only | with email/push channels |
| Rate limiter is in memory | one API process until the worker split | M6 (Valkey) |
| Realtime session registry is in memory; ended sessions are dropped only on `session.end` or the 4 h reaper | single process | M6 |
| Position events use 1m closes and fire once per type per trade | simplest monitor that satisfies the spec | refine from live use |
| Gate token expiry is checked against the database clock; stale-feed check uses the in-process feed monitor | the worker split needs the feed state through the bus | M6 |
| Gate: dwell time between issue and confirm, or a per-gate nonce shown only in the UI, to separate a tap from a script | D-029; a product decision | with the owner |
| Idempotency rows left by a crash (`status` null) block retries until the 24 h purge; trade create does audit and re-read after commit | stale-row takeover after N seconds | Phase 9 |
| Cursor pagination uses millisecond timestamps (Postgres keeps microseconds) | rows sharing a millisecond at a page edge can be skipped | encode the raw timestamp text |
| Journal `PATCH` cannot clear notes/tags; `addNote` with an unknown setup id returns 500 instead of 404 | minor | Phase 9 |
| Position monitor events fire once per type per trade and are not unique-indexed | acceptable for MVP | refine from live use |
| Blocklist additions and `blockUser` do not void open gates; a block takes effect at the next reap (up to 60 s) for sockets | minor | Phase 9 |
| `toDto` loads the risk profile per setup per push | cache per workspace | Phase 9 |
| True provider token streaming for chat with `chat.retract` on a late violation | answers are validated before sending, so retraction is never needed today; streaming lowers time to first token | when first-token latency matters |
| J4 "why no trade?" and J5 post-session review jobs, translation into other languages, 5% sampled online judge | no weeks assigned in B05; templates cover the product without them | post-MVP |
| Eval results into `eval_runs`; OCR eval on 100 crops; image-read eval and bake-off between providers | needs live keys and the browser OCR model | with spike S1 and the first live run |
| Live verification of the three provider request shapes (Anthropic, OpenAI, Gemini) | only tested against a fake network so far; first live call is the owner's | first live run |
| Price table has no built-in prices | plan marks them "verify"; fallback is deliberately high | owner enters real prices in `AI_PRICES_JSON` |
| Narrative minimum interval and cache hit counters are in memory | single process | M6 |
| `AiMeter` and rate limiters are per process | one API process until the worker split | M6 |
| Price comparison for OCR reconcile reveals a little about the price (capped at 60 an hour) | accepted under "analysis only"; could be replaced by a coarser match signal | Phase 9 |
| Narrative language is English only; Explain/chat in other languages not translated | A05 6.5 | when demand appears |
| The dev client builds HTML by string concatenation of server text | acceptable for a local test harness; escape before any public use | before any public use |
| Record an estimated cost for provider calls that time out or are aborted | the vendor may still bill generated tokens; the global cap can under-report | Phase 9 |
| Check the user allowance before buffering a multipart upload | memory use under an upload flood; route-level limit exists | Phase 9 |
| A real UI must escape or sanitise every model and engine string it renders | the dev page does; model output is also guarded against markup only indirectly | when the real client is built |
| Wire the real recogniser (transformers.js Whisper on WebGPU, Moonshine on WASM, Silero VAD) and the microphone worklet into the seams | browser code, measured by the owner in spike S3 | with S1 and S4 |
| Per-language glossaries and models | English only | when demand appears |
| Spoken-form correction is rule based; learn corrections from edited transcripts | edits are not recorded (and must not contain audio) | after beta |
| The nightly workflow has never run | no GitHub remote yet | when a remote exists |
| Model licences not reviewed by the owner | Whisper, Moonshine, Silero published as permissive | before launch |
| Sign the speech model manifest (the server currently supplies addresses and hashes) | a compromised server could point the browser at its own files | before public launch |
| Catch letter-spelled forbidden words and negations ("don't confirm") in the voice rules | harmless today: the grammar cannot express any action | Phase 9 |
| Review step before a voice journal note is saved | notes are saved at once | when the real client exists |
| Cursor timestamps keep milliseconds (Postgres keeps microseconds); order by millisecond-truncated time | rows sharing a millisecond at a page edge could be skipped | when lists get long |
| Grafana dashboards on the metrics | alerts exist; dashboards are for looking, not paging | with the first scraper |
| ZAP baseline scan and a k6 run against a deployed target | needs a target | at deploy |
| Move the in-process timers (retention, deletion purge, cohort and calibration jobs) to pg-boss with the worker split | idempotent, single replica | M6 |
- Frontend: replace the hand-copied `InstrumentDto` in apps/web with a contracts export; add chart licence-mode switch tests in F2.
- Frontend: first-load JS is 247 KB gz (framework about 156 KB); consider dropping the Radix tooltip from the shell or splitting the canvas to get under 200 KB.
- Frontend: wagmi/viem and the Solana wallet adapter were not added in F1; `signInWithWeb3` only needs the wallet provider, and EIP-6963 discovery covers multiple EVM wallets. Revisit if in-app signing (wallet link, step-up) needs them.
