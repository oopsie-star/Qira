import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'
import { crypto as stdCrypto } from 'https://deno.land/std@0.224.0/crypto/mod.ts'
import { encodeHex } from 'https://deno.land/std@0.224.0/encoding/hex.ts'

import {
  type AttachmentFileRef,
  decodeAttachmentBase64,
  MAX_ATTACHMENT_BYTES,
  resolveAttachmentBytes,
} from './attachmentPaths.ts'
import { ToolError } from './errors.ts'

// Everything an upload tool accepts about the file itself, whichever way it
// arrives: whole (content_base64 or a ChatGPT `file` reference) or in chunks.
export interface UploadArgs {
  content_base64?: string
  file?: AttachmentFileRef
  mime_type?: string
  expected_md5?: string
  chunk_index?: number
  total_chunks?: number
  upload_id?: string
  chunk_md5?: string
}

export type ReceivedUpload =
  | { complete: true; bytes: Uint8Array; size: number; md5: string }
  | { complete: false; upload_id: string; received: number[]; total_chunks: number }

const BUCKET = 'attachments'
// Not a project id, so no user-facing storage policy ever matches it: chunks are
// visible to the service role only.
const UPLOADS_PREFIX = '_uploads'
export const MAX_CHUNKS = 64
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MD5_RE = /^[0-9a-f]{32}$/

export async function md5Hex(bytes: Uint8Array): Promise<string> {
  // The cast is only for the type checker: digest wants an ArrayBuffer-backed
  // view, and every Uint8Array here is one (none come from SharedArrayBuffer).
  // Copying a 20MB file to satisfy the type would be the wrong trade.
  return encodeHex(await stdCrypto.subtle.digest('MD5', bytes as Uint8Array<ArrayBuffer>))
}

function normaliseMd5(value: string | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const md5 = String(value).trim().toLowerCase()
  if (!MD5_RE.test(md5)) throw new ToolError(`"${field}" must be a 32-character hex MD5, got "${value}".`)
  return md5
}

/**
 * Turns whatever the caller sent into the file's bytes, or — for a chunk that
 * does not yet complete its upload — into a receipt saying what has arrived.
 *
 * Nothing is stored as an attachment from here: a file whose MD5 does not match
 * expected_md5 is refused before the caller writes anything, which is the whole
 * point of sending a checksum. Re-copying 70 000 characters of base64 by hand is
 * where uploads went wrong; one bad character used to be invisible until someone
 * downloaded the file and checked it.
 *
 * `scope` names the upload's target (e.g. "task:<id>") and is pinned at chunk 0,
 * so chunks of one upload cannot be redirected into a different task.
 */
export async function receiveUpload(
  admin: SupabaseClient,
  args: UploadArgs,
  scope: string,
  filename: string,
): Promise<ReceivedUpload> {
  const expected = normaliseMd5(args.expected_md5, 'expected_md5')
  const chunked = args.total_chunks !== undefined || args.chunk_index !== undefined || args.upload_id !== undefined

  if (!chunked) {
    const bytes = await resolveAttachmentBytes(args)
    const md5 = await md5Hex(bytes)
    if (expected && md5 !== expected) {
      throw new ToolError(
        `MD5 mismatch: the file received hashes to ${md5}, but expected_md5 is ${expected}. Nothing was saved — the content was altered on the way; send it again.`,
      )
    }
    return { complete: true, bytes, size: bytes.byteLength, md5 }
  }

  return receiveChunk(admin, args, scope, filename, expected)
}

interface Manifest {
  scope: string
  filename: string
  total_chunks: number
  expected_md5: string | null
  created_at: string
}

async function receiveChunk(
  admin: SupabaseClient,
  args: UploadArgs,
  scope: string,
  filename: string,
  expected: string | null,
): Promise<ReceivedUpload> {
  const total = Number(args.total_chunks)
  const index = Number(args.chunk_index)
  if (!Number.isInteger(total) || total < 2 || total > MAX_CHUNKS) {
    throw new ToolError(`"total_chunks" must be a whole number from 2 to ${MAX_CHUNKS} (send a smaller file in one call without chunking).`)
  }
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new ToolError(`"chunk_index" must be a whole number from 0 to ${total - 1}.`)
  }
  if (args.file) throw new ToolError('Chunked uploads take content_base64 per chunk; a "file" reference is fetched whole, so send it without chunking.')
  if (!args.content_base64) throw new ToolError(`"content_base64" is required for chunk ${index}.`)

  const store = admin.storage.from(BUCKET)

  // The upload is opened by chunk 0, which mints its id. Every later chunk must
  // carry that id — and match the target, file name and chunk count pinned then.
  let uploadId: string
  let manifest: Manifest
  if (index === 0 && !args.upload_id) {
    uploadId = crypto.randomUUID()
    manifest = { scope, filename, total_chunks: total, expected_md5: expected, created_at: new Date().toISOString() }
    const { error } = await store.upload(
      `${UPLOADS_PREFIX}/${uploadId}/manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
      { contentType: 'application/json', upsert: true },
    )
    if (error) throw new ToolError(`Failed to open the upload: ${error.message}`)
  } else {
    if (!args.upload_id) throw new ToolError(`"upload_id" is required for chunk ${index} — send chunk 0 first; its response carries the upload_id.`)
    if (!UUID_RE.test(args.upload_id)) throw new ToolError('"upload_id" is not one this server issued.')
    uploadId = args.upload_id
    const { data, error } = await store.download(`${UPLOADS_PREFIX}/${uploadId}/manifest.json`)
    if (error || !data) throw new ToolError(`Unknown or expired upload_id ${uploadId} — start again from chunk 0.`)
    manifest = JSON.parse(await data.text()) as Manifest
    if (manifest.scope !== scope) throw new ToolError(`upload_id ${uploadId} belongs to a different target.`)
    if (manifest.filename !== filename) throw new ToolError(`upload_id ${uploadId} was opened for "${manifest.filename}", not "${filename}".`)
    if (manifest.total_chunks !== total) throw new ToolError(`upload_id ${uploadId} was opened with total_chunks ${manifest.total_chunks}, not ${total}.`)
  }

  const chunk = decodeAttachmentBase64(args.content_base64)
  const chunkExpected = normaliseMd5(args.chunk_md5, 'chunk_md5')
  if (chunkExpected) {
    const chunkMd5 = await md5Hex(chunk)
    if (chunkMd5 !== chunkExpected) {
      throw new ToolError(`MD5 mismatch on chunk ${index}: received ${chunkMd5}, expected ${chunkExpected}. Resend just this chunk with the same upload_id.`)
    }
  }

  const { error: chunkError } = await store.upload(
    `${UPLOADS_PREFIX}/${uploadId}/${String(index).padStart(4, '0')}`,
    chunk,
    { contentType: 'application/octet-stream', upsert: true },
  )
  if (chunkError) throw new ToolError(`Failed to store chunk ${index}: ${chunkError.message}`)

  const { data: listing, error: listError } = await store.list(`${UPLOADS_PREFIX}/${uploadId}`, { limit: 1000 })
  if (listError) throw new ToolError(`Failed to read the upload back: ${listError.message}`)
  const received = (listing ?? [])
    .map((entry: { name: string }) => entry.name)
    .filter((name: string) => /^\d{4}$/.test(name))
    .map(Number)
    .sort((a: number, b: number) => a - b)

  if (received.length < total) return { complete: false, upload_id: uploadId, received, total_chunks: total }

  // Every chunk is in: assemble in index order, within the same size limit as a
  // whole-file upload, and check the file as a whole.
  const parts: Uint8Array[] = []
  let size = 0
  for (let i = 0; i < total; i++) {
    const { data, error } = await store.download(`${UPLOADS_PREFIX}/${uploadId}/${String(i).padStart(4, '0')}`)
    if (error || !data) throw new ToolError(`Chunk ${i} could not be read back: ${error?.message ?? 'missing'}`)
    const part = new Uint8Array(await data.arrayBuffer())
    size += part.byteLength
    if (size > MAX_ATTACHMENT_BYTES) {
      await discardUpload(admin, uploadId)
      throw new ToolError(`The chunks add up to more than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit. The upload was discarded.`)
    }
    parts.push(part)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }

  const md5 = await md5Hex(bytes)
  const wanted = expected ?? manifest.expected_md5
  // Either way the chunks have served their purpose.
  await discardUpload(admin, uploadId)
  if (wanted && md5 !== wanted) {
    throw new ToolError(
      `MD5 mismatch: the assembled file hashes to ${md5}, but expected_md5 is ${wanted}. Nothing was saved and the upload was discarded — send chunk_md5 with each chunk to find the bad one, and start again.`,
    )
  }
  return { complete: true, bytes, size, md5 }
}

async function discardUpload(admin: SupabaseClient, uploadId: string): Promise<void> {
  const store = admin.storage.from(BUCKET)
  const { data } = await store.list(`${UPLOADS_PREFIX}/${uploadId}`, { limit: 1000 })
  const paths = (data ?? []).map((entry: { name: string }) => `${UPLOADS_PREFIX}/${uploadId}/${entry.name}`)
  if (paths.length) await store.remove(paths)
}

/**
 * The args as they go into agent_audit_log. Upload tools used to log their
 * arguments verbatim — the whole file as base64, up to 20MB per row — and a
 * ChatGPT download_url with its signed token. The log keeps what the call was,
 * not what it carried.
 */
export function auditableUploadArgs<T extends Record<string, unknown>>(args: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args }
  if (typeof args.content_base64 === 'string') out.content_base64 = `<${args.content_base64.length} base64 chars>`
  const file = args.file as AttachmentFileRef | undefined
  if (file?.download_url) {
    try {
      const url = new URL(file.download_url)
      out.file = { ...file, download_url: `${url.origin}${url.pathname}` }
    } catch {
      out.file = { ...file, download_url: '<unparseable>' }
    }
  }
  return out
}
