import { useEffect, useState } from 'react'
import { fileUrls } from '@/lib/fileGateway'
import { useFilePurpose } from '@/lib/filePurpose'

export interface SignedAttachment {
  path: string
  signedUrl: string | null
}

/**
 * URLs for a list of attachment paths, through the file gateway (checked at
 * every request; no storage signed URLs). Returns the list plus a path→url
 * lookup map for inline rendering.
 */
export function useSignedAttachments(attachments: string[]): {
  signed: SignedAttachment[]
  urlByPath: Map<string, string>
} {
  const [signed, setSigned] = useState<SignedAttachment[]>([])
  const purpose = useFilePurpose()

  // Stable dependency key so re-renders with an equal array don't refetch.
  const key = `${purpose}#${attachments.join('|')}`

  useEffect(() => {
    let active = true

    async function load() {
      if (!attachments.length) {
        setSigned([])
        return
      }
      const urls = await fileUrls(attachments, purpose).catch(() => new Map<string, string>())
      if (active) setSigned(attachments.map((path) => ({ path, signedUrl: urls.get(path) ?? null })))
    }

    void load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const urlByPath = new Map<string, string>()
  for (const s of signed) if (s.signedUrl) urlByPath.set(s.path, s.signedUrl)

  return { signed, urlByPath }
}
