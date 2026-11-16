import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { checkCrossAgentConflict, resolveAgentName } from './agentGate.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId, resolveTaskByKeyOrId } from './resolvers.ts'
import { TASK_STATUSES, type TaskStatus } from '../types.ts'

interface UpdateTaskStatusArgs {
  task?: string
  status?: string
  comment?: string
  agent_name?: string
  confirmed_cross_agent?: boolean
}

export async function updateTaskStatus(admin: SupabaseClient, args: UpdateTaskStatusArgs) {
  const ref = args.task?.trim()
  const agentName = resolveAgentName(args)
  if (!ref) throw new ToolError('"task" is required.')
  if (!args.status || !TASK_STATUSES.includes(args.status as TaskStatus)) {
    throw new ToolError(`Invalid status "${args.status}" — must be one of: ${TASK_STATUSES.join(', ')}`)
  }

  const task = await resolveTaskByKeyOrId(admin, ref)
  await checkCrossAgentConflict(admin, { type: 'task', id: task.id, label: task.key }, agentName, Boolean(args.confirmed_cross_agent))

  // Back to To do from in progress always says why (stage 4a): the reason is
  // posted as a comment, and the work stays marked as started.
  if (args.status === 'todo' && task.status === 'in_progress') {
    const comment = args.comment?.trim() ?? ''
    if (comment.length < 15) {
      throw new ToolError(`Moving ${task.key} back to To do needs "comment": why, in at least 15 characters. It is posted on the task.`)
    }
    const actorId = await resolveMcpAgentProfileId(admin)
    const { error } = await admin.rpc('return_to_todo', { p_task: task.id, p_comment: comment, p_actor: actorId })
    if (error) throw new ToolError(`Failed to move ${task.key} back to To do: ${error.message}`)
    const { error: auditError } = await admin.from('agent_audit_log').insert({
      agent_type: 'mcp',
      agent_name: agentName,
      agent_profile_id: actorId,
      project_id: task.project_id,
      task_id: task.id,
      action_type: 'update_task_status',
      payload: args,
      result: { key: task.key, status: 'todo' },
    })
    if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)
    return { key: task.key, status: 'todo' }
  }

  const { data, error } = await admin
    .from('tasks')
    .update({ status: args.status })
    .eq('id', task.id)
    .select('id, key, status')
    .single()

  if (error) {
    // guard_universal_task_status (see 20260704000000_universal_task_multi_assignee.sql)
    // requires is_admin()/can_manage_project(), both of which read auth.uid()
    // — always NULL under this service-role connection, so status changes on
    // tasks with 2+ assignee_ids always fail here. Known v1 limitation.
    if (error.message.includes('universal_task_status')) {
      throw new ToolError(
        `Cannot change status of ${task.key} — it has multiple assignees, and the database blocks non-admin ` +
          'status changes on shared tasks even for this trusted service connection (no authenticated user context).',
      )
    }
    throw new ToolError(`Failed to update task status: ${error.message}`)
  }

  const actorId = await resolveMcpAgentProfileId(admin)
  const { error: activityError } = await admin.from('task_activities').insert({
    project_id: task.project_id,
    task_id: task.id,
    actor_id: actorId,
    activity_type: 'task_updated',
    message: `Status changed to ${args.status}`,
  })
  if (activityError) {
    console.error('[mcp-server] Failed to record task_updated activity', activityError.message)
  }

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: actorId,
    project_id: task.project_id,
    task_id: task.id,
    action_type: 'update_task_status',
    payload: args,
    result: data,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)

  return {
    key: data.key,
    status: data.status,
    // An agent moving a task to in progress does not start the work: only the
    // assignee does, with "Take into work" in the app.
    ...(args.status === 'in_progress' ? { note: 'Status only — the work counts as started when the assignee takes it into work in Qira.' } : {}),
  }
}
