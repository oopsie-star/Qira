-- Stage 4b: owner approval requests.
--
-- An AI agent asks for something only an owner may allow; the server files a
-- request and tells the project's owners; an owner approves or rejects it in
-- one click; the agent repeats its call with the request number, and only then
-- does it happen — once. Four kinds:
--
--   edit_in_place     — change the title/description of a started or done task;
--   delete_attachment — delete a file for good (not archive it);
--   purge_task        — delete an archived/deleted task for good (with its
--                       archived/deleted subtasks; never a live one);
--   purge_trash       — the same for a fixed list of a project's trashed tasks.
--
-- Trust:
--   * requests and their history are written only by the functions below
--     (no insert/update/delete policy at all);
--   * only an owner — owner, admin, founder, ceo of the project, or the super
--     admin — can decide, and is re-checked when the request is used;
--   * apply_owner_request() is the only door: it checks the request (approved,
--     unused, not expired, same kind, same task, same parameters), does the
--     thing and marks the request used, in one transaction;
--   * for edits the edit-policy trigger does not trust its setting alone: it
--     also re-reads the request and lets the edit through only if it is that
--     approved, unused request, for this task, with exactly these values, and
--     the caller is not a signed-in user. A client that sets the setting
--     itself gets nothing (PostgREST does not even expose set_config).
--
-- Every request and decision is in owner_request_events — the audit log for
-- people (agent_audit_log only takes agents).

-- ── Owners ───────────────────────────────────────────────────────────────────

create or replace function public.is_project_owner_of(p_project uuid, p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_profile is not null and (
    exists (select 1 from public.profiles p where p.id = p_profile and p.role = 'admin')
    or exists (
      select 1 from public.project_members pm
       where pm.project_id = p_project and pm.profile_id = p_profile
         and pm.project_role in ('owner', 'admin', 'founder', 'ceo')
    )
  );
$$;

revoke all on function public.is_project_owner_of(uuid, uuid) from public, anon;
grant execute on function public.is_project_owner_of(uuid, uuid) to authenticated, service_role;

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists public.owner_requests (
  id                 bigint generated always as identity primary key,
  project_id         uuid not null references public.projects(id) on delete cascade,
  task_id            uuid references public.tasks(id) on delete set null,
  request_type       text not null check (request_type in ('edit_in_place', 'delete_attachment', 'purge_task', 'purge_trash')),
  -- What will be done, exactly; the repeat call must send the same.
  params             jsonb not null,
  -- What the owner reads: a diff, or the list of what goes for good.
  preview            jsonb not null default '{}'::jsonb,
  reason             text,
  requested_by       uuid,
  requested_by_agent text,
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'used')),
  decided_by         uuid,
  decided_at         timestamptz,
  decision_note      text,
  used_at            timestamptz,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default now() + interval '7 days'
);

create index if not exists owner_requests_open_idx on public.owner_requests (project_id, status, created_at desc);
create index if not exists owner_requests_task_idx on public.owner_requests (task_id);

create table if not exists public.owner_request_events (
  id          bigint generated always as identity primary key,
  request_id  bigint not null references public.owner_requests(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  event       text not null check (event in ('created', 'approved', 'rejected', 'applied', 'refused')),
  actor_id    uuid,
  actor_agent text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists owner_request_events_by_request_idx on public.owner_request_events (request_id, created_at);

alter table public.owner_requests enable row level security;
alter table public.owner_request_events enable row level security;

-- Readable by the project's members; written only by the functions below.
drop policy if exists owner_requests_select on public.owner_requests;
create policy owner_requests_select on public.owner_requests
  for select using (public.is_project_member(project_id) or public.is_admin());
drop policy if exists owner_request_events_select on public.owner_request_events;
create policy owner_request_events_select on public.owner_request_events
  for select using (public.is_project_member(project_id) or public.is_admin());

-- Owners see a new request without reloading.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'owner_requests') then
    alter publication supabase_realtime add table public.owner_requests;
  end if;
end $$;

-- ── Filing a request (MCP) ───────────────────────────────────────────────────

/**
 * Files a request for the service role (MCP), or returns the open one with the
 * same kind, task and parameters, so an agent retrying a call does not stack
 * duplicates. Notifies the project's owners (the super admins if the project
 * has none).
 */
create or replace function public.create_owner_request(
  p_type    text,
  p_project uuid,
  p_task    uuid,
  p_params  jsonb,
  p_preview jsonb,
  p_reason  text,
  p_actor   uuid,
  p_agent   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req     public.owner_requests%rowtype;
  v_key     text;
  v_label   text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'only the MCP server files owner requests' using errcode = '42501';
  end if;
  if p_type not in ('edit_in_place', 'delete_attachment', 'purge_task', 'purge_trash') then
    raise exception 'unknown request type %', p_type using errcode = '22023';
  end if;

  select * into v_req from public.owner_requests r
   where r.request_type = p_type and r.project_id = p_project and r.task_id is not distinct from p_task
     and r.params = p_params and r.status in ('pending', 'approved') and r.used_at is null and r.expires_at > now()
   order by r.id desc limit 1;
  if found then
    return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'existing', true, 'expires_at', v_req.expires_at);
  end if;

  insert into public.owner_requests (project_id, task_id, request_type, params, preview, reason, requested_by, requested_by_agent)
  values (p_project, p_task, p_type, p_params, coalesce(p_preview, '{}'::jsonb), nullif(btrim(coalesce(p_reason, '')), ''), p_actor, p_agent)
  returning * into v_req;

  insert into public.owner_request_events (request_id, project_id, event, actor_id, actor_agent, details)
  values (v_req.id, p_project, 'created', p_actor, p_agent, jsonb_build_object('type', p_type, 'task_id', p_task, 'reason', v_req.reason));

  select key into v_key from public.tasks where id = p_task;
  v_label := case p_type
    when 'edit_in_place' then 'правка задачи в работе на месте'
    when 'delete_attachment' then 'окончательное удаление файла'
    when 'purge_task' then 'окончательное удаление задачи'
    else 'очистка корзины' end;

  insert into public.notifications (project_id, profile_id, task_id, notification_type, title, body)
  select p_project, o.id, p_task, 'system',
         'Заявка №' || v_req.id || ' · ' || v_label || coalesce(' · ' || v_key, ''),
         coalesce(initcap(p_agent), 'Агент') || ' просит разрешения' || coalesce(': ' || v_req.reason, '.')
           || E'\nОдобрить или отклонить — в Qira, «Заявки на одобрение».'
    from (
      select pm.profile_id id from public.project_members pm
       where pm.project_id = p_project and pm.project_role in ('owner', 'admin', 'founder', 'ceo')
      union
      select p.id from public.profiles p
       where p.role = 'admin'
         and not exists (select 1 from public.project_members pm
                          where pm.project_id = p_project and pm.project_role in ('owner', 'admin', 'founder', 'ceo'))
    ) o;

  return jsonb_build_object('request_id', v_req.id, 'status', 'pending', 'existing', false, 'expires_at', v_req.expires_at);
end;
$$;

revoke all on function public.create_owner_request(text, uuid, uuid, jsonb, jsonb, text, uuid, text) from public, anon, authenticated;
grant execute on function public.create_owner_request(text, uuid, uuid, jsonb, jsonb, text, uuid, text) to service_role;

-- ── Deciding (an owner, in the app) ──────────────────────────────────────────

create or replace function public.decide_owner_request(p_request bigint, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.owner_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'only a signed-in owner decides' using errcode = '42501';
  end if;
  select * into v_req from public.owner_requests where id = p_request for update;
  if not found then
    raise exception 'request % does not exist', p_request using errcode = 'P0002';
  end if;
  if not public.is_project_owner_of(v_req.project_id, auth.uid()) then
    raise exception 'only an owner of the project can decide request %', p_request using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request % is already %', p_request, v_req.status using errcode = '55000';
  end if;
  if v_req.expires_at <= now() then
    raise exception 'request % has expired', p_request using errcode = '55000';
  end if;

  update public.owner_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_request;

  insert into public.owner_request_events (request_id, project_id, event, actor_id, details)
  values (p_request, v_req.project_id, case when p_approve then 'approved' else 'rejected' end, auth.uid(),
          jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));

  return jsonb_build_object('request_id', p_request, 'status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;

revoke all on function public.decide_owner_request(bigint, boolean, text) from public, anon;
grant execute on function public.decide_owner_request(bigint, boolean, text) to authenticated;

-- ── The edit policy: an approved edit must be exactly the approved request ────

create or replace function public.enforce_task_edit_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner    boolean;
  v_request  text := current_setting('qira.edit_request', true);
  v_approved boolean;
  v_who      text;
  v_opened   boolean;
  v_assignees uuid[];
  v_summary  text;
begin
  -- Approved only if ALL hold: the setting names this task; the named request
  -- is approved, unused, unexpired, an edit of this task, decided by someone
  -- who is an owner now, and carries exactly the values being written; and
  -- the caller is not a signed-in user (apply_owner_request runs as the
  -- service role). Anything missing or NULL counts as not approved.
  v_approved := coalesce(
    current_setting('qira.edit_approved', true) = old.id::text
    and auth.uid() is null
    and exists (
      select 1 from public.owner_requests r
       -- CASE, not AND: SQL does not promise to test the format before the cast.
       where r.id = case when v_request ~ '^[0-9]{1,18}$' then v_request::bigint end
         and r.request_type = 'edit_in_place'
         and r.task_id = old.id
         and r.status = 'approved'
         and r.used_at is null
         and r.expires_at > now()
         and public.is_project_owner_of(r.project_id, r.decided_by)
         and new.title = coalesce(r.params->>'title', old.title)
         and new.description is not distinct from coalesce(r.params->>'description', old.description)
    ),
    false);

  if new.status = 'done' and (old.status is distinct from 'done' or old.formulation_changed_at is not null) then
    new.formulation_changed_at := null;
  end if;

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
                then 'EDIT_POLICY:owner_approval_required — ask for an owner''s approval (the request is filed for you), or create a new revision with create_task_revision.'
                else 'EDIT_POLICY:rejected — create a new revision of the task, or ask a project owner to edit it in place.' end;
    end if;
  end if;

  v_assignees := public.task_assignee_list(old.assignee_id, old.assignee_ids);

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

-- ── Purging: what goes, decided at request time and re-checked at apply ──────

/**
 * Deletes for good the given tasks, each only if it is still archived or
 * deleted and nothing live hangs under it (subtasks are deleted with their
 * parent by the foreign key, so a live one would go too). Returns what was
 * deleted, what was skipped and why, and the storage paths to remove — the
 * Storage API does that (the storage schema forbids deleting objects in SQL).
 */
create or replace function public.purge_trashed_tasks(p_task_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid;
  v_task     public.tasks%rowtype;
  v_live     integer;
  v_deleted  text[] := '{}';
  v_skipped  jsonb := '[]'::jsonb;
  v_paths    text[] := '{}';
  v_tree     uuid[];
begin
  foreach v_id in array coalesce(p_task_ids, '{}') loop
    select * into v_task from public.tasks where id = v_id for update;
    if not found then
      continue; -- already gone (e.g. with its parent earlier in this list)
    end if;
    if v_task.status not in ('archived', 'deleted') then
      v_skipped := v_skipped || jsonb_build_object('key', v_task.key, 'why', 'no longer in the trash (' || v_task.status || ')');
      continue;
    end if;

    with recursive tree as (
      select id, status from public.tasks where id = v_id
      union all
      select c.id, c.status from public.tasks c join tree on c.parent_task_id = tree.id
    )
    select array_agg(id), count(*) filter (where status not in ('archived', 'deleted')) into v_tree, v_live from tree;
    if v_live > 0 then
      v_skipped := v_skipped || jsonb_build_object('key', v_task.key, 'why', v_live || ' live subtask(s) under it');
      continue;
    end if;

    select v_paths || coalesce(array_agg(distinct p), '{}') into v_paths from (
      select unnest(t.attachments || t.archived_attachments) p from public.tasks t where t.id = any(v_tree)
      union
      select unnest(c.attachments) from public.task_comments c where c.task_id = any(v_tree)
    ) x where p is not null;

    delete from public.attachment_notes n
     where n.project_id = v_task.project_id
       and n.path in (select unnest(t.attachments || t.archived_attachments) from public.tasks t where t.id = any(v_tree));

    select v_deleted || coalesce(array_agg(key order by key), '{}') into v_deleted from public.tasks where id = any(v_tree);
    delete from public.tasks where id = v_id;
  end loop;

  return jsonb_build_object('deleted', to_jsonb(v_deleted), 'skipped', v_skipped, 'paths', to_jsonb(v_paths));
end;
$$;

revoke all on function public.purge_trashed_tasks(uuid[]) from public, anon, authenticated;
grant execute on function public.purge_trashed_tasks(uuid[]) to service_role;

-- ── Applying (MCP repeats its call with the request number) ──────────────────

create or replace function public.apply_owner_request(
  p_request bigint,
  p_type    text,
  p_task    uuid,
  p_params  jsonb,
  p_actor   uuid,
  p_agent   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req    public.owner_requests%rowtype;
  v_result jsonb;
  v_why    text;
  v_path   text;
  v_table  text;
  v_owner_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'only the MCP server applies owner requests' using errcode = '42501';
  end if;

  select * into v_req from public.owner_requests where id = p_request for update;
  if not found then
    raise exception 'request % does not exist', p_request using errcode = 'P0002';
  end if;

  v_why := case
    when v_req.status = 'pending' then 'is still waiting for an owner''s decision'
    when v_req.status = 'rejected' then 'was rejected' || coalesce(': ' || v_req.decision_note, '')
    when v_req.status = 'used' or v_req.used_at is not null then 'has already been used — a request works once'
    when v_req.expires_at <= now() then 'has expired'
    when v_req.request_type <> p_type then 'is for ' || v_req.request_type || ', not ' || p_type
    when v_req.task_id is distinct from p_task then 'is for a different task'
    when v_req.params <> p_params then 'was approved for different parameters — send exactly what was requested'
    when not public.is_project_owner_of(v_req.project_id, v_req.decided_by) then 'was approved by someone who is not an owner (any more)'
  end;
  if v_why is not null then
    insert into public.owner_request_events (request_id, project_id, event, actor_id, actor_agent, details)
    values (p_request, v_req.project_id, 'refused', p_actor, p_agent, jsonb_build_object('why', v_why));
    raise exception 'request % %', p_request, v_why using errcode = '55000', hint = 'OWNER_REQUEST:' || v_req.status;
  end if;

  if p_type = 'edit_in_place' then
    perform set_config('qira.edit_request', p_request::text, true);
    perform set_config('qira.edit_approved', p_task::text, true);
    perform set_config('qira.edit_actor', coalesce(p_actor::text, ''), true);
    perform set_config('qira.edit_agent', coalesce(p_agent, ''), true);
    perform set_config('qira.edit_mode', 'approved', true);
    update public.tasks
       set title = coalesce(p_params->>'title', title),
           description = coalesce(p_params->>'description', description)
     where id = p_task;
    perform set_config('qira.edit_approved', '', true);
    perform set_config('qira.edit_request', '', true);
    perform set_config('qira.edit_mode', '', true);
    v_result := jsonb_build_object('task_id', p_task, 'edit_mode', 'approved');

  elsif p_type = 'delete_attachment' then
    v_path := p_params->>'path';
    for v_table in select unnest(array['tasks', 'epics', 'sprints']) loop
      execute format('select id from public.%I where $1 = any(attachments) or $1 = any(archived_attachments) limit 1', v_table)
        into v_owner_id using v_path;
      exit when v_owner_id is not null;
    end loop;
    if v_owner_id is not null then
      perform set_config('qira.attachment_move', 'on', true);
      execute format('update public.%I set attachments = array_remove(attachments, $2), archived_attachments = array_remove(archived_attachments, $2) where id = $1', v_table)
        using v_owner_id, v_path;
      perform set_config('qira.attachment_move', '', true);
    end if;
    delete from public.attachment_notes where project_id = v_req.project_id and path = v_path;
    v_result := jsonb_build_object('paths', jsonb_build_array(v_path),
                                   'detached_from', case when v_owner_id is not null then v_table end);

  else -- purge_task, purge_trash
    v_result := public.purge_trashed_tasks(array(select jsonb_array_elements_text(p_params->'task_ids')::uuid));
  end if;

  update public.owner_requests set status = 'used', used_at = now() where id = p_request;
  insert into public.owner_request_events (request_id, project_id, event, actor_id, actor_agent, details)
  values (p_request, v_req.project_id, 'applied', p_actor, p_agent, v_result - 'paths');

  return v_result || jsonb_build_object('request_id', p_request);
end;
$$;

revoke all on function public.apply_owner_request(bigint, text, uuid, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_owner_request(bigint, text, uuid, jsonb, uuid, text) to service_role;
