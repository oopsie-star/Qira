-- Stage 5: possible duplicates.
--
-- A rule tuned on the live data (a plain similarity threshold flags dozens of
-- "sister" tasks — MW-DESIGN-06 vs MW-FE-06, the same template per life stage):
--   * both titles start with a code (MOM-CAL-ME-FE03, CON-BE-03): a duplicate
--     only when the codes are equal;
--   * otherwise: trigram similarity of the titles without a code >= 0.9, and
--     only for titles of two words / 12 characters or more;
--   * never flagged: archived or trashed tasks, pairs already linked
--     (supersedes / duplicates), pairs someone marked "not a duplicate".
--
-- resolve_duplicate(keep, other, action):
--   not_duplicate  the pair is remembered and not flagged again;
--   duplicate      `other` goes to the archive, linked other -duplicates-> keep.
--                  If `other` still has live files, live comments or open
--                  subtasks, nothing happens unless confirmed: the answer lists
--                  them and suggests new_version;
--   new_version    exactly create_task_revision's move (shared function
--                  revision_move): live files and open subtasks go to `keep`,
--                  chosen comments too, closed subtasks stay, `other` is archived,
--                  linked keep -supersedes-> other.
-- Archiving a task whose work was started (not done_status) follows the edit
-- policy: an owner confirms in the app (seeing who started it and when); an
-- agent needs an owner request (stage 4b); anyone else is refused.
-- Every decision is recorded in task_duplicate_decisions.

create extension if not exists pg_trgm with schema extensions;

-- ── the rule ────────────────────────────────────────────────────────────────

create or replace function public.task_title_code(p_title text)
returns text
language sql
immutable
as $$
  select substring(coalesce(p_title, '') from '^\s*([A-Z][A-Z0-9]*(?:-[A-Za-z0-9.]+)+)(?=[\s:—–·]|$)');
$$;

create or replace function public.task_title_rest(p_title text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(coalesce(p_title, ''), '^\s*[A-Z][A-Z0-9]*(?:-[A-Za-z0-9.]+)+(?=[\s:—–·]|$)', ''), ' —–·:-');
$$;

create or replace function public.task_titles_match(p_a text, p_b text, out is_dup boolean, out similarity real, out reason text)
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  v_ca text := public.task_title_code(p_a);
  v_cb text := public.task_title_code(p_b);
  v_ra text := lower(public.task_title_rest(p_a));
  v_rb text := lower(public.task_title_rest(p_b));
begin
  is_dup := false;
  similarity := extensions.similarity(lower(coalesce(p_a, '')), lower(coalesce(p_b, '')));
  if v_ca is not null and v_cb is not null then
    if v_ca = v_cb then
      is_dup := true;
      reason := 'same code ' || v_ca;
    end if;
    return;
  end if;
  if length(v_ra) < 12 or length(v_rb) < 12
     or cardinality(regexp_split_to_array(v_ra, '\s+')) < 2 or cardinality(regexp_split_to_array(v_rb, '\s+')) < 2 then
    return;
  end if;
  similarity := extensions.similarity(v_ra, v_rb);
  if similarity >= 0.9 then
    is_dup := true;
    reason := 'similar title';
  end if;
end;
$$;

-- ── decisions (also the audit log) ──────────────────────────────────────────

create table if not exists public.task_duplicate_decisions (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- the pair, order-free: task_a < task_b
  task_a uuid not null,
  task_b uuid not null,
  keep_task uuid,
  other_task uuid,
  action text not null check (action in ('not_duplicate', 'duplicate', 'new_version')),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_agent text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (task_a < task_b)
);

create index if not exists task_duplicate_decisions_pair on public.task_duplicate_decisions (task_a, task_b);
create index if not exists task_duplicate_decisions_project on public.task_duplicate_decisions (project_id, created_at desc);

alter table public.task_duplicate_decisions enable row level security;
drop policy if exists task_duplicate_decisions_read on public.task_duplicate_decisions;
create policy task_duplicate_decisions_read on public.task_duplicate_decisions
  for select to authenticated using (public.is_project_member(project_id));
revoke all on public.task_duplicate_decisions from anon, authenticated;
grant select on public.task_duplicate_decisions to authenticated;

-- A pair is "settled" when it is linked either way or marked not a duplicate.
create or replace function public.task_pair_settled(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.task_links l
     where l.link_type in ('supersedes', 'duplicates')
       and ((l.source_task_id = p_a and l.target_task_id = p_b) or (l.source_task_id = p_b and l.target_task_id = p_a))
  ) or exists (
    select 1 from public.task_duplicate_decisions d
     where d.action = 'not_duplicate' and d.task_a = least(p_a, p_b) and d.task_b = greatest(p_a, p_b)
  );
$$;

revoke all on function public.task_pair_settled(uuid, uuid) from public, anon, authenticated;

-- ── finding them ────────────────────────────────────────────────────────────

create or replace function public.find_possible_duplicates(
  p_project uuid,
  p_title   text,
  p_exclude uuid default null,
  p_epic    uuid default null
)
returns table (task_id uuid, key text, title text, status text, similarity real, reason text, same_epic boolean)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null then
    if not public.is_project_member(p_project) then
      return;
    end if;
  elsif auth.role() is distinct from 'service_role' then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  return query
    select t.id, t.key, t.title, t.status::text, m.similarity, m.reason, (p_epic is not null and t.epic_id = p_epic)
      from public.tasks t
      cross join lateral public.task_titles_match(p_title, t.title) m
     where t.project_id = p_project
       and t.status not in ('archived', 'deleted')
       and t.id is distinct from p_exclude
       and m.is_dup
       and (p_exclude is null or not public.task_pair_settled(p_exclude, t.id))
     order by m.similarity desc, t.created_at desc
     limit 10;
end;
$$;

revoke all on function public.find_possible_duplicates(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.find_possible_duplicates(uuid, text, uuid, uuid) to authenticated, service_role;

create or replace function public.list_possible_duplicates(p_project uuid)
returns table (
  task_a uuid, key_a text, title_a text, status_a text,
  task_b uuid, key_b text, title_b text, status_b text,
  similarity real, reason text, same_epic boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null then
    if not public.is_project_member(p_project) then
      return;
    end if;
  elsif auth.role() is distinct from 'service_role' then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  return query
    with live as (
      select t.id, t.key, t.title, t.status::text as status, t.epic_id, t.created_at
        from public.tasks t
       where t.project_id = p_project and t.status not in ('archived', 'deleted')
    )
    select a.id, a.key, a.title, a.status, b.id, b.key, b.title, b.status, m.similarity, m.reason,
           (a.epic_id is not null and a.epic_id = b.epic_id)
      from live a
      join live b on a.id < b.id
      cross join lateral public.task_titles_match(a.title, b.title) m
     where m.is_dup
       and not public.task_pair_settled(a.id, b.id)
     order by m.similarity desc, greatest(a.created_at, b.created_at) desc;
end;
$$;

revoke all on function public.list_possible_duplicates(uuid) from public, anon;
grant execute on function public.list_possible_duplicates(uuid) to authenticated, service_role;

-- ── moving a task's work into another: shared by revisions and new_version ──

create or replace function public.revision_move(
  p_old         uuid,
  p_new         uuid,
  p_files       text[],
  p_comment_ids uuid[],
  p_reason      text,
  p_actor       uuid,
  p_agent       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old      public.tasks%rowtype;
  v_new      public.tasks%rowtype;
  v_files    text[];
  v_comments uuid[];
  v_subtasks text[];
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_old from public.tasks where id = p_old;
  select * into v_new from public.tasks where id = p_new;

  -- Only files that are live on the old task move.
  select coalesce(array_agg(f order by array_position(v_old.attachments, f)), '{}') into v_files
    from unnest(coalesce(p_files, '{}')) f
   where f = any(v_old.attachments);

  insert into public.task_links (project_id, source_task_id, target_task_id, link_type, created_by)
  values (v_old.project_id, p_new, p_old, 'supersedes', p_actor)
  on conflict do nothing;

  -- Open subtasks follow; closed ones stay as the old task's history.
  with moved as (
    update public.tasks
       set parent_task_id = p_new
     where parent_task_id = p_old
       and id <> p_new
       and status not in ('done', 'cancelled', 'archived', 'deleted')
    returning key
  )
  select coalesce(array_agg(key order by key), '{}') into v_subtasks from moved;

  perform set_config('qira.attachment_move', 'on', true);
  perform set_config('qira.revision', p_old::text, true);
  if cardinality(v_files) > 0 then
    update public.tasks
       set attachments = coalesce(attachments, '{}') || array(select f from unnest(v_files) f where not (f = any(coalesce(attachments, '{}'))))
     where id = p_new;
  end if;
  update public.tasks
     set attachments = array(select a from unnest(attachments) a where not (a = any(v_files))),
         status = 'archived'
   where id = p_old;
  perform set_config('qira.attachment_move', '', true);
  perform set_config('qira.revision', '', true);

  with moved as (
    update public.task_comments
       set task_id = p_new
     where task_id = p_old and id = any(coalesce(p_comment_ids, '{}')) and archived_at is null
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_comments from moved;
  update public.task_comment_edits e set task_id = p_new
    from public.task_comments c
   where e.comment_id = c.id and c.task_id = p_new;

  insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
  values
    (v_old.project_id, p_old, p_actor, 'task_updated',
     'Superseded by a new revision ' || v_new.key || coalesce(': ' || v_reason, '') || ' — archived'),
    (v_old.project_id, p_new, p_actor, 'task_created',
     'New revision of ' || v_old.key || coalesce(': ' || v_reason, ''));

  insert into public.notifications (project_id, profile_id, task_id, notification_type, title, body)
  select v_old.project_id, a.id, p_new, 'system',
         'Новая редакция задачи · ' || v_old.key || ' → ' || v_new.key,
         coalesce(v_reason || E'\n', '') || v_old.key || ' перенесена в архив, актуальна ' || v_new.key || '.'
    from unnest(public.task_assignee_list(v_old.assignee_id, v_old.assignee_ids)) a(id)
   where a.id is distinct from p_actor;

  return jsonb_build_object(
    'moved_attachments', cardinality(v_files),
    'moved_attachment_paths', to_jsonb(v_files),
    'moved_comments', cardinality(v_comments),
    'moved_comment_ids', to_jsonb(v_comments),
    'moved_subtasks', to_jsonb(v_subtasks)
  );
end;
$$;

revoke all on function public.revision_move(uuid, uuid, text[], uuid[], text, uuid, text) from public, anon, authenticated;

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
  v_moved jsonb;
  v_subtasks text[];
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
    v_old.implements_screen_task_id, '{}'::text[]
  )
  returning * into v_new;

  v_moved := public.revision_move(v_old.id, v_new.id, v_files, p_comment_ids, p_reason, v_actor, p_agent);

  return jsonb_build_object(
    'old_task_id', v_old.id, 'old_key', v_old.key,
    'new_task_id', v_new.id, 'new_key', v_new.key,
    'moved_attachments', (v_moved->>'moved_attachments')::int, 'moved_comments', (v_moved->>'moved_comments')::int,
    'moved_subtasks', v_moved->'moved_subtasks',
    'agent', p_agent
  );
end;
$$;

-- Moving files is not uploading them: a move never marks work as started.
create or replace function public.mark_work_started_by_attachment()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.work_started_at is null and auth.uid() is not null
     and current_setting('qira.attachment_move', true) is distinct from 'on'
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

-- ── resolving ───────────────────────────────────────────────────────────────

create or replace function public.resolve_duplicate(
  p_keep              uuid,
  p_other             uuid,
  p_action            text,
  p_comment_ids       uuid[] default '{}',
  p_confirm_data_loss boolean default false,
  p_owner_confirmed   boolean default false,
  p_actor             uuid default null,
  p_agent             text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid;
  v_keep    public.tasks%rowtype;
  v_other   public.tasks%rowtype;
  v_started boolean;
  v_request text := current_setting('qira.dup_request', true);
  v_params  jsonb;
  v_files   text[];
  v_comments integer;
  v_open    text[];
  v_who     text;
  v_moved   jsonb := '{}'::jsonb;
  v_details jsonb;
begin
  if auth.uid() is not null then
    v_actor := auth.uid();
  elsif auth.role() = 'service_role' then
    v_actor := p_actor;
  else
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_action not in ('not_duplicate', 'duplicate', 'new_version') then
    raise exception 'action must be not_duplicate, duplicate or new_version' using errcode = '22023';
  end if;

  select * into v_keep from public.tasks where id = p_keep for update;
  select * into v_other from public.tasks where id = p_other for update;
  if v_keep.id is null or v_other.id is null then
    raise exception 'task does not exist' using errcode = 'P0002';
  end if;
  if v_keep.id = v_other.id or v_keep.project_id <> v_other.project_id then
    raise exception 'two different tasks of one project are needed' using errcode = '22023';
  end if;
  if v_keep.status in ('archived', 'deleted') or v_other.status in ('archived', 'deleted') then
    raise exception '% and % must both be live', v_keep.key, v_other.key using errcode = '55000';
  end if;
  if auth.uid() is not null and not public.is_admin() and not exists (
    select 1 from public.project_members pm
     where pm.project_id = v_keep.project_id and pm.profile_id = v_actor and pm.project_role <> 'viewer'
  ) then
    raise exception 'not allowed in this project' using errcode = '42501';
  end if;

  if p_action = 'not_duplicate' then
    insert into public.task_duplicate_decisions (project_id, task_a, task_b, keep_task, other_task, action, actor_id, actor_agent)
    values (v_keep.project_id, least(p_keep, p_other), greatest(p_keep, p_other), p_keep, p_other, 'not_duplicate', v_actor, p_agent);
    return jsonb_build_object('action', 'not_duplicate', 'keep', v_keep.key, 'other', v_other.key, 'done', true);
  end if;

  -- What `other` still holds.
  v_files := coalesce(v_other.attachments, '{}');
  select count(*) into v_comments from public.task_comments c where c.task_id = p_other and c.archived_at is null;
  select coalesce(array_agg(s.key order by s.key), '{}') into v_open
    from public.tasks s
   where s.parent_task_id = p_other and s.id <> p_keep and s.status not in ('done', 'cancelled', 'archived', 'deleted');

  if p_action = 'duplicate' and not p_confirm_data_loss
     and (cardinality(v_files) > 0 or v_comments > 0 or cardinality(v_open) > 0) then
    return jsonb_build_object(
      'action', 'duplicate', 'done', false, 'needs_confirmation', 'data',
      'keep', v_keep.key, 'other', v_other.key,
      'other_holds', jsonb_build_object(
        'attachments', (select coalesce(jsonb_agg(jsonb_build_object('path', f, 'name', coalesce(n.original_name, f))), '[]'::jsonb)
                          from unnest(v_files) f left join public.attachment_notes n on n.path = f and n.project_id = v_other.project_id),
        'live_comments', v_comments,
        'open_subtasks', to_jsonb(v_open)),
      'suggestion', 'new_version');
  end if;

  -- Archiving started work follows the edit policy.
  v_started := v_other.work_started_at is not null and coalesce(v_other.work_started_signal, '') <> 'done_status';
  if v_started then
    select coalesce(nullif(p.full_name, ''), p.email) into v_who from public.profiles p where p.id = v_other.work_started_by;
    v_params := jsonb_build_object('keep', p_keep, 'other', p_other, 'action', p_action,
                                   'comment_ids', to_jsonb(coalesce(p_comment_ids, '{}')), 'confirm_data_loss', coalesce(p_confirm_data_loss, false));
    if auth.uid() is not null then
      if not public.is_project_owner_of(v_other.project_id, v_actor) then
        raise exception '% is in work: % started it on % (signal: %). Only an owner of the project can archive it.',
          v_other.key, coalesce(v_who, 'someone'), to_char(v_other.work_started_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), v_other.work_started_signal
          using errcode = '42501';
      end if;
      if not p_owner_confirmed then
        return jsonb_build_object(
          'action', p_action, 'done', false, 'needs_confirmation', 'owner',
          'keep', v_keep.key, 'other', v_other.key,
          'started_by', v_who, 'started_at', v_other.work_started_at, 'signal', v_other.work_started_signal);
      end if;
    elsif not coalesce(
      exists (
        select 1 from public.owner_requests r
         where r.id = case when v_request ~ '^[0-9]{1,18}$' then v_request::bigint end
           and r.request_type = 'resolve_duplicate'
           and r.task_id = p_other
           and r.status = 'approved'
           and r.used_at is null
           and r.expires_at > now()
           and r.params = v_params
           and public.is_project_owner_of(r.project_id, r.decided_by)
      ), false) then
      return jsonb_build_object(
        'action', p_action, 'done', false, 'needs_owner_request', true,
        'keep', v_keep.key, 'other', v_other.key, 'other_task_id', p_other, 'project_id', v_other.project_id,
        'params', v_params,
        'started_by', v_who, 'started_at', v_other.work_started_at, 'signal', v_other.work_started_signal);
    end if;
  end if;

  if p_action = 'duplicate' then
    perform set_config('qira.revision', p_other::text, true);
    update public.tasks set status = 'archived' where id = p_other;
    perform set_config('qira.revision', '', true);
    insert into public.task_links (project_id, source_task_id, target_task_id, link_type, created_by)
    values (v_other.project_id, p_other, p_keep, 'duplicates', v_actor)
    on conflict do nothing;
    insert into public.task_activities (project_id, task_id, actor_id, activity_type, message)
    values (v_other.project_id, p_other, v_actor, 'task_updated', 'Archived as a duplicate of ' || v_keep.key);
  else
    -- `keep` may be the old revision trigger's subtask of `other`: lift it first.
    if v_keep.parent_task_id = p_other then
      update public.tasks set parent_task_id = v_other.parent_task_id where id = p_keep;
    end if;
    v_moved := public.revision_move(p_other, p_keep, v_files, p_comment_ids, 'new version ' || v_keep.key, v_actor, p_agent);
  end if;

  v_details := jsonb_build_object('started', v_started, 'confirmed_data_loss', coalesce(p_confirm_data_loss, false)) || v_moved;
  insert into public.task_duplicate_decisions (project_id, task_a, task_b, keep_task, other_task, action, actor_id, actor_agent, details)
  values (v_keep.project_id, least(p_keep, p_other), greatest(p_keep, p_other), p_keep, p_other, p_action, v_actor, p_agent, v_details);

  return jsonb_build_object('action', p_action, 'done', true, 'keep', v_keep.key, 'archived', v_other.key) || v_moved;
end;
$$;

revoke all on function public.resolve_duplicate(uuid, uuid, text, uuid[], boolean, boolean, uuid, text) from public, anon;
grant execute on function public.resolve_duplicate(uuid, uuid, text, uuid[], boolean, boolean, uuid, text) to authenticated, service_role;

-- ── owner requests learn the new type ───────────────────────────────────────

alter table public.owner_requests drop constraint if exists owner_requests_request_type_check;
alter table public.owner_requests add constraint owner_requests_request_type_check
  check (request_type in ('edit_in_place', 'delete_attachment', 'purge_task', 'purge_trash', 'resolve_duplicate'));

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
  if p_type not in ('edit_in_place', 'delete_attachment', 'purge_task', 'purge_trash', 'resolve_duplicate') then
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
    when 'resolve_duplicate' then 'архивация задачи в работе как дубля'
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
    -- Answer, don't raise: an exception would roll back this very event, and
    -- the audit log must show every refused attempt.
    insert into public.owner_request_events (request_id, project_id, event, actor_id, actor_agent, details)
    values (p_request, v_req.project_id, 'refused', p_actor, p_agent, jsonb_build_object('why', v_why));
    return jsonb_build_object('request_id', p_request, 'refused', true, 'status', v_req.status,
                              'why', format('request %s %s', p_request, v_why));
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

  elsif p_type = 'resolve_duplicate' then
    perform set_config('qira.dup_request', p_request::text, true);
    v_result := public.resolve_duplicate(
      (p_params->>'keep')::uuid, (p_params->>'other')::uuid, p_params->>'action',
      coalesce(array(select jsonb_array_elements_text(p_params->'comment_ids')::uuid), '{}'),
      coalesce((p_params->>'confirm_data_loss')::boolean, false), false, p_actor, p_agent);
    perform set_config('qira.dup_request', '', true);
    if not coalesce((v_result->>'done')::boolean, false) then
      -- The tasks changed since the request was filed: nothing done, request kept.
      insert into public.owner_request_events (request_id, project_id, event, actor_id, actor_agent, details)
      values (p_request, v_req.project_id, 'refused', p_actor, p_agent, jsonb_build_object('why', 'tasks changed since the request', 'answer', v_result));
      return jsonb_build_object('request_id', p_request, 'refused', true, 'status', v_req.status,
                                'why', format('request %s cannot be carried out as filed: the tasks changed since (%s)', p_request, coalesce(v_result->>'needs_confirmation', 'state')));
    end if;

  else -- purge_task, purge_trash
    v_result := public.purge_trashed_tasks(array(select jsonb_array_elements_text(p_params->'task_ids')::uuid));
  end if;

  update public.owner_requests set status = 'used', used_at = now() where id = p_request;
  insert into public.owner_request_events (request_id, project_id, event, actor_id, actor_agent, details)
  values (p_request, v_req.project_id, 'applied', p_actor, p_agent, v_result - 'paths');

  return v_result || jsonb_build_object('request_id', p_request);
end;
$$;
