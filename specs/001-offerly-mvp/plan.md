# Offerly MVP — Technical Implementation Plan

Spec: `specs/001-offerly-mvp/spec.md`
Constitution: `.specify/memory/constitution.md` (binding — especially §II modular monolith, §V AI cost, §VI free-tier-first)

## 0. Architecture Overview

- **Monorepo** (pnpm workspaces + Turborepo) containing the Next.js frontend, the NestJS backend, and shared packages. One backend deployable — a **modular monolith**, not microservices.
- **Supabase** provides: PostgreSQL, Auth (email + Google OAuth), Storage (CV files), and Row Level Security.
- **Vercel** hosts the frontend; **Railway or Render** free tier hosts the NestJS API.
- **Stripe** for subscriptions behind a payment-provider abstraction (crypto later).
- LLM access behind a provider abstraction with caching, token caps, and usage metering.

Why a monorepo for a solo dev: one repo, one CI, shared TypeScript types between frontend/backend (single source of truth for API contracts), and a future browser extension package that reuses those types. Turborepo keeps it fast; no microservice overhead.

## 1. Folder Structure

```
offerly/
├── apps/
│   ├── web/                      # Next.js 16 + React 19 (Vercel)
│   │   ├── app/                  # App Router routes
│   │   │   ├── (marketing)/      # landing, pricing
│   │   │   ├── (auth)/           # login, signup, callback
│   │   │   └── (app)/            # authenticated product
│   │   │       ├── dashboard/
│   │   │       ├── cv/
│   │   │       ├── match/
│   │   │       ├── apply/
│   │   │       ├── tracker/
│   │   │       ├── coach/
│   │   │       └── settings/     # profile, billing
│   │   ├── components/           # web-specific components
│   │   ├── lib/                  # api client, supabase client, hooks
│   │   └── middleware.ts         # session refresh, route protection
│   │
│   ├── api/                      # NestJS modular monolith (Railway/Render)
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── common/           # guards, interceptors, filters, decorators
│   │   │   └── modules/
│   │   │       ├── auth/
│   │   │       ├── profiles/
│   │   │       ├── cvs/
│   │   │       ├── jobs/
│   │   │       ├── applications/ # job tracker
│   │   │       ├── ai/           # LLM gateway: providers, prompts, cache, usage
│   │   │       ├── coach/        # conversations (uses ai module)
│   │   │       ├── billing/      # subscriptions, entitlements, webhooks
│   │   │       └── storage/
│   │   └── test/
│   │
│   └── extension/                # FUTURE: browser extension (placeholder only,
│                                 #  no build setup until post-MVP — YAGNI)
│
├── packages/
│   ├── types/                    # shared TS types: API DTOs, domain models, DB row types
│   ├── config/                   # shared tsconfig, eslint, tailwind presets
│   └── ui/                       # design system (only when ≥2 apps exist; for MVP
│                                 #  components live in apps/web — see note)
│
├── supabase/
│   └── migrations/               # SQL migrations, applied via Supabase CLI
├── specs/                        # this spec/plan
├── .specify/memory/constitution.md
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

Notes:

- `packages/types` is the only shared package created on day one. `packages/ui` and `apps/extension` are **named placeholders in this plan, not built** — creating them now is exactly the premature complexity the constitution rejects. When the extension ships, shared UI gets extracted then.
- NestJS modules map 1:1 to bounded domains; cross-module access goes through exported services only (constitution §II).

## 2. Database Schema (Supabase PostgreSQL)

All tables carry `user_id` (or join to a table that does) and have **RLS enabled**. `id` columns are `uuid default gen_random_uuid()`, timestamps `timestamptz default now()`. Migrations live in `supabase/migrations/`.

### `users`

Handled by **Supabase Auth** (`auth.users`) — we do not duplicate it. Our `profiles` table references it.

### `profiles`

| column | type | notes |
|---|---|---|
| id | uuid PK → auth.users.id | 1:1 with auth user |
| full_name | text | |
| current_role | text | nullable — progressive profiling |
| target_role | text | nullable |
| experience_level | text | nullable, asked later |
| location | text | nullable, asked later |
| visa_status | text | nullable, asked later |
| salary_expectation | jsonb | nullable, asked later |
| onboarding_completed | bool | default false |
| created_at / updated_at | timestamptz | |

### `cvs`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → profiles | RLS: owner only |
| file_path | text | Supabase Storage path, nullable if pasted |
| name | text | display label; defaults to filename, or "Pasted CV" |
| extracted_text | text | used for analysis |
| content_hash | text | sha256 of normalized text → cache key |
| is_active | bool | one active CV per user |
| created_at | timestamptz | |

### `cv_analyses`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| cv_id | uuid → cvs | |
| user_id | uuid → profiles | denormalized for RLS simplicity |
| score | int | 0–100 |
| result | jsonb | sections, improvements, model version |
| depth | text | `basic` \| `deep` (free/pro) |
| created_at | timestamptz | |

### `jobs`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → profiles | |
| title / company | text | |
| url | text | nullable |
| description_text | text | pasted JD |
| content_hash | text | cache key |
| created_at | timestamptz | |

### `job_matches`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → profiles | |
| cv_id | uuid → cvs | |
| job_id | uuid → jobs | |
| score | int | 0–100 |
| result | jsonb | strengths, gaps, recommendations |
| created_at | timestamptz | |

### `applications` (Job Tracker)

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → profiles | |
| job_id | uuid → jobs | nullable (manual entries allowed) |
| company / role | text | |
| status | text enum | `saved` `applied` `interview` `offer` `rejected` |
| applied_at | timestamptz | nullable |
| notes | text | |
| archived | bool | default false — free limit counts only non-archived |
| created_at / updated_at | timestamptz | |

### `ai_conversations` + `ai_messages`

`ai_conversations`: `id`, `user_id`, `kind` (`coach` | `apply_assistant`), `context` jsonb (linked cv_id/job_id), `created_at`.
`ai_messages`: `id`, `conversation_id` FK, `role` (`user`|`assistant`|`system-summary`), `content` text, `token_count` int, `created_at`. Older turns get compacted into a `system-summary` message (spec: user is told when compaction happens).

### `subscriptions`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → profiles | unique |
| provider | text | `stripe` (future: `crypto`) |
| provider_customer_id | text | |
| provider_subscription_id | text | |
| plan | text | `free` \| `pro` |
| status | text | `active` `past_due` `canceled` `trialing` |
| current_period_end | timestamptz | |
| updated_at | timestamptz | |

Written **only by webhook handlers**, never by client calls (constitution §III).

### `usage_records` (metering + quota)

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → profiles | |
| operation | text | `cv_analysis` `job_match` `apply_generate` `coach_message` |
| tokens_in / tokens_out | int | |
| cost_microcents | int | estimated cost — weekly spend review (constitution §V) |
| cache_hit | bool | |
| created_at | timestamptz | |

Quota check = count of `usage_records` in current month for free-tier operations. No separate "limits" table needed — limits are config constants per plan (see §6).

### `llm_cache`

| column | type | notes |
|---|---|---|
| cache_key | text PK | sha256(template_version + normalized input) |
| response | jsonb | |
| created_at | timestamptz | for TTL eviction |

Shared across users (a CV+JD pair is identical work regardless of who asked) but contains no per-user identifiers beyond the input itself.

## 3. API Architecture

- NestJS REST API, versioned prefix `/api/v1`. OpenAPI generated from decorators; `packages/types` keeps DTOs in sync manually for MVP (codegen later if drift becomes painful).
- Modules and their main endpoints:

| module | endpoints |
|---|---|
| profiles | `GET/PATCH /profiles/me` |
| cvs | `POST /cvs` (signed-URL flow), `GET /cvs`, `PATCH /cvs/:id` (rename/set active), `DELETE /cvs/:id`, `POST /cvs/:id/analyze`, `GET /cvs/:id/analyses` |
| jobs | `POST /jobs`, `GET /jobs/:id` |
| job match | `POST /jobs/:id/match`, `GET /jobs/:id/match` |
| applications | CRUD `GET/POST/PATCH/DELETE /applications` |
| apply assistant | `POST /jobs/:id/apply` (generate letter/answers) |
| coach | `POST /coach/conversations`, `POST /coach/conversations/:id/messages` (SSE stream) |
| billing | `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/webhooks/stripe` |
| usage | `GET /usage/me` (quota display on dashboard) |

- **Long-running AI calls**: streaming responses (SSE) for coach and apply generation; score-type calls (match, analysis) are single requests with generous timeouts. A queue (e.g. BullMQ) is **deferred** — synchronous-with-streaming is acceptable at MVP scale; add a queue only when latency/timeout metrics demand it (constitution §VI: optimize measured bottlenecks).
- Global pipes: DTO validation (`class-validator`), global exception filter, request logging interceptor.

## 4. Authentication Strategy

- **Supabase Auth**: email/password + Google OAuth. Email verification on.
- Frontend: `@supabase/ssr` — server-side session in cookies, `middleware.ts` refreshes tokens and guards `/dashboard` etc.
- Backend: NestJS `AuthGuard` validates the Supabase **JWT** (RS256 via Supabase JWKS, or HS256 shared secret — whichever the project issues) on every request except `/billing/webhooks/*` and health checks. The guard attaches `userId` to the request.
- No custom auth code, no password storage, no session tables. Supabase owns it.

## 5. Authorization Strategy

Two layers, both server-side (constitution §III):

1. **RLS on every table** — `user_id = auth.uid()` policies. Defense in depth: even a buggy query can't leak cross-user data.
2. **API-level ownership checks** — services scope every query by the authenticated `userId`; mutations verify ownership before write. Backend connects with the **service-role key only where RLS must be bypassed** (webhooks, usage metering); everything user-initiated goes through policies scoped to that user.

## 6. Subscription & Feature Gating

- Single source of truth: `subscriptions` table + plan limits in code:

```ts
// packages/types/src/plans.ts (concept)
const PLAN_LIMITS = {
  free: { aiRequestsPerMonth: 5, cvAnalyses: 1, storedCvs: 1, activeApplications: 10,
          applyAssistant: 'sample', coach: false, matchDepth: 'basic' },
  pro:  { aiRequestsPerMonth: Infinity, cvAnalyses: Infinity, storedCvs: Infinity, activeApplications: Infinity,
          applyAssistant: 'full', coach: true, matchDepth: 'deep' },
};
```

- NestJS `EntitlementGuard` + `@Requires(feature)` decorator on gated endpoints. Checks run **server-side on every request** (constitution §VI).
- Frontend reads `GET /usage/me` + plan to render paywalls/locked UI — UX hint only, never enforcement.
- Downgrade rule (spec §6): over-limit tracker entries become read-only, never deleted.
- Quota counting is per calendar month from `usage_records`.

## 7. Payment Abstraction

- `billing` module exposes a `PaymentProvider` interface:

```ts
interface PaymentProvider {
  createCheckoutSession(userId: string, priceId: string): Promise<{ url: string }>;
  createPortalSession(userId: string): Promise<{ url: string }>;
  handleWebhook(payload: Buffer, signature: string): Promise<SubscriptionEvent>;
}
```

- MVP implements `StripePaymentProvider` only. Webhook signature verification is mandatory; subscription state changes **only** via webhook handlers.
- Crypto support = a second `PaymentProvider` implementation later. The abstraction costs ~30 lines today and prevents a rewrite; anything more elaborate (multi-provider routing, dunning logic) is YAGNI and deferred.

## 8. LLM Architecture (`ai` module)

The `ai` module is the **single gateway** — no other module calls an LLM provider directly.

### 8.1 Provider abstraction

```ts
interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): AsyncIterable<string>;
}
```

- MVP: one implementation (cheapest model that passes manual quality check per task — constitution §V). A second provider is a config swap, not a refactor.
- Model routing table in config: `cv_analysis → model X`, `coach → model Y`. Escalation to stronger models only where quality measurably matters.

### 8.2 Prompt management

- Prompts are **versioned template files** in `api/src/modules/ai/prompts/` (e.g. `cv-analysis.v3.ts`), each exporting `templateVersion` used in cache keys. No DB-stored prompts, no prompt CMS — version control is the prompt manager.
- User-provided text (CV, JD) is injected as clearly delimited **data blocks**, never into instruction sections (prompt-injection rule, constitution §III).

### 8.3 Caching

- Cache key: `sha256(templateVersion + normalized input)`. Normalization: lowercase, whitespace collapse, strip PII-light noise where safe.
- Lookup order: `llm_cache` table → provider. Cache hits are logged with `cache_hit=true` and do **not** count against the user's AI quota.
- TTL eviction by `created_at` (e.g. 90 days) as a scheduled job later; unbounded for MVP.

### 8.4 Token optimization

- Hard input caps: CV/JD truncated intelligently (keep sections in priority order, drop from the tail) with the user told what was analyzed.
- `max_tokens` set on every call.
- Structured output (JSON mode / schema) for analyses and matches — shorter, parseable, cheaper.
- Every call logs `tokens_in/out` and estimated cost to `usage_records`.

### 8.5 Rate limits

- Per-user: free tier monthly quota (§6); pro tier a generous soft cap (e.g. 500 AI requests/month) to prevent abuse and runaway spend.
- Global: concurrency limiter (e.g. `p-limit` or Bottleneck) around provider calls; exponential backoff on 429s.
- Circuit breaker: if provider errors or the daily spend cap is hit, AI features degrade to cached/generic guidance instead of failing or overspending (constitution §V).

## 9. File Storage Strategy

- **Supabase Storage**, one private bucket `cvs`.
- Upload flow: client requests a **signed upload URL** from the API → uploads directly to Storage → API triggers text extraction (pdf-parse / mammoth) and stores `extracted_text` + `content_hash`.
- Files are never served directly; download (if ever needed) via short-lived signed URLs.
- Size limit (e.g. 5 MB) enforced at signed-URL creation; accepted types: PDF, DOCX. Scanned PDFs without a text layer → error + paste fallback (spec §5.2).
- No image processing, no OCR in MVP.

## 10. Deployment Architecture (free tiers)

```
                 ┌─────────────┐
   users ───────▶│   Vercel    │  apps/web (Next.js, free hobby tier)
                 └──────┬──────┘
                        │ HTTPS, Supabase JWT
                        ▼
                 ┌─────────────┐        ┌──────────────────┐
                 │Railway/Render│───────▶│     Supabase      │
                 │  apps/api    │        │ Postgres + Auth   │
                 │  (free tier) │        │ + Storage (free)  │
                 └──────┬──────┘        └──────────────────┘
                        │
                        ▼
                 LLM provider API          Stripe (pay-per-use, no fixed cost)
```

- CI: GitHub Actions free tier — lint, typecheck, tests on PR; auto-deploy via Vercel Git integration + Railway/Render Git integration.
- DB migrations: Supabase CLI, run as a deploy step.
- Observability on a budget (constitution §VI): Vercel/Railway built-in logs + one free error tracker (Sentry free tier) + the `usage_records` cost queries. Nothing else.
- Env vars per platform; secrets never in the repo.

## 11. Security Considerations

(Operationalizes constitution §III.)

- RLS on every user table; service-role key used only in webhook/metering paths and never exposed to the client.
- All input validated at the API boundary via DTOs; all output rendered through React escaping (no `dangerouslySetInnerHTML` for AI/user content — markdown renderer with sanitization if rich output is needed).
- CV/JD text treated as untrusted data in prompts (delimited blocks) and in UI (sanitize before render).
- Stripe webhooks: signature verification, idempotent handlers, no client-driven subscription changes.
- Rate limiting on auth-adjacent endpoints and AI endpoints; CORS locked to the Vercel domain.
- Secrets in platform env vars; never logged; `.env` files gitignored.
- Dependency hygiene: `pnpm audit` in CI; pinned lockfile.

## 12. Build Order (each step independently shippable)

1. Monorepo scaffold + `packages/types` + CI.
2. Supabase project: migrations for all tables + RLS policies + storage bucket.
3. Auth end-to-end (Supabase Auth → web guard → api guard).
4. Profiles + onboarding flow.
5. CV upload → extraction → storage.
6. `ai` module (provider, prompts, cache, usage) + CV Analyzer (first "aha").
7. Job Match. 8. Job Tracker (pure CRUD). 9. Billing + entitlements + paywall.
10. Apply Assistant. 11. AI Coach (streaming). 12. Polish + UX pass.

Apply Assistant and Coach come last because they're Pro-gated — the free loop must validate first.
