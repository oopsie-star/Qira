// Short tickets for <img>/<video>/<iframe> src: a browser cannot send the
// session token with those, so the app asks for a ticket (with the token) and
// puts it in the URL. A ticket only says WHO asked for WHAT file and until
// when; it grants nothing by itself — every request with it is checked again
// against the database (file still live? still a member?).

export type Purpose = 'view' | 'archive'

export interface Ticket {
  /** channel: tickets are only ever for the app */
  c: 'app'
  /** profile id */
  u: string
  /** storage path */
  p: string
  pu: Purpose
  /** expiry, unix seconds */
  e: number
}

export const TICKET_TTL_SECONDS = 60 * 60

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function key(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signTicket(secret: string, t: Ticket): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(t)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)))
  return `${body}.${b64url(sig)}`
}

/** The ticket if its signature is ours and it has not expired; otherwise null. */
export async function verifyTicket(secret: string, raw: string, nowSeconds = Date.now() / 1000): Promise<Ticket | null> {
  const [body, sig, extra] = raw.split('.')
  if (!body || !sig || extra !== undefined) return null
  let ok = false
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), unb64url(sig), enc.encode(body))
  } catch {
    return null
  }
  if (!ok) return null
  try {
    const t = JSON.parse(new TextDecoder().decode(unb64url(body))) as Ticket
    if (t.c !== 'app' || typeof t.u !== 'string' || typeof t.p !== 'string' || (t.pu !== 'view' && t.pu !== 'archive') || typeof t.e !== 'number') return null
    return t.e > nowSeconds ? t : null
  } catch {
    return null
  }
}
