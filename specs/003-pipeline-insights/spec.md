# Pipeline Insights — Feature Specification

Status: Draft
Source of truth: `PROJECT_CONTEXT.md`, `.specify/memory/constitution.md`, `specs/001-offerly-mvp/spec.md` §4 (Job Tracker)
Owner: solo developer

## 1. Feature Goal

Turn the Job Tracker from a passive list into a feedback loop: show the user how their pipeline is actually converting and which applications have gone quiet, directly above the board they already use.

Feature test (constitution): **"Does this help the user get a job offer faster?"** — Yes. Two concrete behaviour changes: the user sees that (a) their applications are not converting to interviews, which is a CV/targeting problem, and (b) specific applications have been untouched for weeks and need a follow-up. Both are actions that move applications forward.

## 2. Current State (as of spec writing)

- `/tracker` (`apps/web/app/(app)/tracker/tracker-client.tsx`) renders a 5-column kanban on desktop and a list on mobile, fed by `GET /applications` (+`?archived=true`). Status changes are optimistic with rollback.
- `/dashboard` already shows raw counts per status (`dashboard-client.tsx`). That is a *count*, not a *conversion*; this feature does not duplicate it and does not touch the dashboard.
- The `applications` table (`supabase/migrations/20260728120000_create_tables.sql`) stores: `status`, `archived`, `applied_at`, `created_at`, `updated_at`. **There is no status-history table.**
- `apps/web` now has a vitest runner (`pnpm --filter @offerly/web test`); no web unit tests exist yet.

### Schema constraint that shapes this spec

Because only the *current* status is stored, no metric in this feature may claim to measure a transition over time. Any funnel is a snapshot of where applications stand today, not a cohort conversion. Average time-in-stage and time-to-interview are **not computable** and are out of scope (§8) — not deferred for effort reasons, but impossible on this schema.

## 3. User Stories

### US-1 — See whether the pipeline converts (primary)

As an active applicant, I want to see what share of my applications get a reply and reach an interview, so I know whether my problem is volume or quality.

### US-2 — Catch stalled applications

As an active applicant, I want to see which applications have gone quiet, so I can follow up before they go cold.

### US-3 — Not be misled

As a user, I want the numbers to be honest about what they can and cannot know, so I don't draw the wrong conclusion from a small or ambiguous sample.

## 4. Functional Requirements

### FR-1 — Insights strip on `/tracker`

A panel renders above the kanban/list, containing three stat tiles, a funnel, and a "Needs a nudge" list. It is part of the tracker page; no new route, no nav change.

### FR-2 — Metric definitions (binding)

All metrics are computed from **non-archived applications only**, regardless of the "Show archived" toggle.

Stage reach, derived from current status:

| Stage | Counts applications whose status is |
|---|---|
| Saved | any (all non-archived) |
| Applied | `applied`, `interview`, `offer`, `rejected` |
| Interview | `interview`, `offer` |
| Offer | `offer` |

`rejected` counts as *reached Applied* but not as reached Interview or Offer: the schema does not record which stage a rejection came from. The UI must state this.

Tiles:

- **Reply rate** = (`interview` + `offer` + `rejected`) / reachedApplied. A rejection is a reply.
- **Interview rate** = reachedInterview / reachedApplied.
- **Needs a nudge** = count of applications with status `saved` or `applied` whose `updated_at` is strictly older than 14 days.

Any rate whose denominator is `0` is `null`, rendered as `—`. **No `NaN`, no `0%`, no `Infinity` ever reaches the DOM.**

### FR-3 — Funnel

Four stages in order (Saved → Applied → Interview → Offer) with the absolute count per stage and the conversion from the previous stage. A conversion whose previous stage is `0` is `null` → `—`. Bar widths are relative to the Saved count; a stage with count `0` still renders its label and `0`.

### FR-4 — Needs a nudge

Lists up to 3 stale applications, oldest `updated_at` first, each showing role · company and how long it has been quiet (reuse `formatRelative` from `apps/web/lib/format.ts`). Clicking an entry opens the existing application edit modal — the same one a kanban card opens. No new modal.

When the count is 0, the list is replaced by a single reassuring line, not an empty block.

### FR-5 — Honesty affordance

The panel carries one short line of plain text explaining the snapshot limitation (rejections count as applied; the funnel reflects current status, not history). A `title`/`aria-describedby` note is acceptable, but the limitation must be visible in text, not hover-only.

### FR-6 — Logic/rendering separation

All arithmetic lives in one pure, exported function in `apps/web/lib/pipeline-insights.ts`:

```ts
derivePipelineInsights(applications: Application[], now: Date): PipelineInsights
```

`now` is a parameter so tests are deterministic. Components receive the computed object and render it. **No metric arithmetic inside JSX or component bodies.**

## 5. Acceptance Criteria

1. With a mixed pipeline, `/tracker` shows the three tiles, the funnel with conversions, and up to three stale applications above the board.
2. With applications that are all `saved` (nothing applied yet), reply rate and interview rate render `—` and no console error occurs.
3. Archived applications affect no tile, no funnel stage, and never appear in "Needs a nudge" — including while "Show archived" is on.
4. An application whose `updated_at` is exactly 14 days old is **not** stale; 14 days plus one second **is**.
5. Clicking a "Needs a nudge" entry opens the existing edit modal for that application.
6. With zero applications, the panel does not render at all and the existing empty state is unchanged.
7. `pipeline-insights.test.ts` covers: empty input, all-archived input, zero denominators, the 14-day boundary on both sides, stage-reach counts including `rejected`, and the ≤3 cap with correct ordering.
8. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
9. `apps/web/package.json` dependencies are unchanged — no library was added.

## 6. Edge Cases

- **Single application, status `offer`** → reachedApplied = 1, reply rate 100%, interview rate 100%. Correct, if statistically meaningless; the honesty line covers it. Do not add a "too few data points" suppression rule.
- **All applications rejected** → reply rate 100%, interview rate 0%. This is the intended signal.
- **`updated_at` in the future** (clock skew) → treated as not stale; no negative durations rendered.
- **Loading / error** → the panel participates in the page's existing loading and error states; it must not render against partial data.
- **Optimistic status change** → the panel recomputes from the same local array the board renders, so a drag immediately updates the numbers. No separate fetch.
- **Very long role/company names** → truncate, do not wrap the layout.

## 7. Non-Functional Requirements

- **Mobile-first:** tiles stack to one column under `md`; the funnel stays readable at 360px.
- **Accessibility:** the funnel is a labelled list, not colour-only; every value has a visible text label; contrast meets the existing `--color-accent-*` usage.
- **No new dependencies.** No chart library — the funnel is CSS/inline SVG.
- **Performance:** derivation is O(n) over an already-fetched array; no extra request.
- **Cost:** $0. No backend, no LLM, no new query.

## 8. Out of Scope (explicitly)

- **Average time-in-stage, time-to-interview, time-to-offer** — not computable: no status history exists. Adding an `application_events` table to serve one tile is premature (constitution §II, KISS/YAGNI).
- Cohort or time-window filtering ("last 30 days") — needs the same history.
- Trend lines, sparklines, week-over-week deltas.
- Benchmarks against other users — requires cross-tenant aggregation; explicitly against the multi-tenant isolation rule for a cosmetic feature.
- Any change to `/dashboard`, to the backend, or to `@offerly/types`.
- Persisting insights, exporting them, or emailing them.

## 9. Parallel Execution Boundary

This feature is implemented in the worktree `003-pipeline-insights`, in parallel with `004-interview-prep`. The split is by file ownership, decided before either agent starts.

**Files this task may create or modify — and no others:**

```
apps/web/lib/pipeline-insights.ts              (new)
apps/web/lib/pipeline-insights.test.ts         (new)
apps/web/components/insight-tile.tsx           (new)
apps/web/components/pipeline-funnel.tsx        (new)
apps/web/app/(app)/tracker/tracker-client.tsx  (modify)
specs/003-pipeline-insights/*                  (this spec set)
```

**Hard constraints:**

- Do not touch `packages/types`, `apps/api`, `supabase/`, `apps/web/lib/contract.ts`, `apps/web/components/app-nav.tsx`, `apps/web/app/globals.css`, or any dashboard file. Those belong to the other workstream or to nobody.
- **Do not add, remove, or upgrade any dependency.** `pnpm-lock.yaml` is the only file both workstreams could collide on; neither may change it.
- If the task appears to require a file outside this list, stop and report it instead of expanding scope.
