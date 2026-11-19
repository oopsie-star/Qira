import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { displayFilename } from './attachmentPaths.ts'
import { ToolError } from './errors.ts'
import { resolveTaskByKeyOrId } from './resolvers.ts'
import { classifySupersedeLinks, isHiddenTaskStatus, type SupersedeLinkRow } from './visibility.ts'

interface GetTaskArgs {
  task?: string
  include_archived?: boolean
  /** Stage 6: 'history' | 'archived' | 'all_comments'. */
  include?: unknown
  history_limit?: unknown
  history_cursor?: unknown
}

const INCLUDES = ['history', 'archived', 'all_comments'] as const
// Live comments above this many bytes in total are cut to the latest
// COMMENTS_SHOWN unless include: ['all_comments'].
const COMMENTS_BUDGET_BYTES = 15 * 1024
const COMMENTS_SHOWN = 20
const HISTORY_DEFAULT = 20
const HISTORY_MAX = 100
// Field values longer than this are never inlined in history: lengths only.
const HISTORY_VALUE_MAX = 200
const bytes = (text: string | null | undefined) => new TextEncoder().encode(text ?? '').length

interface HistoryEntry {
  source: 'activity' | 'field_change'
  at: string
  [key: string]: unknown
}

export async function getTask(admin: SupabaseClient, args: GetTaskArgs) {
  const ref = args.task?.trim()
  if (!ref) throw new ToolError('"task" is required.')

  const task = await resolveTaskByKeyOrId(admin, ref)

  const requested = Array.isArray(args.include) ? args.include.map(String) : typeof args.include === 'string' ? [args.include] : []
  const unknown = requested.filter((x) => !(INCLUDES as readonly string[]).includes(x))
  if (unknown.length) throw new ToolError(`Unknown "include" value(s): ${unknown.join(', ')}. Use: ${INCLUDES.join(', ')}.`)
  const include = new Set(requested)
  if (args.include_archived === true) include.add('archived')
  const withArchived = include.has('archived')
  const historyLimit = args.history_limit === undefined ? HISTORY_DEFAULT : Number(args.history_limit)
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > HISTORY_MAX) throw new ToolError(`"history_limit" must be 1..${HISTORY_MAX}.`)
  const historyOffset = args.history_cursor === undefined || args.history_cursor === null || args.history_cursor === '' ? 0 : Number(args.history_cursor)
  if (!Number.isInteger(historyOffset) || historyOffset < 0) throw new ToolError('"history_cursor" must be the history_next_cursor of a previous answer.')

  // An archived task takes its comments and attachments out of the working area
  // with it. Asked for without include_archived it answers with what it is and
  // how much is behind it — enough to know it exists and why it is not live,
  // without dumping a dead task's whole contents into the caller's context.
  if (isHiddenTaskStatus(task.status) && !withArchived) {
    const { count, error } = await admin
      .from('task_comments')
      .select('id', { count: 'exact', head: true })
      .eq('task_id', task.id)
    if (error) throw new ToolError(`Failed to count comments: ${error.message}`)
    return {
      key: task.key,
      id: task.id,
      title: task.title,
      status: task.status,
      archived: true,
      archived_comments_count: count ?? 0,
      archived_attachments_count: task.attachments.length + (task.archived_attachments?.length ?? 0),
      note: 'This task is archived. Pass include_archived: true to see its description, comments and attachments.',
    }
  }

  const archivedPaths: string[] = task.archived_attachments ?? []
  const allPaths = [...task.attachments, ...archivedPaths]

  const [commentsRes, activitiesRes, fieldChangesRes, attachmentNotesRes, lastAgentRes, linksRes] = await Promise.all([
    admin
      .from('task_comments')
      .select('id, author_id, body, created_at, edited_at, archived_at, archived_by, archived_by_agent, folded_into_description, archive_reason, comment_type')
      .eq('task_id', task.id)
      .order('created_at'),
    include.has('history')
      ? admin.from('task_activities').select('id, actor_id, activity_type, message, created_at').eq('task_id', task.id).order('created_at')
      : admin.from('task_activities').select('id', { count: 'exact', head: true }).eq('task_id', task.id),
    include.has('history')
      ? admin.from('task_field_changes').select('id, field_name, old_value, new_value, changed_by, changed_at').eq('task_id', task.id).order('changed_at')
      : admin.from('task_field_changes').select('id', { count: 'exact', head: true }).eq('task_id', task.id),
    allPaths.length
      ? admin
          .from('attachment_notes')
          .select('path, original_name, mime_type, size_bytes, md5, archived_at, archived_by, archived_by_agent')
          .eq('project_id', task.project_id)
          .in('path', allPaths)
      : Promise.resolve({ data: [], error: null }),
    admin
      .from('agent_audit_log')
      .select('agent_name, action_type, created_at')
      .eq('task_id', task.id)
      .not('agent_name', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from('task_links')
      .select('link_type, source_task_id, target_task_id, source_task:tasks!task_links_source_task_id_fkey(key, title, status), target_task:tasks!task_links_target_task_id_fkey(key, title, status)')
      .or(`source_task_id.eq.${task.id},target_task_id.eq.${task.id}`),
  ])

  if (commentsRes.error) throw new ToolError(`Failed to load comments: ${commentsRes.error.message}`)
  if (activitiesRes.error) throw new ToolError(`Failed to load activity: ${activitiesRes.error.message}`)
  if (fieldChangesRes.error) throw new ToolError(`Failed to load field history: ${fieldChangesRes.error.message}`)
  if (attachmentNotesRes.error) throw new ToolError(`Failed to load attachment names: ${attachmentNotesRes.error.message}`)
  if (lastAgentRes.error) throw new ToolError(`Failed to load last agent: ${lastAgentRes.error.message}`)
  if (linksRes.error) throw new ToolError(`Failed to load supersede links: ${linksRes.error.message}`)

  const linkRows = (linksRes.data ?? []) as unknown as (SupersedeLinkRow & { link_type: string })[]
  const { supersededBy, supersedes, history: supersedeHistory } = classifySupersedeLinks(
    task.id,
    linkRows.filter((l) => l.link_type === 'supersedes'),
  )
  // Every link, compact: which way it points and where the other end stands.
  const links = linkRows.flatMap((l) => {
    const outgoing = l.source_task_id === task.id
    const other = outgoing ? l.target_task : l.source_task
    return other ? [{ type: l.link_type, direction: outgoing ? 'outgoing' : 'incoming', key: other.key, title: other.title, status: other.status }] : []
  })

  // Live comments are the working area; archived ones (including those folded
  // into the description) are counted, and listed only on request.
  const allComments = commentsRes.data ?? []
  const comments = allComments.filter((c) => !c.archived_at)
  const archivedComments = allComments.filter((c) => c.archived_at)
  const activities = include.has('history') ? (activitiesRes.data ?? []) as { actor_id: string | null; activity_type: string; message: string; created_at: string }[] : []
  const fieldChanges = include.has('history') ? (fieldChangesRes.data ?? []) as { field_name: string; old_value: string | null; new_value: string | null; changed_by: string | null; changed_at: string }[] : []
  const historyTotal = include.has('history') ? activities.length + fieldChanges.length : (activitiesRes.count ?? 0) + (fieldChangesRes.count ?? 0)

  // Long comment threads are cut to the latest ones unless asked for.
  const commentBytes = comments.reduce((sum, c) => sum + bytes(c.body), 0)
  const cutComments = !include.has('all_comments') && comments.length > COMMENTS_SHOWN && commentBytes > COMMENTS_BUDGET_BYTES
  const shownComments = cutComments ? comments.slice(-COMMENTS_SHOWN) : comments
  const noteByPath = new Map((attachmentNotesRes.data ?? []).map((n) => [n.path, n]))
  // Live files only: an archived file is out of `attachments` by construction.
  // size_bytes / md5 are filled from stage 2 on; older uploads get them in the
  // stage 8 data migration, until then null.
  const attachments = task.attachments.map((path) => {
    const note = noteByPath.get(path)
    return {
      path,
      name: displayFilename(path, note?.original_name),
      mime_type: note?.mime_type ?? null,
      size_bytes: note?.size_bytes ?? null,
      md5: note?.md5 ?? null,
    }
  })

  const profileIds = new Set<string>()
  for (const c of shownComments) profileIds.add(c.author_id)
  if (withArchived) {
    for (const c of archivedComments) {
      profileIds.add(c.author_id)
      if (c.archived_by) profileIds.add(c.archived_by)
    }
  }
  for (const a of activities) if (a.actor_id) profileIds.add(a.actor_id)
  for (const f of fieldChanges) if (f.changed_by) profileIds.add(f.changed_by)
  if (task.assignee_id) profileIds.add(task.assignee_id)
  for (const id of task.assignee_ids ?? []) profileIds.add(id)
  if (task.reporter_id) profileIds.add(task.reporter_id)
  if (task.work_started_by) profileIds.add(task.work_started_by)
  if (withArchived) {
    for (const path of archivedPaths) {
      const by = noteByPath.get(path)?.archived_by
      if (by) profileIds.add(by)
    }
  }

  const emailById = new Map<string, string>()
  if (profileIds.size) {
    const { data: profiles, error: profilesError } = await admin
      .from('profiles')
      .select('id, email')
      .in('id', [...profileIds])
    if (profilesError) throw new ToolError(`Failed to resolve profiles: ${profilesError.message}`)
    for (const p of profiles ?? []) emailById.set(p.id, p.email)
  }

  // Newest first, a page at a time. Long values (description, long titles)
  // are never inlined: their lengths, and where the full text lives.
  const allHistory: HistoryEntry[] = [
    ...activities.map((a) => ({
      source: 'activity' as const,
      type: a.activity_type,
      message: a.message,
      actor_email: a.actor_id ? emailById.get(a.actor_id) ?? null : null,
      at: a.created_at,
    })),
    ...fieldChanges.map((f) => {
      const long = f.field_name === 'description' || (f.old_value?.length ?? 0) > HISTORY_VALUE_MAX || (f.new_value?.length ?? 0) > HISTORY_VALUE_MAX
      return {
        source: 'field_change' as const,
        field: f.field_name,
        ...(long
          ? {
              old_length: f.old_value?.length ?? 0,
              new_length: f.new_value?.length ?? 0,
              ...(f.field_name === 'description' || f.field_name === 'title' ? { full_text: 'list_description_versions' } : {}),
            }
          : { old_value: f.old_value, new_value: f.new_value }),
        changed_by_email: f.changed_by ? emailById.get(f.changed_by) ?? null : null,
        at: f.changed_at,
      }
    }),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const history = allHistory.slice(historyOffset, historyOffset + historyLimit)
  const historyNext = historyOffset + historyLimit < allHistory.length ? String(historyOffset + historyLimit) : null

  return {
    key: task.key,
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    issue_type: task.issue_type,
    priority: task.priority,
    assignee_emails: (task.assignee_ids?.length ? task.assignee_ids : task.assignee_id ? [task.assignee_id] : [])
      .map((id) => emailById.get(id) ?? id),
    reporter_email: task.reporter_id ? emailById.get(task.reporter_id) ?? task.reporter_id : null,
    epic_id: task.epic_id,
    sprint_id: task.sprint_id,
    due_date: task.due_date,
    // Stage 4a: whether the ASSIGNEE has started (an agent's in_progress does
    // not count), and so whether the text can still be edited in place.
    work_started: task.work_started_at
      ? {
          at: task.work_started_at,
          by_email: task.work_started_by ? emailById.get(task.work_started_by) ?? task.work_started_by : null,
          signal: task.work_started_signal,
          comment: [...comments].reverse().find((c) => c.comment_type === 'take_in_work')?.body ?? null,
          note: 'Title and description can no longer be edited in place by an agent — see get_edit_policy.',
        }
      : null,
    comments: shownComments.map((c) => ({
      id: c.id,
      author_email: emailById.get(c.author_id) ?? c.author_id,
      body: c.body,
      created_at: c.created_at,
      ...(c.comment_type && c.comment_type !== 'comment' ? { type: c.comment_type } : {}),
      ...(c.edited_at ? { edited_at: c.edited_at } : {}),
    })),
    ...(cutComments
      ? { comments_truncated: { shown: shownComments.length, omitted: comments.length - shownComments.length, hint: "use include: ['all_comments']" } }
      : {}),
    archived_comments_count: archivedComments.length,
    ...(withArchived
      ? {
          archived_comments: archivedComments.map((c) => ({
            id: c.id,
            author_email: emailById.get(c.author_id) ?? c.author_id,
            body: c.body,
            created_at: c.created_at,
            archived_at: c.archived_at,
            archived_by_email: c.archived_by ? emailById.get(c.archived_by) ?? c.archived_by : null,
            archived_by_agent: c.archived_by_agent ?? null,
            folded_into_description: c.folded_into_description === true,
            reason: c.archive_reason ?? null,
          })),
        }
      : {}),
    attachments,
    archived_attachments_count: archivedPaths.length,
    // Asked for explicitly: each archived file with when, by whom and its
    // checksum, so the right one can be told apart and restored.
    ...(withArchived
      ? {
          archived_attachments: archivedPaths.map((path) => {
            const note = noteByPath.get(path)
            return {
              path,
              name: displayFilename(path, note?.original_name),
              mime_type: note?.mime_type ?? null,
              archived_at: note?.archived_at ?? null,
              archived_by_email: note?.archived_by ? emailById.get(note.archived_by) ?? note.archived_by : null,
              archived_by_agent: note?.archived_by_agent ?? null,
              size_bytes: note?.size_bytes ?? null,
              md5: note?.md5 ?? null,
            }
          }),
        }
      : {}),
    last_ai_agent: lastAgentRes.data
      ? { agent_name: lastAgentRes.data.agent_name, action_type: lastAgentRes.data.action_type, at: lastAgentRes.data.created_at }
      : null,
    ...(isHiddenTaskStatus(task.status) ? { archived: true } : {}),
    superseded_by: supersededBy,
    supersedes,
    // Links whose other end is archived: kept as a record, but they no longer
    // say anything about whether THIS task is current.
    supersede_history: supersedeHistory,
    links,
    history_count: historyTotal,
    ...(include.has('history') ? { history, history_total: historyTotal, history_next_cursor: historyNext } : {}),
  }
}
