// Stage 1 — archived and deleted tasks are out of the working area by default.
//
// The fixture is the real case that prompted this: four "Educational Calendar
// Screen Render" tasks in MOMNA, of which only 1206 is live (1015 and 1204 are
// deleted, 1205 archived). Search used to return all four.

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { FakeAdmin } from './testing/fakeAdmin.ts'
import { getTask } from './tools/getTask.ts'
import { listTasks } from './tools/listTasks.ts'
import { searchTasks } from './tools/searchTasks.ts'
import { unlinkSupersedes } from './tools/unlinkSupersedes.ts'
import { classifySupersedeLinks, isHiddenTaskStatus } from './tools/visibility.ts'
import { ToolError } from './tools/errors.ts'

const PROJECT = 'p-momna'
const TITLE = 'Educational Calendar Screen Render'

function task(key: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: `t-${key}`,
    project_id: PROJECT,
    key,
    title: TITLE,
    description: `body of ${key}`,
    status,
    issue_type: 'task',
    priority: 'medium',
    epic_id: null,
    sprint_id: null,
    assignee_id: null,
    reporter_id: null,
    assignee_ids: [],
    due_date: null,
    attachments: [],
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...extra,
  }
}

function fixture() {
  Deno.env.set('MCP_AGENT_EMAIL', 'mcp-agent@test')
  const admin = new FakeAdmin({
    projects: [{ id: PROJECT, key: 'MOMNA', name: 'Momna' }],
    profiles: [{ id: 'agent', email: 'mcp-agent@test' }],
    tasks: [
      task('MOMNA-1015', 'deleted'),
      task('MOMNA-1204', 'deleted'),
      task('MOMNA-1205', 'archived', { attachments: ['p/t/u/1-a.zip', 'p/t/u/2-b.zip'] }),
      task('MOMNA-1206', 'todo'),
    ],
    task_comments: [{ id: 'c1', task_id: 't-MOMNA-1205', author_id: 'agent', body: 'old', created_at: '2026-11-01T00:00:00Z' }],
    task_activities: [],
    task_field_changes: [],
    attachment_notes: [],
    agent_audit_log: [],
    task_links: [],
  })
  // Stands in for public.search_tasks: only the status rule matters here (the
  // matching itself is SQL, checked against the live DB after the migration).
  admin.rpcHandlers.search_tasks = (p, db) => ({
    data: db.tables.tasks
      .filter((t) => String(t.title).toLowerCase().includes(String(p.p_query).toLowerCase()))
      .filter((t) => p.p_include_archived || !isHiddenTaskStatus(t.status as string))
      .map((t) => ({ ...t, matched_in: 'title' })),
    error: null,
  })
  return admin
}

const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort()

// ── search_tasks ──────────────────────────────────────────────────────────────

Deno.test('search_tasks leaves archived and deleted tasks out by default', async () => {
  const { tasks } = await searchTasks(fixture() as never, { query: TITLE })
  assertEquals(keys(tasks), ['MOMNA-1206'])
})

Deno.test('search_tasks with include_archived returns them, each marked archived', async () => {
  const { tasks } = await searchTasks(fixture() as never, { query: TITLE, include_archived: true })
  assertEquals(keys(tasks), ['MOMNA-1015', 'MOMNA-1204', 'MOMNA-1205', 'MOMNA-1206'])
  for (const t of tasks) {
    assertEquals((t as { archived?: boolean }).archived === true, t.key !== 'MOMNA-1206', t.key)
  }
})

Deno.test('search_tasks passes the query, project and archive flag to public.search_tasks', async () => {
  const admin = fixture()
  await searchTasks(admin as never, { query: '  MOMNA-989 ', project: 'MOMNA' })
  assertEquals(admin.rpcCalls.at(-1), {
    fn: 'search_tasks',
    params: { p_query: 'MOMNA-989', p_project_id: PROJECT, p_include_archived: false, p_limit: 25 },
  })
})

Deno.test('search_tasks says where each task matched', async () => {
  const { tasks } = await searchTasks(fixture() as never, { query: TITLE })
  assertEquals(tasks.map((t) => t.matched_in), ['title'])
})

Deno.test('search_tasks keeps cancelled tasks visible — cancelled is a decision, not an archive', async () => {
  const admin = fixture()
  admin.tables.tasks.push(task('MOMNA-1300', 'cancelled'))
  const { tasks } = await searchTasks(admin as never, { query: TITLE })
  assertEquals(keys(tasks), ['MOMNA-1206', 'MOMNA-1300'])
})

// ── list_tasks ────────────────────────────────────────────────────────────────

Deno.test('list_tasks leaves archived and deleted tasks out by default', async () => {
  const { tasks } = await listTasks(fixture() as never, { project: 'MOMNA' })
  assertEquals(keys(tasks), ['MOMNA-1206'])
})

Deno.test('list_tasks with include_archived returns everything, archived ones marked', async () => {
  const { tasks } = await listTasks(fixture() as never, { project: 'MOMNA', include_archived: true })
  assertEquals(tasks.length, 4)
  assertEquals(tasks.filter((t) => (t as { archived?: boolean }).archived).length, 3)
})

Deno.test('list_tasks asking for status "archived" by name counts as asking for archived tasks', async () => {
  const { tasks } = await listTasks(fixture() as never, { project: 'MOMNA', status: 'archived' })
  assertEquals(keys(tasks), ['MOMNA-1205'])
})

// ── get_task ──────────────────────────────────────────────────────────────────

Deno.test('get_task on an archived task hides its comments and attachments, giving counts only', async () => {
  const result = await getTask(fixture() as never, { task: 'MOMNA-1205' }) as Record<string, unknown>
  assertEquals(result.archived, true)
  assertEquals(result.archived_comments_count, 1)
  assertEquals(result.archived_attachments_count, 2)
  assertEquals('comments' in result, false)
  assertEquals('attachments' in result, false)
  assertEquals('description' in result, false)
})

Deno.test('get_task on an archived task with include_archived returns its full contents', async () => {
  const result = await getTask(fixture() as never, { task: 'MOMNA-1205', include_archived: true }) as Record<string, unknown>
  assertEquals(result.archived, true)
  assertEquals(result.description, 'body of MOMNA-1205')
  assertEquals((result.comments as unknown[]).length, 1)
  assertEquals((result.attachments as unknown[]).length, 2)
})

Deno.test('get_task on a live task is unaffected and carries no archived flag', async () => {
  const result = await getTask(fixture() as never, { task: 'MOMNA-1206' }) as Record<string, unknown>
  assertEquals(result.description, 'body of MOMNA-1206')
  assertEquals('archived' in result, false)
})

Deno.test('get_task moves a supersede link to an archived task into supersede_history', async () => {
  const admin = fixture()
  // 1206 replaced 1205 (archived): a record, not a live relationship.
  admin.tables.task_links.push({
    link_type: 'supersedes',
    source_task_id: 't-MOMNA-1206',
    target_task_id: 't-MOMNA-1205',
    source_task: { key: 'MOMNA-1206', title: TITLE, status: 'todo' },
    target_task: { key: 'MOMNA-1205', title: TITLE, status: 'archived' },
  })
  const result = await getTask(admin as never, { task: 'MOMNA-1206' }) as Record<string, unknown>
  assertEquals(result.supersedes, [])
  assertEquals(result.supersede_history, [{ key: 'MOMNA-1205', title: TITLE, status: 'archived', relation: 'supersedes' }])
})

// ── supersede links ───────────────────────────────────────────────────────────

Deno.test('a task "superseded by" an archived replacement is not obsolete', () => {
  const { supersededBy, history } = classifySupersedeLinks('old', [{
    source_task_id: 'new', target_task_id: 'old',
    source_task: { key: 'K-2', title: 'replacement', status: 'archived' },
    target_task: { key: 'K-1', title: 'original', status: 'todo' },
  }])
  assertEquals(supersededBy, null)
  assertEquals(history.map((h) => h.relation), ['superseded_by'])
})

Deno.test('a task superseded by a live replacement still is', () => {
  const { supersededBy, history } = classifySupersedeLinks('old', [{
    source_task_id: 'new', target_task_id: 'old',
    source_task: { key: 'K-2', title: 'replacement', status: 'in_progress' },
    target_task: { key: 'K-1', title: 'original', status: 'todo' },
  }])
  assertEquals(supersededBy?.key, 'K-2')
  assertEquals(history, [])
})

Deno.test('isHiddenTaskStatus covers archived and deleted only', () => {
  assertEquals(['todo', 'in_progress', 'done', 'cancelled', 'archived', 'deleted'].map(isHiddenTaskStatus),
    [false, false, false, false, true, true])
})

function linked() {
  const admin = fixture()
  admin.tables.task_links.push({ link_type: 'supersedes', source_task_id: 't-MOMNA-1206', target_task_id: 't-MOMNA-1205' })
  return admin
}

Deno.test('unlink_supersedes removes the link whichever order the two tasks are given in', async () => {
  for (const [a, b] of [['MOMNA-1205', 'MOMNA-1206'], ['MOMNA-1206', 'MOMNA-1205']]) {
    const admin = linked()
    const result = await unlinkSupersedes(admin as never, { task: a, other: b, agent_name: 'claude' })
    assertEquals(result.removed, 1)
    assertEquals(admin.tables.task_links.length, 0)
  }
})

Deno.test('unlink_supersedes records the change on both tasks and in the audit log', async () => {
  const admin = linked()
  await unlinkSupersedes(admin as never, { task: 'MOMNA-1206', other: 'MOMNA-1205', agent_name: 'claude' })
  const activityTasks = admin.inserted.filter((i) => i.table === 'task_activities').map((i) => i.row.task_id).sort()
  assertEquals(activityTasks, ['t-MOMNA-1205', 't-MOMNA-1206'])
  const audit = admin.inserted.filter((i) => i.table === 'agent_audit_log')
  assertEquals(audit.map((a) => a.row.action_type), ['unlink_supersedes'])
})

Deno.test('unlink_supersedes refuses when there is no link, and touches nothing', async () => {
  const admin = fixture()
  await assertRejects(
    () => unlinkSupersedes(admin as never, { task: 'MOMNA-1206', other: 'MOMNA-1205', agent_name: 'claude' }),
    ToolError,
    'There is no supersedes link',
  )
  assertEquals(admin.inserted.length, 0)
})

Deno.test('unlink_supersedes leaves unrelated links between other tasks alone', async () => {
  const admin = linked()
  admin.tables.task_links.push({ link_type: 'supersedes', source_task_id: 't-MOMNA-1204', target_task_id: 't-MOMNA-1015' })
  admin.tables.task_links.push({ link_type: 'blocks', source_task_id: 't-MOMNA-1206', target_task_id: 't-MOMNA-1205' })
  await unlinkSupersedes(admin as never, { task: 'MOMNA-1206', other: 'MOMNA-1205', agent_name: 'claude' })
  assertEquals(admin.tables.task_links.length, 2)
})
