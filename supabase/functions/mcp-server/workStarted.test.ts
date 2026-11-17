// Stage 4a — the edit policy as MCP sees it. The policy itself is SQL
// (task_edit_policy, tasks_enforce_edit_policy); these fakes reproduce what it
// answers so the MCP code around it — refusals shown, nothing half-applied,
// nothing forked — is tested.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 workStarted.test.ts

import { assertEquals, assertRejects, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { FakeAdmin, installOwnerRequestFakes } from './testing/fakeAdmin.ts'
import { createTaskRevision, getEditPolicy, lineDiff, listDescriptionVersions, restoreDescriptionVersion } from './tools/editPolicy.ts'
import { ToolError } from './tools/errors.ts'
import { getTask } from './tools/getTask.ts'
import { updateTask } from './tools/updateTask.ts'
import { updateTaskStatus } from './tools/updateTaskStatus.ts'

const PROJECT = 'p-1'

function task(id: string, key: string, extra: Record<string, unknown> = {}) {
  return {
    id, project_id: PROJECT, key, title: `title ${key}`, description: `line 1\nline 2`, status: 'in_progress',
    issue_type: 'task', priority: 'medium', epic_id: null, sprint_id: null, assignee_id: 'dev', reporter_id: null,
    assignee_ids: [], due_date: null, attachments: ['p-1/x/dev/1-a.zip'], archived_attachments: [],
    work_started_at: null, work_started_by: null, work_started_signal: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...extra,
  }
}

const STARTED = { work_started_at: '2026-11-10T09:00:00Z', work_started_by: 'dev', work_started_signal: 'take_in_work' }

function fixture() {
  Deno.env.set('MCP_AGENT_EMAIL', 'mcp-agent@test')
  const db = new FakeAdmin({
    projects: [{ id: PROJECT, key: 'P', name: 'P' }],
    profiles: [{ id: 'agent', email: 'mcp-agent@test' }, { id: 'dev', email: 'dev@test' }],
    tasks: [task('t-free', 'P-1'), task('t-started', 'P-2', STARTED)],
    task_comments: [
      { id: 'c-take', project_id: PROJECT, task_id: 't-started', author_id: 'dev', body: 'Understood: start with the API', comment_type: 'take_in_work', created_at: '2026-11-10T09:00:00Z', archived_at: null },
      { id: 'c-2', project_id: PROJECT, task_id: 't-started', author_id: 'dev', body: 'question', comment_type: 'comment', created_at: '2026-11-11T09:00:00Z', archived_at: null },
    ],
    task_activities: [],
    task_field_changes: [],
    attachment_notes: [],
    task_links: [],
    agent_audit_log: [],
    task_description_versions: [],
  })

  const byId = (id: unknown) => db.tables.tasks.find((t) => t.id === id)!
  // As the SQL: the service role on a started task needs an owner's approval.
  db.rpcHandlers.task_edit_policy = (params) => {
    const t = byId(params.p_task)
    return {
      data: {
        task_id: t.id, key: t.key, work_started: Boolean(t.work_started_at), started_at: t.work_started_at,
        started_by: t.work_started_by, started_by_name: null, signal: t.work_started_signal, owner: false,
        edit_mode: t.work_started_at ? 'owner_approval_required' : 'in_place',
      },
      error: null,
    }
  }
  db.rpcHandlers.edit_task_text = (params) => {
    const t = byId(params.p_task)
    if (t.work_started_at) {
      return {
        data: null,
        error: {
          message: `${t.key} is already in work: dev started it on 2026-11-10 09:00 UTC (signal: take_in_work). The title and description can no longer be edited in place.`,
          hint: 'EDIT_POLICY:owner_approval_required — create a new revision with create_task_revision, or ask a project owner to edit it in place.',
        } as { message: string },
      }
    }
    const versions = db.tables.task_description_versions
    const next = versions.filter((v) => v.task_id === t.id).length + 1
    if (next === 1) versions.push({ task_id: t.id, version: 1, title: t.title, description: t.description, edited_by: null, edited_by_agent: null, edit_mode: 'original', created_at: '2026-11-01T00:00:00Z' })
    if (params.p_title !== null) t.title = params.p_title
    if (params.p_description !== null) t.description = params.p_description
    versions.push({ task_id: t.id, version: Math.max(next, 2), title: t.title, description: t.description, edited_by: params.p_actor, edited_by_agent: params.p_agent, edit_mode: params.p_mode ?? 'in_place', created_at: '2026-11-17T00:00:00Z' })
    return { data: { task_id: t.id, key: t.key, edit_mode: 'in_place' }, error: null }
  }
  db.rpcHandlers.return_to_todo = (params) => {
    const t = byId(params.p_task)
    t.status = 'todo'
    db.tables.task_comments.push({ id: 'c-back', task_id: t.id, author_id: params.p_actor, body: params.p_comment, comment_type: 'return_to_todo' })
    return { data: { task_id: t.id, key: t.key, status: 'todo' }, error: null }
  }
  db.rpcHandlers.create_task_revision = (params) => {
    const old = byId(params.p_task)
    const files = params.p_attachments as string[]
    db.tables.tasks.push(task('t-new', 'P-3', { title: params.p_title ?? old.title, description: params.p_description ?? old.description, status: 'todo', attachments: files }))
    old.status = 'archived'
    old.attachments = (old.attachments as string[]).filter((p) => !files.includes(p))
    const ids = params.p_comment_ids as string[]
    for (const c of db.tables.task_comments) if (ids.includes(c.id as string)) c.task_id = 't-new'
    return { data: { old_task_id: old.id, old_key: old.key, new_task_id: 't-new', new_key: 'P-3', moved_attachments: files.length, moved_comments: ids.length, moved_subtasks: ['P-9'] }, error: null }
  }
  return db
}

// ── update_task ───────────────────────────────────────────────────────────────

Deno.test('update_task edits an unstarted task in place and says so', async () => {
  const db = fixture()
  const out = await updateTask(db as never, { task: 'P-1', description: 'new text', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(out.edit_mode, 'in_place')
  assertEquals(db.tables.tasks.find((t) => t.id === 't-free')!.description, 'new text')
  assertEquals(db.tables.tasks.length, 2) // nothing forked
})

Deno.test('update_task on a started task files an owner request and changes NOTHING — not even the other fields', async () => {
  const db = fixture()
  installOwnerRequestFakes(db)
  const out = await updateTask(db as never, { task: 'P-2', description: 'rewrite', priority: 'high', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(out.status, 'awaiting_owner_approval')
  assertEquals(out.request_id, 1)
  assertStringIncludes(String(out.message), 'request №1')
  assertStringIncludes(String(out.message), 'request_id: 1')
  const filed = db.tables.owner_requests[0]
  assertEquals([filed.request_type, filed.task_id, JSON.stringify(filed.params)], ['edit_in_place', 't-started', '{"description":"rewrite"}'])
  assertEquals((filed.preview as Record<string, unknown>).description_diff, ['- line 1', '- line 2', '+ rewrite'])
  const t = db.tables.tasks.find((x) => x.id === 't-started')!
  assertEquals([t.description, t.priority], ['line 1\nline 2', 'medium'])
  assertEquals(db.tables.tasks.length, 2)
  assertEquals(db.inserted.filter((i) => i.table === 'agent_audit_log').length, 0)
})

Deno.test('update_task without text fields does not consult the policy', async () => {
  const db = fixture()
  const out = await updateTask(db as never, { task: 'P-2', priority: 'high', agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(out.priority, 'high')
  assertEquals(out.edit_mode, undefined)
  assertEquals(db.rpcCalls.length, 0)
})

// ── get_edit_policy / get_task ────────────────────────────────────────────────

Deno.test('get_edit_policy reports who started, the signal, and what the agent must do', async () => {
  const out = await getEditPolicy(fixture() as never, { task: 'P-2' }) as Record<string, unknown>
  assertEquals([out.work_started, out.started_by, out.signal, out.edit_mode], [true, 'dev@test', 'take_in_work', 'owner_approval_required'])
  assertStringIncludes(String(out.note), 'create_task_revision')
  const free = await getEditPolicy(fixture() as never, { task: 'P-1' }) as Record<string, unknown>
  assertEquals([free.work_started, free.edit_mode, free.note], [false, 'in_place', undefined])
})

Deno.test('get_task shows the start with the assignee\'s own words, and comment types', async () => {
  const out = await getTask(fixture() as never, { task: 'P-2' }) as Record<string, unknown>
  const started = out.work_started as Record<string, unknown>
  assertEquals([started.by_email, started.signal, started.comment], ['dev@test', 'take_in_work', 'Understood: start with the API'])
  assertEquals((out.comments as { type?: string }[]).map((c) => c.type ?? 'comment'), ['take_in_work', 'comment'])
  const free = await getTask(fixture() as never, { task: 'P-1' }) as Record<string, unknown>
  assertEquals(free.work_started, null)
})

// ── update_task_status ────────────────────────────────────────────────────────

Deno.test('back to todo from in progress needs a reason of 15+ characters, posted via return_to_todo', async () => {
  const db = fixture()
  await assertRejects(() => updateTaskStatus(db as never, { task: 'P-2', status: 'todo', comment: 'too short', agent_name: 'claude' }), ToolError, 'at least 15 characters')
  assertEquals(db.rpcCalls.length, 0)
  const out = await updateTaskStatus(db as never, { task: 'P-2', status: 'todo', comment: 'Blocked on the API contract', agent_name: 'claude' })
  assertEquals(out.status, 'todo')
  assertEquals(db.rpcCalls[0].fn, 'return_to_todo')
  assertEquals(db.tables.task_comments.at(-1)!.comment_type, 'return_to_todo')
})

Deno.test('an agent moving a task to in progress gets told it is a status only', async () => {
  const db = fixture()
  db.tables.tasks[0].status = 'todo'
  const out = await updateTaskStatus(db as never, { task: 'P-1', status: 'in_progress', agent_name: 'claude' }) as Record<string, unknown>
  assertStringIncludes(String(out.note), 'Status only')
})

// ── create_task_revision ──────────────────────────────────────────────────────

Deno.test('create_task_revision needs a reason, moves what was chosen ("all"), and archives the old task', async () => {
  const db = fixture()
  await assertRejects(() => createTaskRevision(db as never, { task: 'P-2', agent_name: 'claude' }), ToolError, '"reason" is required')
  const out = await createTaskRevision(db as never, {
    task: 'P-2', description: 'v2 text', attachments: 'all', comments: 'all', reason: 'API contract changed', agent_name: 'claude',
  })
  assertEquals(out, { new_task: 'P-3', archived_task: 'P-2', moved_attachments: 1, moved_comments: 2, moved_subtasks: ['P-9'] })
  const call = db.rpcCalls.find((c) => c.fn === 'create_task_revision')!
  assertEquals(call.params.p_attachments, ['p-1/x/dev/1-a.zip'])
  assertEquals(call.params.p_comment_ids, ['c-take', 'c-2'])
  assertEquals(call.params.p_title, null)
})

// ── versions ──────────────────────────────────────────────────────────────────

Deno.test('lineDiff marks added and removed lines only', () => {
  assertEquals(lineDiff('a\nb\nc', 'a\nB\nc\nd'), ['- b', '+ B', '+ d'])
  assertEquals(lineDiff('same', 'same'), [])
})

Deno.test('versions: an edit records the original and the new text; restore brings the old one back', async () => {
  const db = fixture()
  await updateTask(db as never, { task: 'P-1', description: 'line 1\nline two', agent_name: 'claude' })
  const list = await listDescriptionVersions(db as never, { task: 'P-1' }) as { versions: Record<string, unknown>[] }
  assertEquals(list.versions.map((v) => v.version), [1, 2])
  assertEquals(list.versions[1].description_diff, ['- line 2', '+ line two'])
  assertEquals(list.versions[1].agent, 'claude')

  const out = await restoreDescriptionVersion(db as never, { task: 'P-1', version: 1, agent_name: 'claude' })
  assertEquals(out.restored_version, 1)
  assertEquals(db.tables.tasks.find((t) => t.id === 't-free')!.description, 'line 1\nline 2')
  assertEquals(db.rpcCalls.at(-1)!.params.p_mode, 'restore')
})

Deno.test('restore on a started task files an owner request like any edit', async () => {
  const db = fixture()
  installOwnerRequestFakes(db)
  db.tables.task_description_versions.push({ task_id: 't-started', version: 1, title: 'old', description: 'old', edit_mode: 'original', created_at: '2026-11-01T00:00:00Z' })
  const out = await restoreDescriptionVersion(db as never, { task: 'P-2', version: 1, agent_name: 'claude' }) as Record<string, unknown>
  assertEquals(out.status, 'awaiting_owner_approval')
  assertEquals(JSON.stringify(db.tables.owner_requests[0].params), '{"title":"old","description":"old"}')
  assertEquals(db.tables.tasks.find((x) => x.id === 't-started')!.description, 'line 1\nline 2')
})
