const { DatabaseSync } = require('node:sqlite')
const { normaliseRows, erFrom } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

class SqliteDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'sqlite'
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
    if (!this.config.file) throw new Error(t('Informe o caminho do arquivo SQLite'))
    this.db = new DatabaseSync(this.config.file, { readOnly: !!this.config.readOnly })
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  async disconnect() {
    this.db?.close()
    this.db = null
  }

  async version() {
    return 'SQLite ' + this.db.prepare('select sqlite_version() as v').get().v
  }

  async database() {
    return require('node:path').basename(this.config.file)
  }

  async execute(text, params = [], opts = {}) {
    const stmt = this.db.prepare(text)
    const cols = stmt.columns()
    if (cols.length) {
      stmt.setReturnArrays(true)
      const fields = cols.map((c) => c.name)
      if (opts.raw) {
        stmt.setReadBigInts(true) // no precision loss above 2^53
        return { fields, rows: stmt.all(...params) }
      }
      const binary = new Set()
      const rows = normaliseRows(stmt.all(...params), fields, binary)
      if (!opts.origins) return { fields, rows }
      const origins = cols.map((c) => (c.table && c.column
        ? { schema: c.database && c.database !== 'main' ? c.database : null, table: c.table, column: c.column }
        : null))
      return { fields, rows, origins, binary: [...binary] }
    }
    const res = stmt.run(...params)
    return { affected: Number(res.changes) }
  }

  async *stream(sql, { batch = 1000, raw } = {}) {
    const stmt = this.db.prepare(sql)
    stmt.setReturnArrays(true)
    if (raw) stmt.setReadBigInts(true)
    const fields = stmt.columns().map((c) => c.name)
    let rows = []
    for (const row of stmt.iterate()) {
      rows.push(row)
      if (rows.length >= batch) {
        yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
        rows = []
      }
    }
    yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
  }

  async erModel() {
    const cols = []
    const fks = []
    for (const t of await this.listTables()) {
      for (const c of await this.listColumns(t.name)) cols.push({ table: t.name, kind: t.type, ...c })
      const list = this.db.prepare('select * from pragma_foreign_key_list(?) order by id, seq').all(t.name)
      const byId = new Map()
      for (const f of list) {
        if (!byId.has(f.id)) byId.set(f.id, { name: `fk_${t.name}_${f.id}`, table: t.name, columns: [], refSchema: null, refTable: f.table, refColumns: [] })
        byId.get(f.id).columns.push(f.from)
        // `to` is null when the FK points at the parent's primary key implicitly
        byId.get(f.id).refColumns.push(f.to ?? this.db.prepare('select name from pragma_table_info(?) where pk = 1').get(f.table)?.name)
      }
      fks.push(...byId.values())
    }
    return erFrom(null, cols, fks)
  }

  async listSchemas() {
    return []
  }

  async currentSchema() {
    return null
  }

  async listTables() {
    const rows = this.db
      .prepare(`select name, type from sqlite_master
                where type in ('table','view') and name not like 'sqlite_%'
                order by type, name`)
      .all()
    return rows.map((r) => ({ name: r.name, schema: null, type: r.type }))
  }

  async listColumns(table) {
    const cols = this.db.prepare(`select * from pragma_table_info(?)`).all(table)
    const fks = this.db.prepare(`select * from pragma_foreign_key_list(?)`).all(table)
    // A lone INTEGER PRIMARY KEY is the rowid: SQLite fills it in.
    const rowid = cols.filter((c) => c.pk > 0).length === 1 ? cols.find((c) => c.pk > 0 && /^integer$/i.test(c.type)) : null
    return cols.map((c) => {
      const fk = fks.find((f) => f.from === c.name)
      return {
        name: c.name,
        type: c.type || 'ANY',
        nullable: !c.notnull && !c.pk,
        default: c.dflt_value,
        primary: c.pk > 0,
        auto: c === rowid,
        // `REFERENCES t` without a column points at t's primary key.
        references: fk ? `${fk.table}(${fk.to ?? this.db.prepare('select name from pragma_table_info(?) where pk = 1').get(fk.table)?.name})` : null,
      }
    })
  }

  async schemaMap() {
    const map = {}
    for (const t of await this.listTables()) {
      map[t.name] = this.db.prepare(`select name from pragma_table_info(?)`).all(t.name).map((c) => c.name)
    }
    return map
  }

  async listIndexes(table) {
    const list = this.db.prepare(`select * from pragma_index_list(?)`).all(table)
    return list.map((ix) => ({
      name: ix.name,
      unique: !!ix.unique,
      primary: ix.origin === 'pk',
      columns: this.db.prepare(`select name from pragma_index_info(?)`).all(ix.name).map((c) => c.name),
    }))
  }

  async createScript(table) {
    const r = this.db.prepare(`select sql from sqlite_master where name = ?`).get(table)
    return r?.sql ? r.sql + ';' : ''
  }

  async transaction(fn) {
    this.db.exec('BEGIN')
    try {
      const out = await fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}

module.exports = SqliteDriver
