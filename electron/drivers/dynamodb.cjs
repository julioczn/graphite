// Amazon DynamoDB through its HTTP API, signed with SigV4 (lib/sigv4.cjs) —
// no AWS SDK. Queries are PartiQL (ExecuteStatement).
//
// - Tables only (no schemas); the key attributes come first in the grid,
//   other attributes are the union of what the items carry.
// - Paging follows NextToken, so there is no total.
// - endpoint points at DynamoDB Local / LocalStack.
// - Grid edits: one TransactWriteItems (all or nothing, up to 100 items), each
//   item conditioned on still existing. A value keeps the attribute's type
//   (S, N, BOOL, M/L and sets as JSON); NULL removes the attribute.
// - No interactive transactions: every AI query needs approval.
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

// Plain JSON value → AttributeValue (maps and lists recursively).
function toAv(v) {
  if (v === null || v === undefined) return { NULL: true }
  if (typeof v === 'boolean') return { BOOL: v }
  if (typeof v === 'number') return { N: String(v) }
  if (Array.isArray(v)) return { L: v.map(toAv) }
  if (typeof v === 'object') return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toAv(x)])) }
  return { S: String(v) }
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

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
    // Raw items of the page on screen: edits keep each attribute's type.
    this.shown = { table, items: new Map(items.map((it) => [JSON.stringify(keys.map((k) => String(unmarshall(it[k])))), it])) }
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

  // changes: [{ kind: 'update' | 'delete', table, pk: {attr: val}, column, value }]
  async applyChanges(changes) {
    const table = changes[0].table
    const d = await this.describe(table)
    const keys = d.KeySchema.map((k) => k.AttributeName)
    const keyType = Object.fromEntries(d.AttributeDefinitions.map((a) => [a.AttributeName, a.AttributeType]))
    const shown = this.shown?.table === table ? this.shown.items : new Map()
    const keyOf = (pk) => Object.fromEntries(keys.map((k) => [k, keyType[k] === 'N' ? { N: String(pk[k]) } : keyType[k] === 'B' ? { B: pk[k] } : { S: String(pk[k]) }]))
    // One write per item: its edits merge into one update; a delete wins.
    const items = new Map()
    for (const ch of changes) {
      const id = JSON.stringify(keys.map((k) => String(ch.pk[k])))
      const it = items.get(id) || { pk: ch.pk, del: false, set: new Map(), remove: new Set() }
      items.set(id, it)
      if (ch.kind === 'delete') it.del = true
      else if (keys.includes(ch.column)) throw new Error(t('Atributos da chave não podem ser alterados no DynamoDB'))
      else if (ch.value === null) it.remove.add(ch.column)
      else it.set.set(ch.column, this.typed(ch.column, ch.value, shown.get(id)?.[ch.column]))
    }
    if (items.size > 100) throw new Error(t('O DynamoDB aplica no máximo 100 itens por vez; aplique em partes'))
    const writes = [...items.values()].map((it) => {
      const names = { '#k': keys[0] }
      const base = { TableName: table, Key: keyOf(it.pk), ConditionExpression: 'attribute_exists(#k)', ExpressionAttributeNames: names }
      if (it.del) return { Delete: base }
      const values = {}
      const set = [...it.set].map(([col, av], i) => ((names['#s' + i] = col), (values[':s' + i] = av), `#s${i} = :s${i}`))
      const rm = [...it.remove].map((col, i) => ((names['#r' + i] = col), `#r${i}`))
      const expr = [set.length && 'SET ' + set.join(', '), rm.length && 'REMOVE ' + rm.join(', ')].filter(Boolean).join(' ')
      return { Update: { ...base, UpdateExpression: expr, ...(set.length && { ExpressionAttributeValues: values }) } }
    })
    try {
      await this.api('TransactWriteItems', { TransactItems: writes })
    } catch (e) {
      if (/ConditionalCheckFailed/.test(e.message)) throw new Error(t('Um dos itens não existe mais. Nada foi aplicado.'))
      throw e
    }
    return changes.length
  }

  // The grid's text → AttributeValue of the attribute's current type.
  typed(column, text, current) {
    const kind = current ? Object.keys(current)[0] : 'S'
    const json = () => {
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(t('{column}: informe o valor em JSON (ex.: {example})', { column, example: kind === 'M' ? '{"a": 1}' : '["a", "b"]' }))
      }
    }
    switch (kind) {
      case 'N':
        if (!NUMBER.test(text.trim())) throw new Error(t('{column}: "{value}" não é um número', { column, value: text }))
        return { N: text.trim() }
      case 'BOOL':
        if (!/^(true|false)$/i.test(text.trim())) throw new Error(t('{column}: use true ou false', { column }))
        return { BOOL: /^true$/i.test(text.trim()) }
      case 'M':
      case 'L':
        return toAv(json())
      case 'SS':
      case 'NS': {
        const list = json()
        if (!Array.isArray(list) || !list.length) throw new Error(t('{column}: um conjunto precisa de pelo menos um valor, em JSON (ex.: ["a", "b"])', { column }))
        if (kind === 'NS' && !list.every((n) => NUMBER.test(String(n)))) throw new Error(t('{column}: "{value}" não é um número', { column, value: list.find((n) => !NUMBER.test(String(n))) }))
        return { [kind]: [...new Set(list.map(String))] }
      }
      case 'B':
      case 'BS':
        throw new Error(t('{column}: valores binários não podem ser editados na grade', { column }))
      default:
        return { S: text }
    }
  }

  async transaction(fn) {
    return fn()
  }

  async readOnly(fn) {
    return fn()
  }
}

module.exports = DynamoDriver
