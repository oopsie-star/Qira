// The gateway around the decision: tickets, routes, 404 for everything
// refused, no-cache headers, streaming and Range. The decision itself
// (public.file_gate) is proven live in TEST.
//
// Run: deno test --no-check handler.test.ts

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { contentDisposition, handle, routeOf, type Deps, type GateArgs } from './handler.ts'
import { signTicket, verifyTicket } from './ticket.ts'

const SECRET = 'test-secret'
const BASE = 'https://x.supabase.co/functions/v1/files'
const LIVE = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/1790000000000-scan.pdf'
const ARCH = LIVE.replace('scan', 'old')
const TOKEN = 'a'.repeat(64)
const BYTES = new Uint8Array(1000).map((_, i) => i % 251)

function deps(over: Partial<Deps> = {}) {
  const gateCalls: GateArgs[] = []
  const removed: string[][] = []
  const d: Deps = {
    secret: SECRET,
    baseUrl: BASE,
    userFromJwt: (jwt) => Promise.resolve(jwt === 'good-jwt' ? 'user-1' : null),
    gate: (a) => {
      gateCalls.push(a)
      if (a.channel === 'share') return Promise.resolve(a.shareToken === TOKEN ? { ok: true, path: LIVE, bucket: 'attachments', name: 'скан.pdf', mime_type: 'application/pdf' } : { ok: false })
      if (a.actor !== 'user-1') return Promise.resolve({ ok: false })
      if (a.path === LIVE && a.purpose === 'view') return Promise.resolve({ ok: true, path: LIVE, bucket: 'attachments', name: 'скан.pdf', mime_type: 'application/pdf' })
      if (a.path === ARCH && a.purpose === 'archive') return Promise.resolve({ ok: true, path: ARCH, bucket: 'attachments', name: null, mime_type: null })
      return Promise.resolve({ ok: false })
    },
    fetchObject: (_b, _p, range) => {
      const m = range?.match(/^bytes=(\d+)-(\d*)$/)
      if (m) {
        const from = Number(m[1]); const to = m[2] ? Number(m[2]) : BYTES.length - 1
        const part = BYTES.slice(from, to + 1)
        return Promise.resolve(new Response(part, { status: 206, headers: { 'content-length': String(part.length), 'content-range': `bytes ${from}-${to}/${BYTES.length}`, 'content-type': 'application/octet-stream' } }))
      }
      return Promise.resolve(new Response(BYTES, { status: 200, headers: { 'content-length': String(BYTES.length), 'content-type': 'application/octet-stream' } }))
    },
    mayRemove: (p) => Promise.resolve(p !== LIVE),
    removeObjects: (_b, paths) => { removed.push(paths); return Promise.resolve(paths.filter((p) => !p.includes('missing'))) },
    now: () => 1_800_000_000_000,
    ...over,
  }
  return { d, gateCalls, removed }
}

async function ticketFor(path: string, purpose: 'view' | 'archive' = 'view', u = 'user-1', e = 1_800_000_000 + 3600) {
  return `${BASE}/t/${await signTicket(SECRET, { c: 'app', u, p: path, pu: purpose, e })}`
}

function assertNoCache(res: Response) {
  assertEquals(res.headers.get('cache-control'), 'no-store, private')
  assertEquals(res.headers.get('x-content-type-options'), 'nosniff')
}

Deno.test('routes are read after /files, with or without /functions/v1', () => {
  assertEquals(routeOf(new URL('https://x/functions/v1/files/t/abc')), '/t/abc')
  assertEquals(routeOf(new URL('https://x/files/s/abc')), '/s/abc')
})

Deno.test('tickets: a signed-in user gets one URL per path; without sign-in, 401', async () => {
  const { d } = deps()
  const res = await handle(new Request(`${BASE}/tickets`, { method: 'POST', headers: { authorization: 'Bearer good-jwt' }, body: JSON.stringify({ paths: [LIVE, LIVE], purpose: 'view' }) }), d)
  const body = await res.json()
  assertEquals(Object.keys(body.urls), [LIVE])
  assertStringIncludes(body.urls[LIVE], `${BASE}/t/`)
  assertNoCache(res)
  const anon = await handle(new Request(`${BASE}/tickets`, { method: 'POST', body: JSON.stringify({ paths: [LIVE] }) }), d)
  assertEquals(anon.status, 401)
})

Deno.test('a live file is streamed with the right headers, decided by the gate as the ticket holder', async () => {
  const { d, gateCalls } = deps()
  const res = await handle(new Request(await ticketFor(LIVE), { headers: { 'user-agent': 'UA', 'cf-connecting-ip': '1.2.3.4' } }), d)
  assertEquals(res.status, 200)
  assertNoCache(res)
  assertEquals(res.headers.get('content-type'), 'application/pdf')
  assertEquals(res.headers.get('content-disposition'), `inline; filename="____.pdf"; filename*=UTF-8''${encodeURIComponent('скан.pdf')}`)
  assertEquals(res.headers.get('accept-ranges'), 'bytes')
  assertEquals(new Uint8Array(await res.arrayBuffer()), BYTES)
  assertEquals([gateCalls[0].channel, gateCalls[0].actor, gateCalls[0].purpose, gateCalls[0].ip, gateCalls[0].userAgent], ['app', 'user-1', 'view', '1.2.3.4', 'UA'])
})

Deno.test('Range is passed through: 206 with Content-Range, only those bytes', async () => {
  const { d, gateCalls } = deps()
  const res = await handle(new Request(await ticketFor(LIVE), { headers: { range: 'bytes=100-199' } }), d)
  assertEquals(res.status, 206)
  assertEquals(res.headers.get('content-range'), 'bytes 100-199/1000')
  assertEquals(new Uint8Array(await res.arrayBuffer()), BYTES.slice(100, 200))
  assertEquals(gateCalls[0].range, 'bytes=100-199')
})

Deno.test('the body is the upstream stream itself, not a buffered copy', async () => {
  let pulled = 0
  const upstream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 3) c.close(); else c.enqueue(new Uint8Array(10)) } })
  const { d } = deps({ fetchObject: () => Promise.resolve(new Response(upstream, { status: 200 })) })
  const res = await handle(new Request(await ticketFor(LIVE)), d)
  assert(pulled <= 1, `read ${pulled} chunks before the client asked`)
  assertEquals((await res.arrayBuffer()).byteLength, 30)
})

Deno.test('refusals are all the same bare 404: archived as view, live as archive, other user, bad or expired ticket', async () => {
  const { d } = deps()
  const cases = [
    await ticketFor(ARCH, 'view'),
    await ticketFor(LIVE, 'archive'),
    await ticketFor(LIVE, 'view', 'user-2'),
    await ticketFor(LIVE, 'view', 'user-1', 1_800_000_000 - 1),
    (await ticketFor(LIVE)).slice(0, -3) + 'xyz',
    `${BASE}/t/garbage`,
    `${BASE}/nothing-here`,
  ]
  for (const u of cases) {
    const res = await handle(new Request(u), d)
    assertEquals(res.status, 404, u)
    assertEquals(await res.text(), 'Not found')
    assertNoCache(res)
  }
})

Deno.test('an archived file opens with an "archive" ticket (from the archive list)', async () => {
  const { d } = deps()
  const res = await handle(new Request(await ticketFor(ARCH, 'archive')), d)
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('content-type'), 'application/octet-stream')
  await res.body?.cancel()
})

Deno.test('share links: a known token streams; anything else is 404 without asking storage', async () => {
  let fetched = 0
  const { d } = deps()
  const inner = d.fetchObject
  d.fetchObject = (...a) => { fetched++; return inner(...a) }
  const ok = await handle(new Request(`${BASE}/s/${TOKEN}`), d)
  assertEquals(ok.status, 200)
  assertNoCache(ok)
  await ok.body?.cancel()
  for (const t of ['b'.repeat(64), 'short', `${TOKEN}x`]) assertEquals((await handle(new Request(`${BASE}/s/${t}`), d)).status, 404)
  assertEquals(fetched, 1)
})

Deno.test('storage missing the object after a yes is still a plain 404', async () => {
  const { d } = deps({ fetchObject: () => Promise.resolve(new Response('{"error":"not_found"}', { status: 400 })) })
  const res = await handle(new Request(await ticketFor(LIVE)), d)
  assertEquals(res.status, 404)
  assertEquals(await res.text(), 'Not found')
})

Deno.test('html, svg and scripts are always downloads, never inline', () => {
  assertStringIncludes(contentDisposition('text/html', 'p.html'), 'attachment;')
  assertStringIncludes(contentDisposition('image/svg+xml', 'a.svg'), 'attachment;')
  assertStringIncludes(contentDisposition('image/png', 'a.png'), 'inline;')
})

Deno.test('no secret configured: everything is refused', async () => {
  const { d } = deps({ secret: '' })
  assertEquals((await handle(new Request(await ticketFor(LIVE)), d)).status, 404)
})

Deno.test('remove: only what file_may_remove allows; counted by what storage removed', async () => {
  const { d, removed } = deps()
  const other = LIVE.replace('scan', 'gone')
  const missing = LIVE.replace('scan', 'missing')
  const res = await handle(new Request(`${BASE}/remove`, { method: 'POST', headers: { authorization: 'Bearer good-jwt' }, body: JSON.stringify({ paths: [LIVE, other, missing] }) }), d)
  assertEquals(await res.json(), { removed: [other], failed: [missing], refused: [LIVE] })
  assertEquals(removed, [[other, missing]])
})

Deno.test('ticket verification rejects tampering and expiry', async () => {
  const t = await signTicket(SECRET, { c: 'app', u: 'u', p: 'p', pu: 'view', e: 2000 })
  assertEquals((await verifyTicket(SECRET, t, 1000))?.u, 'u')
  assertEquals(await verifyTicket(SECRET, t, 2001), null)
  assertEquals(await verifyTicket('other', t, 1000), null)
  const [body, sig] = t.split('.')
  assertEquals(await verifyTicket(SECRET, `${body}x.${sig}`, 1000), null)
  // A ticket for another channel, even correctly signed, is refused.
  const other = await signTicket(SECRET, { c: 'share', u: 'u', p: 'p', pu: 'view', e: 2000 } as never)
  assertEquals(await verifyTicket(SECRET, other, 1000), null)
})
