# Decisions — T1.1 (monorepo scaffold) + T4.1 (database migrations)

Date: 2026-07-28. Phase 1 + Phase 4 groundwork only; no feature code.

## Dependency versions (exact, pinned)

| package | version | note |
|---|---|---|
| next | 16.2.12 | latest stable 16.x — matches plan (Next.js 16) |
| react / react-dom | 19.2.8 | latest stable 19.x — matches plan (React 19) |
| typescript | 5.9.3 | **deviation:** latest 5.x, not 7.x. TypeScript 7 (`7.0.2`) is the new native-compiler line; NestJS/`tsc` build tooling and `@types/*` compat is not yet proven against it. KISS: stay on the toolchain NestJS officially supports. Revisit post-MVP. |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | Tailwind v4, CSS-first config (`@import "tailwindcss"` in `app/globals.css`), no `tailwind.config.js` needed |
| turbo | 2.10.7 | |
| @nestjs/common, core, platform-express | 11.1.28 | NestJS 11 |
| @nestjs/cli | 11.0.24 | build/dev runner only |
| eslint | 9.39.5 | **deviation:** eslint 10.8.0 exists, but `eslint-config-next@16`'s plugins (`eslint-plugin-import`, `eslint-plugin-jsx-a11y`, `eslint-plugin-react`) declare peer support only up to eslint 9. Pinned 9.x until those peers catch up. |
| eslint-config-next | 16.2.12 | used via its native flat-config entry points (`eslint-config-next/core-web-vitals`, `eslint-config-next/typescript`) — the legacy `FlatCompat` route crashes on a circular plugin reference |
| typescript-eslint | 8.65.0 | shared base flat config in `packages/config/eslint/base.mjs` |
| class-validator / class-transformer | 0.15.1 / 0.5.1 | for the global ValidationPipe (plan §3) |
| rxjs / reflect-metadata | 7.8.2 / 0.2.2 | NestJS runtime requirements |
| @types/node | 26.1.2 | matches Node 24 runtime |
| @types/react / @types/react-dom | 19.2.17 / 19.2.3 | |

All versions are exact (no `^` ranges) per plan §11 dependency hygiene; the lockfile pins everything transitively.

## Structural decisions

- **`packages/types` builds to `dist/` with `tsc`** and consumers import the compiled output (`main`/`exports` → `dist`). Chosen over source-TS exports because the NestJS `tsc` build cannot reliably transpile TS from `node_modules`. Turbo's `^build` dependency guarantees build order.
- **Shared tsconfig bases** live in `packages/config/tsconfig/{base,nextjs,nestjs}.json`; `strict: true` everywhere, plus `noUncheckedIndexedAccess`. NestJS base uses `module: CommonJS` + decorators; Next.js base uses the `next` plugin and `jsx: preserve`.
- **Shared eslint config** is a single minimal flat config (`packages/config/eslint/base.mjs`, typescript-eslint recommended). The web app uses `eslint-config-next`'s own flat config instead of the shared base — framework rules matter more there; api/types use the shared base.
- **API versioning:** global prefix `api/v1` (plan §3) with `/health` excluded so uptime checks stay unprefixed.
- **`cvs.is_active` defaults to `true`** — plan says "one active CV per user" but not the default; a freshly uploaded CV being active is the least surprising behavior. Uniqueness enforcement is app logic (T5.1), not a DB constraint, per plan.
- **DTO surface in `packages/types` is intentionally minimal** (health, profile update, job/application CRUD, usage summary, coach message, apply generate) — enough to type the plan §3 endpoints; `jsonb` result columns are `unknown` on row types because their shape belongs to the AI module that produces them (T5.x), not to shared row types (YAGNI).
- **No `packages/ui`, no `apps/extension`** — explicitly deferred by plan §1.
- **`pnpm-workspace.yaml` `allowBuilds`:** `sharp` and `unrs-resolver` build scripts approved (Next.js image optimization + eslint resolver need them).
- **No test scripts yet** — `pnpm test` runs through turbo and trivially passes with zero test tasks; a test runner lands with the first real test (constitution: no infrastructure beyond the plan).
- **`supabase/config.toml`** generated via `pnpm dlx supabase init` (offline-safe). `supabase start` / `db lint` / `db reset` require Docker and were **not run here** — migrations are validated by review only.

## RLS policy decisions (deviations from a blanket reading of the task)

- **`subscriptions`: select-only for users.** Plan §2 + constitution §III state subscription rows are written *only* by webhook handlers. Webhooks use the service-role key, which bypasses RLS, so no insert/update/delete user policies were added — this makes client-driven subscription changes impossible at the database layer. The select policy exists so the API/UI can read the plan for UX hints.
- **`usage_records`: select-only for users** for the same reason — metering writes go through the API with the service-role key (plan §5).
- **`ai_messages`** has no `user_id`; all four operations are scoped through `exists (... parent conversation user_id = auth.uid())`.
- **`llm_cache`**: RLS enabled, zero policies → service-role only, exactly as planned.
- **Storage bucket `cvs`:** owner-only policies keyed on the path convention `<user_id>/<file>` via `(storage.foldername(name))[1] = auth.uid()`. The signed-upload flow (T5.1) must upload under that prefix. 5 MB limit and PDF/DOCX mime allowlist set on the bucket itself.
- **Triggers** are `security definer` with `set search_path = ''` and fully qualified names (supabase lint guidance): `auth.users` insert → `profiles` row; `profiles` insert → default `subscriptions` row (`plan='free'`, `status='active'`, `provider=null` until Stripe attaches).
- **No `updated_at` auto-update triggers** — the API sets `updated_at` on writes. Adding trigger machinery now is YAGNI.

## Environment

- The machine's **npm cache is root-corrupted** (`~/.npm/_cacache` EACCES); pnpm's own store works fine and was used for everything. Not fixed (needs `sudo chown`); noted so future `npx` failures aren't a surprise.
- `.env.example` documents Supabase (URL, anon, service-role, JWT secret), LLM provider key, Stripe (secret, webhook secret, publishable), `API_URL`, `WEB_URL`, plus the `NEXT_PUBLIC_*` mirrors the web app needs.

## Verification (this machine, 2026-07-28)

- `pnpm install` — clean, lockfile passes pnpm supply-chain policy check.
- `pnpm typecheck` — 4/4 packages pass.
- `pnpm lint` — 3/3 lint tasks pass (config package has no lintable sources).
- `pnpm build` — types (tsc), api (nest build), web (next build, static `/` prerendered) all pass.
- API smoke test: `node apps/api/dist/main.js` → `GET /health` returns `{"status":"ok"}`; `/api/v1/health` correctly 404s.
- `pnpm dev` not run end-to-end (two persistent servers); both `dev` scripts are the standard `next dev -p 3000` / `nest start --watch`.

---

# Decisions — Frontend (T1.4, T2.1, T2.3, T3.1–T3.3, T5.3/T6.2/T7.2 UIs, T8.2–T8.3, T9.2, T10.3)

Date: 2026-07-28. Scope: entire `apps/web` frontend. Backend was being built in parallel; everything below codes against the plan §3 endpoint table + `packages/types` DTOs.

## Dependencies added (exact pins, per repo convention)

- `@supabase/ssr@0.12.3` and `@supabase/supabase-js@2.110.9` — the only new runtime deps, as authorized. No DnD, animation, state-management, or font libraries.

## Frontend-local contract types (`apps/web/lib/contract.ts`)

`packages/types` intentionally ships a minimal DTO surface (T1.1 decision). Rather than editing it (the backend agent owns it in parallel), the web app defines the shapes it needs locally — these are the contract the backend should implement; drift means changing one file:

- `CvAnalysisResult` / `JobMatchResult` — the `jsonb` result payloads for `cv_analyses.result` / `job_matches.result` (sections+improvements+truncation flag; strengths+gaps+recommendations+low_confidence).
- `CreateCvUploadRequest/Response` — signed-URL upload flow (`POST /cvs` with `{filename, content_type}` → `{cv, upload_url}`; paste variant `{pasted_text}` → `Cv`). Client PUTs the file directly to the signed Storage URL (plan §9).
- `ApplyGeneration` — `POST /jobs/:id/apply` response: `cover_letter`, `answers[]`, `recommendations[]`, `gaps_flagged[]` (honesty rule), `sample` (free-tier watermark).
- `CoachStreamEvent` — SSE frames for `POST /coach/conversations/:id/messages`: `event: token|notice|done|error` with JSON `data:`. `notice` carries the context-compaction message (spec §5.6).
- `CreateConversationRequest`, `CheckoutResponse`/`PortalResponse` (`{url}`), `UpgradeRequiredPayload` (402 body: `error`, `message?`, `feature?`, `plan_required?`, `limit?`, `used?`).
- **`GET /coach/conversations/:id/messages` (history)** is consumed but not in the plan §3 table — the UI treats it as optional (catch → fresh conversation). Backend should add it or accept historyless reloads.

## Structural decisions

- **Route groups per plan §1:** `(marketing)` (`/`, `/pricing`), `(auth)` (`/login`, `/signup`, `/callback` as a route handler), `(app)` (guarded product: dashboard, cv, match, apply, tracker, coach, settings). `/onboarding` sits outside `(app)` so it renders without the app nav; the `(app)` layout redirects to it until `profiles.onboarding_completed` is true. Next 16 prints a "middleware → proxy" deprecation warning; `middleware.ts` kept because plan §1 names it explicitly and it still works.
- **Server components by default; interactive pages are client components.** Marketing/pricing/auth shells/layouts are server components. Data pages use a tiny `useApi` hook (loading/error/data/refetch — no state library) so every fetch has skeleton + empty + error states as required by spec §7.
- **API client split:** `lib/api-core.ts` (shared fetch core: bearer token, 402 → `PaywallError` with `UpgradeRequiredPayload`, error parsing), `lib/api.ts` (browser: token from `@supabase/ssr` browser client, 401 → redirect `/login?next=…`), `lib/api-server.ts` (server components, throws instead of redirecting). Coach SSE uses raw `fetch` + `ReadableStream` (EventSource can't POST with headers).
- **Onboarding guard is best-effort:** if `GET /profiles/me` fails in the `(app)` layout (API down), the shell renders anyway and pages show their own error states — an API outage must not lock users out of static shell.
- **Env fallbacks:** Supabase clients fall back to placeholder URL/key when `NEXT_PUBLIC_SUPABASE_*` is unset so `next build` prerenders without credentials; real values are required at runtime.
- **`@/*` path alias** added to `apps/web/tsconfig.json` (standard Next scaffold convention; wasn't configured).
- **Tracker DnD:** native HTML5 drag-and-drop on `md+` kanban, `<select>` dropdown status change on mobile (spec §5.5 allows either). Optimistic updates with rollback to last server state on failure; delete with `job_id` linked asks for confirmation (linked artifacts deleted with entry, per spec §5.5 "simplest"). The only linked-artifact signal in the schema is `applications.job_id`, rendered as a "Match linked" badge.
- **Next-best-action** is a pure rule engine (`lib/next-action.ts`): no CV → upload; CV but no applications → match; all rejected → improve CV; applied >7 days → follow up; else keep momentum. Rule-based (not LLM) so it works with exhausted quota (constitution §V).
- **Apply Assistant** shows an elapsed-seconds message after 10s (spec §5.4 "never a frozen spinner") and a SAMPLE watermark + banner when `sample: true`; 402 opens the contextual `PaywallModal` (T10.3) which states the attempted action and starts `POST /billing/checkout`.
- **Pricing page** prices Pro at $12/mo as display copy (spec sets no number; Stripe price ID lives backend-side). Free-tier numbers come from `PLAN_LIMITS`.
- **React-hooks v6 lint rules** (eslint-config-next 16): form state initializes from props via keyed components and `useState` initializers instead of `useEffect` sync; the one interval timer resets in the event handler.

## Verification (this machine, 2026-07-28)

- `pnpm install` — clean.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` for `@offerly/web` — all pass; `next build` compiles all 15 routes (4 static, 10 dynamic, 1 route handler + middleware).
- No live API calls attempted (backend not running); contract correctness is by type + plan §3.
- **Root-level `pnpm typecheck` also builds `@offerly/api`, which had an unrelated in-progress error (`extractText` in `cvs.service.ts`) from the parallel backend agent at the time of this run — not frontend scope.**

---

# Decisions — T2.2, T4.2, T5.1–T5.3, T6.1–T6.2, T7.1, T8.1, T9.1, T10.1–T10.2, T1.2 (NestJS backend)

Date: 2026-07-28. Full API implementation per plan §3 endpoint table.

## New dependencies (apps/api, exact versions)

| package | version | note |
|---|---|---|
| @supabase/supabase-js | 2.110.9 | anon/user-context + service-role clients |
| stripe | 22.3.2 | injected into StripePaymentProvider for testability |
| pdf-parse | 2.4.5 | **deviation:** v2 is a rewrite — class API `new PDFParse({ data }).getText()`, not v1's default function |
| mammoth | 1.12.0 | DOCX extraction; **no published @types** — local declaration in `apps/api/src/types/mammoth.d.ts` (extractRawText only) |
| vitest | 4.1.10 | unit tests, no NestJS e2e harness (constitution §IV priority order) |

## Architecture decisions

- **Supabase access:** `SupabaseService` (@Global) exposes `getAnonClient()` (AuthGuard `auth.getUser(token)` — simplest correct JWT validation, no JWKS plumbing), `forUser(token)` (per-request RLS-scoped client for all user-initiated queries), `getServiceClient()` (webhooks, usage_records, llm_cache only). No custom auth code.
- **AuthGuard is global** (APP_GUARD) with a `@Public()` opt-out used by `/health` and the Stripe webhook. Global `AllExceptionsFilter` sanitizes unknown errors to 500; 402s carry an upgrade payload `{ feature, upgrade: { plan: 'pro' } }`.
- **AI gateway (`AiService`)** is the only LLM caller. Cache key = `sha256(templateVersion + ':' + normalize(cacheInput))`; hits are logged with `cache_hit=true` and never consume quota. Structured-output calls retry once on parse/validation failure with a repair message; manual validators (no zod — the shapes are 3 small interfaces, a schema lib is YAGNI at this size). Concurrency limiter is hand-rolled (~25 lines, no p-limit dep); backoff = 3 attempts, 500ms·2ⁿ on 429/5xx. Provider failure surfaces as a clear 503 (`ServiceUnavailableException`), never an unhandled crash.
- **`cost_microcents` = millionths of a US cent** (1e-6 ¢). Pricing table per model in `ai.service.ts`; default model `gpt-4o-mini` ($0.15/$0.60 per 1M tokens → 15/60 microcents per token), env-overridable via `LLM_MODEL`/`LLM_BASE_URL`.
- **Prompt templates** in `modules/ai/prompts/*.v1.ts` export `templateVersion` + build/parse functions. User text is always inside `<cv_text>`/`<job_description>` data blocks with an explicit untrusted-data rule in the system prompt (prompt-injection rule, constitution §III); adversarial fixture covered by test.
- **Entitlements:** `EntitlementGuard` + `@Requires(feature)` per endpoint (not global — only gated endpoints pay the extra queries). Monthly quota counts `usage_records` for `cv_analysis`+`job_match` only, `cache_hit=false`, calendar month (apply is sample-gated and coach is blocked on free, so counting them would double-punish). Cache-hit exemptions are structural: re-analyzing a CV with an existing analysis, or re-matching a (job, active-CV) pair, is always allowed because cv rows are immutable ⇒ guaranteed cache hit. Pro soft-cap from plan §8.5 **not implemented** — PLAN_LIMITS says Infinity; adding a second limit source now is YAGNI.
- **Downgrade rule:** over-limit free users get 402 on `PATCH /applications/:id` unless the patch archives the entry; DELETE stays allowed (user-owned cleanup). "Read-only, never deleted" without per-entry ranking complexity.
- **Job match & apply live in the jobs module** (routes are `/jobs/:id/*`); match/apply cross into cvs only via the exported `CvsService`. Apply generations persist as `ai_conversations` rows (`kind='apply_assistant'`, context cv_id/job_id) so artifacts stay retrievable (T7.2 link).
- **Coach:** SSE via raw express `Response` (`@Res()`) — full control over headers and mid-stream error frames; Nest `@Sse()` can't send a proper HTTP error after streaming starts, so `prepareMessage` validates/inserts/compacts *before* headers flush. Compaction: >10 raw turns → older turns summarized by an LLM call into a `system-summary` row (visible in history = the user-visible notice) and the raw rows deleted.
- **Stripe webhook idempotency** uses a new table `processed_webhook_events(event_id PK)` — migration `20260728130000` (RLS enabled, no policies = service-role only). Insert-first, unique-violation (23505) = replay ⇒ no-op. `PaymentProvider.createPortalSession` takes `customerId` (not plan's `userId`) because Stripe's portal API requires it; the service resolves it from the subscriptions row. `current_period_end` read from subscription items (newer Stripe API nests it there) with top-level fallback.
- **CV upload flow:** `POST /cvs` with `{text}` = paste, with `{filename, content_type, size_bytes}` = creates the row + signed upload URL (path `<user_id>/<uuid>-<file>`, matching the storage RLS prefix), `POST /cvs/confirm` downloads + extracts. <50 extracted chars = scanned PDF ⇒ 422 `no_text_layer` with paste-fallback message. New CV (either flow) deactivates all others (one active per user).
- **UsageSummary `Infinity` serialized as -1** (existing dto contract in packages/types).
- **CI:** `.github/workflows/ci.yml` — pnpm/action-setup + setup-node 24 with pnpm cache, `install --frozen-lockfile`, lint, typecheck, test, build on PR + main.

## Verification (this machine, 2026-07-28)

- `pnpm install` clean; `pnpm typecheck`, `pnpm lint`, `pnpm build` pass from root; `pnpm test` = **37/37 vitest tests** (ai cache hit/miss + retry + 429 backoff + 503 degradation, prompt assembly + validators + truncation, entitlements free/pro decision matrix, JD heuristics, Stripe signature/idempotency with mocked stripe).
- Boot smoke test with dummy env: all plan §3 routes mapped; `/health` 200 public; `/api/v1/profiles/me` without token → 401; webhook without signature → 400. No live Supabase/Stripe/OpenAI used anywhere — all externals behind interfaces/mocks.

## Integration pass (2026-07-28, after parallel backend/frontend build)

- **Added `GET /api/v1/coach/conversations/:id/messages`** (history for resumed conversations) — the frontend assumed it; plan §3 omitted it. Read-only, ownership-scoped, no entitlement gate (a downgraded user can still read their own history). Frontend/backend contract is now fully aligned.
- **Deployment (T11.1 config):** `railway.json` at repo root (Nixpacks monorepo build `pnpm --filter @offerly/api build`, start `node apps/api/dist/main.js`, `/health` healthcheck). Web needs no config file: Vercel project with root directory `apps/web` picks up Next.js automatically. Supabase migrations deploy via `supabase db push` (run manually or as a release step). Chosen: Railway over Render (healthcheck + monorepo build in one file); both stay on free tier.
- **Remaining manual launch steps** (cannot be done from this repo): create Supabase/Vercel/Railway/Stripe projects, set env vars from `.env.example` on each platform, run `supabase db push`, point Stripe webhook to `/api/v1/billing/webhooks/stripe`, add Sentry DSNs when the free project exists (T11.2), and run the Playwright smoke suite against production (T11.3 — deferred until a live URL exists).
- **Not verified by design:** live end-to-end flows (signup → upload → analysis) — no live Supabase/Stripe/LLM credentials on this machine; all externals were mocked. First real deploy must run the T11.3 happy paths.

## Contract fixes (2026-07-28, local run)

- **CV upload contract misaligned frontend↔backend (bug fix).** Frontend sent `pasted_text` (backend expects `text`) and omitted `size_bytes` on the signed-upload request; it also read `upload_url` while the API returns `signed_url`, and never called `POST /cvs/confirm` — meaning uploaded files would never get text extraction. Fixed in `apps/web/lib/contract.ts`, `apps/web/components/cv-upload-form.tsx`, `apps/web/app/onboarding/page.tsx` to match the API contract in plan §3/§9: `{text}` for paste, `{filename, content_type, size_bytes}` → `{cv, signed_url, path}` → PUT file → `POST /cvs/confirm {cv_id}` (422 there = scanned PDF, paste fallback). Backend was authoritative per the plan; no API change.

## Billing flow fixes (2026-07-28, local run)

- **Stripe redirect 404:** checkout/portal URLs pointed at `/settings/billing`, a route that doesn't exist — billing UI lives on `/settings`. URLs changed in `billing.module.ts`; `settings-client.tsx` now shows a success/canceled banner (Suspense-wrapped `useSearchParams` component, URL cleaned via `history.replaceState`) and refetches usage ~2.5s after success so the plan badge flips once the webhook lands.
- **Unhandled webhook events now ACK 200** (`{ eventId, ignored: true }` union in `WebhookEvent`) instead of 400 — `stripe listen` forwards every event type (invoice.paid, customer.created…), and 400s caused pointless Stripe retries. Signature failures still 400.
- **Plan not upgrading locally is an environment issue, not code:** the webhook is the only subscription writer, so without `stripe listen --forward-to localhost:3001/api/v1/billing/webhooks/stripe` running (and `STRIPE_WEBHOOK_SECRET` set to its `whsec_…` — not the `sk_test_…` secret key) no event ever reaches the handler. Verified the handler logic with the existing mocked-Stripe tests (37/37).
