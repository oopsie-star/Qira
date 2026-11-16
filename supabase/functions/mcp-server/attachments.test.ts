// Stage 2 — attachments are archived, not deleted; uploads carry a checksum and
// can arrive in chunks.

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'

import { FakeAdmin, fakeSetAttachmentArchived } from './testing/fakeAdmin.ts'
import { archiveAttachment, restoreAttachment } from './tools/archiveAttachment.ts'
import { attachTaskFile } from './tools/attachTaskFile.ts'
import { getTask } from './tools/getTask.ts'
import { replaceAttachment } from './tools/replaceAttachment.ts'
import { md5Hex } from './tools/uploadPipeline.ts'
import { ToolError } from './tools/errors.ts'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const TASK = '22222222-2222-4222-8222-222222222222'
const OTHER_TASK = '33333333-3333-4333-8333-333333333333'
const AGENT = '44444444-4444-4444-8444-444444444444'
const LIVE = `${PROJECT}/${TASK}/${AGENT}/1-package-v1.zip`
const OLD = `${PROJECT}/${TASK}/${AGENT}/0-package-v0.zip`

const bytesOf = (text: string) => new TextEncoder().encode(text)

function fixture() {
  Deno.env.set('MCP_AGENT_EMAIL', 'mcp-agent@test')
  const admin = new FakeAdmin({
    projects: [{ id: PROJECT, key: 'MOMNA', name: 'Momna' }],
    profiles: [{ id: AGENT, email: 'mcp-agent@test' }],
    tasks: [
      {
        id: TASK, project_id: PROJECT, key: 'MOMNA-1071', title: 'Content package', description: 'd', status: 'in_progress',
        issue_type: 'task', priority: 'high', epic_id: null, sprint_id: null, assignee_id: null, reporter_id: null,
        assignee_ids: [], due_date: null, attachments: [LIVE, OLD], archived_attachments: [],
        created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
      },
      {
        id: OTHER_TASK, project_id: PROJECT, key: 'MOMNA-9', title: 'Other', description: '', status: 'todo',
        issue_type: 'task', priority: 'low', epic_id: null, sprint_id: null, assignee_id: null, reporter_id: null,
        assignee_ids: [], due_date: null, attachments: [], archived_attachments: [],
        created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
      },
    ],
    attachment_notes: [
      { project_id: PROJECT, path: LIVE, original_name: 'package-v1.zip', mime_type: 'application/zip', size_bytes: 10, md5: 'a'.repeat(32) },
      { project_id: PROJECT, path: OLD, original_name: 'package-v0.zip', mime_type: 'application/zip', size_bytes: 8, md5: 'b'.repeat(32) },
    ],
    task_comments: [],
    task_activities: [],
    task_field_changes: [],
    agent_audit_log: [],
    task_links: [],
  })
  admin.rpcHandlers.set_attachment_archived = fakeSetAttachmentArchived
  return admin
}

const task = (admin: FakeAdmin, id = TASK) => admin.tables.tasks.find((t) => t.id === id) as Record<string, string[]>

// ── archive / restore ─────────────────────────────────────────────────────────

Deno.test('archive_attachment moves the file out of the live list into the archive, and records who', async () => {
  const admin = fixture()
  const outcome = await archiveAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  assertEquals(outcome.changed, true)
  assertEquals(task(admin).attachments, [LIVE])
  assertEquals(task(admin).archived_attachments, [OLD])
  // The call names its actor and agent; the database stamps them.
  assertEquals(admin.rpcCalls[0].params, { p_path: OLD, p_archived: true, p_actor: AGENT, p_agent: 'claude' })
  const note = admin.tables.attachment_notes.find((n) => n.path === OLD)!
  assertEquals([note.archived_by, note.archived_by_agent], [AGENT, 'claude'])
  assertEquals(admin.inserted.filter((i) => i.table === 'agent_audit_log').map((i) => i.row.action_type), ['archive_attachment'])
})

Deno.test('archiving twice is harmless: the second call reports no change', async () => {
  const admin = fixture()
  await archiveAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  const again = await archiveAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  assertEquals(again.changed, false)
  assertEquals(task(admin).archived_attachments, [OLD])
})

Deno.test('restore_attachment brings an archived file back in one call', async () => {
  const admin = fixture()
  await archiveAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  const outcome = await restoreAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  assertEquals(outcome.changed, true)
  assertEquals(task(admin).attachments, [LIVE, OLD])
  assertEquals(task(admin).archived_attachments, [])
})

Deno.test('archiving a path that is attached nowhere is refused', async () => {
  await assertRejects(
    () => archiveAttachment(fixture() as never, { path: `${PROJECT}/${TASK}/${AGENT}/9-ghost.zip`, agent_name: 'claude' }),
    ToolError,
    'not attached to any task',
  )
})

// ── get_task ──────────────────────────────────────────────────────────────────

Deno.test('get_task by default lists live files only, each with size and md5, plus a count of archived ones', async () => {
  const admin = fixture()
  await archiveAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  const result = await getTask(admin as never, { task: 'MOMNA-1071' }) as Record<string, unknown>
  assertEquals(result.attachments, [{ path: LIVE, name: 'package-v1.zip', mime_type: 'application/zip', size_bytes: 10, md5: 'a'.repeat(32) }])
  assertEquals(result.archived_attachments_count, 1)
  assertEquals('archived_attachments' in result, false)
})

Deno.test('get_task with include_archived lists archived files separately: when, by whom, size, md5', async () => {
  const admin = fixture()
  await archiveAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  const result = await getTask(admin as never, { task: 'MOMNA-1071', include_archived: true }) as Record<string, unknown>
  assertEquals(result.archived_attachments, [{
    path: OLD,
    name: 'package-v0.zip',
    mime_type: 'application/zip',
    archived_at: '2026-11-16T12:00:00Z',
    archived_by_email: 'mcp-agent@test',
    archived_by_agent: 'claude',
    size_bytes: 8,
    md5: 'b'.repeat(32),
  }])
})

// ── upload integrity ──────────────────────────────────────────────────────────

Deno.test('attach_task_file reports the size and md5 it stored, and records them on the file', async () => {
  const admin = fixture()
  const content = bytesOf('hello qira')
  const result = await attachTaskFile(admin as never, { task: 'MOMNA-1071', filename: 'note.txt', content_base64: encodeBase64(content), agent_name: 'claude' })
  assertEquals(result.size, content.byteLength)
  assertEquals(result.md5, await md5Hex(content))
  const note = admin.tables.attachment_notes.find((n) => n.path === result.path)!
  assertEquals([note.size_bytes, note.md5], [content.byteLength, await md5Hex(content)])
})

Deno.test('a file whose md5 does not match expected_md5 is not saved anywhere', async () => {
  const admin = fixture()
  const before = [...task(admin).attachments]
  await assertRejects(
    () => attachTaskFile(admin as never, {
      task: 'MOMNA-1071', filename: 'note.txt', content_base64: encodeBase64(bytesOf('hello qira')),
      expected_md5: '0'.repeat(32), agent_name: 'claude',
    }),
    ToolError,
    'MD5 mismatch',
  )
  assertEquals(admin.files.size, 0)
  assertEquals(task(admin).attachments, before)
})

Deno.test('a matching expected_md5 is accepted', async () => {
  const admin = fixture()
  const content = bytesOf('hello qira')
  const result = await attachTaskFile(admin as never, {
    task: 'MOMNA-1071', filename: 'note.txt', content_base64: encodeBase64(content), expected_md5: await md5Hex(content), agent_name: 'claude',
  })
  assertEquals(task(admin).attachments.includes(result.path as string), true)
})

Deno.test('the audit log keeps what the call was, not the file it carried', async () => {
  const admin = fixture()
  const content = bytesOf('x'.repeat(5000))
  await attachTaskFile(admin as never, { task: 'MOMNA-1071', filename: 'big.txt', content_base64: encodeBase64(content), agent_name: 'claude' })
  const payload = admin.inserted.find((i) => i.table === 'agent_audit_log')!.row.payload as Record<string, unknown>
  assertEquals(String(payload.content_base64).startsWith('<'), true)
  assertEquals(String(payload.content_base64).length < 40, true)
})

// ── chunked upload ────────────────────────────────────────────────────────────

function split(content: Uint8Array, parts: number) {
  const size = Math.ceil(content.byteLength / parts)
  return Array.from({ length: parts }, (_, i) => content.slice(i * size, (i + 1) * size))
}

Deno.test('a file sent in chunks is assembled exactly, checked, attached on the last chunk, and the chunks cleaned up', async () => {
  const admin = fixture()
  const content = bytesOf('0123456789'.repeat(30))
  const chunks = split(content, 3)
  const expected_md5 = await md5Hex(content)
  const base = { task: 'MOMNA-1071', filename: 'pkg.zip', total_chunks: 3, expected_md5, agent_name: 'claude' as const }

  const first = await attachTaskFile(admin as never, { ...base, chunk_index: 0, content_base64: encodeBase64(chunks[0]) })
  assertEquals(first.pending, true)
  const upload_id = first.upload_id as string
  const second = await attachTaskFile(admin as never, { ...base, chunk_index: 1, upload_id, content_base64: encodeBase64(chunks[1]) })
  assertEquals(second.received_chunks, [0, 1])
  const attachedBefore = task(admin).attachments.length

  const last = await attachTaskFile(admin as never, { ...base, chunk_index: 2, upload_id, content_base64: encodeBase64(chunks[2]) })
  assertEquals(last.md5, expected_md5)
  assertEquals(last.size, content.byteLength)
  assertEquals(task(admin).attachments.length, attachedBefore + 1)
  const stored = admin.files.get(`attachments/${last.path}`)!
  assertEquals([...stored], [...content])
  assertEquals([...admin.files.keys()].some((k) => k.includes('_uploads/')), false)
})

Deno.test('chunks that assemble to the wrong md5 attach nothing and leave no chunks behind', async () => {
  const admin = fixture()
  const content = bytesOf('abcdefghij'.repeat(10))
  const chunks = split(content, 2)
  const base = { task: 'MOMNA-1071', filename: 'pkg.zip', total_chunks: 2, expected_md5: 'f'.repeat(32), agent_name: 'claude' as const }
  const first = await attachTaskFile(admin as never, { ...base, chunk_index: 0, content_base64: encodeBase64(chunks[0]) })
  const before = task(admin).attachments.length
  await assertRejects(
    () => attachTaskFile(admin as never, { ...base, chunk_index: 1, upload_id: first.upload_id as string, content_base64: encodeBase64(chunks[1]) }),
    ToolError,
    'MD5 mismatch',
  )
  assertEquals(task(admin).attachments.length, before)
  assertEquals(admin.files.size, 0)
})

Deno.test('a corrupted chunk is rejected on its own and can be resent', async () => {
  const admin = fixture()
  const content = bytesOf('abcdefghij'.repeat(10))
  const chunks = split(content, 2)
  const base = { task: 'MOMNA-1071', filename: 'pkg.zip', total_chunks: 2, agent_name: 'claude' as const }
  const first = await attachTaskFile(admin as never, { ...base, chunk_index: 0, content_base64: encodeBase64(chunks[0]) })
  const upload_id = first.upload_id as string
  await assertRejects(
    () => attachTaskFile(admin as never, { ...base, chunk_index: 1, upload_id, chunk_md5: '0'.repeat(32), content_base64: encodeBase64(chunks[1]) }),
    ToolError,
    'chunk 1',
  )
  const retry = await attachTaskFile(admin as never, { ...base, chunk_index: 1, upload_id, chunk_md5: await md5Hex(chunks[1]), content_base64: encodeBase64(chunks[1]) })
  assertEquals(retry.md5, await md5Hex(content))
})

Deno.test('an upload opened for one task cannot be finished into another', async () => {
  const admin = fixture()
  const chunks = split(bytesOf('abcdefghij'.repeat(10)), 2)
  const first = await attachTaskFile(admin as never, { task: 'MOMNA-1071', filename: 'pkg.zip', total_chunks: 2, chunk_index: 0, content_base64: encodeBase64(chunks[0]), agent_name: 'claude' })
  await assertRejects(
    () => attachTaskFile(admin as never, { task: 'MOMNA-9', filename: 'pkg.zip', total_chunks: 2, chunk_index: 1, upload_id: first.upload_id as string, content_base64: encodeBase64(chunks[1]), agent_name: 'claude' }),
    ToolError,
    'different target',
  )
})

// ── replace ───────────────────────────────────────────────────────────────────

Deno.test('replace_attachment uploads the new version under the old name and archives the old file', async () => {
  const admin = fixture()
  const content = bytesOf('package v2')
  const result = await replaceAttachment(admin as never, { old_path: LIVE, content_base64: encodeBase64(content), expected_md5: await md5Hex(content), agent_name: 'claude' })
  assertEquals(result.name, 'package-v1.zip')
  assertEquals(result.old_archived, true)
  assertEquals(task(admin).attachments.includes(LIVE), false)
  assertEquals(task(admin).attachments.includes(result.path as string), true)
  assertEquals(task(admin).archived_attachments, [LIVE])
})

Deno.test('replace_attachment with a bad checksum leaves the old file live and nothing new attached', async () => {
  const admin = fixture()
  await assertRejects(
    () => replaceAttachment(admin as never, { old_path: LIVE, content_base64: encodeBase64(bytesOf('package v2')), expected_md5: '0'.repeat(32), agent_name: 'claude' }),
    ToolError,
    'MD5 mismatch',
  )
  assertEquals(task(admin).attachments, [LIVE, OLD])
  assertEquals(task(admin).archived_attachments, [])
})

Deno.test('replace_attachment refuses a file that is already archived', async () => {
  const admin = fixture()
  await archiveAttachment(admin as never, { path: OLD, agent_name: 'claude' })
  await assertRejects(
    () => replaceAttachment(admin as never, { old_path: OLD, content_base64: encodeBase64(bytesOf('x')), agent_name: 'claude' }),
    ToolError,
    'already archived',
  )
})

Deno.test('replace_attachment finds a file that a revision moved to another task (its path still names the old one)', async () => {
  const admin = fixture()
  // As create_task_revision leaves it: LIVE moved from TASK to OTHER_TASK, path unchanged.
  task(admin).attachments = [OLD]
  task(admin, OTHER_TASK).attachments = [LIVE]
  const content = bytesOf('package v2')
  const result = await replaceAttachment(admin as never, { old_path: LIVE, content_base64: encodeBase64(content), agent_name: 'claude' })
  assertEquals(task(admin, OTHER_TASK).attachments, [result.path as string])
  assertEquals(task(admin, OTHER_TASK).archived_attachments, [LIVE])
  assertEquals((result.path as string).split('/')[1], OTHER_TASK)
  assertEquals(task(admin).attachments, [OLD])
})
