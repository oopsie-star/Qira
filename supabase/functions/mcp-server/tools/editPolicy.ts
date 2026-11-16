import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { checkCrossAgentConflict, resolveAgentName } from './agentGate.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId, resolveTaskByKeyOrId } from './resolvers.ts'

// Stage 4a. The policy itself lives in the database (task_edit_policy and the
// tasks_enforce_edit_policy trigger) so the app, the assistant and MCP cannot
// disagree; these tools ask it, and turn its refusals into something an agent
// shows its human instead of retrying or working around.

export interface EditPolicy {
  task_id: string
  key: string
  work_started: boolean
  started_at: string | null
  started_by: string | null
  started_by_name: string | null
  signal: 'take_in_work' | 'implicit' | 'legacy' | null
  owner: boolean
  edit_mode: 'in_place' | 'owner_approval_required' | 'rejected'
}

/** What an agent must do with a refused edit: show it, and offer these. */
export const EDIT_REFUSAL_INSTRUCTIONS =
  'Do not retry and do not work around it. Show this refusal to the human you work with, and offer them the two options: ' +
  '(1) create_task_revision — a new revision of the task with the new text (the old one is archived); or ' +
  '(2) a project owner edits the task in place themselves in the Qira app.'

export async function fetchEditPolicy(admin: SupabaseClient, taskId: string): Promise<EditPolicy> {
  const { data, error } = await admin.rpc('task_edit_policy', { p_task: taskId })
  if (error) throw new ToolError(`Failed to read the edit policy: ${error.message}`)
  return data as EditPolicy
}

async function emailOf(admin: SupabaseClient, profileId: string | null): Promise<string | null> {
  if (!profileId) return null
  const { data } = await admin.from('profiles').select('email').eq('id', profileId).maybeSingle()
  return (data?.email as string | undefined) ?? null
}

export async function getEditPolicy(admin: SupabaseClient, args: { task?: string }) {
  const ref = args.task?.trim()
  if (!ref) throw new ToolError('"task" is required.')
  const task = await resolveTaskByKeyOrId(admin, ref)
  const policy = await fetchEditPolicy(admin, task.id)
  return {
    task: policy.key,
    work_started: policy.work_started,
    started_at: policy.started_at,
    started_by: await emailOf(admin, policy.started_by),
    signal: policy.signal,
    edit_mode: policy.edit_mode,
    ...(policy.edit_mode === 'in_place'
      ? {}
      : { note: `The title and description of ${policy.key} cannot be edited in place by an agent. ${EDIT_REFUSAL_INSTRUCTIONS}` }),
  }
}

/**
 * The database refuses a started task's text with hint "EDIT_POLICY:<mode> — …".
 * Returns the refusal for the agent, or null when the error is something else.
 */
export function editRefusal(error: { message: string; hint?: string | null }): ToolError | null {
  const hint = error.hint ?? ''
  const match = hint.match(/^EDIT_POLICY:(\w+)/)
  if (!match) return null
  return new ToolError(
    `Refused (edit_mode: ${match[1]}). ${error.message} ${EDIT_REFUSAL_INSTRUCTIONS} Nothing was changed.`,
  )
}

// ── create_task_revision ─────────────────────────────────────────────────────

interface CreateRevisionArgs {
  task?: string
  title?: string
  description?: string
  attachments?: string[] | 'all'
  comments?: string[] | 'all'
  reason?: string
  agent_name?: string
  confirmed_cross_agent?: boolean
}

export async function createTaskRevision(admin: SupabaseClient, args: CreateRevisionArgs) {
  const ref = args.task?.trim()
  const agentName = resolveAgentName(args)
  if (!ref) throw new ToolError('"task" is required.')
  const reason = args.reason?.trim()
  if (!reason) throw new ToolError('"reason" is required — one sentence on why a new revision is needed; the assignee sees it.')

  const task = await resolveTaskByKeyOrId(admin, ref)
  await checkCrossAgentConflict(admin, { type: 'task', id: task.id, label: task.key }, agentName, Boolean(args.confirmed_cross_agent))

  const files = args.attachments === 'all' ? task.attachments : (args.attachments ?? [])
  if (!Array.isArray(files)) throw new ToolError('"attachments" must be a list of paths or "all".')

  let commentIds: string[] = []
  if (args.comments === 'all') {
    const { data, error } = await admin.from('task_comments').select('id').eq('task_id', task.id).is('archived_at', null)
    if (error) throw new ToolError(`Failed to list comments: ${error.message}`)
    commentIds = (data ?? []).map((c) => c.id as string)
  } else if (Array.isArray(args.comments)) {
    commentIds = args.comments
  } else if (args.comments !== undefined) {
    throw new ToolError('"comments" must be a list of comment ids or "all".')
  }

  const actorId = await resolveMcpAgentProfileId(admin)
  const { data, error } = await admin.rpc('create_task_revision', {
    p_task: task.id,
    p_title: args.title ?? null,
    p_description: args.description ?? null,
    p_attachments: files,
    p_comment_ids: commentIds,
    p_reason: reason,
    p_actor: actorId,
    p_agent: agentName,
  })
  if (error) throw new ToolError(`Failed to create a revision of ${task.key}: ${error.message}`)
  const result = data as Record<string, unknown>

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: actorId,
    project_id: task.project_id,
    task_id: result.new_task_id,
    action_type: 'create_task_revision',
    payload: args,
    result,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)

  return {
    new_task: result.new_key,
    archived_task: result.old_key,
    moved_attachments: result.moved_attachments,
    moved_comments: result.moved_comments,
  }
}

// ── Description versions ─────────────────────────────────────────────────────

interface VersionRow {
  version: number
  title: string
  description: string | null
  edited_by: string | null
  edited_by_agent: string | null
  edit_mode: string
  created_at: string
}

/** A minimal line diff (LCS): '+ line' / '- line', unchanged lines left out. */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i++]}`)
    } else {
      out.push(`+ ${b[j++]}`)
    }
  }
  while (i < n) out.push(`- ${a[i++]}`)
  while (j < m) out.push(`+ ${b[j++]}`)
  return out
}

export async function listDescriptionVersions(admin: SupabaseClient, args: { task?: string; version?: number }) {
  const ref = args.task?.trim()
  if (!ref) throw new ToolError('"task" is required.')
  const task = await resolveTaskByKeyOrId(admin, ref)

  const { data, error } = await admin
    .from('task_description_versions')
    .select('version, title, description, edited_by, edited_by_agent, edit_mode, created_at')
    .eq('task_id', task.id)
    .order('version')
  if (error) throw new ToolError(`Failed to load versions: ${error.message}`)
  const rows = ((data ?? []) as VersionRow[]).sort((x, y) => x.version - y.version)

  if (args.version !== undefined) {
    const row = rows.find((r) => r.version === Number(args.version))
    if (!row) throw new ToolError(`${task.key} has no version ${args.version}.`)
    return { task: task.key, version: row.version, title: row.title, description: row.description, created_at: row.created_at }
  }

  const ids = [...new Set(rows.map((r) => r.edited_by).filter((id): id is string => Boolean(id)))]
  const emails = new Map<string, string>()
  if (ids.length) {
    const { data: profiles } = await admin.from('profiles').select('id, email').in('id', ids)
    for (const p of profiles ?? []) emails.set(p.id as string, p.email as string)
  }

  return {
    task: task.key,
    note: rows.length
      ? 'Each version shows what changed from the one before. Pass version to get one version\'s full text; restore_description_version brings it back.'
      : 'No edits recorded yet — the current text is the only version.',
    versions: rows.map((row, index) => {
      const prev = rows[index - 1]
      return {
        version: row.version,
        at: row.created_at,
        edited_by: row.edited_by ? emails.get(row.edited_by) ?? row.edited_by : null,
        agent: row.edited_by_agent,
        edit_mode: row.edit_mode,
        ...(prev && prev.title !== row.title ? { title_from: prev.title, title_to: row.title } : {}),
        ...(prev ? { description_diff: lineDiff(prev.description ?? '', row.description ?? '') } : { title: row.title }),
      }
    }),
  }
}

export async function restoreDescriptionVersion(
  admin: SupabaseClient,
  args: { task?: string; version?: number; agent_name?: string; confirmed_cross_agent?: boolean },
) {
  const ref = args.task?.trim()
  const agentName = resolveAgentName(args)
  if (!ref) throw new ToolError('"task" is required.')
  if (args.version === undefined) throw new ToolError('"version" is required — from list_description_versions.')
  const task = await resolveTaskByKeyOrId(admin, ref)
  await checkCrossAgentConflict(admin, { type: 'task', id: task.id, label: task.key }, agentName, Boolean(args.confirmed_cross_agent))

  const { data: row, error } = await admin
    .from('task_description_versions')
    .select('version, title, description')
    .eq('task_id', task.id)
    .eq('version', Number(args.version))
    .maybeSingle()
  if (error) throw new ToolError(`Failed to load version ${args.version}: ${error.message}`)
  if (!row) throw new ToolError(`${task.key} has no version ${args.version}.`)

  const actorId = await resolveMcpAgentProfileId(admin)
  const { error: editError } = await admin.rpc('edit_task_text', {
    p_task: task.id,
    p_title: row.title,
    p_description: row.description ?? '',
    p_actor: actorId,
    p_agent: agentName,
    p_mode: 'restore',
  })
  if (editError) throw editRefusal(editError) ?? new ToolError(`Failed to restore version ${args.version}: ${editError.message}`)

  const result = { task: task.key, restored_version: row.version, edit_mode: 'in_place' }
  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: actorId,
    project_id: task.project_id,
    task_id: task.id,
    action_type: 'restore_description_version',
    payload: args,
    result,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)
  return result
}
