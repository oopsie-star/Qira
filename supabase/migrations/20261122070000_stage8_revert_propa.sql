-- Stage 8: undo everything stage 8 changed in project PROPA (the cleanup was
-- meant for MOMNA only; PROPA is in active work — PROPA-459 was being worked
-- on the day before). Every row comes back from data_migration_log, as it was
-- before; each undo is logged under block 'revert-propa'.
--
-- Undone: 8.3 (6 predecessors back to their status, 6 revisions back under
-- their parents, 8 supersedes links back with their ids), 8.1 (14 epic files
-- live again at their position with their old names, 5 name rows back),
-- 8.2 (49 tasks back to the trash).
-- Kept: size/md5 metadata (no effect on work) and the restored completion
-- dates (8.3-fix), which the done tasks keep.

do $$
declare
  v_propa uuid := (select id from public.projects where key = 'PROPA');
  r       record;
  v_n     integer;
begin
  -- ── 8.3: links first (so a restored parent is again a supersedes target and
  --    sync_parent_task_status leaves it alone), then parents, then statuses ──
  v_n := 0;
  for r in select * from public.data_migration_log
            where block = '8.3' and action = 'remove_supersedes' and (before->>'project_id')::uuid = v_propa loop
    insert into public.task_links select * from jsonb_populate_record(null::public.task_links, r.before);
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('revert-propa', 'task_links', r.row_id, 'restore_supersedes', null, r.before);
    v_n := v_n + 1;
  end loop;
  if v_n <> 8 then raise exception 'revert 8.3 links: % (expected 8)', v_n; end if;

  v_n := 0;
  for r in select l.*, t.parent_task_id as now_parent from public.data_migration_log l join public.tasks t on t.id::text = l.row_id
            where l.block = '8.3' and l.action = 'lift_revision' and t.project_id = v_propa loop
    update public.tasks set parent_task_id = (r.before->>'parent_task_id')::uuid where id = r.row_id::uuid;
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('revert-propa', 'tasks', r.row_id, 'restore_parent', jsonb_build_object('parent_task_id', r.now_parent), jsonb_build_object('parent_task_id', r.before->>'parent_task_id'));
    v_n := v_n + 1;
  end loop;
  if v_n <> 6 then raise exception 'revert 8.3 parents: % (expected 6)', v_n; end if;

  v_n := 0;
  for r in select l.* from public.data_migration_log l join public.tasks t on t.id::text = l.row_id
            where l.block = '8.3' and l.action = 'archive_predecessor' and t.project_id = v_propa loop
    perform set_config('qira.revision', r.row_id, true);
    update public.tasks set status = r.before->>'status' where id = r.row_id::uuid and status = 'archived';
    perform set_config('qira.revision', '', true);
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('revert-propa', 'tasks', r.row_id, 'restore_status', jsonb_build_object('status', 'archived'), jsonb_build_object('status', r.before->>'status'));
    insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
    values (v_propa, r.row_id::uuid, null, 'task_updated', 'Returned from the archive: the stage 8 cleanup is undone for this project');
    v_n := v_n + 1;
  end loop;
  if v_n <> 6 then raise exception 'revert 8.3 statuses: % (expected 6)', v_n; end if;

  -- ── 8.1: files live again, old names back ──
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_n := 0;
  for r in select * from public.data_migration_log
            where block = '8.1' and action = 'archive_and_strip' and (before->>'project_id')::uuid = v_propa loop
    perform public.set_attachment_archived(r.row_id, false, null, 'stage8-revert');
    update public.attachment_notes
       set original_name = r.before->>'original_name', retired_name = null
     where path = r.row_id;
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('revert-propa', 'attachment_notes', r.row_id, 'restore_live_and_name', null, jsonb_build_object('original_name', r.before->>'original_name'));
    v_n := v_n + 1;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  if v_n <> 14 then raise exception 'revert 8.1 files: % (expected 14)', v_n; end if;

  v_n := 0;
  for r in select * from public.data_migration_log
            where block = '8.1' and action = 'delete_name_without_file' and (before->>'project_id')::uuid = v_propa loop
    insert into public.attachment_notes select * from jsonb_populate_record(null::public.attachment_notes, r.before)
      on conflict do nothing;
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('revert-propa', 'attachment_notes', r.row_id, 'restore_name_row', null, r.before);
    v_n := v_n + 1;
  end loop;
  if v_n <> 5 then raise exception 'revert 8.1 name rows: % (expected 5)', v_n; end if;

  -- ── 8.2: back to the trash ──
  v_n := 0;
  for r in select l.* from public.data_migration_log l join public.tasks t on t.id::text = l.row_id
            where l.block = '8.2' and t.project_id = v_propa and t.status = 'archived' loop
    perform set_config('qira.revision', r.row_id, true);
    update public.tasks set status = 'deleted' where id = r.row_id::uuid;
    perform set_config('qira.revision', '', true);
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('revert-propa', 'tasks', r.row_id, 'restore_status', jsonb_build_object('status', 'archived'), jsonb_build_object('status', 'deleted'));
    v_n := v_n + 1;
  end loop;
  if v_n <> 49 then raise exception 'revert 8.2: % (expected 49)', v_n; end if;
end;
$$;
