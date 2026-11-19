import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { checkCrossAgentConflict, resolveAgentName } from './agentGate.ts'
import { editRefusal, lineDiff } from './editPolicy.ts'
import { fileOrApply, parseRequestId } from './ownerRequests.ts'
import { possibleDuplicates, withDuplicates } from './duplicates.ts'
import { ToolError } from './errors.ts'
import {
  resolveEpicByKeyOrTitle,
  resolveMcpAgentProfileId,
  resolveProfileByEmail,
  resolveSprintByName,
  resolveTaskByKeyOrId,
} from './resolvers.ts'
import { ISSUE_PRIORITIES, type IssuePriority } from '../types.ts'

interface UpdateTaskArgs {
  task?: string
  title?: string
  description?: string
  priority?: string
  due_date?: string
  assignee_email?: string
  epic?: string
  sprint?: string
  labels?: string[]
  request_id?: unknown
  agent_name?: string
  confirmed_cross_agent?: boolean
}

export async function updateTask(admin: SupabaseClient, args: UpdateTaskArgs) {
  const ref = args.task?.trim()
  const agentName = resolveAgentName(args)
  if (!ref) throw new ToolError('"task" is required.')

  if (args.priority && !ISSUE_PRIORITIES.includes(args.priority as IssuePriority)) {
    throw new ToolError(`Invalid priority "${args.priority}" — must be one of: ${ISSUE_PRIORITIES.join(', ')}`)
  }

  const task = await resolveTaskByKeyOrId(admin, ref)
  await checkCrossAgentConflict(admin, { type: 'task', id: task.id, label: task.key }, agentName, Boolean(args.confirmed_cross_agent))

  const fields: Record<string, unknown> = {}
  const textChange = args.title !== undefined || args.description !== undefined
  if (args.priority !== undefined) fields.priority = args.priority
  if (args.due_date !== undefined) fields.due_date = args.due_date
  if (args.labels !== undefined) fields.labels = args.labels
  if (args.assignee_email !== undefined) {
    fields.assignee_id = (await resolveProfileByEmail(admin, args.assignee_email)).id
  }
  if (args.epic !== undefined) {
    fields.epic_id = args.epic ? (await resolveEpicByKeyOrTitle(admin, task.project_id, args.epic)).id : null
  }
  if (args.sprint !== undefined) {
    fields.sprint_id = args.sprint ? (await resolveSprintByName(admin, task.project_id, args.sprint)).id : null
  }

  if (Object.keys(fields).length === 0 && !textChange) {
    throw new ToolError('No fields to update — provide at least one of: title, description, priority, due_date, assignee_email, epic, sprint, labels.')
  }

  const reporterId = await resolveMcpAgentProfileId(admin)

  // Title and description go through the edit policy (stage 4a): in place
  // while the assignee has not started, refused once they have. They go
  // first, so a refusal leaves the whole call unapplied — never half of it.
  // Nothing ever creates a new task here.
  let editMode: string | undefined
  const requestId = parseRequestId(args.request_id)
  if (requestId !== undefined && !textChange) {
    throw new ToolError('"request_id" is for the title/description edit it was filed for — send the same title/description with it.')
  }
  if (textChange) {
    // Exactly the fields sent: the repeat call with request_id must match.
    const textParams: Record<string, string> = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
    }
    if (requestId !== undefined) {
      await fileOrApply(admin, {
        type: 'edit_in_place', projectId: task.project_id, taskId: task.id, params: textParams, preview: {},
        reason: null, requestId, agentName, actorId: reporterId,
      })
      editMode = 'approved'
    } else {
      const { data: edit, error: editError } = await admin.rpc('edit_task_text', {
        p_task: task.id,
        p_title: args.title ?? null,
        p_description: args.description ?? null,
        p_actor: reporterId,
        p_agent: agentName,
      })
      if (editError) {
        // Stage 4b: an agent's edit of a started task becomes a request to
        // the owners. Nothing — not even the other fields — is applied now.
        if ((editError.hint ?? '').startsWith('EDIT_POLICY:owner_approval_required')) {
          return await fileOrApply(admin, {
            type: 'edit_in_place', projectId: task.project_id, taskId: task.id, params: textParams,
            preview: {
              task: task.key,
              ...(args.title !== undefined && args.title !== task.title ? { title_from: task.title, title_to: args.title } : {}),
              ...(args.description !== undefined ? { description_diff: lineDiff(task.description ?? '', args.description) } : {}),
              refused_because: editError.message,
            },
            reason: `update_task on ${task.key}`, agentName, actorId: reporterId,
          })
        }
        throw editRefusal(editError) ?? new ToolError(`Failed to update task: ${editError.message}`)
      }
      editMode = (edit as { edit_mode?: string } | null)?.edit_mode ?? 'in_place'
    }
  }

  let data: Record<string, unknown> | null = null
  if (Object.keys(fields).length) {
    const res = await admin.from('tasks').update(fields).eq('id', task.id).select('id, key, title, status, priority').single()
    if (res.error) throw new ToolError(`Failed to update task: ${res.error.message}`)
    data = res.data
  } else {
    const res = await admin.from('tasks').select('id, key, title, status, priority').eq('id', task.id).single()
    if (res.error) throw new ToolError(`Failed to read the task back: ${res.error.message}`)
    data = res.data
  }
  const changed = [...(args.title !== undefined ? ['title'] : []), ...(args.description !== undefined ? ['description'] : []), ...Object.keys(fields)]
  const { error: activityError } = await admin.from('task_activities').insert({
    project_id: task.project_id,
    task_id: task.id,
    actor_id: reporterId,
    activity_type: 'task_updated',
    message: `Updated: ${changed.join(', ')}`,
  })
  if (activityError) {
    console.error('[mcp-server] Failed to record task_updated activity', activityError.message)
  }

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: reporterId,
    project_id: task.project_id,
    task_id: task.id,
    action_type: 'update_task',
    payload: args,
    result: { ...data, ...(editMode ? { edit_mode: editMode } : {}) },
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)

  const answer = { ...data, ...(editMode ? { edit_mode: editMode } : {}) }
  // Stage 5: a new title is checked against live tasks of the project.
  if (args.title !== undefined && args.title !== task.title) {
    return withDuplicates(answer, await possibleDuplicates(admin, task.project_id, args.title, task.id, task.epic_id ?? null))
  }
  return answer
}
