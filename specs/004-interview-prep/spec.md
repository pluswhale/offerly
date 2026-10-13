# Interview Prep — Feature Specification

Status: Draft
Source of truth: `PROJECT_CONTEXT.md`, `.specify/memory/constitution.md`, `specs/001-offerly-mvp/spec.md` §4 (AI Coach, Apply Assistant)
Owner: solo developer

## 1. Feature Goal

When a tracked application reaches the interview stage, generate the questions this specific company is likely to ask for this specific role, with talking points drawn **only** from the user's own CV, plus the gaps the CV does not cover.

Feature test (constitution): **"Does this help the user get a job offer faster?"** — Yes, and at the highest-leverage point in the funnel. An interview the user walks into prepared is worth more than ten extra applications.

## 2. Current State (as of spec writing)

- `AiService` (`apps/api/src/modules/ai/ai.service.ts`) is the single LLM gateway: cache-before-call keyed on `sha256(templateVersion + normalized input)`, token caps, retry-once on parse failure, concurrency limiting with 429 backoff, and `usage_records` logging with an estimated cost. Every new LLM feature goes through it; no second path to a provider is permitted.
- Prompt templates live in `apps/api/src/modules/ai/prompts/*.v1.ts`, each exporting `templateVersion`, a `build*` function returning `BuiltPrompt`, and a `parse*` validator. User text is wrapped with `dataBlock()` and `UNTRUSTED_DATA_RULE` (`prompt.types.ts`).
- `ApplyService` (`apps/api/src/modules/jobs/apply.service.ts`) is the closest existing analogue: active CV + JD → truncate → prompt → `generateJson`.
- Plan gating is declarative: `@Requires(feature)` + `EntitlementGuard`, with `PLAN_LIMITS` in `packages/types/src/plans.ts` as the single source of truth and a `402` carrying a structured upgrade payload. The web client renders it with `PaywallModal`.
- `CvsService.getActive()` returns the active CV; `JobsService.getOwned()` returns an owned job or throws.
- `ApplicationsModule` does **not** export its service.

### Schema constraints that shape this spec

Read before writing the spec, not discovered at runtime:

1. `usage_records.operation` carries a CHECK constraint listing exactly four values (`cv_analysis`, `job_match`, `apply_generate`, `coach_message`). **Logging a new operation therefore requires a migration.** The alternative — reusing `apply_generate` — would silently corrupt the free-tier "one sample generation" counter that reads that exact value. A three-line additive migration is the honest option.
2. `ai_conversations.kind` is likewise constrained to `('coach', 'apply_assistant')`. Persisting prep output as a conversation would need a second migration — and nothing in the product reads it back yet. See §8.

## 3. User Stories

### US-1 — Prepare for a specific interview (primary)

As a candidate with an interview booked, I want likely questions for this role and company with talking points from my own experience, so I can rehearse with material that is actually mine.

### US-2 — Know my weak spots

As a candidate, I want to be told which job requirements my CV does not evidence, so I prepare an honest answer instead of being caught out.

### US-3 — Ask good questions back

As a candidate, I want two sharp questions to ask the interviewer, so the conversation ends well.

## 4. Functional Requirements

### FR-1 — Endpoint

`POST /applications/:id/interview-prep`, no request body.

Preconditions, in order, each with a distinct response:

| Condition | Response |
|---|---|
| Application not found or not owned by the caller | `404` |
| Application has no `job_id` | `422` `{ code: "no_linked_job" }` |
| Linked job has empty `description_text` | `422` `{ code: "no_job_description" }` |
| No active CV, or it has no `extracted_text` | `422` `{ code: "no_active_cv" }` |
| Caller's plan lacks the feature | `402` with the standard upgrade payload |

Ownership is enforced server-side on every row read. The client never supplies a user id.

### FR-2 — Response shape

```ts
interface InterviewPrepQuestion {
  question: string;
  why: string;                // why this role/JD makes the question likely
  talking_points: string[];   // 2–3, grounded in the CV only
}

interface InterviewPrepResponse {
  questions: InterviewPrepQuestion[];   // 4–8 (the prompt asks for 6)
  questions_to_ask: string[];           // exactly 2
  gaps_flagged: string[];               // JD requirements the CV does not evidence; may be empty
  cached: boolean;                      // true when served from llm_cache
}
```

### FR-3 — Prompt construction

New template `interview-prep.v1.ts`, following the existing convention exactly:

- CV text and JD text are wrapped in `dataBlock("cv_text", …)` / `dataBlock("job_description", …)` in the **user** message. The system message contains `UNTRUSTED_DATA_RULE` and never interpolates user text.
- Inputs truncated with `truncateText`: CV ≤ 10 000 chars, JD ≤ 10 000 chars (same caps as match and apply).
- Honesty rule, carried over from `apply-generate.v1`: talking points may only reference experience stated in the CV. Anything the JD requires and the CV does not show goes to `gaps_flagged`, never into an invented talking point.
- `cacheInput` is the truncated CV text plus the truncated JD text, so the same CV/JD pair never costs twice.

### FR-4 — Output validation

`parseInterviewPrepResult(raw)` returns the typed result or `null`. `null` triggers the gateway's single retry; a second failure surfaces as `422`, never as partial or unvalidated content.

Rejected: non-object; `questions` not an array or outside 4–8 entries; any question missing a non-empty `question` or `why`; `talking_points` not an array of 2–3 non-empty strings; `questions_to_ask` not exactly 2 non-empty strings; `gaps_flagged` not an array of strings.

The 4–8 band is deliberate: the prompt asks for 6, but failing a usable 5-question answer would burn a retry and a paid call for nothing. The bound exists to catch a *malformed* response, not an off-by-one one.

### FR-5 — Plan gating

- New gated feature `interview_prep`; new `PlanLimits.interviewPrep: boolean` — `false` on free, `true` on pro.
- Enforced by `@Requires("interview_prep")` + `EntitlementGuard` only. No client-side check may stand in for it; the frontend hides nothing it cannot also prove.
- Denial reason: "Interview prep is a Pro feature".

### FR-6 — Usage accounting

- New `UsageOperation` value `interview_prep`, with the additive migration from §2.
- The operation is **not** added to `QUOTA_OPERATIONS`: it is Pro-only, free users cannot reach it, and Pro has no monthly cap — adding it would change what the dashboard's quota meter means for zero benefit.
- Cache hits are logged without token cost, as the gateway already does for every operation.

### FR-7 — Frontend

New route `/prep` (`apps/web/app/(app)/prep/`), plus one nav entry after "Tracker".

- A selector listing non-archived applications that have a `job_id`; applications without a linked job are not offered, and a short line explains why if the list is empty.
- "Generate prep" triggers the call. While in flight: skeleton, button disabled.
- Results render as a list of question cards (question, why, talking points), then "Questions to ask them", then "Gaps to prepare for" when non-empty.
- `402` → existing `PaywallModal`. `422` → the specific message from the API, not a generic failure. Network/`5xx` → error state with retry.
- `cached: true` shows a small "instant · cached" badge. This is a real product signal, not decoration: it tells the user a repeat is free.

## 5. Acceptance Criteria

1. A Pro user selects a tracked application with a linked job and receives 4–8 questions, each with a reason and 2–3 talking points, plus exactly 2 questions to ask.
2. Running it a second time for the same CV/JD pair returns the same content, shows the cached badge, and makes no provider call.
3. A free user receives `402` and sees the paywall modal; no LLM call is made.
4. An application belonging to another user returns `404` — verified by test, not by inspection.
5. An application with no linked job returns `422 no_linked_job` and the UI shows that specific message.
6. A malformed model response is retried once and then surfaces as `422`; no partial content is rendered.
7. An adversarial JD containing instruction-shaped text ("ignore previous instructions…") appears only inside the `<job_description>` block and never in the system message — asserted by a prompt test.
8. A row is written to `usage_records` with `operation = 'interview_prep'`, and the dashboard's monthly quota figure is unchanged by it.
9. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
10. No dependency was added.

## 6. Edge Cases

- **CV or JD longer than the cap** → truncated, not rejected; truncation is silent to the model but bounded, exactly as match and apply behave.
- **Empty `gaps_flagged`** → the section is omitted, not rendered empty.
- **Provider unavailable / 429 beyond backoff** → `503` from the gateway; UI offers retry and states that nothing was charged.
- **Application deleted between selection and generation** → `404`, handled as an error state rather than a crash.
- **User switches active CV, then regenerates** → different `cacheInput`, so a fresh generation. Correct and intended.
- **Application linked to a job whose JD is short or vague** → still generated; no fake confidence signal is invented for this feature (unlike match, which has an explicit low-confidence path).

## 7. Non-Functional Requirements

- **Security (constitution §III):** every row read is scoped to the caller through the user-scoped Supabase client; untrusted text stays in delimited data blocks; the gate is server-side only.
- **Cost (constitution §V):** `max_tokens` capped at 2000; cached repeats cost nothing; bounded inputs; Pro-only, so spend tracks revenue.
- **Testing (constitution §IV):** priority order applies — gating and ownership first, prompt assembly and output parsing second. LLM output itself is never asserted; the provider is stubbed.
- **Mobile-first**, consistent with the rest of the app.

## 8. Out of Scope (explicitly)

- **Persisting generated prep.** It would need a second migration (`ai_conversations.kind`), and nothing reads it back yet; `llm_cache` already makes a repeat free. Revisit when a "my prep history" screen is actually requested.
- Regeneration with an instruction ("more technical") — the apply assistant has it; add here only if asked.
- Mock-interview chat, follow-up questions, answer grading.
- Company research beyond the stored job description (no scraping, no web search).
- Audio, flashcards, export to PDF.
- Any change to the Tracker page, the Dashboard, or the Coach.

## 9. Parallel Execution Boundary

This feature is implemented in the worktree `004-interview-prep`, in parallel with `003-pipeline-insights`. The split is by file ownership, decided before either agent starts.

**Files this task may create or modify — and no others:**

```
supabase/migrations/20261012120000_interview_prep_usage_operation.sql  (new)
packages/types/src/db.ts                                               (modify: UsageOperation)
packages/types/src/plans.ts                                            (modify: PlanLimits)
apps/api/src/modules/ai/prompts/interview-prep.v1.ts                   (new)
apps/api/src/modules/prep/prep.module.ts                               (new)
apps/api/src/modules/prep/prep.controller.ts                           (new)
apps/api/src/modules/prep/prep.service.ts                              (new)
apps/api/src/modules/entitlements/requires.decorator.ts                (modify: GatedFeature)
apps/api/src/modules/entitlements/entitlements.service.ts              (modify: one case)
apps/api/src/app.module.ts                                             (modify: register PrepModule)
apps/api/test/interview-prep.spec.ts                                   (new)
apps/api/test/entitlements.spec.ts                                     (modify only if it breaks)
apps/web/lib/contract.ts                                               (modify: response types)
apps/web/app/(app)/prep/page.tsx                                       (new)
apps/web/app/(app)/prep/prep-client.tsx                                (new)
apps/web/components/app-nav.tsx                                        (modify: one nav entry)
specs/004-interview-prep/*                                             (this spec set)
```

**Hard constraints:**

- Do not touch `apps/web/app/(app)/tracker/**`, `apps/web/app/(app)/dashboard/**`, `apps/web/lib/pipeline-insights*`, or `apps/web/app/globals.css`. Those belong to the other workstream or to nobody.
- Do not modify `ApplicationsModule`, `ApplicationsService`, or `ApplicationsController`. The application row is read directly through `SupabaseService` in `PrepService`.
- **Do not add, remove, or upgrade any dependency.** `pnpm-lock.yaml` is the only file both workstreams could collide on; neither may change it.
- The migration must be idempotent (`drop constraint if exists` before `add constraint`) — it may already have been applied to the shared dev database.
- If the task appears to require a file outside this list, stop and report it instead of expanding scope.
