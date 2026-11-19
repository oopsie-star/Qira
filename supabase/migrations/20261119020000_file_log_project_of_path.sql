-- Fix for 20261119000000_file_gateway.sql: a refused request for a file that
-- is no longer attached anywhere (deleted for good, or never attached) was
-- logged with no project, so the project's owners could not see the attempt
-- in "File access". It now falls back to the project named in the path's
-- first segment, when such a project exists. Found by the gateway checks in
-- TEST. Such rows carry project_from_path = true, so an owner can tell an
-- attempt on a deleted or foreign path from a read of a live file.
-- file_gate is otherwise unchanged.

alter table public.file_access_log add column if not exists project_from_path boolean not null default false;

create or replace function public.file_path_project(p_path text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id from public.projects p
   where split_part(coalesce(p_path, ''), '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and p.id = split_part(p_path, '/', 1)::uuid;
$$;

revoke all on function public.file_path_project(text) from public, anon, authenticated;
grant execute on function public.file_path_project(text) to service_role;

create or replace function public.file_gate(
  p_path text,
  p_channel text,
  p_purpose text,
  p_actor uuid,
  p_agent text,
  p_share_token text,
  p_range text,
  p_ip text,
  p_user_agent text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_path text := p_path;
  v_purpose text := coalesce(p_purpose, 'view');
  v_link public.file_share_links;
  v_state text;
  v_project uuid;
  v_why text;
  v_note record;
begin
  if p_channel = 'share' then
    v_purpose := 'view';
    select * into v_link from public.file_share_links
     where token_hash = encode(sha256(convert_to(coalesce(p_share_token, ''), 'UTF8')), 'hex');
    if v_link.id is null then
      v_why := 'unknown link';
    elsif v_link.revoked_at is not null then
      v_why := 'link revoked';
    elsif v_link.expires_at <= now() then
      v_why := 'link expired';
    end if;
    v_path := v_link.path;
  end if;

  if v_why is null then
    select f.state, f.project_id into v_state, v_project from public.file_locate(v_path) f limit 1;
    if v_state is null or v_state = 'none' then
      v_why := 'not attached';
    elsif p_channel = 'share' then
      -- A share link never serves an archived file.
      if v_state <> 'live' then
        v_why := 'not live';
        update public.file_share_links set revoked_at = now(), revoke_reason = 'file archived or removed' where id = v_link.id;
      end if;
    elsif p_channel = 'app' then
      if not public.file_reader_is_member(v_project, p_actor) then
        v_why := 'not a member';
      elsif v_purpose = 'view' and v_state <> 'live' then
        v_why := 'archived, open it from the archive list';
      elsif v_purpose = 'archive' and v_state <> 'archived' then
        v_why := 'not archived';
      end if;
    elsif p_channel = 'mcp' then
      -- The MCP agent reads live files of any project, never archived ones.
      if v_purpose <> 'view' or v_state <> 'live' then
        v_why := 'not live';
      end if;
    else
      v_why := 'unknown channel';
    end if;
  end if;

  insert into public.file_access_log (project_id, project_from_path, path, channel, purpose, actor_id, actor_agent, share_link_id, outcome, reason, byte_range, ip, user_agent)
  values (coalesce(v_project, v_link.project_id, public.file_path_project(v_path)),
          v_project is null and v_link.project_id is null and public.file_path_project(v_path) is not null,
          v_path, coalesce(p_channel, 'app'), v_purpose, p_actor, p_agent, v_link.id,
          case when v_why is null then 'served' else 'denied' end, v_why, left(p_range, 100), left(p_ip, 100), left(p_user_agent, 300));

  if v_why is not null then
    return jsonb_build_object('ok', false);
  end if;

  if p_channel = 'share' then
    update public.file_share_links set use_count = use_count + 1, last_used_at = now() where id = v_link.id;
  end if;

  select n.original_name, n.mime_type, n.size_bytes into v_note
    from public.attachment_notes n where n.project_id = v_project and n.path = v_path limit 1;

  return jsonb_build_object(
    'ok', true,
    'path', v_path,
    'bucket', public.file_bucket(v_path),
    'project_id', v_project,
    'name', v_note.original_name,
    'mime_type', v_note.mime_type,
    'size_bytes', v_note.size_bytes
  );
end;
$$;

revoke all on function public.file_gate(text, text, text, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.file_gate(text, text, text, uuid, text, text, text, text, text) to service_role;
