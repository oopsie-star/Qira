import { createContext, useContext } from 'react'
import type { FilePurpose } from '@/lib/fileGateway'

/**
 * Why files are being opened in this part of the screen. A task in the archive
 * (or the trash) is viewed as archive: its files are no longer live, and the
 * file gateway serves archived files only for purpose 'archive' (members only,
 * logged). The task drawer sets it; everything that loads file URLs inside it
 * reads it, so an archived task's files, inline images and voice notes open
 * instead of answering "Not found".
 */
export const FilePurposeContext = createContext<FilePurpose>('view')

export function useFilePurpose(): FilePurpose {
  return useContext(FilePurposeContext)
}
