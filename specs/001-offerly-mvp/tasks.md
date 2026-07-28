# Offerly MVP — Implementation Tasks

Plan: `specs/001-offerly-mvp/plan.md` | Spec: `specs/001-offerly-mvp/spec.md`
Complexity scale: **S** (<half day) · **M** (~1 day) · **L** (2–3 days)
Priority principles: fastest path to a usable free loop (CV → Match → Tracker) before any billing work; cheapest viable option always wins; no task may add infrastructure beyond the plan.

---

## Phase 1 — Project Setup

### T1.1 Monorepo scaffold
- **Description:** pnpm workspace + Turborepo with `apps/web` (Next.js 16, React 19, TS strict), `apps/api` (NestJS, TS strict), `packages/types`, `packages/config` (shared tsconfig/eslint). Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`.
- **Dependencies:** none
- **Complexity:** M
- **Acceptance criteria:** `pnpm dev` starts web on :3000 and api on :3001; `pnpm typecheck && pnpm lint` passes across all packages; a type exported from `packages/types` is imported by both apps.

### T1.2 GitHub Actions CI
- **Description:** Single workflow: install (pnpm cache), lint, typecheck, run tests on PR and main.
- **Dependencies:** T1.1
- **Complexity:** S
- **Acceptance criteria:** PR with a type error fails CI; clean PR passes; build time <5 min.

### T1.3 Supabase project + local dev
- **Description:** Create Supabase project, install CLI, init `supabase/migrations`, configure local dev via `supabase start`. Document env vars in `.env.example` (never commit `.env`).
- **Dependencies:** T1.1
- **Complexity:** S
- **Acceptance criteria:** `supabase start` serves local DB/Auth/Storage; connection strings documented; `.env` is gitignored.

### T1.4 Design system foundation
- **Description:** Tailwind + a minimal component set in `apps/web/components` (Button, Input, Card, Modal, Badge, Skeleton, EmptyState) following the UX principles: one accent color, generous whitespace, mobile-first. Light mode only.
- **Dependencies:** T1.1
- **Complexity:** M
- **Acceptance criteria:** Components render correctly at 360px and 1440px widths; touch targets ≥44px; no horizontal scroll on mobile.

---

## Phase 2 — Authentication

### T2.1 Supabase Auth wiring (web)
- **Description:** `@supabase/ssr` cookie sessions, email/password + Google OAuth, login/signup pages, `middleware.ts` route protection for `/dashboard` and other app routes.
- **Dependencies:** T1.3, T1.4
- **Complexity:** M
- **Acceptance criteria:** User can sign up, verify email, log in with Google, log out; unauthenticated visit to `/dashboard` redirects to login; session survives refresh.

### T2.2 API auth guard
- **Description:** NestJS guard validating Supabase JWT on all routes except `/billing/webhooks/*` and `/health`; attaches `userId` to request. Global DTO validation pipe + exception filter.
- **Dependencies:** T1.1, T1.3
- **Complexity:** M
- **Acceptance criteria:** Request without token → 401; valid token → handler receives `userId`; tampered token → 401; integration test covers all three.

### T2.3 Frontend API client
- **Description:** Typed fetch wrapper in `apps/web/lib` that attaches the session token, handles 401 (redirect to login), typed against `packages/types` DTOs.
- **Dependencies:** T2.1, T2.2
- **Complexity:** S
- **Acceptance criteria:** A test page calls a protected endpoint and renders data; expired session triggers redirect.

---

## Phase 3 — User Onboarding

### T3.1 Onboarding flow UI
- **Description:** 3 steps max (basics: name/current/target role → CV upload-or-skip → first analysis trigger), completable in <2 min, skippable CV step. Sets `profiles.onboarding_completed`.
- **Dependencies:** T2.1, needs `profiles` table (T4.1), CV upload endpoint (T5.1 — can ship with a stub that only stores text until Phase 5 lands)
- **Complexity:** M
- **Acceptance criteria:** New user reaches Dashboard in ≤3 steps; skipping CV lands on Dashboard with "Upload your CV" as primary action; `onboarding_completed=true` persisted.

### T3.2 Progressive profiling hooks
- **Description:** Reusable "missing context" prompt component: when a feature needs a profile field that's null (location for match, experience for coach), ask inline at that moment — never in onboarding.
- **Dependencies:** T3.1
- **Complexity:** S
- **Acceptance criteria:** Prompt appears only when the field is null and the feature is used; answering persists via `PATCH /profiles/me`; never shown twice for a filled field.

### T3.3 Dashboard shell
- **Description:** Authenticated layout + Dashboard with empty states: pipeline summary placeholder, next-action card (rule-based: no CV → upload; CV but no jobs → add job; etc.), usage display placeholder.
- **Dependencies:** T3.1, T1.4
- **Complexity:** M
- **Acceptance criteria:** Empty account shows onboarding card, not blank widgets; next action changes correctly for 3 seeded account states; mobile layout clean above the fold.

---

## Phase 4 — Database

### T4.1 Core migrations + RLS
- **Description:** SQL migrations for `profiles`, `cvs`, `cv_analyses`, `jobs`, `job_matches`, `applications`, `ai_conversations`, `ai_messages`, `subscriptions`, `usage_records`, `llm_cache` per plan §2. RLS policies (`user_id = auth.uid()`) on every user table. Storage bucket `cvs` (private).
- **Dependencies:** T1.3
- **Complexity:** M
- **Acceptance criteria:** Migrations apply cleanly from scratch (`supabase db reset`); RLS test: user B cannot select/insert/update user A's rows in any table; all tables have created_at defaults.

### T4.2 Data access layer
- **Description:** NestJS services per module wrapping Supabase queries, scoped by authenticated `userId`; typed rows in `packages/types`.
- **Dependencies:** T4.1, T2.2
- **Complexity:** M
- **Acceptance criteria:** No module writes raw queries outside its own service; integration test proves cross-user access returns empty/403 even with valid JWT.

---

## Phase 5 — CV Analyzer (first "aha")

### T5.1 CV upload + text extraction
- **Description:** Signed-upload-URL flow to `cvs` bucket (PDF/DOCX, ≤5 MB), server-side extraction (pdf-parse/mammoth), store `extracted_text` + sha256 `content_hash`, one `is_active` CV per user. Paste-text alternative. Scanned-PDF detection → error + paste fallback.
- **Dependencies:** T4.2
- **Complexity:** M
- **Acceptance criteria:** PDF and DOCX extract correctly on 3 sample CVs; >5 MB rejected with clear message; image-only PDF returns the paste fallback; re-upload replaces active CV.

### T5.2 AI module foundation
- **Description:** `ai` module: `LlmProvider` interface + one provider implementation, versioned prompt templates, `llm_cache` lookup-before-call, token caps + intelligent truncation, `usage_records` logging with cost estimate, global concurrency limiter + 429 backoff.
- **Dependencies:** T4.2
- **Complexity:** L
- **Acceptance criteria:** Identical request twice → second is a cache hit (logged, zero provider call); oversized input is truncated and result notes it; every call writes a `usage_records` row with tokens + cost; recorded-fixture test runs the pipeline with no live API.

### T5.3 CV analysis endpoint + UI
- **Description:** `POST /cvs/:id/analyze`: score 0–100, section feedback, prioritized improvements (structured JSON output). Basic depth for all users at this stage (gating lands in Phase 10). UI: analysis result page with score, sections, improvement checklist. Cache key = CV content hash.
- **Dependencies:** T5.1, T5.2
- **Complexity:** L
- **Acceptance criteria:** Analysis returns in <30s with loading skeleton; re-analyzing unchanged CV is instant and free (cache); result renders on mobile; prompt-injection strings inside a CV do not alter output instructions (test with adversarial fixture); user sees what was analyzed if truncated.

---

## Phase 6 — Job Match

### T6.1 Job input
- **Description:** `POST /jobs` accepting pasted description + title/company/url; `content_hash`; validation that the paste looks like a JD (length/heuristic) with polite rejection otherwise.
- **Dependencies:** T4.2
- **Complexity:** S
- **Acceptance criteria:** Valid JD saved; paragraph of lorem ipsum rejected with clear message; duplicate paste (same hash) reuses the job row.

### T6.2 Match scoring endpoint + UI
- **Description:** `POST /jobs/:id/match`: 0–100 score, strengths, gaps, 2–3 recommendations (structured output). Cached on (cv hash + jd hash). Low-confidence warning for short/vague JDs. UI: paste → score → gaps, with "Save to tracker" CTA. Prompts for CV upload if none exists.
- **Dependencies:** T6.1, T5.2, active CV from T5.1
- **Complexity:** M
- **Acceptance criteria:** Score + gaps render from a real CV/JD pair; repeated match is a cache hit; vague JD shows low-confidence warning instead of fake precision; missing CV triggers upload prompt (progressive profiling, T3.2).

---

## Phase 7 — AI Apply Assistant

### T7.1 Generation endpoint
- **Description:** `POST /jobs/:id/apply`: cover letter + application answers + vacancy-specific recommendations from active CV + JD. Honesty rule: flags gaps instead of fabricating experience. Regeneration with user instruction ("shorter", "more formal"). Each generation logged to `usage_records`.
- **Dependencies:** T6.2, T5.2
- **Complexity:** L
- **Acceptance criteria:** Output never claims experience absent from the CV (adversarial test); gap-flagging works when JD requires missing skill; regeneration honors the instruction; editable output before copy.

### T7.2 Apply Assistant UI
- **Description:** Flow from a Job Match result or tracker entry: generate → edit in place → copy. Streaming/progressive display; never a frozen spinner >10s. Generated artifacts linked to the application entry.
- **Dependencies:** T7.1, tracker entry creation (T8.1 — ship UI after tracker, or with a temporary "save later" state)
- **Complexity:** M
- **Acceptance criteria:** Full flow works mobile + desktop; long output streams progressively; artifacts retrievable from the linked application.

---

## Phase 8 — Job Tracker

### T8.1 Applications CRUD API
- **Description:** CRUD for `applications` with statuses `saved|applied|interview|offer|rejected`, notes, `applied_at`, `archived` flag, optional link to job/match/apply artifacts.
- **Dependencies:** T4.2
- **Complexity:** M
- **Acceptance criteria:** Full CRUD via API with ownership enforced; status transitions persisted; linked artifacts resolve.

### T8.2 Tracker UI
- **Description:** Kanban (desktop) / list (mobile) view, drag or dropdown status change, create/edit/delete entries, optimistic updates with rollback on failure. Delete with linked artifacts → confirmation dialog.
- **Dependencies:** T8.1, T1.4
- **Complexity:** M
- **Acceptance criteria:** All CRUD operations work offline-tolerant (optimistic, no silent loss); mobile list fully usable; deletion confirms when artifacts are linked.

### T8.3 Dashboard integration
- **Description:** Real pipeline summary counts per status, recent activity, and data-driven next-action rules (e.g., "3 applications >7 days old — follow up").
- **Dependencies:** T8.1, T3.3
- **Complexity:** S
- **Acceptance criteria:** Counts match tracker data; next-action card updates for the 3 seeded states; all-rejected pipeline suggests CV/match improvement.

---

## Phase 9 — AI Coach

### T9.1 Conversations API
- **Description:** `ai_conversations`/`ai_messages` endpoints; system prompt injects user context (CV summary, target role, pipeline state); context compaction — older turns summarized into a `system-summary` message, user notified in UI.
- **Dependencies:** T5.2, T4.2
- **Complexity:** L
- **Acceptance criteria:** Coach answers reference the user's actual CV/role (verified on seeded account); long conversation triggers compaction with visible notice; off-topic request gets polite redirect.

### T9.2 Coach UI
- **Description:** Chat interface with streaming responses (SSE); first-use asks for missing context (progressive profiling); suggestion chips that deep-link into features ("Run a Job Match").
- **Dependencies:** T9.1, T3.2
- **Complexity:** M
- **Acceptance criteria:** Streaming renders token-by-token; suggestion chips navigate correctly; empty-context user is prompted to upload CV before personalized advice; mobile chat usable with on-screen keyboard.

---

## Phase 10 — Subscription System

### T10.1 Payment abstraction + Stripe
- **Description:** `PaymentProvider` interface, `StripePaymentProvider`, checkout + customer portal endpoints, webhook handler with signature verification and idempotency — the only writer of `subscriptions`.
- **Dependencies:** T2.2, T4.2
- **Complexity:** L
- **Acceptance criteria:** Stripe test-mode: checkout → webhook → `subscriptions` row active; forged webhook signature rejected; replayed webhook event is idempotent; client calls cannot mutate subscription state.

### T10.2 Entitlements + feature gating
- **Description:** `PLAN_LIMITS` in `packages/types`, `EntitlementGuard` + `@Requires(feature)` on gated endpoints, monthly quota counting from `usage_records`, `GET /usage/me`. Free limits: 5 AI requests/mo, 1 basic CV analysis, 10 active applications, Apply sample-only, Coach locked.
- **Dependencies:** T10.1, all gated features exist (T5.3, T6.2, T7.1, T8.1, T9.1)
- **Complexity:** M
- **Acceptance criteria:** Free user at limit → 402/403 with upgrade payload; Pro user passes; tracker over-limit entries after downgrade become read-only, never deleted; cache hits don't consume quota; server-side enforcement proven by calling API without UI.

### T10.3 Paywall + pricing UI
- **Description:** Pricing page, contextual paywall when hitting a limit or locked feature, checkout redirect, billing portal in settings, usage display on Dashboard.
- **Dependencies:** T10.2, T3.3
- **Complexity:** M
- **Acceptance criteria:** Free user can upgrade end-to-end in Stripe test mode; Pro state reflected immediately after webhook; downgrade path (portal cancel) works; paywall shows exactly what the user was trying to do.

---

## Phase 11 — Deployment

### T11.1 Production deploy
- **Description:** Web → Vercel (hobby), API → Railway or Render free tier, production Supabase instance, env vars per platform, CORS locked to the Vercel domain, migrations run as deploy step.
- **Dependencies:** T1.2, feature phases complete for what's being shipped
- **Complexity:** M
- **Acceptance criteria:** Production URL serves the full signup → CV analysis flow; API not publicly reachable outside CORS origin; `supabase db push` runs migrations on deploy; monthly fixed cost = $0.

### T11.2 Observability on a budget
- **Description:** Sentry free tier on web + api, platform log retention, a saved SQL query for weekly LLM spend review (`usage_records` sum by week/user), uptime ping (free tier).
- **Dependencies:** T11.1
- **Complexity:** S
- **Acceptance criteria:** A thrown test error appears in Sentry with release tag; weekly spend query runs; downtime alert fires on forced outage.

### T11.3 Launch checklist smoke tests
- **Description:** Scripted E2E happy paths (Playwright): signup → onboarding → CV analysis → match → tracker add → upgrade. Runs against production after each deploy.
- **Dependencies:** T11.1
- **Complexity:** M
- **Acceptance criteria:** Suite passes on production; failure blocks nothing automatically but notifies; covers exactly the 6 MVP feature happy paths, no more.

---

## Phase 12 — Multiple CVs

### T12.1 Multi-CV data model + management API
- **Description:** Migration adding `cvs.name` (backfill: filename, or "Pasted CV" for pasted CVs). `PATCH /cvs/:id` (rename, set active — activating reuses the T5.1 deactivate-others logic), `DELETE /cvs/:id`. Free-tier `storedCvs: 1` limit in `PLAN_LIMITS` enforced on upload: a free user with an existing CV gets a replace-or-upgrade response instead of a second stored CV.
- **Dependencies:** T5.1, T10.2
- **Complexity:** M
- **Acceptance criteria:** Rename/activate/delete work via API with RLS intact; exactly one active CV per user invariant holds (concurrent activates can't leave two active); free user uploading a 2nd CV receives the replace-or-upgrade response, Pro user uploads freely; deleting the active CV leaves no active CV; regression tests for upload → analyze → match still pass.

### T12.2 CV selector component
- **Description:** Shared `CvSelector` dropdown (CV name, active indicator) rendered at the top of the `cv`, `match`, `apply`, and `coach` pages. Selecting a CV calls the activate endpoint and refetches the section's data; zero CVs → upload prompt instead of a selector. Built from T1.4 primitives, mobile-first.
- **Dependencies:** T12.1
- **Complexity:** M
- **Acceptance criteria:** Selector renders on all four sections at 360px and 1440px; switching CV updates the displayed analysis/match context without a full page reload; keyboard accessible; with one CV the selector is a static label, with zero it is the upload prompt.

### T12.3 CV management UI + free-limit upsell
- **Description:** CV list on the CV section: inline rename, delete with confirmation, set active, upload new. Free users hitting the 1-CV limit on upload see a dialog offering "Replace existing CV" or "Upgrade to Pro" (links to pricing, T10.3).
- **Dependencies:** T12.1, T12.2
- **Complexity:** M
- **Acceptance criteria:** All management actions work end-to-end; deleting the only CV returns all CV-dependent sections to the upload-prompt state; the free-limit dialog offers both replace and upgrade paths; Playwright happy path (T11.3) extended with: upload 2nd CV as Pro → switch active via selector → run match against the newly active CV.

---

## Validation Order & Parallelization

- **Fastest validation path:** T1 → T2 → T4 → T5 → T6 → T8 (free loop usable) → **deploy T11.1 early** → T7, T9, T10.
- Phases 5–8 can partially parallelize once T4.2 + T5.2 land, but a solo developer should stay serial: context switching costs more than it saves.
- Deploy after Phase 6 (CV + Match live) rather than waiting for everything — real users beat finished features.
- Every bug fix ships with a regression test (constitution §IV). Every task touching AI must verify the cache-hit and truncation behavior of T5.2 still holds.
