# Pipeline Insights — Technical Implementation Plan

Spec: `specs/003-pipeline-insights/spec.md`
Constitution: `.specify/memory/constitution.md` (binding — KISS/YAGNI, §I coding standards, §IV testing priority)

## 0. Strategy

Frontend-only, no new data. Everything the panel shows is already in the `Application[]` the tracker fetches; the feature is a derivation plus a render.

The shape of the change is deliberately boring:

1. One pure module (`pipeline-insights.ts`) that turns `Application[] + now` into a typed result. This is where every rule from spec §4 lives, and it is the only part with tests.
2. Two presentational components that take already-computed values.
3. One integration point in `tracker-client.tsx`.

Everything risky about this feature (`NaN`, archived leakage, the stale boundary, `rejected` handling) is arithmetic — so it all goes in the pure module, where it can be tested without rendering anything. That is the whole design.

### Scope options considered

| Scope | Content | Decision |
|---|---|---|
| **Minimal** | Three tiles only | Rejected — the funnel is what turns counts into a diagnosis, and it costs one component |
| **Selected** | Tiles + funnel + nudge list, pure-function core, unit tests | **Chosen** |
| Complete | Add `application_events` for real time-in-stage metrics | Rejected — a table, a trigger, a migration and a backfill to serve one tile. Revisit only if users ask for timing data |

## 1. Module: `apps/web/lib/pipeline-insights.ts`

Exported types and one function. No React import, no DOM reference, no `Date.now()` inside.

```ts
import type { Application, ApplicationStatus } from "@offerly/types";

export const STALE_DAYS = 14;

export interface FunnelStage {
  key: "saved" | "applied" | "interview" | "offer";
  label: string;
  count: number;
  /** Conversion from the previous stage, 0–1. null when the previous stage is 0. */
  conversionFromPrevious: number | null;
}

export interface PipelineInsights {
  /** Non-archived total; 0 means the caller should not render the panel. */
  total: number;
  /** Share of applied-or-beyond that got any reply (interview, offer or rejected). null when nothing was applied. */
  replyRate: number | null;
  /** Share of applied-or-beyond that reached interview or offer. null when nothing was applied. */
  interviewRate: number | null;
  staleCount: number;
  /** Up to 3, oldest updated_at first. */
  staleApplications: Application[];
  funnel: FunnelStage[];
}

export function derivePipelineInsights(
  applications: Application[],
  now: Date,
): PipelineInsights;
```

Implementation rules:

- First step is `const active = applications.filter((a) => !a.archived)`. Nothing downstream sees archived rows (spec FR-2).
- Stage reach uses explicit status sets, not a numeric rank — `rejected` does not fit on a linear rank, and encoding it as one is how this gets silently wrong:
  ```ts
  const REACHED_APPLIED: ApplicationStatus[] = ["applied", "interview", "offer", "rejected"];
  const REACHED_INTERVIEW: ApplicationStatus[] = ["interview", "offer"];
  const REACHED_OFFER: ApplicationStatus[] = ["offer"];
  ```
- One division helper used by every rate and conversion:
  ```ts
  const ratio = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : numerator / denominator;
  ```
  No other division appears in the file. This is the single defence against `NaN` and `Infinity`.
- Staleness:
  ```ts
  const ageMs = now.getTime() - new Date(a.updated_at).getTime();
  const isStale = ageMs > STALE_DAYS * 24 * 60 * 60 * 1000;
  ```
  Strict `>` gives the boundary behaviour in spec AC-4, and a future `updated_at` yields a negative age, which is never stale (spec §6).
- `staleApplications` is sorted ascending by `updated_at` then sliced to 3. Sort a copy; never mutate the input array.

## 2. Components

### `apps/web/components/insight-tile.tsx`

```tsx
export function InsightTile(props: {
  label: string;
  value: string;        // already formatted by the caller — "—" for null
  hint?: string;
  tone?: "default" | "warn";
}): JSX.Element
```

Styling follows the existing `Card`/`CardBody` idiom (`apps/web/components/card.tsx`) and the `--color-accent-*` / neutral tokens already in `globals.css`. Numbers use `tabular-nums`, as the dashboard does. `tone="warn"` is used only by the nudge tile when `staleCount > 0`; it changes colour, not layout.

Formatting lives in the caller, in one helper inside `tracker-client.tsx`:
`const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`)`.

### `apps/web/components/pipeline-funnel.tsx`

Takes `stages: FunnelStage[]` and renders an ordered list. Per stage: label, count, a proportional bar, and the conversion from the previous stage (`—` when null).

- Bar width: `count / stages[0].count` as a percentage, guarded for a zero first stage. Inline `style={{ width }}` is acceptable here — Tailwind cannot express a computed percentage.
- Semantics: `<ol>` with one `<li>` per stage; each `<li>` carries an `aria-label` reading like `"Interview: 3 applications, 50% from Applied"`. Colour never carries meaning on its own (spec §7).
- No SVG needed — four divs with a width are enough. Do not reach for a chart library.

## 3. Integration: `apps/web/app/(app)/tracker/tracker-client.tsx`

One insertion, between the page header/error block and the `loading ? ... : ...` board, plus one `useMemo`:

```tsx
const insights = useMemo(
  () => derivePipelineInsights(applications, new Date()),
  [applications],
);
```

- `applications` is the component's existing local-or-server array, so optimistic drag-and-drop updates recompute the panel for free (spec §6). Do not add a fetch.
- Render the panel only when `!loading && !error && insights.total > 0` (spec AC-6).
- Nudge entries call the existing `setEditing(app)` — the same handler a kanban card uses. Do not build a second modal path.
- Each nudge row is a `<button type="button">` with `min-h-11` (the touch target size used across the app), not a clickable `<div>`.
- Do not restructure, reformat or refactor anything else in this file. The diff should be an insertion plus imports.

## 4. Tests: `apps/web/lib/pipeline-insights.test.ts`

Vitest, pure function only, no rendering. A small factory keeps cases readable:

```ts
const app = (over: Partial<Application> = {}): Application => ({
  id: crypto.randomUUID(), user_id: "u1", job_id: null,
  company: "Acme", role: "Engineer", status: "saved",
  applied_at: null, notes: null, archived: false,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});
```

Required cases (spec AC-7):

1. Empty array → `total: 0`, both rates `null`, empty funnel counts, no throw.
2. Only archived rows → identical to the empty case.
3. All `saved` → `replyRate` and `interviewRate` are `null`, not `0`.
4. `rejected` counts in `reachedApplied` and in `replyRate`, but not in `reachedInterview`.
5. Stale boundary: exactly 14 days old → not stale; 14 days + 1s → stale. Pass a fixed `now`.
6. Stale list caps at 3 and is ordered oldest first; `interview`/`offer`/`rejected` rows are never stale regardless of age.
7. A future `updated_at` is not stale.
8. Funnel conversions: a known fixture (e.g. 10 saved / 6 applied-or-beyond / 3 interview-or-offer / 1 offer) produces the expected counts and ratios, and the Saved→Applied conversion is `null` when there are no applications at all.

Assert on ratios (`0.5`), not formatted strings — formatting is the component's job.

## 5. Verification

```
pnpm --filter @offerly/web test     # fast loop while implementing
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git diff --stat                     # must match spec §9's file list exactly
git diff -- pnpm-lock.yaml          # must be empty
```

Manual pass on the seeded dev account: mixed pipeline renders correctly; "Show archived" does not change any number; a drag between columns updates the funnel immediately; 360px width has no horizontal scroll.
