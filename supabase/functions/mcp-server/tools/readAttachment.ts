import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { displayFilename, projectIdFromPath } from './attachmentPaths.ts'
import { ToolError } from './errors.ts'
import { resolveMcpAgentProfileId } from './resolvers.ts'

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

interface ReadAttachmentArgs {
  path?: string
  agent_name?: string
}

interface Gate {
  ok: boolean
  path?: string
  bucket?: 'attachments' | 'task-attachments'
  name?: string | null
  mime_type?: string | null
  size_bytes?: number | null
}

/**
 * Reads a file through the same check as the app and share links
 * (public.file_gate): the file must be attached to something live right now.
 * Archived files are not readable through MCP. Every attempt is logged in
 * file_access_log (channel "mcp").
 */
export async function readAttachment(admin: SupabaseClient, args: ReadAttachmentArgs) {
  const path = args.path?.trim()
  if (!path) throw new ToolError('"path" is required.')
  if (!projectIdFromPath(path)) throw new ToolError(`"${path}" doesn't look like a valid attachment path.`)

  const actorId = await resolveMcpAgentProfileId(admin)
  const { data, error } = await admin.rpc('file_gate', {
    p_path: path,
    p_channel: 'mcp',
    p_purpose: 'view',
    p_actor: actorId,
    p_agent: typeof args.agent_name === 'string' ? args.agent_name : null,
    p_share_token: null,
    p_range: null,
    p_ip: null,
    p_user_agent: 'mcp-server',
  })
  if (error) throw new ToolError(`Failed to check access to the attachment: ${error.message}`)
  const gate = data as Gate
  if (!gate?.ok || !gate.bucket) {
    // Same answer whatever the reason, as the file gateway gives.
    throw new ToolError(`"${path}" is not available: no live task, epic, sprint or comment has it attached (archived files cannot be read through MCP).`)
  }
  if (typeof gate.size_bytes === 'number' && gate.size_bytes > MAX_ATTACHMENT_BYTES) throw tooBig(gate.size_bytes)

  const { data: blob, error: downloadError } = await admin.storage.from(gate.bucket).download(path)
  if (downloadError || !blob) throw new ToolError(`Failed to download attachment: ${downloadError?.message ?? 'no data'}`)

  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw tooBig(bytes.length)

  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))

  return {
    path,
    name: displayFilename(path, gate.name),
    mime_type: gate.mime_type ?? (blob.type || null),
    content_base64: btoa(binary),
  }
}

function tooBig(size: number) {
  return new ToolError(
    `Attachment is ${Math.round(size / 1024 / 1024)}MB, which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit for files returned through MCP.`,
  )
}
