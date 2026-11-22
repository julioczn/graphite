// Firebird 3+ (node-firebird, pure JS wire protocol).
//
// - "Database" is the path or alias on the server (e.g. /data/app.fdb, employee).
// - Every statement runs in a transaction: in auto-commit mode each one gets
//   its own; in manual mode they share one until COMMIT / ROLLBACK. A failed
//   statement is undone on its own, so no savepoints are needed.
// - Catalog from the RDB$ system tables; identifiers are stored in upper case.
// - Dates come back as the stored wall-clock text; scaled numerics wider than
//   a double are read as exact text where Graphite writes the query.
// - AI reads run in a READ ONLY transaction, which Firebird enforces.
const Firebird = require('node-firebird')
const { normaliseRows, erFrom, commandOf } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

const cb = (fn) => new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r))))
const pad = (n, w = 2) => String(n).padStart(w, '0')

// SQL type codes (XSQLVAR) of date/time columns.
const SQL_DATE = 570
const SQL_TIME = 560
function cell(v, type) {
  if (!(v instanceof Date)) return v
  const date = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  const ms = v.getMilliseconds()
  const time = `${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}${ms ? '.' + pad(ms, 3) : ''}`
  if (type === SQL_DATE) return date
  if (type === SQL_TIME) return time
  return `${date} ${time}`
}

// RDB$FIELDS → a readable type name.
function typeName(f) {
  const len = f.CHAR_LEN ?? f.FIELD_LENGTH
  const scale = -(f.FIELD_SCALE || 0)
  if ([7, 8, 16, 26].includes(f.FIELD_TYPE) && (f.FIELD_SUB_TYPE === 1 || f.FIELD_SUB_TYPE === 2 || scale)) {
    return `${f.FIELD_SUB_TYPE === 2 ? 'DECIMAL' : 'NUMERIC'}(${f.FIELD_PRECISION || 18},${scale})`
  }
  return ({
    7: 'SMALLINT', 8: 'INTEGER', 16: 'BIGINT', 26: 'INT128', 10: 'FLOAT', 27: 'DOUBLE PRECISION',
    12: 'DATE', 13: 'TIME', 35: 'TIMESTAMP', 28: 'TIME WITH TIME ZONE', 29: 'TIMESTAMP WITH TIME ZONE',
    23: 'BOOLEAN', 24: 'DECFLOAT(16)', 25: 'DECFLOAT(34)',
    14: `CHAR(${len})`, 37: `VARCHAR(${len})`,
    261: f.FIELD_SUB_TYPE === 1 ? 'BLOB SUB_TYPE TEXT' : 'BLOB',
  })[f.FIELD_TYPE] || `TYPE ${f.FIELD_TYPE}`
}

class FirebirdDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'firebird'
    this.tx = null // open transaction (manual mode, atomic work, AI reads)
    this.txSql = { begin: null, release: (n) => `release savepoint ${n} only` }
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
    const c = this.config
    if (!c.database) throw new Error(t('Informe o caminho ou alias do banco Firebird'))
    this.db = await cb((done) => Firebird.attach({
      host: c.host || 'localhost',
      port: Number(c.port) || 3050,
      database: c.database,
      user: c.user || 'SYSDBA',
      password: c.password || '',
      lowercase_keys: false,
      blobAsText: true,
      encoding: 'UTF8',
    }, done))
  }

  async disconnect() {
    if (this.tx) await cb((d) => this.tx.rollback(d)).catch(() => {})
    this.tx = null
    await cb((d) => this.db?.detach(d)).catch(() => {})
    this.db = null
  }

  // A statement on the open transaction, or in its own (auto-commit).
  async run(sql, params = []) {
    const text = sql.trim().replace(/[\s;]+$/, '')
    const cmd = commandOf(text)
    if (this.tx && (cmd === 'COMMIT' || (cmd === 'ROLLBACK' && !/\bto\b/i.test(text)))) {
      await cb((d) => this.tx[cmd === 'COMMIT' ? 'commit' : 'rollback'](d))
      this.tx = null
      return { rows: [], fields: [], affectedRows: 0 }
    }
    if (this.tx) return this.tx.executeAsync(text, params, { withMeta: true })
    const tx = await this.db.transactionAsync(Firebird.ISOLATION_READ_COMMITTED)
    try {
      const r = await tx.executeAsync(text, params, { withMeta: true })
      await cb((d) => tx.commit(d))
      return r
    } catch (e) {
      await cb((d) => tx.rollback(d)).catch(() => {})
      throw e
    }
  }

  async execute(text, params = [], opts = {}) {
    const r = await this.run(text, params)
    if (r.fields?.length) {
      const fields = r.fields.map((f) => f.alias || f.field)
      const rows = (r.rows || []).map((row) => row.map((v, i) => cell(v, r.fields[i].type)))
      if (opts.raw) return { fields, rows }
      const binary = new Set()
      const out = normaliseRows(rows, fields, binary)
      return opts.origins ? { fields, rows: out, origins: fields.map(() => null), binary: [...binary] } : { fields, rows: out }
    }
    return { affected: Number(r.affectedRows ?? 0) }
  }

  async query(sql, params = []) {
    const r = await this.execute(sql, params, { raw: true })
    return (r.rows || []).map((row) => Object.fromEntries(r.fields.map((f, i) => [f, typeof row[i] === 'string' ? row[i].trimEnd() : row[i]])))
  }

  // Rows with backpressure through node-firebird's queryStream.
  async *stream(sql, { batch = 1000, raw } = {}) {
    const own = !this.tx
    const tx = this.tx || (await this.db.transactionAsync(Firebird.ISOLATION_READ_COMMITTED))
    const st = tx.queryStream(sql.trim().replace(/[\s;]+$/, ''), [], { asObject: true })
    let fields = null
    let rows = []
    try {
      for await (const row of st) {
        fields ||= Object.keys(row)
        rows.push(fields.map((f) => cell(row[f])))
        if (rows.length >= batch) {
          yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
          rows = []
        }
      }
      fields ||= []
      yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
    } finally {
      st.destroy?.()
      if (own) await cb((d) => tx.rollback(d)).catch(() => {})
    }
  }

  pageSql({ cols = '*', from, filter, order, limit, offset }) {
    return `select ${cols} from ${from}${filter}${order} offset ${offset} rows fetch next ${limit} rows only`
  }

  async beginTx() {
    if (!this.tx) this.tx = await this.db.transactionAsync(Firebird.ISOLATION_READ_COMMITTED)
  }

  async transaction(fn) {
    if (this.tx) return fn()
    this.tx = await this.db.transactionAsync(Firebird.ISOLATION_READ_COMMITTED)
    try {
      const out = await fn()
      await cb((d) => this.tx.commit(d))
      return out
    } catch (e) {
      await cb((d) => this.tx.rollback(d)).catch(() => {})
      throw e
    } finally {
      this.tx = null
    }
  }

  // AI reads: a READ ONLY transaction (enforced by Firebird), always rolled back.
  async readOnly(fn) {
    if (this.tx) throw new Error('read-only guard inside an open transaction')
    this.tx = await this.db.transactionAsync(Firebird.ISOLATION_READ_COMMITTED_READ_ONLY)
    try {
      return await fn()
    } finally {
      await cb((d) => this.tx.rollback(d)).catch(() => {})
      this.tx = null
    }
  }

  async beginSnapshot() {
    this.tx = await this.db.transactionAsync(Firebird.ISOLATION_REPEATABLE_READ)
  }

  // Scaled numerics are decoded into doubles; where Graphite writes the query
  // (browsing, exports) the wide ones are read as text.
  async selectList(table) {
    const cols = await this.listColumns(table).catch(() => [])
    if (!cols.some((c) => /^(NUMERIC|DECIMAL)\((1[6-9]|[2-9]\d)/.test(c.type) || /^(DECFLOAT|INT128)/.test(c.type))) return '*'
    return cols.map((c) => {
      const q = this.quote(c.name)
      return /^(NUMERIC|DECIMAL)\((1[6-9]|[2-9]\d)/.test(c.type) || /^(DECFLOAT|INT128)/.test(c.type) ? `cast(${q} as varchar(64)) as ${q}` : q
    }).join(', ')
  }

  async version() {
    const r = await this.query("select rdb$get_context('SYSTEM', 'ENGINE_VERSION') as v from rdb$database")
    return 'Firebird ' + r[0].V
  }

  async database() {
    return String(this.config.database).split(/[\\/]/).pop()
  }

  async listSchemas() {
    return []
  }

  async currentSchema() {
    return null
  }

  async useSchema() {}

  async listTables() {
    const rows = await this.query(
      `select trim(rdb$relation_name) as name, iif(rdb$view_blr is null, 'table', 'view') as kind
       from rdb$relations where coalesce(rdb$system_flag, 0) = 0
       order by 2, 1`,
    )
    return rows.map((r) => ({ name: r.NAME, schema: null, type: r.KIND }))
  }

  async listColumns(table) {
    const cols = await this.query(
      `select trim(rf.rdb$field_name) as name, f.rdb$field_type as field_type, f.rdb$field_sub_type as field_sub_type,
              f.rdb$field_length as field_length, f.rdb$character_length as char_len, f.rdb$field_precision as field_precision,
              f.rdb$field_scale as field_scale, rf.rdb$null_flag as not_null, f.rdb$null_flag as domain_not_null,
              cast(coalesce(rf.rdb$default_source, f.rdb$default_source) as varchar(1000)) as dflt,
              rf.rdb$identity_type as identity_type, iif(f.rdb$computed_blr is null, 0, 1) as computed
       from rdb$relation_fields rf join rdb$fields f on f.rdb$field_name = rf.rdb$field_source
       where rf.rdb$relation_name = ? order by rf.rdb$field_position`,
      [table],
    )
    const keys = await this.query(
      `select trim(rc.rdb$constraint_type) as ct, trim(seg.rdb$field_name) as col,
              trim(rrc.rdb$relation_name) as ref_table, trim(rseg.rdb$field_name) as ref_col
       from rdb$relation_constraints rc
       join rdb$index_segments seg on seg.rdb$index_name = rc.rdb$index_name
       left join rdb$ref_constraints ref on ref.rdb$constraint_name = rc.rdb$constraint_name
       left join rdb$relation_constraints rrc on rrc.rdb$constraint_name = ref.rdb$const_name_uq
       left join rdb$index_segments rseg on rseg.rdb$index_name = rrc.rdb$index_name and rseg.rdb$field_position = seg.rdb$field_position
       where rc.rdb$relation_name = ? and rc.rdb$constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`,
      [table],
    )
    return cols.map((c) => {
      const fk = keys.find((k) => k.CT === 'FOREIGN KEY' && k.COL === c.NAME)
      return {
        name: c.NAME,
        type: typeName(c),
        nullable: !c.NOT_NULL && !c.DOMAIN_NOT_NULL,
        default: c.DFLT ? c.DFLT.replace(/^\s*default\s+/i, '') : null,
        primary: keys.some((k) => k.CT === 'PRIMARY KEY' && k.COL === c.NAME),
        auto: c.IDENTITY_TYPE != null || c.COMPUTED === 1,
        references: fk ? `${fk.REF_TABLE}(${fk.REF_COL})` : null,
      }
    })
  }

  async schemaMap() {
    const rows = await this.query(
      `select trim(rf.rdb$relation_name) as t, trim(rf.rdb$field_name) as c
       from rdb$relation_fields rf join rdb$relations r on r.rdb$relation_name = rf.rdb$relation_name
       where coalesce(r.rdb$system_flag, 0) = 0 order by rf.rdb$relation_name, rf.rdb$field_position`,
    )
    const map = {}
    for (const r of rows) (map[r.T] ||= []).push(r.C)
    return map
  }

  async listIndexes(table) {
    const rows = await this.query(
      `select trim(i.rdb$index_name) as name, coalesce(i.rdb$unique_flag, 0) as uniq,
              (select count(*) from rdb$relation_constraints rc where rc.rdb$index_name = i.rdb$index_name and rc.rdb$constraint_type = 'PRIMARY KEY') as pk,
              trim(s.rdb$field_name) as col
       from rdb$indices i join rdb$index_segments s on s.rdb$index_name = i.rdb$index_name
       where i.rdb$relation_name = ? order by i.rdb$index_name, s.rdb$field_position`,
      [table],
    )
    const map = new Map()
    for (const r of rows) {
      if (!map.has(r.NAME)) map.set(r.NAME, { name: r.NAME, unique: r.UNIQ === 1, primary: r.PK > 0, columns: [] })
      map.get(r.NAME).columns.push(r.COL)
    }
    return [...map.values()]
  }

  // No SHOW CREATE in Firebird: views from their source, tables from the catalog.
  async createScript(table) {
    const view = (await this.query('select cast(rdb$view_source as varchar(8000)) as src from rdb$relations where rdb$relation_name = ? and rdb$view_blr is not null', [table]))[0]
    if (view) return `CREATE VIEW ${this.quote(table)} AS\n${String(view.SRC).trim()};`
    const cols = await this.listColumns(table)
    const lines = cols.map((c) => `  ${this.quote(c.name)} ${c.type}${c.auto ? ' GENERATED BY DEFAULT AS IDENTITY' : ''}${c.default ? ' DEFAULT ' + c.default : ''}${c.nullable ? '' : ' NOT NULL'}`)
    const pk = cols.filter((c) => c.primary).map((c) => this.quote(c.name))
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`)
    for (const c of cols.filter((x) => x.references)) {
      const [, refTable, refCol] = /^(.*)\((.*)\)$/.exec(c.references)
      lines.push(`  FOREIGN KEY (${this.quote(c.name)}) REFERENCES ${this.quote(refTable)} (${this.quote(refCol)})`)
    }
    return `CREATE TABLE ${this.quote(table)} (\n${lines.join(',\n')}\n);`
  }

  async erModel() {
    const cols = []
    const fks = []
    for (const tb of await this.listTables()) {
      const list = await this.listColumns(tb.name)
      for (const c of list) cols.push({ table: tb.name, kind: tb.type, ...c })
      const byRef = new Map()
      for (const c of list.filter((x) => x.references)) {
        const [, refTable, refCol] = /^(.*)\((.*)\)$/.exec(c.references)
        byRef.set(`${c.name}`, { name: `fk_${tb.name}_${c.name}`, table: tb.name, columns: [c.name], refSchema: null, refTable, refColumns: [refCol] })
      }
      fks.push(...byRef.values())
    }
    return erFrom(null, cols, fks)
  }
}

module.exports = FirebirdDriver
