-- Interview prep (spec 004) logs its own usage operation; the original CHECK
-- constraint enumerates operations, so it is replaced with the extended list.
alter table public.usage_records
  drop constraint if exists usage_records_operation_check;

alter table public.usage_records
  add constraint usage_records_operation_check
  check (operation in ('cv_analysis', 'job_match', 'apply_generate', 'coach_message', 'interview_prep'));
