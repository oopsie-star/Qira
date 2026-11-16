-- Two follow-ups to stages 2 and 3.
--
-- 1. A restored attachment goes back where it was in the list, not to the end.
--    The position is recorded on archive (attachment_notes.archived_position)
--    and used on restore; the function reports it so the app can place the file
--    without reloading. A file archived before this migration, or archived by
--    the guard trigger (an old tab dropping it), has no recorded position and
--    is restored at the end, as before.
--
-- 2. When an AI agent archives a person's comment, the author is notified with
--    the reason, and the reason is kept on the comment (archive_reason) so the
--    task drawer can show who archived it and why.
--
-- No foreign keys are added (see 20261116030000): archived_by-style stamps are
-- written only by these functions.

alter table public.attachment_notes add column if not exists archived_position integer;

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
  v_actor    uuid;
  v_agent    text;
  v_table    text;
  v_id       uuid;
  v_project  uuid;
  v_live     boolean;
  v_kind     text;
  v_list     text[];
  v_position integer;
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

  for v_table, v_kind in values ('tasks', 'task'), ('epics', 'epic'), ('sprints', 'sprint') loop
    execute format(
      'select id, project_id, $1 = any(attachments), attachments from public.%I
        where $1 = any(attachments) or $1 = any(archived_attachments)
        limit 1',
      v_table
    ) into v_id, v_project, v_live, v_list using p_path;
    exit when v_id is not null;
  end loop;

  if v_id is null then
    raise exception 'attachment % is not attached to any task, epic or sprint', p_path using errcode = 'P0002';
  end if;

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
    -- 0-based index in the live list, kept so a restore can put it back there.
    v_position := array_position(v_list, p_path) - 1;
    execute format(
      'update public.%I
          set attachments          = array_remove(attachments, $2),
              archived_attachments = array_append(array_remove(archived_attachments, $2), $2)
        where id = $1',
      v_table
    ) using v_id, p_path;
  else
    select n.archived_position into v_position
      from public.attachment_notes n
     where n.project_id = v_project and n.path = p_path;
    -- Unknown, or past the end of a list that has since shrunk: the end.
    v_position := least(coalesce(v_position, cardinality(v_list)), cardinality(v_list));
    execute format(
      'update public.%I
          set archived_attachments = array_remove(archived_attachments, $2),
              attachments          = attachments[1:$3] || array[$2] || attachments[$3 + 1:]
        where id = $1',
      v_table
    ) using v_id, p_path, v_position;
  end if;

  insert into public.attachment_notes (project_id, path, archived_at, archived_by, archived_by_agent, archived_position, updated_by)
  values (
    v_project, p_path,
    case when p_archived then now() end,
    case when p_archived then v_actor end,
    case when p_archived then v_agent end,
    case when p_archived then v_position end,
    v_actor
  )
  on conflict (project_id, path) do update
     set archived_at       = excluded.archived_at,
         archived_by       = excluded.archived_by,
         archived_by_agent = excluded.archived_by_agent,
         archived_position = excluded.archived_position,
         updated_by        = excluded.updated_by;

  return jsonb_build_object('path', p_path, 'entity', v_kind, 'entity_id', v_id, 'archived', p_archived,
                            'changed', true, 'position', v_position);
end;
$$;

revoke all on function public.set_attachment_archived(text, boolean, uuid, text) from public, anon;
grant execute on function public.set_attachment_archived(text, boolean, uuid, text) to authenticated, service_role;

-- ── Comments: archive reason and the author's notice ───────────────────────────

alter table public.task_comments add column if not exists archive_reason text;

comment on column public.task_comments.archive_reason is
  'Why the comment was archived, as given by whoever archived it (optional). Cleared on restore.';

-- The signature gains p_reason; drop the old one so a call by name cannot be
-- ambiguous between the two.
drop function if exists public.set_comment_archived(uuid, boolean, boolean, uuid, text);

/**
 * As in 20261116020000, plus:
 *   - p_reason, kept on the comment (at most 500 characters);
 *   - when an AI agent (p_agent) archives a comment someone else wrote, that
 *     author gets a notification saying which agent, on which task, and why.
 *     Agents' own comments (author = the acting profile) notify no one.
 */
create or replace function public.set_comment_archived(
  p_comment  uuid,
  p_archived boolean,
  p_folded   boolean default false,
  p_actor    uuid default null,
  p_agent    text default null,
  p_reason   text default null
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
  v_reason  text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  v_folded  boolean := p_archived and coalesce(p_folded, false);
  v_key     text;
  v_locale  text;
  v_who     text;
  v_why     text;
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
     and (not p_archived or (v_row.folded_into_description = v_folded
                             and v_row.archive_reason is not distinct from coalesce(v_reason, v_row.archive_reason))) then
    return jsonb_build_object('comment_id', v_row.id, 'task_id', v_row.task_id, 'archived', p_archived,
                              'folded_into_description', v_row.folded_into_description,
                              'reason', v_row.archive_reason, 'changed', false);
  end if;

  if p_archived then
    update public.task_comments
       set archived_at = coalesce(archived_at, now()),
           archived_by = case when archived_at is null then v_actor else archived_by end,
           archived_by_agent = case when archived_at is null then v_agent else archived_by_agent end,
           folded_into_description = v_folded,
           archive_reason = coalesce(v_reason, archive_reason)
     where id = p_comment;
  else
    update public.task_comments
       set archived_at = null,
           archived_by = null,
           archived_by_agent = null,
           folded_into_description = false,
           archive_reason = null
     where id = p_comment;
  end if;

  -- Tell the author when an AI took their comment out of the working area.
  -- Only on the first archive (not on a repeat that merely adds a reason).
  if p_archived and v_row.archived_at is null and v_agent is not null
     and v_row.author_id is distinct from v_actor then
    select t.key into v_key from public.tasks t where t.id = v_row.task_id;
    select coalesce(p.locale, 'ru') into v_locale from public.profiles p where p.id = v_row.author_id;
    v_who := case v_agent when 'claude' then 'Claude' when 'chatgpt' then 'ChatGPT'
                          when 'qira-assistant' then case when v_locale like 'en%' then 'Qira assistant' else 'Ассистент Qira' end
                          else v_agent end;
    v_why := case
      when v_folded and v_reason is not null then
        case when v_locale like 'en%' then 'moved into the task description: ' else 'перенесён в описание задачи: ' end || v_reason
      when v_folded then
        case when v_locale like 'en%' then 'moved into the task description' else 'перенесён в описание задачи' end
      when v_reason is not null then v_reason
      else case when v_locale like 'en%' then 'no reason given' else 'причина не указана' end
    end;

    insert into public.notifications (project_id, profile_id, task_id, notification_type, title, body)
    values (
      v_row.project_id,
      v_row.author_id,
      v_row.task_id,
      'system',
      case when v_locale like 'en%'
        then v_who || ' archived your comment on ' || coalesce(v_key, 'a task')
        else v_who || ' убрал ваш комментарий в архив · ' || coalesce(v_key, 'задача') end,
      case when v_locale like 'en%' then 'Reason: ' else 'Причина: ' end || v_why
        || E'\n«' || left(v_row.body, 140) || case when length(v_row.body) > 140 then '…' else '' end || '»'
        || case when v_locale like 'en%' then E'\nIt can be restored from the comments archive.'
                else E'\nЕго можно восстановить из архива комментариев.' end
    );
  end if;

  return jsonb_build_object('comment_id', v_row.id, 'task_id', v_row.task_id, 'archived', p_archived,
                            'folded_into_description', v_folded,
                            'reason', case when p_archived then coalesce(v_reason, v_row.archive_reason) end,
                            'changed', true);
end;
$$;

revoke all on function public.set_comment_archived(uuid, boolean, boolean, uuid, text, text) from public, anon;
grant execute on function public.set_comment_archived(uuid, boolean, boolean, uuid, text, text) to authenticated, service_role;
