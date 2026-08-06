-- 003-ai-pipeline-redesign T1.2: Candidate Profile pipeline artifacts.
-- candidate_profiles / job_profiles / cv_improvements per spec §FR-2/§FR-5/§FR-12,
-- new usage_records operations per spec §10, profiles.user_goals per spec §FR-11.

-- Immutable Candidate Profile rows; one 'ready' profile per CV (spec §FR-1).
create table public.candidate_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  cv_id uuid not null references public.cvs (id) on delete cascade,
  version int not null default 1,       -- profile version; part of match-reuse key
  status text not null default 'extracting'
    check (status in ('extracting', 'validating', 'ready', 'failed')),
  profile jsonb not null,               -- CandidateProfile (validated server-side)
  stage_meta jsonb,                     -- per-stage: template version, tokens, duration, flags
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index candidate_profiles_user_id_idx on public.candidate_profiles (user_id);
create index candidate_profiles_cv_id_idx on public.candidate_profiles (cv_id);
create unique index candidate_profiles_one_ready_per_cv
  on public.candidate_profiles (cv_id) where status = 'ready';

-- Structured JD per jobs row (spec §FR-5). One profile per job; cached by the
-- job's content_hash at the app level (same JD text never costs twice).
create table public.job_profiles (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.jobs (id) on delete cascade,
  profile jsonb not null,               -- JobProfile (validated server-side)
  template_version text not null,       -- e.g. 'jd-extract.v1'
  created_at timestamptz not null default now()
);
create index job_profiles_job_id_idx on public.job_profiles (job_id);

-- Sentence/bullet rewrite suggestions + deterministic health findings (spec §FR-12/§FR-14).
create table public.cv_improvements (
  id uuid primary key default gen_random_uuid(),
  cv_id uuid not null references public.cvs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('sentence', 'bullet', 'health')),
  suggestions jsonb not null,           -- per-suggestion status: pending|accepted|rejected
  template_version text,                -- prompt version that produced the row (spec §10)
  created_at timestamptz not null default now()
);
create index cv_improvements_user_id_idx on public.cv_improvements (user_id);
create index cv_improvements_cv_id_idx on public.cv_improvements (cv_id);

-- New metering operations (spec §10). The operation column is a CHECK
-- constraint, so extend it by replacing the constraint.
alter table public.usage_records drop constraint usage_records_operation_check;
alter table public.usage_records add constraint usage_records_operation_check
  check (operation in (
    'cv_analysis', 'job_match', 'apply_generate', 'coach_message',
    'cv_profile', 'jd_extract', 'match_requirements', 'cv_improve'
  ));

-- Progressive-profiling goals for the coach context manifest (spec §FR-11):
-- {target_location, target_salary, priority}, collected inline, never blocking.
alter table public.profiles add column user_goals jsonb;

-- RLS: owner-only on all new tables (constitution: RLS on every user table).
alter table public.candidate_profiles enable row level security;
alter table public.job_profiles enable row level security;
alter table public.cv_improvements enable row level security;

create policy "candidate_profiles_owner_all" on public.candidate_profiles
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- job_profiles has no user_id; ownership is checked via the parent job
-- (same pattern as ai_messages → ai_conversations).
create policy "job_profiles_owner_all" on public.job_profiles
  for all to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.user_id = auth.uid()
    )
  );

create policy "cv_improvements_owner_all" on public.cv_improvements
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
