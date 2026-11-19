import { useCallback, useEffect, useState } from 'react'
import { Ban, FileLock2, Link2 } from 'lucide-react'
import { displayFilename } from '@/lib/attachments'
import { getErrorMessage } from '@/lib/errors'
import { useI18n } from '@/lib/i18n'
import { supabase } from '@/lib/supabase'
import { useStore } from '@/store'

interface ShareLinkRow {
  id: string
  path: string
  created_by: string | null
  created_at: string
  expires_at: string
  revoked_at: string | null
  revoke_reason: string | null
  use_count: number
  last_used_at: string | null
}

interface AccessRow {
  id: number
  at: string
  path: string | null
  channel: 'app' | 'mcp' | 'share'
  purpose: 'view' | 'archive'
  actor_id: string | null
  actor_agent: string | null
  outcome: 'served' | 'denied'
  reason: string | null
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

/**
 * Owners only: the project's share links (revoke any of them) and the file
 * access log — who opened which file, when, and through what.
 */
export function FileAccessPanel({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const attachmentNotes = useStore((state) => state.attachmentNotes)
  const members = useStore((state) => state.projectMembers)
  const [links, setLinks] = useState<ShareLinkRow[]>([])
  const [log, setLog] = useState<AccessRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const nameOf = (path: string | null) => (path ? displayFilename(path, attachmentNotes[path]?.original_name) : '—')
  const personOf = (id: string | null, agent?: string | null) => {
    if (agent) return agent
    if (!id) return '—'
    const p = members.find((m) => m.profile_id === id)?.profile
    return p?.full_name || p?.email || id.slice(0, 8)
  }

  const load = useCallback(async () => {
    const [l, a] = await Promise.all([
      supabase.from('file_share_links')
        .select('id, path, created_by, created_at, expires_at, revoked_at, revoke_reason, use_count, last_used_at')
        .eq('project_id', projectId).order('created_at', { ascending: false }).limit(100),
      supabase.from('file_access_log')
        .select('id, at, path, channel, purpose, actor_id, actor_agent, outcome, reason')
        .eq('project_id', projectId).order('at', { ascending: false }).limit(100),
    ])
    if (l.error || a.error) setError((l.error ?? a.error)!.message)
    setLinks((l.data ?? []) as ShareLinkRow[])
    setLog((a.data ?? []) as AccessRow[])
  }, [projectId])

  useEffect(() => { void load() }, [load])

  async function revoke(id: string) {
    setBusy(id)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('revoke_file_share_link', { p_link: id })
      if (rpcError) throw rpcError
      await load()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const now = Date.now()
  const active = (l: ShareLinkRow) => !l.revoked_at && new Date(l.expires_at).getTime() > now

  return (
    <section className="rounded-3xl border border-slate-200 bg-surface-card p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <FileLock2 size={18} /> {t('files.title')}
      </h2>
      <p className="mt-1 text-sm text-slate-500">{t('files.hint')}</p>
      {error && <p className="mt-3 rounded-2xl bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</p>}

      <h3 className="mt-5 flex items-center gap-2 text-sm font-semibold text-slate-700"><Link2 size={14} /> {t('files.links')}</h3>
      {links.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{t('files.noLinks')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {links.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{nameOf(l.path)}</span>
              <span className="text-xs text-slate-500">{t('files.issuedBy', { who: personOf(l.created_by), when: when(l.created_at) })}</span>
              <span className="text-xs text-slate-500">{t('files.used', { count: String(l.use_count) })}</span>
              {active(l) ? (
                <>
                  <span className="text-xs text-emerald-700">{t('files.activeUntil', { when: when(l.expires_at) })}</span>
                  <button
                    type="button"
                    disabled={busy === l.id}
                    onClick={() => void revoke(l.id)}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                  >
                    <Ban size={12} /> {t('files.revoke')}
                  </button>
                </>
              ) : (
                <span className="text-xs text-slate-400">
                  {l.revoked_at ? t('files.revoked', { when: when(l.revoked_at), why: l.revoke_reason ?? '' }) : t('files.expired')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-sm font-semibold text-slate-700">{t('files.log')}</h3>
      {log.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{t('files.noLog')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('files.col.when')}</th>
                <th className="py-1 pr-3 font-medium">{t('files.col.who')}</th>
                <th className="py-1 pr-3 font-medium">{t('files.col.file')}</th>
                <th className="py-1 pr-3 font-medium">{t('files.col.via')}</th>
                <th className="py-1 font-medium">{t('files.col.result')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {log.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap py-1 pr-3">{when(r.at)}</td>
                  <td className="py-1 pr-3">{r.channel === 'share' ? t('files.via.share') : personOf(r.actor_id, r.channel === 'mcp' ? (r.actor_agent ?? 'MCP') : null)}</td>
                  <td className="max-w-[16rem] truncate py-1 pr-3">{nameOf(r.path)}</td>
                  <td className="py-1 pr-3">{t(`files.via.${r.channel}`)}{r.purpose === 'archive' ? ` · ${t('attachments.archived')}` : ''}</td>
                  <td className={`py-1 ${r.outcome === 'served' ? 'text-emerald-700' : 'text-rose-600'}`}>
                    {r.outcome === 'served' ? t('files.served') : t('files.denied', { why: r.reason ?? '' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
