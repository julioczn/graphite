// Trino (and Starburst) over its REST protocol, with a small fetch client:
// POST /v1/statement, then follow nextUri until the query finishes.
//
// - Session state travels in headers: catalog/schema (changed by USE or the
//   picker), session properties, and the transaction id.
// - The picker lists "catalog.schema" pairs.
// - Most connectors have no transactions: no manual mode, no grid editing.
// - AI reads run in START TRANSACTION READ ONLY, which Trino enforces
//   ("Cannot execute write in a read-only transaction").
// - With a password, the server requires HTTPS (Basic auth).
const { normaliseRows, erFrom } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')
const { tlsOptions } = require('../lib/tls.cjs')
const { request } = require('../lib/http.cjs')

const literal = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/'/g, "''")}'`)

class TrinoDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'trino'
    this.txId = null
    this.properties = {} // SET SESSION values
    this.timeoutMs = 0
  }

  quote(id) {
    return `"${String(id).replace(/"/g, '""')}"`
  }

  // Values are inlined as literals (prepared statements need a server round trip).
  placeholder(i) {
    return `{{p${i}}}`
  }

  qualified(table, schema) {
    return schema ? `${schema.split('.').map((p) => this.quote(p)).join('.')}.${this.quote(table)}` : this.quote(table)
  }

  get base() {
    const c = this.config
    const host = c.host || 'localhost'
    return /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `${c.ssl || c.password ? 'https' : 'http'}://${host}:${Number(c.port) || 8080}`
  }

  headers() {
    const c = this.config
    const h = { 'X-Trino-User': c.user || 'graphite', 'X-Trino-Source': 'Graphite', 'Content-Type': 'text/plain' }
    if (this.catalog) h['X-Trino-Catalog'] = this.catalog
    if (this.schema) h['X-Trino-Schema'] = this.schema
    if (this.txId) h['X-Trino-Transaction-Id'] = this.txId
    const props = Object.entries(this.properties)
    if (props.length) h['X-Trino-Session'] = props.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(',')
    if (c.password) h.Authorization = 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64')
    return h
  }

  // Applies the session changes the server asks for (USE, SET SESSION, transactions).
  track(res) {
    const g = (k) => res.headers.get(k)
    if (g('x-trino-set-catalog')) this.catalog = g('x-trino-set-catalog')
    if (g('x-trino-set-schema')) this.schema = g('x-trino-set-schema')
    if (g('x-trino-started-transaction-id')) this.txId = g('x-trino-started-transaction-id')
    if (g('x-trino-clear-transaction-id')) this.txId = null
    for (const kv of res.headers.get('x-trino-set-session')?.split(',') || []) {
      const [k, v] = kv.split('=')
      if (k) this.properties[k.trim()] = decodeURIComponent(v || '')
    }
    for (const k of res.headers.get('x-trino-clear-session')?.split(',') || []) delete this.properties[k.trim()]
  }

  // Runs a statement; onPage(columns, rows) gets each page and may return
  // false to stop early (the query is then cancelled).
  async run(sql, onPage, extraHeaders = {}) {
    const signal = this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined
    const fetch = this.fetch
    let res = await fetch(this.base + '/v1/statement', { method: 'POST', body: sql, headers: { ...this.headers(), ...extraHeaders }, signal })
    if (!res.ok && res.status !== 200) throw new Error(`Trino ${res.status}: ${(await res.text()).slice(0, 300)}`)
    this.track(res)
    let body = await res.json()
    let columns = body.columns || null
    for (;;) {
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.errorName })
      columns ||= body.columns || null
      if (body.data?.length && onPage && (await onPage(columns, body.data)) === false) {
        if (body.nextUri) await fetch(body.nextUri, { method: 'DELETE', headers: this.headers() }).catch(() => {})
        break
      }
      if (!body.nextUri) break
      res = await fetch(body.nextUri, { headers: this.headers(), signal })
      this.track(res)
      body = await res.json()
    }
    return { columns: columns || [], updateType: body.updateType, updateCount: body.updateCount }
  }

  // HTTPS with our TLS settings; plain fetch otherwise.
  get fetch() {
    const tls = this.base.startsWith('https:') ? tlsOptions({ ...this.config, ssl: true }) : null
    return tls ? (url, init = {}) => request(url, { ...init, tls }) : globalThis.fetch
  }

  async connect() {
    const db = (this.config.database || '').split('.')
    this.catalog = db[0] || undefined
    this.schema = db[1] || undefined
    await this.run('select 1')
  }

  async disconnect() {
    if (this.txId) await this.run('rollback').catch(() => {})
  }

  bind(sql, params) {
    return params.length ? sql.replace(/\{\{p(\d+)\}\}/g, (m, i) => literal(params[Number(i) - 1])) : sql
  }

  async execute(text, params = [], opts = {}) {
    const rows = []
    const r = await this.run(this.bind(text, params).trim().replace(/[\s;]+$/, ''), (cols, data) => { rows.push(...data) })
    if (r.columns.length) {
      const fields = r.columns.map((c) => c.name)
      if (opts.raw) return { fields, rows }
      const out = normaliseRows(rows, fields)
      return opts.origins ? { fields, rows: out, origins: fields.map(() => null), binary: [] } : { fields, rows: out }
    }
    return { affected: Number(r.updateCount ?? 0) }
  }

  async query(sql) {
    const r = await this.execute(sql, [], { raw: true })
    return (r.rows || []).map((row) => Object.fromEntries(r.fields.map((f, i) => [f, row[i]])))
  }

  // Pages as they arrive, regrouped into batches. The fetch loop waits while
  // the consumer is behind, so a huge export doesn't pile up in memory.
  async *stream(sql, { batch = 1000, raw } = {}) {
    const queue = []
    let fields = null
    let done = false
    let error = null
    let wake = null
    let resume = null
    const signal = () => { wake?.(); wake = null }
    let stopped = false // the consumer left early: cancel the query on the server
    const running = this.run(sql.trim().replace(/[\s;]+$/, ''), async (cols, data) => {
      if (stopped) return false
      fields ||= cols.map((c) => c.name)
      queue.push(...data)
      signal()
      if (queue.length >= batch * 4) await new Promise((r) => (resume = r))
      return !stopped
    }).then((r) => { fields ||= r.columns.map((c) => c.name); done = true; signal() }, (e) => { error = e; done = true; signal() })
    try {
      for (let first = true; ; first = false) {
        while (queue.length < batch && !done) await new Promise((r) => (wake = r))
        if (error) throw error
        const rows = queue.splice(0, batch)
        resume?.(); resume = null
        if (rows.length || first) yield { fields: fields || [], rows: raw ? rows : normaliseRows(rows, fields || []) }
        if (done && !queue.length) break
      }
    } finally {
      stopped = true
      resume?.()
      await running
    }
  }

  async firstRows(sql, limit) {
    const rows = []
    let fields = []
    const r = await this.run(sql.trim().replace(/[\s;]+$/, ''), (cols, data) => {
      fields = cols.map((c) => c.name)
      rows.push(...data)
      return rows.length <= limit
    })
    if (!fields.length) fields = r.columns.map((c) => c.name)
    return { fields, rows: normaliseRows(rows.slice(0, limit + 1), fields) }
  }

  pageSql({ cols = '*', from, filter, order, limit, offset }) {
    // Trino puts OFFSET before LIMIT.
    return `select ${cols} from ${from}${filter}${order} offset ${offset} limit ${limit}`
  }

  async transaction(fn) {
    return fn()
  }

  // AI reads: a read-only transaction Trino enforces, with a time limit.
  async readOnly(fn, timeoutMs) {
    await this.run('start transaction read only', null, { 'X-Trino-Transaction-Id': 'NONE' })
    this.timeoutMs = timeoutMs
    try {
      return await fn()
    } finally {
      this.timeoutMs = 0
      await this.run('rollback').catch(() => {})
      this.txId = null
    }
  }

  async version() {
    return 'Trino ' + (await this.query('select node_version as v from system.runtime.nodes limit 1'))[0].v
  }

  async database() {
    return this.catalog || ''
  }

  // --- catalog: the picker shows "catalog.schema" -------------------------------

  async listSchemas() {
    const out = []
    for (const { Catalog } of await this.query('show catalogs')) {
      const schemas = await this.query(`show schemas from ${this.quote(Catalog)}`).catch(() => [])
      for (const s of schemas) out.push({ name: `${Catalog}.${s.Schema}`, system: Catalog === 'system' || s.Schema === 'information_schema' })
    }
    return out
  }

  async currentSchema() {
    return this.catalog && this.schema ? `${this.catalog}.${this.schema}` : null
  }

  async useSchema(name) {
    const [catalog, schema] = String(name).split('.')
    if (!catalog || !schema) throw new Error(t('Escolha um schema no formato catálogo.schema'))
    this.catalog = catalog
    this.schema = schema
  }

  split(schema) {
    const full = schema || (this.catalog && this.schema ? `${this.catalog}.${this.schema}` : null)
    if (!full) throw new Error(t('Escolha um schema no formato catálogo.schema'))
    const [catalog, sch] = full.split('.')
    return { full, catalog, schema: sch }
  }

  async listTables(schema) {
    const s = this.split(schema)
    const rows = await this.query(
      `select table_name, table_type from ${this.quote(s.catalog)}.information_schema.tables
       where table_schema = ${literal(s.schema)} order by table_type, table_name`,
    )
    return rows.map((r) => ({ name: r.table_name, schema: s.full, type: r.table_type === 'VIEW' ? 'view' : 'table' }))
  }

  async listColumns(table, schema) {
    const s = this.split(schema)
    const rows = await this.query(
      `select column_name, data_type, is_nullable, column_default from ${this.quote(s.catalog)}.information_schema.columns
       where table_schema = ${literal(s.schema)} and table_name = ${literal(table)} order by ordinal_position`,
    )
    return rows.map((r) => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', default: r.column_default ?? null, primary: false, auto: false, references: null }))
  }

  async schemaMap() {
    if (!this.catalog || !this.schema) return {}
    const rows = await this.query(
      `select table_name, column_name from ${this.quote(this.catalog)}.information_schema.columns
       where table_schema = ${literal(this.schema)} order by table_name, ordinal_position`,
    )
    const map = {}
    for (const r of rows) (map[r.table_name] ||= []).push(r.column_name)
    return map
  }

  async listIndexes() {
    return []
  }

  async createScript(table, schema) {
    const name = this.qualified(table, this.split(schema).full)
    const r = await this.query(`show create table ${name}`).catch(() => this.query(`show create view ${name}`))
    return String(Object.values(r[0])[0]).trim() + ';'
  }

  async erModel(schema) {
    const s = this.split(schema)
    const rows = await this.query(
      `select c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable
       from ${this.quote(s.catalog)}.information_schema.columns c
       join ${this.quote(s.catalog)}.information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = ${literal(s.schema)} order by c.table_name, c.ordinal_position`,
    )
    return erFrom(s.full, rows.map((r) => ({ table: r.table_name, kind: r.table_type === 'VIEW' ? 'view' : 'table', name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', primary: false })), [])
  }
}

module.exports = TrinoDriver
