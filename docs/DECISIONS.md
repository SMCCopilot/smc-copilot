# Decision records

Short records of choices that deviate from, resolve, or extend the plan in `docs/plan/`. Newest last.

## D-001: The original "Auto Pilot" PRD is lineage, not scope

- **Context:** `docs/plan/set-a|set-b/0-first_proj_scope_smc_copilot_app.md` (identical copies) describes an autonomous trading system with PAPER/LIVE modes and broker adapters. A01 section 1.1 deliberately inverts it: SMC Copilot assists a human and never trades on its own.
- **Options:** (a) build the PRD as written; (b) reuse its process ideas only.
- **Choice:** (b). Reused: hard filters vs soft scores, reason codes, strategy versioning, decision journal including rejects, no silent learning, replay without look-ahead. Not built: PAPER/LIVE modes, broker adapters, any automated order path.
- **Consequences:** invariant 1 stands. A01 still cites the stale name `0-first_prd_smc_copilot_app.md` ("SNC Pilot"); harmless.

## D-002: Schema ownership and migration numbering

- **Context:** `docs/plan/set-b/sql/` is canonical, but Drizzle cannot express partitions, views, triggers or functions. Files `0010` and `0011` are reserved for the upgrade path, so a new MVP migration cannot take the next free number.
- **Choice:** `packages/db/migrations/` holds a verbatim copy of `0001`-`0009`, with a CI test that its checksums equal the files in `docs/plan/set-b/sql/`. The Drizzle schema is hand-written for typed queries and checked against the live schema in CI. New MVP migrations use a separate series starting at `0100_`; `upgrade/0010` and `0011` stay as the plan has them.
- **Consequences:** `B03` and `A06` are generated from the SQL, so any change to canonical SQL must regenerate them; do not hand-edit tables elsewhere.

## D-003: Browser spike page lives in `tools/spike-web`

- **Context:** spikes S1, S3, S4 need one browser test page that is not in the A01 monorepo layout.
- **Choice:** `tools/spike-web`, a static Vite app, outside `apps/` and `packages/` and excluded from the package boundary rules. Reusable parts move into `packages/capture-kit` in Phase 7.

## D-004: Separate Binance spot and perp hosts

- **Context:** B02 lists one `BINANCE_WS_URL` defaulting to `data-stream.binance.vision`, which is the market-data-only host for spot. USD-M perpetuals are on a different host.
- **Choice:** four variables (`BINANCE_WS_URL`, `BINANCE_REST_URL`, `BINANCE_PERP_WS_URL`, `BINANCE_PERP_REST_URL`) with defaults; current perp endpoint paths are re-verified against Binance docs in Phase 1 **[verify]**.

## D-005: Toolchain versions

- **Context:** the registry is ahead of the plan (NestJS 12, TypeScript 7, Vitest 5 exist). The plan and the product owner specify NestJS 11 and TypeScript 5. `nestjs-zod` 5.5 declares support for Nest 10/11 and `@nestjs/swagger` up to 11.
- **Choice:** NestJS 11.x, `@nestjs/swagger` 11.x, TypeScript 5.9, Zod 4, Vitest 4, Biome 2.5, Turborepo 2, pnpm 10. Node: `engines >=22.18`, CI on 22 and 24, production image on Node 24 LTS (Node 22 is in maintenance).
- **Consequences:** revisit NestJS 12 and TypeScript 7 after the closed beta; not in scope now.

## D-006: How package boundaries are enforced

- **Choice:** three layers: (1) `tools/boundaries` checks every `packages/*/package.json` against an explicit allow-list and scans `smc-engine` source for clocks, randomness, I/O and framework imports; (2) `dependency-cruiser` checks real imports (no app imports, no cross-package relative paths, no Node builtins or Nest in the engine, capture-kit and contracts); (3) `tsconfig` for `smc-engine`, `capture-kit` and `contracts` sets `types: []` so Node globals do not exist at all. Negative tests prove each rule fails when violated.
- **Consequences:** a new package must be added to the allow-list deliberately. `smc-engine` cannot use `node:crypto`; event ids (`sha1`) need a pure hash implementation in Phase 2.

## D-007: Database environments

- **Choice:** hosted Supabase dev project for integration runs (credentials in `.env.local`, no Docker for Supabase); a plain local Postgres with the dev shims (`0000_dev_shims.sql`) for the SQL smoke test; CI runs the smoke test on Postgres 16 and 17 (Supabase may default to 17; the plan only tested 16).
