// A small in-memory stand-in for the supabase-js client, for testing tool
// handlers without a database.
//
// It applies the filters the handlers actually use (eq, not-in, ilike, and the
// `and(...)` groups of .or()) to canned rows, so a test proves what the code
// asks the database for — not merely that it ran. Anything it does not
// implement throws, so a handler that starts using a new query method fails a
// test loudly instead of silently passing against a fake that ignored it.

type Row = Record<string, unknown>
type Predicate = (row: Row) => boolean

function likeToRegExp(pattern: string): RegExp {
  // PostgREST ILIKE: % = any run, _ = one char, backslash escapes either.
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (ch === '%') out += '.*'
    else if (ch === '_') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'is')
}

function parseInList(value: string): string[] {
  return value.replace(/^\(|\)$/g, '').split(',').map((v) => v.trim())
}

/** Supports `and(col.eq.val,col.eq.val),and(...)` and `col.eq.val,col.eq.val`. */
function parseOr(expr: string): Predicate {
  const groups: string[][] = []
  for (const m of expr.matchAll(/and\(([^)]*)\)/g)) groups.push(m[1].split(','))
  if (!groups.length) for (const term of expr.split(',')) groups.push([term])
  // Whatever is left once the and(...) groups are taken out must be only the
  // commas between them — anything else is syntax this fake does not model.
  else if (expr.replace(/and\([^)]*\)/g, '').replace(/,/g, '').trim()) {
    throw new Error(`fakeAdmin: unsupported .or() expression ${expr}`)
  }

  const clauses = groups.map((terms) => terms.map((term) => {
    const [col, op, ...rest] = term.split('.')
    const val = rest.join('.')
    if (op !== 'eq') throw new Error(`fakeAdmin: unsupported .or() operator ${op}`)
    return (row: Row) => String(row[col]) === val
  }))
  return (row) => clauses.some((all) => all.every((p) => p(row)))
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private predicates: Predicate[] = []
  private mode: 'select' | 'delete' | 'update' = 'select'
  private patch: Row = {}
  private wantCount = false
  private headOnly = false
  private singleMode: 'none' | 'maybe' | 'one' = 'none'
  private limitN: number | null = null

  constructor(private db: FakeAdmin, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.wantCount = true
    if (opts?.head) this.headOnly = true
    return this
  }
  eq(col: string, val: unknown) {
    // PostgREST's `json_col->>key` text extraction, as in .eq('result->>id', x).
    const json = col.match(/^(\w+)->>(\w+)$/)
    if (json) {
      this.predicates.push((r) => {
        const obj = r[json[1]] as Record<string, unknown> | null | undefined
        return obj != null && String(obj[json[2]]) === String(val)
      })
    } else this.predicates.push((r) => r[col] === val)
    return this
  }
  is(col: string, val: null) {
    if (val !== null) throw new Error('fakeAdmin: .is() supports only null')
    this.predicates.push((r) => r[col] === null || r[col] === undefined)
    return this
  }
  in(col: string, values: unknown[]) { this.predicates.push((r) => values.includes(r[col])); return this }
  /** Array column contains every given value (PostgREST cs). */
  contains(col: string, values: unknown[]) {
    this.predicates.push((r) => Array.isArray(r[col]) && values.every((v) => (r[col] as unknown[]).includes(v)))
    return this
  }
  ilike(col: string, pattern: string) {
    const re = likeToRegExp(pattern)
    this.predicates.push((r) => typeof r[col] === 'string' && re.test(r[col] as string))
    return this
  }
  not(col: string, op: string, value: string) {
    if (op === 'in') {
      const list = parseInList(value)
      this.predicates.push((r) => !list.includes(String(r[col])))
    } else if (op === 'is' && value === null) {
      this.predicates.push((r) => r[col] !== null && r[col] !== undefined)
    } else throw new Error(`fakeAdmin: unsupported .not(${op})`)
    return this
  }
  or(expr: string) { this.predicates.push(parseOr(expr)); return this }
  order() { return this }
  limit(n: number) { this.limitN = n; return this }
  maybeSingle() { this.singleMode = 'maybe'; return this }
  single() { this.singleMode = 'one'; return this }
  delete() { this.mode = 'delete'; return this }
  update(fields: Row) { this.mode = 'update'; this.patch = fields; return this }

  private rows(): Row[] {
    return (this.db.tables[this.table] ?? []).filter((r) => this.predicates.every((p) => p(r)))
  }

  then<T1, T2>(onfulfilled?: (v: { data: unknown; error: null; count?: number }) => T1 | PromiseLike<T1>, onrejected?: (e: unknown) => T2 | PromiseLike<T2>) {
    return Promise.resolve().then(() => {
      let matched = this.rows()
      if (this.mode === 'update') {
        for (const row of matched) Object.assign(row, this.patch)
        this.db.updated.push(...matched.map((r) => ({ table: this.table, row: r, patch: this.patch })))
      }
      if (this.mode === 'delete') {
        const gone = new Set(matched)
        this.db.tables[this.table] = (this.db.tables[this.table] ?? []).filter((r) => !gone.has(r))
        this.db.deleted.push(...matched.map((r) => ({ table: this.table, row: r })))
      }
      if (this.limitN !== null) matched = matched.slice(0, this.limitN)
      if (this.headOnly) return { data: null, error: null, count: matched.length }
      if (this.singleMode === 'maybe') return { data: matched[0] ?? null, error: null }
      if (this.singleMode === 'one') return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } as unknown as null }
      return { data: matched, error: null, ...(this.wantCount ? { count: matched.length } : {}) }
    }).then(onfulfilled, onrejected)
  }
}

class FakeInsert implements PromiseLike<{ data: null; error: null }> {
  constructor(private db: FakeAdmin, private table: string, private rows: Row[]) {}
  then<T1, T2>(onfulfilled?: (v: { data: null; error: null }) => T1 | PromiseLike<T1>, onrejected?: (e: unknown) => T2 | PromiseLike<T2>) {
    return Promise.resolve().then(() => {
      ;(this.db.tables[this.table] ??= []).push(...this.rows)
      this.db.inserted.push(...this.rows.map((row) => ({ table: this.table, row })))
      return { data: null, error: null as null }
    }).then(onfulfilled, onrejected)
  }
}

type RpcHandler = (params: Row, db: FakeAdmin) => { data: unknown; error: { message: string } | null }

export class FakeAdmin {
  inserted: { table: string; row: Row }[] = []
  deleted: { table: string; row: Row }[] = []
  updated: { table: string; row: Row; patch: Row }[] = []
  rpcCalls: { fn: string; params: Row }[] = []
  /** Storage objects by "bucket/path". */
  files = new Map<string, Uint8Array>()
  rpcHandlers: Record<string, RpcHandler> = {}

  constructor(public tables: Record<string, Row[]>) {}

  from(table: string) {
    return {
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => new FakeQuery(this, table).select(cols, opts),
      delete: () => new FakeQuery(this, table).delete(),
      update: (fields: Row) => new FakeQuery(this, table).update(fields),
      insert: (rows: Row | Row[]) => new FakeInsert(this, table, Array.isArray(rows) ? rows : [rows]),
      upsert: (row: Row, opts?: { onConflict?: string }) => {
        const keys = (opts?.onConflict ?? 'id').split(',')
        const rows = (this.tables[table] ??= [])
        const existing = rows.find((r) => keys.every((k) => r[k] === row[k]))
        if (existing) Object.assign(existing, row)
        else rows.push({ ...row })
        return Promise.resolve({ data: null, error: null })
      },
    }
  }

  rpc(fn: string, params: Row) {
    this.rpcCalls.push({ fn, params })
    const handler = this.rpcHandlers[fn]
    if (!handler) throw new Error(`fakeAdmin: no rpc handler for ${fn}`)
    return Promise.resolve(handler(params, this))
  }

  get storage() {
    return {
      from: (bucket: string) => ({
        upload: (path: string, data: Uint8Array, opts?: { upsert?: boolean }) => {
          const key = `${bucket}/${path}`
          if (this.files.has(key) && !opts?.upsert) return Promise.resolve({ data: null, error: { message: 'The resource already exists' } })
          this.files.set(key, new Uint8Array(data))
          return Promise.resolve({ data: { path }, error: null })
        },
        download: (path: string) => {
          const bytes = this.files.get(`${bucket}/${path}`)
          if (!bytes) return Promise.resolve({ data: null, error: { message: 'Object not found' } })
          return Promise.resolve({ data: new Blob([bytes]), error: null })
        },
        list: (prefix: string) => {
          const base = `${bucket}/${prefix.replace(/\/$/, '')}/`
          const names = [...this.files.keys()].filter((k) => k.startsWith(base)).map((k) => k.slice(base.length)).filter((n) => !n.includes('/'))
          return Promise.resolve({ data: names.map((name) => ({ name })), error: null })
        },
        remove: (paths: string[]) => {
          for (const p of paths) this.files.delete(`${bucket}/${p}`)
          return Promise.resolve({ data: null, error: null })
        },
      }),
    }
  }
}

/**
 * set_attachment_archived as the SQL function behaves: finds the owner in either
 * array, moves the path, stamps attachment_notes, and reports changed: false on
 * a repeat. The SQL itself is verified against the live database; this lets the
 * MCP code around it be tested.
 */
export const fakeSetAttachmentArchived: RpcHandler = (params, db) => {
  const path = params.p_path as string
  const archived = params.p_archived as boolean
  for (const [table, entity] of [['tasks', 'task'], ['epics', 'epic'], ['sprints', 'sprint']] as const) {
    const row = (db.tables[table] ?? []).find((r) =>
      (r.attachments as string[] ?? []).includes(path) || (r.archived_attachments as string[] ?? []).includes(path))
    if (!row) continue
    const live = (row.attachments as string[]) ?? []
    const gone = (row.archived_attachments as string[]) ?? []
    const isLive = live.includes(path)
    const outcome = { path, entity, entity_id: row.id, archived }
    if (archived !== isLive) return { data: { ...outcome, changed: false }, error: null }
    if (archived) {
      row.attachments = live.filter((p) => p !== path)
      row.archived_attachments = [...gone.filter((p) => p !== path), path]
    } else {
      row.archived_attachments = gone.filter((p) => p !== path)
      row.attachments = [...live.filter((p) => p !== path), path]
    }
    const notes = (db.tables.attachment_notes ??= [])
    let note = notes.find((n) => n.project_id === row.project_id && n.path === path)
    if (!note) notes.push(note = { project_id: row.project_id, path })
    Object.assign(note, archived
      ? { archived_at: '2026-11-16T12:00:00Z', archived_by: params.p_actor, archived_by_agent: params.p_agent }
      : { archived_at: null, archived_by: null, archived_by_agent: null })
    return { data: { ...outcome, changed: true }, error: null }
  }
  return { data: null, error: { message: `attachment ${path} is not attached to any task, epic or sprint` } }
}

/**
 * set_comment_archived as the SQL function behaves (20261116020000): stamps or
 * clears the archive columns and reports changed: false on a repeat.
 */
export const fakeSetCommentArchived: RpcHandler = (params, db) => {
  const row = (db.tables.task_comments ?? []).find((c) => c.id === params.p_comment)
  if (!row) return { data: null, error: { message: `comment ${params.p_comment} does not exist` } }
  const archived = params.p_archived as boolean
  const folded = archived && params.p_folded === true
  const isArchived = row.archived_at != null
  const reason = (params.p_reason as string | null | undefined) ?? null
  const base = { comment_id: row.id, task_id: row.task_id, archived }
  if (archived === isArchived && (!archived || ((row.folded_into_description === true) === folded && (reason === null || reason === row.archive_reason)))) {
    return { data: { ...base, folded_into_description: row.folded_into_description === true, reason: row.archive_reason ?? null, changed: false }, error: null }
  }
  if (archived) {
    if (!isArchived) {
      Object.assign(row, { archived_at: '2026-11-16T12:00:00Z', archived_by: params.p_actor, archived_by_agent: params.p_agent })
      // The SQL notifies a person whose comment an agent archives.
      if (params.p_agent && row.author_id !== params.p_actor) {
        ;(db.tables.notifications ??= []).push({ profile_id: row.author_id, task_id: row.task_id, folded, reason })
      }
    }
    row.folded_into_description = folded
    if (reason !== null) row.archive_reason = reason
  } else {
    Object.assign(row, { archived_at: null, archived_by: null, archived_by_agent: null, folded_into_description: false, archive_reason: null })
  }
  return { data: { ...base, folded_into_description: folded, reason: archived ? (row.archive_reason ?? null) : null, changed: true }, error: null }
}

/** update_comment_body: live comments only, edit recorded, changed: false when identical. */
export const fakeUpdateCommentBody: RpcHandler = (params, db) => {
  const row = (db.tables.task_comments ?? []).find((c) => c.id === params.p_comment)
  if (!row) return { data: null, error: { message: `comment ${params.p_comment} does not exist` } }
  if (row.archived_at != null) return { data: null, error: { message: `comment ${row.id} is archived; restore it before editing` } }
  const body = String(params.p_body ?? '').trim()
  const base = { comment_id: row.id, task_id: row.task_id }
  if (body === row.body) return { data: { ...base, changed: false }, error: null }
  ;(db.tables.task_comment_edits ??= []).push({
    comment_id: row.id, old_body: row.body, new_body: body, edited_by: params.p_actor, edited_by_agent: params.p_agent,
  })
  Object.assign(row, { body, edited_at: '2026-11-16T12:00:00Z' })
  return { data: { ...base, changed: true }, error: null }
}

/** Canonical JSON for comparing params as jsonb equality does (key order ignored). */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Row).sort().map((k) => `${JSON.stringify(k)}:${canon((value as Row)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * create_owner_request / apply_owner_request as the SQL behaves
 * (20261118000000): dedupe of open identical requests; apply only an
 * approved, unused request of the same type, task and params; one use.
 * Tests approve a request by setting its status, as an owner's click would.
 */
export function installOwnerRequestFakes(db: FakeAdmin) {
  db.tables.owner_requests ??= []
  db.rpcHandlers.create_owner_request = (params) => {
    const open = db.tables.owner_requests.find((r) => r.request_type === params.p_type && r.task_id === params.p_task
      && canon(r.params) === canon(params.p_params) && (r.status === 'pending' || r.status === 'approved'))
    if (open) return { data: { request_id: open.id, status: open.status, existing: true }, error: null }
    const row = {
      id: db.tables.owner_requests.length + 1, project_id: params.p_project, task_id: params.p_task, request_type: params.p_type,
      params: params.p_params, preview: params.p_preview, reason: params.p_reason, requested_by_agent: params.p_agent,
      status: 'pending', used_at: null, expires_at: '2099-01-01T00:00:00Z',
    }
    db.tables.owner_requests.push(row)
    return { data: { request_id: row.id, status: 'pending', existing: false }, error: null }
  }
  db.rpcHandlers.apply_owner_request = (params) => {
    const r = db.tables.owner_requests.find((x) => x.id === params.p_request)
    if (!r) return { data: null, error: { message: `request ${params.p_request} does not exist` } }
    // As 20261118010000: a refusal is returned (so it can be logged), not raised.
    const fail = (why: string) => {
      ;(db.tables.owner_request_events ??= []).push({ request_id: r.id, event: 'refused', why })
      return { data: { request_id: r.id, refused: true, status: r.status, why: `request ${r.id} ${why}` }, error: null }
    }
    if (r.status === 'pending') return fail('is still waiting for an owner\'s decision')
    if (r.status === 'rejected') return fail('was rejected')
    if (r.status === 'used') return fail('has already been used — a request works once')
    if (r.request_type !== params.p_type) return fail(`is for ${r.request_type}`)
    if (r.task_id !== params.p_task) return fail('is for a different task')
    if (canon(r.params) !== canon(params.p_params)) return fail('was approved for different parameters — send exactly what was requested')
    let result: Row = {}
    if (r.request_type === 'edit_in_place') {
      const t = db.tables.tasks.find((x) => x.id === r.task_id)!
      const p = r.params as Row
      if (p.title !== undefined) t.title = p.title
      if (p.description !== undefined) t.description = p.description
      result = { task_id: t.id, edit_mode: 'approved' }
    } else if (r.request_type === 'delete_attachment') {
      const path = (r.params as Row).path as string
      for (const table of ['tasks', 'epics', 'sprints']) {
        for (const row of db.tables[table] ?? []) {
          row.attachments = ((row.attachments as string[]) ?? []).filter((x) => x !== path)
          row.archived_attachments = ((row.archived_attachments as string[]) ?? []).filter((x) => x !== path)
        }
      }
      result = { paths: [path] }
    } else {
      const ids = (r.params as Row).task_ids as string[]
      const gone = db.tables.tasks.filter((t) => ids.includes(t.id as string) || ids.includes(t.parent_task_id as string))
      db.tables.tasks = db.tables.tasks.filter((t) => !gone.includes(t))
      result = { deleted: gone.map((t) => t.key), skipped: [], paths: gone.flatMap((t) => [...((t.attachments as string[]) ?? []), ...((t.archived_attachments as string[]) ?? [])]) }
    }
    r.status = 'used'
    r.used_at = '2026-11-18T00:00:00Z'
    return { data: { ...result, request_id: r.id }, error: null }
  }
}
