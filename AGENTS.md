# Offerly — Agent Guide

AI Career Copilot SaaS. Product vision: `PROJECT_CONTEXT.md`. Binding engineering rules: `.specify/memory/constitution.md` (KISS/YAGNI are binding; small reviewable diffs).

## Monorepo layout

pnpm + turbo workspace:

- `apps/web` — Next.js 16 / React 19 frontend (port 3000). Server components by default.
- `apps/api` — NestJS backend (port 3001). Feature modules under `src/modules/`.
- `packages/types` — shared TS types + DB row types (`db.ts`), dependency-free on purpose.
- `supabase/migrations` — SQL migrations, applied via `supabase db push`.

Commands (repo root): `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm bench:ai`, `pnpm report:cost`. Local setup: `RUNNING_LOCALLY.md`.

## Module boundaries (constitution §II)

Modular monolith. Modules communicate through explicit interfaces — **no cross-module imports of internals**. Shared AI building blocks live in the `ai` module; feature modules (`candidate-profiles`, `jobs`, `cv-review`, `cv-improvements`, `coach`) consume them, never reach into each other.

## AI module (`apps/api/src/modules/ai/`)

- `prompts/` — versioned prompt templates. Contract: `PromptTemplate<TInput, TOutput>` in `prompt.types.ts` (`templateVersion`, system/user builders, zod `schema`, `validate`, `cacheInput`, `maxTokens`, `modelTier`). Assemble with `buildPrompt()`; run through `AiService` (cache + usage logging + repair retry). Bump `templateVersion` on every intentional prompt change — it is part of every cache key. Off-contract legacy templates: `apply-generate.v1` (not redesigned) and `coach.v1` (rollback via `COACH_TEMPLATE_VERSION=v1`).
- `schemas/` — zod mirrors of the `packages/types` AI shapes; the API boundary owns validation.
- `matching/` — deterministic engine: `aliases.ts` (skill alias map), `prepass.ts` (resolves requirements without the LLM), `weights.ts` (`WEIGHTS_V1` + `computeScore`), `static-components.ts`.
- `evidence.ts` — deterministic evidence verifier: every `status:'stated'` item's quote must substring-match normalized source text; failures are flagged and confidence-clamped.
- `profile-extraction.ts` / `profile-validation.ts` / `profile-merge.ts` / `profile-paths.ts` — S1 extract / S3 adjudicate / user-correction merge / Evidenced-path helpers.
- Model routing: `LLM_MODEL__<TEMPLATE_NAME>` > `LLM_MODEL_CHEAP`/`LLM_MODEL_STRONG` > `LLM_MODEL`.

## Key invariants (spec 003 — do not break)

- **Evidence-only extraction:** no stated fact without a verbatim quote; the verifier, not the model, decides what survives.
- **UNKNOWN ≠ MISSING:** `unknown` = profile field itself is unknown; `missing` = profile affirmatively lacks a stated requirement. Never infer `missing` from silence.
- **Deterministic scoring:** identical verdicts + weights → bit-identical score. No LLM in the score path.
- **No raw CV text in matching/coach prompts** — they consume the Candidate Profile; raw CV goes only into extraction/review/improvement templates.
- **Untrusted data:** user text (CV/JD) goes in delimited data blocks, never interpolated into system-prompt instructions (constitution §III).

## Tests

Vitest in `apps/api/test/`, all offline: mocked `LlmProvider` (queued JSON responses) + `test/helpers/fake-supabase.ts` (in-memory Supabase client). Test prompt assembly and response *handling*, not model output (constitution §IV). A bug fix ships with the test that would have caught it.

## Benchmark harness

`pnpm bench:ai` → `apps/api/scripts/ai-benchmark.ts`. Modes: `replay` (default, offline, recorded responses — CI-safe), `live` (real provider), `record` (re-record fixtures). Dataset: `apps/api/test/fixtures/ai-benchmark/`; reports written to `fixtures/ai-benchmark/reports/<templateVersion>.md`. **Any change under `prompts/` must ship with a re-run report** (gating automation deferred, T6.2).

## Migrations

One timestamped SQL file per change in `supabase/migrations/` (`YYYYMMDDHHMMSS_name.sql`). RLS owner-only policies on every user-data table; user tables are accessed via `SupabaseService.forUser(token)` (service role only for cross-user/system work like the LLM cache and usage records). Extend `packages/types/src/db.ts` row types in the same change.

## Adding a prompt template (checklist)

1. New file in `prompts/` implementing `PromptTemplate` (version `name.v1`).
2. Zod schema in `schemas/` (+ shared type in `packages/types` if reused).
3. Unit tests: assembly (data blocks, cache input) + validator edge cases.
4. `pnpm bench:ai` report if it touches extraction/matching quality.
5. Env override works automatically via `LLM_MODEL__<NAME>`.
