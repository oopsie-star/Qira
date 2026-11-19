// Stage 5 — duplicates as MCP sees them. The rule and the moves are SQL
// (proven live in TEST); these fakes mirror its answers so the MCP flow is
// tested: candidates on create/rename, the data guard, the owner request for
// a task in work, and the repeat with request_id.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 duplicates.test.ts

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { FakeAdmin, installOwnerRequestFakes } from './testing/fakeAdmin.ts'
import { createTask } from './tools/createTask.ts'
import { listPossibleDuplicates, resolveDuplicate } from './tools/duplicates.ts'
import { updateTask } from './tools/updateTask.ts'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'

function task(id: string, key: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id, project_id: PROJECT, key, title, description: '', status: 'todo', issue_type: 'task', priority: 'medium',
    epic_id: null, sprint_id: null, assignee_id: null, reporter_id: null, assignee_ids: [], due_date: null,
    attachments: [], archived_attachments: [], parent_task_id: null, work_started_at: null, work_started_by: null,
    work_started_signal: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...extra,
  }
}

function fixture() {
  Deno.env.set('MCP_AGENT_EMAIL', 'mcp-agent@test')
  const db = new FakeAdmin({
    projects: [{ id: PROJECT, key: 'P', name: 'P' }],
    profiles: [{ id: 'agent', email: 'mcp-agent@test' }],
    tasks: [task(A, 'P-1', 'TST-BE-01 — Login API'), task(B, 'P-2', 'TST-BE-01 — Login API v2')],
    task_activities: [], agent_audit_log: [], task_comments: [],
  })
  db.rpcHandlers.find_possible_duplicates = (p) =>
    ({ data: String(p.p_title).startsWith('TST-BE-01') ? [{ task_id: A, key: 'P-1', title: 'TST-BE-01 — Login API', status: 'todo', similarity: 0.871, reason: 'same code TST-BE-01', same_epic: false }].filter((d) => d.task_id !== p.p_exclude) : [], error: null })
  installOwnerRequestFakes(db)
  return db
}

Deno.test('create_task: candidates and the three options come back with the new task', async () => {
  const db = fixture()
  const out = await createTask(db as never, { project: 'P', title: 'TST-BE-01 — Login API (again)', agent_name: 'claude' }) as Record<string, unknown>
  const dups = out.possible_duplicates as { key: string; similarity: number; reason: string }[]
  assertEquals([dups[0].key, dups[0].similarity, dups[0].reason], ['P-1', 0.87, 'same code TST-BE-01'])
  assertStringIncludes(String(out.duplicate_hint), 'new_version')
})

Deno.test('create_task: nothing similar -> no duplicate fields; a failing check never blocks creating', async () => {
  const db = fixture()
  const plain = await createTask(db as never, { project: 'P', title: 'Something else entirely', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals('possible_duplicates' in plain, false)
  db.rpcHandlers.find_possible_duplicates = () => ({ data: null, error: { message: 'boom' } })
  const still = await createTask(db as never, { project: 'P', title: 'TST-BE-01 — x', agent_name: 'claude' }) as Record<string, unknown>
  assert(still.key)
  assertEquals('possible_duplicates' in still, false)
})

Deno.test('update_task: a new title is checked, the task itself excluded', async () => {
  const db = fixture()
  db.rpcHandlers.edit_task_text = () => ({ data: { edit_mode: 'in_place' }, error: null })
  const out = await updateTask(db as never, { task: 'P-2', title: 'TST-BE-01 — Login API', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals((out.possible_duplicates as { key: string }[]).map((d) => d.key), ['P-1'])
  const call = db.rpcCalls.find((c) => c.fn === 'find_possible_duplicates')!
  assertEquals(call.params.p_exclude, B)
})

Deno.test('resolve duplicate with data left on `other`: nothing done, the data listed, new_version suggested', async () => {
  const db = fixture()
  db.rpcHandlers.resolve_duplicate = () => ({
    data: { action: 'duplicate', done: false, needs_confirmation: 'data', keep: 'P-1', other: 'P-2', suggestion: 'new_version',
      other_holds: { attachments: [{ path: 'x', name: 'spec.pdf' }], live_comments: 2, open_subtasks: ['P-7'] } },
    error: null,
  })
  const out = await resolveDuplicate(db as never, { keep: 'P-1', other: 'P-2', action: 'duplicate', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(out.done, false)
  for (const bit of ['spec.pdf', '2 live comment', 'P-7', 'new_version', 'confirm_data_loss']) assertStringIncludes(String(out.message), bit)
})

Deno.test('resolve on a task in work: an owner request is filed; once approved the repeat carries it out', async () => {
  const db = fixture()
  let approvedRun = false
  db.rpcHandlers.resolve_duplicate = (p) => {
    if (p.p_approved) {
      approvedRun = true
      return { data: { action: 'new_version', done: true, keep: 'P-1', archived: 'P-2', moved_subtasks: ['P-7'], moved_attachments: 1 }, error: null }
    }
    return { data: { action: 'new_version', done: false, needs_owner_request: true, keep: 'P-1', other: 'P-2', started_by: 'Dev', started_at: '2026-11-10T00:00:00Z', signal: 'take_in_work' }, error: null }
  }
  const filed = await resolveDuplicate(db as never, { keep: 'P-1', other: 'P-2', action: 'new_version', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(filed.status, 'awaiting_owner_approval')
  assertStringIncludes(String(filed.why), 'Dev started it')
  const req = db.tables.owner_requests[0]
  assertEquals([req.request_type, req.task_id, (req.params as Record<string, unknown>).action], ['resolve_duplicate', B, 'new_version'])
  assertEquals((req.preview as Record<string, unknown>).started_by, 'Dev')

  Object.assign(req, { status: 'approved', decided_by: 'boss' })
  const done = await resolveDuplicate(db as never, { keep: 'P-1', other: 'P-2', action: 'new_version', request_id: 1, agent_name: 'claude' }) as Record<string, unknown>
  assertEquals([done.done, done.archived, approvedRun], [true, 'P-2', true])
  assert(db.tables.agent_audit_log.some((r) => r.action_type === 'resolve_duplicate'))
})

Deno.test('list_possible_duplicates: pairs with the hint', async () => {
  const db = fixture()
  db.rpcHandlers.list_possible_duplicates = () => ({ data: [{ key_a: 'P-1', title_a: 'a', status_a: 'todo', key_b: 'P-2', title_b: 'b', status_b: 'todo', similarity: 0.9, reason: 'same code TST-BE-01', same_epic: true }], error: null })
  const out = await listPossibleDuplicates(db as never, { project: 'P' })
  assertEquals(out.count, 1)
  assertStringIncludes(String(out.hint), 'resolve_duplicate')
})
