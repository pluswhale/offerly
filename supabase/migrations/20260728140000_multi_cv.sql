-- T12.1 Multiple CVs: user-facing name + one-active-per-user invariant.

alter table public.cvs add column name text not null default 'Pasted CV';

-- Backfill uploaded CVs with the original filename. Storage paths are
-- '<user_id>/<uuid>-<filename>' and a uuid is 36 chars, so the filename
-- starts at char 38 of the path segment after the first '/'.
update public.cvs
set name = substring(split_part(file_path, '/', 2) from 38)
where file_path is not null;

-- Exactly one active CV per user, enforced at the DB level (replaces the
-- app-logic-only note on is_active in 20260728120000_create_tables.sql).
create unique index cvs_one_active_per_user on public.cvs (user_id) where is_active;
