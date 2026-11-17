import { useEffect, useState } from 'react'
import { Check, ShieldQuestion, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAppIsStale } from '@/lib/appVersion'
import { useI18n } from '@/lib/i18n'
import { canManageProject } from '@/lib/permissions'
import { useStore } from '@/store'
import type { OwnerRequest } from '@/types'

// Stage 4b. What an AI agent may do only with an owner's approval — an edit of
// a started task, deleting a file or tasks for good — arrives here. One click
// approves or rejects; the agent then repeats its call and the database lets
// exactly that through, once.

function Preview({ request }: { request: OwnerRequest }) {
  const { t } = useI18n()
  const p = request.preview ?? {}
  const tasks = (p.tasks as { key: string; status: string }[] | undefined) ?? []
  const files = (p.files as { name: string; size_bytes?: number | null }[] | undefined) ?? []
  const diff = (p.description_diff as string[] | undefined) ?? []
  return (
    <div className="mt-2 space-y-1 text-xs">
      {typeof p.title_from === 'string' && (
        <p className="text-slate-600">
          {t('requests.titleChange')}: <span className="line-through">{p.title_from as string}</span> → <span className="font-semibold">{p.title_to as string}</span>
        </p>
      )}
      {diff.length > 0 && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 font-mono text-[11px] leading-5">
          {diff.map((line, index) => (
            <div key={index} className={line.startsWith('+') ? 'text-emerald-700' : line.startsWith('-') ? 'text-rose-700' : 'text-slate-600'}>{line}</div>
          ))}
        </pre>
      )}
      {files.length > 0 && (
        <ul className="list-disc pl-4 text-slate-700">
          {files.map((file, index) => <li key={index}>{file.name}{file.size_bytes ? ` · ${Math.round(file.size_bytes / 1024)} KB` : ''}</li>)}
        </ul>
      )}
      {tasks.length > 0 && (
        <p className="text-slate-700">
          {t('requests.goesForGood', { count: String(tasks.length) })}: {tasks.slice(0, 40).map((task) => task.key).join(', ')}
          {tasks.length > 40 ? ` ${t('requests.andMore', { count: String(tasks.length - 40) })}` : ''}
        </p>
      )}
    </div>
  )
}

export function OwnerRequestCard({ request }: { request: OwnerRequest }) {
  const { t, locale } = useI18n()
  const decide = useStore((state) => state.decideOwnerRequest)
  const role = useStore((state) => state.activeProjectRole)
  const isSuperAdmin = useStore((state) => state.profile?.role === 'admin')
  const stale = useAppIsStale()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owner = canManageProject(role, isSuperAdmin)

  async function choose(approve: boolean) {
    setBusy(true)
    setError(null)
    try {
      await decide(request.id, approve, note)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            №{request.id} · {t(`requests.type.${request.request_type}`)}{request.task ? ` · ${request.task.key}` : ''}
          </p>
          <p className="text-xs text-slate-500">
            {(request.requested_by_agent ?? 'agent')} · {new Date(request.created_at).toLocaleString(locale === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {request.reason ? ` · ${request.reason}` : ''}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">{t(`requests.status.${request.status}`)}</span>
      </div>
      <Preview request={request} />
      {owner && request.status === 'pending' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('requests.notePlaceholder')}
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-qira-pistachio"
          />
          <button type="button" disabled={busy || stale} onClick={() => void choose(false)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <X size={13} /> {t('requests.reject')}
          </button>
          <button type="button" disabled={busy || stale} onClick={() => void choose(true)} className="inline-flex items-center gap-1 rounded-lg bg-qira-pistachio px-3 py-1.5 text-xs font-semibold text-white hover:bg-qira-pistachio-dk disabled:opacity-50">
            <Check size={13} /> {t('requests.approve')}
          </button>
        </div>
      )}
      {stale && owner && request.status === 'pending' && <p className="mt-2 text-xs text-amber-700">{t('app.updateAvailable')}</p>}
      {error && <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-600">{error}</p>}
    </div>
  )
}

/** The owners' inbox: a bar while anything waits, and the list behind it. */
export function OwnerRequestsInbox() {
  const { t } = useI18n()
  const projectId = useStore((state) => state.activeProjectId)
  const requests = useStore((state) => state.ownerRequests)
  const fetchOwnerRequests = useStore((state) => state.fetchOwnerRequests)
  const role = useStore((state) => state.activeProjectRole)
  const isSuperAdmin = useStore((state) => state.profile?.role === 'admin')
  const [open, setOpen] = useState(false)
  const owner = canManageProject(role, isSuperAdmin)

  useEffect(() => {
    if (!projectId) return
    void fetchOwnerRequests()
    const channel = supabase
      .channel(`owner-requests-${projectId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'owner_requests', filter: `project_id=eq.${projectId}` }, () => void fetchOwnerRequests())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [projectId, fetchOwnerRequests])

  const pending = requests.filter((request) => request.status === 'pending')
  if (!owner || pending.length === 0) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 bg-sky-50 px-4 py-1.5 text-sm font-semibold text-sky-900 hover:bg-sky-100"
      >
        <ShieldQuestion size={15} />
        {t('requests.bar', { count: String(pending.length) })}
      </button>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
          <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-2xl bg-surface-card p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-base font-semibold text-slate-900">{t('requests.title')}</p>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1 text-slate-400 hover:text-slate-700" aria-label={t('common.close')}>
                <X size={18} />
              </button>
            </div>
            <p className="mb-3 text-sm text-slate-500">{t('requests.hint')}</p>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {pending.map((request) => <OwnerRequestCard key={request.id} request={request} />)}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
