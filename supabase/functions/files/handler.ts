// The file gateway. Every byte of every attachment a client reads comes
// through here, and every request is decided by public.file_gate() first:
//
//   POST /tickets  {paths, purpose}   signed-in app: short tickets for src URLs
//   GET  /t/<ticket>                   the app reading a file (view | archive)
//   GET  /s/<token>                    a share link (live files only, ever)
//   POST /remove   {paths}             the app removing files nothing references
//
// A refusal is a bare 404 whatever the reason, so nobody learns whether a file
// exists. Nothing is cached (no-store, private); bodies are streamed, and
// Range is passed through for large files and video.

import { TICKET_TTL_SECONDS, signTicket, verifyTicket, type Purpose } from './ticket.ts'

export interface GateArgs {
  path: string | null
  channel: 'app' | 'share'
  purpose: Purpose
  actor: string | null
  shareToken: string | null
  range: string | null
  ip: string | null
  userAgent: string | null
}

export interface GateResult {
  ok: boolean
  path?: string
  bucket?: string
  name?: string | null
  mime_type?: string | null
}

export interface Deps {
  /** HMAC secret for tickets; empty = refuse everything. */
  secret: string
  /** Public base URL of this function, e.g. https://x.supabase.co/functions/v1/files */
  baseUrl: string
  userFromJwt(jwt: string): Promise<string | null>
  gate(args: GateArgs): Promise<GateResult>
  fetchObject(bucket: string, path: string, range: string | null): Promise<Response>
  mayRemove(path: string, actor: string): Promise<boolean>
  /** Removes; returns the names storage says it removed, or null on error. */
  removeObjects(bucket: string, paths: string[]): Promise<string[] | null>
  now?: () => number
}

const MAX_PATHS = 200

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, range, apikey, x-client-info',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Content-Disposition, Accept-Ranges, Content-Type',
  'Access-Control-Max-Age': '600',
}

const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store, private',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

// Types that would run as a page if opened inline from this origin: always a download.
const DOWNLOAD_ONLY = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)\b/i

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...CORS, ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, ...NO_STORE, 'Content-Type': 'application/json' } })
}

export function bucketOf(path: string): 'attachments' | 'task-attachments' {
  const parts = path.split('/')
  if (parts.length >= 4 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[2])) return 'attachments'
  if (parts.length === 3) return 'task-attachments'
  return 'attachments'
}

export function displayName(path: string, original?: string | null): string {
  if (original && original.trim()) return original.trim()
  const last = path.split('/').pop() ?? 'file'
  return last.replace(/^\d{10,}-/, '') || 'file'
}

export function contentDisposition(type: string, name: string): string {
  const kind = DOWNLOAD_ONLY.test(type) ? 'attachment' : 'inline'
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

function clientIp(req: Request): string | null {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

/** Route part after ".../files", e.g. "/t/abc". */
export function routeOf(url: URL): string {
  const m = url.pathname.match(/\/files(\/.*)?$/)
  return m ? (m[1] ?? '/') : url.pathname
}

async function stream(deps: Deps, req: Request, gate: GateResult): Promise<Response> {
  if (!gate.ok || !gate.path) return notFound()
  const bucket = gate.bucket ?? bucketOf(gate.path)
  const range = req.headers.get('range')
  let upstream: Response
  try {
    upstream = await deps.fetchObject(bucket, gate.path, range)
  } catch {
    return notFound()
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    await upstream.body?.cancel()
    // 416 must stay a 416 so players stop asking; anything else is "not found".
    if (upstream.status === 416) return new Response(null, { status: 416, headers: { ...CORS, ...NO_STORE, 'Content-Range': upstream.headers.get('content-range') ?? '' } })
    return notFound()
  }
  const type = gate.mime_type || upstream.headers.get('content-type') || 'application/octet-stream'
  const headers: Record<string, string> = {
    ...CORS,
    ...NO_STORE,
    'Content-Type': type,
    'Content-Disposition': contentDisposition(type, displayName(gate.path, gate.name)),
    'Accept-Ranges': 'bytes',
  }
  const length = upstream.headers.get('content-length')
  if (length) headers['Content-Length'] = length
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) headers['Content-Range'] = contentRange
  // The body is passed on as it arrives — never read whole into memory.
  return new Response(upstream.body, { status: upstream.status, headers })
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (!deps.secret) return notFound()
  const url = new URL(req.url)
  const route = routeOf(url)
  const now = deps.now?.() ?? Date.now()

  // ── the app reads a file ──
  if (req.method === 'GET' && route.startsWith('/t/')) {
    const ticket = await verifyTicket(deps.secret, decodeURIComponent(route.slice(3)), now / 1000)
    if (!ticket) return notFound()
    const gate = await deps.gate({
      path: ticket.p, channel: 'app', purpose: ticket.pu, actor: ticket.u, shareToken: null,
      range: req.headers.get('range'), ip: clientIp(req), userAgent: req.headers.get('user-agent'),
    })
    return stream(deps, req, gate)
  }

  // ── a share link ──
  if (req.method === 'GET' && route.startsWith('/s/')) {
    const token = route.slice(3)
    if (!/^[0-9a-f]{64}$/.test(token)) return notFound()
    const gate = await deps.gate({
      path: null, channel: 'share', purpose: 'view', actor: null, shareToken: token,
      range: req.headers.get('range'), ip: clientIp(req), userAgent: req.headers.get('user-agent'),
    })
    return stream(deps, req, gate)
  }

  if (req.method !== 'POST' || (route !== '/tickets' && route !== '/remove')) return notFound()

  // ── signed-in calls ──
  const jwt = bearer(req)
  const userId = jwt ? await deps.userFromJwt(jwt) : null
  if (!userId) return json(401, { error: 'sign in' })
  let body: { paths?: unknown; purpose?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'bad body' })
  }
  const paths = Array.isArray(body.paths) ? [...new Set(body.paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length < 1024))] : []
  if (!paths.length || paths.length > MAX_PATHS) return json(400, { error: `1..${MAX_PATHS} paths` })

  if (route === '/tickets') {
    const purpose: Purpose = body.purpose === 'archive' ? 'archive' : 'view'
    const exp = Math.floor(now / 1000) + TICKET_TTL_SECONDS
    const urls: Record<string, string> = {}
    // A ticket grants nothing: each GET with it is decided by file_gate.
    for (const p of paths) urls[p] = `${deps.baseUrl}/t/${await signTicket(deps.secret, { c: 'app', u: userId, p, pu: purpose, e: exp })}`
    return json(200, { urls, expires_at: new Date(exp * 1000).toISOString() })
  }

  // route === '/remove'
  const allowed: string[] = []
  const refused: string[] = []
  for (const p of paths) ((await deps.mayRemove(p, userId)) ? allowed : refused).push(p)
  const byBucket = new Map<string, string[]>()
  for (const p of allowed) byBucket.set(bucketOf(p), [...(byBucket.get(bucketOf(p)) ?? []), p])
  const removed: string[] = []
  const failed: string[] = []
  for (const [bucket, list] of byBucket) {
    const gone = new Set((await deps.removeObjects(bucket, list)) ?? [])
    for (const p of list) (gone.has(p) ? removed : failed).push(p)
  }
  return json(200, { removed, failed, refused })
}
