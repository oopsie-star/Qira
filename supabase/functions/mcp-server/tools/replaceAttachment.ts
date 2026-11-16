import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { resolveAgentName } from './agentGate.ts'
import { setArchived } from './archiveAttachment.ts'
import { attachEpicFile } from './attachEpicFile.ts'
import { epicIdFromPath, getFilename, projectIdFromPath, sprintIdFromPath, taskIdFromPath } from './attachmentPaths.ts'
import { attachSprintFile } from './attachSprintFile.ts'
import { attachTaskFile } from './attachTaskFile.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId } from './resolvers.ts'
import { auditableUploadArgs, type UploadArgs } from './uploadPipeline.ts'

interface ReplaceAttachmentArgs extends UploadArgs {
  old_path?: string
  filename?: string
  agent_name?: string
  confirmed_cross_agent?: boolean
}

// "Here is a new version of this file": upload the new one to wherever the old
// one is attached, then archive the old one. The everyday case that used to end
// in a task holding one live ZIP and nineteen copies renamed "УСТАРЕЛО".
//
// Upload first, archive second: if the upload fails the old file is untouched
// and still live. The reverse order could leave a task with no current file.
export async function replaceAttachment(admin: SupabaseClient, args: ReplaceAttachmentArgs) {
  const oldPath = args.old_path?.trim()
  const agentName = resolveAgentName(args)
  if (!oldPath) throw new ToolError('"old_path" is required — the path of the attachment being replaced, from get_task/get_project.')

  const projectId = projectIdFromPath(oldPath)
  if (!projectId) throw new ToolError(`"${oldPath}" doesn't look like a valid attachment path.`)

  const taskId = taskIdFromPath(oldPath)
  const epicId = epicIdFromPath(oldPath)
  const sprintId = sprintIdFromPath(oldPath)
  const table = taskId ? 'tasks' : epicId ? 'epics' : sprintId ? 'sprints' : null
  const ownerId = taskId ?? epicId ?? sprintId
  if (!table || !ownerId) throw new ToolError(`"${oldPath}" is not a task, epic or sprint attachment.`)

  // Only a live file can be replaced. An archived one already is "the old
  // version"; one attached nowhere means the path is wrong.
  let { data: owner, error: ownerError } = await admin
    .from(table)
    .select('id, attachments, archived_attachments')
    .eq('id', ownerId)
    .maybeSingle()
  if (ownerError) throw new ToolError(`Failed to look up the file's owner: ${ownerError.message}`)
  // A file moved to a new revision (create_task_revision) keeps its path, which
  // still names the old task: find the task that holds it now.
  let currentTaskId = taskId
  if (taskId && !owner?.attachments?.includes(oldPath)) {
    const { data: holder } = await admin
      .from('tasks')
      .select('id, attachments, archived_attachments')
      .contains('attachments', [oldPath])
      .limit(1)
      .maybeSingle()
    if (holder) {
      owner = holder
      currentTaskId = holder.id as string
    }
  }
  if (!owner?.attachments?.includes(oldPath)) {
    if (owner?.archived_attachments?.includes(oldPath)) {
      throw new ToolError(`"${oldPath}" is already archived. Attach the new file with attach_*_file instead.`)
    }
    throw new ToolError(`"${oldPath}" is not a current attachment of its ${table.slice(0, -1)}.`)
  }

  // The new version keeps the old file's name unless the caller gives one.
  let filename = args.filename?.trim()
  if (!filename) {
    const { data: note } = await admin
      .from('attachment_notes')
      .select('original_name')
      .eq('project_id', projectId)
      .eq('path', oldPath)
      .maybeSingle()
    filename = note?.original_name || getFilename(oldPath)
  }

  const upload: UploadArgs = {
    content_base64: args.content_base64,
    file: args.file,
    mime_type: args.mime_type,
    expected_md5: args.expected_md5,
    chunk_index: args.chunk_index,
    total_chunks: args.total_chunks,
    upload_id: args.upload_id,
    chunk_md5: args.chunk_md5,
  }
  const common = { ...upload, filename, agent_name: args.agent_name, confirmed_cross_agent: args.confirmed_cross_agent }

  let uploaded: Record<string, unknown>
  if (taskId) {
    uploaded = await attachTaskFile(admin, { ...common, task: currentTaskId as string })
  } else {
    const { data: project, error: projectError } = await admin.from('projects').select('key').eq('id', projectId).maybeSingle()
    if (projectError || !project) throw new ToolError(`Failed to look up the file's project: ${projectError?.message ?? 'not found'}`)
    uploaded = epicId
      ? await attachEpicFile(admin, { ...common, project: project.key, epic: epicId })
      : await attachSprintFile(admin, { ...common, project: project.key, sprint: sprintId as string })
  }

  if (uploaded.pending) {
    return { ...uploaded, replaces: oldPath, note: `${uploaded.note} ${oldPath} is archived once the new file is complete.` }
  }

  const reporterId = await resolveMcpAgentProfileId(admin)
  try {
    await setArchived(admin, oldPath, true, reporterId, agentName)
  } catch (err) {
    // The new file IS attached at this point; say so, and how to finish.
    throw new ToolError(
      `The new file was attached at ${uploaded.path}, but archiving the old one failed: ${err instanceof Error ? err.message : String(err)}. Call archive_attachment on ${oldPath} to finish.`,
    )
  }

  const result = { ...uploaded, replaced: oldPath, old_archived: true }

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: reporterId,
    project_id: projectId,
    task_id: currentTaskId,
    epic_id: epicId,
    sprint_id: sprintId,
    action_type: 'replace_attachment',
    payload: auditableUploadArgs(args as Record<string, unknown>),
    result,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)

  return result
}
