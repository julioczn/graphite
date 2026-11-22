// ClickHouse over HTTP (@clickhouse/client, pure JS).
//
// - A server-side session (session_id) keeps USE and SET between statements.
// - Statements that return rows go through query() in a compact JSON format
//   (64-bit integers and decimals quoted, so nothing loses digits); the rest
//   through command(), whose summary reports the written rows.
// - No interactive transactions: no manual mode and no grid editing
//   (UPDATE/DELETE are asynchronous mutations in ClickHouse).
// - AI reads run with readonly=1, which the server enforces per query, plus
//   max_execution_time.
const { randomUUID } = require('node:crypto')
const { normaliseRows, erFrom, commandOf } = require('../lib/sql.cjs')

const ROW_COMMANDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'EXISTS', 'VALUES'])
const SYSTEM_DBS = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])
const FORMAT = 'JSONCompactEachRowWithNamesAndTypes'

let clientModule = null
const loadClient = () => (clientModule ||= require('@clickhouse/client'))
const { tlsOptions, modeOf } = require('../lib/tls.cjs')

// ClickHouse string literal: backslash escapes.
function literal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

class ClickhouseDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'clickhouse'
    this.settings = {} // extra per-query settings while an AI read runs
  }

  quote(id) {
    return '`' + String(id).replace(/`/g, '``') + '`'
  }

  // Parameters are inlined as literals: ClickHouse's typed {name:Type}
  // parameters would need each column's type.
  placeholder(i) {
    return `{{p${i}}}`
  }

  bind(sql, params) {
    return params.length ? sql.replace(/\{\{p(\d+)\}\}/g, (m, i) => literal(params[Number(i) - 1])) : sql
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  async connect() {
    const c = this.config
    const { createClient, ClickHouseLogLevel } = loadClient()
    const host = c.host || 'localhost'
    const url = /^https?:\/\//.test(host) ? host : `${c.ssl ? 'https' : 'http'}://${host}:${Number(c.port) || 8123}`
    this.client = createClient({
      url,
      username: c.user || 'default',
      password: c.password || '',
      database: c.database || 'default',
      session_id: randomUUID(),
      request_timeout: 300000,
      // HTTPS with our TLS settings (CA, client certificate, verification mode).
      ...(url.startsWith('https:') && { http_agent: new (require('node:https').Agent)({ keepAlive: true, ...(tlsOptions({ ...c, ssl: true }) || {}) }) }),
      // Errors reach the user through the rejected promise; no console noise.
      log: { level: ClickHouseLogLevel.OFF },
      clickhouse_settings: {
        output_format_json_quote_decimals: 1,
        output_format_json_quote_64bit_integers: 1,
        // Keeps long queries alive through proxies that drop idle connections.
        send_progress_in_http_headers: 1,
        http_headers_progress_interval_ms: '10000',
      },
    })
    await this.client.command({ query: 'select 1' })
  }

  async disconnect() {
    await this.client?.close().catch(() => {})
    this.client = null
  }

  clean(sql) {
    return sql.trim().replace(/[\s;]+$/, '')
  }

  async rowsOf(sql, extra = {}) {
    const rs = await this.client.query({ query: sql, format: FORMAT, clickhouse_settings: { ...this.settings, ...extra } })
    const all = await rs.json()
    const [names = [], , ...rows] = all
    return { fields: names, rows }
  }

  async execute(text, params = [], opts = {}) {
    const sql = this.clean(this.bind(text, params))
    if (ROW_COMMANDS.has(commandOf(sql))) {
      const r = await this.rowsOf(sql)
      if (opts.raw) return r
      const rows = normaliseRows(r.rows, r.fields)
      return opts.origins ? { fields: r.fields, rows, origins: r.fields.map(() => null), binary: [] } : { fields: r.fields, rows }
    }
    const res = await this.client.command({ query: sql, clickhouse_settings: this.settings })
    return { affected: Number(res.summary?.written_rows ?? 0) }
  }

  async query(sql) {
    const r = await this.rowsOf(this.clean(sql))
    return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f, row[i]])))
  }

  async *stream(sql, { batch = 1000, raw } = {}) {
    const rs = await this.client.query({ query: this.clean(sql), format: FORMAT, clickhouse_settings: this.settings })
    let fields = null
    let skipTypes = true
    let rows = []
    for await (const chunk of rs.stream()) {
      for (const row of chunk) {
        const v = row.json()
        if (!fields) { fields = v; continue }
        if (skipTypes) { skipTypes = false; continue }
        rows.push(v)
        if (rows.length >= batch) {
          yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
          rows = []
        }
      }
    }
    fields ||= []
    yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
  }

  firstRows(sql, limit) {
    return this.rowsOf(this.clean(sql), { max_result_rows: String(limit), result_overflow_mode: 'break' })
      .then((r) => ({ fields: r.fields, rows: normaliseRows(r.rows.slice(0, limit), r.fields) }))
  }

  async transaction(fn) {
    return fn()
  }

  // AI reads: readonly=1 (enforced by the server) and a time limit.
  async readOnly(fn, timeoutMs) {
    this.settings = { readonly: '1', max_execution_time: String(Math.ceil(timeoutMs / 1000)) }
    try {
      return await fn()
    } finally {
      this.settings = {}
    }
  }

  async version() {
    return 'ClickHouse ' + (await this.query('select version() as v'))[0].v
  }

  async database() {
    return (await this.query('select currentDatabase() as d'))[0].d
  }

  async listSchemas() {
    const rows = await this.query('select name from system.databases order by name')
    return rows.map((r) => ({ name: r.name, system: SYSTEM_DBS.has(r.name) }))
  }

  async currentSchema() {
    return this.database()
  }

  async useSchema(name) {
    await this.client.command({ query: `use ${this.quote(name)}` })
  }

  async listTables(schema) {
    const db = schema ?? (await this.database())
    const rows = await this.query(
      `select name, engine like '%View' as is_view from system.tables
       where database = ${literal(db)} and not is_temporary and name not like '.inner%'
       order by is_view, name`,
    )
    return rows.map((r) => ({ name: r.name, schema: db, type: Number(r.is_view) ? 'view' : 'table' }))
  }

  async listColumns(table, schema) {
    const db = schema ?? (await this.database())
    const rows = await this.query(
      `select name, type, default_kind, default_expression, is_in_primary_key
       from system.columns where database = ${literal(db)} and table = ${literal(table)} order by position`,
    )
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: /^Nullable\(/.test(r.type),
      default: r.default_expression || null,
      primary: Number(r.is_in_primary_key) === 1,
      auto: r.default_kind === 'MATERIALIZED' || r.default_kind === 'ALIAS',
      references: null,
    }))
  }

  async schemaMap() {
    const db = await this.database()
    const rows = await this.query(`select table, name from system.columns where database = ${literal(db)} order by table, position`)
    const map = {}
    for (const r of rows) (map[r.table] ||= []).push(r.name)
    return map
  }

  async listIndexes(table, schema) {
    const db = schema ?? (await this.database())
    const t = (await this.query(`select primary_key, sorting_key from system.tables where database = ${literal(db)} and name = ${literal(table)}`))[0]
    const out = []
    if (t?.primary_key) out.push({ name: 'PRIMARY KEY', unique: false, primary: true, columns: t.primary_key.split(',').map((s) => s.trim()) })
    if (t?.sorting_key && t.sorting_key !== t.primary_key) out.push({ name: 'ORDER BY', unique: false, primary: false, columns: t.sorting_key.split(',').map((s) => s.trim()) })
    const skip = await this.query(
      `select name, expr from system.data_skipping_indices where database = ${literal(db)} and table = ${literal(table)}`,
    ).catch(() => [])
    for (const ix of skip) out.push({ name: ix.name, unique: false, primary: false, columns: [ix.expr] })
    return out
  }

  async createScript(table, schema) {
    const r = await this.query(`show create table ${this.qualified(table, schema)}`)
    return String(Object.values(r[0])[0]).trim() + ';'
  }

  async erModel(schema) {
    const db = schema ?? (await this.database())
    const rows = await this.query(
      `select c.table as table, t.engine like '%View' as is_view, c.name as name, c.type as type, c.is_in_primary_key as pk
       from system.columns c join system.tables t on t.database = c.database and t.name = c.table
       where c.database = ${literal(db)} order by c.table, c.position`,
    )
    // ClickHouse has no foreign keys; the ER view can still infer *_id relations.
    return erFrom(db, rows.map((r) => ({
      table: r.table, kind: Number(r.is_view) ? 'view' : 'table', name: r.name, type: r.type,
      nullable: /^Nullable\(/.test(r.type), primary: Number(r.pk) === 1,
    })), [])
  }
}

module.exports = ClickhouseDriver
