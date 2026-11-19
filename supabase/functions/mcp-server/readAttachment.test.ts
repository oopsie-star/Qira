// read_attachment goes through public.file_gate — the same check the file
// gateway uses. The SQL decision itself is proven live in TEST; here: MCP asks
// the gate first, reads from the bucket the gate names, and answers a refusal
// the same way whatever the reason.
//
// Run: deno test --no-check --allow-env readAttachment.test.ts

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { FakeAdmin } from './testing/fakeAdmin.ts'
import { ToolError } from './tools/errors.ts'
import { readAttachment } from './tools/readAttachment.ts'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const TASK = '22222222-2222-4222-8222-222222222222'
const AUTHOR = '55555555-5555-4555-8555-555555555555'
const LIVE = `${PROJECT}/${TASK}/${AUTHOR}/1-scan.pdf`
const ARCHIVED = `${PROJECT}/${TASK}/${AUTHOR}/2-old.pdf`
const JIRA = `${PROJECT}/${TASK}/report.docx`

function fixture() {
  Deno.env.set('MCP_AGENT_EMAIL', 'mcp-agent@test')
  const db = new FakeAdmin({ profiles: [{ id: 'agent', email: 'mcp-agent@test' }] })
  db.rpcHandlers.file_gate = (p) => {
    const path = p.p_path as string
    if (p.p_channel !== 'mcp' || p.p_purpose !== 'view' || p.p_actor !== 'agent') return { data: { ok: false }, error: null }
    if (path === LIVE) return { data: { ok: true, path, bucket: 'attachments', name: 'scan.pdf', mime_type: 'application/pdf', size_bytes: 3 }, error: null }
    if (path === JIRA) return { data: { ok: true, path, bucket: 'task-attachments', name: null, mime_type: null, size_bytes: null }, error: null }
    return { data: { ok: false }, error: null }
  }
  db.files.set(`attachments/${LIVE}`, new Uint8Array([1, 2, 3]))
  db.files.set(`attachments/${ARCHIVED}`, new Uint8Array([4]))
  db.files.set(`task-attachments/${JIRA}`, new Uint8Array([5, 6]))
  return db
}

Deno.test('a live file is read after the gate says yes, as the MCP agent', async () => {
  const db = fixture()
  const out = await readAttachment(db as never, { path: LIVE, agent_name: 'claude' })
  assertEquals([out.name, out.mime_type, out.content_base64], ['scan.pdf', 'application/pdf', btoa('\x01\x02\x03')])
  const call = db.rpcCalls.find((c) => c.fn === 'file_gate')!
  assertEquals([call.params.p_channel, call.params.p_agent], ['mcp', 'claude'])
})

Deno.test('an archived file is refused, though storage still has it', async () => {
  const db = fixture()
  await assertRejects(() => readAttachment(db as never, { path: ARCHIVED }), ToolError, 'is not available')
})

Deno.test('a path nothing has attached is refused with the same words', async () => {
  const db = fixture()
  await assertRejects(() => readAttachment(db as never, { path: `${PROJECT}/${TASK}/${AUTHOR}/9-nope.pdf` }), ToolError, 'is not available')
})

Deno.test('a Jira import is read from the bucket the gate names', async () => {
  const db = fixture()
  const out = await readAttachment(db as never, { path: JIRA })
  assertEquals(out.content_base64, btoa('\x05\x06'))
})

Deno.test('too big by the note: refused before downloading', async () => {
  const db = fixture()
  db.rpcHandlers.file_gate = () => ({ data: { ok: true, path: LIVE, bucket: 'attachments', size_bytes: 50 * 1024 * 1024 }, error: null })
  await assertRejects(() => readAttachment(db as never, { path: LIVE }), ToolError, 'exceeds')
})
