## Why

The Job Tracker is a passive board: users see where each application sits, but not whether their search is working. They can't tell if applications convert into replies and interviews, how long things sit in a stage, or which applications have gone quiet and need a follow-up.

## What Changes

- Add an insights panel above the board on `/tracker` with:
  - conversion tiles: applications sent, reply rate, interview rate (snapshot of current statuses);
  - average days in current stage for the open stages (Saved, Applied, Interview);
  - a "Gone quiet" list: Applied/Interview applications with no status change for more than 14 days, clickable to the existing edit modal.
- Show "N days in stage" on each tracker card / mobile list item.
- Record when an application last changed status: new `applications.status_changed_at` column, maintained by a database trigger, backfilled from `updated_at`.
- Expose `status_changed_at` on the `Application` type (the API already returns `select("*")`, so no endpoint change).
- Dashboard "Follow up" next-best-action uses the same "gone quiet" definition as the tracker. **Behaviour change:** it now triggers after 14 days without a status change (was: 7 days since `applied_at`/`created_at`) and also covers Interview.
- Demo seed script sets `status_changed_at` so seeded data shows realistic stage ages.
- Supersedes the earlier `specs/003-pipeline-insights` draft (deleted), which ruled out time-in-stage because no status timestamp existed.

## Capabilities

### New Capabilities
- `tracker-insights`: pipeline conversion, time-in-stage and gone-quiet signals shown on the tracker, the status-change clock that feeds them, and the dashboard follow-up nudge that shares the same quiet definition.

### Modified Capabilities
_None — no existing OpenSpec specs in this repo._

## Impact

- **Database:** one migration on `public.applications` (column + trigger). Additive, nullable-safe via backfill; no RLS change.
- **Types:** `packages/types` — `Application.status_changed_at: string`.
- **Web:** `apps/web/lib/pipeline-insights.ts` (pure derivation), `apps/web/lib/next-action.ts`, `apps/web/app/(app)/tracker/tracker-client.tsx`, new presentational component(s).
- **API:** no code change.
- **Scripts:** `apps/api/scripts/seed-demo-applications.mjs`.
- **Dependencies:** none added.
- **Deferred:** true average transition times and cohort conversion (needs a status-event history table), rejection-stage attribution, auto-setting `applied_at` on move to Applied, funnel visualisation, time-window filters, trends.
