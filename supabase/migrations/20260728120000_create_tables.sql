-- T4.1: Core tables per plan.md §2.
-- All ids: uuid default gen_random_uuid(); timestamps: timestamptz default now().

-- 1:1 with auth.users (Supabase Auth owns the users table; we do not duplicate it).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  "current_role" text,
  target_role text,
  experience_level text,
  location text,
  visa_status text,
  salary_expectation jsonb,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cvs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  file_path text,          -- Supabase Storage path, null if pasted
  extracted_text text,
  content_hash text,       -- sha256 of normalized text → cache key
  is_active boolean not null default true, -- one active CV per user, enforced in app logic
  created_at timestamptz not null default now()
);
create index cvs_user_id_idx on public.cvs (user_id);

create table public.cv_analyses (
  id uuid primary key default gen_random_uuid(),
  cv_id uuid not null references public.cvs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade, -- denormalized for RLS simplicity
  score int check (score between 0 and 100),
  result jsonb,            -- sections, improvements, model version
  depth text check (depth in ('basic', 'deep')),
  created_at timestamptz not null default now()
);
create index cv_analyses_user_id_idx on public.cv_analyses (user_id);
create index cv_analyses_cv_id_idx on public.cv_analyses (cv_id);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  company text,
  url text,
  description_text text,
  content_hash text,       -- cache key; duplicate paste reuses the row (app logic)
  created_at timestamptz not null default now()
);
create index jobs_user_id_idx on public.jobs (user_id);

create table public.job_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  cv_id uuid not null references public.cvs (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  score int check (score between 0 and 100),
  result jsonb,            -- strengths, gaps, recommendations
  created_at timestamptz not null default now()
);
create index job_matches_user_id_idx on public.job_matches (user_id);
create index job_matches_job_id_idx on public.job_matches (job_id);

-- Job Tracker
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null, -- nullable: manual entries allowed
  company text not null,
  role text not null,
  status text not null default 'saved'
    check (status in ('saved', 'applied', 'interview', 'offer', 'rejected')),
  applied_at timestamptz,
  notes text,
  archived boolean not null default false, -- free limit counts only non-archived
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index applications_user_id_idx on public.applications (user_id);

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('coach', 'apply_assistant')),
  context jsonb,           -- linked cv_id/job_id
  created_at timestamptz not null default now()
);
create index ai_conversations_user_id_idx on public.ai_conversations (user_id);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system-summary')),
  content text not null,
  token_count int,
  created_at timestamptz not null default now()
);
create index ai_messages_conversation_id_idx on public.ai_messages (conversation_id);

-- Written only by webhook handlers (constitution §III); users get a default row via trigger.
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  provider text,                    -- 'stripe' (future: 'crypto'); null for default free rows
  provider_customer_id text,
  provider_subscription_id text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  status text check (status in ('active', 'past_due', 'canceled', 'trialing')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Metering + quota: monthly free-tier quota = count of rows in current month.
create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  operation text not null
    check (operation in ('cv_analysis', 'job_match', 'apply_generate', 'coach_message')),
  tokens_in int,
  tokens_out int,
  cost_microcents int,     -- estimated cost for weekly spend review (constitution §V)
  cache_hit boolean not null default false,
  created_at timestamptz not null default now()
);
create index usage_records_user_month_idx on public.usage_records (user_id, created_at);

-- Shared LLM response cache across users; service-role access only (RLS, no public policies).
create table public.llm_cache (
  cache_key text primary key, -- sha256(template_version + normalized input)
  response jsonb not null,
  created_at timestamptz not null default now() -- for TTL eviction
);
