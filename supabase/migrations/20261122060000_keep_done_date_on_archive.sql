-- A done task keeps its completion date when it is archived or trashed.
--
-- handle_task_lifecycle cleared completed_at on any move out of 'done', so
-- archiving a finished task (in the app, create_task_revision, resolve_duplicate,
-- or the stage 8 data migration) lost the date it was finished. Now:
--   - into 'archived' / 'deleted': completed_at is kept;
--   - back into work (todo, in_progress, …): cleared, as before;
--   - back to 'done' from the archive or the trash: the original date returns;
--     a fresh 'done' gets now().
-- Everything else in the function is unchanged (definition taken from the live DB).
--
-- Data: the five done predecessors archived in stage 8 block 8.3 (PROPA-450,
-- 451, 457, 458, 465) get their completion date back from their last
-- "Status changed … to done" activity; each row is logged to data_migration_log.

create or replace function public.handle_task_lifecycle()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  settings public.project_automation_settings%ROWTYPE;
BEGIN
  SELECT *
  INTO settings
  FROM public.project_automation_settings
  WHERE project_id = NEW.project_id;

  IF TG_OP = 'INSERT' THEN
    NEW.status_changed_at := COALESCE(NEW.status_changed_at, NEW.created_at, now());

    IF NEW.status IN ('in_progress', 'done') AND NEW.started_at IS NULL THEN
      NEW.started_at := COALESCE(NEW.created_at, now());
    END IF;

    IF NEW.status = 'done' AND NEW.completed_at IS NULL THEN
      NEW.completed_at := COALESCE(NEW.updated_at, NEW.created_at, now());
    END IF;

    IF COALESCE(settings.auto_assign_on_start, true)
      AND NEW.status = 'in_progress'
      AND NEW.assignee_id IS NULL
      AND auth.uid() IS NOT NULL THEN
      NEW.assignee_id := auth.uid();
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();

    IF NEW.status IN ('in_progress', 'done') AND NEW.started_at IS NULL THEN
      NEW.started_at := now();
    END IF;

    IF NEW.status = 'done' THEN
      NEW.completed_at := CASE
        WHEN OLD.status IN ('archived', 'deleted') AND OLD.completed_at IS NOT NULL THEN OLD.completed_at
        ELSE now()
      END;
    ELSIF NEW.status IN ('archived', 'deleted') THEN
      NULL;  -- keep completed_at: an archived finished task stays finished on that date
    ELSE
      NEW.completed_at := NULL;
    END IF;

    IF COALESCE(settings.auto_assign_on_start, true)
      AND NEW.status = 'in_progress'
      AND NEW.assignee_id IS NULL
      AND auth.uid() IS NOT NULL THEN
      NEW.assignee_id := auth.uid();
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

do $$
declare
  r   record;
  v_n integer := 0;
begin
  for r in
    select t.id, t.key, t.completed_at,
           (select max(a.created_at) from public.task_activities a
             where a.task_id = t.id and a.message ~ '^Status changed (from [a-z_]+ )?to done$') as done_at
      from public.tasks t
      join public.data_migration_log l
        on l.row_id = t.id::text and l.block = '8.3' and l.action = 'archive_predecessor' and l.before->>'status' = 'done'
  loop
    if r.done_at is null then
      raise exception 'no done activity for %', r.key;
    end if;
    update public.tasks set completed_at = r.done_at where id = r.id and completed_at is null;
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('8.3-fix', 'tasks', r.id::text, 'restore_completed_at',
            jsonb_build_object('key', r.key, 'completed_at', r.completed_at), jsonb_build_object('completed_at', r.done_at));
    v_n := v_n + 1;
  end loop;
  if v_n <> 5 then
    raise exception 'restored % completion dates, expected 5', v_n;
  end if;
end;
$$;
