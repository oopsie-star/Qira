-- Stage 2, second half: keep `attachments` and `archived_attachments` honest
-- against writes that replace the whole array.
--
-- The app writes a task's attachment list as a complete array computed from its
-- own copy, which can be stale. With a second array that is a hazard in both
-- directions:
--   - an agent archives file X, a user with an older tab open uploads something,
--     and the app writes back a list that still contains X — X is now both
--     live and archived;
--   - someone restores file Y, the stale tab writes a list without it — Y is now
--     in neither array, attached nowhere.
--
-- The rule enforced here: set_attachment_archived is the only way a file moves
-- between the two lists. A plain write can add new files and reorder live ones,
-- but
--   1. a file that was archived before the write cannot come back with it;
--   2. a file that leaves `attachments` without being archived is archived, not
--      dropped.
-- Rule 2 also makes "archive instead of delete" hold at the database level: even
-- a client still deleting the old way archives instead.
--
-- The archive RPC passes both rules untouched, because it moves the path out of
-- one array and into the other in the same statement.

create or replace function public.keep_attachment_archive_consistent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- 1. No silent un-archive: drop any live path that was already archived before
  --    this statement and is still archived after it. Order of the rest is kept.
  new.attachments := array(
    select live.path
    from unnest(coalesce(new.attachments, '{}')) with ordinality as live(path, pos)
    where not (
      live.path = any(coalesce(old.archived_attachments, '{}'))
      and live.path = any(coalesce(new.archived_attachments, '{}'))
    )
    order by live.pos
  );

  -- 2. No silent drop: a path that left the live list without landing in the
  --    archive goes to the archive.
  new.archived_attachments := coalesce(new.archived_attachments, '{}') || array(
    select distinct gone.path
    from unnest(coalesce(old.attachments, '{}')) as gone(path)
    where not (gone.path = any(new.attachments))
      and not (gone.path = any(coalesce(new.archived_attachments, '{}')))
  );

  return new;
end;
$$;

drop trigger if exists tasks_attachment_archive_guard on public.tasks;
create trigger tasks_attachment_archive_guard
  before update of attachments, archived_attachments on public.tasks
  for each row execute function public.keep_attachment_archive_consistent();

drop trigger if exists epics_attachment_archive_guard on public.epics;
create trigger epics_attachment_archive_guard
  before update of attachments, archived_attachments on public.epics
  for each row execute function public.keep_attachment_archive_consistent();

drop trigger if exists sprints_attachment_archive_guard on public.sprints;
create trigger sprints_attachment_archive_guard
  before update of attachments, archived_attachments on public.sprints
  for each row execute function public.keep_attachment_archive_consistent();
