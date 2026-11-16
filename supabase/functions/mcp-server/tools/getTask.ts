import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { displayFilename } from './attachmentPaths.ts'
import { ToolError } from './errors.ts'
import { resolveTaskByKeyOrId } from './resolvers.ts'
import { classifySupersedeLinks, isHiddenTaskStatus, type SupersedeLinkRow } from './visibility.ts'

interface GetTaskArgs {
  task?: string
  include_archived?: boolean
}

interface HistoryEntry {
  source: 'activity' | 'field_change'
  at: string
  [key: string]: unknown
}

export async function getTask(admin: SupabaseClient, args: GetTaskArgs) {
  const ref = args.task?.trim()
  if (!ref) throw new ToolError('"task" is required.')

  const task = await resolveTaskByKeyOrId(admin, ref)

  // An archived task takes its comments and attachments out of the working area
  // with it. Asked for without include_archived it answers with what it is and
  // how much is behind it — enough to know it exists and why it is not live,
  // without dumping a dead task's whole contents into the caller's context.
  if (isHiddenTaskStatus(task.status) && args.include_archived !== true) {
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
      .select('id, author_id, body, created_at, edited_at, archived_at, archived_by, archived_by_agent, folded_into_description')
      .eq('task_id', task.id)
      .order('created_at'),
    admin
      .from('task_activities')
      .select('id, actor_id, activity_type, message, created_at')
      .eq('task_id', task.id)
      .order('created_at'),
    admin
      .from('task_field_changes')
      .select('id, field_name, old_value, new_value, changed_by, changed_at')
      .eq('task_id', task.id)
      .order('changed_at'),
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
      .select('source_task_id, target_task_id, source_task:tasks!task_links_source_task_id_fkey(key, title, status), target_task:tasks!task_links_target_task_id_fkey(key, title, status)')
      .eq('link_type', 'supersedes')
      .or(`source_task_id.eq.${task.id},target_task_id.eq.${task.id}`),
  ])

  if (commentsRes.error) throw new ToolError(`Failed to load comments: ${commentsRes.error.message}`)
  if (activitiesRes.error) throw new ToolError(`Failed to load activity: ${activitiesRes.error.message}`)
  if (fieldChangesRes.error) throw new ToolError(`Failed to load field history: ${fieldChangesRes.error.message}`)
  if (attachmentNotesRes.error) throw new ToolError(`Failed to load attachment names: ${attachmentNotesRes.error.message}`)
  if (lastAgentRes.error) throw new ToolError(`Failed to load last agent: ${lastAgentRes.error.message}`)
  if (linksRes.error) throw new ToolError(`Failed to load supersede links: ${linksRes.error.message}`)

  const { supersededBy, supersedes, history: supersedeHistory } = classifySupersedeLinks(
    task.id,
    (linksRes.data ?? []) as unknown as SupersedeLinkRow[],
  )

  // Live comments are the working area; archived ones (including those folded
  // into the description) are counted, and listed only on request.
  const allComments = commentsRes.data ?? []
  const comments = allComments.filter((c) => !c.archived_at)
  const archivedComments = allComments.filter((c) => c.archived_at)
  const activities = activitiesRes.data ?? []
  const fieldChanges = fieldChangesRes.data ?? []
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
  for (const c of comments) profileIds.add(c.author_id)
  if (args.include_archived === true) {
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
  if (args.include_archived === true) {
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

  const history: HistoryEntry[] = [
    ...activities.map((a) => ({
      source: 'activity' as const,
      type: a.activity_type,
      message: a.message,
      actor_email: a.actor_id ? emailById.get(a.actor_id) ?? null : null,
      at: a.created_at,
    })),
    ...fieldChanges.map((f) => ({
      source: 'field_change' as const,
      field: f.field_name,
      old_value: f.old_value,
      new_value: f.new_value,
      changed_by_email: f.changed_by ? emailById.get(f.changed_by) ?? null : null,
      at: f.changed_at,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at))

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
    comments: comments.map((c) => ({
      id: c.id,
      author_email: emailById.get(c.author_id) ?? c.author_id,
      body: c.body,
      created_at: c.created_at,
      ...(c.edited_at ? { edited_at: c.edited_at } : {}),
    })),
    archived_comments_count: archivedComments.length,
    ...(args.include_archived === true
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
          })),
        }
      : {}),
    attachments,
    archived_attachments_count: archivedPaths.length,
    // Asked for explicitly: each archived file with when, by whom and its
    // checksum, so the right one can be told apart and restored.
    ...(args.include_archived === true
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
    history,
  }
}
