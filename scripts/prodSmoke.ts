// Production smoke check — run after every migration (see CLAUDE.md, "Deploying").
//
//   npm run smoke:prod
//
// Sends the same queries the main screens send — task list and board, the task
// drawer (comments, activity, history, links, attachments), sprints and epics —
// using the column lists in src/store/selects.ts, with the anon key from .env.
//
// The anon key sees no rows (RLS), so this checks what migrations break: every
// query must still be ACCEPTED — columns exist, embeds resolve to exactly one
// foreign key, the RPCs the screens call exist with their signatures. A query
// PostgREST rejects is exactly how stage 3 hid every comment (PGRST201).
// The second part signs in as a TEST-only account (SMOKE_TEST_EMAIL/PASSWORD in
// .env) and checks data and permissions on a fixture task in project TEST.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

import {
  OWNER_REQUEST_SELECT,
  TASK_ACTIVITY_SELECT,
  TASK_COMMENT_SELECT,
  TASK_FIELD_CHANGE_SELECT,
  TASK_LINK_SELECT,
  TASK_SELECT,
} from '../src/store/selects'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
)
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY
if (!url || !key) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing from .env')

const supabase = createClient(url, key, { auth: { persistSession: false } })
// Any well-formed id: RLS returns nothing either way; what matters is that the
// query is accepted.
const ID = '00000000-0000-4000-8000-000000000000'

type Result = { error: { code?: string; message: string } | null }
/** expectError: the error code that counts as a pass (a refused-but-existing function). */
type Check = [screen: string, name: string, run: () => PromiseLike<Result>, expectError?: string]

const checks: Check[] = [
  ['Backlog', 'tasks (list)', () =>
    supabase.from('tasks').select(TASK_SELECT).eq('project_id', ID)
      .order('sprint_id', { ascending: true, nullsFirst: true }).order('position').order('created_at').range(0, 0)],
  ['Board', 'tasks (sprint)', () =>
    supabase.from('tasks').select(TASK_SELECT).eq('project_id', ID).eq('sprint_id', ID).order('status').order('position').range(0, 0)],
  ['Board', 'subtasks', () => supabase.from('tasks').select(TASK_SELECT).eq('project_id', ID).in('parent_task_id', [ID])],
  ['Board', 'sprints', () => supabase.from('sprints').select('*').eq('project_id', ID).order('created_at')],
  ['Board', 'epics', () => supabase.from('epics').select('*').eq('project_id', ID).order('created_at')],
  ['Board', 'last AI agent (rpc)', () => supabase.rpc('get_task_last_ai_agent', { p_project_id: ID })],
  ['Task drawer', 'comments', () => supabase.from('task_comments').select(TASK_COMMENT_SELECT).eq('task_id', ID).order('created_at')],
  ['Task drawer', 'activity', () => supabase.from('task_activities').select(TASK_ACTIVITY_SELECT).eq('task_id', ID).order('created_at', { ascending: false })],
  ['Task drawer', 'field history', () => supabase.from('task_field_changes').select(TASK_FIELD_CHANGE_SELECT).eq('task_id', ID).order('changed_at', { ascending: false })],
  ['Task drawer', 'links', () => supabase.from('task_links').select(TASK_LINK_SELECT).eq('project_id', ID).order('created_at', { ascending: false })],
  ['Task drawer', 'attachment notes', () => supabase.from('attachment_notes').select('*').eq('project_id', ID)],
  // Write paths are probed without writing: anon may not execute them, and the
  // 42501 it gets proves the function exists with these arguments — a missing
  // or renamed function answers PGRST202 instead.
  ['Task drawer', 'archive attachment (rpc)', () =>
    supabase.rpc('set_attachment_archived', { p_path: 'smoke/none', p_archived: true }), '42501'],
  ['Task drawer', 'archive comment (rpc)', () =>
    supabase.rpc('set_comment_archived', { p_comment: ID, p_archived: true }), '42501'],
  // Stage 4b: owner requests — the inbox query and the three functions.
  ['Requests', 'owner requests (inbox)', () =>
    supabase.from('owner_requests').select(OWNER_REQUEST_SELECT).eq('project_id', ID).in('status', ['pending', 'approved'])
      .is('used_at', null).order('created_at', { ascending: false })],
  ['Requests', 'decide (rpc)', () => supabase.rpc('decide_owner_request', { p_request: 1, p_approve: false, p_note: null }), '42501'],
  ['Requests', 'file (rpc, MCP only)', () =>
    supabase.rpc('create_owner_request', { p_type: 'purge_trash', p_project: ID, p_task: null, p_params: {}, p_preview: {}, p_reason: null, p_actor: null, p_agent: null }), '42501'],
  ['Requests', 'apply (rpc, MCP only)', () =>
    supabase.rpc('apply_owner_request', { p_request: 1, p_type: 'purge_trash', p_task: null, p_params: {}, p_actor: null, p_agent: null }), '42501'],
  // Stage 4a: starting work, the edit policy, revisions.
  ['Task drawer', 'take in work (rpc)', () => supabase.rpc('take_in_work', { p_task: ID, p_comment: 'smoke check only' }), '42501'],
  ['Task drawer', 'back to to do (rpc)', () => supabase.rpc('return_to_todo', { p_task: ID, p_comment: 'smoke check only' }), '42501'],
  ['Task drawer', 'edit policy (rpc)', () => supabase.rpc('task_edit_policy', { p_task: ID }), '42501'],
  ['Task drawer', 'new revision (rpc)', () =>
    supabase.rpc('create_task_revision', { p_task: ID, p_title: null, p_description: null, p_attachments: [], p_comment_ids: [], p_reason: 'smoke' }), '42501'],
  // File gateway: the owners' panel reads these (anon: no grant at all), the
  // gate is for the server only, links are made by signed-in members.
  ['Files', 'share links (owners)', () =>
    supabase.from('file_share_links').select('id, path, created_by, created_at, expires_at, revoked_at, revoke_reason, use_count, last_used_at').eq('project_id', ID), '42501'],
  ['Files', 'access log (owners)', () =>
    supabase.from('file_access_log').select('id, at, path, channel, purpose, actor_id, actor_agent, outcome, reason, project_from_path').eq('project_id', ID), '42501'],
  ['Files', 'gate (rpc, server only)', () =>
    supabase.rpc('file_gate', { p_path: 'x', p_channel: 'app', p_purpose: 'view', p_actor: null, p_agent: null, p_share_token: null, p_range: null, p_ip: null, p_user_agent: null }), '42501'],
  ['Files', 'share (rpc)', () => supabase.rpc('create_file_share_links', { p_paths: [] }), '42501'],
  ['Files', 'revoke share (rpc)', () => supabase.rpc('revoke_file_share_link', { p_link: ID }), '42501'],
]

let failed = 0
let total = 0
function report(ok: boolean, screen: string, name: string, detail: string) {
  total++
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${screen.padEnd(12)} ${name.padEnd(26)} ${detail}`)
}

console.log('— schema (anon key) —')
for (const [screen, name, run, expectError] of checks) {
  const { error } = await run()
  const ok = expectError ? error?.code === expectError : !error
  report(ok, screen, name, error ? `${error.code ?? ''} ${error.message}`.trim() : 'accepted')
}

// ── Signed in: data and permissions ──────────────────────────────────────────
//
// As a dedicated account that is a member of project TEST and nothing else
// (SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD in .env). It opens a fixture task in
// TEST the way the drawer does and expects to see its comments and attachments;
// and it must not see any other project. The fixture is created on the first
// run — the only writes this script makes, and only in TEST.
console.log('\n— signed in as the TEST-only account —')
const FIXTURE_TITLE = 'smoke fixture — do not delete'
await signedInChecks().catch((err) => report(false, 'Sign-in', 'signed-in checks', String(err?.message ?? err)))

async function signedInChecks() {
  const email = env.SMOKE_TEST_EMAIL
  const password = env.SMOKE_TEST_PASSWORD
  if (!email || !password) {
    report(false, 'Sign-in', 'credentials', 'SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD missing from .env')
    return
  }
  const user = createClient(url, key, { auth: { persistSession: false } })
  const { data: auth, error: authError } = await user.auth.signInWithPassword({ email, password })
  report(!authError, 'Sign-in', 'password sign-in', authError?.message ?? 'ok')
  if (authError || !auth.user) return
  const uid = auth.user.id

  try {
    const { data: projects, error: projectsError } = await user.from('projects').select('id, key')
    const keys = (projects ?? []).map((p) => p.key as string)
    report(!projectsError && keys.length === 1 && keys[0] === 'TEST', 'Permissions', 'sees only project TEST',
      projectsError?.message ?? `sees: ${keys.join(', ') || 'nothing'}`)
    const project = (projects ?? []).find((p) => p.key === 'TEST')
    if (!project) return

    const { data: foreign, error: foreignError } = await user.from('tasks').select('id').neq('project_id', project.id).limit(1)
    report(!foreignError && (foreign ?? []).length === 0, 'Permissions', 'no tasks of other projects',
      foreignError?.message ?? `${(foreign ?? []).length} visible`)

    const taskId = await ensureFixture(user, project.id as string, uid)

    // The drawer, as the app loads it.
    const { data: task, error: taskError } = await user.from('tasks').select(TASK_SELECT).eq('id', taskId).maybeSingle()
    report(!taskError && Boolean(task), 'Task drawer', 'fixture task', taskError?.message ?? (task ? (task as { key: string }).key : 'not visible'))
    if (!task) return

    // The drawer asks the policy before saving a started task's text.
    const { data: policy, error: policyError } = await user.rpc('task_edit_policy', { p_task: taskId })
    report(!policyError && Boolean((policy as { edit_mode?: string } | null)?.edit_mode), 'Task drawer', 'edit policy',
      policyError?.message ?? `edit_mode ${(policy as { edit_mode?: string }).edit_mode}`)

    const { data: comments, error: commentsError } = await user
      .from('task_comments').select(TASK_COMMENT_SELECT).eq('task_id', taskId).order('created_at')
    const live = (comments ?? []).filter((c) => !(c as { archived_at?: string | null }).archived_at)
    const withAuthor = live.filter((c) => (c as { author?: unknown }).author)
    report(!commentsError && live.length > 0 && withAuthor.length === live.length, 'Task drawer', 'comments with authors',
      commentsError?.message ?? `${live.length} live, ${withAuthor.length} with author`)

    const paths = ((task as { attachments?: string[] }).attachments ?? [])
    const { data: notes, error: notesError } = await user.from('attachment_notes').select('*').eq('project_id', project.id)
    const named = paths.filter((p) => (notes ?? []).some((n) => n.path === p && n.original_name))
    report(!notesError && paths.length > 0 && named.length === paths.length, 'Task drawer', 'attachments with names',
      notesError?.message ?? `${paths.length} attached, ${named.length} named`)

    await fileGatewayChecks(user, auth.session!.access_token, paths[0], project.id as string)
  } finally {
    await user.auth.signOut()
  }
}

// ── The file gateway (supabase/functions/files) ──────────────────────────────
//
// Opening a file the way the drawer does: a ticket, then the file — with no
// caching anywhere. A share link works, and stops the moment it is revoked.
// A file of another project is a plain 404. And the old door is shut: the
// account cannot sign a storage URL itself (SMOKE_STORAGE_OPEN=1 only for the
// one run between 20261119000000 and 20261119010000).
async function fileGatewayChecks(user: ReturnType<typeof createClient>, jwt: string, path: string | undefined, projectId: string) {
  if (!path) {
    report(false, 'Files', 'fixture file', 'the fixture task has no attachment')
    return
  }
  const FILES = `${url}/functions/v1/files`
  const cacheOk = (r: Response) =>
    r.headers.get('cache-control') === 'no-store, private' && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('cf-cache-status') !== 'HIT'
  const headersOf = (r: Response) => `cc=${r.headers.get('cache-control')} nosniff=${r.headers.get('x-content-type-options')} cf=${r.headers.get('cf-cache-status')}`

  const t = await fetch(`${FILES}/tickets`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [path] }) })
  const ticketUrl = t.ok ? ((await t.json()) as { urls: Record<string, string> }).urls[path] : undefined
  report(Boolean(ticketUrl), 'Files', 'ticket', ticketUrl ? 'issued' : `HTTP ${t.status}`)
  if (!ticketUrl) return

  const first = await fetch(ticketUrl)
  const body = await first.text()
  report(first.status === 200 && body.length > 0, 'Task drawer', 'attachment opens', `HTTP ${first.status}, ${body.length} bytes`)
  const second = await fetch(ticketUrl)
  await second.text()
  report(cacheOk(first) && cacheOk(second), 'Files', 'no cache (twice)', headersOf(second))

  const ranged = await fetch(ticketUrl, { headers: { Range: 'bytes=0-3' } })
  const part = await ranged.arrayBuffer()
  report(ranged.status === 206 && part.byteLength === 4, 'Files', 'range request', `HTTP ${ranged.status}, ${part.byteLength} bytes, ${ranged.headers.get('content-range')}`)

  const foreign = '00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/1-x.txt'
  const ft = await fetch(`${FILES}/tickets`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [foreign] }) })
  const fUrl = ((await ft.json()) as { urls?: Record<string, string> }).urls?.[foreign]
  const fRes = fUrl ? await fetch(fUrl) : null
  const fBody = fRes ? await fRes.text() : ''
  report(fRes?.status === 404 && fBody === 'Not found', 'Files', 'foreign file is 404', `HTTP ${fRes?.status}`)

  const { data: links, error: linkError } = await user.rpc('create_file_share_links', { p_paths: [path] })
  const token = (links as { token: string }[] | null)?.[0]?.token
  const shareUrl = token ? `${FILES}/s/${token}` : ''
  const s1 = token ? await fetch(shareUrl) : null
  if (s1) await s1.text()
  report(s1?.status === 200 && cacheOk(s1), 'Files', 'share link opens', linkError?.message ?? `HTTP ${s1?.status} ${s1 ? headersOf(s1) : ''}`)
  const { data: row } = await user.from('file_share_links').select('id').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1)
  const { error: revokeError } = await user.rpc('revoke_file_share_link', { p_link: row?.[0]?.id })
  const s2 = token ? await fetch(shareUrl) : null
  if (s2) await s2.text()
  report(!revokeError && s2?.status === 404, 'Files', 'revoked link is 404', revokeError?.message ?? `HTTP ${s2?.status}`)

  const { data: direct, error: directError } = await user.storage.from('attachments').createSignedUrl(path, 60)
  if (env.SMOKE_STORAGE_OPEN === '1' || process.env.SMOKE_STORAGE_OPEN === '1') {
    report(true, 'Files', 'direct storage signing', direct ? 'still open (expected until 20261119010000)' : `closed: ${directError?.message}`)
  } else {
    report(!direct, 'Files', 'direct storage signing', direct ? 'STILL OPEN: storage signed a URL for a client' : `refused (${directError?.message})`)
  }
}

/** The fixture task in TEST, created with a comment and a small file if missing. */
async function ensureFixture(user: ReturnType<typeof createClient>, projectId: string, uid: string): Promise<string> {
  const { data: existing } = await user.from('tasks').select('id').eq('project_id', projectId).eq('title', FIXTURE_TITLE).limit(1)
  if (existing?.length) return existing[0].id as string

  const { data: task, error } = await user.from('tasks')
    .insert({ project_id: projectId, title: FIXTURE_TITLE, description: 'Read by npm run smoke:prod. Keep its comment and attachment.', reporter_id: uid })
    .select('id').single()
  if (error || !task) throw new Error(`could not create the fixture task: ${error?.message}`)
  const taskId = task.id as string

  const { error: commentError } = await user.from('task_comments')
    .insert({ project_id: projectId, task_id: taskId, author_id: uid, body: 'Smoke fixture comment.' })
  if (commentError) throw new Error(`could not add the fixture comment: ${commentError.message}`)

  const path = `${projectId}/${taskId}/${uid}/${Date.now()}-smoke-fixture.txt`
  const { error: uploadError } = await user.storage.from('attachments')
    .upload(path, new Blob(['smoke fixture\n'], { type: 'text/plain' }), { upsert: false })
  if (uploadError) throw new Error(`could not upload the fixture file: ${uploadError.message}`)
  const { error: noteError } = await user.from('attachment_notes')
    .upsert({ project_id: projectId, path, original_name: 'smoke-fixture.txt', mime_type: 'text/plain', updated_by: uid }, { onConflict: 'project_id,path' })
  if (noteError) throw new Error(`could not name the fixture file: ${noteError.message}`)
  const { error: attachError } = await user.from('tasks').update({ attachments: [path] }).eq('id', taskId)
  if (attachError) throw new Error(`could not attach the fixture file: ${attachError.message}`)

  console.log(`      (created the fixture task in TEST: ${taskId})`)
  return taskId
}

console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nall ${total} checks passed`)
process.exit(failed ? 1 : 0)
