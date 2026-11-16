import { useEffect, useRef, useState } from 'react'
import { Play, RotateCcw, X } from 'lucide-react'
import { useAppIsStale } from '@/lib/appVersion'
import { useI18n } from '@/lib/i18n'
import { MIN_WORK_COMMENT } from '@/lib/workStart'
import { useStore } from '@/store'

/**
 * The one window every "start" and "back to To do" goes through — the button,
 * a drag on the board, the status dropdown (stage 4a). Taking into work needs
 * the assignee's own words: an empty field, no template, at least 15
 * characters; the button stays disabled until then.
 */
export function WorkTransitionModal() {
  const { t } = useI18n()
  const pending = useStore((state) => state.workTransition)
  const task = useStore((state) => state.tasks.find((item) => item.id === state.workTransition?.taskId))
  const cancel = useStore((state) => state.cancelWorkTransition)
  const confirm = useStore((state) => state.confirmWorkTransition)
  const stale = useAppIsStale()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setComment('')
    setError(null)
    if (pending) window.setTimeout(() => fieldRef.current?.focus(), 0)
  }, [pending])

  if (!pending || !task) return null

  const take = pending.kind === 'take'
  const length = comment.trim().length
  const ready = length >= MIN_WORK_COMMENT && !busy && !stale

  async function submit() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await confirm(comment.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl bg-surface-card p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold text-slate-900">
              {take ? t('work.takeTitle') : t('work.returnTitle')}
            </p>
            <p className="truncate text-sm text-slate-500">{task.key} · {task.title}</p>
          </div>
          <button type="button" onClick={cancel} className="rounded-lg p-1 text-slate-400 hover:text-slate-700" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <p className="mb-2 text-sm text-slate-600">{take ? t('work.takePrompt') : t('work.returnPrompt')}</p>
        <textarea
          ref={fieldRef}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel()
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
          }}
          rows={5}
          className="w-full resize-y rounded-xl border border-slate-200 bg-surface-card px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-qira-pistachio"
        />
        <p className={['mt-1 text-xs', length >= MIN_WORK_COMMENT ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
          {t('work.minChars', { count: String(Math.max(0, MIN_WORK_COMMENT - length)) })}
        </p>

        {stale && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('app.updateAvailable')}</p>}
        {error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={cancel} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!ready}
            className="inline-flex items-center gap-2 rounded-xl bg-qira-pistachio px-4 py-2 text-sm font-semibold text-white transition hover:bg-qira-pistachio-dk disabled:cursor-not-allowed disabled:opacity-50"
          >
            {take ? <Play size={14} /> : <RotateCcw size={14} />}
            {take ? t('task.startWork') : t('work.returnConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
