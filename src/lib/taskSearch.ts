// Task text search in the browser — the same rules as public.search_tasks
// (migration 20261122080000_task_search.sql), which serves MCP and the command
// palette. Keep the two in step.
//
//   key  — "MOMNA-989", "momna 989", "momna989", "#989", or just "989";
//   text — the whole phrase, or every word in any order, across key, title,
//          description and labels; case-insensitive, ё = е, every dash kind = "-",
//          runs of whitespace = one space, quotes/punctuation around words ignored.

export interface SearchableTask {
  key: string
  title: string
  description?: string | null
  labels?: string[] | null
}

export interface TaskSearchQuery {
  phrase: string
  words: string[]
  /** Exact key, lower case ("momna-989"). */
  key: string | null
  /** Bare number ("989"): that number in any project. */
  keyNumber: string | null
}

const DASHES = /[‐‑‒–—―−]/g
const EDGE_PUNCTUATION = /^[«»„“”"'`.,;:!?()[\]{}<>]+|[«»„“”"'`.,;:!?()[\]{}<>]+$/g

export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/ё/g, 'е').replace(DASHES, '-').replace(/\s+/g, ' ').trim()
}

/** Null for an empty query (nothing to filter by). */
export function parseTaskSearch(raw: string): TaskSearchQuery | null {
  const phrase = normalizeSearchText(raw)
  if (!phrase) return null
  const words = phrase.split(' ').map((w) => w.replace(EDGE_PUNCTUATION, '')).filter(Boolean)
  if (words.length === 0) return null

  let key: string | null = null
  let keyNumber: string | null = null
  const m = phrase.match(/^#?([a-z]+)[ _-]*#?0*(\d+)$/) ?? phrase.match(/^#?([a-z][a-z0-9]*)[ _-]+#?0*(\d+)$/)
  if (m) key = `${m[1]}-${m[2]}`
  else {
    const n = phrase.match(/^#?0*(\d+)$/)
    if (n) keyNumber = n[1]
  }
  return { phrase, words, key, keyNumber }
}

/**
 * How well a task matches — the same ranks as public.search_tasks:
 * 0 its key, 1 title has the phrase, 2 title has every word, 3 text has the
 * phrase, 4 text has every word; null = no match. 0–2 are the task itself
 * ("by its number or its name"); 3–4 are tasks that merely mention it.
 */
export function rankTaskSearch(task: SearchableTask, query: TaskSearchQuery): number | null {
  const lk = task.key.toLowerCase()
  if (query.key && lk === query.key) return 0
  if (query.keyNumber && lk.endsWith(`-${query.keyNumber}`)) return 0
  const title = normalizeSearchText(task.title)
  if (title.includes(query.phrase)) return 1
  if (query.words.every((w) => title.includes(w))) return 2
  const all = normalizeSearchText([task.key, task.title, task.description ?? '', ...(task.labels ?? [])].join(' '))
  if (all.includes(query.phrase)) return 3
  if (query.words.every((w) => all.includes(w))) return 4
  return null
}

/** Rank at or below this = the task itself, not a mention of it. */
export const OWN_MATCH_RANK = 2

export function matchesTaskSearch(task: SearchableTask, query: TaskSearchQuery | null): boolean {
  return !query || rankTaskSearch(task, query) !== null
}
