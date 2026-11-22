import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { ToolError } from './errors.ts'
import { resolveProjectByKey } from './resolvers.ts'
import { isHiddenTaskStatus } from './visibility.ts'

interface SearchTasksArgs {
  query?: string
  project?: string
  include_archived?: boolean
}

const RESULT_LIMIT = 25

interface SearchRow {
  key: string
  title: string
  status: string
  priority: string
  matched_in: 'key' | 'title' | 'description'
}

// The matching and ranking live in public.search_tasks (migration
// 20261122080000_task_search.sql), shared with the app's search: any form of
// the key ("MOMNA-989", "momna 989", "989"), the phrase, or every word in any
// order across title, description and labels. The key hit comes first — the
// old ILIKE-only search returned the tasks that MENTION MOMNA-989 instead of it.
export async function searchTasks(admin: SupabaseClient, args: SearchTasksArgs) {
  const query = args.query?.trim()
  if (!query) throw new ToolError('"query" is required.')

  const projectId = args.project ? (await resolveProjectByKey(admin, args.project)).id : null

  const { data, error } = await admin.rpc('search_tasks', {
    p_query: query,
    p_project_id: projectId,
    // Filtered in the database, before the limit: dropping archived rows after
    // the fact would let a page of dead duplicates crowd the live task out.
    p_include_archived: args.include_archived === true,
    p_limit: RESULT_LIMIT,
  })
  if (error) throw new ToolError(`Search failed: ${error.message}`)

  const tasks = ((data ?? []) as SearchRow[]).map(({ key, title, status, priority, matched_in }) => ({
    key,
    title,
    status,
    priority,
    matched_in,
    // Only ever true with include_archived — and then said explicitly, so a
    // caller can never mistake a dead row for the live one.
    ...(isHiddenTaskStatus(status) ? { archived: true } : {}),
  }))

  return { tasks }
}
