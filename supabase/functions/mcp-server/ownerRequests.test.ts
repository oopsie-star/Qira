// Stage 4b — owner requests as MCP sees them. The checks that matter (owner,
// one use, same params, the trigger re-reading the request) are SQL and are
// proven live in TEST; these fakes mirror that SQL so the MCP flow around it —
// file, wait, repeat, nothing half-done, files removed only after — is tested.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 ownerRequests.test.ts

import { assertEquals, assertRejects, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { FakeAdmin, installOwnerRequestFakes } from './testing/fakeAdmin.ts'
import { ToolError } from './tools/errors.ts'
import { deleteAttachment, getOwnerRequest, purgeTask, purgeTrash } from './tools/ownerRequests.ts'
import { updateTask } from './tools/updateTask.ts'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const T_STARTED = '22222222-2222-4222-8222-222222222222'
const T_TRASH = '33333333-3333-4333-8333-333333333333'
const T_SUB = '44444444-4444-4444-8444-444444444444'
const AUTHOR = '55555555-5555-4555-8555-555555555555'
const FILE = `${PROJECT}/${T_STARTED}/${AUTHOR}/1-old.zip`
const TRASH_FILE = `${PROJECT}/${T_TRASH}/${AUTHOR}/2-x.pdf`

function task(id: string, key: string, extra: Record<string, unknown> = {}) {
  return {
    id, project_id: PROJECT, key, title: `title ${key}`, description: 'old text', status: 'in_progress',
    issue_type: 'task', priority: 'medium', epic_id: null, sprint_id: null, assignee_id: null, reporter_id: null,
    assignee_ids: [], due_date: null, attachments: [], archived_attachments: [], parent_task_id: null,
    work_started_at: null, work_started_by: null, work_started_signal: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...extra,
  }
}

function fixture() {
  Deno.env.set('MCP_AGENT_EMAIL', 'mcp-agent@test')
  const db = new FakeAdmin({
    projects: [{ id: PROJECT, key: 'P', name: 'P' }],
    profiles: [{ id: 'agent', email: 'mcp-agent@test' }, { id: 'boss', email: 'boss@test' }],
    tasks: [
      task(T_STARTED, 'P-1', { work_started_at: '2026-11-10T00:00:00Z', work_started_signal: 'take_in_work', attachments: [FILE] }),
      task(T_TRASH, 'P-2', { status: 'archived', archived_attachments: [TRASH_FILE] }),
      task(T_SUB, 'P-3', { status: 'deleted', parent_task_id: T_TRASH }),
    ],
    attachment_notes: [{ project_id: PROJECT, path: FILE, original_name: 'old.zip', size_bytes: 3, md5: 'a'.repeat(32), archived_at: null }],
    task_comments: [], task_activities: [], task_field_changes: [], task_links: [], agent_audit_log: [],
  })
  // As the SQL: the service role on a started task needs an owner's approval.
  db.rpcHandlers.edit_task_text = () => ({
    data: null,
    error: { message: 'P-1 is already in work.', hint: 'EDIT_POLICY:owner_approval_required — …' } as { message: string },
  })
  installOwnerRequestFakes(db)
  db.files.set(`attachments/${FILE}`, new Uint8Array([1, 2, 3]))
  db.files.set(`attachments/${TRASH_FILE}`, new Uint8Array([4]))
  return db
}

const approve = (db: FakeAdmin, id: number) => {
  const r = db.tables.owner_requests.find((x) => x.id === id)!
  Object.assign(r, { status: 'approved', decided_by: 'boss', decided_at: '2026-11-18T00:00:00Z' })
}

// ── edit_in_place ─────────────────────────────────────────────────────────────

Deno.test('edit: filed, then a repeat while pending says "still waiting" and changes nothing', async () => {
  const db = fixture()
  const first = await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(first.request_id, 1)
  await assertRejects(
    () => updateTask(db as never, { task: 'P-1', description: 'new text', request_id: 1, agent_name: 'claude' }),
    ToolError,
    'still waiting',
  )
  assertEquals(db.tables.tasks[0].description, 'old text')
  // The refused attempt is logged (a refusal is returned, not raised).
  assertEquals(db.tables.owner_request_events.map((e) => e.event), ['refused'])
})

Deno.test('edit: the same call again does not stack a second request', async () => {
  const db = fixture()
  await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' })
  const again = await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(again.request_id, 1)
  assertStringIncludes(String(again.message), 'already filed')
  assertEquals(db.tables.owner_requests.length, 1)
})

Deno.test('edit: approved -> the repeat applies it, the other fields too; then the request is spent', async () => {
  const db = fixture()
  await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' })
  approve(db, 1)
  const out = await updateTask(db as never, { task: 'P-1', description: 'new text', priority: 'high', request_id: 1, agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(out.edit_mode, 'approved')
  assertEquals([db.tables.tasks[0].description, db.tables.tasks[0].priority], ['new text', 'high'])
  await assertRejects(
    () => updateTask(db as never, { task: 'P-1', description: 'new text', request_id: 1, agent_name: 'claude' }),
    ToolError,
    'works once',
  )
})

Deno.test('edit: approved for one text, repeated with another -> refused, nothing applied', async () => {
  const db = fixture()
  await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' })
  approve(db, 1)
  await assertRejects(
    () => updateTask(db as never, { task: 'P-1', description: 'something else', priority: 'high', request_id: 1, agent_name: 'claude' }),
    ToolError,
    'different parameters',
  )
  assertEquals([db.tables.tasks[0].description, db.tables.tasks[0].priority], ['old text', 'medium'])
})

Deno.test('edit: a rejected request is reported as rejected', async () => {
  const db = fixture()
  await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' })
  db.tables.owner_requests[0].status = 'rejected'
  await assertRejects(() => updateTask(db as never, { task: 'P-1', description: 'new text', request_id: 1, agent_name: 'claude' }), ToolError, 'rejected')
})

Deno.test('a request_id that is not a number is refused before anything runs', async () => {
  const db = fixture()
  await assertRejects(() => updateTask(db as never, { task: 'P-1', description: 'x', request_id: 'abc', agent_name: 'claude' }), ToolError, 'request number')
  assertEquals(db.rpcCalls.length, 0)
})

// ── delete_attachment ─────────────────────────────────────────────────────────

Deno.test('delete_attachment: needs a reason, files a request, and deletes the file only once approved', async () => {
  const db = fixture()
  await assertRejects(() => deleteAttachment(db as never, { path: FILE, agent_name: 'claude' }), ToolError, '"reason" is required')
  const first = await deleteAttachment(db as never, { path: FILE, reason: 'contains personal data', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(first.status, 'awaiting_owner_approval')
  assertEquals(db.files.has(`attachments/${FILE}`), true)
  assertEquals((db.tables.owner_requests[0].preview as { files: { name: string }[] }).files[0].name, 'old.zip')

  approve(db, 1)
  const done = await deleteAttachment(db as never, { path: FILE, request_id: 1, agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(done.storage, { removed: 1, failed: [] })
  assertEquals(db.files.has(`attachments/${FILE}`), false)
  assertEquals(db.tables.tasks[0].attachments, [])
})

// ── purge_task / purge_trash ──────────────────────────────────────────────────

Deno.test('purge_task: refuses a live task, and a trashed task with a live subtask', async () => {
  const db = fixture()
  await assertRejects(() => purgeTask(db as never, { task: 'P-1', reason: 'x', agent_name: 'claude' }), ToolError, 'archive it first')
  db.tables.tasks[2].status = 'todo'
  await assertRejects(() => purgeTask(db as never, { task: 'P-2', reason: 'x', agent_name: 'claude' }), ToolError, 'live subtasks (P-3)')
  assertEquals(db.rpcCalls.length, 0)
})

Deno.test('purge_task: lists the task and its trashed subtasks; once approved deletes them and their files', async () => {
  const db = fixture()
  const first = await purgeTask(db as never, { task: 'P-2', reason: 'duplicate import', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(first.status, 'awaiting_owner_approval')
  assertEquals((db.tables.owner_requests[0].preview as { tasks: { key: string }[] }).tasks.map((t) => t.key), ['P-2', 'P-3'])
  assertEquals(db.tables.tasks.length, 3)

  approve(db, 1)
  const done = await purgeTask(db as never, { task: 'P-2', request_id: 1, agent_name: 'claude' }) as Record<string, unknown>
  assertEquals((done.deleted as string[]).sort(), ['P-2', 'P-3'])
  assertEquals(db.tables.tasks.map((t) => t.key), ['P-1'])
  assertEquals(db.files.has(`attachments/${TRASH_FILE}`), false)
})

Deno.test('purge_trash: the list is fixed when filed; the repeat carries out exactly that list', async () => {
  const db = fixture()
  const first = await purgeTrash(db as never, { project: 'P', reason: 'quarterly cleanup', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(first.status, 'awaiting_owner_approval')
  const listed = (db.tables.owner_requests[0].params as { task_ids: string[] }).task_ids
  assertEquals(listed, [T_TRASH, T_SUB])
  // Something new lands in the trash after filing: it is NOT purged.
  db.tables.tasks.push(task('66666666-6666-4666-8666-666666666666', 'P-9', { status: 'archived' }))
  approve(db, 1)
  await purgeTrash(db as never, { project: 'P', request_id: 1, agent_name: 'claude' })
  assertEquals(db.tables.tasks.map((t) => t.key).sort(), ['P-1', 'P-9'])
})

Deno.test('get_owner_request reports the state and who decided', async () => {
  const db = fixture()
  await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' })
  approve(db, 1)
  const out = await getOwnerRequest(db as never, { request_id: 1 })
  assertEquals([out.status, out.decided_by, out.type], ['approved', 'boss@test', 'edit_in_place'])
})
