-- Hotfix for 20261117000000_work_started_and_edit_policy.sql: the edit policy
-- was not enforced.
--
-- v_approved compared current_setting('qira.edit_approved', true) with the task
-- id. When the setting was never set in the session that comparison is NULL,
-- `not v_approved` is NULL too, and `started and NULL` skipped the refusal:
-- every edit of a started or done task went through in place. Found by the
-- stage 4a checks in project TEST (a member's and an agent's edit of a started
-- task were accepted). Nothing was forked or lost meanwhile — edits were simply
-- not refused.
--
-- The function is otherwise unchanged; v_approved is now false unless the
-- setting names this task.

create or replace function public.enforce_task_edit_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner    boolean;
  v_approved boolean := coalesce(current_setting('qira.edit_approved', true) = old.id::text, false);
  v_who      text;
  v_opened   boolean;
  v_assignees uuid[];
  v_summary  text;
begin
  if new.status = 'done' and (old.status is distinct from 'done' or old.formulation_changed_at is not null) then
    new.formulation_changed_at := null;
  end if;

  -- A task closed without a recorded start is protected from now on too.
  if new.status = 'done' and old.status is distinct from 'done' and new.work_started_at is null then
    new.work_started_at := now();
    new.work_started_signal := 'done_status';
  end if;

  if new.title is not distinct from old.title and new.description is not distinct from old.description then
    return new;
  end if;

  if old.work_started_at is not null and not v_approved then
    v_owner := auth.uid() is not null and public.can_override_project_delete(old.project_id);
    if not v_owner then
      select coalesce(nullif(p.full_name, ''), p.email) into v_who from public.profiles p where p.id = old.work_started_by;
      raise exception '%',
        case when old.work_started_signal = 'done_status'
          then format('%s is done (closed on %s): its text records what was delivered and can no longer be edited in place. New requirements go into a new task or a new revision.',
                      old.key, to_char(old.work_started_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'))
          else format('%s is already in work: %s started it on %s (signal: %s). The title and description can no longer be edited in place.',
                      old.key, coalesce(v_who, 'the assignee'), to_char(old.work_started_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), old.work_started_signal)
        end
        using errcode = 'P0001',
              hint = case when auth.uid() is null
                then 'EDIT_POLICY:owner_approval_required — create a new revision with create_task_revision, or ask a project owner to edit it in place.'
                else 'EDIT_POLICY:rejected — create a new revision of the task, or ask a project owner to edit it in place.' end;
    end if;
  end if;

  v_assignees := public.task_assignee_list(old.assignee_id, old.assignee_ids);

  -- Re-read mark: only for an assignee who has seen the task, or started it.
  select exists (
    select 1 from public.activity_events e
     where e.task_id = old.id and e.event_type = 'view_task' and e.profile_id = any(v_assignees)
  ) into v_opened;
  if (old.work_started_at is not null or v_opened)
     and not (coalesce(auth.uid() = any(v_assignees), false)) then
    new.formulation_changed_at := now();
  end if;

  if old.work_started_at is not null then
    v_summary := public.text_change_summary(old.description, new.description);
    insert into public.notifications (project_id, profile_id, task_id, notification_type, title, body)
    select old.project_id, a.id, old.id, 'system',
           case when coalesce(p.locale, 'ru') like 'en%' then 'Task in progress was edited · ' else 'Изменена задача в работе · ' end || old.key,
           concat_ws('; ',
             case when new.title is distinct from old.title
                  then case when coalesce(p.locale, 'ru') like 'en%' then 'title changed' else 'заголовок изменён' end end,
             case when new.description is distinct from old.description
                  then case when coalesce(p.locale, 'ru') like 'en%' then 'description: ' || v_summary || ' lines'
                            else 'описание: ' || v_summary || ' строк' end end)
           || case when coalesce(p.locale, 'ru') like 'en%' then E'\nThe full diff is in the task''s version history.'
                   else E'\nПолная разница — в истории версий задачи.' end
      from unnest(v_assignees) a(id)
      left join public.profiles p on p.id = a.id
     where a.id is distinct from auth.uid();
  end if;

  return new;
end;
$$;
