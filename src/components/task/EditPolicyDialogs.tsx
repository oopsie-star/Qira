import { useState } from 'react'
import { FilePlus2, Save, X } from 'lucide-react'
import { displayFilename } from '@/lib/attachments'
import { useI18n } from '@/lib/i18n'
import { useStore, type EditPolicy } from '@/store'
import type { Task, TaskComment } from '@/types'

export type EditChoice = 'in_place' | 'revision' | 'cancel'

function startedLine(policy: EditPolicy, locale: string, t: ReturnType<typeof useI18n>['t']) {
  const when = policy.started_at
    ? new Date(policy.started_at).toLocaleString(locale === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—'
  if (policy.signal === 'done_status') return t('edit.closedOn', { when })
  return t('edit.startedBy', {
    who: policy.started_by_name ?? '—',
    when,
    signal: t(`work.signal.${policy.signal ?? 'legacy'}`),
  })
}

/**
 * Before saving a new title or description of a task whose assignee has
 * started (stage 4a). An owner chooses: save in place, or make a new revision.
 * Anyone else is told why it cannot be edited in place, and offered a new
 * revision — or to ask an owner.
 */
export function EditPolicyDialog({ policy, onChoose }: { policy: EditPolicy; onChoose: (choice: EditChoice) => void }) {
  const { t, locale } = useI18n()
  const owner = policy.edit_mode === 'in_place' && policy.owner
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl bg-surface-card p-5 shadow-xl">
        <p className="text-base font-semibold text-slate-900">{owner ? t('edit.ownerTitle') : t('edit.rejectedTitle')}</p>
        <p className="mt-2 text-sm text-slate-700">{startedLine(policy, locale, t)}</p>
        <p className="mt-2 text-sm text-slate-500">{owner ? t('edit.ownerHint') : t('edit.rejectedHint')}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => onChoose('cancel')} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            {t('edit.discard')}
          </button>
          <button
            type="button"
            onClick={() => onChoose('revision')}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            <FilePlus2 size={14} />
            {t('edit.newRevision')}
          </button>
          {owner && (
            <button
              type="button"
              onClick={() => onChoose('in_place')}
              className="inline-flex items-center gap-2 rounded-xl bg-qira-pistachio px-4 py-2 text-sm font-semibold text-white hover:bg-qira-pistachio-dk"
            >
              <Save size={14} />
              {t('edit.saveInPlace')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * create_task_revision, from the app: the new text, which live files and
 * comments move to the revision, and why. The old task is archived.
 */
export function RevisionDialog({
  task,
  title: initialTitle,
  description: initialDescription,
  comments,
  onDone,
  onCancel,
}: {
  task: Task
  title: string
  description: string
  comments: TaskComment[]
  onDone: (newTaskId: string, newKey: string) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const createTaskRevision = useStore((state) => state.createTaskRevision)
  const attachmentNotes = useStore((state) => state.attachmentNotes)
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [files, setFiles] = useState<string[]>(task.attachments)
  const [commentIds, setCommentIds] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id])

  async function submit() {
    if (!reason.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await createTaskRevision(task.id, {
        title: title.trim() || undefined,
        description,
        attachments: files,
        commentIds,
        reason: reason.trim(),
      })
      onDone(result.new_task_id, result.new_key)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-2xl bg-surface-card p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold text-slate-900">{t('revision.title', { key: task.key })}</p>
            <p className="text-sm text-slate-500">{t('revision.hint', { key: task.key })}</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-lg p-1 text-slate-400 hover:text-slate-700" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <label className="block text-xs font-semibold text-slate-500">
            {t('revision.newTitle')}
            <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-surface-card px-3 py-2 text-sm text-slate-800 outline-none focus:border-qira-pistachio" />
          </label>
          <label className="block text-xs font-semibold text-slate-500">
            {t('revision.newDescription')}
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={8} className="mt-1 w-full resize-y rounded-xl border border-slate-200 bg-surface-card px-3 py-2 text-sm text-slate-800 outline-none focus:border-qira-pistachio" />
          </label>

          {task.attachments.length > 0 && (
            <fieldset>
              <legend className="text-xs font-semibold text-slate-500">{t('revision.moveFiles')}</legend>
              {task.attachments.map((path) => (
                <label key={path} className="mt-1 flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={files.includes(path)} onChange={() => setFiles((list) => toggle(list, path))} />
                  <span className="truncate">{displayFilename(path, attachmentNotes[path]?.original_name)}</span>
                </label>
              ))}
            </fieldset>
          )}

          {comments.length > 0 && (
            <fieldset>
              <legend className="text-xs font-semibold text-slate-500">{t('revision.moveComments')}</legend>
              {comments.map((comment) => (
                <label key={comment.id} className="mt-1 flex items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="mt-1" checked={commentIds.includes(comment.id)} onChange={() => setCommentIds((list) => toggle(list, comment.id))} />
                  <span className="line-clamp-2">{comment.body}</span>
                </label>
              ))}
            </fieldset>
          )}

          <label className="block text-xs font-semibold text-slate-500">
            {t('revision.reason')}
            <input value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-surface-card px-3 py-2 text-sm text-slate-800 outline-none focus:border-qira-pistachio" />
          </label>
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!reason.trim() || busy}
            className="inline-flex items-center gap-2 rounded-xl bg-qira-pistachio px-4 py-2 text-sm font-semibold text-white hover:bg-qira-pistachio-dk disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FilePlus2 size={14} />
            {t('revision.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
