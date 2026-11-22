// Apache Cassandra and ScyllaDB through the DataStax driver (cassandra-driver).
//
// - The picker switches keyspaces (USE).
// - CQL has no OFFSET and counting a table means reading it, so the table tab
//   pages with the server's paging state and shows no total.
// - A filter on a column outside the primary key needs ALLOW FILTERING,
//   which the user types (it can be expensive on big tables).
// - Values: bigint/varint/decimal/uuid/inet/date/time/duration as text,
//   collections and UDTs as JSON.
// - Grid edits: one logged BATCH (all or nothing), after checking that every
//   row still exists; values go through fromJson() so the server converts the
//   grid's text to the column type. Key columns can't change (CQL rule).
// - No interactive transactions: every AI query needs approval.
const cassandra = require('cassandra-driver')
const { normaliseRows } = require('../lib/sql.cjs')
const { tlsOptions, modeOf } = require('../lib/tls.cjs')
const { t } = require('../../shared/i18n.mjs')

const { types } = cassandra
const SYSTEM_KS = /^system(_|$)|^dse_|^solr_admin$/
// Types whose grid text is the value itself; anything else (collections, tuples,
// UDTs) is shown as JSON and edited as JSON.
const SCALAR = /^(ascii|bigint|blob|boolean|counter|date|decimal|double|duration|float|inet|int|smallint|text|time|timestamp|timeuuid|tinyint|uuid|varchar|varint)$/

function cell(v) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(cell(k)), cell(x)]))
  if (v instanceof Set) return [...v].map(cell)
  if (Array.isArray(v)) return v.map(cell)
  if (v instanceof types.Long || v instanceof types.Integer || v instanceof types.BigDecimal || v instanceof types.Uuid ||
      v instanceof types.InetAddress || v instanceof types.LocalDate || v instanceof types.LocalTime || v instanceof types.Duration) return v.toString()
  if (v instanceof types.Tuple) return v.values().map(cell)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cell(x)]))
  return v
}

class CassandraDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'cql'
  }

  quote(id) {
    return /^[a-z_][a-z0-9_]*$/.test(id) ? id : `"${String(id).replace(/"/g, '""')}"`
  }

  placeholder() {
    return '?'
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  async connect() {
    const c = this.config
    const port = Number(c.port) || 9042
    this.client = new cassandra.Client({
      contactPoints: (c.host || 'localhost').split(',').map((h) => h.trim()),
      protocolOptions: { port },
      keyspace: c.database || undefined,
      // Round robin needs no local data center name; fine for a desktop client.
      policies: { loadBalancing: new cassandra.policies.loadBalancing.RoundRobinPolicy() },
      ...(c.user && { credentials: { username: c.user, password: c.password || '' } }),
      ...(c.ssl && { sslOptions: tlsOptions(c) }),
      socketOptions: { connectTimeout: 10000, readTimeout: 120000 },
    })
    await this.client.connect()
  }

  async disconnect() {
    await this.client?.shutdown().catch(() => {})
    this.client = null
  }

  grid(rs) {
    const fields = (rs.columns || []).map((c) => c.name)
    return { fields, rows: rs.rows.map((r) => fields.map((f) => cell(r[f]))) }
  }

  async version() {
    if (this.engine === 'scylladb') {
      const r = await this.client.execute("select version from system.versions where key = 'local'").catch(() => null)
      if (r?.rows[0]) return 'ScyllaDB ' + r.rows[0].version.split('-')[0]
    }
    const r = await this.client.execute('select release_version from system.local')
    return 'Cassandra ' + r.rows[0].release_version
  }

  async database() {
    return this.client.keyspace || ''
  }

  async listSchemas() {
    const r = await this.client.execute('select keyspace_name from system_schema.keyspaces')
    return r.rows.map((x) => ({ name: x.keyspace_name, system: SYSTEM_KS.test(x.keyspace_name) })).sort((a, b) => a.name.localeCompare(b.name))
  }

  async currentSchema() {
    return this.client.keyspace || null
  }

  async useSchema(name) {
    await this.client.execute(`use ${this.quote(name)}`)
  }

  async listTables(schema) {
    const ks = schema ?? this.client.keyspace
    if (!ks) return []
    const tables = await this.client.execute('select table_name from system_schema.tables where keyspace_name = ?', [ks], { prepare: true })
    const views = await this.client.execute('select view_name from system_schema.views where keyspace_name = ?', [ks], { prepare: true }).catch(() => ({ rows: [] }))
    return [
      ...tables.rows.map((r) => ({ name: r.table_name, schema: ks, type: 'table' })),
      ...views.rows.map((r) => ({ name: r.view_name, schema: ks, type: 'view' })),
    ].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  }

  async columnsRaw(table, ks) {
    const r = await this.client.execute(
      'select column_name, type, kind, position, clustering_order from system_schema.columns where keyspace_name = ? and table_name = ?',
      [ks, table], { prepare: true },
    )
    const rank = { partition_key: 0, clustering: 1, static: 2, regular: 3 }
    return r.rows.sort((a, b) => rank[a.kind] - rank[b.kind] || a.position - b.position || a.column_name.localeCompare(b.column_name))
  }

  async listColumns(table, schema) {
    const ks = schema ?? this.client.keyspace
    return (await this.columnsRaw(table, ks)).map((c) => ({
      name: c.column_name,
      type: c.type + (c.kind === 'partition_key' ? ' (partition key)' : c.kind === 'clustering' ? ' (clustering)' : c.kind === 'static' ? ' (static)' : ''),
      nullable: c.kind === 'regular' || c.kind === 'static',
      default: null,
      primary: c.kind === 'partition_key' || c.kind === 'clustering',
      auto: false,
      references: null,
    }))
  }

  async schemaMap() {
    const ks = this.client.keyspace
    if (!ks) return {}
    const r = await this.client.execute('select table_name, column_name from system_schema.columns where keyspace_name = ?', [ks], { prepare: true })
    const map = {}
    for (const row of r.rows) (map[row.table_name] ||= []).push(row.column_name)
    return map
  }

  async listIndexes(table, schema) {
    const ks = schema ?? this.client.keyspace
    const cols = await this.columnsRaw(table, ks)
    const pk = cols.filter((c) => c.kind === 'partition_key').map((c) => c.column_name)
    const ck = cols.filter((c) => c.kind === 'clustering').map((c) => c.column_name)
    const out = [{ name: 'PRIMARY KEY', unique: true, primary: true, columns: [...pk, ...ck] }]
    const ix = await this.client.execute('select index_name, options from system_schema.indexes where keyspace_name = ? and table_name = ?', [ks, table], { prepare: true }).catch(() => ({ rows: [] }))
    for (const r of ix.rows) out.push({ name: r.index_name, unique: false, primary: false, columns: [r.options?.target || ''] })
    return out
  }

  // CREATE TABLE rebuilt from system_schema (the driver has no DDL export here).
  async createScript(table, schema) {
    const ks = schema ?? this.client.keyspace
    const cols = await this.columnsRaw(table, ks)
    const pk = cols.filter((c) => c.kind === 'partition_key').map((c) => this.quote(c.column_name))
    const ck = cols.filter((c) => c.kind === 'clustering')
    const key = `PRIMARY KEY (${pk.length > 1 ? `(${pk.join(', ')})` : pk[0]}${ck.length ? ', ' + ck.map((c) => this.quote(c.column_name)).join(', ') : ''})`
    const lines = cols.map((c) => `  ${this.quote(c.column_name)} ${c.type}${c.kind === 'static' ? ' STATIC' : ''}`)
    const order = ck.filter((c) => c.clustering_order === 'desc').length
      ? `\nWITH CLUSTERING ORDER BY (${ck.map((c) => `${this.quote(c.column_name)} ${c.clustering_order.toUpperCase()}`).join(', ')})`
      : ''
    return `CREATE TABLE ${this.qualified(table, ks)} (\n${lines.join(',\n')},\n  ${key}\n)${order};`
  }

  async page({ table, schema, limit, offset, where }) {
    const q = `select * from ${this.qualified(table, schema ?? this.client.keyspace)}${where ? ` where ${where}` : ''}`
    const rows = []
    let fields = []
    let pageState
    let skipped = 0
    do {
      const rs = await this.client.execute(q, [], { fetchSize: Math.max(limit, 100), pageState })
      const g = this.grid(rs)
      fields = g.fields
      for (const r of g.rows) {
        if (skipped < offset) skipped++
        else if (rows.length < limit) rows.push(r)
      }
      pageState = rs.pageState
    } while (pageState && rows.length < limit)
    return { fields, rows: normaliseRows(rows, fields), total: null }
  }

  async *streamTable(table, schema, where) {
    yield* this.stream(`select * from ${this.qualified(table, schema ?? this.client.keyspace)}${where ? ` where ${where}` : ''}`)
  }

  async execute(text, params = [], opts = {}) {
    const sql = text.trim().replace(/[\s;]+$/, '')
    const rs = await this.client.execute(sql, params, { prepare: params.length > 0, fetchSize: 5000 })
    if (!rs.columns) return { affected: 0 }
    const g = this.grid(rs)
    if (opts.raw) return g
    return { fields: g.fields, rows: normaliseRows(g.rows, g.fields) }
  }

  // Rows with backpressure through the driver's auto-paging stream.
  async *stream(text, { batch = 1000, raw } = {}) {
    const st = this.client.stream(text.trim().replace(/[\s;]+$/, ''), [], { prepare: false, autoPage: true, fetchSize: batch })
    let fields = null
    let rows = []
    let first = true
    for await (const row of st) {
      fields ||= row.keys()
      rows.push(fields.map((f) => cell(row[f])))
      if (rows.length >= batch) {
        yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
        rows = []
        first = false
      }
    }
    if (rows.length || first) yield { fields: fields || [], rows: raw ? rows : normaliseRows(rows, fields || []) }
  }

  async firstRows(text, limit) {
    const rs = await this.client.execute(text.trim().replace(/[\s;]+$/, ''), [], { fetchSize: limit + 1 })
    if (!rs.columns) return { affected: 0 }
    const g = this.grid(rs)
    return { fields: g.fields, rows: normaliseRows(g.rows.slice(0, limit + 1), g.fields) }
  }

  // changes: [{ kind: 'update' | 'delete', table, schema, pk: {col: val}, column, value }]
  async applyChanges(changes) {
    const { table, schema } = changes[0]
    const ks = schema ?? this.client.keyspace
    const cols = new Map((await this.columnsRaw(table, ks)).map((c) => [c.column_name, c]))
    const keys = [...cols.values()].filter((c) => c.kind === 'partition_key' || c.kind === 'clustering').map((c) => c.column_name)
    const from = this.qualified(table, ks)
    const where = keys.map((k) => `${this.quote(k)} = fromJson(?)`).join(' and ')
    const keyParams = (pk) => keys.map((k) => JSON.stringify(pk[k] === null || pk[k] === undefined ? null : pk[k]))
    const label = (pk) => keys.map((k) => `${k} = ${pk[k]}`).join(', ')
    // UPDATE in CQL is an upsert: make sure no row came back from the dead.
    const seen = new Set()
    for (const ch of changes) {
      const id = JSON.stringify(keyParams(ch.pk))
      if (seen.has(id)) continue
      seen.add(id)
      const rs = await this.client.execute(`select ${this.quote(keys[0])} from ${from} where ${where}`, keyParams(ch.pk), { prepare: true })
      if (!rs.rows.length) throw new Error(t('A linha {key} não existe mais. Nada foi aplicado.', { key: label(ch.pk) }))
    }
    const queries = changes.map((ch) => {
      if (ch.kind === 'delete') return { query: `delete from ${from} where ${where}`, params: keyParams(ch.pk) }
      const col = cols.get(ch.column)
      if (!col) throw new Error(t('A coluna {column} não existe', { column: ch.column }))
      if (keys.includes(ch.column)) throw new Error(t('Colunas da chave primária não podem ser alteradas no Cassandra'))
      if (ch.value === null) return { query: `update ${from} set ${this.quote(ch.column)} = null where ${where}`, params: keyParams(ch.pk) }
      let json = ch.value
      if (!SCALAR.test(col.type)) {
        try {
          json = JSON.parse(ch.value)
        } catch {
          throw new Error(t('{column}: informe o valor em JSON (ex.: {example})', { column: ch.column, example: /^(frozen<)?map</.test(col.type) ? '{"a": 1}' : '["a", "b"]' }))
        }
      }
      return { query: `update ${from} set ${this.quote(ch.column)} = fromJson(?) where ${where}`, params: [JSON.stringify(json), ...keyParams(ch.pk)] }
    })
    try {
      await this.client.batch(queries, { prepare: true, logged: true })
    } catch (e) {
      // fromJson failures read like "Unable to make int from 'abc'" / marshal_exception.
      if (/fromjson|marshal/i.test(e.message)) {
        // Keep the server's reason, without the Java class / Scylla wrapper around it.
        const reason = e.message.split(/MarshalException:\s*|marshaling error:\s*/i).pop().replace(/\)\s*$/, '').trim()
        throw new Error(t('Valor incompatível com o tipo da coluna: {error}', { error: reason.slice(0, 200) }))
      }
      throw e
    }
    return changes.length
  }

  async transaction(fn) {
    return fn()
  }

  async readOnly(fn) {
    return fn()
  }
}

module.exports = CassandraDriver
