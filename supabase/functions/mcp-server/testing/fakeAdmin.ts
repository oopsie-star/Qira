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
  private single: 'none' | 'maybe' | 'one' = 'none'
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
  maybeSingle() { this.single = 'maybe'; return this }
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
      if (this.single === 'maybe') return { data: matched[0] ?? null, error: null }
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
