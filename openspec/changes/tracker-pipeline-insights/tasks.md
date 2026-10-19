## 1. Status-change clock (database + types)

- [x] 1.1 Review the existing WIP migration `supabase/migrations/20261019120000_application_status_changed_at.sql` against design D1 (column, backfill from `updated_at`, `NOT NULL default now()`, `BEFORE UPDATE OF status ... WHEN distinct` trigger, `search_path = ''`); verify by applying it to a local/dev database and checking that a notes-only update leaves `status_changed_at` unchanged while a status update bumps it
- [x] 1.2 Keep `status_changed_at: string` on `Application` in `packages/types/src/db.ts`; verify `pnpm --filter @offerly/web typecheck` and the API typecheck pass
- [x] 1.3 Update `apps/api/scripts/seed-demo-applications.mjs` to set `status_changed_at` per row (from the row's `updated` offset); verify by reading the script and, if a dev DB is available, re-seeding and checking stage ages are non-zero

## 2. Pure derivation

- [x] 2.1 Adjust `apps/web/lib/pipeline-insights.ts` per design D2: `QUIET_DAYS = 14`, `isQuiet` = non-archived, status `applied|interview`, `status_changed_at` strictly older than cutoff; `avgDaysInStage` for `saved|applied|interview` only; `quiet` sorted by `status_changed_at` ascending; `daysInStage` clamped ≥ 0; verify with typecheck
- [x] 2.2 Add `apps/web/lib/pipeline-insights.test.ts` covering: empty input, all-archived input, zero-denominator rates → `null`, the mixed-pipeline example from the spec (10 / 60% / 30%), rejected counted as reply but not interview, 14-day boundary on both sides, Saved/Offer/Rejected never quiet, quiet ordering, average days per open stage and `null` for empty stage, future timestamp → 0; verify `pnpm --filter @offerly/web test` passes

## 3. Dashboard consistency

- [x] 3.1 Keep `apps/web/lib/next-action.ts` using `isQuiet` from `pipeline-insights` (no local threshold); add a focused test that a 10-day-old Applied application yields no follow-up action and a 15-day-old one does; verify `pnpm --filter @offerly/web test` passes

## 4. Tracker UI

- [x] 4.1 Create a presentational `PipelineInsights` component (in `apps/web/components/`) that takes the derived insights plus an `onSelect(app)` callback and renders: Applied / Reply rate / Interview rate tiles (`—` for `null`, whole percentages), average days in stage for Saved/Applied/Interview (`—` for `null`), the gone-quiet count and list (role · company · days quiet, oldest first) or a reassuring line when empty, and the visible snapshot disclaimer; tiles stack below `md`; verify with lint + typecheck
- [ ] 4.2 Render `PipelineInsights` in `tracker-client.tsx` between the header and the board, only in the loaded and non-empty branch, computing `derivePipelineInsights(applications, new Date())` from the same local array; wire `onSelect` to `setEditing`; verify in the browser that the panel appears with seeded data and is absent for an empty account
- [ ] 4.3 Show "Nd in stage" on `TrackerCard` and on mobile list items using `daysInStage`; verify visually on desktop and at mobile width
- [ ] 4.4 In `changeStatus`, set `status_changed_at` to now in the optimistic copy; verify in the browser that dragging a card shows 0 days in stage and the insights update immediately

## 5. Final validation

- [x] 5.1 Run `pnpm --filter @offerly/web lint`, `typecheck`, `test` and `build`; verify all pass and `apps/web/package.json` dependencies are unchanged
- [ ] 5.2 Manual check against spec scenarios: "Show archived" toggle does not change any insight; clicking a gone-quiet entry opens the edit dialog; dashboard follow-up count matches the tracker's gone-quiet count
