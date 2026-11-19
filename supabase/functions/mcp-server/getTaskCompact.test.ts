// Stage 6 — get_task is compact by default: history only on request and
// paged, long values as lengths, long comment threads cut with a marker.
//
// Run: deno test --no-check --allow-env getTaskCompact.test.ts

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { FakeAdmin } from './testing/fakeAdmin.ts'
import { ToolError } from './tools/errors.ts'
import { getTask } from './tools/getTask.ts'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const T = '22222222-2222-4222-8222-222222222222'

function fixture(comments = 3) {
  const big = 'x'.repeat(1200)
  return new FakeAdmin({
    projects: [{ id: PROJECT, key: 'P', name: 'P' }],
    profiles: [{ id: 'u', email: 'u@test' }],
    tasks: [{
      id: T, project_id: PROJECT, key: 'P-1', title: 'T', description: 'd', status: 'todo', issue_type: 'task', priority: 'medium',
      epic_id: null, sprint_id: null, assignee_id: null, reporter_id: 'u', assignee_ids: [], due_date: null, attachments: [], archived_attachments: [],
      work_started_at: null, work_started_by: null, work_started_signal: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    }],
    task_comments: Array.from({ length: comments }, (_, i) => ({
      id: `c${i}`, task_id: T, author_id: 'u', body: `${i} ${big}`, created_at: `2026-11-0${1 + Math.floor(i / 10)}T00:${String(i % 60).padStart(2, '0')}:00Z`, archived_at: null, comment_type: 'comment',
    })),
    task_activities: Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, task_id: T, actor_id: 'u', activity_type: 'task_updated', message: `m${i}`, created_at: `2026-11-02T00:${String(i).padStart(2, '0')}:00Z` })),
    task_field_changes: [
      { id: 'f1', task_id: T, field_name: 'description', old_value: 'a'.repeat(5000), new_value: 'b'.repeat(6000), changed_by: 'u', changed_at: '2026-11-03T00:00:00Z' },
      { id: 'f2', task_id: T, field_name: 'status', old_value: 'todo', new_value: 'in_progress', changed_by: 'u', changed_at: '2026-11-03T00:01:00Z' },
    ],
    attachment_notes: [], agent_audit_log: [], task_links: [],
  })
}

Deno.test('default: no history, only its count', async () => {
  const out = await getTask(fixture() as never, { task: 'P-1' }) as Record<string, unknown>
  assertEquals('history' in out, false)
  assertEquals(out.history_count, 27)
})

Deno.test('history: newest first, paged without overlap; the last page has no cursor', async () => {
  const db = fixture()
  const p1 = await getTask(db as never, { task: 'P-1', include: ['history'] }) as Record<string, unknown>
  const h1 = p1.history as { at: string }[]
  assertEquals([h1.length, p1.history_total, p1.history_next_cursor], [20, 27, '20'])
  assertEquals(h1[0].at, '2026-11-03T00:01:00Z')
  const p2 = await getTask(db as never, { task: 'P-1', include: ['history'], history_cursor: p1.history_next_cursor }) as Record<string, unknown>
  const h2 = p2.history as { at: string }[]
  assertEquals([h2.length, p2.history_next_cursor], [7, null])
  assertEquals(h1.some((a) => h2.some((b) => JSON.stringify(a) === JSON.stringify(b))), false)
})

Deno.test('history: a description change is lengths only; a status change is shown in full', async () => {
  const out = await getTask(fixture() as never, { task: 'P-1', include: ['history'], history_limit: 2 }) as Record<string, unknown>
  const [status, desc] = out.history as Record<string, unknown>[]
  assertEquals([status.field, status.old_value, status.new_value], ['status', 'todo', 'in_progress'])
  assertEquals([desc.field, desc.old_length, desc.new_length, desc.full_text, 'old_value' in desc], ['description', 5000, 6000, 'list_description_versions', false])
})

Deno.test('a long comment thread: latest 20 and comments_truncated; all_comments gives every one', async () => {
  const db = fixture(30)
  const out = await getTask(db as never, { task: 'P-1' }) as Record<string, unknown>
  const shown = out.comments as { id: string }[]
  assertEquals([shown.length, shown[0].id, shown[19].id], [20, 'c10', 'c29'])
  assertEquals(out.comments_truncated, { shown: 20, omitted: 10, hint: "use include: ['all_comments']" })
  const all = await getTask(db as never, { task: 'P-1', include: ['all_comments'] }) as Record<string, unknown>
  assertEquals([(all.comments as unknown[]).length, 'comments_truncated' in all], [30, false])
})

Deno.test('a short thread is never cut', async () => {
  const out = await getTask(fixture(5) as never, { task: 'P-1' }) as Record<string, unknown>
  assertEquals([(out.comments as unknown[]).length, 'comments_truncated' in out], [5, false])
})

Deno.test('bad include / limit are refused', async () => {
  await assertRejects(() => getTask(fixture() as never, { task: 'P-1', include: ['everything'] }), ToolError, 'Unknown "include"')
  await assertRejects(() => getTask(fixture() as never, { task: 'P-1', include: ['history'], history_limit: 500 }), ToolError, 'history_limit')
})
