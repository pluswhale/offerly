-- T1.3 (specs/002-google-auth): full_name fallback for OAuth providers.
-- Google supplies `full_name` in raw_user_meta_data, but other providers use
-- `name`; coalesce so profile provisioning works regardless. Trigger binding
-- is untouched — replacing the function body is sufficient.
-- Rollback: re-apply the function body from 20260728120200_triggers.sql.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  );
  return new;
end;
$$;
