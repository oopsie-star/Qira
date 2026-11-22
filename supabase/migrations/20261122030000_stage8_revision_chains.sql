-- Stage 8 data migration, block 8.3 (revision chains). Generated from the dry-run plan that
-- was approved (2026-11-22); every change is written to data_migration_log with the
-- row before and after, so the block can be undone row by row. The block
-- checks its own counts against the dry-run and aborts as a whole if they differ.
--
-- Eight live predecessors of a revision. For each: the revisions that sit
-- under it as subtasks are lifted to its own parent; for MOMNA-326/327 the
-- open subtask, the live files and the comments not in the revision move to
-- the revision first (the two "тест уведомлений" comments are archived);
-- then the supersedes links are removed and the predecessor archived. Nothing
-- is merged; the predecessor keeps its other comments and closed history in
-- its archive.

do $$
declare
  r        record;
  v_old    public.tasks%rowtype;
  v_new    public.tasks%rowtype;
  v_succ   uuid[];
  v_files  text[];
  v_row    record;
  v_links  integer := 0;
  v_done   integer := 0;
begin
  for r in select * from (values
    ('PROPA-457', null::text, null::text, '{}'::uuid[], '{}'::uuid[]),
    ('PROPA-458', null::text, null::text, '{}'::uuid[], '{}'::uuid[]),
    ('PROPA-450', null::text, null::text, '{}'::uuid[], '{}'::uuid[]),
    ('PROPA-451', null::text, null::text, '{}'::uuid[], '{}'::uuid[]),
    ('PROPA-465', null::text, null::text, '{}'::uuid[], '{}'::uuid[]),
    ('PROPA-459', null::text, null::text, '{}'::uuid[], '{}'::uuid[]),
    ('MOMNA-326', 'MOMNA-990', 'MOMNA-563', array['12931c38-fc98-4287-b485-ab428063a147', 'd732ae22-cccd-4c71-90c6-82fbbeea327f']::uuid[], '{}'::uuid[]),
    ('MOMNA-327', 'MOMNA-991', 'MOMNA-565', array['4b584ef3-bb53-4796-8fb6-151fb44a1a4b']::uuid[], array['3352f90f-7d19-4029-b532-75c6f15e32a9', '7ac0afe7-7271-4ffc-beb5-32b28ff00ea3']::uuid[])
  ) v(old_key, new_key, move_subtask, move_comments, test_comments) loop
    select * into v_old from public.tasks where key = r.old_key;
    if v_old.id is null or v_old.status in ('archived', 'deleted') then
      raise exception '8.3: % is missing or already %, the plan is stale', r.old_key, v_old.status;
    end if;
    select array_agg(source_task_id) into v_succ from public.task_links where link_type = 'supersedes' and target_task_id = v_old.id;

    if r.new_key is not null then
      select * into v_new from public.tasks where key = r.new_key;
      if not v_new.id = any(v_succ) then
        raise exception '8.3: % does not supersede %', r.new_key, r.old_key;
      end if;
      -- the other open subtask goes with the revision
      for v_row in select * from public.tasks where key = r.move_subtask and parent_task_id = v_old.id loop
        insert into public.data_migration_log (block, table_name, row_id, action, before, after)
        values ('8.3', 'tasks', v_row.id::text, 'move_subtask', jsonb_build_object('key', v_row.key, 'parent_task_id', v_row.parent_task_id), jsonb_build_object('parent_task_id', v_new.id));
        update public.tasks set parent_task_id = v_new.id where id = v_row.id;
      end loop;
      -- live files: appended to the revision, removed from the predecessor (a move, not an archive)
      v_files := coalesce(v_old.attachments, '{}');
      if cardinality(v_files) > 0 then
        perform set_config('qira.attachment_move', 'on', true);
        update public.tasks set attachments = coalesce(attachments, '{}') || v_files where id = v_new.id;
        update public.tasks set attachments = '{}' where id = v_old.id;
        perform set_config('qira.attachment_move', '', true);
        insert into public.data_migration_log (block, table_name, row_id, action, before, after)
        values ('8.3', 'tasks', v_old.id::text, 'move_files', jsonb_build_object('key', v_old.key, 'attachments', v_files), jsonb_build_object('moved_to', v_new.key));
      end if;
      for v_row in select * from public.task_comments where id = any(r.move_comments) and task_id = v_old.id loop
        insert into public.data_migration_log (block, table_name, row_id, action, before, after)
        values ('8.3', 'task_comments', v_row.id::text, 'move_comment', jsonb_build_object('task_id', v_row.task_id), jsonb_build_object('task_id', v_new.id));
        update public.task_comments set task_id = v_new.id where id = v_row.id;
      end loop;
      if (select count(*) from public.task_comments where id = any(r.move_comments) and task_id = v_new.id) <> cardinality(r.move_comments) then
        raise exception '8.3: not every comment of % moved', r.old_key;
      end if;
      for v_row in select * from public.task_comments where id = any(r.test_comments) and archived_at is null loop
        insert into public.data_migration_log (block, table_name, row_id, action, before, after)
        values ('8.3', 'task_comments', v_row.id::text, 'archive_test_comment', jsonb_build_object('archived_at', null), jsonb_build_object('archive_reason', 'test comment'));
        update public.task_comments set archived_at = now(), archive_reason = 'Тестовый комментарий (уборка, этап 8)' where id = v_row.id;
      end loop;
      insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
      values (v_new.project_id, v_new.id, null, 'task_updated',
              format('Moved here from %s (data migration, stage 8): %s file(s), %s comment(s)%s', v_old.key, cardinality(v_files), cardinality(r.move_comments),
                     case when r.move_subtask is not null then ', subtask ' || r.move_subtask else '' end));
    end if;

    -- revisions sitting under the predecessor are lifted to its parent
    for v_row in select * from public.tasks where parent_task_id = v_old.id and id = any(v_succ) loop
      insert into public.data_migration_log (block, table_name, row_id, action, before, after)
      values ('8.3', 'tasks', v_row.id::text, 'lift_revision', jsonb_build_object('key', v_row.key, 'parent_task_id', v_old.id), jsonb_build_object('parent_task_id', v_old.parent_task_id));
      update public.tasks set parent_task_id = v_old.parent_task_id where id = v_row.id;
    end loop;

    for v_row in select * from public.task_links where link_type = 'supersedes' and target_task_id = v_old.id loop
      insert into public.data_migration_log (block, table_name, row_id, action, before, after)
      values ('8.3', 'task_links', v_row.id::text, 'remove_supersedes', to_jsonb(v_row), null);
      delete from public.task_links where id = v_row.id;
      v_links := v_links + 1;
    end loop;

    perform set_config('qira.revision', v_old.id::text, true);
    update public.tasks set status = 'archived' where id = v_old.id;
    perform set_config('qira.revision', '', true);
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('8.3', 'tasks', v_old.id::text, 'archive_predecessor', jsonb_build_object('key', v_old.key, 'status', v_old.status), jsonb_build_object('status', 'archived'));
    insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
    values (v_old.project_id, v_old.id, null, 'task_updated', 'Archived as a predecessor of its revision (data migration, stage 8)');
    v_done := v_done + 1;
  end loop;

  if v_done <> 8 or v_links <> 10 then
    raise exception '8.3: archived % predecessors (expected 8), removed % links (expected 10)', v_done, v_links;
  end if;
end;
$$;
