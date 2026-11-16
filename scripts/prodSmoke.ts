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

    for (const path of paths.slice(0, 3)) {
      const { data: signed, error: signError } = await user.storage.from('attachments').createSignedUrl(path, 60)
      const status = signed?.signedUrl ? (await fetch(signed.signedUrl)).status : 0
      report(!signError && status === 200, 'Task drawer', 'attachment downloads', signError?.message ?? `HTTP ${status}`)
    }
  } finally {
    await user.auth.signOut()
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
