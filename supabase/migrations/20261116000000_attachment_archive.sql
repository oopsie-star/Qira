-- Stage 2 of the clean working area: attachments are archived, not deleted.
--
-- An archived file's path moves from `attachments` to `archived_attachments`
-- on the same row. Every existing reader of `attachments` — task cards and their
-- paperclip counts, the drawer, epic export, MCP get_task — therefore shows only
-- live files without being changed at all.
--
-- The cost of that choice is anything that enumerates a project's files from
-- those arrays. There is exactly one: project_attachment_paths, which lists what
-- to remove from storage when a project is deleted. It is taught about the new
-- arrays below — without that, archiving a file would strand it in storage for
-- good once its project was deleted.

alter table public.tasks   add column if not exists archived_attachments text[] not null default '{}';
alter table public.epics   add column if not exists archived_attachments text[] not null default '{}';
alter table public.sprints add column if not exists archived_attachments text[] not null default '{}';

comment on column public.tasks.archived_attachments is
  'Storage paths archived out of `attachments`. Restorable; who and when is on attachment_notes.';

-- Metadata lives on the path-keyed notes row, which exists for files from every
-- entity type. size_bytes / md5 are recorded at upload from now on, so a file's
-- integrity can be checked later rather than only at the moment it arrives.
alter table public.attachment_notes
  add column if not exists archived_at       timestamptz,
  add column if not exists archived_by       uuid references public.profiles(id) on delete set null,
  add column if not exists archived_by_agent text,
  add column if not exists size_bytes        bigint,
  add column if not exists md5               text;

/**
 * Archives (p_archived = true) or restores one attachment, wherever it lives:
 * a task, an epic or a sprint. Moving the path between the two arrays and
 * recording who did it happen in one statement, so a file is never in both
 * arrays, in neither, or archived with no record of by whom.
 *
 * Idempotent: archiving an already-archived file (or restoring a live one)
 * reports `changed: false` instead of failing, so an agent retrying a call that
 * timed out does no harm.
 *
 * Callers and identity:
 *   - a signed-in user (the app, and the in-app assistant, which runs under the
 *     user's token) always acts as themselves: p_actor is ignored for them, so
 *     nobody can archive in someone else's name. They may label the action
 *     'qira-assistant' and nothing else.
 *   - the service role (the MCP server, which has no user) passes its own agent
 *     profile as p_actor and 'claude' / 'chatgpt' as p_agent.
 */
create or replace function public.set_attachment_archived(
  p_path     text,
  p_archived boolean,
  p_actor    uuid default null,
  p_agent    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid;
  v_agent   text;
  v_table   text;
  v_id      uuid;
  v_project uuid;
  v_live    boolean;
  v_kind    text;
begin
  if p_path is null or btrim(p_path) = '' then
    raise exception 'path is required' using errcode = '22023';
  end if;

  if auth.uid() is not null then
    v_actor := auth.uid();
    v_agent := case when p_agent = 'qira-assistant' then p_agent else null end;
  elsif auth.role() = 'service_role' then
    v_actor := p_actor;
    v_agent := p_agent;
  else
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- Find the owner, in either array. Looking in both is what makes the call
  -- idempotent and lets a miss say precisely that the path is attached nowhere.
  for v_table, v_kind in values ('tasks', 'task'), ('epics', 'epic'), ('sprints', 'sprint') loop
    execute format(
      'select id, project_id, $1 = any(attachments) from public.%I
        where $1 = any(attachments) or $1 = any(archived_attachments)
        limit 1',
      v_table
    ) into v_id, v_project, v_live using p_path;
    exit when v_id is not null;
  end loop;

  if v_id is null then
    raise exception 'attachment % is not attached to any task, epic or sprint', p_path using errcode = 'P0002';
  end if;

  -- Same bar as editing the work itself: a project member who is not a viewer,
  -- or the super admin. The service role has already been vouched for by the
  -- MCP server's own key.
  if auth.uid() is not null and not (
    public.is_admin()
    or exists (
      select 1 from public.project_members pm
      where pm.project_id = v_project
        and pm.profile_id = v_actor
        and pm.project_role <> 'viewer'
    )
  ) then
    raise exception 'not allowed to change attachments in this project' using errcode = '42501';
  end if;

  if p_archived = not v_live then
    return jsonb_build_object('path', p_path, 'entity', v_kind, 'entity_id', v_id, 'archived', p_archived, 'changed', false);
  end if;

  if p_archived then
    execute format(
      'update public.%I
          set attachments          = array_remove(attachments, $2),
              archived_attachments = array_append(array_remove(archived_attachments, $2), $2)
        where id = $1',
      v_table
    ) using v_id, p_path;
  else
    execute format(
      'update public.%I
          set archived_attachments = array_remove(archived_attachments, $2),
              attachments          = array_append(array_remove(attachments, $2), $2)
        where id = $1',
      v_table
    ) using v_id, p_path;
  end if;

  insert into public.attachment_notes (project_id, path, archived_at, archived_by, archived_by_agent, updated_by)
  values (
    v_project, p_path,
    case when p_archived then now() end,
    case when p_archived then v_actor end,
    case when p_archived then v_agent end,
    v_actor
  )
  on conflict (project_id, path) do update
     set archived_at       = excluded.archived_at,
         archived_by       = excluded.archived_by,
         archived_by_agent = excluded.archived_by_agent,
         updated_by        = excluded.updated_by;

  return jsonb_build_object('path', p_path, 'entity', v_kind, 'entity_id', v_id, 'archived', p_archived, 'changed', true);
end;
$$;

revoke all on function public.set_attachment_archived(text, boolean, uuid, text) from public, anon;
grant execute on function public.set_attachment_archived(text, boolean, uuid, text) to authenticated, service_role;

-- The project-delete storage sweep, now including archived files. Identical to
-- the previous definition (20260815000000_project_map.sql) apart from the three
-- archived_attachments branches.
create or replace function public.project_attachment_paths(project_uuid uuid)
returns table(path text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct attachment_path as path
  from (
    select unnest(t.attachments) as attachment_path
    from public.tasks t
    where t.project_id = project_uuid

    union all

    select unnest(t.archived_attachments) as attachment_path
    from public.tasks t
    where t.project_id = project_uuid

    union all

    select unnest(tc.attachments) as attachment_path
    from public.task_comments tc
    where tc.project_id = project_uuid

    union all

    select unnest(e.attachments) as attachment_path
    from public.epics e
    where e.project_id = project_uuid

    union all

    select unnest(e.archived_attachments) as attachment_path
    from public.epics e
    where e.project_id = project_uuid

    union all

    select unnest(s.attachments) as attachment_path
    from public.sprints s
    where s.project_id = project_uuid

    union all

    select unnest(s.archived_attachments) as attachment_path
    from public.sprints s
    where s.project_id = project_uuid

    union all

    select unnest(b.attachments) as attachment_path
    from public.project_map_blocks b
    where b.project_id = project_uuid
  ) attachment_paths
  where public.can_delete_project(project_uuid)
    and attachment_path <> '';
$$;
