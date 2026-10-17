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
