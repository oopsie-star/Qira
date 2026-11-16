// What "archived" means for reads, in one place.
//
// archived and deleted tasks are out of the working area: search, lists and
// get_task leave them out unless the caller asks with include_archived: true.
// They were showing up next to the live task they had been replaced by — the
// four "Educational Calendar Screen Render" rows (MOMNA-1015, 1204, 1205, 1206)
// where only 1206 is current.
//
// cancelled is deliberately NOT here: it is a decision about the work ("we will
// not do this"), still worth finding, whereas archived/deleted mean the row
// itself is no longer the place to look.
export const HIDDEN_TASK_STATUSES = ['archived', 'deleted'] as const

/** PostgREST value for `.not('status', 'in', ...)`. */
export const HIDDEN_STATUS_FILTER = `(${HIDDEN_TASK_STATUSES.join(',')})`

export function isHiddenTaskStatus(status: string | null | undefined): boolean {
  return Boolean(status) && (HIDDEN_TASK_STATUSES as readonly string[]).includes(status as string)
}

export interface LinkedTaskRef {
  key: string
  title: string
  status: string
}

export interface SupersedeLinkRow {
  source_task_id: string
  target_task_id: string
  source_task: LinkedTaskRef | null
  target_task: LinkedTaskRef | null
}

export interface SupersedeHistoryEntry extends LinkedTaskRef {
  /** "superseded_by": the other task replaced this one. "supersedes": this one replaced the other. */
  relation: 'superseded_by' | 'supersedes'
}

/**
 * Splits a task's supersede links into the ones that still mean something and
 * the ones that are only history.
 *
 * A link whose other end is archived or deleted is history: it records what
 * happened, but it must not steer anything. In particular a task "superseded
 * by" a replacement that was itself archived is NOT obsolete — treating it as
 * obsolete is how a live task ended up sunk and badged because of a link to a
 * dead one.
 */
export function classifySupersedeLinks(taskId: string, links: SupersedeLinkRow[]) {
  let supersededBy: LinkedTaskRef | null = null
  const supersedes: LinkedTaskRef[] = []
  const history: SupersedeHistoryEntry[] = []

  for (const link of links) {
    if (link.target_task_id === taskId && link.source_task) {
      if (isHiddenTaskStatus(link.source_task.status)) history.push({ ...link.source_task, relation: 'superseded_by' })
      else supersededBy = link.source_task
    } else if (link.source_task_id === taskId && link.target_task) {
      if (isHiddenTaskStatus(link.target_task.status)) history.push({ ...link.target_task, relation: 'supersedes' })
      else supersedes.push(link.target_task)
    }
  }

  return { supersededBy, supersedes, history }
}
