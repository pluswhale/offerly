# AI Pipeline Redesign — Implementation Plan

Spec: `specs/003-ai-pipeline-redesign/spec.md` | Tasks: `specs/003-ai-pipeline-redesign/tasks.md`
Complexity scale: **S** (<half day) · **M** (~1 day) · **L** (2–3 days)

## Phasing rationale

The plan is ordered so that **the single source of truth (the Candidate Profile) exists before anything consumes it**, and so every phase ships something independently verifiable. The two hardest risks — extraction quality and verdict accuracy — are measurable by the benchmark harness from Phase 2 onward, so prompt iteration happens against data, not vibes. UX comes after the contracts are stable; Coach v2 comes last because it depends on everything.

```
P1 Schema foundation ──► P2 Profile pipeline ──► P3 JD structuring + Matching ──► P4 Consumers (review, coach)
                      └─► P5 CV improvement features ──► P6 Hardening & rollout
```

## Phase 1 — Schema & contract foundation

**What:** `packages/types` additions (Evidenced<T>, CandidateProfile, JobProfile, RequirementVerdict, MatchReport v2); zod schemas in the AI module; DB migration (`candidate_profiles`, `job_profiles`, `cv_improvements`, extend `usage_records.operation` enum, `profiles.user_goals`); weights config (`weights.v1`).

**Why first:** every later stage imports these contracts. Getting the Evidenced shape wrong after three consumers exist is the expensive mistake; getting it right now is two days.

**Dependencies:** none. **Risk:** schema over-design — mitigate by building exactly the fields in spec §FR-2, no speculative additions.

## Phase 2 — Candidate Profile pipeline

**What:** `cv-extract.v1` prompt; S2 deterministic evidence verifier + normalization util; conditional S3 `cv-validate.v1`; pipeline orchestrator with stage checkpoints and 202/polling endpoints; user-correction PATCH; profile UI (grouped, evidence-expandable, completeness badge).

**Why second:** it is the trunk every consumer branches from, and it is independently demoable (upload → see profile). The deterministic S2 checker is the highest hallucination-reduction-per-dollar component in the whole redesign — it ships here, before any consumer trusts extraction output.

**Dependencies:** P1. **Risks:** (a) extraction accuracy on messy CVs — mitigated by the fixture benchmark harness built *in this phase*, before consumers amplify errors; (b) 20k-char CVs exceeding context/cost — mitigated by the existing truncation util + `analyzed_chars` disclosure; (c) latency — 202/polling, stage checkpoints make retries cheap.

## Phase 3 — Job structuring & matching engine

**What:** `jd-extract.v1` + lazy per-job profile; skill alias map + deterministic pre-pass; `match-requirements.v1`; deterministic scoring per `weights.v1` with UNKNOWN/MISSING semantics; match report v2 storage + low-confidence gating; auto-trigger of profile pipeline from match; match report UI (verdict table, evidence, weighted breakdown bars).

**Why third:** matching is the revenue-visible payoff of the profile and the strongest moat (explainability competitors' single-prompt matchers can't show). It needs P2's profile to exist — this is the hard dependency from spec §FR-6.

**Dependencies:** P2. **Risks:** (a) verdict quality — mitigated by extending the benchmark with labeled requirement verdicts and gating prompt merges on it; (b) score weight calibration — weights live in config, not code paths, so tuning is a one-line change; ship with spec defaults, calibrate against fixture expectations, not production users.

## Phase 4 — Consumers: quality review & coach

**What:** `cv-review.v2` re-based on the profile (preserving `cv_analyses` UX contract); `recommendations.v1`; coach context manifest + `coach.v2`; "why do you think that" evidence drill-down; clarifying-question surfacing from must-have UNKNOWNs.

**Why fourth:** both consume now-stable artifacts; switching them earlier would couple prompt iteration to unfinished upstream stages. Coach is deliberately last among consumers — it has the most inputs and benefits from match reports existing.

**Dependencies:** P2 (review), P3 (recommendations, coach). **Risk:** coach regressions in perceived quality — mitigated by keeping `coach.v1` reachable behind a template-version flag during rollout.

## Phase 5 — CV improvement features

**What:** `sentence-rewrite.v1`, `bullet-improve.v1` with span verification + new-entity rejection; `cv_improvements` storage + accept/reject UI (❌/✅ diff); deterministic CV Health detectors (completeness, duplicates, tense, buzzwords, missing-keywords-from-matches, quantified-achievement ratio).

**Why fifth:** genuinely independent of P3/P4 (operates on CV text), but lower stakes than matching correctness — and it reuses P2's verification machinery. The zero-LLM detectors are cheap wins that make the feature feel rich on day one.

**Dependencies:** P2 (verification util, profile for detectors); missing-keywords detector additionally uses P3 reports. **Risk:** rewrite hallucination — mitigated by the deterministic new-entity token-diff guard (spec §FR-13).

## Phase 6 — Hardening & rollout

**What:** benchmark-as-gate wiring (prompt changes require benchmark report); per-template model-tier config; cost dashboard query for new operations; template-version invalidation sweep; E2E smoke (upload → profile → match → coach, mocked provider); docs (`RUNNING_LOCALLY.md`, `AGENTS.md` updates for new module structure).

**Why last:** hardening before behavior is complete is wasted motion.

**Dependencies:** P2–P5. **Risk:** cost drift — mitigated by weekly review already mandated by constitution §V, now with per-stage granularity.

## Cross-cutting risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Extraction quality insufficient for trustworthy matching | Medium | Benchmark harness in P2 *before* consumers; S2/S3 funnel; UNKNOWN-first design degrades gracefully |
| Token cost per user doubles (extraction + validation + matching) | Medium | Conditional S3, deterministic pre-pass, content-hash caching, per-template model tiers; measure in P6 against Pro revenue floor |
| Latency of multi-stage pipeline annoys users | Medium | 202/polling with stage progress; profile is built once per CV, amortized across all matches |
| Scope creep (queue infra, embeddings, auto-rewrite) | High | Explicit out-of-scope list (spec §11); constitution KISS/YAGNI review at each phase boundary |
| Old v1 artifacts confuse the UI during transition | Low | Versioned `result` shapes; UI feature-detects v2; old rows read-only |
