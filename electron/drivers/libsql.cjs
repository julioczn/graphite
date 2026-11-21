// LibSQL / Turso over the network (libsql://, https://, wss://, http:// for a
// local sqld). Same SQL and catalog as SQLite; local .db files use the SQLite
// engine instead. Uses the pure-JS web client (HTTP / WebSocket), so no native
// binary has to ship with the app.
//
// The protocol is stateless between requests, so there is no manual
// transaction mode (caps.manualMode = false); atomic work uses the client's
// interactive transactions.
//
// AI reads: sqld neither enforces 'read' transactions nor accepts
// PRAGMA query_only, so the guarantee here is different from the other
// engines: the read runs inside a transaction that is always rolled back,
// never committed. In SQLite even DDL is transactional, so nothing a read
// could sneak in survives (and classify() already refuses non-read commands).
const { normaliseRows, erFrom } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

let clientModule = null
const loadClient = async () => (clientModule ||= await import('@libsql/client/web'))

// Integers arrive as BigInt (no precision loss); keep the safe ones as numbers.
const int = (v) => (typeof v === 'bigint' && v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v)
const bytes = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)
const plain = (row, n) => Array.from({ length: n }, (_, i) => bytes(int(row[i])))

class LibsqlDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'sqlite'
    this.tx = null // open interactive transaction, if any
  }

  quote(id) {
    return `"${String(id).replace(/"/g, '""')}"`
  }

  placeholder() {
    return '?'
  }

  qualified(table) {
    return this.quote(table)
  }

  async connect() {
    const url = (this.config.url || '').trim()
    if (!url) throw new Error(t('Informe a URL do banco LibSQL'))
    const { createClient } = await loadClient()
    // libsql:// means "the default protocol" — WebSocket for Turso.
    this.client = createClient({ url, authToken: this.config.password || undefined, intMode: 'bigint' })
    await this.client.execute('select 1')
  }

  async disconnect() {
    await this.tx?.close?.()
    this.tx = null
    this.client?.close()
    this.client = null
  }

  get runner() {
    return this.tx || this.client
  }

  async version() {
    const r = await this.client.execute('select sqlite_version() as v')
    return 'LibSQL (SQLite ' + r.rows[0][0] + ')'
  }

  async database() {
    try {
      return new URL(this.config.url).hostname || this.config.url
    } catch {
      return this.config.url
    }
  }

  async query(sql, params = []) {
    const r = await this.runner.execute({ sql, args: params })
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, int(row[i])])))
  }

  async execute(text, params = [], opts = {}) {
    const r = await this.runner.execute({ sql: text, args: params })
    if (r.columns.length) {
      const fields = r.columns
      const rows = r.rows.map((row) => plain(row, fields.length))
      if (opts.raw) return { fields, rows }
      const binary = new Set()
      const out = normaliseRows(rows, fields, binary)
      return opts.origins ? { fields, rows: out, origins: fields.map(() => null), binary: [...binary] } : { fields, rows: out }
    }
    return { affected: Number(r.rowsAffected ?? 0) }
  }

  // The server returns whole results; page through them so callers still get batches.
  async *stream(sql, { batch = 1000, raw } = {}) {
    const r = await this.runner.execute(sql.replace(/[\s;]+$/, ''))
    const fields = r.columns
    for (let i = 0; i < r.rows.length || i === 0; i += batch) {
      const rows = r.rows.slice(i, i + batch).map((row) => plain(row, fields.length))
      yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
      if (!r.rows.length) break
    }
  }

  async withTx(mode, fn) {
    if (this.tx) return fn()
    this.tx = await this.client.transaction(mode)
    try {
      const out = await fn()
      if (mode === 'write') await this.tx.commit()
      return out
    } finally {
      this.tx.close()
      this.tx = null
    }
  }

  transaction(fn) {
    return this.withTx('write', fn)
  }

  // AI reads: a transaction that is always rolled back (see the top comment).
  async readOnly(fn) {
    if (this.tx) throw new Error('read-only guard inside an open transaction')
    this.tx = await this.client.transaction('read')
    try {
      return await fn()
    } finally {
      await this.tx.rollback().catch(() => {})
      this.tx.close()
      this.tx = null
    }
  }

  async erModel() {
    const cols = []
    const fks = []
    for (const tb of await this.listTables()) {
      for (const c of await this.listColumns(tb.name)) cols.push({ table: tb.name, kind: tb.type, ...c })
      const byId = new Map()
      for (const f of await this.query('select * from pragma_foreign_key_list(?) order by id, seq', [tb.name])) {
        if (!byId.has(f.id)) byId.set(f.id, { name: `fk_${tb.name}_${f.id}`, table: tb.name, columns: [], refSchema: null, refTable: f.table, refColumns: [] })
        byId.get(f.id).columns.push(f.from)
        byId.get(f.id).refColumns.push(f.to ?? (await this.pkOf(f.table)))
      }
      fks.push(...byId.values())
    }
    return erFrom(null, cols, fks)
  }

  async pkOf(table) {
    return (await this.query('select name from pragma_table_info(?) where pk = 1', [table]))[0]?.name
  }

  async listSchemas() {
    return []
  }

  async currentSchema() {
    return null
  }

  async useSchema() {}

  async listTables() {
    const rows = await this.query(`select name, type from sqlite_master
      where type in ('table','view') and name not like 'sqlite_%' and name not like 'libsql_%' and name not like '_litestream%'
      order by type, name`)
    return rows.map((r) => ({ name: r.name, schema: null, type: r.type }))
  }

  async listColumns(table) {
    const cols = await this.query('select * from pragma_table_info(?)', [table])
    const fks = await this.query('select * from pragma_foreign_key_list(?)', [table])
    const rowid = cols.filter((c) => c.pk > 0).length === 1 ? cols.find((c) => c.pk > 0 && /^integer$/i.test(c.type)) : null
    const out = []
    for (const c of cols) {
      const fk = fks.find((f) => f.from === c.name)
      out.push({
        name: c.name,
        type: c.type || 'ANY',
        nullable: !c.notnull && !c.pk,
        default: c.dflt_value,
        primary: c.pk > 0,
        auto: c === rowid,
        references: fk ? `${fk.table}(${fk.to ?? (await this.pkOf(fk.table))})` : null,
      })
    }
    return out
  }

  async schemaMap() {
    const map = {}
    for (const tb of await this.listTables()) {
      map[tb.name] = (await this.query('select name from pragma_table_info(?)', [tb.name])).map((c) => c.name)
    }
    return map
  }

  async listIndexes(table) {
    const out = []
    for (const ix of await this.query('select * from pragma_index_list(?)', [table])) {
      out.push({
        name: ix.name,
        unique: !!ix.unique,
        primary: ix.origin === 'pk',
        columns: (await this.query('select name from pragma_index_info(?)', [ix.name])).map((c) => c.name),
      })
    }
    return out
  }

  async createScript(table) {
    const r = (await this.query('select sql from sqlite_master where name = ?', [table]))[0]
    return r?.sql ? r.sql + ';' : ''
  }
}

module.exports = LibsqlDriver
