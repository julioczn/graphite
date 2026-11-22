// Amazon DynamoDB through its HTTP API, signed with SigV4 (lib/sigv4.cjs) —
// no AWS SDK. Queries are PartiQL (ExecuteStatement).
//
// - Tables only (no schemas); the key attributes come first in the grid,
//   other attributes are the union of what the items carry.
// - Paging follows NextToken, so there is no total.
// - endpoint points at DynamoDB Local / LocalStack.
// - No interactive transactions: read-only grid; every AI query needs approval.
const { sign } = require('../lib/sigv4.cjs')
const { normaliseRows } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

// AttributeValue → plain value.
function unmarshall(av) {
  if (!av || typeof av !== 'object') return av
  if ('S' in av) return av.S
  if ('N' in av) return /^-?\d{1,15}(\.\d+)?$/.test(av.N) && av.N.replace(/[-.]/g, '').length <= 15 ? Number(av.N) : av.N
  if ('BOOL' in av) return av.BOOL
  if ('NULL' in av) return null
  if ('B' in av) return Buffer.from(av.B, 'base64')
  if ('M' in av) return Object.fromEntries(Object.entries(av.M).map(([k, v]) => [k, unmarshall(v)]))
  if ('L' in av) return av.L.map(unmarshall)
  if ('SS' in av) return av.SS
  if ('NS' in av) return av.NS.map((n) => (/^-?\d{1,15}$/.test(n) ? Number(n) : n))
  if ('BS' in av) return av.BS.map((b) => Buffer.from(b, 'base64'))
  return av
}

function marshall(v) {
  if (v === null || v === undefined) return { NULL: true }
  if (typeof v === 'boolean') return { BOOL: v }
  if (typeof v === 'number' || typeof v === 'bigint') return { N: String(v) }
  return { S: String(v) }
}

const plain = (v) => (Buffer.isBuffer(v) ? v : v && typeof v === 'object' ? JSON.stringify(v, (k, x) => (x?.type === 'Buffer' ? `<${x.data.length} bytes>` : x)) : v)

class DynamoDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'partiql'
    this.keys = new Map() // table -> key attribute names
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

  get region() {
    return (this.config.region || 'us-east-1').trim()
  }

  get endpoint() {
    return (this.config.endpoint || '').trim().replace(/\/+$/, '') || `https://dynamodb.${this.region}.amazonaws.com`
  }

  async api(op, payload) {
    const body = JSON.stringify(payload)
    const headers = sign({
      method: 'POST',
      url: this.endpoint + '/',
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${op}` },
      body,
      region: this.region,
      service: 'dynamodb',
      accessKeyId: this.config.accessKey || 'local',
      secretAccessKey: this.config.password || 'local',
    })
    delete headers.host
    const res = await fetch(this.endpoint + '/', { method: 'POST', headers, body })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(out.message || out.Message || `${(out.__type || '').split('#').pop() || 'DynamoDB'} ${res.status}`)
    return out
  }

  async connect() {
    if (!this.config.endpoint && !this.config.accessKey) throw new Error(t('Informe a access key da AWS'))
    await this.api('ListTables', { Limit: 1 })
  }

  async disconnect() {}

  async version() {
    return this.config.endpoint ? 'DynamoDB Local' : `DynamoDB (${this.region})`
  }

  async database() {
    return this.region
  }

  async listSchemas() {
    return []
  }

  async currentSchema() {
    return null
  }

  async useSchema() {}

  async listTables() {
    const out = []
    let start
    do {
      const r = await this.api('ListTables', { Limit: 100, ...(start && { ExclusiveStartTableName: start }) })
      out.push(...r.TableNames)
      start = r.LastEvaluatedTableName
    } while (start)
    return out.sort().map((name) => ({ name, schema: null, type: 'table' }))
  }

  async describe(table) {
    return (await this.api('DescribeTable', { TableName: table })).Table
  }

  async keyNames(table) {
    if (!this.keys.has(table)) {
      const d = await this.describe(table)
      this.keys.set(table, d.KeySchema.sort((a) => (a.KeyType === 'HASH' ? -1 : 1)).map((k) => k.AttributeName))
    }
    return this.keys.get(table)
  }

  // Items → grid: key attributes first, then the others in first-seen order.
  grid(items, keys = [], fixed = null) {
    const fields = fixed ? [...fixed] : [...keys]
    if (!fixed) {
      const seen = new Set(fields)
      for (const it of items) for (const k of Object.keys(it)) if (!seen.has(k)) { seen.add(k); fields.push(k) }
    }
    return { fields, rows: items.map((it) => fields.map((f) => plain(unmarshall(it[f])))) }
  }

  async listColumns(table) {
    const d = await this.describe(table)
    const defs = Object.fromEntries((d.AttributeDefinitions || []).map((a) => [a.AttributeName, a.AttributeType]))
    const keys = await this.keyNames(table)
    const sample = await this.api('Scan', { TableName: table, Limit: 50 })
    const types = new Map(keys.map((k) => [k, new Set([{ S: 'S', N: 'N', B: 'B' }[defs[k]] || 'S'])]))
    for (const it of sample.Items || []) for (const [k, v] of Object.entries(it)) {
      if (!types.has(k)) types.set(k, new Set())
      types.get(k).add(Object.keys(v)[0])
    }
    const keyType = (k) => (d.KeySchema.find((x) => x.AttributeName === k)?.KeyType === 'HASH' ? ' (partition key)' : ' (sort key)')
    return [...types.keys()].map((name) => ({
      name,
      type: [...types.get(name)].join(' | ') + (keys.includes(name) ? keyType(name) : ''),
      nullable: !keys.includes(name),
      default: null,
      primary: keys.includes(name),
      auto: false,
      references: null,
    }))
  }

  async schemaMap() {
    const map = {}
    for (const tb of (await this.listTables()).slice(0, 50)) map[tb.name] = await this.keyNames(tb.name).catch(() => [])
    return map
  }

  async listIndexes(table) {
    const d = await this.describe(table)
    const ix = [{ name: 'PRIMARY', unique: true, primary: true, columns: d.KeySchema.map((k) => k.AttributeName) }]
    for (const g of [...(d.GlobalSecondaryIndexes || []), ...(d.LocalSecondaryIndexes || [])]) ix.push({ name: g.IndexName, unique: false, primary: false, columns: g.KeySchema.map((k) => k.AttributeName) })
    return ix
  }

  // The Structure tab: the table definition as CreateTable would take it.
  async createScript(table) {
    const d = await this.describe(table)
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
    const gsi = (d.GlobalSecondaryIndexes || []).map((g) => pick(g, ['IndexName', 'KeySchema', 'Projection']))
    return JSON.stringify({
      TableName: d.TableName,
      KeySchema: d.KeySchema,
      AttributeDefinitions: d.AttributeDefinitions,
      BillingMode: d.BillingModeSummary?.BillingMode || 'PROVISIONED',
      ...(gsi.length && { GlobalSecondaryIndexes: gsi }),
      ItemCount: d.ItemCount,
    }, null, 2)
  }

  async *pages(statement, params = []) {
    let next
    do {
      const r = await this.api('ExecuteStatement', { Statement: statement, ...(params.length && { Parameters: params.map(marshall) }), ...(next && { NextToken: next }) })
      yield r.Items || []
      next = r.NextToken
    } while (next)
  }

  async page({ table, limit, offset, where }) {
    const keys = await this.keyNames(table)
    const items = []
    let skipped = 0
    for await (const batch of this.pages(`SELECT * FROM ${this.quote(table)}${where ? ` WHERE ${where}` : ''}`)) {
      for (const it of batch) {
        if (skipped < offset) skipped++
        else if (items.length < limit) items.push(it)
      }
      if (items.length >= limit) break
    }
    const g = this.grid(items, keys)
    return { fields: g.fields, rows: normaliseRows(g.rows, g.fields), total: null }
  }

  async *streamTable(table, schema, where) {
    const keys = await this.keyNames(table)
    // Columns for every batch: the attributes found in a first pass over the keys only.
    const names = new Set(keys)
    for await (const batch of this.pages(`SELECT * FROM ${this.quote(table)}${where ? ` WHERE ${where}` : ''}`)) for (const it of batch) for (const k of Object.keys(it)) names.add(k)
    const fields = [...names]
    let first = true
    for await (const batch of this.pages(`SELECT * FROM ${this.quote(table)}${where ? ` WHERE ${where}` : ''}`)) {
      const g = this.grid(batch, keys, fields)
      yield { fields, rows: g.rows }
      first = false
    }
    if (first) yield { fields, rows: [] }
  }

  async execute(text, params = []) {
    const statement = text.trim().replace(/[\s;]+$/, '')
    if (!/^\s*select\b/i.test(statement)) {
      await this.api('ExecuteStatement', { Statement: statement, ...(params.length && { Parameters: params.map(marshall) }) })
      return { affected: 1 } // PartiQL writes touch a single item
    }
    const items = []
    for await (const batch of this.pages(statement, params)) {
      items.push(...batch)
      if (items.length >= 5000) break
    }
    // Key attributes lead only for SELECT *; an explicit projection keeps its order.
    const table = /^\s*select\s+\*\s+from\s+"?([\w.-]+)"?/i.exec(statement)?.[1]
    const projection = /^\s*select\s+(.+?)\s+from\b/is.exec(statement)?.[1]
    const listed = !table && projection ? projection.split(',').map((p) => p.trim().replace(/^"|"$/g, '')).filter((p) => /^[\w.-]+$/.test(p)) : []
    const g = this.grid(items, table ? await this.keyNames(table).catch(() => []) : listed)
    return { fields: g.fields, rows: normaliseRows(g.rows, g.fields) }
  }

  async *stream(text, { batch = 1000 } = {}) {
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

module.exports = DynamoDriver
