-- Stage 3 of the clean working area: comments are archived, not deleted.
--
-- An archived comment stays in task_comments with archived_at set. Readers that
-- show the working area (the task drawer, MCP get_task, epic export) ask for
-- archived_at is null; the archive itself is a list the drawer and get_task
-- (include_archived) show on request, with a restore.
--
-- Three routes lead here, and all three end in the same columns:
--   - set_comment_archived(): the app's "archive" button and MCP archive_comment
--     / restore_comment;
--   - a plain DELETE from a tab still running the old bundle: turned into an
--     archive by the trigger below, so nothing is lost before that tab reloads;
--   - folding a comment into the description (MCP archive_comment with
--     folded_into_description): an archive with the reason recorded.
--
-- Edits are kept too: every change of a comment's body, whoever makes it and by
-- whatever route, writes the old and new text to task_comment_edits.

alter table public.task_comments
  add column if not exists archived_at             timestamptz,
  add column if not exists archived_by             uuid references public.profiles(id) on delete set null,
  add column if not exists archived_by_agent       text,
  add column if not exists folded_into_description boolean not null default false,
  add column if not exists edited_at               timestamptz;

comment on column public.task_comments.archived_at is
  'Set when the comment is archived (out of the working area, restorable). Null = live.';
comment on column public.task_comments.folded_into_description is
  'The comment was archived because its content was moved into the task description.';

-- The drawer and get_task read a task's live comments in order.
create index if not exists task_comments_live_by_task_idx
  on public.task_comments (task_id, created_at)
  where archived_at is null;

create table if not exists public.task_comment_edits (
  id              uuid primary key default gen_random_uuid(),
  comment_id      uuid not null references public.task_comments(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  task_id         uuid not null references public.tasks(id) on delete cascade,
  old_body        text not null,
  new_body        text not null,
  edited_by       uuid references public.profiles(id) on delete set null,
  edited_by_agent text,
  edited_at       timestamptz not null default now()
);

create index if not exists task_comment_edits_by_comment_idx
  on public.task_comment_edits (comment_id, edited_at);

alter table public.task_comment_edits enable row level security;

-- Readable like the comments themselves; written only by the trigger below
-- (security definer), so there is no insert/update/delete policy at all.
drop policy if exists task_comment_edits_select on public.task_comment_edits;
create policy task_comment_edits_select on public.task_comment_edits
  for select using (public.is_project_member(project_id));

/**
 * Records every change of a comment's body. The editor is the signed-in user;
 * for the service role (MCP), update_comment_body() names the agent's profile
 * and agent in transaction-local settings first. Nothing else reads them.
 */
create or replace function public.record_task_comment_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.body is distinct from old.body then
    insert into public.task_comment_edits (comment_id, project_id, task_id, old_body, new_body, edited_by, edited_by_agent)
    values (
      old.id, old.project_id, old.task_id, old.body, new.body,
      coalesce(auth.uid(), nullif(current_setting('qira.comment_actor', true), '')::uuid),
      nullif(current_setting('qira.comment_agent', true), '')
    );
    new.edited_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists task_comments_record_edit on public.task_comments;
create trigger task_comments_record_edit
  before update of body on public.task_comments
  for each row execute function public.record_task_comment_edit();

/**
 * The archive columns can also be written by a plain UPDATE (the existing
 * update policy covers every column). Whoever does that is the archiver: a
 * signed-in user cannot record someone else, or an MCP agent, as having
 * archived a comment. The service role (MCP, via set_comment_archived) is
 * trusted with the names it gives, as everywhere else.
 */
create or replace function public.stamp_task_comment_archiver()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and (new.archived_at is distinct from old.archived_at
          or new.archived_by is distinct from old.archived_by
          or new.archived_by_agent is distinct from old.archived_by_agent) then
    if new.archived_at is null then
      new.archived_by := null;
      new.archived_by_agent := null;
      new.folded_into_description := false;
    else
      new.archived_by := auth.uid();
      new.archived_by_agent := case when new.archived_by_agent = 'qira-assistant' then new.archived_by_agent end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists task_comments_stamp_archiver on public.task_comments;
create trigger task_comments_stamp_archiver
  before update of archived_at, archived_by, archived_by_agent on public.task_comments
  for each row execute function public.stamp_task_comment_archiver();

/**
 * A DELETE of a comment archives it instead — the safety net for tabs still on
 * the old bundle, whose trash button deletes. Same permission as before (the
 * delete policy has already let the row through), same outcome as the new
 * archive button.
 *
 * Deliberately NOT turned into an archive: a comment going away because its
 * task, project or author is being deleted. Those deletes arrive as foreign-key
 * cascades, from inside the cascading trigger (depth > 1) and after the parent
 * row is already gone; either sign alone lets the delete through. Turning them
 * into archives would make deleting a task or project fail or leave orphans.
 * A future purge (stage 4b, owner-approved) sets qira.purge_comments = 'on'.
 */
create or replace function public.archive_task_comment_instead_of_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1
     or current_setting('qira.purge_comments', true) = 'on'
     or not exists (select 1 from public.tasks where id = old.task_id)
     or not exists (select 1 from public.projects where id = old.project_id)
     or not exists (select 1 from public.profiles where id = old.author_id)
  then
    return old;
  end if;

  if old.archived_at is null then
    update public.task_comments
       set archived_at = now(),
           archived_by = auth.uid(),
           archived_by_agent = null
     where id = old.id;
  end if;
  return null;
end;
$$;

drop trigger if exists task_comments_archive_instead_of_delete on public.task_comments;
create trigger task_comments_archive_instead_of_delete
  before delete on public.task_comments
  for each row execute function public.archive_task_comment_instead_of_delete();

/**
 * Archives (p_archived = true) or restores one comment. Idempotent: a repeat
 * reports changed: false. p_folded marks an archive as "moved into the
 * description"; restoring clears it, since the comment is live again.
 *
 * Identity follows set_attachment_archived: a signed-in user always acts as
 * themselves (and may only label the action 'qira-assistant'); the service role
 * (MCP) names its agent profile and agent.
 *
 * Permission for a signed-in user is the one that already governed deleting a
 * comment (can_delete_task_content: a project owner/admin/founder/ceo or the
 * super admin, or the author while the task is still to do). Archiving is
 * reversible, but who may take a comment out of the working area is unchanged.
 */
create or replace function public.set_comment_archived(
  p_comment  uuid,
  p_archived boolean,
  p_folded   boolean default false,
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
  v_row     public.task_comments%rowtype;
begin
  if p_comment is null then
    raise exception 'comment id is required' using errcode = '22023';
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

  select * into v_row from public.task_comments where id = p_comment;
  if not found then
    raise exception 'comment % does not exist', p_comment using errcode = 'P0002';
  end if;

  if auth.uid() is not null
     and not public.can_delete_task_content(v_row.project_id, v_row.task_id, v_row.author_id) then
    raise exception 'not allowed to archive or restore this comment' using errcode = '42501';
  end if;

  if p_archived = (v_row.archived_at is not null)
     and (not p_archived or v_row.folded_into_description = coalesce(p_folded, false)) then
    return jsonb_build_object('comment_id', v_row.id, 'task_id', v_row.task_id, 'archived', p_archived,
                              'folded_into_description', v_row.folded_into_description, 'changed', false);
  end if;

  if p_archived then
    update public.task_comments
       set archived_at = coalesce(archived_at, now()),
           archived_by = case when archived_at is null then v_actor else archived_by end,
           archived_by_agent = case when archived_at is null then v_agent else archived_by_agent end,
           folded_into_description = coalesce(p_folded, false)
     where id = p_comment;
  else
    update public.task_comments
       set archived_at = null,
           archived_by = null,
           archived_by_agent = null,
           folded_into_description = false
     where id = p_comment;
  end if;

  return jsonb_build_object('comment_id', v_row.id, 'task_id', v_row.task_id, 'archived', p_archived,
                            'folded_into_description', p_archived and coalesce(p_folded, false), 'changed', true);
end;
$$;

revoke all on function public.set_comment_archived(uuid, boolean, boolean, uuid, text) from public, anon;
grant execute on function public.set_comment_archived(uuid, boolean, boolean, uuid, text) to authenticated, service_role;

/**
 * Changes a live comment's text, recording who did it in task_comment_edits.
 * The route MCP update_comment takes: the service role has no auth.uid(), so
 * the edit trigger learns the agent from transaction-local settings set here.
 * A signed-in user acts as themselves, under the existing update permission.
 */
create or replace function public.update_comment_body(
  p_comment uuid,
  p_body    text,
  p_actor   uuid default null,
  p_agent   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.task_comments%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if v_body = '' then
    raise exception 'body is required' using errcode = '22023';
  end if;

  if auth.uid() is null and auth.role() is distinct from 'service_role' then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into v_row from public.task_comments where id = p_comment;
  if not found then
    raise exception 'comment % does not exist', p_comment using errcode = 'P0002';
  end if;
  if v_row.archived_at is not null then
    raise exception 'comment % is archived; restore it before editing', p_comment using errcode = '55000';
  end if;

  if auth.uid() is not null then
    if not public.can_delete_task_content(v_row.project_id, v_row.task_id, v_row.author_id) then
      raise exception 'not allowed to edit this comment' using errcode = '42501';
    end if;
    perform set_config('qira.comment_agent', case when p_agent = 'qira-assistant' then p_agent else '' end, true);
  else
    perform set_config('qira.comment_actor', coalesce(p_actor::text, ''), true);
    perform set_config('qira.comment_agent', coalesce(p_agent, ''), true);
  end if;

  if v_body = v_row.body then
    return jsonb_build_object('comment_id', v_row.id, 'task_id', v_row.task_id, 'changed', false);
  end if;

  update public.task_comments set body = v_body where id = p_comment;

  return jsonb_build_object('comment_id', v_row.id, 'task_id', v_row.task_id, 'changed', true);
end;
$$;

revoke all on function public.update_comment_body(uuid, text, uuid, text) from public, anon;
grant execute on function public.update_comment_body(uuid, text, uuid, text) to authenticated, service_role;
