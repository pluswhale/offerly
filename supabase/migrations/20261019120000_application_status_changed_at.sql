alter table public.applications add column status_changed_at timestamptz;

update public.applications set status_changed_at = updated_at;

alter table public.applications
  alter column status_changed_at set default now(),
  alter column status_changed_at set not null;

create or replace function public.touch_application_status_changed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status_changed_at := now();
  return new;
end;
$$;

create trigger on_application_status_changed
  before update of status on public.applications
  for each row
  when (old.status is distinct from new.status)
  execute function public.touch_application_status_changed_at();
