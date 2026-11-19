import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { resolveAgentName } from './agentGate.ts'
import { ToolError } from './errors.ts'
import { fileOrApply, parseRequestId } from './ownerRequests.ts'
import { resolveMcpAgentProfileId, resolveProjectByKey, resolveTaskByKeyOrId } from './resolvers.ts'

// Stage 5. The rule lives in SQL (find_possible_duplicates / task_titles_match):
// same title code, or a very similar title without a code. This module reports
// candidates on create/rename and carries out what the agent decides.

export interface PossibleDuplicate {
  key: string
  title: string
  status: string
  similarity: number
  reason: string
  same_epic: boolean
}

export const DUPLICATE_HINT =
  'Possible duplicates found. Decide with resolve_duplicate(keep, other, action): ' +
  '"duplicate" — the new one is a duplicate, archive it (keep = the existing task); ' +
  '"new_version" — the new one replaces the old, archive the old and move its live files and open subtasks (keep = the new task); ' +
  '"not_duplicate" — keep both, the pair is not flagged again.'

/** Candidates for a title in a project (live tasks only, settled pairs skipped). */
export async function possibleDuplicates(
  admin: SupabaseClient,
  projectId: string,
  title: string,
  excludeTaskId: string | null,
  epicId: string | null,
): Promise<PossibleDuplicate[]> {
  const { data, error } = await admin.rpc('find_possible_duplicates', {
    p_project: projectId, p_title: title, p_exclude: excludeTaskId, p_epic: epicId,
  })
  if (error) {
    // A failed check must never block creating or renaming a task.
    console.error('[mcp-server] find_possible_duplicates failed', error.message)
    return []
  }
  return ((data ?? []) as (PossibleDuplicate & { task_id: string })[]).map((d) => ({
    key: d.key, title: d.title, status: d.status, similarity: Math.round(Number(d.similarity) * 100) / 100, reason: d.reason, same_epic: d.same_epic,
  }))
}

/** Adds possible_duplicates + the hint to a create/rename answer when there are any. */
export function withDuplicates<T extends object>(answer: T, dups: PossibleDuplicate[]) {
  return dups.length ? { ...answer, possible_duplicates: dups, duplicate_hint: DUPLICATE_HINT } : answer
}

export async function listPossibleDuplicates(admin: SupabaseClient, args: { project?: string }) {
  if (!args.project?.trim()) throw new ToolError('"project" is required.')
  const project = await resolveProjectByKey(admin, args.project.trim())
  const { data, error } = await admin.rpc('list_possible_duplicates', { p_project: project.id })
  if (error) throw new ToolError(`Failed to list possible duplicates: ${error.message}`)
  const pairs = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    a: { key: r.key_a, title: r.title_a, status: r.status_a },
    b: { key: r.key_b, title: r.title_b, status: r.status_b },
    similarity: Math.round(Number(r.similarity) * 100) / 100,
    reason: r.reason,
    same_epic: r.same_epic,
  }))
  return { project: project.key, count: pairs.length, pairs, ...(pairs.length ? { hint: DUPLICATE_HINT } : {}) }
}

interface ResolveArgs {
  keep?: string
  other?: string
  action?: string
  comment_ids?: unknown
  confirm_data_loss?: boolean
  request_id?: unknown
  agent_name?: string
}

const ACTIONS = ['not_duplicate', 'duplicate', 'new_version']

export async function resolveDuplicate(admin: SupabaseClient, args: ResolveArgs) {
  const agentName = resolveAgentName(args)
  if (!args.keep?.trim() || !args.other?.trim()) throw new ToolError('"keep" and "other" are required (task keys).')
  if (!args.action || !ACTIONS.includes(args.action)) throw new ToolError(`"action" must be one of: ${ACTIONS.join(', ')}.`)
  const commentIds = Array.isArray(args.comment_ids) ? args.comment_ids.map(String) : []
  const requestId = parseRequestId(args.request_id)
  const keep = await resolveTaskByKeyOrId(admin, args.keep.trim())
  const other = await resolveTaskByKeyOrId(admin, args.other.trim())
  const actorId = await resolveMcpAgentProfileId(admin)
  // Exactly the shape resolve_duplicate checks an owner request against.
  const params = { keep: keep.id, other: other.id, action: args.action, comment_ids: commentIds, confirm_data_loss: args.confirm_data_loss === true }

  let answer: Record<string, unknown>
  if (requestId !== undefined) {
    answer = await fileOrApply(admin, {
      type: 'resolve_duplicate', projectId: keep.project_id, taskId: other.id, params, preview: {}, reason: null,
      requestId, agentName, actorId,
    }) as Record<string, unknown>
  } else {
    const { data, error } = await admin.rpc('resolve_duplicate', {
      p_keep: keep.id, p_other: other.id, p_action: args.action, p_comment_ids: commentIds,
      p_confirm_data_loss: params.confirm_data_loss, p_owner_confirmed: false, p_actor: actorId, p_agent: agentName,
    })
    if (error) throw new ToolError(`Not done: ${error.message}. Nothing was changed.`)
    answer = data as Record<string, unknown>

    if (answer.needs_confirmation === 'data') {
      const holds = answer.other_holds as { attachments: { name: string }[]; live_comments: number; open_subtasks: string[] }
      return {
        ...answer,
        message:
          `Nothing was changed. ${other.key} still holds ` +
          [
            holds.attachments.length ? `${holds.attachments.length} live file(s): ${holds.attachments.map((a) => a.name).join(', ')}` : '',
            holds.live_comments ? `${holds.live_comments} live comment(s)` : '',
            holds.open_subtasks.length ? `open subtasks ${holds.open_subtasks.join(', ')}` : '',
          ].filter(Boolean).join('; ') +
          `. "duplicate" would archive them with it. Use action "new_version" to move the files and open subtasks to ${keep.key} ` +
          '(pass comment_ids to move comments too), or repeat with confirm_data_loss: true only if your human confirms they may go to the archive with the task.',
      }
    }

    if (answer.needs_owner_request) {
      const filed = await fileOrApply(admin, {
        type: 'resolve_duplicate', projectId: keep.project_id, taskId: other.id, params,
        preview: {
          task: other.key, keep: keep.key, action: args.action,
          started_by: answer.started_by, started_at: answer.started_at, signal: answer.signal,
          tasks: [{ key: other.key, status: other.status }],
        },
        reason: `${args.action === 'new_version' ? 'new version' : 'duplicate'}: archive ${other.key} (in work), keep ${keep.key}`,
        agentName, actorId,
      })
      return {
        ...filed,
        why: `${other.key} is in work: ${answer.started_by ?? 'someone'} started it on ${answer.started_at} (signal: ${answer.signal}). Archiving it needs an owner's approval.`,
      }
    }
  }

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp', agent_name: agentName, agent_profile_id: actorId, project_id: keep.project_id, task_id: other.id,
    action_type: 'resolve_duplicate', payload: args, result: answer,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)
  return answer
}
