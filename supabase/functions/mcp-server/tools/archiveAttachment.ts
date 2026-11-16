import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { checkCrossAgentConflict, resolveAgentName } from './agentGate.ts'
import { epicIdFromPath, getFilename, projectIdFromPath, sprintIdFromPath, taskIdFromPath } from './attachmentPaths.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId } from './resolvers.ts'

interface ArchiveAttachmentArgs {
  path?: string
  agent_name?: string
  confirmed_cross_agent?: boolean
}

export interface ArchiveOutcome {
  path: string
  entity: 'task' | 'epic' | 'sprint'
  entity_id: string
  archived: boolean
  changed: boolean
}

/**
 * Archive or restore through set_attachment_archived — the one route a file has
 * between `attachments` and `archived_attachments`, shared with the app. The
 * function finds the owning task/epic/sprint itself, so this only has to name
 * who is acting.
 */
export async function setArchived(
  admin: SupabaseClient,
  path: string,
  archived: boolean,
  actorId: string,
  agentName: string,
): Promise<ArchiveOutcome> {
  const { data, error } = await admin.rpc('set_attachment_archived', {
    p_path: path,
    p_archived: archived,
    p_actor: actorId,
    p_agent: agentName,
  })
  if (error) throw new ToolError(`Failed to ${archived ? 'archive' : 'restore'} "${path}": ${error.message}`)
  return data as ArchiveOutcome
}

async function archiveOrRestore(admin: SupabaseClient, args: ArchiveAttachmentArgs, archived: boolean) {
  const path = args.path?.trim()
  const agentName = resolveAgentName(args)
  if (!path) throw new ToolError('"path" is required — use the path from get_task/get_project\'s attachments list.')

  const projectId = projectIdFromPath(path)
  if (!projectId) throw new ToolError(`"${path}" doesn't look like a valid attachment path.`)

  // Same gate as rename_attachment: changing what is attached to someone else's
  // work is a change to that work.
  const taskId = taskIdFromPath(path)
  const epicId = epicIdFromPath(path)
  const sprintId = sprintIdFromPath(path)
  const confirmed = Boolean(args.confirmed_cross_agent)
  if (taskId) await checkCrossAgentConflict(admin, { type: 'task', id: taskId, label: path }, agentName, confirmed)
  else if (epicId) await checkCrossAgentConflict(admin, { type: 'epic', id: epicId, label: path }, agentName, confirmed)
  else if (sprintId) await checkCrossAgentConflict(admin, { type: 'sprint', id: sprintId, label: path }, agentName, confirmed)

  const reporterId = await resolveMcpAgentProfileId(admin)
  const outcome = await setArchived(admin, path, archived, reporterId, agentName)

  if (outcome.changed && outcome.entity === 'task') {
    const { error: activityError } = await admin.from('task_activities').insert({
      project_id: projectId,
      task_id: outcome.entity_id,
      actor_id: reporterId,
      activity_type: 'task_updated',
      message: `${archived ? 'Archived' : 'Restored'} file: ${getFilename(path)}`,
    })
    if (activityError) console.error('[mcp-server] Failed to record task_updated activity', activityError.message)
  }

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: reporterId,
    project_id: projectId,
    task_id: outcome.entity === 'task' ? outcome.entity_id : null,
    epic_id: outcome.entity === 'epic' ? outcome.entity_id : null,
    sprint_id: outcome.entity === 'sprint' ? outcome.entity_id : null,
    action_type: archived ? 'archive_attachment' : 'restore_attachment',
    payload: args,
    result: outcome,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)

  return outcome
}

export function archiveAttachment(admin: SupabaseClient, args: ArchiveAttachmentArgs) {
  return archiveOrRestore(admin, args, true)
}

export function restoreAttachment(admin: SupabaseClient, args: ArchiveAttachmentArgs) {
  return archiveOrRestore(admin, args, false)
}
