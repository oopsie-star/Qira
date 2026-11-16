import { useSyncExternalStore } from 'react'

// When this bundle was built. Every deploy writes the same value into
// version.json next to index.html, so a tab can ask the server which build is
// current and notice that it is running an older one.
export const APP_BUILT_AT: number = __APP_BUILT_AT__

const CHECK_INTERVAL_MS = 5 * 60 * 1000

let stale = false
let started = false
const listeners = new Set<() => void>()

function setStale() {
  if (stale) return
  stale = true
  listeners.forEach((listener) => listener())
}

/**
 * Asks the server for the current build. Only a strictly newer build marks the
 * tab stale: a missing file (dev server, a deploy in progress), a network
 * error or garbage changes nothing, so a flaky connection never locks anyone out.
 */
export async function checkAppVersion(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) return stale
    const body = (await response.json()) as { built_at?: unknown }
    if (typeof body.built_at === 'number' && body.built_at > APP_BUILT_AT) setStale()
  } catch {
    // Offline or a non-JSON answer: keep working with what we have.
  }
  return stale
}

function start() {
  if (started || typeof window === 'undefined') return
  started = true
  void checkAppVersion()
  window.setInterval(() => void checkAppVersion(), CHECK_INTERVAL_MS)
  // A tab left open overnight is the usual stale one; check as it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkAppVersion()
  })
}

function subscribe(listener: () => void) {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * True once the server has a newer build than this tab. Attachment changes are
 * blocked from then on: an old bundle does not know the archive, and deleting
 * through it would bypass the rules the new build follows.
 */
export function useAppIsStale(): boolean {
  return useSyncExternalStore(subscribe, () => stale, () => false)
}
