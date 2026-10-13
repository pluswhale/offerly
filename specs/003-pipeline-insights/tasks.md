# Pipeline Insights — Implementation Tasks

Plan: `specs/003-pipeline-insights/plan.md` | Spec: `specs/003-pipeline-insights/spec.md`
Complexity: **S** (<half day) · **M** (~1 day)
Order principle: pure logic and its tests first — they are the specification made executable. UI only after the numbers are provably right.

---

### T1 — Pure derivation module

- **Description:** Create `apps/web/lib/pipeline-insights.ts` exactly as typed in plan §1: `STALE_DAYS`, `FunnelStage`, `PipelineInsights`, `derivePipelineInsights(applications, now)`. Filter archived rows first. Use explicit status sets for stage reach, the single `ratio()` helper for every division, strict `>` for staleness, and a non-mutating sort for the stale list.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** No React or DOM reference in the file; no `Date.now()` inside the function; exactly one division expression in the module; `pnpm --filter @offerly/web typecheck` passes.

### T2 — Unit tests for the derivation

- **Description:** Create `apps/web/lib/pipeline-insights.test.ts` covering all eight cases in plan §4, using a fixed `now` and the `app()` factory. Assert numeric ratios, never formatted strings.
- **Dependencies:** T1
- **Complexity:** S
- **Acceptance criteria:** `pnpm --filter @offerly/web test` passes; every case from spec AC-7 is present; the 14-day boundary is asserted on both sides.

### T3 — `InsightTile` component

- **Description:** Create `apps/web/components/insight-tile.tsx` per plan §2: `label`, pre-formatted `value`, optional `hint`, `tone: "default" | "warn"`. Reuse the `Card`/`CardBody` idiom and existing tokens; `tabular-nums` on the value.
- **Dependencies:** none (can run alongside T1/T2)
- **Complexity:** S
- **Acceptance criteria:** Purely presentational — no arithmetic, no data fetching, no `null` handling (the caller passes `"—"`); renders correctly at 360px.

### T4 — `PipelineFunnel` component

- **Description:** Create `apps/web/components/pipeline-funnel.tsx` taking `stages: FunnelStage[]`. Ordered list, one row per stage with label, count, proportional bar and conversion-from-previous (`—` when null). Bar width guarded against a zero first stage. Per-row `aria-label` as in plan §2.
- **Dependencies:** T1 (for the `FunnelStage` type)
- **Complexity:** S
- **Acceptance criteria:** No chart library; colour is never the only carrier of meaning; a stage with count 0 still renders; no horizontal overflow at 360px.

### T5 — Wire the panel into the tracker

- **Description:** In `apps/web/app/(app)/tracker/tracker-client.tsx`, add the `useMemo` derivation over the existing `applications` array and render the panel between the header/error block and the board: three `InsightTile`s, the funnel, the "Needs a nudge" list (≤3 rows, each a `min-h-11` button calling the existing `setEditing(app)`), and the one-line honesty note from spec FR-5. Render only when `!loading && !error && insights.total > 0`. Add the `pct()` formatter locally.
- **Dependencies:** T1, T3, T4
- **Complexity:** M
- **Acceptance criteria:** No new fetch; no second modal; archived toggle changes no number; a drag between columns updates the panel immediately; the diff on this file is an insertion plus imports, with no unrelated reformatting.

### T6 — Full verification

- **Description:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Then `git diff --stat` and confirm the changed-file list matches spec §9 exactly, and `git diff -- pnpm-lock.yaml` is empty. Manually walk spec §5 acceptance criteria 1–6 against the seeded dev account, including the 360px layout.
- **Dependencies:** T1–T5
- **Complexity:** S
- **Acceptance criteria:** All four commands pass; the file list matches; the lockfile is untouched; every acceptance criterion in spec §5 is confirmed, or any deviation is reported rather than worked around.

---

## Dependency graph

```
T1 ──> T2
 │
 ├──> T4 ──┐
T3 ────────┤
           v
          T5 ──> T6
```
