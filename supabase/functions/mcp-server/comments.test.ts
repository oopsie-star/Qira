// Stage 3 — comments are archived, not deleted; agents edit only their own.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 comments.test.ts

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { FakeAdmin, fakeSetCommentArchived, fakeUpdateCommentBody } from './testing/fakeAdmin.ts'
import { archiveComment, restoreComment, updateComment } from './tools/commentArchive.ts'
import { ToolError } from './tools/errors.ts'
import { getTask } from './tools/getTask.ts'

const PROJECT = 'p-1'
const TASK = 't-1'
const C_PERSON = '11111111-1111-4111-8111-111111111111'
const C_CLAUDE = '22222222-2222-4222-8222-222222222222'
const C_CHATGPT = '33333333-3333-4333-8333-333333333333'
const C_OLD = '44444444-4444-4444-8444-444444444444'

function fixture(extraAudit: Record<string, unknown>[] = []) {
  Deno.env.set('MCP_AGENT_EMAIL', 'mcp-agent@test')
  const db = new FakeAdmin({
    projects: [{ id: PROJECT, key: 'P', name: 'P' }],
    profiles: [
      { id: 'agent', email: 'mcp-agent@test' },
      { id: 'anna', email: 'anna@test' },
    ],
    tasks: [{
      id: TASK, project_id: PROJECT, key: 'P-1', title: 'T', description: 'd', status: 'in_progress',
      issue_type: 'task', priority: 'medium', epic_id: null, sprint_id: null, assignee_id: null, reporter_id: null,
      assignee_ids: [], due_date: null, attachments: [], archived_attachments: [],
      created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    }],
    task_comments: [
      { id: C_PERSON, project_id: PROJECT, task_id: TASK, author_id: 'anna', body: 'person says', created_at: '2026-11-01T01:00:00Z', archived_at: null },
      { id: C_CLAUDE, project_id: PROJECT, task_id: TASK, author_id: 'agent', body: 'claude says', created_at: '2026-11-01T02:00:00Z', archived_at: null },
      { id: C_CHATGPT, project_id: PROJECT, task_id: TASK, author_id: 'agent', body: 'gpt says', created_at: '2026-11-01T03:00:00Z', archived_at: null },
      {
        id: C_OLD, project_id: PROJECT, task_id: TASK, author_id: 'anna', body: 'old note', created_at: '2026-10-01T00:00:00Z',
        archived_at: '2026-11-02T00:00:00Z', archived_by: 'anna', archived_by_agent: null, folded_into_description: true,
      },
    ],
    task_activities: [],
    task_field_changes: [],
    attachment_notes: [],
    task_links: [],
    agent_audit_log: [
      // Newest first, as the gate's order('created_at', desc) returns them (the fake does not sort).
      { agent_name: 'chatgpt', action_type: 'add_comment', task_id: TASK, result: { id: C_CHATGPT }, created_at: '2026-11-01T03:00:00Z' },
      { agent_name: 'claude', action_type: 'add_comment', task_id: TASK, result: { id: C_CLAUDE }, created_at: '2026-11-01T02:00:00Z' },
      ...extraAudit,
    ],
  })
  db.rpcHandlers.set_comment_archived = fakeSetCommentArchived
  db.rpcHandlers.update_comment_body = fakeUpdateCommentBody
  return db
}

const comment = (db: FakeAdmin, id: string) => db.tables.task_comments.find((c) => c.id === id)!

// ── get_task ──────────────────────────────────────────────────────────────────

Deno.test('get_task returns only live comments, each with its id, and counts the archived', async () => {
  const result = await getTask(fixture() as never, { task: 'P-1' }) as Record<string, unknown>
  const comments = result.comments as { id: string; body: string }[]
  assertEquals(comments.map((c) => c.id), [C_PERSON, C_CLAUDE, C_CHATGPT])
  assertEquals(result.archived_comments_count, 1)
  assertEquals(result.archived_comments, undefined)
})

Deno.test('get_task with include_archived lists archived comments with who, when and why', async () => {
  const result = await getTask(fixture() as never, { task: 'P-1', include_archived: true }) as Record<string, unknown>
  assertEquals((result.comments as unknown[]).length, 3)
  assertEquals(result.archived_comments, [{
    id: C_OLD,
    author_email: 'anna@test',
    body: 'old note',
    created_at: '2026-10-01T00:00:00Z',
    archived_at: '2026-11-02T00:00:00Z',
    archived_by_email: 'anna@test',
    archived_by_agent: null,
    folded_into_description: true,
    reason: null,
  }])
})

// ── archive_comment / restore_comment ─────────────────────────────────────────

Deno.test('archive_comment archives through the RPC, deletes nothing, and leaves the comment out of get_task', async () => {
  const db = fixture()
  const out = await archiveComment(db as never, { comment: C_PERSON, agent_name: 'chatgpt' })
  assertEquals(out.changed, true)
  assertEquals(out.task_key, 'P-1')
  assertEquals(db.deleted.length, 0)
  assertEquals(comment(db, C_PERSON).archived_by_agent, 'chatgpt')
  assertEquals(comment(db, C_PERSON).archived_by, 'agent')
  const after = await getTask(db as never, { task: 'P-1' }) as Record<string, unknown>
  assertEquals((after.comments as { id: string }[]).map((c) => c.id), [C_CLAUDE, C_CHATGPT])
  assertEquals(after.archived_comments_count, 2)
  const audit = db.inserted.filter((i) => i.table === 'agent_audit_log').map((i) => i.row.action_type)
  assertEquals(audit, ['archive_comment'])
  const activity = db.inserted.filter((i) => i.table === 'task_activities').map((i) => i.row.message)
  assertEquals(activity, ['Archived a comment'])
})

Deno.test('archive_comment with folded_into_description records the reason', async () => {
  const db = fixture()
  const out = await archiveComment(db as never, { comment: C_PERSON, folded_into_description: true, agent_name: 'chatgpt' })
  assertEquals(out.folded_into_description, true)
  assertEquals(comment(db, C_PERSON).folded_into_description, true)
})

Deno.test("archive_comment sends the reason, and the author of a person's comment is notified", async () => {
  const db = fixture()
  const out = await archiveComment(db as never, {
    comment: C_PERSON, folded_into_description: true, reason: '  moved into the acceptance criteria  ', agent_name: 'chatgpt',
  })
  assertEquals(db.rpcCalls[0].params.p_reason, 'moved into the acceptance criteria')
  assertEquals(out.reason, 'moved into the acceptance criteria')
  assertEquals(db.tables.notifications, [{ profile_id: 'anna', task_id: TASK, folded: true, reason: 'moved into the acceptance criteria' }])
  const after = await getTask(db as never, { task: 'P-1', include_archived: true }) as Record<string, unknown>
  const archived = (after.archived_comments as { id: string; reason: string | null }[]).find((c) => c.id === C_PERSON)
  assertEquals(archived?.reason, 'moved into the acceptance criteria')
})

Deno.test("archiving an agent's own comment notifies no one, and restore sends no reason", async () => {
  const db = fixture()
  await archiveComment(db as never, { comment: C_CHATGPT, reason: 'superseded', agent_name: 'chatgpt' })
  assertEquals(db.tables.notifications, undefined)
  await restoreComment(db as never, { comment: C_CHATGPT, reason: 'ignored', agent_name: 'chatgpt' })
  assertEquals(db.rpcCalls[1].params.p_reason, null)
})

Deno.test('archive_comment twice is a no-op the second time, with no second activity row', async () => {
  const db = fixture()
  await archiveComment(db as never, { comment: C_PERSON, agent_name: 'chatgpt' })
  const again = await archiveComment(db as never, { comment: C_PERSON, agent_name: 'chatgpt' })
  assertEquals(again.changed, false)
  assertEquals(db.inserted.filter((i) => i.table === 'task_activities').length, 1)
})

Deno.test('restore_comment brings a folded comment back and clears the folded mark', async () => {
  const db = fixture()
  const out = await restoreComment(db as never, { comment: C_OLD, agent_name: 'chatgpt' })
  assertEquals(out.changed, true)
  assertEquals(comment(db, C_OLD).archived_at, null)
  assertEquals(comment(db, C_OLD).folded_into_description, false)
  const after = await getTask(db as never, { task: 'P-1' }) as Record<string, unknown>
  assertEquals(after.archived_comments_count, 0)
})

Deno.test('archive_comment is gated when another agent last touched the task', async () => {
  // The last agent on the task is chatgpt (its add_comment); claude must confirm.
  const db = fixture()
  await assertRejects(() => archiveComment(db as never, { comment: C_PERSON, agent_name: 'claude' }), ToolError, 'last modified by chatgpt')
  assertEquals(db.rpcCalls.length, 0)
  const ok = await archiveComment(db as never, { comment: C_PERSON, agent_name: 'claude', confirmed_cross_agent: true })
  assertEquals(ok.changed, true)
})

Deno.test('archive_comment rejects a non-id and an unknown comment before calling the RPC', async () => {
  const db = fixture()
  await assertRejects(() => archiveComment(db as never, { comment: 'P-1', agent_name: 'chatgpt' }), ToolError, 'not a comment id')
  await assertRejects(
    () => archiveComment(db as never, { comment: '99999999-9999-4999-8999-999999999999', agent_name: 'chatgpt' }),
    ToolError,
    'does not exist',
  )
  assertEquals(db.rpcCalls.length, 0)
})

// ── update_comment ────────────────────────────────────────────────────────────

Deno.test('update_comment rewrites the agent\'s own comment and keeps the old text', async () => {
  const db = fixture()
  const out = await updateComment(db as never, { comment: C_CHATGPT, body: '  gpt says, corrected  ', agent_name: 'chatgpt' })
  assertEquals(out.changed, true)
  assertEquals(comment(db, C_CHATGPT).body, 'gpt says, corrected')
  assertEquals(db.tables.task_comment_edits, [{
    comment_id: C_CHATGPT, old_body: 'gpt says', new_body: 'gpt says, corrected', edited_by: 'agent', edited_by_agent: 'chatgpt',
  }])
})

Deno.test('update_comment refuses a person\'s comment, even with confirmed_cross_agent', async () => {
  const db = fixture()
  await assertRejects(
    () => updateComment(db as never, { comment: C_PERSON, body: 'x', agent_name: 'chatgpt', confirmed_cross_agent: true }),
    ToolError,
    'written by a person',
  )
  assertEquals(comment(db, C_PERSON).body, 'person says')
  assertEquals(db.rpcCalls.length, 0)
})

Deno.test('update_comment refuses another agent\'s comment until confirmed', async () => {
  const db = fixture()
  await assertRejects(
    () => updateComment(db as never, { comment: C_CLAUDE, body: 'gpt rewrote it', agent_name: 'chatgpt' }),
    ToolError,
    'written by claude',
  )
  assertEquals(comment(db, C_CLAUDE).body, 'claude says')
  const ok = await updateComment(db as never, { comment: C_CLAUDE, body: 'gpt rewrote it', agent_name: 'chatgpt', confirmed_cross_agent: true })
  assertEquals(ok.changed, true)
})

Deno.test('update_comment refuses an archived comment and an empty body', async () => {
  const db = fixture()
  await assertRejects(() => updateComment(db as never, { comment: C_CHATGPT, body: '   ', agent_name: 'chatgpt' }), ToolError, '"body" is required')
  await archiveComment(db as never, { comment: C_CHATGPT, agent_name: 'chatgpt' })
  await assertRejects(() => updateComment(db as never, { comment: C_CHATGPT, body: 'new', agent_name: 'chatgpt' }), ToolError, 'is archived')
})

Deno.test('update_comment with identical text changes nothing and records no edit', async () => {
  const db = fixture()
  const out = await updateComment(db as never, { comment: C_CHATGPT, body: 'gpt says', agent_name: 'chatgpt' })
  assertEquals(out.changed, false)
  assertEquals(db.tables.task_comment_edits, undefined)
  assertEquals(db.inserted.filter((i) => i.table === 'task_activities').length, 0)
})
