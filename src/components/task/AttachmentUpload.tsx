import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { Archive, ChevronDown, ChevronRight, FileText, Loader2, Mic, Music, RotateCcw, Square, Upload, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { setAttachmentArchived } from '@/lib/attachmentArchive'
import { checkAppVersion, useAppIsStale } from '@/lib/appVersion'
import { getErrorMessage } from '@/lib/errors'
import { useI18n } from '@/lib/i18n'
import { displayFilename, isImage, previewKind, safeFilename, storageBucket } from '@/lib/attachments'
import { useStore } from '@/store'
import { AttachmentPreview } from './AttachmentPreview'

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

interface SignedAttachment {
  path: string
  signedUrl: string | null
}

interface AttachmentUploadProps {
  /** Storage path prefix this widget uploads under, e.g. `${projectId}/${taskId}` or `${projectId}/epics/${epicId}` — the author id and filename are appended. */
  pathPrefix: string
  currentUserId: string | null
  attachments: string[]
  /** Whether the given uploader (path's author id) may delete a given attachment. */
  canDelete: (authorId: string | null) => boolean
  onAttachmentsChange: (paths: string[]) => Promise<void>
  /**
   * Passing this turns removal into archiving: the file moves to the archive
   * through set_attachment_archived and stays restorable, nothing is deleted.
   * Only tasks, epics and sprints have an archive — a caller that omits this
   * (the project map) keeps the old delete.
   */
  archivedAttachments?: string[]
  /** Local-only update after an archive/restore — the RPC has already written the database. */
  onArchiveChange?: (live: string[], archived: string[]) => void
  /** Use the full page width on desktop (more columns) — for full-width contexts like an epic/sprint section, not the narrow task drawer. */
  wide?: boolean
}

function getAttachmentAuthorId(path: string) {
  const parts = path.split('/')
  return parts[parts.length - 2] ?? null
}

export function AttachmentUpload({
  pathPrefix,
  currentUserId,
  attachments,
  canDelete,
  onAttachmentsChange,
  archivedAttachments,
  onArchiveChange,
  wide = false,
}: AttachmentUploadProps) {
  const archiveMode = archivedAttachments !== undefined
  // An outdated tab must not change files: its bundle may not know the rules
  // (archive instead of delete) the current build and database follow.
  const stale = useAppIsStale()
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { t } = useI18n()
  const attachmentNotes = useStore((state) => state.attachmentNotes)
  const updateAttachmentNote = useStore((state) => state.updateAttachmentNote)
  const recordAttachmentOriginalName = useStore((state) => state.recordAttachmentOriginalName)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signedAttachments, setSignedAttachments] = useState<SignedAttachment[]>([])
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    async function loadSignedUrls() {
      if (!attachments.length) {
        setSignedAttachments([])
        return
      }

      const results = await Promise.all(
        attachments.map(async (path) => {
          const { data } = await supabase.storage
            .from(storageBucket(path))
            .createSignedUrl(path, 3600)

          return { path, signedUrl: data?.signedUrl ?? null }
        })
      )

      if (active) {
        setSignedAttachments(results)
      }
    }

    loadSignedUrls()
    return () => {
      active = false
    }
  }, [attachments])

  // Re-asks the server just before a change, so a tab that has not polled
  // since a deploy is still caught. Returns true when the change may go ahead.
  async function ensureCurrent(): Promise<boolean> {
    if (stale || (await checkAppVersion())) {
      setError(t('attachments.staleApp'))
      return false
    }
    return true
  }

  async function uploadFiles(files: File[]) {
    if (!files.length) return
    if (!(await ensureCurrent())) return
    setUploading(true)
    setError(null)
    const newPaths: string[] = []

    try {
      for (const file of files) {
        const nextPath = `${pathPrefix}/${currentUserId ?? 'unknown'}/${Date.now()}-${safeFilename(file.name)}`
        const { error } = await supabase.storage
          .from('attachments')
          .upload(nextPath, file, { upsert: false })

        if (error) throw error
        newPaths.push(nextPath)
        void recordAttachmentOriginalName(pathPrefix.split('/')[0], nextPath, file.name, file.type)
      }

      if (newPaths.length) {
        await onAttachmentsChange([...attachments, ...newPaths])
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setUploading(false)
    }
  }

  function clearRecordTimer() {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
  }

  async function startRecording() {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = ['audio/webm', 'audio/ogg', 'audio/mp4'].find((candidate) => MediaRecorder.isTypeSupported(candidate))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recordedChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const extension = recorder.mimeType?.includes('ogg') ? 'ogg' : recorder.mimeType?.includes('mp4') ? 'm4a' : 'webm'
        const file = new File([blob], `voice-comment-${Date.now()}.${extension}`, { type: blob.type })
        void uploadFiles([file])
      }

      recorder.start()
      mediaRecorderRef.current = recorder
      setRecordSeconds(0)
      setRecording(true)
      clearRecordTimer()
      recordTimerRef.current = window.setInterval(() => setRecordSeconds((value) => value + 1), 1000)
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
    setRecording(false)
    clearRecordTimer()
  }

  useEffect(() => () => {
    clearRecordTimer()
    mediaRecorderRef.current?.stop()
  }, [])

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragOver(false)
    uploadFiles(Array.from(event.dataTransfer.files))
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    uploadFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  async function handleDelete(path: string) {
    if (!canDelete(getAttachmentAuthorId(path))) return
    if (!(await ensureCurrent())) return

    if (archiveMode) {
      setError(null)
      setArchiveBusy(path)
      try {
        await setAttachmentArchived(path, true)
        onArchiveChange?.(attachments.filter((item) => item !== path), [...(archivedAttachments ?? []), path])
      } catch (err) {
        setError(getErrorMessage(err))
      } finally {
        setArchiveBusy(null)
      }
      return
    }

    await supabase.storage.from(storageBucket(path)).remove([path])
    if (attachmentNotes[path]) void updateAttachmentNote(path, '')
    await onAttachmentsChange(attachments.filter((item) => item !== path))
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-surface-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-900">{t('task.attachments')}</p>
        {typeof MediaRecorder !== 'undefined' && (
          recording ? (
            <button
              type="button"
              onClick={stopRecording}
              className="flex items-center gap-1.5 text-sm font-medium text-rose-600"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-600" aria-hidden />
              {formatSeconds(recordSeconds)}
              <Square size={13} />
            </button>
          ) : (
            <button
              type="button"
              disabled={stale}
              onClick={() => void startRecording()}
              title={t('task.recordVoiceComment')}
              aria-label={t('task.recordVoiceComment')}
              className="text-slate-400 transition hover:text-qira-pistachio disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Mic size={16} />
            </button>
          )
        )}
      </div>

      {signedAttachments.length > 0 ? (
        <>
          {signedAttachments.some(({ path }) => previewKind(path, attachmentNotes[path]?.mime_type) === 'audio') && (
            <div className="mb-3 space-y-1.5">
              {signedAttachments
                .filter(({ path }) => previewKind(path, attachmentNotes[path]?.mime_type) === 'audio')
                .map(({ path }) => (
                  <div key={path} className="group flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setPreviewPath(path)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Music size={15} className="shrink-0 text-qira-pistachio" />
                      <span className="truncate text-sm text-slate-700">
                        {displayFilename(path, attachmentNotes[path]?.original_name)}
                      </span>
                    </button>
                    {canDelete(getAttachmentAuthorId(path)) && (
                      <button
                        type="button"
                        onClick={() => handleDelete(path)}
                        disabled={stale || archiveBusy === path}
                        title={archiveMode ? t('attachments.archive') : t('common.delete')}
                        aria-label={archiveMode ? t('attachments.archive') : t('common.delete')}
                        className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-surface-card hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {archiveMode ? <Archive size={14} /> : <X size={14} />}
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}

          {signedAttachments.some(({ path }) => previewKind(path, attachmentNotes[path]?.mime_type) !== 'audio') && (
            <div className={['mb-4 grid gap-3 sm:grid-cols-2', wide ? 'lg:grid-cols-3 xl:grid-cols-4' : ''].join(' ')}>
              {signedAttachments
                .filter(({ path }) => previewKind(path, attachmentNotes[path]?.mime_type) !== 'audio')
                .map(({ path, signedUrl }) => (
                  <div key={path} className="group rounded-xl border border-slate-200 bg-slate-50 p-2">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {displayFilename(path, attachmentNotes[path]?.original_name)}
                        </p>
                      </div>
                      {canDelete(getAttachmentAuthorId(path)) && (
                        <button
                          type="button"
                          onClick={() => handleDelete(path)}
                          disabled={stale || archiveBusy === path}
                          title={archiveMode ? t('attachments.archive') : t('common.delete')}
                          aria-label={archiveMode ? t('attachments.archive') : t('common.delete')}
                          className="rounded-lg p-1 text-slate-400 transition hover:bg-surface-card hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {archiveMode ? <Archive size={14} /> : <X size={14} />}
                        </button>
                      )}
                    </div>

                    <div className="flex items-start gap-2">
                      {isImage(path) && signedUrl ? (
                        <button type="button" onClick={() => setPreviewPath(path)} className="block shrink-0">
                          <img
                            src={signedUrl}
                            alt={displayFilename(path, attachmentNotes[path]?.original_name)}
                            className="h-20 w-20 rounded-xl border border-slate-200 object-cover"
                          />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPreviewPath(path)}
                          className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 bg-surface-card px-1 text-qira-pistachio transition hover:border-qira-pistachio hover:bg-qira-pistachio-lt/40"
                        >
                          <FileText size={18} />
                        </button>
                      )}

                      <textarea
                        key={path}
                        defaultValue={attachmentNotes[path]?.body ?? ''}
                        onBlur={(event) => {
                          const value = event.target.value
                          if (value !== (attachmentNotes[path]?.body ?? '')) void updateAttachmentNote(path, value)
                        }}
                        placeholder={t('task.attachmentNotePlaceholder')}
                        rows={3}
                        className="min-w-0 flex-1 resize-none rounded-xl border border-slate-200 bg-surface-card px-2.5 py-2 text-xs text-slate-700 outline-none transition focus:border-qira-pistachio"
                      />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      ) : (
        <p className="mb-4 text-sm text-slate-500">{t('task.noFiles')}</p>
      )}

      {archiveMode && (archivedAttachments?.length ?? 0) > 0 && (
        <div className="mb-4 rounded-xl bg-slate-50 px-3 py-2">
          <button
            type="button"
            onClick={() => setArchiveOpen((value) => !value)}
            aria-expanded={archiveOpen}
            className="flex w-full items-center gap-2 text-left text-xs font-semibold text-slate-500 transition hover:text-slate-700"
          >
            {archiveOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Archive size={13} />
            {t('attachments.archived')} · {archivedAttachments?.length}
          </button>
          {archiveOpen && (
            <ul className="mt-2 space-y-1">
              {archivedAttachments?.map((path) => (
                <li key={path} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                    {displayFilename(path, attachmentNotes[path]?.original_name)}
                  </span>
                  <button
                    type="button"
                    disabled={stale || archiveBusy === path}
                    onClick={async () => {
                      if (!(await ensureCurrent())) return
                      setError(null)
                      setArchiveBusy(path)
                      try {
                        const { position } = await setAttachmentArchived(path, false)
                        // Back where it was, as the database put it; the end if unknown.
                        const live = attachments.filter((item) => item !== path)
                        const at = position === null ? live.length : Math.min(position, live.length)
                        onArchiveChange?.([...live.slice(0, at), path, ...live.slice(at)], (archivedAttachments ?? []).filter((item) => item !== path))
                      } catch (err) {
                        setError(getErrorMessage(err))
                      } finally {
                        setArchiveBusy(null)
                      }
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-qira-pistachio-dk transition hover:bg-surface-card disabled:opacity-50"
                  >
                    <RotateCcw size={12} />
                    {t('attachments.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {stale && !error && (
        <p className="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{t('attachments.staleApp')}</p>
      )}

      {error && (
        <p className="mb-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>
      )}

      <div
        role="button"
        tabIndex={stale ? -1 : 0}
        aria-disabled={stale}
        onClick={() => !stale && fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (!stale && (event.key === 'Enter' || event.key === ' ')) fileInputRef.current?.click()
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (!stale) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={[
          'rounded-2xl border border-dashed px-4 py-3 text-center transition',
          stale ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          dragOver ? 'border-qira-pistachio bg-qira-pistachio-lt' : 'border-slate-200 bg-slate-50 hover:border-slate-300',
        ].join(' ')}
      >
        {uploading ? (
          <div className="flex justify-center">
            <Loader2 size={16} className="animate-spin text-qira-pistachio" />
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2">
            <Upload size={16} className="shrink-0 text-slate-500" />
            <p className="text-sm text-slate-600">{t('task.dropFiles')}</p>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInput}
      />

      {previewPath && (
        <AttachmentPreview
          path={previewPath}
          signedUrl={signedAttachments.find((item) => item.path === previewPath)?.signedUrl ?? null}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </div>
  )
}
