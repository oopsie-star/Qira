-- Stage 4a: the "work started" signal and one edit policy for everyone.
--
-- Until now handle_task_formulation_change decided, on its own, to fork a new
-- task whenever a backend task's title or description changed while it was in
-- progress or done — whoever had put it there. Of 20 revisions it made, 3 had a
-- real start by the assignee. It is replaced by:
--
--   * a recorded signal that the ASSIGNEE started the work (work_started_*):
--       take_in_work — the assignee pressed "Take into work" and wrote what they
--                      understood and where they start (>= 15 characters);
--       implicit     — the assignee commented or attached a file without it;
--       legacy       — reconstructed below from history, for existing tasks.
--     A status of in_progress set by someone else, or over MCP, is only a status.
--   * one policy (task_edit_policy) applied by a trigger to every title or
--     description change, from the app, the assistant and MCP alike:
--       not started            -> edited in place;
--       started, owner editing -> in place (the app asks first: in place or a new
--                                 revision);
--       started, anyone else   -> refused, with the options: create_task_revision,
--                                 or the owner edits it (a request, stage 4b).
--     Nothing creates a revision on its own any more: create_task_revision is
--     the only way, and it is always explicit.
--   * every title/description change is kept as a numbered version.
--
-- Owner roles: owner, admin, founder, ceo, and the super admin — exactly
-- can_override_project_delete().
--
-- No foreign keys to profiles are added (see 20261116030000): the *_by stamps
-- are written only by these functions.

-- ── Columns ──────────────────────────────────────────────────────────────────

alter table public.tasks
  add column if not exists work_started_at     timestamptz,
  add column if not exists work_started_by     uuid,
  add column if not exists work_started_signal text,
  -- The assignee's own words when taking it into work, for cards: reading the
  -- comment would cost a query per card. The comment itself stays in the thread.
  add column if not exists work_started_note   text;

alter table public.tasks drop constraint if exists tasks_work_started_signal_check;
alter table public.tasks add constraint tasks_work_started_signal_check
  check (work_started_signal is null or work_started_signal in ('take_in_work', 'implicit', 'legacy'));

comment on column public.tasks.work_started_signal is
  'How we know the assignee started: take_in_work (button + comment), implicit (their comment/file), legacy (from history). Null = not started.';

alter table public.task_comments
  add column if not exists comment_type text not null default 'comment';

alter table public.task_comments drop constraint if exists task_comments_comment_type_check;
alter table public.task_comments add constraint task_comments_comment_type_check
  check (comment_type in ('comment', 'take_in_work', 'return_to_todo'));

-- ── Helpers ──────────────────────────────────────────────────────────────────

create or replace function public.task_assignee_list(p_assignee_id uuid, p_assignee_ids uuid[])
returns uuid[]
language sql
immutable
as $$
  select case
    when coalesce(array_length(p_assignee_ids, 1), 0) > 0 then p_assignee_ids
    when p_assignee_id is not null then array[p_assignee_id]
    else '{}'::uuid[]
  end;
$$;

-- ── Legacy signal, before anything starts enforcing ──────────────────────────
--
-- Only the CURRENT assignee's own actions count: their status change to
-- in_progress or done, their comment, their file. The earliest one dates the
-- start. Archived and deleted tasks are left alone. (Dry-run: the same query,
-- read-only, reported before this migration was applied.)
--
-- The task triggers are off for this one statement: it only fills the three
-- new columns, and must not bump updated_at, re-sync epic/parent statuses
-- (handle_task_automations does on every update) or clear re-read marks.
-- All of them were enabled before; all are enabled again right after.
alter table public.tasks disable trigger user;

with t as (
  select id, attachments, archived_attachments, public.task_assignee_list(assignee_id, assignee_ids) as assignees
  from public.tasks
  where status not in ('archived', 'deleted') and work_started_at is null
),
ev as (
  select t.id task_id, a.actor_id who, a.created_at at
  from t join public.task_activities a on a.task_id = t.id
  where a.actor_id = any(t.assignees)
    and a.message ~ '^Status changed (from [a-z_]+ )?to (in_progress|done)$'
  union all
  select t.id, c.author_id, c.created_at
  from t join public.task_comments c on c.task_id = t.id
  where c.author_id = any(t.assignees)
  union all
  select t.id, split_part(p.path, '/', 3)::uuid,
         to_timestamp(substring(split_part(p.path, '/', 4) from '^(\d{13})-')::bigint / 1000.0)
  from t, unnest(t.attachments || t.archived_attachments) p(path)
  where split_part(p.path, '/', 3) = any(t.assignees::text[])
    and split_part(p.path, '/', 4) ~ '^\d{13}-'
),
first_ev as (
  select distinct on (task_id) task_id, who, at from ev order by task_id, at
)
update public.tasks tk
   set work_started_at = f.at,
       work_started_by = f.who,
       work_started_signal = 'legacy'
  from first_ev f
 where tk.id = f.task_id;

alter table public.tasks enable trigger user;

-- ── Take into work / return to To do ─────────────────────────────────────────

/**
 * The assignee takes the task into work, from their own account, with a
 * comment of at least 15 characters (what they understood, where they start,
 * any questions). Unassigned task: a project member (not a viewer) taking it
 * becomes its assignee first.
 *
 * Status goes to in_progress — except on a shared task (2+ assignees), whose
 * status only a manager moves: there the signal and the comment are recorded
 * and the status is left as it is.
 */
create or replace function public.take_in_work(p_task uuid, p_comment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_task     public.tasks%rowtype;
  v_body     text := btrim(coalesce(p_comment, ''));
  v_assignees uuid[];
  v_shared   boolean;
  v_comment  uuid;
begin
  if v_uid is null then
    raise exception 'only a signed-in assignee can take a task into work' using errcode = '42501';
  end if;
  if char_length(v_body) < 15 then
    raise exception 'the comment must be at least 15 characters: what you understood, where you start, any questions' using errcode = '22023';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'task % does not exist', p_task using errcode = 'P0002';
  end if;
  if v_task.status in ('archived', 'deleted', 'cancelled', 'done') then
    raise exception 'task % is %, it cannot be taken into work', v_task.key, v_task.status using errcode = '55000';
  end if;
  if not public.is_project_member(v_task.project_id) then
    raise exception 'not a member of this project' using errcode = '42501';
  end if;

  v_assignees := public.task_assignee_list(v_task.assignee_id, v_task.assignee_ids);
  if cardinality(v_assignees) = 0 then
    if not exists (select 1 from public.project_members pm
                    where pm.project_id = v_task.project_id and pm.profile_id = v_uid and pm.project_role <> 'viewer') then
      raise exception 'viewers cannot take tasks' using errcode = '42501';
    end if;
    update public.tasks set assignee_id = v_uid, assignee_placeholder_id = null where id = p_task;
    v_assignees := array[v_uid];
  elsif not (v_uid = any(v_assignees)) then
    raise exception 'only the assignee can take % into work', v_task.key using errcode = '42501';
  end if;

  v_shared := cardinality(v_assignees) >= 2;

  update public.tasks
     set status = case when v_shared then status else 'in_progress' end,
         work_started_at = coalesce(work_started_at, now()),
         work_started_by = case when work_started_signal = 'take_in_work' then work_started_by else v_uid end,
         work_started_signal = 'take_in_work',
         work_started_note = coalesce(case when work_started_signal = 'take_in_work' then work_started_note end, v_body)
   where id = p_task;

  insert into public.task_comments (project_id, task_id, author_id, body, comment_type)
  values (v_task.project_id, p_task, v_uid, v_body, 'take_in_work')
  returning id into v_comment;

  insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
  values (v_task.project_id, p_task, v_uid, 'task_updated',
          case when v_shared then 'Took the task into work' else 'Status changed from ' || v_task.status || ' to in_progress' end);

  return jsonb_build_object('task_id', p_task, 'key', v_task.key, 'comment_id', v_comment,
                            'status', case when v_shared then v_task.status else 'in_progress' end);
end;
$$;

revoke all on function public.take_in_work(uuid, text) from public, anon;
grant execute on function public.take_in_work(uuid, text) to authenticated;

/**
 * Back to To do, with the reason as a comment (>= 15 characters). The work
 * stays marked as started: both events remain in the history. A signed-in
 * project member (not a viewer) or the service role (MCP, naming its agent
 * profile as p_actor).
 */
create or replace function public.return_to_todo(p_task uuid, p_comment text, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_task  public.tasks%rowtype;
  v_body  text := btrim(coalesce(p_comment, ''));
  v_comment uuid;
begin
  if auth.uid() is not null then
    v_actor := auth.uid();
  elsif auth.role() = 'service_role' then
    v_actor := p_actor;
  else
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if char_length(v_body) < 15 then
    raise exception 'say why it goes back to To do — at least 15 characters' using errcode = '22023';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'task % does not exist', p_task using errcode = 'P0002';
  end if;
  if v_task.status <> 'in_progress' then
    raise exception 'task % is %, not in progress', v_task.key, v_task.status using errcode = '55000';
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.project_members pm
     where pm.project_id = v_task.project_id and pm.profile_id = v_actor and pm.project_role <> 'viewer'
  ) and not public.is_admin() then
    raise exception 'not allowed to change this task' using errcode = '42501';
  end if;

  update public.tasks set status = 'todo' where id = p_task;

  insert into public.task_comments (project_id, task_id, author_id, body, comment_type)
  values (v_task.project_id, p_task, v_actor, v_body, 'return_to_todo')
  returning id into v_comment;

  insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
  values (v_task.project_id, p_task, v_actor, 'task_updated', 'Status changed from in_progress to todo');

  return jsonb_build_object('task_id', p_task, 'key', v_task.key, 'comment_id', v_comment, 'status', 'todo');
end;
$$;

revoke all on function public.return_to_todo(uuid, text, uuid) from public, anon;
grant execute on function public.return_to_todo(uuid, text, uuid) to authenticated, service_role;

-- ── Implicit signal: the assignee's own comment or file ──────────────────────

create or replace function public.mark_work_started_by_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.comment_type = 'comment' and auth.uid() is not null and new.author_id = auth.uid() then
    update public.tasks t
       set work_started_at = now(), work_started_by = auth.uid(), work_started_signal = 'implicit'
     where t.id = new.task_id
       and t.work_started_at is null
       and t.status not in ('archived', 'deleted')
       and auth.uid() = any(public.task_assignee_list(t.assignee_id, t.assignee_ids));
  end if;
  return new;
end;
$$;

drop trigger if exists task_comments_mark_work_started on public.task_comments;
create trigger task_comments_mark_work_started
  after insert on public.task_comments
  for each row execute function public.mark_work_started_by_comment();

-- Files: a new path whose author segment is the signed-in assignee.
create or replace function public.mark_work_started_by_attachment()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.work_started_at is null and auth.uid() is not null
     and auth.uid() = any(public.task_assignee_list(new.assignee_id, new.assignee_ids))
     and exists (
       select 1 from unnest(coalesce(new.attachments, '{}')) p(path)
        where not (p.path = any(coalesce(old.attachments, '{}')))
          and split_part(p.path, '/', 3) = auth.uid()::text
     ) then
    new.work_started_at := now();
    new.work_started_by := auth.uid();
    new.work_started_signal := 'implicit';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_mark_work_started_by_attachment on public.tasks;
create trigger tasks_mark_work_started_by_attachment
  before update of attachments on public.tasks
  for each row execute function public.mark_work_started_by_attachment();

-- ── The edit policy ──────────────────────────────────────────────────────────

/**
 * What would happen to an edit of this task's title or description, for the
 * caller: in_place, owner_approval_required (the service role — MCP — on a
 * started task; it goes through an owner-approved request, stage 4b) or
 * rejected (a signed-in non-owner on a started task). `owner` tells the app to
 * ask an owner "in place or a new revision?" before saving a started task.
 */
create or replace function public.task_edit_policy(p_task uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_task  public.tasks%rowtype;
  v_owner boolean;
  v_mode  text;
begin
  select * into v_task from public.tasks where id = p_task;
  if not found then
    raise exception 'task % does not exist', p_task using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not public.is_project_member(v_task.project_id) and not public.is_admin() then
    raise exception 'not a member of this project' using errcode = '42501';
  end if;

  v_owner := auth.uid() is not null and public.can_override_project_delete(v_task.project_id);
  v_mode := case
    when v_task.work_started_at is null then 'in_place'
    when v_owner then 'in_place'
    when auth.uid() is null then 'owner_approval_required'
    else 'rejected'
  end;

  return jsonb_build_object(
    'task_id', v_task.id,
    'key', v_task.key,
    'work_started', v_task.work_started_at is not null,
    'started_at', v_task.work_started_at,
    'started_by', v_task.work_started_by,
    'started_by_name', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = v_task.work_started_by),
    'signal', v_task.work_started_signal,
    'owner', v_owner,
    'edit_mode', v_mode
  );
end;
$$;

revoke all on function public.task_edit_policy(uuid) from public, anon;
grant execute on function public.task_edit_policy(uuid) to authenticated, service_role;

-- Line-level summary for the assignee's notification: "+3 −1 lines".
create or replace function public.text_change_summary(p_old text, p_new text)
returns text
language sql
immutable
as $$
  select '+' || (select count(*) from (select unnest(string_to_array(coalesce(p_new, ''), E'\n')) except all
                                       select unnest(string_to_array(coalesce(p_old, ''), E'\n'))) a)
      || ' −' || (select count(*) from (select unnest(string_to_array(coalesce(p_old, ''), E'\n')) except all
                                        select unnest(string_to_array(coalesce(p_new, ''), E'\n'))) r);
$$;

/**
 * Replaces handle_task_formulation_change (dropped below). On every update:
 *   - done clears the orange "re-read" mark, as before;
 *   - a title/description change of a started task is allowed only to an
 *     owner, or under an owner-approved request (stage 4b sets
 *     qira.edit_approved to the task id); otherwise it is refused with the
 *     reason and the options;
 *   - the orange mark is set only when the assignee has already opened the
 *     task or taken it into work;
 *   - the assignee of a started task is notified with a short summary.
 */
create or replace function public.enforce_task_edit_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner    boolean;
  v_approved boolean := current_setting('qira.edit_approved', true) = old.id::text;
  v_who      text;
  v_opened   boolean;
  v_assignees uuid[];
  v_summary  text;
begin
  if new.status = 'done' and (old.status is distinct from 'done' or old.formulation_changed_at is not null) then
    new.formulation_changed_at := null;
  end if;

  if new.title is not distinct from old.title and new.description is not distinct from old.description then
    return new;
  end if;

  if old.work_started_at is not null and not v_approved then
    v_owner := auth.uid() is not null and public.can_override_project_delete(old.project_id);
    if not v_owner then
      select coalesce(nullif(p.full_name, ''), p.email) into v_who from public.profiles p where p.id = old.work_started_by;
      raise exception '% is already in work: % started it on % (signal: %). The title and description can no longer be edited in place.',
        old.key, coalesce(v_who, 'the assignee'), to_char(old.work_started_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), old.work_started_signal
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

drop trigger if exists tasks_formulation_change on public.tasks;
drop trigger if exists tasks_enforce_edit_policy on public.tasks;
create trigger tasks_enforce_edit_policy
  before update on public.tasks
  for each row execute function public.enforce_task_edit_policy();

-- ── Description versions ─────────────────────────────────────────────────────

create table if not exists public.task_description_versions (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references public.tasks(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  version         integer not null,
  title           text not null,
  description     text,
  edited_by       uuid,
  edited_by_agent text,
  edit_mode       text not null,
  created_at      timestamptz not null default now(),
  unique (task_id, version)
);

alter table public.task_description_versions enable row level security;
drop policy if exists task_description_versions_select on public.task_description_versions;
create policy task_description_versions_select on public.task_description_versions
  for select using (public.is_project_member(project_id));

/**
 * Keeps every title/description as a numbered version. The first change of a
 * task also stores what it was before (version 1, edit_mode 'original'). Who
 * edited: the signed-in user, or for MCP the agent profile and agent name that
 * edit_task_text() sets for the transaction; edit_mode likewise
 * ('in_place', 'owner_in_place', 'approved', 'restore').
 */
create or replace function public.record_task_description_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
  v_mode text := nullif(current_setting('qira.edit_mode', true), '');
begin
  if new.title is not distinct from old.title and new.description is not distinct from old.description then
    return null;
  end if;

  select coalesce(max(version), 0) + 1 into v_next from public.task_description_versions where task_id = old.id;
  if v_next = 1 then
    insert into public.task_description_versions (task_id, project_id, version, title, description, edit_mode, created_at)
    values (old.id, old.project_id, 1, old.title, old.description, 'original', old.updated_at);
    v_next := 2;
  end if;

  insert into public.task_description_versions (task_id, project_id, version, title, description, edited_by, edited_by_agent, edit_mode)
  values (
    old.id, old.project_id, v_next, new.title, new.description,
    coalesce(auth.uid(), nullif(current_setting('qira.edit_actor', true), '')::uuid),
    nullif(current_setting('qira.edit_agent', true), ''),
    coalesce(v_mode,
             case when old.work_started_at is not null then 'owner_in_place' else 'in_place' end)
  );
  return null;
end;
$$;

drop trigger if exists tasks_record_description_version on public.tasks;
create trigger tasks_record_description_version
  after update of title, description on public.tasks
  for each row execute function public.record_task_description_version();

/**
 * The route for MCP text edits (the service role has no auth.uid()): names the
 * agent for the version history and goes through the same policy trigger. A
 * signed-in user may call it too (e.g. to restore a version).
 */
create or replace function public.edit_task_text(
  p_task        uuid,
  p_title       text default null,
  p_description text default null,
  p_actor       uuid default null,
  p_agent       text default null,
  p_mode        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
begin
  if auth.uid() is null and auth.role() is distinct from 'service_role' then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_task from public.tasks where id = p_task;
  if not found then
    raise exception 'task % does not exist', p_task using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.project_members pm
     where pm.project_id = v_task.project_id and pm.profile_id = auth.uid() and pm.project_role <> 'viewer'
  ) and not public.is_admin() then
    raise exception 'not allowed to edit this task' using errcode = '42501';
  end if;

  if auth.uid() is null then
    perform set_config('qira.edit_actor', coalesce(p_actor::text, ''), true);
    perform set_config('qira.edit_agent', coalesce(p_agent, ''), true);
  else
    perform set_config('qira.edit_agent', case when p_agent = 'qira-assistant' then p_agent else '' end, true);
  end if;
  perform set_config('qira.edit_mode', case when p_mode in ('restore') then p_mode else '' end, true);

  update public.tasks
     set title = coalesce(p_title, title),
         description = case when p_description is null then description else p_description end
   where id = p_task;

  return jsonb_build_object('task_id', p_task, 'key', v_task.key,
                            'edit_mode', case when v_task.work_started_at is null then 'in_place' else 'owner_in_place' end);
end;
$$;

revoke all on function public.edit_task_text(uuid, text, text, uuid, text, text) from public, anon;
grant execute on function public.edit_task_text(uuid, text, text, uuid, text, text) to authenticated, service_role;

-- ── Explicit revisions ───────────────────────────────────────────────────────

-- A shared task's status is a manager's call — except when create_task_revision
-- archives it: that is the revision's own effect, already permitted there.
create or replace function public.guard_universal_task_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and coalesce(array_length(old.assignee_ids, 1), 0) >= 2
     and current_setting('qira.revision', true) is distinct from old.id::text
     and not (public.is_admin() or public.can_manage_project(old.project_id))
  then
    raise exception 'universal_task_status: only an admin can change the status of a shared task';
  end if;
  return new;
end;
$$;

-- Moving a file from the old task to its revision is not "dropping" it: the
-- archive guard (20261116010000) would otherwise archive it on the old task.
create or replace function public.keep_attachment_archive_consistent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.attachments := array(
    select live.path
    from unnest(coalesce(new.attachments, '{}')) with ordinality as live(path, pos)
    where not (
      live.path = any(coalesce(old.archived_attachments, '{}'))
      and live.path = any(coalesce(new.archived_attachments, '{}'))
    )
    order by live.pos
  );

  if current_setting('qira.attachment_move', true) = 'on' then
    return new;
  end if;

  new.archived_attachments := coalesce(new.archived_attachments, '{}') || array(
    select distinct gone.path
    from unnest(coalesce(old.attachments, '{}')) as gone(path)
    where not (gone.path = any(new.attachments))
      and not (gone.path = any(coalesce(new.archived_attachments, '{}')))
  );
  return new;
end;
$$;

/**
 * The only way to make a new revision of a task: explicit, by a project
 * member (not a viewer) or MCP. The revision is a new To do task with the
 * given (or the old) title and description and the old one's fields; the
 * chosen live files and live comments MOVE to it; it supersedes the old task,
 * which is archived. Not subject to the edit policy: nothing is edited in place.
 */
create or replace function public.create_task_revision(
  p_task          uuid,
  p_title         text default null,
  p_description   text default null,
  p_attachments   text[] default '{}',
  p_comment_ids   uuid[] default '{}',
  p_reason        text default null,
  p_actor         uuid default null,
  p_agent         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_old   public.tasks%rowtype;
  v_new   public.tasks%rowtype;
  v_files text[];
  v_moved_comments integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is not null then
    v_actor := auth.uid();
  elsif auth.role() = 'service_role' then
    v_actor := p_actor;
  else
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into v_old from public.tasks where id = p_task for update;
  if not found then
    raise exception 'task % does not exist', p_task using errcode = 'P0002';
  end if;
  if v_old.status in ('archived', 'deleted') then
    raise exception 'task % is already %', v_old.key, v_old.status using errcode = '55000';
  end if;
  if auth.uid() is not null and not exists (
    select 1 from public.project_members pm
     where pm.project_id = v_old.project_id and pm.profile_id = v_actor and pm.project_role <> 'viewer'
  ) and not public.is_admin() then
    raise exception 'not allowed to revise this task' using errcode = '42501';
  end if;

  -- Only files that are live on the old task can move.
  select coalesce(array_agg(f order by array_position(v_old.attachments, f)), '{}') into v_files
    from unnest(coalesce(p_attachments, '{}')) f
   where f = any(v_old.attachments);
  if cardinality(coalesce(p_attachments, '{}')) <> cardinality(v_files) then
    raise exception 'some attachments are not live files of %', v_old.key using errcode = '22023';
  end if;

  insert into public.tasks (
    project_id, parent_task_id, title, description, status, issue_type, priority,
    labels, epic_id, sprint_id, assignee_id, assignee_ids, reporter_id,
    assignee_placeholder_id, reporter_placeholder_id, due_date,
    implements_screen_task_id, attachments
  )
  values (
    v_old.project_id, v_old.parent_task_id, coalesce(nullif(btrim(p_title), ''), v_old.title),
    coalesce(p_description, v_old.description), 'todo', v_old.issue_type, v_old.priority,
    v_old.labels, v_old.epic_id, v_old.sprint_id, v_old.assignee_id, v_old.assignee_ids, v_old.reporter_id,
    v_old.assignee_placeholder_id, v_old.reporter_placeholder_id, v_old.due_date,
    v_old.implements_screen_task_id, v_files
  )
  returning * into v_new;

  perform set_config('qira.attachment_move', 'on', true);
  perform set_config('qira.revision', v_old.id::text, true);
  update public.tasks
     set attachments = array(select a from unnest(attachments) a where not (a = any(v_files))),
         status = 'archived'
   where id = v_old.id;
  perform set_config('qira.attachment_move', '', true);
  perform set_config('qira.revision', '', true);

  update public.task_comments
     set task_id = v_new.id
   where task_id = v_old.id and id = any(coalesce(p_comment_ids, '{}')) and archived_at is null;
  get diagnostics v_moved_comments = row_count;
  update public.task_comment_edits e set task_id = v_new.id
    from public.task_comments c
   where e.comment_id = c.id and c.task_id = v_new.id;

  insert into public.task_links (project_id, source_task_id, target_task_id, link_type, created_by)
  values (v_old.project_id, v_new.id, v_old.id, 'supersedes', v_actor)
  on conflict do nothing;

  insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
  values
    (v_old.project_id, v_old.id, v_actor, 'task_updated',
     'Superseded by a new revision ' || v_new.key || coalesce(': ' || v_reason, '') || ' — archived'),
    (v_old.project_id, v_new.id, v_actor, 'task_created',
     'New revision of ' || v_old.key || coalesce(': ' || v_reason, ''));

  insert into public.notifications (project_id, profile_id, task_id, notification_type, title, body)
  select v_old.project_id, a.id, v_new.id, 'system',
         'Новая редакция задачи · ' || v_old.key || ' → ' || v_new.key,
         coalesce(v_reason || E'\n', '') || v_old.key || ' перенесена в архив, актуальна ' || v_new.key || '.'
    from unnest(public.task_assignee_list(v_old.assignee_id, v_old.assignee_ids)) a(id)
   where a.id is distinct from v_actor;

  return jsonb_build_object(
    'old_task_id', v_old.id, 'old_key', v_old.key,
    'new_task_id', v_new.id, 'new_key', v_new.key,
    'moved_attachments', cardinality(v_files), 'moved_comments', v_moved_comments,
    'agent', p_agent
  );
end;
$$;

revoke all on function public.create_task_revision(uuid, text, text, text[], uuid[], text, uuid, text) from public, anon;
grant execute on function public.create_task_revision(uuid, text, text, text[], uuid[], text, uuid, text) to authenticated, service_role;

-- The auto-revision function has no trigger any more; drop it so nothing can
-- wire it back by accident. merge_formulation_revision stays (unused, harmless).
drop function if exists public.handle_task_formulation_change();
