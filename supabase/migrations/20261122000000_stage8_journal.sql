-- Stage 8: journal of data migrations, and where a retired file keeps its old name.

create table if not exists public.data_migration_log (
  id         bigserial primary key,
  block      text        not null,
  table_name text        not null,
  row_id     text        not null,
  action     text        not null,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);
comment on table public.data_migration_log is
  'Every row a data migration changed (stage 8 on): block, row, the row before and after. Read it to audit or undo a block.';
alter table public.data_migration_log enable row level security;
revoke all on table public.data_migration_log from anon, authenticated;
create index if not exists data_migration_log_block on public.data_migration_log (block);

alter table public.attachment_notes add column if not exists retired_name text;
comment on column public.attachment_notes.retired_name is
  'The name a file had when it was retired by renaming ("УСТАРЕЛО …") before the archive existed; the prefix was dropped from original_name and the file archived (stage 8).';
