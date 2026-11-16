import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { ToolError } from './errors.ts'
import { resolveProjectByKey } from './resolvers.ts'
import { HIDDEN_STATUS_FILTER, isHiddenTaskStatus } from './visibility.ts'

interface SearchTasksArgs {
  query?: string
  project?: string
  include_archived?: boolean
}

const RESULT_LIMIT = 25

// Escapes ILIKE wildcards so user input can't inject pattern behavior —
// backslash is Postgres's default LIKE/ILIKE escape character.
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export async function searchTasks(admin: SupabaseClient, args: SearchTasksArgs) {
  const query = args.query?.trim()
  if (!query) throw new ToolError('"query" is required.')

  const projectId = args.project ? (await resolveProjectByKey(admin, args.project)).id : null
  const pattern = `%${escapeLikePattern(query)}%`
  const includeArchived = args.include_archived === true

  // Two separate ILIKE queries (rather than a single .or(...)) avoid having
  // to interpolate user input into PostgREST's comma/paren filter syntax.
  const buildQuery = (column: 'title' | 'description') => {
    let q = admin
      .from('tasks')
      .select('key, title, status, priority, updated_at')
      .ilike(column, pattern)
      .order('updated_at', { ascending: false })
      .limit(RESULT_LIMIT)
    if (projectId) q = q.eq('project_id', projectId)
    // Filtered in the query, not afterwards: RESULT_LIMIT applies to what the
    // database returns, so dropping archived rows after the fact would let a
    // page of dead duplicates crowd the live task out of the results entirely.
    if (!includeArchived) q = q.not('status', 'in', HIDDEN_STATUS_FILTER)
    return q
  }

  const [titleRes, descriptionRes] = await Promise.all([buildQuery('title'), buildQuery('description')])
  if (titleRes.error) throw new ToolError(`Search failed: ${titleRes.error.message}`)
  if (descriptionRes.error) throw new ToolError(`Search failed: ${descriptionRes.error.message}`)

  const byKey = new Map<string, { key: string; title: string; status: string; priority: string; updated_at: string }>()
  for (const row of [...(titleRes.data ?? []), ...(descriptionRes.data ?? [])]) {
    byKey.set(row.key, row)
  }

  const tasks = [...byKey.values()]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, RESULT_LIMIT)
    .map(({ key, title, status, priority }) => ({
      key,
      title,
      status,
      priority,
      // Only ever true with include_archived — and then said explicitly, so a
      // caller can never mistake a dead row for the live one.
      ...(isHiddenTaskStatus(status) ? { archived: true } : {}),
    }))

  return { tasks }
}
