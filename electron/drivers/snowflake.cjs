// Snowflake through its SQL API v2 (POST /api/v2/statements), with a
// Programmatic Access Token (PAT) — or an OAuth token — as the bearer.
// No dependency: plain fetch.
//
// - The API is stateless: database / schema / warehouse / role go with every
//   request (the picker changes them; a typed USE doesn't persist).
// - Values arrive as text; dates as days since 1970, times and timestamps as
//   seconds — converted here to readable text by column type.
// - No interactive transactions across requests: read-only grid, no manual mode.
// - AI: no read-only mode to rely on, so every AI query needs approval.
// Beta: written against Snowflake's documentation, not yet run against a real account.
const { normaliseRows, erFrom, commandOf } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

const pad = (n, w = 2) => String(n).padStart(w, '0')
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const hms = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

// "1700000000.123456789" → Date (ms precision) + the fraction digits.
function fromSeconds(text) {
  const [sec, frac = ''] = String(text).split('.')
  const d = new Date(Number(sec) * 1000)
  return { d, frac: frac.replace(/0+$/, '') }
}

function convert(v, col) {
  if (v === null || v === undefined) return null
  const type = String(col.type).toLowerCase()
  if (type === 'fixed') return col.scale === 0 && /^-?\d{1,15}$/.test(v) ? Number(v) : v
  if (type === 'real') return Number(v)
  if (type === 'boolean') return v === 'true' || v === '1'
  if (type === 'date') return ymd(new Date(Number(v) * 86400000))
  if (type === 'time') {
    const { d, frac } = fromSeconds(v)
    return hms(d) + (frac ? '.' + frac : '')
  }
  if (type === 'timestamp_ntz' || type === 'timestamp_ltz') {
    const { d, frac } = fromSeconds(v)
    return `${ymd(d)} ${hms(d)}${frac ? '.' + frac : ''}${type === 'timestamp_ltz' ? ' UTC' : ''}`
  }
  if (type === 'timestamp_tz') {
    // "seconds.fraction offset", offset in minutes + 1440.
    const [secs, off] = String(v).split(' ')
    const minutes = Number(off) - 1440
    const { d, frac } = fromSeconds(secs)
    const local = new Date(d.getTime() + minutes * 60000)
    const sign = minutes < 0 ? '-' : '+'
    return `${ymd(local)} ${hms(local)}${frac ? '.' + frac : ''} ${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
  }
  return v
}

const literal = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`)

class SnowflakeDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'snowflake'
    this.timeoutMs = 0
  }

  quote(id) {
    return `"${String(id).replace(/"/g, '""')}"`
  }

  placeholder() {
    return '?'
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  get base() {
    const a = String(this.config.account || '').trim()
    if (/^https?:\/\//.test(a)) return a.replace(/\/+$/, '')
    return `https://${a.replace(/\.snowflakecomputing\.com$/i, '')}.snowflakecomputing.com`
  }

  headers() {
    return {
      Authorization: `Bearer ${this.config.password}`,
      'X-Snowflake-Authorization-Token-Type': this.config.tokenType === 'OAUTH' ? 'OAUTH' : 'PROGRAMMATIC_ACCESS_TOKEN',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Graphite',
    }
  }

  async call(url, init = {}) {
    const res = await fetch(url, { ...init, headers: this.headers(), signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined })
    const body = await res.json().catch(() => ({}))
    if (res.status >= 400) throw Object.assign(new Error(body.message || `Snowflake ${res.status}`), { code: body.code, sqlState: body.sqlState })
    return { status: res.status, body }
  }

  // Runs one statement; follows async execution (202) and result partitions.
  async run(sql, params = [], { onPage } = {}) {
    const c = this.config
    const bindings = Object.fromEntries(params.map((v, i) => [String(i + 1), v === null || v === undefined
      ? { type: 'TEXT', value: null }
      : { type: typeof v === 'number' ? (Number.isInteger(v) ? 'FIXED' : 'REAL') : typeof v === 'boolean' ? 'BOOLEAN' : 'TEXT', value: String(v) }]))
    let { status, body } = await this.call(`${this.base}/api/v2/statements?requestId=${crypto.randomUUID()}`, {
      method: 'POST',
      body: JSON.stringify({
        statement: sql,
        timeout: 3600,
        database: this.database_ || undefined,
        schema: this.schema_ || undefined,
        warehouse: c.warehouse || undefined,
        role: c.role || undefined,
        ...(params.length && { bindings }),
      }),
    })
    while (status === 202) {
      await new Promise((r) => setTimeout(r, 500))
      ;({ status, body } = await this.call(this.base + body.statementStatusUrl))
    }
    const meta = body.resultSetMetaData || { rowType: [], partitionInfo: [] }
    const cols = meta.rowType || []
    const pages = [body.data || []]
    const more = (meta.partitionInfo || []).length
    let stop = false
    const emit = async (rows) => {
      if (onPage && (await onPage(cols, rows.map((r) => r.map((v, i) => convert(v, cols[i]))))) === false) stop = true
    }
    await emit(pages[0])
    for (let p = 1; p < more && !stop; p++) {
      const part = await this.call(`${this.base}/api/v2/statements/${body.statementHandle}?partition=${p}`)
      await emit(part.body.data || [])
    }
    return { cols, stats: body.stats }
  }

  async connect() {
    const c = this.config
    if (!c.account) throw new Error(t('Informe o identificador da conta Snowflake'))
    if (!c.password) throw new Error(t('Informe o token de acesso (PAT) do Snowflake'))
    const [db, schema] = String(c.database || '').split('.')
    this.database_ = db || undefined
    this.schema_ = schema || undefined
    await this.run('select 1')
  }

  async disconnect() {}

  async execute(text, params = [], opts = {}) {
    const rows = []
    const sql = text.trim().replace(/[\s;]+$/, '')
    const r = await this.run(sql, params, { onPage: (cols, data) => { rows.push(...data) } })
    const fields = r.cols.map((c) => c.name)
    const cmd = commandOf(sql)
    const dml = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(cmd)
    if (dml || !fields.length) {
      const s = r.stats || {}
      const n = (s.numRowsInserted || 0) + (s.numRowsUpdated || 0) + (s.numRowsDeleted || 0)
      return { affected: n || (dml ? Number(rows[0]?.[0] ?? 0) : 0) }
    }
    if (opts.raw) return { fields, rows }
    const out = normaliseRows(rows, fields)
    return opts.origins ? { fields, rows: out, origins: fields.map(() => null), binary: [] } : { fields, rows: out }
  }

  async query(sql, params = []) {
    const r = await this.execute(sql, params, { raw: true })
    return (r.rows || []).map((row) => Object.fromEntries(r.fields.map((f, i) => [f, row[i]])))
  }

  async *stream(sql, { batch = 1000, raw } = {}) {
    // Partitions are already bounded by the server; regroup them into batches.
    const all = []
    let fields = []
    await this.run(sql.trim().replace(/[\s;]+$/, ''), [], { onPage: (cols, data) => { fields = cols.map((c) => c.name); all.push(...data) } })
    for (let i = 0; i < all.length || i === 0; i += batch) {
      const rows = all.slice(i, i + batch)
      yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
      if (!all.length) break
    }
  }

  async firstRows(sql, limit) {
    const rows = []
    let fields = []
    await this.run(sql.trim().replace(/[\s;]+$/, ''), [], {
      onPage: (cols, data) => {
        fields = cols.map((c) => c.name)
        rows.push(...data)
        return rows.length <= limit
      },
    })
    return { fields, rows: normaliseRows(rows.slice(0, limit + 1), fields) }
  }

  async transaction(fn) {
    return fn()
  }

  // Approved AI reads (aiReadOnly is false) still get a time limit.
  async readOnly(fn, timeoutMs) {
    this.timeoutMs = timeoutMs
    try {
      return await fn()
    } finally {
      this.timeoutMs = 0
    }
  }

  async version() {
    return 'Snowflake ' + (await this.query('select current_version() as v'))[0].V
  }

  async database() {
    return this.database_ || (await this.query('select current_database() as d'))[0].D
  }

  async listSchemas() {
    const db = await this.database()
    const rows = await this.query(`select schema_name as n from ${this.quote(db)}.information_schema.schemata order by 1`)
    return rows.map((r) => ({ name: r.N, system: r.N === 'INFORMATION_SCHEMA' }))
  }

  async currentSchema() {
    return this.schema_ || (await this.query('select current_schema() as s'))[0].S
  }

  async useSchema(name) {
    this.schema_ = name
  }

  async listTables(schema) {
    const db = await this.database()
    const s = schema ?? (await this.currentSchema())
    const rows = await this.query(
      `select table_name as n, table_type as k from ${this.quote(db)}.information_schema.tables where table_schema = ? order by 2, 1`,
      [s],
    )
    return rows.map((r) => ({ name: r.N, schema: s, type: /VIEW/.test(r.K) ? 'view' : 'table' }))
  }

  async listColumns(table, schema) {
    const db = await this.database()
    const s = schema ?? (await this.currentSchema())
    const cols = await this.query(
      `select column_name as n, data_type as t, is_nullable as nl, column_default as d, is_identity as ident
       from ${this.quote(db)}.information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
      [s, table],
    )
    const pk = new Set((await this.query(`show primary keys in table ${this.quote(db)}.${this.qualified(table, s)}`).catch(() => [])).map((k) => k.column_name))
    const fks = await this.query(`show imported keys in table ${this.quote(db)}.${this.qualified(table, s)}`).catch(() => [])
    return cols.map((c) => {
      const fk = fks.find((k) => k.fk_column_name === c.N)
      return {
        name: c.N, type: c.T, nullable: c.NL === 'YES', default: c.D ?? null, primary: pk.has(c.N),
        auto: c.IDENT === 'YES' || /\.nextval$/i.test(c.D || ''),
        references: fk ? `${fk.pk_table_name}(${fk.pk_column_name})` : null,
        refSchema: fk ? fk.pk_schema_name : null,
      }
    })
  }

  async schemaMap() {
    const db = await this.database()
    const s = await this.currentSchema()
    const rows = await this.query(`select table_name as t, column_name as c from ${this.quote(db)}.information_schema.columns where table_schema = ? order by table_name, ordinal_position`, [s])
    const map = {}
    for (const r of rows) (map[r.T] ||= []).push(r.C)
    return map
  }

  async listIndexes() {
    return []
  }

  async createScript(table, schema) {
    const db = await this.database()
    const s = schema ?? (await this.currentSchema())
    const r = await this.query(`select get_ddl('table', ?) as ddl`, [`${this.quote(db)}.${this.qualified(table, s)}`])
    return String(r[0].DDL).trim()
  }

  async erModel(schema) {
    const s = schema ?? (await this.currentSchema())
    const cols = []
    const fks = []
    for (const tb of await this.listTables(s)) {
      const list = await this.listColumns(tb.name, s)
      for (const c of list) cols.push({ table: tb.name, kind: tb.type, ...c })
      for (const c of list.filter((x) => x.references)) {
        const [, refTable, refCol] = /^(.*)\((.*)\)$/.exec(c.references)
        fks.push({ name: `fk_${tb.name}_${c.name}`, table: tb.name, columns: [c.name], refSchema: c.refSchema, refTable, refColumns: [refCol] })
      }
    }
    return erFrom(s, cols, fks)
  }
}

SnowflakeDriver.literal = literal
module.exports = SnowflakeDriver
