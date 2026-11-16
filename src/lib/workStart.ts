import type { Profile, ProjectRole, Task, TaskStatus } from '@/types'

// Stage 4a. Only the assignee starts the work, from their own account, with a
// comment. Anyone else moving a task to in progress changes a status, nothing
// more — the database (take_in_work, the edit policy) holds the same rule.

export const MIN_WORK_COMMENT = 15

export function taskAssigneeIds(task: Pick<Task, 'assignee_id' | 'assignee_ids'>): string[] {
  if (task.assignee_ids?.length) return task.assignee_ids
  return task.assignee_id ? [task.assignee_id] : []
}

/**
 * Which window a status change needs, if any:
 *   'take'   — the assignee (or a member picking up an unassigned task) moves
 *              To do → In progress: the "Take into work" comment window;
 *   'return' — In progress → To do, by anyone: the reason window;
 *   null     — a plain status change (a manager moving someone else's task,
 *              any other move).
 */
export function workTransitionFor(
  task: Pick<Task, 'status' | 'assignee_id' | 'assignee_ids' | 'assignee_placeholder_id'>,
  toStatus: TaskStatus,
  profileId: string | null | undefined,
  role: ProjectRole | null | undefined,
): 'take' | 'return' | null {
  if (task.status === 'in_progress' && toStatus === 'todo') return 'return'
  if (task.status !== 'todo' || toStatus !== 'in_progress' || !profileId) return null
  const assignees = taskAssigneeIds(task)
  if (assignees.includes(profileId)) return 'take'
  const unclaimed = assignees.length === 0 && !task.assignee_placeholder_id
  return unclaimed && role && role !== 'viewer' ? 'take' : null
}

/**
 * "Taken into work: Anna, 12 Nov 14:05 — “starting with the API”", or null.
 * A done_status mark (done, no recorded start) is not a start: cards and rows
 * leave it out (`startsOnly`); the drawer shows it as "closed".
 */
export function workStartedSummary(
  task: Pick<Task, 'work_started_at' | 'work_started_by' | 'work_started_signal' | 'work_started_note'>,
  members: Profile[],
  locale: string,
  startsOnly = false,
): { who: string; when: string; note: string | null; signal: string } | null {
  if (!task.work_started_at) return null
  if (startsOnly && task.work_started_signal === 'done_status') return null
  const person = members.find((member) => member.id === task.work_started_by)
  const who = person ? person.full_name || person.email : '—'
  const when = new Date(task.work_started_at).toLocaleString(locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
  return { who, when, note: task.work_started_note ?? null, signal: task.work_started_signal ?? 'legacy' }
}
