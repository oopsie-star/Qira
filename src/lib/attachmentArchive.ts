import { supabase } from '@/lib/supabase'

/**
 * Archives or restores one attachment through set_attachment_archived — the only
 * way a file moves between `attachments` and `archived_attachments`. The RPC
 * finds the owning task, epic or sprint itself, records who did it, and is safe
 * to repeat. Throws with the database's message on refusal (a viewer, a path
 * attached nowhere).
 */
export async function setAttachmentArchived(path: string, archived: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_attachment_archived', { p_path: path, p_archived: archived })
  if (error) throw new Error(error.message)
}
