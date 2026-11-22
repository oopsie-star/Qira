-- Stage 8 data migration, block "size and md5" (metadata of older files). Generated from the dry-run plan that
-- was approved (2026-11-22); every change is written to data_migration_log with the
-- row before and after, so the block can be undone row by row. The block
-- checks its own counts against the dry-run and aborts as a whole if they differ.
--
-- Files uploaded before the integrity work have no size or md5 in
-- attachment_notes. Both come from storage's own metadata — no file is read:
-- size from metadata.size, md5 from the eTag where it is a plain md5 (a
-- multipart eTag "…-N" is not one, and stays empty). Files that are live on a
-- task, epic or sprint and have no attachment_notes row get one.

do $$
declare
  r      record;
  v_md5  text;
  v_n    integer := 0;
  v_new  integer := 0;
begin
  for r in
    select o.name as path, (o.metadata->>'size')::bigint as size, trim(both '"' from o.metadata->>'eTag') as etag, o.metadata->>'mimetype' as mime,
           n.id as note_id, to_jsonb(n) as before, split_part(o.name, '/', 1) as project
      from storage.objects o
      left join public.attachment_notes n on n.path = o.name
     where o.bucket_id = 'attachments'
       and (n.id is not null and (n.size_bytes is null or n.md5 is null)
            or n.id is null and exists (
                 select 1 from public.tasks t where o.name = any(t.attachments) or o.name = any(t.archived_attachments)
                 union all select 1 from public.epics e where o.name = any(e.attachments) or o.name = any(e.archived_attachments)
                 union all select 1 from public.sprints s where o.name = any(s.attachments) or o.name = any(s.archived_attachments)))
  loop
    v_md5 := case when r.etag ~ '^[0-9a-f]{32}$' then r.etag end;
    if r.note_id is null then
      insert into public.attachment_notes (project_id, path, size_bytes, md5, mime_type)
      values (r.project::uuid, r.path, r.size, v_md5, r.mime);
      v_new := v_new + 1;
      insert into public.data_migration_log (block, table_name, row_id, action, before, after)
      values ('size_md5', 'attachment_notes', r.path, 'insert_note', null, jsonb_build_object('size_bytes', r.size, 'md5', v_md5, 'mime_type', r.mime));
    else
      update public.attachment_notes
         set size_bytes = coalesce(size_bytes, r.size), md5 = coalesce(md5, v_md5)
       where id = r.note_id;
      insert into public.data_migration_log (block, table_name, row_id, action, before, after)
      values ('size_md5', 'attachment_notes', r.path, 'fill_size_md5', r.before - 'body', jsonb_build_object('size_bytes', r.size, 'md5', v_md5));
    end if;
    v_n := v_n + 1;
  end loop;
  raise notice 'size_md5: % rows (% new)', v_n, v_new;
end;
$$;
