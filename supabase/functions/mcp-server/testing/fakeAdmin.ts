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
  private mode: 'select' | 'delete' = 'select'
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
  eq(col: string, val: unknown) { this.predicates.push((r) => r[col] === val); return this }
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

  private rows(): Row[] {
    return (this.db.tables[this.table] ?? []).filter((r) => this.predicates.every((p) => p(r)))
  }

  then<T1, T2>(onfulfilled?: (v: { data: unknown; error: null; count?: number }) => T1 | PromiseLike<T1>, onrejected?: (e: unknown) => T2 | PromiseLike<T2>) {
    return Promise.resolve().then(() => {
      let matched = this.rows()
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

export class FakeAdmin {
  inserted: { table: string; row: Row }[] = []
  deleted: { table: string; row: Row }[] = []
  constructor(public tables: Record<string, Row[]>) {}

  from(table: string) {
    return {
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => new FakeQuery(this, table).select(cols, opts),
      delete: () => new FakeQuery(this, table).delete(),
      insert: (rows: Row | Row[]) => new FakeInsert(this, table, Array.isArray(rows) ? rows : [rows]),
    }
  }
}
