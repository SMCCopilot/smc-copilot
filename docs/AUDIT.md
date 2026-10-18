# Platform audit (round 1, 2026-10-17)

Scope reached so far: baseline gates, the chart, screen share, layout, production hygiene. The rest of the audit table
(live feed vs REST, staging database, identity on real Supabase, live AI, jobs, security, deploy) is NOT done: see "Not yet audited".

## Gates (clean tree after the fixes)
build, typecheck, lint (biome + boundaries), all unit tests: pass (`docs/audit/_*2.log`). Web Playwright: 19/19 (`pnpm --filter @smc/web e2e`).
Before the fixes lint failed (4 biome errors in tests and tooling, one unformatted `railway.json`): fixed.

## Findings
| ID | Sev | Finding | Root cause | Status |
|---|---|---|---|---|
| A1 | S1 | No chart for any instrument | Every instrument is `INTERNAL_ONLY`, so the web shows the overlay-only ruler; no dev way to see candles | Fixed: `DEV_RAW_PRICES` (dev only, refused when `NODE_ENV=production`, banner "DEV: raw prices enabled"); licence view still decides in production. Test: `packages/config/test/env.test.ts` |
| A2 | S1 | No Meet-style screen share | Share lived only inside the Explain dialog; no tile, indicator, chips, override or Explain now | Fixed: `share-panel.tsx` (Share screen button in the chart toolbar, self-view tile, Sharing indicator, detected chips with confidence, market and timeframe override via `context.set`, `FEED_MISMATCH` notice, Explain now, Stop, privacy line, permission-denied message). Test: `e2e/qa.spec.ts` share flow |
| A3 | S2 | Overlay labels drawn on top of each other (zone, entry, stop, invalidation) | All labels drawn at one x with no collision handling | Fixed in `chart-full.tsx` (rows pushed apart, backing plate) |
| A4 | S2 | Candles bunched in the right third of the chart | No framing of the visible range after data load | Fixed (fit or last 120 bars, once per chart; chart remounts per instrument and timeframe) |
| A5 | S2 | Plan panel's collapse button covered the Journal tab at 1440 | Five tabs wider than the panel | Fixed: tab strip scrolls, tabs do not wrap |
| A6 | S2 | Production could start with dev switches on | Schema only checked required secrets | Fixed: production refuses `DEV_RAW_PRICES` and `DNS_SERVERS` |
| A7 | S3 | Migration 0009 inserts dev invite `DEV-BETA-0001` | Seed in reference migration | Mitigated: `packages/db/src/cli/migrate.ts` deletes it after migrating. Deploy must use that CLI (Railway `preDeployCommand` does). Backlog: move it out of the migration |
| A8 | S2 | No Dockerfile in the repo | Deploy is Railway RAILPACK from `railway.json`; the brief assumed Docker | Open: decide Docker vs Railpack; image-content checks cannot run |
| A9 | S3 | `packages/market-data/src/replay.ts` ships inside a production package | Replay adapter lives in `src` | Open: confirm no import from the API runtime path |
| A10 | S3 | Tests could not run beside a developer's running Next server | Next locks `.next` | Fixed: tests build into `.next-e2e` |

## Evidence
Screenshots `docs/qa/after/` (room dark and light at 1440, 1280, 390; share active at 1440). Layouts have no sideways scroll at all three widths (asserted).
The design files in `docs/design/` show a light "Codelytic" chat layout, not this product; the app follows `98-FRONTEND-BUILD-PROMPT.md` (dark first). I did not restyle to the Codelytic look.
Screenshots use a fake API with fixture candles: they prove layout and flow, not live data. There are no "before" screenshots (I fixed A3 to A5 as I found them).

## Not yet audited (UNVERIFIED)
Live Binance/Bybit candles vs venue REST in the browser; real wallet sign-in (EVM, Solana); staging Supabase migration and RLS tests; live AI, budgets and fallback; OCR quality on a real chart (the fake screen source cannot read a symbol); jobs and restart behaviour; security scans; backup/restore; deploy and production smoke check.

## Live data check (2026-10-17, local dev database only; the real Supabase was not touched)
the compare script (`tools/spikes/src/compare-db-vs-rest.mjs`, with the DNS option set for this network) after about 14 minutes of live ingest (API on port 3012, ingest switched on):
- 1,264 closed candles (1m, 5m, 1h, last 60 each) vs each venue's REST: 0 differences.
- Second run, 1m only, last 6 candles (written by the live socket, not backfill): 48 candles, 0 differences.
- `/v1/status`: 8 of 8 feeds OK, no error-level log lines. Covered: Binance spot and perp for BTC, ETH, SOL; Bybit perp for BTC and ETH.
- Gaps against the release list: Bybit has no SOL perp; Coinbase and Kraken have no candles (cross-check venues, not enabled for analysis).
- Not measured: the 3-second chart latency and venue lag in the browser, engine event correctness on this data, restart without duplicates.

## Engine and jobs (2026-10-18, local dev database only)
- Determinism: replaying the last 3 days of BTCUSDT perp from the database twice, and once from an exported file, gives the same event counts and the same stream hash and state hash each time (`pnpm engine:replay`).
- Restart: the API was stopped with a forced kill (a crash) twice and started again. `tools/spikes/src/dup-check.mjs` found no duplicate candles, engine events (same payload), setups or setup transitions before or after. After the first restart, which followed a 7 hour gap, the engine caught up on each instrument (about 170 to 230 events written; 2 earlier events retracted for SOLUSDT perp because the gap was backfilled). The restart after that wrote nothing new, and stored candles still matched venue REST (240 of 240).
- Background jobs observed running: warm-up seeding, backfill queue (17 jobs completed), feed monitor, partition maintenance at start, retention pass (ran twice, nothing due), the daily `md.reconcile` job (scheduled for 03:00 UTC; I queued it by hand and it completed).
- A11 (S2, fixed): cohort base rates were refreshed only on an hourly timer that first fires an hour after start, so a server restarted more often than hourly never refreshed them (0 rows after boot). Now also run 30 seconds after start: 18 cohort rows appeared after a restart. Rows with n below 30 are stored with `sufficient = false` (n = 7 seen) and the API only gives a base rate at n >= 30.
- Not exercised: the account-deletion purge (no account to delete on the dev database), the calibration job (daily timer, still waits 24 h after start, same restart weakness as A10; backlog), notifications and outcomes on live data beyond the 287 shadow outcomes already stored.
- `apps/worker` is an empty stub. With `APP_ROLE=all` every job above runs inside `apps/api`, so a single process runs ingest, engine, queue and jobs. Splitting them is not done.
- Engine start rebuilds each instrument from the beginning of its stored history (log shows "from 1970"). Fine at this size (a few seconds), but start-up time grows with history (backlog).

## Security pass (2026-10-18)
- Secrets: history scan, 86 commits, no leaks (gitleaks, repo config). The working-tree scan flagged only generated or ignored files: `.env.local` (git-ignored, expected), Next build output (preview keys it generates, and the public Supabase anon key, a JWT, in the client bundle). None of the server secrets in `.env.local` (database URLs, token secret, salt, Turnstile secret, model keys) appears anywhere in the built web bundle. No `.env` files are tracked except the two `.env.example`.
- Dependencies: `pnpm audit` (all dependencies): no known vulnerabilities.
- Auth on every route: the running API listed 81 routes. Without a token, 77 answered 401, `/metrics` answered 404 (it does not exist without `METRICS_TOKEN`), and only `/healthz`, `/readyz` and `/v1/status` answered 200 (public by design; they return no user data). Admin routes use JWT plus the admin guard and IP allow-list (covered by `apps/api/test/hardening.e2e.test.ts`; not re-tried with a real non-admin token).
- API headers (helmet), CORS (a foreign origin gets no allow header, the configured origin does), problem+json errors with a correlation id, JSON bodies capped at 64 KB (a 100 KB body got 413), uploads: memory only, 6 MB, one file (the guard runs first, so an unauthenticated 7 MB upload got 401).
- Log redaction: requests log method, path, status and timing only. A request carrying a fake bearer token, cookie, Turnstile header and invite code left none of them in the log.
- A12 (S2, fixed): the web app sent no security headers. Added nosniff, frame deny, no referrer, opener isolation, HSTS and a permissions policy (mic and screen capture for itself only) in `apps/web/next.config.mjs`, with a test. No CSP yet (backlog): the speech and OCR workers need a tested allow-list.
- Not checked: SSRF and injection by fuzzing (the code never fetches a user-supplied URL; queries are parameterised), the real Supabase auth settings, Cloudflare/Railway edge settings, rate limits under load.

## API contract and consistency pass (2026-10-18)
Method: new `apps/api/test/contract-probe.e2e.test.ts` boots the real app on a throwaway database, signs in as a fully onboarded user and walks all /v1 routes (valid id, malformed id, empty body). It does not touch the dev database or your Supabase.
- Result: 0 server errors after the fix below; every 4xx is problem+json with `code`, `status` and `correlationId`; every admin route answers an ordinary user 403 (41 of 41 probes); JSON GET lists carry an ETag and answer 304 on `If-None-Match`; list endpoints reject `limit` of 0, -1 and text with a problem+json error and return `items` and `nextCursor`. Idempotency, rate limits (429) and the gate are covered by the existing 280 API tests, all passing.
- A13 (S2, fixed): `GET /v1/instruments/<not a uuid>/candles` answered 500 (the licence guard ran before the id check and Postgres rejected the cast). Now a 422 problem+json. Covered by the probe.
- A14 (S3, fixed): stale text said the HTML dev client at `/dev` still exists (`.env.example`, `docs/deploy-railway.md`); it was retired in F4. Corrected.
- Frontend types vs contracts: the web error table is a `Record<ErrorCode, ...>`, so a new backend code fails the web build until it has a message (already enforced). `InstrumentDto` in the web is hand-written, not generated from the API (a drift risk, backlog).
- A15 (S3, open): no OpenAPI document is generated; the plan documents (A07, B04) still list routes that were renamed or never built (billing, chat threads, exchange connections, `/v1/gates/...`, `/v1/plans/:id/gate`, journal export, notification prefs, backtest admin). The running route table (81 routes) is the truth; the plan documents have not been brought in line.
- A16 (S3, open): `tsc` does not clear `dist`, so a local `pnpm build` keeps stale files (a leftover `dist/dev` from the retired dev client). Railway builds from a clean checkout, so deploys are not affected.

## Dead and fake code, production hygiene (2026-10-18)
- Greps over shipped source (`apps/api/src`, `apps/web/src`, `packages/*/src`, tests excluded) for mock, demo, fixture, lorem, TODO, FIXME, HACK: no real hits (only the word "placeholder" in the AI number-guard, which is the feature). `console.*`: only in the database CLI tools (migrate, smoke), which are meant to print. No seed users, test wallets or sample rows in shipped code. The only dev seed in a migration is the `DEV-BETA-0001` invite (A7, removed by the migrate CLI).
- `localhost` in shipped source: the API binds `127.0.0.1` outside production, the web falls back to `http://localhost:3002` when `NEXT_PUBLIC_API_URL` is unset, and the WebSocket URL falls back to the request host. All legitimate except the web fallback (A17).
- A17 (S2, fixed): a hosted production build of the web app with no API address would silently point the browser at localhost. `next.config.mjs` now refuses the build on Railway (or with `REQUIRE_PUBLIC_WEB_ENV=true`) unless `NEXT_PUBLIC_API_URL` is an https address and the Supabase URL and anon key are set. Local builds are unchanged.
- A18 (S2, fixed): the web app now has its own Railway service config (`apps/web/railway.json`) and a section in `docs/deploy-railway.md`. Production build and start verified locally with the public variables set; a real Railway deploy is UNVERIFIED (needs your Railway project and domain).
- Replay adapter (A9, now closed as not reachable): `ReplayProvider` is exported from `packages/market-data` but nothing under `apps/api/src` or `apps/web/src` imports it, and the compiled API contains no reference to it. Only the spike tools and tests use it. It is not a runtime path.
- Unreferenced modules: none (dependency-cruiser over 260 source modules). Knip lists only unused exported types and constants (about 37 values, none dead modules) and four unused package dependencies (`@smc/contracts` in `db` and `testing`, `@smc/db` is now used by the spikes). Left as is; no behavioural risk (backlog).
- Stubs: `apps/worker/src/main.ts` (empty by design until M6).
