## Context

- `/tracker` (`apps/web/app/(app)/tracker/tracker-client.tsx`) fetches `GET /applications` once and keeps a local copy for optimistic status changes, archive and delete; after each mutation it reloads from the server.
- All application writes go through the Nest API (`applications.service.ts`). Every PATCH sets `updated_at = now()`, so `updated_at` moves on notes/company/role edits and is not a status clock.
- `applications` stores only the current `status`; there is no history. `applied_at` is a manual date field and is often empty.
- The dashboard next-best-action (`apps/web/lib/next-action.ts`) has its own "stale applied" rule.
- Uncommitted WIP already exists on this branch: the migration, `pipeline-insights.ts`, the `Application` type field, a `next-action.ts` refactor, and a seed script. This design adopts it with adjustments listed below.

## Goals / Non-Goals

**Goals:**
- A single pure function derives all insight numbers from the already-fetched array; components only render.
- Status-change time is captured at the database, so it is correct for every write path.

**Non-Goals:**
- Status-event history, average transition times, cohort conversion, rejection-stage attribution.
- Any new endpoint, server-side aggregation, or caching.
- Charts or a chart library.

## Decisions

### D1. `status_changed_at` column maintained by a trigger
`BEFORE UPDATE OF status ... WHEN (old.status IS DISTINCT FROM new.status)` sets `new.status_changed_at := now()`. Inserts use `default now()`. Backfill from `updated_at`, then `NOT NULL`.

- *Why trigger, not API code:* one place, covers any future writer (scripts, SQL, other endpoints), and the API needs no change because it selects `*`.
- *Alternative — `application_status_events` table:* gives real time-per-stage, but a new table, RLS policy and query for a first iteration. Deferred; this column doesn't block adding it later.
- *Alternative — reuse `updated_at`:* rejected; notes edits would reset "quiet".
- Function uses `set search_path = ''` like existing triggers; no `security definer` needed (runs as the updating user under existing RLS).

### D2. Pure derivation in `apps/web/lib/pipeline-insights.ts`
`derivePipelineInsights(applications, now)` returns `{ applied, replyRate, interviewRate, avgDaysInStage, quiet }`, plus exported helpers `isQuiet(app, now)` and `daysInStage(app, now)`. `now` is a parameter for deterministic tests. Rates are `number | null`; formatting (`—`, `%`) happens in the component.

Adjustments to the WIP version:
- `QUIET_DAYS = 14` (rename from `FOLLOW_UP_DAYS = 7`).
- `isQuiet`: status in `applied | interview`, clock = `status_changed_at`, strict `<` cutoff (WIP used `applied` only and `applied_at ?? created_at`).
- `avgDaysInStage` only for `saved | applied | interview`.
- `quiet` sorted by `status_changed_at` ascending.
- Archived filtering stays inside the function so callers can pass the full array.

### D3. Client-side compute on the tracker's local array
The panel is fed from the same `applications` state the board renders, so optimistic changes update insights instantly and no extra request is made. The optimistic status update also sets `status_changed_at` to now locally; the post-mutation reload replaces it with the server value.

Because the tracker fetches only non-archived applications unless "Show archived" is on, and the function filters archived anyway, insights are identical in both toggle states.

### D4. UI placement
One `PipelineInsights` presentational component rendered between the header and the board, only in the loaded, non-empty branch. Mobile-first: tiles stack under `md`. Gone-quiet entries are buttons calling the existing `setEditing(app)`. Per-card "Nd in stage" is a small text line in `TrackerCard` and the mobile list item. No new dependencies; reuse existing `Badge`/typography tokens.

### D5. Dashboard shares `isQuiet`
`next-action.ts` imports `isQuiet` (already done in WIP). This changes the dashboard nudge from 7 days/Applied-only to 14 days/Applied+Interview — accepted to keep the two pages consistent.

## Risks / Trade-offs

- [Backfilled `status_changed_at = updated_at` is approximate for existing rows (a later notes edit makes it look newer)] → Accepted; only affects pre-existing data, and errs towards *not* flagging quiet.
- [Snapshot conversion can mislead: rejected-after-interview counts only as a reply] → Visible disclaimer; true attribution deferred to an event table.
- [Small samples give extreme percentages (1 of 1 = 100%)] → Accepted for now; no suppression rule.
- [Client clock skew] → `daysInStage` clamps to ≥ 0.
- [Dashboard nudge becomes less eager (14d vs 7d)] → Intentional, agreed.
- [Seed rows inserted without `status_changed_at` get `now()`] → Seed script sets it explicitly.

## Migration Plan

1. Apply `20261019120000_application_status_changed_at.sql` (`pnpm dlx supabase db push`) before deploying web — the web reads the new field.
2. Deploy web. API needs no redeploy.
3. Rollback: revert web; the column and trigger are harmless if left in place. Full rollback: `drop trigger on_application_status_changed on public.applications; drop function public.touch_application_status_changed_at(); alter table public.applications drop column status_changed_at;`.
