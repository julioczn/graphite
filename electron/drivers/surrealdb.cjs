// SurrealDB 2.x over its HTTP /sql endpoint (no SDK).
//
// - Namespace and database go in the Surreal-NS / Surreal-DB headers; the
//   picker switches databases inside the namespace.
// - Tables come from INFO FOR DB; columns from the table's defined fields plus
//   a sample of records (schemaless tables).
// - Integers beyond 2^53 keep every digit (JSON source text access).
// - No interactive transactions over HTTP: read-only grid; every AI query
//   needs approval.
const { normaliseRows } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

// JSON.parse that keeps integers wider than a double as text.
const parse = (text) => JSON.parse(text, (key, value, ctx) =>
  typeof value === 'number' && !Number.isSafeInteger(value) && ctx?.source && /^-?\d+$/.test(ctx.source) ? ctx.source : value)

const plain = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

class SurrealDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'surql'
  }

  quote(id) {
    return /^[A-Za-z_][\w]*$/.test(id) ? id : '`' + String(id).replace(/`/g, '\\`') + '`'
  }

  placeholder(i) {
    return `$p${i}`
  }

  qualified(table) {
    return this.quote(table)
  }

  get base() {
    return (this.config.url || 'http://localhost:8000').trim().replace(/\/+$/, '').replace(/^ws(s?):/, 'http$1:')
  }

  // One request with any number of statements → their results (throws on the first ERR).
  async sql(text, vars = {}) {
    const qs = new URLSearchParams(Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString()
    const headers = { Accept: 'application/json', 'Content-Type': 'text/plain', 'Surreal-NS': this.ns, 'Surreal-DB': this.db, NS: this.ns, DB: this.db }
    if (this.config.user) headers.Authorization = 'Basic ' + Buffer.from(`${this.config.user}:${this.config.password || ''}`).toString('base64')
    const res = await fetch(`${this.base}/sql${qs ? '?' + qs : ''}`, { method: 'POST', headers, body: text })
    const raw = await res.text()
    const body = raw ? parse(raw) : null
    if (!res.ok) throw new Error(body?.information || body?.description || `SurrealDB ${res.status}`)
    const failed = body.find((r) => r.status === 'ERR')
    if (failed) throw new Error(String(failed.result))
    return body.map((r) => r.result)
  }

  async connect() {
    this.ns = (this.config.namespace || '').trim()
    this.db = (this.config.database || '').trim()
    if (!this.ns || !this.db) throw new Error(t('Informe o namespace e o banco do SurrealDB'))
    await this.sql('RETURN 1')
  }

  async disconnect() {}

  async version() {
    const v = await fetch(`${this.base}/version`).then((r) => r.text()).catch(() => '')
    return 'SurrealDB ' + (v.replace(/^surrealdb-/, '') || '')
  }

  async database() {
    return this.db
  }

  async listSchemas() {
    const [info] = await this.sql('INFO FOR NS')
    return Object.keys(info?.databases || {}).sort().map((name) => ({ name, system: false }))
  }

  async currentSchema() {
    return this.db
  }

  async useSchema(name) {
    this.db = name
  }

  async listTables() {
    const [info] = await this.sql('INFO FOR DB')
    return Object.keys(info?.tables || {}).sort().map((name) => ({ name, schema: null, type: /\bAS\s+SELECT\b/i.test(info.tables[name]) ? 'view' : 'table' }))
  }

  // Records → grid: id first, then fields in first-seen order.
  grid(records, fixed = null) {
    const list = Array.isArray(records) ? records : records === null || records === undefined ? [] : [records]
    if (list.length && list.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
      return { fields: ['value'], rows: list.map((v) => [plain(v)]) }
    }
    const fields = fixed ? [...fixed] : []
    if (!fixed) {
      const seen = new Set()
      for (const r of list) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); fields.push(k) }
      if (fields.indexOf('id') > 0) fields.unshift(...fields.splice(fields.indexOf('id'), 1))
    }
    return { fields, rows: list.map((r) => fields.map((f) => plain(r[f]))) }
  }

  async listColumns(table) {
    const [info, sample] = await this.sql(`INFO FOR TABLE ${this.quote(table)}; SELECT * FROM ${this.quote(table)} LIMIT 50`)
    const defined = info?.fields || {}
    const cols = new Map([['id', 'record']])
    for (const [name, def] of Object.entries(defined)) cols.set(name, /\bTYPE\s+(.+?)(\s+(DEFAULT|VALUE|ASSERT|READONLY|PERMISSIONS|COMMENT)\b|$)/i.exec(def)?.[1] || 'any')
    for (const r of sample || []) for (const [k, v] of Object.entries(r)) if (!cols.has(k)) cols.set(k, Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
    return [...cols].map(([name, type]) => ({ name, type, nullable: name !== 'id', default: null, primary: name === 'id', auto: name === 'id', references: null }))
  }

  async schemaMap() {
    const map = {}
    for (const tb of (await this.listTables()).slice(0, 50)) map[tb.name] = (await this.listColumns(tb.name).catch(() => [])).map((c) => c.name)
    return map
  }

  async listIndexes(table) {
    const [info] = await this.sql(`INFO FOR TABLE ${this.quote(table)}`)
    return [
      { name: 'id', unique: true, primary: true, columns: ['id'] },
      ...Object.entries(info?.indexes || {}).map(([name, def]) => ({ name, unique: /\bUNIQUE\b/i.test(def), primary: false, columns: [(/\bFIELDS\s+(.+?)(\s+(UNIQUE|SEARCH|MTREE|HNSW)\b|$)/i.exec(def)?.[1] || '').trim()] })),
    ]
  }

  async createScript(table) {
    const [db, info] = await this.sql(`INFO FOR DB; INFO FOR TABLE ${this.quote(table)}`)
    const lines = [db?.tables?.[table] || `DEFINE TABLE ${this.quote(table)}`]
    for (const kind of ['fields', 'indexes', 'events']) for (const def of Object.values(info?.[kind] || {})) lines.push(def)
    return lines.map((l) => l.replace(/;?$/, ';')).join('\n')
  }

  async page({ table, limit, offset, where, orderBy, dir }) {
    const tb = this.quote(table)
    const cond = where ? ` WHERE ${where}` : ''
    const order = orderBy ? ` ORDER BY ${this.quote(orderBy)} ${dir === 'desc' ? 'DESC' : 'ASC'}` : ''
    const [rows, count] = await this.sql(`SELECT * FROM ${tb}${cond}${order} LIMIT ${limit} START ${offset}; SELECT count() FROM ${tb}${cond} GROUP ALL`)
    const g = this.grid(rows)
    return { fields: g.fields, rows: normaliseRows(g.rows, g.fields), total: count?.[0]?.count ?? 0 }
  }

  async *streamTable(table, schema, where) {
    const tb = this.quote(table)
    const cond = where ? ` WHERE ${where}` : ''
    // Columns of every batch: the field names found across the matching records.
    const [keys] = await this.sql(`array::distinct(array::flatten((SELECT VALUE object::keys($this) FROM ${tb}${cond})))`)
    const fields = ['id', ...(keys || []).filter((k) => k !== 'id').sort()]
    for (let start = 0; ; start += 1000) {
      const [rows] = await this.sql(`SELECT * FROM ${tb}${cond} LIMIT 1000 START ${start}`)
      yield { fields, rows: this.grid(rows, fields).rows }
      if ((rows || []).length < 1000) break
    }
  }

  async execute(text, params = []) {
    const vars = Object.fromEntries(params.map((v, i) => [`p${i + 1}`, v]))
    const results = await this.sql(text.trim().replace(/[\s;]+$/, ''), vars)
    const last = results.at(-1)
    if (last === null || last === undefined) return { affected: 0 }
    const g = this.grid(last)
    return { fields: g.fields, rows: normaliseRows(g.rows, g.fields) }
  }

  async *stream(text) {
    yield await this.execute(text)
  }

  async firstRows(text, limit) {
    const r = await this.execute(text)
    return r.rows ? { ...r, rows: r.rows.slice(0, limit + 1) } : r
  }

  async transaction(fn) {
    return fn()
  }

  async readOnly(fn) {
    return fn()
  }
}

module.exports = SurrealDriver
