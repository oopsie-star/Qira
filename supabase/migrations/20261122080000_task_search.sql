-- One task search for MCP and the app: by any form of the key, by any match of the text.
--
-- The MCP search_tasks tool did two ILIKE queries (title, description) and did
-- not look at the key at all: "MOMNA-989" returned the 15 tasks that MENTION
-- MOMNA-989 in their text, but not MOMNA-989 itself. It also matched the query
-- only as one contiguous substring, so words in another order, or split between
-- title and description, found nothing; and each column was cut to 25 rows by
-- updated_at before merging, so a title hit could lose to newer description hits.
--
-- public.search_tasks(query, project, include_archived, limit):
--   key     — "MOMNA-989", "momna 989", "momna989", "#989", "989" (any project
--             prefix, or just the number = that number in any visible project);
--   text    — the whole phrase, or every word in any order, across key, title,
--             description and labels; case-insensitive, ё = е, all dash kinds = "-",
--             runs of whitespace = one space, quotes/punctuation around words ignored.
-- Order: exact key, title has the phrase, title has every word, text has the
-- phrase, text has every word; inside each group the most recently updated first.
-- archived/deleted are left out unless p_include_archived (cancelled stays: it is
-- a decision, not an archive — same rule as tools/visibility.ts).
--
-- security invoker: app users see only what RLS lets them; the MCP server calls
-- it as service_role, as it did the old queries.

create or replace function public.qira_search_norm(p text)
returns text
language sql
immutable
parallel safe
set search_path to 'public'
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p, '')), 'ё‐‑‒–—―−', 'е-------'),
    '\s+', ' ', 'g'))
$$;

create or replace function public.search_tasks(
  p_query text,
  p_project_id uuid default null,
  p_include_archived boolean default false,
  p_limit integer default 25
)
returns table (
  id uuid,
  key text,
  title text,
  status text,
  priority text,
  project_id uuid,
  updated_at timestamptz,
  matched_in text
)
language plpgsql
stable
security invoker
set search_path to 'public'
as $$
declare
  v_phrase text := public.qira_search_norm(p_query);
  v_words text[];
  v_m text[];
  v_key text;      -- exact key, lower case ("momna-989")
  v_key_num text;  -- bare number ("989"): that number in any project
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if v_phrase = '' then
    return;
  end if;

  v_words := array(
    select w from (
      select btrim(x, '«»„“”"''`.,;:!?()[]{}<>') as w
      from unnest(string_to_array(v_phrase, ' ')) as x
    ) s
    where w <> ''
  );
  if coalesce(array_length(v_words, 1), 0) = 0 then
    return;
  end if;

  -- Key forms. A prefix of letters may sit right against the number ("momna989");
  -- a prefix that itself has digits needs a separator ("p2-5", "p2 5").
  v_m := regexp_match(v_phrase, '^#?([a-z]+)[ _-]*#?0*([0-9]+)$');
  if v_m is null then
    v_m := regexp_match(v_phrase, '^#?([a-z][a-z0-9]*)[ _-]+#?0*([0-9]+)$');
  end if;
  if v_m is not null then
    v_key := v_m[1] || '-' || v_m[2];
  else
    v_m := regexp_match(v_phrase, '^#?0*([0-9]+)$');
    if v_m is not null then
      v_key_num := v_m[1];
    end if;
  end if;

  return query
  with cand as (
    select
      t.id, t.key, t.title, t.status, t.priority, t.project_id, t.updated_at,
      public.qira_search_norm(t.title) as nt,
      public.qira_search_norm(
        t.key || ' ' || coalesce(t.title, '') || ' ' || coalesce(t.description, '')
        || ' ' || coalesce(array_to_string(t.labels, ' '), '')
      ) as nall,
      lower(t.key) as lk
    from public.tasks t
    where (p_project_id is null or t.project_id = p_project_id)
      and (p_include_archived or t.status not in ('archived', 'deleted'))
  ),
  ranked as (
    select c.*,
      case
        when v_key is not null and c.lk = v_key then 0
        when v_key_num is not null and c.lk like '%-' || v_key_num then 0
        when strpos(c.nt, v_phrase) > 0 then 1
        when (select bool_and(strpos(c.nt, w) > 0) from unnest(v_words) w) then 2
        when strpos(c.nall, v_phrase) > 0 then 3
        when (select bool_and(strpos(c.nall, w) > 0) from unnest(v_words) w) then 4
      end as rnk
    from cand c
  )
  select r.id, r.key, r.title, r.status, r.priority, r.project_id, r.updated_at,
    case when r.rnk = 0 then 'key' when r.rnk <= 2 then 'title' else 'description' end
  from ranked r
  where r.rnk is not null
  order by r.rnk, r.updated_at desc
  limit v_limit;
end;
$$;

revoke all on function public.qira_search_norm(text) from public;
revoke all on function public.qira_search_norm(text) from anon;
grant execute on function public.qira_search_norm(text) to authenticated, service_role;
revoke all on function public.search_tasks(text, uuid, boolean, integer) from public;
revoke all on function public.search_tasks(text, uuid, boolean, integer) from anon;
grant execute on function public.search_tasks(text, uuid, boolean, integer) to authenticated, service_role;
