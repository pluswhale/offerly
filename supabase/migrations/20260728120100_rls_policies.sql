-- T4.1: Row Level Security per plan.md §5.
-- Every user table: rows are visible/mutable only where user_id = auth.uid().
-- ai_messages has no user_id; ownership is checked via the parent conversation.
-- llm_cache: RLS enabled with NO policies → service-role only access.

alter table public.profiles enable row level security;
alter table public.cvs enable row level security;
alter table public.cv_analyses enable row level security;
alter table public.jobs enable row level security;
alter table public.job_matches enable row level security;
alter table public.applications enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_records enable row level security;
alter table public.llm_cache enable row level security;

-- profiles: PK is the auth user id itself.
create policy "profiles_owner_all" on public.profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "cvs_owner_all" on public.cvs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "cv_analyses_owner_all" on public.cv_analyses
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "jobs_owner_all" on public.jobs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "job_matches_owner_all" on public.job_matches
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "applications_owner_all" on public.applications
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "ai_conversations_owner_all" on public.ai_conversations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "ai_messages_owner_all" on public.ai_messages
  for all to authenticated
  using (
    exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

-- subscriptions: select-only for users. Writes happen exclusively via webhook
-- handlers using the service-role key, which bypasses RLS (plan.md §2, constitution §III).
create policy "subscriptions_owner_select" on public.subscriptions
  for select to authenticated
  using (user_id = auth.uid());

-- usage_records: select-only for users (dashboard quota display). Metering writes
-- go through the API with the service-role key (plan.md §5).
create policy "usage_records_owner_select" on public.usage_records
  for select to authenticated
  using (user_id = auth.uid());

-- llm_cache: no policies on purpose — only the service role (RLS bypass) may touch it.
