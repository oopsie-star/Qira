// download_url hardening: only allowed hosts, redirects re-checked at every
// hop, and the size limit enforced before and during the read.

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { assertAllowedDownloadUrl, fetchAttachmentBytes, MAX_ATTACHMENT_BYTES } from './tools/attachmentPaths.ts'
import { ToolError } from './tools/errors.ts'

const ALLOWED = 'https://oaisdmntprnortheu.blob.core.windows.net/files/abc?sig=x'
const MB = 1024 * 1024

/** A fetch stand-in that records every URL it was asked for. */
function fakeFetch(respond: (url: string) => Response) {
  const calls: string[] = []
  const fn = ((input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    return Promise.resolve(respond(url))
  }) as typeof fetch
  return { fn, calls }
}

/**
 * A body that hands out `chunks` pieces of `size` bytes on demand and counts how
 * many were actually pulled. highWaterMark 0 means nothing is read ahead — a
 * pull happens only when the reader asks — so the count is exact.
 */
function countingBody(chunks: number, size: number) {
  const stats = { pulled: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats.pulled >= chunks) return controller.close()
      stats.pulled++
      controller.enqueue(new Uint8Array(size))
    },
    cancel() { stats.cancelled = true },
  }, { highWaterMark: 0 })
  return { body, stats }
}

// ── host allowlist ────────────────────────────────────────────────────────────

Deno.test('every OpenAI region seen in production is allowed', () => {
  for (const region of ['denmarkeast', 'northeu', 'westus']) {
    assertAllowedDownloadUrl(`https://oaisdmntpr${region}.blob.core.windows.net/f?sig=1`)
  }
})

Deno.test('a foreign host is refused, and never fetched', async () => {
  const { fn, calls } = fakeFetch(() => new Response('secret'))
  await assertRejects(() => fetchAttachmentBytes('https://evil.example.com/file', fn), ToolError, 'not an allowed file host')
  assertEquals(calls, [])
})

Deno.test('lookalike hosts are refused', () => {
  for (const url of [
    'https://oaisdmntprnortheu.blob.core.windows.net.evil.com/f',  // suffix trick
    'https://attacker.blob.core.windows.net/f',                    // any Azure account
    'https://oaisdmntpr.blob.core.windows.net/f',                  // prefix with no region
    'https://xoaisdmntprnortheu.blob.core.windows.net/f',          // prefix not at the start
    'http://169.254.169.254/latest/meta-data/',                    // cloud metadata
    'http://localhost:54321/rest/v1/',                             // internal service
  ]) {
    try {
      assertAllowedDownloadUrl(url)
      throw new Error(`accepted ${url}`)
    } catch (err) {
      assertEquals(err instanceof ToolError, true, url)
    }
  }
})

Deno.test('plain http, credentials in the URL and odd ports are refused even on an allowed host', () => {
  for (const url of [
    'http://oaisdmntprnortheu.blob.core.windows.net/f',
    'https://user:pass@oaisdmntprnortheu.blob.core.windows.net/f',
    'https://oaisdmntprnortheu.blob.core.windows.net:8443/f',
  ]) {
    try {
      assertAllowedDownloadUrl(url)
      throw new Error(`accepted ${url}`)
    } catch (err) {
      assertEquals(err instanceof ToolError, true, url)
    }
  }
})

// ── redirects ─────────────────────────────────────────────────────────────────

Deno.test('a redirect to a foreign host is refused, and the target is never fetched', async () => {
  const { fn, calls } = fakeFetch((url) => url.startsWith('https://oaisdmntpr')
    ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } })
    : new Response('should not get here'))
  await assertRejects(() => fetchAttachmentBytes(ALLOWED, fn), ToolError, 'not an allowed file host')
  assertEquals(calls, [ALLOWED])
})

Deno.test('a redirect between allowed hosts is followed', async () => {
  const next = 'https://oaisdmntprwestus.blob.core.windows.net/files/abc?sig=y'
  const { fn, calls } = fakeFetch((url) => url === ALLOWED
    ? new Response(null, { status: 302, headers: { location: next } })
    : new Response(new Uint8Array([1, 2, 3])))
  const bytes = await fetchAttachmentBytes(ALLOWED, fn)
  assertEquals([...bytes], [1, 2, 3])
  assertEquals(calls, [ALLOWED, next])
})

Deno.test('a redirect loop stops instead of running forever', async () => {
  const { fn, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: ALLOWED } }))
  await assertRejects(() => fetchAttachmentBytes(ALLOWED, fn), ToolError, 'redirected more than')
  assertEquals(calls.length <= 4, true)
})

// ── size ──────────────────────────────────────────────────────────────────────

Deno.test('a declared size over the limit is refused without reading the body at all', async () => {
  const { body, stats } = countingBody(50, MB)
  const { fn } = fakeFetch(() => new Response(body, { headers: { 'content-length': String(50 * MB) } }))
  await assertRejects(() => fetchAttachmentBytes(ALLOWED, fn), ToolError, 'exceeds')
  assertEquals(stats.pulled, 0)
})

Deno.test('an undeclared oversized body is cut off as soon as it crosses the limit', async () => {
  // 50MB on offer, no Content-Length: the read must stop just past 20MB.
  const { body, stats } = countingBody(50, MB)
  const { fn } = fakeFetch(() => new Response(body))
  await assertRejects(() => fetchAttachmentBytes(ALLOWED, fn), ToolError, 'exceeds')
  assertEquals(stats.pulled, MAX_ATTACHMENT_BYTES / MB + 1)
  assertEquals(stats.cancelled, true)
})

Deno.test('a body that understates its Content-Length is still cut off', async () => {
  const { body, stats } = countingBody(50, MB)
  const { fn } = fakeFetch(() => new Response(body, { headers: { 'content-length': '1024' } }))
  await assertRejects(() => fetchAttachmentBytes(ALLOWED, fn), ToolError, 'exceeds')
  assertEquals(stats.pulled < 50, true)
})

Deno.test('a file within the limit comes back whole', async () => {
  const { body } = countingBody(3, MB)
  const { fn } = fakeFetch(() => new Response(body))
  const bytes = await fetchAttachmentBytes(ALLOWED, fn)
  assertEquals(bytes.byteLength, 3 * MB)
})

Deno.test('an HTTP error from the file host is reported, not saved', async () => {
  const { fn } = fakeFetch(() => new Response('gone', { status: 404 }))
  await assertRejects(() => fetchAttachmentBytes(ALLOWED, fn), ToolError, 'HTTP 404')
})
