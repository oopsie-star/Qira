import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { checkCrossAgentConflict, resolveAgentName } from './agentGate.ts'
import { type AttachmentFileRef, safeFilename } from './attachmentPaths.ts'
import { auditableUploadArgs, receiveUpload } from './uploadPipeline.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId, resolveTaskByKeyOrId } from './resolvers.ts'

interface AttachTaskFileArgs {
  task?: string
  filename?: string
  content_base64?: string
  file?: AttachmentFileRef
  mime_type?: string
  expected_md5?: string
  chunk_index?: number
  total_chunks?: number
  upload_id?: string
  chunk_md5?: string
  agent_name?: string
  confirmed_cross_agent?: boolean
}

export async function attachTaskFile(admin: SupabaseClient, args: AttachTaskFileArgs) {
  const ref = args.task?.trim()
  const filename = args.filename?.trim()
  const agentName = resolveAgentName(args)
  if (!ref) throw new ToolError('"task" is required.')
  if (!filename) throw new ToolError('"filename" is required.')

  const task = await resolveTaskByKeyOrId(admin, ref)
  await checkCrossAgentConflict(admin, { type: 'task', id: task.id, label: task.key }, agentName, Boolean(args.confirmed_cross_agent))

  // Whole file, or one chunk of it. A chunk that does not complete the upload
  // stops here with a receipt: nothing is attached until the last one lands and
  // the assembled file passes its checksum.
  const received = await receiveUpload(admin, args, `task:${task.id}`, filename)
  if (!received.complete) {
    return {
      pending: true,
      upload_id: received.upload_id,
      received_chunks: received.received,
      total_chunks: received.total_chunks,
      note: 'Chunk stored. Send the remaining chunks with this upload_id; the file is attached when the last one arrives.',
    }
  }
  const { bytes, size, md5 } = received

  const reporterId = await resolveMcpAgentProfileId(admin)
  const mimeType = args.mime_type || args.file?.mime_type

  const path = `${task.project_id}/${task.id}/${reporterId}/${Date.now()}-${safeFilename(filename)}`
  const { error: uploadError } = await admin.storage
    .from('attachments')
    .upload(path, bytes, { contentType: mimeType || undefined })
  if (uploadError) throw new ToolError(`Failed to upload file: ${uploadError.message}`)

  const { error: updateError } = await admin
    .from('tasks')
    .update({ attachments: [...task.attachments, path] })
    .eq('id', task.id)
  if (updateError) throw new ToolError(`Uploaded, but failed to attach to task: ${updateError.message}`)

  const { error: noteError } = await admin
    .from('attachment_notes')
    .upsert(
      { project_id: task.project_id, path, original_name: filename, mime_type: mimeType ?? null, size_bytes: size, md5 },
      { onConflict: 'project_id,path' },
    )
  if (noteError) console.error('[mcp-server] Failed to record attachment_notes', noteError.message)

  const { error: activityError } = await admin.from('task_activities').insert({
    project_id: task.project_id,
    task_id: task.id,
    actor_id: reporterId,
    activity_type: 'task_updated',
    message: `Attached file: ${filename}`,
  })
  if (activityError) {
    console.error('[mcp-server] Failed to record task_updated activity', activityError.message)
  }

  const result = { path, name: filename, task_key: task.key, size, md5 }

  const { error: auditError } = await admin.from('agent_audit_log').insert({
    agent_type: 'mcp',
    agent_name: agentName,
    agent_profile_id: reporterId,
    project_id: task.project_id,
    task_id: task.id,
    action_type: 'attach_task_file',
    payload: auditableUploadArgs(args as Record<string, unknown>),
    result,
  })
  if (auditError) console.error('[mcp-server] Failed to record agent_audit_log', auditError.message)

  return result
}
