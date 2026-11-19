import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { checkCrossAgentConflict, resolveAgentName, type AgentName } from './agentGate.ts'
import { displayFilename, epicIdFromPath, projectIdFromPath, sprintIdFromPath, storageBucket, taskIdFromPath } from './attachmentPaths.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId, resolveProjectByKey, resolveTaskByKeyOrId } from './resolvers.ts'

// Stage 4b. What only an owner may allow goes through a request: the first
// call files it and the owners are notified; an owner approves or rejects it
// in Qira; the agent repeats the SAME call with request_id, and only then it
// happens — once. The database (apply_owner_request) checks everything; this
// module only builds the request and reports back.

export type OwnerRequestType = 'edit_in_place' | 'delete_attachment' | 'purge_task' | 'purge_trash' | 'resolve_duplicate'

export interface FileOrApply {
  type: OwnerRequestType
  projectId: string
  taskId: string | null
  /** Exactly what will be done. The repeat call must produce the same. */
  params: Record<string, unknown>
  /** What the owner reads: a diff, or the list of what goes for good. */
  preview: Record<string, unknown>
  reason: string | null
  requestId?: number
  agentName: AgentName
  actorId: string
}

export interface AwaitingApproval {
  status: 'awaiting_owner_approval'
  request_id: number
  message: string
}

const TYPE_LABEL: Record<OwnerRequestType, string> = {
  edit_in_place: 'an in-place edit of a started task',
  delete_attachment: 'deleting a file for good',
  purge_task: 'deleting a task for good',
  purge_trash: 'emptying the trash',
  resolve_duplicate: 'archiving a task in work as a duplicate',
}

export function parseRequestId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new ToolError(`"request_id" must be the request number Qira gave you, got "${value}".`)
  return n
}

/**
 * Without requestId: files the request (or finds the open identical one) and
 * returns what to tell the human. With it: applies the approved request and
 * returns what the database did.
 */
export async function fileOrApply(admin: SupabaseClient, req: FileOrApply): Promise<AwaitingApproval | Record<string, unknown>> {
  if (req.requestId !== undefined) {
    const { data, error } = await admin.rpc('apply_owner_request', {
      p_request: req.requestId,
      p_type: req.type,
      p_task: req.taskId,
      p_params: req.params,
      p_actor: req.actorId,
      p_agent: req.agentName,
    })
    if (error) throw new ToolError(`Not done: ${error.message}. Nothing was changed.`)
    // A refusal is an answer, not an error, so the database can log it.
    const answer = data as { refused?: boolean; status?: string; why?: string } & Record<string, unknown>
    if (answer?.refused) {
      throw new ToolError(
        answer.status === 'pending'
          ? `Request №${req.requestId} is still waiting for an owner's decision in Qira. Tell your human, and repeat this call once it is approved.`
          : `Not done: ${answer.why}. Nothing was changed.`,
      )
    }
    return answer
  }

  const { data, error } = await admin.rpc('create_owner_request', {
    p_type: req.type,
    p_project: req.projectId,
    p_task: req.taskId,
    p_params: req.params,
    p_preview: req.preview,
    p_reason: req.reason,
    p_actor: req.actorId,
    p_agent: req.agentName,
  })
  if (error) throw new ToolError(`Failed to file the request: ${error.message}`)
  const filed = data as { request_id: number; status: string; existing: boolean }
  const approved = filed.status === 'approved'
  return {
    status: 'awaiting_owner_approval',
    request_id: filed.request_id,
    message: approved
      ? `Request №${filed.request_id} for ${TYPE_LABEL[req.type]} is already approved. Repeat this exact call with request_id: ${filed.request_id} to carry it out.`
      : `Waiting for permission in Qira: request №${filed.request_id} for ${TYPE_LABEL[req.type]}${filed.existing ? ' (already filed)' : ''}. ` +
        `The project's owners have been notified. Tell your human; once an owner approves it, repeat this exact call with request_id: ${filed.request_id}. Nothing has been changed yet.`,
  }
}

export async function getOwnerRequest(admin: SupabaseClient, args: { request_id?: unknown }) {
  const id = parseRequestId(args.request_id)
  if (id === undefined) throw new ToolError('"request_id" is required.')
  const { data, error } = await admin
    .from('owner_requests')
    .select('id, request_type, status, reason, preview, decided_by, decided_at, decision_note, used_at, expires_at, created_at, task_id')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new ToolError(`Failed to read request №${id}: ${error.message}`)
  if (!data) throw new ToolError(`Request №${id} does not exist.`)
  let decidedBy: string | null = null
  if (data.decided_by) {
    const { data: p } = await admin.from('profiles').select('email').eq('id', data.decided_by).maybeSingle()
    decidedBy = (p?.email as string | undefined) ?? data.decided_by
  }
  const expired = !data.used_at && new Date(data.expires_at as string).getTime() <= Date.now()
  return {
    request_id: data.id,
    type: data.request_type,
    status: expired && data.status !== 'used' ? 'expired' : data.status,
    reason: data.reason,
    decided_by: decidedBy,
    decided_at: data.decided_at,
    decision_note: data.decision_note,
    used_at: data.used_at,
    expires_at: data.expires_at,
    preview: data.preview,
  }
}

async function audit(admin: SupabaseClient, row: Record<string, unknown>) {
  const { error } = await admin.from('agent_audit_log').insert({ agent_type: 'mcp', ...row })
  if (error) console.error('[mcp-server] Failed to record agent_audit_log', error.message)
}

/** Removes storage objects after the database let go of them; reports what it could not. */
async function removeFiles(admin: SupabaseClient, paths: string[]) {
  const failed: string[] = []
  let removed = 0
  const byBucket = new Map<string, string[]>()
  for (const path of paths) {
    const bucket = storageBucket(path)
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path])
  }
  for (const [bucket, list] of byBucket) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100)
      // Count what storage says it removed: a path it did not find is not
      // an error there, but it was not removed either.
      const { data, error } = await admin.storage.from(bucket).remove(chunk)
      if (error) {
        failed.push(...chunk)
        continue
      }
      const gone = new Set((data ?? []).map((o: { name: string }) => o.name))
      for (const p of chunk) gone.has(p) ? removed++ : failed.push(p)
    }
  }
  return { removed, failed }
}

// ── delete_attachment ────────────────────────────────────────────────────────

interface DeleteAttachmentArgs {
  path?: string
  reason?: string
  request_id?: unknown
  agent_name?: string
  confirmed_cross_agent?: boolean
}

export async function deleteAttachment(admin: SupabaseClient, args: DeleteAttachmentArgs) {
  const agentName = resolveAgentName(args)
  const path = args.path?.trim()
  if (!path) throw new ToolError('"path" is required — from get_task (include_archived for archived files).')
  const projectId = projectIdFromPath(path)
  if (!projectId) throw new ToolError(`"${path}" doesn't look like a valid attachment path.`)
  const requestId = parseRequestId(args.request_id)
  if (requestId === undefined && !args.reason?.trim()) {
    throw new ToolError('"reason" is required — why this file must go for good rather than to the archive; the owner reads it.')
  }

  const taskId = taskIdFromPath(path)
  const epicId = epicIdFromPath(path)
  const sprintId = sprintIdFromPath(path)
  const confirmed = Boolean(args.confirmed_cross_agent)
  if (taskId) await checkCrossAgentConflict(admin, { type: 'task', id: taskId, label: path }, agentName, confirmed)
  else if (epicId) await checkCrossAgentConflict(admin, { type: 'epic', id: epicId, label: path }, agentName, confirmed)
  else if (sprintId) await checkCrossAgentConflict(admin, { type: 'sprint', id: sprintId, label: path }, agentName, confirmed)

  const { data: note } = await admin
    .from('attachment_notes')
    .select('original_name, size_bytes, md5, archived_at')
    .eq('project_id', projectId)
    .eq('path', path)
    .maybeSingle()

  const actorId = await resolveMcpAgentProfileId(admin)
  const outcome = await fileOrApply(admin, {
    type: 'delete_attachment',
    projectId,
    taskId,
    params: { path },
    preview: {
      files: [{ path, name: displayFilename(path, note?.original_name), size_bytes: note?.size_bytes ?? null, md5: note?.md5 ?? null, archived: Boolean(note?.archived_at) }],
    },
    reason: args.reason?.trim() ?? null,
    requestId,
    agentName,
    actorId,
  })
  if ((outcome as AwaitingApproval).status === 'awaiting_owner_approval') return outcome

  const files = await removeFiles(admin, ((outcome as { paths?: string[] }).paths) ?? [path])
  const result = { request_id: requestId, deleted: path, storage: files }
  await audit(admin, { agent_name: agentName, agent_profile_id: actorId, project_id: projectId, task_id: taskId, epic_id: epicId, sprint_id: sprintId, action_type: 'delete_attachment', payload: args, result })
  return result
}

// ── purge_task / purge_trash ─────────────────────────────────────────────────

const TRASH = ['archived', 'deleted']

/** The task and every task under it: [{id, key, status}], parent first. */
async function subtree(admin: SupabaseClient, rootId: string) {
  const out: { id: string; key: string; status: string }[] = []
  let frontier = [rootId]
  const { data: root } = await admin.from('tasks').select('id, key, status').eq('id', rootId).maybeSingle()
  if (root) out.push(root as never)
  while (frontier.length) {
    const { data, error } = await admin.from('tasks').select('id, key, status').in('parent_task_id', frontier)
    if (error) throw new ToolError(`Failed to read subtasks: ${error.message}`)
    const rows = (data ?? []) as { id: string; key: string; status: string }[]
    out.push(...rows)
    frontier = rows.map((r) => r.id)
  }
  return out
}

interface PurgeTaskArgs {
  task?: string
  reason?: string
  request_id?: unknown
  agent_name?: string
  confirmed_cross_agent?: boolean
}

export async function purgeTask(admin: SupabaseClient, args: PurgeTaskArgs) {
  const agentName = resolveAgentName(args)
  const ref = args.task?.trim()
  if (!ref) throw new ToolError('"task" is required.')
  const requestId = parseRequestId(args.request_id)
  if (requestId === undefined && !args.reason?.trim()) throw new ToolError('"reason" is required — why this task must go for good; the owner reads it.')

  const task = await resolveTaskByKeyOrId(admin, ref)
  if (!TRASH.includes(task.status)) {
    throw new ToolError(`${task.key} is ${task.status}. Only an archived or deleted task can be deleted for good — archive it first.`)
  }
  await checkCrossAgentConflict(admin, { type: 'task', id: task.id, label: task.key }, agentName, Boolean(args.confirmed_cross_agent))

  const tree = await subtree(admin, task.id)
  const live = tree.filter((t) => !TRASH.includes(t.status))
  if (live.length) {
    throw new ToolError(`${task.key} has live subtasks (${live.map((t) => t.key).join(', ')}): they would be deleted with it. Move or archive them first.`)
  }

  const actorId = await resolveMcpAgentProfileId(admin)
  const outcome = await fileOrApply(admin, {
    type: 'purge_task',
    projectId: task.project_id,
    taskId: task.id,
    params: { task_ids: [task.id] },
    preview: { tasks: tree.map((t) => ({ key: t.key, status: t.status })), files: task.attachments.length + (task.archived_attachments?.length ?? 0) },
    reason: args.reason?.trim() ?? null,
    requestId,
    agentName,
    actorId,
  })
  if ((outcome as AwaitingApproval).status === 'awaiting_owner_approval') return outcome

  const done = outcome as { deleted?: string[]; skipped?: unknown[]; paths?: string[] }
  const files = await removeFiles(admin, done.paths ?? [])
  const result = { request_id: requestId, deleted: done.deleted ?? [], skipped: done.skipped ?? [], storage: files }
  await audit(admin, { agent_name: agentName, agent_profile_id: actorId, project_id: task.project_id, task_id: null, action_type: 'purge_task', payload: args, result })
  return result
}

interface PurgeTrashArgs {
  project?: string
  reason?: string
  request_id?: unknown
  agent_name?: string
}

export async function purgeTrash(admin: SupabaseClient, args: PurgeTrashArgs) {
  const agentName = resolveAgentName(args)
  const key = args.project?.trim()
  if (!key) throw new ToolError('"project" is required — the project key.')
  const requestId = parseRequestId(args.request_id)
  if (requestId === undefined && !args.reason?.trim()) throw new ToolError('"reason" is required — why the trash must be emptied; the owner reads it.')
  const project = await resolveProjectByKey(admin, key)

  let params: Record<string, unknown>
  let preview: Record<string, unknown> = {}
  if (requestId !== undefined) {
    // The list was fixed when the request was filed; the repeat call carries
    // it out as approved, not whatever is in the trash now.
    const { data, error } = await admin.from('owner_requests').select('params').eq('id', requestId).maybeSingle()
    if (error) throw new ToolError(`Failed to read request №${requestId}: ${error.message}`)
    if (!data) throw new ToolError(`Request №${requestId} does not exist.`)
    params = data.params as Record<string, unknown>
  } else {
    const { data, error } = await admin.from('tasks').select('id, key, status').eq('project_id', project.id).in('status', TRASH)
    if (error) throw new ToolError(`Failed to read the trash: ${error.message}`)
    const rows = ((data ?? []) as { id: string; key: string; status: string }[]).sort((a, b) => a.id.localeCompare(b.id))
    if (!rows.length) throw new ToolError(`The trash of ${project.key} is empty.`)
    params = { project_id: project.id, task_ids: rows.map((r) => r.id) }
    preview = { count: rows.length, tasks: rows.map((r) => ({ key: r.key, status: r.status })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })) }
  }

  const actorId = await resolveMcpAgentProfileId(admin)
  const outcome = await fileOrApply(admin, {
    type: 'purge_trash',
    projectId: project.id,
    taskId: null,
    params,
    preview,
    reason: args.reason?.trim() ?? null,
    requestId,
    agentName,
    actorId,
  })
  if ((outcome as AwaitingApproval).status === 'awaiting_owner_approval') return outcome

  const done = outcome as { deleted?: string[]; skipped?: unknown[]; paths?: string[] }
  const files = await removeFiles(admin, done.paths ?? [])
  const result = { request_id: requestId, deleted: (done.deleted ?? []).length, skipped: done.skipped ?? [], storage: files }
  await audit(admin, { agent_name: agentName, agent_profile_id: actorId, project_id: project.id, action_type: 'purge_trash', payload: args, result })
  return result
}
