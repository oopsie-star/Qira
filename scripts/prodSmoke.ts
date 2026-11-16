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
// It cannot see data or permission problems; those need a signed-in check.
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
for (const [screen, name, run, expectError] of checks) {
  const { error } = await run()
  const ok = expectError ? error?.code === expectError : !error
  if (!ok) failed++
  const detail = error ? `${error.code ?? ''} ${error.message}`.trim() : 'accepted'
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${screen.padEnd(12)} ${name.padEnd(26)} ${detail}`)
}
console.log(failed ? `\n${failed} of ${checks.length} checks FAILED` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
