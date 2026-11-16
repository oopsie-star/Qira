// Port of src/lib/attachments.ts's pure path/name helpers — that module can't
// be imported directly (Vite/browser module graph, different tsconfig from
// this Deno function), so the logic is duplicated here. Keep in sync if the
// frontend's storage-path convention ever changes.
import { ToolError } from './errors.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UPLOAD_TIMESTAMP_PREFIX_RE = /^\d{13}-/

// Supabase Storage rejects object keys containing most non-ASCII characters
// ("Invalid key") — the true name (any script) is recorded separately in
// attachment_notes.original_name for display, same as the frontend does.
export function safeFilename(name: string): string {
  return name.replace(/[^\w.\-() ]+/g, '_')
}

export function getFilename(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(UPLOAD_TIMESTAMP_PREFIX_RE, '')
}

export function displayFilename(path: string, originalName?: string | null): string {
  return originalName || getFilename(path)
}

// Task attachment paths (both the user-upload and Jira-import shapes) put the
// task id at position 1. Epic/sprint paths have a literal 'epics'/'sprints'
// there instead, which never matches the UUID shape, so this returns null.
export function taskIdFromPath(path: string): string | null {
  const taskId = path.split('/')[1]
  return taskId && UUID_RE.test(taskId) ? taskId : null
}

export function projectIdFromPath(path: string): string | null {
  const projectId = path.split('/')[0]
  return projectId && UUID_RE.test(projectId) ? projectId : null
}

// Epic/sprint attachment paths put a literal 'epics'/'sprints' token at
// position 1 and the entity id at position 2 (see attachEpicFile.ts /
// attachSprintFile.ts for the path shape these mirror).
export function epicIdFromPath(path: string): string | null {
  const parts = path.split('/')
  return parts[1] === 'epics' && parts[2] && UUID_RE.test(parts[2]) ? parts[2] : null
}

export function sprintIdFromPath(path: string): string | null {
  const parts = path.split('/')
  return parts[1] === 'sprints' && parts[2] && UUID_RE.test(parts[2]) ? parts[2] : null
}

// Supabase Edge Functions cap memory at 256MB per invocation; base64 adds
// ~33% on top of the original file size before it's even decoded, plus JSON
// parse overhead for the surrounding tool-call payload. 20MB keeps a wide
// safety margin rather than chasing that ceiling exactly.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export function decodeAttachmentBase64(base64: string): Uint8Array {
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    throw new ToolError('content_base64 is not valid base64.')
  }
  if (binary.length > MAX_ATTACHMENT_BYTES) {
    throw new ToolError(
      `Attachment is ${Math.round(binary.length / 1024 / 1024)}MB, which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit for files sent through MCP.`,
    )
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ChatGPT's Apps SDK can't have the model author raw file bytes as base64 text
// (it often doesn't even have byte-level access to what the user uploaded —
// images get turned into vision tokens before the model ever sees them). It
// instead declares a top-level input field in _meta["openai/fileParams"] and
// hands the tool a { download_url, file_id, mime_type?, file_name? } object at
// call time; the server is expected to fetch the bytes itself. Claude Code
// still sends content_base64 directly (it has real filesystem access), so
// both paths stay supported — whichever the caller provides.
export interface AttachmentFileRef {
  download_url?: string
  file_id?: string
  mime_type?: string
  file_name?: string
}

// The only places a download_url may point. Taken from production, not from
// documentation: every ChatGPT download_url in agent_audit_log is an Azure Blob
// account named oaisdmntpr<region> — denmarkeast, northeu and westus so far. A
// list of exact hosts would break on the next region, so this is a pattern;
// "*.blob.core.windows.net" on its own would let anyone's storage account in.
// Matched against the whole hostname, so a lookalike such as
// oaisdmntprx.blob.core.windows.net.evil.com does not pass.
export const ALLOWED_DOWNLOAD_HOSTS: readonly RegExp[] = [
  /^oaisdmntpr[a-z0-9]{1,14}\.blob\.core\.windows\.net$/,
]

const MAX_DOWNLOAD_REDIRECTS = 3

function tooLarge(bytes: number): ToolError {
  return new ToolError(
    `Attachment is ${Math.round(bytes / 1024 / 1024)}MB, which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit for files sent through MCP.`,
  )
}

/** Parses a download URL and refuses anything outside ALLOWED_DOWNLOAD_HOSTS. */
export function assertAllowedDownloadUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError('download_url is not a valid URL.')
  }
  if (url.protocol !== 'https:') throw new ToolError(`download_url must use https, not ${url.protocol.replace(':', '')}.`)
  if (url.username || url.password) throw new ToolError('download_url must not carry credentials.')
  if (url.port && url.port !== '443') throw new ToolError(`download_url must not name a port (got ${url.port}).`)
  const host = url.hostname.toLowerCase()
  if (!ALLOWED_DOWNLOAD_HOSTS.some((pattern) => pattern.test(host))) {
    // Names the host on purpose: if OpenAI starts serving files from somewhere
    // new, this message is what says which entry to add.
    throw new ToolError(`download_url host "${host}" is not an allowed file host.`)
  }
  return url
}

// The server fetches whatever download_url it is given, so before this it would
// fetch any address at all — internal ones included — and read the whole body
// into memory before looking at its size. Now: only allowed hosts, redirects
// followed by hand and re-checked at every hop, and the size enforced before
// and during the read rather than after it.
export async function fetchAttachmentBytes(downloadUrl: string, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  let url = assertAllowedDownloadUrl(downloadUrl)
  let response: Response

  for (let hop = 0; ; hop++) {
    try {
      // manual: an automatic redirect would land wherever the server says,
      // skipping the host check entirely.
      response = await fetchFn(url.toString(), { redirect: 'manual' })
    } catch (err) {
      throw new ToolError(`Failed to fetch file from download_url: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (response.status < 300 || response.status >= 400) break

    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new ToolError(`download_url answered HTTP ${response.status} with no Location to follow.`)
    if (hop >= MAX_DOWNLOAD_REDIRECTS) throw new ToolError(`download_url redirected more than ${MAX_DOWNLOAD_REDIRECTS} times.`)
    url = assertAllowedDownloadUrl(new URL(location, url).toString())
  }

  if (!response.ok) {
    await response.body?.cancel()
    throw new ToolError(`Failed to fetch file from download_url: HTTP ${response.status}`)
  }

  // A declared size over the limit is refused without reading a byte of body.
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel()
    throw tooLarge(declared)
  }
  if (!response.body) return new Uint8Array(0)

  // Content-Length can be missing or wrong, so the limit is enforced again while
  // reading: the stream is cut the moment it goes over, instead of buffering a
  // file of any size first.
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_ATTACHMENT_BYTES) {
      await reader.cancel()
      throw tooLarge(total)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function resolveAttachmentBytes(args: { content_base64?: string; file?: AttachmentFileRef }): Promise<Uint8Array> {
  if (args.file?.download_url) return fetchAttachmentBytes(args.file.download_url)
  if (args.content_base64) return decodeAttachmentBase64(args.content_base64)
  throw new ToolError('Provide either "content_base64" or "file" (a { download_url, file_id } reference, e.g. ChatGPT\'s openai/fileParams).')
}
