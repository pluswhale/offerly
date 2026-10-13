# Interview Prep — Implementation Tasks

Plan: `specs/004-interview-prep/plan.md` | Spec: `specs/004-interview-prep/spec.md`
Complexity: **S** (<half day) · **M** (~1 day)
Order principle: schema and gating first (everything depends on their types, and a gate retrofitted after a working endpoint is a gate that gets forgotten), then the prompt and its validator, then the service, then the UI.

---

## Phase 1 — Schema, types, gating

### T1.1 Usage-operation migration
- **Description:** Create `supabase/migrations/20261012120000_interview_prep_usage_operation.sql` exactly as in plan §1: drop `usage_records_operation_check` if it exists, then re-add it with `interview_prep` appended to the allowed list. Include the one-line comment explaining why.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** Additive only — no data migration, no column change; re-running it is safe; every existing row still satisfies the new constraint.

### T1.2 Extend shared types
- **Description:** Add `"interview_prep"` to `UsageOperation` in `packages/types/src/db.ts`. Add `interviewPrep: boolean` to `PlanLimits` in `packages/types/src/plans.ts`, placed next to `coach`; `false` on free, `true` on pro. Do not add response shapes here.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** `pnpm typecheck` passes across the workspace; no other field in `PLAN_LIMITS` changed.

### T1.3 New gated feature
- **Description:** Add `"interview_prep"` to `GatedFeature` in `requires.decorator.ts`, and the corresponding `case` in `EntitlementsService.checkAccess` modelled on `coach` (plan §3). Do not modify `EntitlementGuard` — it needs no new context.
- **Dependencies:** T1.2
- **Complexity:** S
- **Acceptance criteria:** Free plan is denied with "Interview prep is a Pro feature"; pro is allowed; `apps/api/test/entitlements.spec.ts` still passes (update it only if the new field genuinely breaks it).

---

## Phase 2 — Prompt and validator

### T2.1 Prompt template
- **Description:** Create `apps/api/src/modules/ai/prompts/interview-prep.v1.ts` per plan §4: `templateVersion`, result interfaces, `buildInterviewPrepPrompt`. System message carries the role instruction, `UNTRUSTED_DATA_RULE`, the honesty rule and the exact JSON shape — and no user text. User message carries the role line plus both `dataBlock`s. `cacheInput` = truncated CV + JD.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** Follows the structure of `apply-generate.v1.ts`; no user-provided string is concatenated into the system message anywhere.

### T2.2 Output validator
- **Description:** Implement `parseInterviewPrepResult` in the same file, in the defensive style of `parseApplyResult`. Enforce spec FR-4: `questions` 4–8, each with non-empty `question` and `why` and 2–3 non-empty `talking_points`; `questions_to_ask` exactly 2 non-empty strings; `gaps_flagged` an array of strings (may be empty). Return `null` on the first violation.
- **Dependencies:** T2.1
- **Complexity:** S
- **Acceptance criteria:** No `as` cast crosses an unvalidated boundary; every array element is checked, not just the array; a non-object input returns `null` rather than throwing.

### T2.3 Prompt and validator tests
- **Description:** Create `apps/api/test/interview-prep.spec.ts` with cases 1–9 from plan §7 (assembly, adversarial JD containment, cache-input sensitivity, and every validator boundary).
- **Dependencies:** T2.1, T2.2
- **Complexity:** S
- **Acceptance criteria:** `pnpm --filter @offerly/api test` passes; the adversarial-JD assertion checks both that the system message excludes the text and that the user message contains it inside the data block.

---

## Phase 3 — API

### T3.1 Prep service
- **Description:** Create `apps/api/src/modules/prep/prep.service.ts` implementing the seven steps in plan §5. Read the application directly through `SupabaseService.forUser(token)` scoped by `id` and `user_id`. Enforce the precondition order from spec FR-1, each with its own code. Call `AiService.generateJson` with `operation: "interview_prep"` and `maxTokens: 2000`. Return the result plus `cached: result.cacheHit`. No persistence.
- **Dependencies:** T1.2, T2.2
- **Complexity:** M
- **Acceptance criteria:** `ApplicationsModule`/`ApplicationsService`/`ApplicationsController` are untouched; no `ai_conversations` or `ai_messages` row is written; every row read is scoped to the caller.

### T3.2 Controller and module
- **Description:** Create `prep.controller.ts` (`@Controller("applications")`, `@Post(":id/interview-prep")`, `ParseUUIDPipe`, `@UseGuards(EntitlementGuard)`, `@Requires("interview_prep")`) and `prep.module.ts` importing `AiModule`, `CvsModule`, `JobsModule`, `EntitlementsModule`. Register `PrepModule` in `app.module.ts` after `ApplicationsModule`.
- **Dependencies:** T1.3, T3.1
- **Complexity:** S
- **Acceptance criteria:** The app boots; `POST /applications/:id/interview-prep` is routed; a non-UUID id is rejected by the pipe before any query runs; the existing `/applications` routes still work.

### T3.3 Service and gating tests
- **Description:** Extend `apps/api/test/interview-prep.spec.ts` with cases 10–13 from plan §7, using stubbed `SupabaseService`, `JobsService`, `CvsService` and `AiService`.
- **Dependencies:** T3.1, T1.3
- **Complexity:** M
- **Acceptance criteria:** The foreign-application case asserts both the `404` **and** that the LLM stub was never invoked; each `422` precondition is asserted with its code; the happy-path case asserts the operation name, the token cap and the `cacheHit → cached` mapping.

---

## Phase 4 — Frontend

### T4.1 Contract types
- **Description:** Add an "Interview Prep" section to `apps/web/lib/contract.ts` with `InterviewPrepQuestion` and `InterviewPrepResponse` matching spec FR-2.
- **Dependencies:** T2.1
- **Complexity:** S
- **Acceptance criteria:** Shapes match the API exactly; placed alongside the existing per-feature sections.

### T4.2 Prep screen
- **Description:** Create `apps/web/app/(app)/prep/page.tsx` and `prep-client.tsx` per plan §6: application selector filtered to non-archived entries with a `job_id`, generate action, question cards, "Questions to ask them", "Gaps to prepare for" (omitted when empty), skeleton while generating, `PaywallModal` on `PaywallError`, specific server message on `422`, retry on failure, cached badge when `cached`.
- **Dependencies:** T4.1, T3.2
- **Complexity:** M
- **Acceptance criteria:** Reuses existing components only; no new dependency; mobile layout works at 360px; an empty selector shows an explanation pointing at the tracker, not an error state.

### T4.3 Navigation entry
- **Description:** Add `{ href: "/prep", label: "Prep" }` to `NAV_ITEMS` in `apps/web/components/app-nav.tsx`, after Tracker.
- **Dependencies:** T4.2
- **Complexity:** S
- **Acceptance criteria:** A one-line diff; active-state highlighting works on `/prep`; desktop and mobile nav both updated (they share the same array).

---

## Phase 5 — Verification

### T5.1 Full gate
- **Description:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Then `git diff --stat` against the spec §9 file list and `git diff -- pnpm-lock.yaml` (must be empty).
- **Dependencies:** T1.1–T4.3
- **Complexity:** S
- **Acceptance criteria:** All four commands pass; the changed-file list matches spec §9 exactly; the lockfile is untouched.

### T5.2 Manual pass
- **Description:** Walk spec §5 acceptance criteria 1, 2, 5 and 8 against the dev account: generate prep for a linked application; regenerate and confirm the cached badge and that no provider call was made; confirm the `no_linked_job` message; confirm a `usage_records` row with `operation = 'interview_prep'` and an unchanged dashboard quota figure. Criteria 3, 4, 6 and 7 are covered by tests.
- **Dependencies:** T5.1
- **Complexity:** S
- **Acceptance criteria:** Each checked item is reported with what was actually observed. Anything not run is reported as not run, never as passed.

---

## Dependency graph

```
T1.1
T1.2 ──> T1.3 ──────────────┐
T2.1 ──> T2.2 ──> T2.3      │
          │                 │
          └──> T3.1 ──> T3.2 ──> T3.3
                 │         │
          T4.1 ──┴──> T4.2 ──> T4.3
                                 │
                                 v
                           T5.1 ──> T5.2
```
