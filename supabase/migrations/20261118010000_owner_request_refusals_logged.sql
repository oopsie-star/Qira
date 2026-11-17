-- Fix for 20261118000000_owner_requests.sql: refused attempts were not logged.
--
-- apply_owner_request recorded a 'refused' event and then raised an
-- exception — which rolled the event back with everything else, so the audit
-- log never showed a refused attempt (pending, rejected, used, expired, other
-- parameters, not an owner). Found by the stage 4b checks in TEST.
--
-- It now records the event and RETURNS the refusal ({refused: true, status,
-- why}); the MCP server turns that into the error the agent sees. Nothing is
-- done on a refusal, exactly as before. The function is otherwise unchanged.

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
