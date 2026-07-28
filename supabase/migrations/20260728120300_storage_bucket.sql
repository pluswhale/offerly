-- T4.1: Private 'cvs' storage bucket per plan.md §9.
-- 5 MB limit, PDF/DOCX only. Files live under '<user_id>/...' so owner-only
-- policies can be expressed on the path prefix.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cvs',
  'cvs',
  false,
  5242880, -- 5 MB
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
);

create policy "cvs_bucket_owner_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "cvs_bucket_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "cvs_bucket_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "cvs_bucket_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);
