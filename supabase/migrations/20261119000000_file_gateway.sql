-- File gateway: every file read goes through one check, at every request.
--
-- Before: the app handed out storage signed URLs (1 hour for previews, 7 days
-- for "share"), which the storage CDN could keep serving for up to a minute
-- after a file was deleted, and which nobody could revoke. Now the edge
-- function "files" serves every byte, and asks file_gate() first:
--
--   * file_locate(path)  where the file is attached right now: 'live' (on a
--     live task / epic / sprint / comment / project-map block), 'archived'
--     (in an archive list, or on something in the trash), or 'none';
--   * file_gate(...)     the only decision: who asks (a signed-in member via a
--     short ticket, the MCP agent, or a share link), for what (view, or
--     archive — opened from the "Archive" list), and whether that is allowed
--     now. It writes every decision to file_access_log and returns only
--     "ok + where to read" or "no" — the caller answers a bare 404;
--   * file_share_links   share links are rows now: token (only its hash is
--     kept), file, who issued, 7 days. Revoked at once when the file stops
--     being live (archived, removed, its task trashed) — by trigger — and
--     by any owner of the project from the app;
--   * file_may_remove()  the app no longer deletes storage objects itself;
--     the function removes a file only when nothing references it any more.
--
-- Storage policies are NOT changed here: the app still uses signed URLs until
-- the new build is out. 20261119010000 closes direct reads afterwards.

-- ── where is this file now ──────────────────────────────────────────────────

create index if not exists tasks_attachments_gin on public.tasks using gin (attachments);
create index if not exists tasks_archived_attachments_gin on public.tasks using gin (archived_attachments);

create or replace function public.file_locate(p_path text)
returns table (state text, project_id uuid, container text, container_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_one text[] := array[p_path];
begin
  if p_path is null or p_path = '' then
    return query select 'none'::text, null::uuid, null::text, null::uuid;
    return;
  end if;

  -- live first: a file both live somewhere and archived elsewhere is live.
  return query
    select 'live', t.project_id, 'task', t.id from public.tasks t
     where t.attachments @> v_one and t.status not in ('archived', 'deleted') limit 1;
  if found then return; end if;
  return query
    select 'live', e.project_id, 'epic', e.id from public.epics e
     where e.attachments @> v_one and e.status::text <> 'archived' limit 1;
  if found then return; end if;
  return query
    select 'live', s.project_id, 'sprint', s.id from public.sprints s
     where s.attachments @> v_one limit 1;
  if found then return; end if;
  return query
    select 'live', t.project_id, 'comment', c.id from public.task_comments c join public.tasks t on t.id = c.task_id
     where c.attachments @> v_one and c.archived_at is null and t.status not in ('archived', 'deleted') limit 1;
  if found then return; end if;
  return query
    select 'live', b.project_id, 'project_map', b.id from public.project_map_blocks b
     where b.attachments @> v_one limit 1;
  if found then return; end if;

  -- archived: in an archive list, or on something that is in the trash.
  return query
    select 'archived', t.project_id, 'task', t.id from public.tasks t
     where t.archived_attachments @> v_one or t.attachments @> v_one limit 1;
  if found then return; end if;
  return query
    select 'archived', e.project_id, 'epic', e.id from public.epics e
     where e.archived_attachments @> v_one or e.attachments @> v_one limit 1;
  if found then return; end if;
  return query
    select 'archived', s.project_id, 'sprint', s.id from public.sprints s
     where s.archived_attachments @> v_one limit 1;
  if found then return; end if;
  return query
    select 'archived', t.project_id, 'comment', c.id from public.task_comments c join public.tasks t on t.id = c.task_id
     where c.attachments @> v_one limit 1;
  if found then return; end if;

  return query select 'none'::text, null::uuid, null::text, null::uuid;
end;
$$;

revoke all on function public.file_locate(text) from public, anon, authenticated;
grant execute on function public.file_locate(text) to service_role;

-- 'attachments' holds user uploads (project/owner/author/file); Jira imports
-- live in 'task-attachments' (three segments). Same rule as storageBucket().
create or replace function public.file_bucket(p_path text)
returns text
language sql
immutable
as $$
  select case
    when array_length(string_to_array(p_path, '/'), 1) >= 4
     and split_part(p_path, '/', 3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then 'attachments'
    when array_length(string_to_array(p_path, '/'), 1) = 3 then 'task-attachments'
    else 'attachments'
  end;
$$;

create or replace function public.file_reader_is_member(p_project uuid, p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_profile is not null and (
    exists (select 1 from public.profiles p where p.id = p_profile and p.role = 'admin')
    or exists (select 1 from public.project_members pm where pm.project_id = p_project and pm.profile_id = p_profile)
  );
$$;

revoke all on function public.file_reader_is_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.file_reader_is_member(uuid, uuid) to service_role;

-- ── share links ─────────────────────────────────────────────────────────────

create table if not exists public.file_share_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null,
  revoke_reason text,
  use_count integer not null default 0,
  last_used_at timestamptz
);

create index if not exists file_share_links_project on public.file_share_links (project_id, created_at desc);
create index if not exists file_share_links_active_path on public.file_share_links (path) where revoked_at is null;

alter table public.file_share_links enable row level security;
drop policy if exists file_share_links_read on public.file_share_links;
create policy file_share_links_read on public.file_share_links
  for select to authenticated
  using (created_by = auth.uid() or public.is_project_owner_of(project_id, auth.uid()));
-- No write policies: links are made and revoked only by the functions below.
-- The token hash is not for clients: grant every column but it.
revoke all on public.file_share_links from anon, authenticated;
grant select (id, project_id, path, created_by, created_at, expires_at, revoked_at, revoked_by, revoke_reason, use_count, last_used_at)
  on public.file_share_links to authenticated;

create or replace function public.create_file_share_links(p_paths text[])
returns table (path text, token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_path text;
  v_loc record;
  v_token text;
  v_exp timestamptz := now() + interval '7 days';
begin
  if v_me is null then
    raise exception 'sign in to share files' using errcode = '42501';
  end if;
  foreach v_path in array coalesce(p_paths, '{}') loop
    select * into v_loc from public.file_locate(v_path) limit 1;
    -- Only live files, only by members; anything else is silently skipped.
    continue when v_loc.state is distinct from 'live' or not public.file_reader_is_member(v_loc.project_id, v_me);
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into public.file_share_links (token_hash, project_id, path, created_by, expires_at)
    values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_loc.project_id, v_path, v_me, v_exp);
    path := v_path; token := v_token; expires_at := v_exp;
    return next;
  end loop;
end;
$$;

revoke all on function public.create_file_share_links(text[]) from public, anon;
grant execute on function public.create_file_share_links(text[]) to authenticated;

create or replace function public.revoke_file_share_link(p_link uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_link public.file_share_links;
begin
  select * into v_link from public.file_share_links where id = p_link;
  if v_link.id is null
     or not (v_link.created_by = auth.uid() or public.is_project_owner_of(v_link.project_id, auth.uid())) then
    raise exception 'no such link' using errcode = '42501';
  end if;
  update public.file_share_links
     set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, auth.uid()),
         revoke_reason = coalesce(revoke_reason, 'revoked by hand')
   where id = p_link;
end;
$$;

revoke all on function public.revoke_file_share_link(uuid) from public, anon;
grant execute on function public.revoke_file_share_link(uuid) to authenticated;

-- A file that stops being live takes its share links with it, at once.
create or replace function public.revoke_share_links_of_dead_files()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paths text[] := coalesce(old.attachments, '{}');
begin
  if cardinality(v_paths) = 0
     or not exists (select 1 from public.file_share_links l where l.revoked_at is null and l.path = any(v_paths)) then
    return null;
  end if;
  update public.file_share_links l
     set revoked_at = now(),
         revoke_reason = case tg_op when 'DELETE' then 'file deleted' else 'file archived or removed' end
   where l.revoked_at is null
     and l.path = any(v_paths)
     and coalesce((select f.state from public.file_locate(l.path) f limit 1), 'none') <> 'live';
  return null;
end;
$$;

drop trigger if exists tasks_revoke_share_links on public.tasks;
create trigger tasks_revoke_share_links
  after update of attachments, status or delete on public.tasks
  for each row execute function public.revoke_share_links_of_dead_files();
drop trigger if exists epics_revoke_share_links on public.epics;
create trigger epics_revoke_share_links
  after update of attachments, status or delete on public.epics
  for each row execute function public.revoke_share_links_of_dead_files();
drop trigger if exists sprints_revoke_share_links on public.sprints;
create trigger sprints_revoke_share_links
  after update of attachments or delete on public.sprints
  for each row execute function public.revoke_share_links_of_dead_files();
drop trigger if exists task_comments_revoke_share_links on public.task_comments;
create trigger task_comments_revoke_share_links
  after update of attachments, archived_at or delete on public.task_comments
  for each row execute function public.revoke_share_links_of_dead_files();
drop trigger if exists project_map_blocks_revoke_share_links on public.project_map_blocks;
create trigger project_map_blocks_revoke_share_links
  after update of attachments or delete on public.project_map_blocks
  for each row execute function public.revoke_share_links_of_dead_files();

-- ── access log ──────────────────────────────────────────────────────────────

create table if not exists public.file_access_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  project_id uuid,
  path text,
  channel text not null check (channel in ('app', 'mcp', 'share')),
  purpose text not null check (purpose in ('view', 'archive')),
  actor_id uuid,
  actor_agent text,
  share_link_id uuid,
  outcome text not null check (outcome in ('served', 'denied')),
  reason text,
  byte_range text,
  ip text,
  user_agent text
);

create index if not exists file_access_log_project_at on public.file_access_log (project_id, at desc);
create index if not exists file_access_log_path on public.file_access_log (path, at desc);

alter table public.file_access_log enable row level security;
drop policy if exists file_access_log_read on public.file_access_log;
create policy file_access_log_read on public.file_access_log
  for select to authenticated
  using (project_id is not null and public.is_project_owner_of(project_id, auth.uid()));
revoke all on public.file_access_log from anon, authenticated;
grant select on public.file_access_log to authenticated;

-- ── the one decision ────────────────────────────────────────────────────────

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

  insert into public.file_access_log (project_id, path, channel, purpose, actor_id, actor_agent, share_link_id, outcome, reason, byte_range, ip, user_agent)
  values (coalesce(v_project, v_link.project_id), v_path, coalesce(p_channel, 'app'), v_purpose, p_actor, p_agent, v_link.id,
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

-- ── removing storage objects ────────────────────────────────────────────────

-- The app removes a file from storage only once nothing references it any
-- more, and only its uploader, a project owner or a super admin may.
create or replace function public.file_may_remove(p_path text, p_actor uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_state text;
  v_project uuid;
  v_owner uuid;
begin
  if p_actor is null or p_path is null then
    return false;
  end if;
  select f.state into v_state from public.file_locate(p_path) f limit 1;
  if coalesce(v_state, 'none') <> 'none' then
    return false;
  end if;
  v_project := case when split_part(p_path, '/', 1) ~* '^[0-9a-f-]{36}$' then split_part(p_path, '/', 1)::uuid end;
  select o.owner into v_owner from storage.objects o where o.bucket_id = public.file_bucket(p_path) and o.name = p_path;
  return v_owner = p_actor
      or exists (select 1 from public.profiles p where p.id = p_actor and p.role = 'admin')
      or (v_project is not null and public.is_project_owner_of(v_project, p_actor));
end;
$$;

revoke all on function public.file_may_remove(text, uuid) from public, anon, authenticated;
grant execute on function public.file_may_remove(text, uuid) to service_role;
