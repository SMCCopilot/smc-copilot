# Progress

Running state. A fresh session should be able to resume from this file and `CLAUDE.md` alone.

- **Current phase:** 0 (Foundations and risk spikes)
- **Owner priority:** build the tech and make it work through live testing; defer everything else.
- **Branches:** step 1-2 on `phase-0/step-1-monorepo-scaffold`, step 3 on `phase-0/step-3-api-skeleton`, steps 4-5 on `phase-0/step-5-spike-s2` (cumulative; the last holds everything)

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
- Router DNS does not resolve the Binance/Bybit API hosts (public DNS does). Binance perp WebSocket moved to a `/market` path (old path sends no frames). Bybit lag 72-82 ms. Lag unmeasurable here (clock/RTT); must be measured on the VM. See docs/spikes.md and DECISIONS.

## Open items for the owner

- **GitHub remote** (private recommended) so CI can run. Until then CI is UNVERIFIED.
- **`.gitignore` lines `.claude` and `docs/*`** were added by someone after I wrote the file. I kept them and un-ignored only the process docs (`DECISIONS`, `PROGRESS`, `backlog`, `spikes`, `engine-fidelity`). `docs/plan/` is already committed on this branch; say if you want the plan untracked.
- Supabase dev project credentials in `.env.local` (never in chat); key names are in `.env.example`.
- Spike inputs: 40 chart screenshots, 200 recorded phrases, device list.
