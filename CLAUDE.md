# SMC Copilot

Browser-based, Meet-style Smart Money Concepts trading assistant, crypto first. The user stays in control: no autonomous trading. Backend first, pnpm + Turborepo monorepo, NestJS 11, TypeScript 5.9 strict.

**Owner priority:** build the tech and make it work through live testing; everything else can come later.

## Where things are

- Plan: `docs/plan/` (read `00-AUDIT-AND-TRACEABILITY.md`, then Set B for scope, Set A for design). `set-b/sql/` is the canonical schema.
- Running state: `docs/PROGRESS.md`. Decisions: `docs/DECISIONS.md`. Deferred work: `docs/backlog.md`.
- Phases 0-10 as in the owner's brief; each ends with a report and a stop. Only the owner starts the next phase.

## Commands

```bash
pnpm install
pnpm build            # turbo, topological
pnpm typecheck
pnpm test             # vitest per package
pnpm lint             # biome + tools/boundaries + dependency-cruiser
pnpm format           # biome --write
```

## Layout and dependency rules (A01 section 6)

```
apps/api, apps/worker          NestJS (worker is an entry stub until M6)
packages/contracts             Zod schemas: the single source of truth for every boundary
packages/smc-engine            PURE: no I/O, no Nest, no clock, no randomness, no node: imports
packages/market-data, ai, db   depend on contracts only
packages/capture-kit           browser library, depends on contracts only
packages/config, testing       env schema; golden datasets and replay harness
tools/                         boundaries checker, git hooks, spike tooling (not shipped)
```

Rules are enforced by `tools/boundaries` + `.dependency-cruiser.cjs` and have negative tests. A new package must be added to the allow-list in `tools/boundaries/src/check.mjs`.

## Invariants (never trade these for speed)

1. No autonomous trading; the gate token is single-use, 60 s, plan-hash bound; voice can never confirm (DB enforces `confirmed_via = 'UI_TAP'`).
2. Zero retention of screen frames and audio (no image/audio column, nothing on disk or in logs).
3. Engine is pure and deterministic; no look-ahead; close-based BOS/CHoCH.
4. AI explains, never invents numbers (reference ids and placeholders, validated).
5. Probabilities only with n >= 30.
6. Egress reads only the `instrument_license` view; default `INTERNAL_ONLY`.
7. Instrument = (venue, market type, symbol); cross-checks compare the same market type only.
8. Data classes D0/D1/D2 enforced in `LlmRouter`; no wallet/email/IP/user id to a model.
9. Wallet-first identity; email optional; nothing country-specific.
10. No secrets in repo, logs, snapshots or chat.
11. Spend controls before any real model call at scale.
12. Zod contracts in `packages/contracts` are the source of truth.
13. Package boundaries enforced by lint.

## Conventions

- Tests first; conventional commits; one logical change per commit; branches `phase-N/step-M-name`.
- Secrets live in `.env.local` (git-ignored) or SOPS files; only `.env.example` is committed. Never print secret values.
- Supabase is hosted (no Docker for it). Local SQL smoke tests use plain Postgres with `0000_dev_shims.sql`.
- Verify library APIs against current official docs, not memory.
- Windows host, Linux CI/VM: LF line endings (`.gitattributes`), Node scripts over shell where practical.
