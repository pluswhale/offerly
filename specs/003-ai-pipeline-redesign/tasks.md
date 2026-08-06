
# AI Pipeline Redesign — Implementation Tasks

> **Implementation status (2026-07-29):** all tasks complete except **T6.2** (benchmark-as-gate CI wiring) and **T6.3** (E2E smoke), deferred by owner decision. T6.5 docs & cleanup closed the spec.

Plan: `specs/003-ai-pipeline-redesign/plan.md` | Spec: `specs/003-ai-pipeline-redesign/spec.md`
Complexity scale: **S** (<half day) · **M** (~1 day) · **L** (2–3 days)
Priority: **P0** critical path · **P1** high value · **P2** polish
Priority principles: the Candidate Profile and its deterministic verifier come before any consumer; every prompt template ships with fixtures and a schema; no task may add infrastructure beyond the plan (no queue, no embeddings).

---

## Phase 1 — Schema & Contract Foundation

### T1.1 Evidenced core types + zod boundary [P0]
- **Description:** Add to `packages/types`: `Evidenced<T>`, `CandidateProfile`, `JobProfile`, `JobRequirement`, `RequirementVerdict`, `MatchReportV2`, `ScoreBreakdown` (shapes per spec §FR-2/§FR-5/§FR-7/§FR-8). Add `zod` to `apps/api`; mirror each type as a zod schema inside `apps/api/src/modules/ai/schemas/` (API boundary owns validation; `packages/types` stays dependency-free).
- **Dependencies:** none
- **Complexity:** M
- **Acceptance criteria:** types compile in both apps; zod schemas parse a hand-written valid profile and reject (a) missing fields, (b) `status:'stated'` with `evidence:null`, (c) `status:'unknown'` with non-null `value`.

### T1.2 DB migration [P0]
- **Description:** Migration creating: `candidate_profiles` (id, user_id, cv_id FK cascade, `version`, `status`, `profile` jsonb, `stage_meta` jsonb, `source: 'ai'|'user'` not needed per-row — per-field in jsonb; unique partial index one `ready` per cv_id), `job_profiles` (id, job_id FK cascade unique, `profile` jsonb, `template_version`, created_at), `cv_improvements` (id, cv_id FK cascade, user_id, `type` enum('sentence','bullet','health'), `suggestions` jsonb, created_at). Extend `usage_records.operation` enum: `cv_profile`, `jd_extract`, `match_requirements`, `cv_improve`. Add `profiles.user_goals` jsonb nullable. RLS owner-only policies on all new tables (service-role for none of them — all user-scoped).
- **Dependencies:** none
- **Complexity:** M
- **Acceptance criteria:** `supabase db reset` applies cleanly; RLS verified: user A cannot select user B's profile rows; types in `packages/types/db.ts` extended.

### T1.3 Weights config [P0]
- **Description:** `apps/api/src/modules/ai/matching/weights.ts` exporting `WEIGHTS_V1` (spec §FR-8 table) as a typed constant with `weightsVersion: 'weights.v1'`. Pure data + one `computeScore(verdicts, components, weights)` pure function.
- **Dependencies:** T1.1
- **Complexity:** S
- **Acceptance criteria:** `computeScore` unit tests pass golden vectors: all-match → 100; all-missing must-haves → ≤ cap; unknown scores 0.35 on must-haves; identical inputs → identical output (determinism test).

### T1.4 Prompt template contract [P0]
- **Description:** Formalize the template interface in `prompt.types.ts`: `{templateVersion, buildSystemPrompt, buildUserMessage, schema (zod), validate, cacheInput, maxTokens, modelTier}`. Refactor one existing template (e.g. `conversation-compact.v1`) onto it as proof; keep others working via adapter.
- **Dependencies:** T1.1
- **Complexity:** M
- **Acceptance criteria:** `AiService.generateJson` accepts the new contract; existing templates still pass their tests unchanged; cache keys include `templateVersion` (already true — assert in test).

---

## Phase 2 — Candidate Profile Pipeline

### T2.1 Normalization + evidence verifier (S2) [P0]
- **Description:** Extend `text.ts` normalization into a shared `normalizeForMatch()` (lowercase, Unicode NFC, whitespace collapse). Implement `verifyEvidence(profile, cvText)`: every `status:'stated'` item's evidence must substring-match normalized CV text; failures → flag `evidence_unverified`, clamp confidence ≤0.4, collect for S3.
- **Dependencies:** T1.1
- **Complexity:** M
- **Acceptance criteria:** unit tests: verbatim quote passes; quote with different casing/whitespace passes; fabricated quote fails and is flagged + clamped; 100% verbatim rate on golden fixture (spec AC-1).

### T2.2 `cv-extract.v1` prompt (S1) [P0]
- **Description:** Extraction prompt per spec §FR-2/§FR-10: emits the full CandidateProfile schema, every field explicit, UNKNOWN as `value:null,status:'unknown',evidence:null`; evidence must be verbatim; years of experience derived from dated roles only. Cap input ~20k chars via existing truncation util (disclose `analyzed_chars`). `cacheInput = content_hash`.
- **Dependencies:** T1.4
- **Complexity:** L
- **Acceptance criteria:** on each benchmark fixture CV, output validates against zod schema; zero stated items lack verifiable evidence after T2.1; a CV with no database mention yields `databases: []` and no invented skills (spec AC-2, fixture-asserted).

### T2.3 `cv-validate.v1` prompt (S3, conditional) [P0]
- **Description:** Adjudication prompt receiving ONLY: S2-flagged items, items with confidence <0.7, and consistency flags (summed role durations vs total years; current-role count ≠1). For each: `keep|correct|drop` with corrected value/evidence. Input = flagged items + CV excerpt ±300 chars around each evidence span (not full CV). Skipped entirely when nothing is flagged.
- **Dependencies:** T2.1, T2.2
- **Complexity:** M
- **Acceptance criteria:** fixture with a planted fabrication (quote not in CV) ends with the item dropped or corrected; run with zero flags makes no LLM call (asserted via usage_records).

### T2.4 Pipeline orchestrator + endpoints [P0]
- **Description:** `ProfilePipelineService` in `cvs` module (or new `profiles-ai` submodule): runs S1→S2→S3→persist with per-stage checkpoints in `stage_meta`; resumable from failed stage. `POST /cvs/:id/profile` (202 + status, `@Requires('cv_analysis')`, usage op `cv_profile` only on real S1 call), `GET /cvs/:id/profile`. Idempotent on (content_hash, template versions).
- **Dependencies:** T2.2, T2.3, T1.2
- **Complexity:** L
- **Acceptance criteria:** happy path persists `ready` profile with stage meta; forced S3 failure → status `failed`, retry reuses S1 cache (no duplicate S1 cost — assert usage_records); second POST with unchanged CV/template returns existing profile with zero LLM calls.

### T2.5 User corrections [P1]
- **Description:** `PATCH /cvs/:id/profile` accepting `{path, value}` edits; sets `status:'stated', confidence:1, evidence:null, source:'user'`. Pipeline re-run preserves `source:'user'` fields (merge: user wins).
- **Dependencies:** T2.4
- **Complexity:** M
- **Acceptance criteria:** corrected field survives re-analysis (spec AC-8); user-sourced fields are distinguishable in stored JSON; invalid path rejected 400.

### T2.6 Benchmark fixture harness [P0]
- **Description:** `apps/api/test/fixtures/ai-benchmark/`: 5–10 anonymized CVs (sparse, senior multi-role, non-English, keyword-stuffed) + JDs; recorded LLM responses for CI; script `pnpm bench:ai` running live extraction/matching against human-labeled expectations, reporting per-field precision/recall, evidence-verbatim rate, verdict accuracy per template version. Not CI-blocking initially; report artifact committed per prompt change.
- **Dependencies:** T2.2
- **Complexity:** L
- **Acceptance criteria:** recorded fixtures run in CI offline; bench script produces a per-template-version report; a deliberately degraded prompt visibly lowers the report score.

### T2.7 Profile UI [P1]
- **Description:** Web: CV detail page gains "Candidate Profile" section — grouped fields (skills by category, roles timeline, education, languages…), each with verified/low-confidence badge and expandable evidence quote; completeness score header (from `summary_quality`); inline edit per field (T2.5); polling progress during pipeline run with stage indicator.
- **Dependencies:** T2.4, T2.5
- **Acceptance criteria:** mobile-first layout; every AI-stated fact shows its evidence on expand; editing persists and updates badge; pipeline progress reflects real stage statuses.

---

## Phase 3 — Job Structuring & Matching Engine

### T3.1 `jd-extract.v1` + job profile store [P0]
- **Description:** JD structuring prompt per spec §FR-5 (requirements flat list with category + importance, all Evidenced). Lazy trigger on first match; reuse T2.1 verifier against JD text; store in `job_profiles`; cache by job `content_hash` (cross-user).
- **Dependencies:** T1.4, T2.1, T1.2
- **Complexity:** M
- **Acceptance criteria:** same JD text matched by two users triggers one LLM call total; vague JD still yields schema-valid profile with `unknown` remote_policy etc.; existing low-confidence JD heuristic still surfaces.

### T3.2 Skill alias map + deterministic pre-pass [P0]
- **Description:** `matching/aliases.ts` curated map (~100 common tech aliases); `prepass.ts` resolving requirements by exact/alias skill overlap, numeric comparisons (years vs `min_years_experience`, team size), location/remote rules. Resolved requirements never reach the LLM.
- **Dependencies:** T1.1
- **Complexity:** M
- **Acceptance criteria:** unit tests per rule; on benchmark pairs, ≥40% of requirements resolve without LLM; `unknown` produced only when profile field status is `unknown` — never `missing` from silence (spec §FR-7 semantics).

### T3.3 `match-requirements.v1` prompt [P0]
- **Description:** Verdict prompt for unresolved requirements only. Input: compact profile JSON (relevant subset) + requirement list; output: `RequirementVerdict[]` constrained to cite profile field paths; validator rejects verdicts citing non-existent paths. Honesty rule: no CV claims beyond profile values.
- **Dependencies:** T3.2, T2.2
- **Complexity:** L
- **Acceptance criteria:** benchmark verdict accuracy report ≥ agreed baseline per template version; verdicts reference valid field paths only; "German required, languages=[EN,RU]" → `missing`; languages unstated → `unknown` (spec AC-2 fixture).

### T3.4 Match orchestration v2 [P0]
- **Description:** Rewrite `match.service.ts`: require `ready` profile for active CV — absent → trigger T2.4 pipeline inline, then proceed (never read `cvs.extracted_text`; spec §FR-6). Assemble: JD profile (T3.1) → pre-pass (T3.2) → LLM verdicts (T3.3) → `computeScore` (T1.3) → low-confidence gate (>40% must-have UNKNOWN weight). Persist report v2 in `job_matches.result`; reuse stored row on identical (profile version, job hash, weights version).
- **Dependencies:** T3.1–T3.3, T2.4, T1.3
- **Complexity:** L
- **Acceptance criteria:** match without profile auto-builds it first (spec AC-3); repeat match makes zero LLM calls; identical inputs → bit-identical score (spec AC-4); `cv_profile`/`jd_extract`/`match_requirements` usage ops recorded with tokens.

### T3.5 Match report UI v2 [P1]
- **Description:** Replace score-only display: per-requirement table with verdict badges (MATCH/PARTIAL/UNKNOWN/MISSING), expandable evidence + reasoning; weighted breakdown bars per component; low-confidence banner leading to profile completion; UNKNOWN must-haves rendered as answerable clarifying questions wired to T2.5.
- **Dependencies:** T3.4, T2.7
- **Acceptance criteria:** spec AC-7 low-confidence UX verified; answering a clarifying question patches the profile and re-match reflects it; breakdown sums visibly to the total score.

---

## Phase 4 — Consumers: Review & Coach

### T4.1 `cv-review.v2` re-based on profile [P1]
- **Description:** Quality score/feedback prompt consumes profile JSON + CV text; claims cite profile field paths; free=basic / pro=deep unchanged; `cv_analyses` table + progress-diff UX contract preserved.
- **Dependencies:** T2.4
- **Complexity:** M
- **Acceptance criteria:** existing analysis UI works unmodified against new shape; improvement items reference real profile fields; cache behavior unchanged (content-hash keyed).

### T4.2 `recommendations.v1` [P2]
- **Description:** From a match report JSON, generate 2–4 prioritized next actions (e.g., "Add Docker with evidence of project X", "This job's must-haves are 60% unknown — complete your profile"). Cached per report hash.
- **Dependencies:** T3.4
- **Complexity:** S
- **Acceptance criteria:** recommendations grounded in actual verdicts (no generic advice — fixture assertion); repeat render costs zero tokens.

### T4.3 Coach context manifest + `coach.v2` [P1]
- **Description:** Replace 4k-char CV injection with budgeted manifest (≤2.5k tokens): user profile + `user_goals`, compacted Candidate Profile (values, no evidence), top-5 match summaries (score + top gaps), pipeline counts/staleness, last advice. Evidence drill-down tool-path: when user challenges a claim, fetch the field's evidence on demand. Keep streaming, compaction, gating; keep `coach.v1` behind config flag for rollback.
- **Dependencies:** T3.4, T2.4
- **Complexity:** L
- **Acceptance criteria:** raw CV text absent from coach requests (spec AC-5, asserted in test); token count of system context ≤2.5k on fixture account; coach cites match gaps for "what should I improve for job X"; rollback flag switches persona without deploy.

### T4.4 Progressive profiling for user goals [P2]
- **Description:** Extend the existing missing-context prompt pattern to `user_goals` (target_location, target_salary, priority) — asked inline when coach/match would benefit; `PATCH /profiles/me` extended.
- **Dependencies:** T1.2
- **Complexity:** S
- **Acceptance criteria:** prompt appears only when field null and feature used; persists; never re-asked after filled.

---

## Phase 5 — CV Improvement Features

### T5.1 `sentence-rewrite.v1` [P1]
- **Description:** Weak-sentence detector + rewriter per spec §FR-12 (basic 5 / deep 12 suggestions; categories; verbatim `original_span`; reasons). Reuse T2.1 verifier — unverifiable spans dropped before storage. Store in `cv_improvements` (usage op `cv_improve`).
- **Dependencies:** T2.1, T1.2
- **Complexity:** M
- **Acceptance criteria:** all stored spans locate verbatim in CV text (spec AC-6); fixture CV with "responsible for…" sentences yields rewrites with reasons; zero-span run stores empty result without error.

### T5.2 `bullet-improve.v1` + new-entity guard [P1]
- **Description:** Bullet rewriter per spec §FR-13: action-verb strengthening, metric placeholders `[X%]` (never invented numbers), impact clauses. Deterministic validator: token-diff rejects improved text containing technology/product entities absent from the original span.
- **Dependencies:** T5.1
- **Complexity:** M
- **Acceptance criteria:** planted hallucination ("improved Kubernetes deployments" from a bullet without Kubernetes) rejected by validator (spec AC-6); placeholders render bracketed in UI.

### T5.3 Improvements UI (❌/✅ diff + accept/reject) [P1]
- **Description:** "Improve my CV" section: per suggestion, original (❌) vs improved (✅) side-by-side (stacked on mobile), reason, category badge, accept/reject buttons (`PATCH` suggestion status); accepted list exportable as a copy-paste checklist. No auto-rewrite of stored CV (spec §11).
- **Dependencies:** T5.1, T5.2
- **Complexity:** M
- **Acceptance criteria:** statuses persist; UI matches spans correctly on real PDF-extracted text; checklist copies cleanly.

### T5.4 Deterministic CV Health detectors [P1]
- **Description:** Code-only detectors per spec §FR-14 priorities: P0 completeness (already `summary_quality` — surface it), P0 missing-keywords-vs-matched-jobs, P1 duplicate skills (alias-aware), P1 tense/date-format inconsistency, P1 overused buzzwords, P1 quantified-achievement ratio. Output as `cv_improvements` type `health` rows — no LLM calls.
- **Dependencies:** T2.4 (profile), T3.4 (missing-keywords only)
- **Complexity:** M
- **Acceptance criteria:** each detector has unit tests with fixture CVs; missing-keywords reflects real match reports; health section renders with zero token cost (usage_records untouched).

### T5.5 P2 health detectors [P2]
- **Description:** Weak-summary detection, technology-adjacency questions ("Express listed, Node.js not — add it?" phrased as question, never auto-added), ATS format lint from PDF parse metadata.
- **Dependencies:** T5.4
- **Complexity:** M
- **Acceptance criteria:** adjacency suggestions never mutate the profile automatically; ATS lint fires on a table-heavy fixture PDF.

---

## Phase 6 — Hardening & Rollout

### T6.1 Per-template model tiers [P1]
- **Description:** Env-configurable model per template (`LLM_MODEL__CV_VALIDATE`, etc., default `LLM_MODEL`); provider already swappable — wire `modelTier` from T1.4 through `AiService`.
- **Dependencies:** T1.4
- **Complexity:** S
- **Acceptance criteria:** setting an env var routes only that template to another model (test with mock provider); pricing lookup per model with safe default.

### T6.2 Benchmark-as-gate [P1]
- **Description:** Document + enforce: any PR touching `prompts/` must include an updated `pnpm bench:ai` report artifact; CI warns (not blocks initially) on metric regression > threshold vs committed baseline.
- **Dependencies:** T2.6
- **Complexity:** S
- **Acceptance criteria:** CI surfaces regression warning on a deliberately degraded prompt PR; baseline artifact exists for all templates.

### T6.3 E2E smoke [P1]
- **Description:** Mocked-provider E2E: upload CV → 202 → profile ready → add job → match report with verdicts → improvements generated → coach message streams. Asserts cross-module wiring + RLS, not model quality.
- **Dependencies:** T4.3, T5.1
- **Complexity:** M
- **Acceptance criteria:** runs in CI offline; covers spec AC-3/AC-4/AC-5 paths.

### T6.4 Cost & observability review [P1]
- **Description:** Weekly-review query/report: tokens + cost per new operation per user per month; verify AI spend per user < Pro revenue per user (constitution §V); stage durations from `stage_meta` for p50 latency check against spec §10 targets.
- **Dependencies:** T3.4, T2.4
- **Complexity:** S
- **Acceptance criteria:** report runs against production-shaped seed data; numbers documented in phase-6 closeout.

### T6.5 Docs & cleanup [P2]
- **Description:** Update `RUNNING_LOCALLY.md` (new env vars), `AGENTS.md` (new module structure, prompt-template contract, benchmark workflow), `specs/001` cross-references where v2 supersedes; remove adapter shims from T1.4 once all templates migrated.
- **Dependencies:** all above
- **Complexity:** S
- **Acceptance criteria:** new contributor can run `pnpm bench:ai` and add a prompt template from docs alone; no v1 template reachable except flagged `coach.v1`.
