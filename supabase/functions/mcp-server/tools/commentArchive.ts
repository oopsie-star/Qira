import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { type AgentName, checkCrossAgentConflict, resolveAgentName } from './agentGate.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId } from './resolvers.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface CommentRow {
  id: string
  task_id: string
  project_id: string
  author_id: string
  archived_at: string | null
}

interface CommentToolArgs {
  comment?: string
  agent_name?: string
  confirmed_cross_agent?: boolean
}

interface ArchiveCommentArgs extends CommentToolArgs {
  folded_into_description?: boolean
  /** Shown to the comment's author in their notification and in the archive. */
  reason?: string
}

interface UpdateCommentArgs extends CommentToolArgs {
  body?: string
}

export interface CommentArchiveOutcome {
  comment_id: string
  task_id: string
  archived: boolean
  folded_into_description: boolean
  reason?: string | null
  changed: boolean
}

async function loadComment(admin: SupabaseClient, ref: string | undefined) {
  const id = ref?.trim()
  if (!id) throw new ToolError('"comment" is required — the comment id, from get_task\'s comments list.')
  if (!UUID_RE.test(id)) throw new ToolError(`"${id}" is not a comment id. get_task lists each comment with its id.`)

  const { data, error } = await admin
    .from('task_comments')
    .select('id, task_id, project_id, author_id, archived_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new ToolError(`Failed to look up comment ${id}: ${error.message}`)
  if (!data) throw new ToolError(`Comment ${id} does not exist.`)
  const comment = data as CommentRow

  const { data: task, error: taskError } = await admin
    .from('tasks')
    .select('key')
    .eq('id', comment.task_id)
    .maybeSingle()
  if (taskError) throw new ToolError(`Failed to look up the comment's task: ${taskError.message}`)
  return { comment, taskKey: (task?.key as string | undefined) ?? comment.task_id }
}

async function recordAudit(
  admin: SupabaseClient,
  row: { agentName: AgentName; reporterId: string; comment: CommentRow; action: string; payload: unknown; result: unknown },
) {
  const { error } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: row.agentName,
    agent_profile_id: row.reporterId,
    project_id: row.comment.project_id,
    task_id: row.comment.task_id,
    action_type: row.action,
    payload: row.payload,
    result: row.result,
  })
  if (error) console.error('[mcp-server] Failed to record agent_audit_log', error.message)
}

async function recordActivity(admin: SupabaseClient, comment: CommentRow, actorId: string, message: string) {
  const { error } = await admin.from('task_activities').insert({
    project_id: comment.project_id,
    task_id: comment.task_id,
    actor_id: actorId,
    activity_type: 'task_updated',
    message,
  })
  if (error) console.error('[mcp-server] Failed to record task_updated activity', error.message)
}

async function archiveOrRestore(admin: SupabaseClient, args: ArchiveCommentArgs, archived: boolean) {
  const agentName = resolveAgentName(args)
  const { comment, taskKey } = await loadComment(admin, args.comment)
  // Taking a comment out of someone else's work is a change to that work: the
  // same gate as add_comment and the attachment tools.
  await checkCrossAgentConflict(admin, { type: 'task', id: comment.task_id, label: taskKey }, agentName, Boolean(args.confirmed_cross_agent))

  const reporterId = await resolveMcpAgentProfileId(admin)
  const folded = archived && args.folded_into_description === true
  const { data, error } = await admin.rpc('set_comment_archived', {
    p_comment: comment.id,
    p_archived: archived,
    p_folded: folded,
    p_actor: reporterId,
    p_agent: agentName,
    p_reason: archived && typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 500) : null,
  })
  if (error) throw new ToolError(`Failed to ${archived ? 'archive' : 'restore'} comment ${comment.id}: ${error.message}`)
  const outcome = data as CommentArchiveOutcome

  if (outcome.changed) {
    const what = !archived ? 'Restored a comment' : folded ? 'Archived a comment folded into the description' : 'Archived a comment'
    await recordActivity(admin, comment, reporterId, what)
  }
  await recordAudit(admin, {
    agentName,
    reporterId,
    comment,
    action: archived ? 'archive_comment' : 'restore_comment',
    payload: args,
    result: outcome,
  })
  return { ...outcome, task_key: taskKey }
}

export function archiveComment(admin: SupabaseClient, args: ArchiveCommentArgs) {
  return archiveOrRestore(admin, args, true)
}

export function restoreComment(admin: SupabaseClient, args: ArchiveCommentArgs) {
  return archiveOrRestore(admin, args, false)
}

/**
 * Rewrites an agent's own comment. A person's comment is theirs: an agent adds
 * a new comment, or archives one it has folded into the description, but does
 * not put words in someone's mouth. Every edit keeps the previous text in
 * task_comment_edits (written by the database, whatever route the edit takes).
 */
export async function updateComment(admin: SupabaseClient, args: UpdateCommentArgs) {
  const agentName = resolveAgentName(args)
  const body = args.body?.trim()
  if (!body) throw new ToolError('"body" is required — the full new text of the comment.')
  const { comment, taskKey } = await loadComment(admin, args.comment)
  const confirmed = Boolean(args.confirmed_cross_agent)

  const reporterId = await resolveMcpAgentProfileId(admin)
  if (comment.author_id !== reporterId) {
    throw new ToolError(
      `Comment ${comment.id} on ${taskKey} was written by a person, not by an AI agent. Agents do not edit people's comments — add a new comment instead, or ask that person to edit theirs.`,
    )
  }
  if (comment.archived_at) {
    throw new ToolError(`Comment ${comment.id} is archived. Restore it with restore_comment before editing, or add a new comment.`)
  }

  // Which agent wrote it: claude and chatgpt share one profile, so the audit log
  // is the only record. A comment another agent wrote is that agent's words.
  const { data: written, error: writtenError } = await admin
    .from('agent_audit_log')
    .select('agent_name')
    .eq('action_type', 'add_comment')
    .eq('result->>id', comment.id)
    .limit(1)
    .maybeSingle()
  if (writtenError) throw new ToolError(`Failed to check who wrote the comment: ${writtenError.message}`)
  if (written?.agent_name && written.agent_name !== agentName && !confirmed) {
    throw new ToolError(
      `Comment ${comment.id} was written by ${written.agent_name}. Get explicit confirmation from the human operator before rewriting another agent's comment, then retry with confirmed_cross_agent: true.`,
    )
  }
  await checkCrossAgentConflict(admin, { type: 'task', id: comment.task_id, label: taskKey }, agentName, confirmed)

  const { data, error } = await admin.rpc('update_comment_body', {
    p_comment: comment.id,
    p_body: body,
    p_actor: reporterId,
    p_agent: agentName,
  })
  if (error) throw new ToolError(`Failed to update comment ${comment.id}: ${error.message}`)
  const outcome = data as { comment_id: string; task_id: string; changed: boolean }

  if (outcome.changed) await recordActivity(admin, comment, reporterId, 'Edited a comment')
  await recordAudit(admin, { agentName, reporterId, comment, action: 'update_comment', payload: args, result: outcome })
  return { ...outcome, task_key: taskKey }
}
