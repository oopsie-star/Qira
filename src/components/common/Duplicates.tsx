import { useEffect, useMemo, useState } from 'react'
import { Copy, X } from 'lucide-react'
import { useAppIsStale } from '@/lib/appVersion'
import { getErrorMessage } from '@/lib/errors'
import { useI18n } from '@/lib/i18n'
import { supabase } from '@/lib/supabase'
import { useStore } from '@/store'
import type { DuplicateAction, DuplicatePair, ResolveDuplicateAnswer, Task } from '@/types'

// Stage 5. Possible duplicates: a bar with the project's list, a badge on
// cards and rows, and a block in the task window. The rule and the moves are
// in the database (find/list_possible_duplicates, resolve_duplicate); this
// only asks and shows what it answers — including "confirm first".

/** Keeps the store's pairs fresh: on project change and whenever tasks change. */
function useDuplicatePairsRefresh() {
  const projectId = useStore((state) => state.activeProjectId)
  const tasks = useStore((state) => state.tasks)
  const fetchDuplicatePairs = useStore((state) => state.fetchDuplicatePairs)
  const signature = useMemo(() => tasks.map((task) => `${task.id}:${task.title}:${task.status}`).join('|'), [tasks])
  useEffect(() => {
    if (!projectId) return
    const timer = window.setTimeout(() => void fetchDuplicatePairs(), 600)
    return () => window.clearTimeout(timer)
  }, [projectId, signature, fetchDuplicatePairs])
}

export function DuplicateBadge({ taskId }: { taskId: string }) {
  const { t } = useI18n()
  const flagged = useStore((state) => state.duplicateTaskIds.has(taskId))
  if (!flagged) return null
  return (
    <span title={t('dups.badgeHint')} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
      <Copy size={11} /> {t('dups.badge')}
    </span>
  )
}

interface Run {
  keepId: string
  otherId: string
  keepKey: string
  otherKey: string
  action: DuplicateAction
}

/** One decision, with the database's "confirm first" answers in between. */
function ResolveFlow({ run, onDone, onCancel }: { run: Run; onDone: (message: string) => void; onCancel: () => void }) {
  const { t, locale } = useI18n()
  const resolve = useStore((state) => state.resolveDuplicate)
  const [action, setAction] = useState<DuplicateAction>(run.action)
  const [answer, setAnswer] = useState<ResolveDuplicateAnswer | null>(null)
  const [comments, setComments] = useState<{ id: string; body: string }[] | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataConfirmed, setDataConfirmed] = useState(false)

  // new_version moves comments only by choice: list the live ones first.
  useEffect(() => {
    if (action !== 'new_version') return
    let active = true
    void supabase.from('task_comments').select('id, body').eq('task_id', run.otherId).is('archived_at', null).order('created_at')
      .then(({ data }) => { if (active) setComments((data ?? []) as { id: string; body: string }[]) })
    return () => { active = false }
  }, [action, run.otherId])

  async function go(opts: { confirmDataLoss?: boolean; ownerConfirmed?: boolean } = {}) {
    setBusy(true)
    setError(null)
    try {
      const confirmDataLoss = opts.confirmDataLoss ?? dataConfirmed
      if (confirmDataLoss) setDataConfirmed(true)
      const result = await resolve({ keepId: run.keepId, otherId: run.otherId, action, commentIds: action === 'new_version' ? chosen : [], confirmDataLoss, ownerConfirmed: opts.ownerConfirmed })
      if (result.done) {
        const moved = action === 'new_version'
          ? t('dups.doneVersion', {
            other: run.otherKey, keep: run.keepKey,
            files: String(result.moved_attachments ?? 0), comments: String(result.moved_comments ?? 0),
            subtasks: (result.moved_subtasks ?? []).join(', ') || '—',
          })
          : action === 'duplicate' ? t('dups.doneDuplicate', { other: run.otherKey, keep: run.keepKey }) : t('dups.doneNot')
        onDone(moved)
      } else {
        setAnswer(result)
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const holds = answer?.needs_confirmation === 'data' ? answer.other_holds : null
  const ownerAsk = answer?.needs_confirmation === 'owner' ? answer : null
  const btn = 'rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50'

  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-slate-700">
      <p className="font-semibold text-slate-900">{t(`dups.confirm.${action}`, { other: run.otherKey, keep: run.keepKey })}</p>

      {action === 'new_version' && !holds && !ownerAsk && (
        <div className="mt-2">
          <p>{t('dups.versionMoves', { keep: run.keepKey })}</p>
          {comments && comments.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="font-semibold">{t('dups.chooseComments')}</p>
              {comments.map((c) => (
                <label key={c.id} className="flex items-start gap-2">
                  <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen((prev) => e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id))} className="mt-0.5" />
                  <span className="line-clamp-2">{c.body}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {holds && (
        <div className="mt-2">
          <p>{t('dups.holds', { other: run.otherKey })}</p>
          <ul className="mt-1 list-disc pl-4">
            {holds.attachments.map((a) => <li key={a.path}>{a.name}</li>)}
            {holds.live_comments > 0 && <li>{t('dups.holdsComments', { count: String(holds.live_comments) })}</li>}
            {holds.open_subtasks.length > 0 && <li>{t('dups.holdsSubtasks', { keys: holds.open_subtasks.join(', ') })}</li>}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => { setAnswer(null); setAction('new_version') }} className={`${btn} bg-qira-pistachio text-white`}>{t('dups.makeVersion')}</button>
            <button type="button" disabled={busy} onClick={() => void go({ confirmDataLoss: true })} className={`${btn} border border-rose-200 text-rose-700`}>{t('dups.archiveAnyway')}</button>
          </div>
        </div>
      )}

      {ownerAsk && (
        <div className="mt-2">
          <p>{t('dups.ownerAsk', {
            other: run.otherKey,
            who: ownerAsk.started_by ?? '—',
            when: ownerAsk.started_at ? new Date(ownerAsk.started_at).toLocaleString(locale === 'en' ? 'en-GB' : 'ru-RU') : '—',
            signal: ownerAsk.signal ? t(`work.signal.${ownerAsk.signal}`) : '—',
          })}</p>
          <button type="button" disabled={busy} onClick={() => void go({ ownerConfirmed: true })} className={`${btn} mt-2 bg-amber-600 text-white`}>{t('dups.ownerConfirm')}</button>
        </div>
      )}

      {error && <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1.5 text-rose-600">{error}</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        {!holds && !ownerAsk && (
          <button type="button" disabled={busy} onClick={() => void go()} className={`${btn} bg-slate-900 text-white`}>{t('dups.go')}</button>
        )}
        <button type="button" disabled={busy} onClick={onCancel} className={`${btn} border border-slate-200 text-slate-600`}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

/** The three choices for "this task" against one candidate. */
function PairChoices({ thisTask, other, onDone }: { thisTask: { id: string; key: string }; other: { id: string; key: string; title: string; status: string }; onDone: (m: string) => void }) {
  const { t } = useI18n()
  const stale = useAppIsStale()
  const [run, setRun] = useState<Run | null>(null)
  const pick = (action: DuplicateAction) => setRun(
    action === 'duplicate'
      ? { keepId: other.id, keepKey: other.key, otherId: thisTask.id, otherKey: thisTask.key, action }
      : { keepId: thisTask.id, keepKey: thisTask.key, otherId: other.id, otherKey: other.key, action },
  )
  const btn = 'rounded-lg border border-slate-200 bg-surface-card px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50'
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={stale} onClick={() => pick('duplicate')} className={btn}>{t('dups.isDuplicate', { other: other.key, me: thisTask.key })}</button>
        <button type="button" disabled={stale} onClick={() => pick('new_version')} className={btn}>{t('dups.isVersion', { other: other.key, me: thisTask.key })}</button>
        <button type="button" disabled={stale} onClick={() => pick('not_duplicate')} className={btn}>{t('dups.notDuplicate')}</button>
      </div>
      {run && <ResolveFlow run={run} onCancel={() => setRun(null)} onDone={(m) => { setRun(null); onDone(m) }} />}
    </div>
  )
}

const pairOther = (pair: DuplicatePair, taskId: string) =>
  pair.task_a === taskId
    ? { id: pair.task_b, key: pair.key_b, title: pair.title_b, status: pair.status_b }
    : { id: pair.task_a, key: pair.key_a, title: pair.title_a, status: pair.status_a }

/** In the task window: the candidates for this task, with the three choices. */
export function TaskDuplicatePanel({ task }: { task: Pick<Task, 'id' | 'key'> }) {
  const { t } = useI18n()
  const pairs = useStore((state) => state.duplicatePairs).filter((p) => p.task_a === task.id || p.task_b === task.id)
  const [message, setMessage] = useState<string | null>(null)
  if (!pairs.length && !message) return null
  return (
    <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
      {pairs.length > 0 && <p className="text-sm font-semibold text-amber-900">{t('dups.panelTitle')}</p>}
      <div className="mt-2 space-y-3">
        {pairs.map((pair) => {
          const other = pairOther(pair, task.id)
          return (
            <div key={`${pair.task_a}-${pair.task_b}`} className="text-xs">
              <p className="text-slate-700">
                <span className="font-semibold">{other.key}</span> · {other.title}
                <span className="text-slate-500"> · {t(`status.${other.status}`)} · {reasonText(t, pair)}</span>
              </p>
              <div className="mt-1.5"><PairChoices thisTask={task} other={other} onDone={setMessage} /></div>
            </div>
          )
        })}
      </div>
      {message && <p className="mt-2 text-xs text-emerald-800">{message}</p>}
    </div>
  )
}

function reasonText(t: (key: string, vars?: Record<string, string>) => string, pair: DuplicatePair) {
  const base = pair.reason.startsWith('same code') ? t('dups.reason.code', { code: pair.reason.slice('same code '.length) }) : t('dups.reason.similar', { pct: String(Math.round(pair.similarity * 100)) })
  return pair.same_epic ? `${base}, ${t('dups.reason.sameEpic')}` : base
}

/** A pair in the list: choices for one side, and a switch to look from the other. */
function PairRow({ pair, onDone }: { pair: DuplicatePair; onDone: (m: string) => void }) {
  const { t } = useI18n()
  const [flip, setFlip] = useState(false)
  const me = flip ? { id: pair.task_a, key: pair.key_a } : { id: pair.task_b, key: pair.key_b }
  const other = pairOther(pair, me.id)
  return (
    <div>
      <PairChoices key={me.id} thisTask={me} other={other} onDone={onDone} />
      <button type="button" onClick={() => setFlip((v) => !v)} className="mt-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800">
        {t('dups.flip', { key: other.key })}
      </button>
    </div>
  )
}

/** The bar under the header while the project has unsettled pairs, and the list behind it. */
export function DuplicatesBar() {
  const { t } = useI18n()
  useDuplicatePairsRefresh()
  const pairs = useStore((state) => state.duplicatePairs)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  if (pairs.length === 0 && !open) return null
  return (
    <>
      {pairs.length > 0 && (
        <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-2 bg-amber-50 px-4 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-100">
          <Copy size={15} /> {t('dups.bar', { count: String(pairs.length) })}
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
          <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-2xl bg-surface-card p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-base font-semibold text-slate-900">{t('dups.title')}</p>
              <button type="button" onClick={() => { setOpen(false); setMessage(null) }} className="rounded-lg p-1 text-slate-400 hover:text-slate-700" aria-label={t('common.close')}><X size={18} /></button>
            </div>
            <p className="mb-3 text-sm text-slate-500">{t('dups.hint')}</p>
            {message && <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{message}</p>}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {pairs.length === 0 && <p className="text-sm text-slate-500">{t('dups.none')}</p>}
              {pairs.map((pair) => (
                <div key={`${pair.task_a}-${pair.task_b}`} className="rounded-xl border border-slate-200 p-3 text-xs">
                  <p className="text-slate-500">{reasonText(t, pair)}</p>
                  <p className="mt-1 text-slate-800"><span className="font-semibold">{pair.key_a}</span> · {pair.title_a} <span className="text-slate-500">· {t(`status.${pair.status_a}`)}</span></p>
                  <p className="text-slate-800"><span className="font-semibold">{pair.key_b}</span> · {pair.title_b} <span className="text-slate-500">· {t(`status.${pair.status_b}`)}</span></p>
                  <div className="mt-2"><PairRow pair={pair} onDone={setMessage} /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
