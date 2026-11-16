import { RefreshCw } from 'lucide-react'
import { useAppIsStale } from '@/lib/appVersion'
import { useI18n } from '@/lib/i18n'

export function UpdateBanner() {
  const stale = useAppIsStale()
  const { t } = useI18n()
  if (!stale) return null

  return (
    <div role="status" className="flex items-center justify-center gap-3 bg-amber-100 px-4 py-2 text-sm text-amber-900">
      <span>{t('app.updateAvailable')}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-900 px-3 py-1 text-xs font-semibold text-amber-50 transition hover:bg-amber-800"
      >
        <RefreshCw size={12} />
        {t('app.reload')}
      </button>
    </div>
  )
}
