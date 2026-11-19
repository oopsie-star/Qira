import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8'

import { handle, type Deps } from './handler.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

function encodePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

const deps: Deps = {
  secret: Deno.env.get('FILES_TICKET_SECRET')?.trim() ?? '',
  baseUrl: `${supabaseUrl}/functions/v1/files`,
  async userFromJwt(jwt) {
    const { data, error } = await admin.auth.getUser(jwt)
    return error ? null : (data.user?.id ?? null)
  },
  async gate(a) {
    const { data, error } = await admin.rpc('file_gate', {
      p_path: a.path,
      p_channel: a.channel,
      p_purpose: a.purpose,
      p_actor: a.actor,
      p_agent: null,
      p_share_token: a.shareToken,
      p_range: a.range,
      p_ip: a.ip,
      p_user_agent: a.userAgent,
    })
    if (error) {
      console.error('[files] file_gate failed', error.message)
      return { ok: false }
    }
    return data
  },
  fetchObject(bucket, path, range) {
    return fetch(`${supabaseUrl}/storage/v1/object/authenticated/${bucket}/${encodePath(path)}`, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, ...(range ? { Range: range } : {}) },
    })
  },
  async mayRemove(path, actor) {
    const { data, error } = await admin.rpc('file_may_remove', { p_path: path, p_actor: actor })
    return !error && data === true
  },
  async removeObjects(bucket, paths) {
    const { data, error } = await admin.storage.from(bucket).remove(paths)
    return error ? null : (data ?? []).map((o) => o.name)
  },
}

Deno.serve((req) => handle(req, deps))
