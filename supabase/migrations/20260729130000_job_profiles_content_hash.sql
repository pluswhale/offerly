-- 003-ai-pipeline-redesign T3.1: track which JD text a job_profiles row was
-- extracted from, so a stale profile is re-extracted when the job text changes
-- (spec §FR-5: cached by the job's content_hash).
alter table public.job_profiles add column content_hash text;

-- Legacy jobs rows may have a NULL content_hash; '' never matches a real
-- hash, so those rows are simply re-extracted on their next read.
update public.job_profiles jp
set content_hash = coalesce(j.content_hash, '')
from public.jobs j
where j.id = jp.job_id;

alter table public.job_profiles alter column content_hash set not null;
