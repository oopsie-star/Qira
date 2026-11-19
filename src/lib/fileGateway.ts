import { supabase } from '@/lib/supabase'

// Every file the app shows or downloads comes from the "files" edge function,
// which checks access at every request (supabase/functions/files). The app
// never gets storage signed URLs: it gets short tickets for src URLs, share
// links that are rows in the database, and asks the function to remove files.

export const FILES_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/files`

export type FilePurpose = 'view' | 'archive'

const REFRESH_BEFORE_MS = 5 * 60 * 1000
const cache = new Map<string, { url: string; exp: number }>()

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

async function post<T>(route: string, body: unknown): Promise<T> {
  const token = await accessToken()
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${FILES_BASE}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Files: ${res.status}`)
  return (await res.json()) as T
}

/**
 * URLs to show files (img/video/iframe src, links). Each URL is a ticket good
 * for about an hour — but every request with it is checked again, so an
 * archived or deleted file stops opening at once.
 */
export async function fileUrls(paths: string[], purpose: FilePurpose = 'view'): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const missing: string[] = []
  const now = Date.now()
  for (const path of new Set(paths)) {
    const hit = cache.get(`${purpose}|${path}`)
    if (hit && hit.exp - REFRESH_BEFORE_MS > now) out.set(path, hit.url)
    else missing.push(path)
  }
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200)
    const { urls, expires_at } = await post<{ urls: Record<string, string>; expires_at: string }>('/tickets', { paths: chunk, purpose })
    const exp = new Date(expires_at).getTime()
    for (const [path, url] of Object.entries(urls)) {
      cache.set(`${purpose}|${path}`, { url, exp })
      out.set(path, url)
    }
  }
  return out
}

export async function fileUrl(path: string, purpose: FilePurpose = 'view'): Promise<string | null> {
  return (await fileUrls([path], purpose)).get(path) ?? null
}

/** The file's bytes, or null when it is not available to this user. */
export async function fetchFile(path: string, purpose: FilePurpose = 'view'): Promise<Blob | null> {
  const url = await fileUrl(path, purpose)
  if (!url) return null
  const res = await fetch(url)
  return res.ok ? await res.blob() : null
}

/** Share links (7 days) for live files; recorded, and revocable by owners. */
export async function createShareLinks(paths: string[]): Promise<{ path: string; url: string }[]> {
  if (!paths.length) return []
  const { data, error } = await supabase.rpc('create_file_share_links', { p_paths: paths })
  if (error) throw error
  return ((data ?? []) as { path: string; token: string }[]).map((row) => ({ path: row.path, url: `${FILES_BASE}/s/${row.token}` }))
}

/**
 * Removes storage objects nothing references any more (detach first). The
 * server checks that, and that the caller uploaded them or owns the project.
 */
export async function removeStoredFiles(paths: string[]): Promise<{ removed: string[]; failed: string[]; refused: string[] }> {
  const all = { removed: [] as string[], failed: [] as string[], refused: [] as string[] }
  for (let i = 0; i < paths.length; i += 200) {
    const part = await post<typeof all>('/remove', { paths: paths.slice(i, i + 200) })
    all.removed.push(...part.removed)
    all.failed.push(...part.failed)
    all.refused.push(...part.refused)
  }
  for (const path of paths) {
    cache.delete(`view|${path}`)
    cache.delete(`archive|${path}`)
  }
  return all
}
