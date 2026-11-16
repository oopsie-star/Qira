import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { resolveAgentName } from './agentGate.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId, resolveTaskByKeyOrId } from './resolvers.ts'

interface UnlinkSupersedesArgs {
  task?: string
  other?: string
  agent_name?: string
}

// The undo for mark_task_superseded. There was no way to take a supersedes link
// back, so one created by mistake — or by the old automatic revision trigger —
// went on marking a live task obsolete for good.
//
// Takes the two tasks in either order: callers think in terms of "these two",
// not in terms of which end the link happens to start from. Ungated, same as
// mark_task_superseded: both are reversible by calling the other.
export async function unlinkSupersedes(admin: SupabaseClient, args: UnlinkSupersedesArgs) {
  const ref = args.task?.trim()
  const otherRef = args.other?.trim()
  const agentName = resolveAgentName(args)
  if (!ref) throw new ToolError('"task" is required.')
  if (!otherRef) throw new ToolError('"other" is required.')

  const task = await resolveTaskByKeyOrId(admin, ref)
  const other = await resolveTaskByKeyOrId(admin, otherRef)
  if (task.id === other.id) throw new ToolError('"task" and "other" are the same task.')

  const { data: removed, error } = await admin
    .from('task_links')
    .delete()
    .eq('link_type', 'supersedes')
    .or(
      `and(source_task_id.eq.${task.id},target_task_id.eq.${other.id}),` +
        `and(source_task_id.eq.${other.id},target_task_id.eq.${task.id})`,
    )
    .select('source_task_id, target_task_id')
  if (error) throw new ToolError(`Failed to remove the link: ${error.message}`)
  if (!removed?.length) throw new ToolError(`There is no supersedes link between ${task.key} and ${other.key}.`)

  const reporterId = await resolveMcpAgentProfileId(admin)

  // Recorded on both tasks: either one can be the one someone opens next and
  // wonders where its "obsolete" badge went.
  const { error: activityError } = await admin.from('task_activities').insert([
    { project_id: task.project_id, task_id: task.id, actor_id: reporterId, activity_type: 'task_updated', message: `Supersede link with ${other.key} removed` },
    { project_id: other.project_id, task_id: other.id, actor_id: reporterId, activity_type: 'task_updated', message: `Supersede link with ${task.key} removed` },
  ])
  if (activityError) console.error('[mcp-server] Failed to record task_updated activity', activityError.message)

  const result = { task_key: task.key, other_key: other.key, removed: removed.length }

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: reporterId,
    project_id: task.project_id,
    task_id: task.id,
    action_type: 'unlink_supersedes',
    payload: args,
    result,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)

  return result
}
