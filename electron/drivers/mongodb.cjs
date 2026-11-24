// MongoDB through the official driver.
//
// - The picker switches databases; collections and views are the "tables".
// - The editor takes mongosh-style commands (see lib/mongoshell.cjs, which
//   parses them without evaluating anything).
// - Documents become grid rows: top-level fields are columns, nested values
//   are shown as Extended JSON; BSON scalars as readable text.
// - Columns of a collection are inferred from a sample of documents.
// - No grid editing yet (caps.transactions = false); AI queries need approval.
const { MongoClient, ObjectId, Decimal128, Long, Int32, Double, Binary, UUID, BSONRegExp, Timestamp, BSON } = require('mongodb')
const { EJSON } = BSON
const { parseCommand, parseValue } = require('../lib/mongoshell.cjs')
const { t } = require('../../shared/i18n.mjs')

const SYSTEM_DBS = new Set(['admin', 'local', 'config'])
const SAMPLE = 100

// One BSON value as a grid cell.
function cell(v) {
  if (v === null || v === undefined) return null
  if (v instanceof ObjectId) return v.toHexString()
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString()
  if (v instanceof Decimal128 || v instanceof Long) return v.toString()
  if (v instanceof Int32 || v instanceof Double) return v.valueOf()
  if (v instanceof UUID) return v.toHexString()
  if (v instanceof Binary) return `Binary(${v.length()} bytes)`
  if (v instanceof BSONRegExp) return `/${v.pattern}/${v.options}`
  if (v instanceof Timestamp) return v.toString()
  if (typeof v === 'object') return EJSON.stringify(v, { relaxed: true })
  return v
}

function bsonType(v) {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (v instanceof ObjectId) return 'objectId'
  if (v instanceof Date) return 'date'
  if (v instanceof Decimal128) return 'decimal'
  if (v instanceof Long) return 'long'
  if (v instanceof Binary || v instanceof UUID) return 'binData'
  if (typeof v === 'object') return v._bsontype ? v._bsontype.toLowerCase() : 'object'
  return typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'double') : typeof v
}

// Documents → { fields, rows }: _id first, then fields in first-seen order
// (or the given field list, so every batch of an export has the same columns).
function toGrid(docs, fixed = null) {
  const fields = fixed ? [...fixed] : []
  if (!fixed) {
    const seen = new Set()
    for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) { seen.add(k); fields.push(k) }
    const i = fields.indexOf('_id')
    if (i > 0) fields.unshift(...fields.splice(i, 1))
  }
  return { fields, rows: docs.map((d) => fields.map((f) => cell(d[f]))) }
}

// Every top-level field name a pipeline produces, computed by the server.
const KEYS = [
  { $project: { k: { $objectToArray: '$$ROOT' } } },
  { $unwind: '$k' },
  { $group: { _id: null, keys: { $addToSet: '$k.k' } } },
]
const keyOrder = (keys) => ['_id', ...keys.filter((k) => k !== '_id').sort()].filter((k) => k !== '_id' || keys.includes('_id'))

const one = (label, value) => ({ fields: [label], rows: [[cell(value)]] })

// An _id typed in the grid (24 hex chars → ObjectId, digits → number).
function idFrom(v) {
  if (typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v)) return new ObjectId(v)
  return v
}

// Text edited in the grid → a value of the field's original BSON type.
function typed(original, text) {
  if (text === null || text === undefined) return null
  const bad = (kind) => { throw new Error(t('Valor inválido para um campo {kind}: {value}', { kind, value: text })) }
  if (original === null || original === undefined) return text
  if (typeof original === 'number') { const n = Number(text); return Number.isFinite(n) && String(text).trim() !== '' ? n : bad('number') }
  if (typeof original === 'boolean') return /^(true|false)$/i.test(text) ? /^true$/i.test(text) : bad('boolean')
  if (original instanceof Date) { const d = new Date(text); return isNaN(d) ? bad('date') : d }
  if (original instanceof ObjectId) return /^[0-9a-f]{24}$/i.test(text) ? new ObjectId(text) : bad('objectId')
  if (original instanceof Decimal128) { try { return Decimal128.fromString(String(text).trim()) } catch { return bad('decimal') } }
  if (original instanceof Long) return /^-?\d+$/.test(String(text).trim()) ? Long.fromString(String(text).trim()) : bad('long')
  if (original instanceof Int32) return /^-?\d+$/.test(String(text).trim()) ? new Int32(Number(text)) : bad('int')
  if (Array.isArray(original) || typeof original === 'object') {
    // Shown as relaxed Extended JSON; mongosh syntax ({ a: 1 }) is accepted too.
    try { return EJSON.parse(text, { relaxed: true }) } catch { try { return parseValue(text) } catch { return bad(Array.isArray(original) ? 'array' : 'object') } }
  }
  return String(text)
}

class MongoDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'mongo'
  }

  quote(id) {
    return JSON.stringify(String(id))
  }

  placeholder() {
    return '?'
  }

  qualified(table) {
    return table
  }

  async connect() {
    const c = this.config
    const url = (c.url || '').trim() || 'mongodb://localhost:27017'
    this.client = new MongoClient(url, {
      appName: 'Graphite',
      serverSelectionTimeoutMS: 10000,
      ...(c.user && { auth: { username: c.user, password: c.password || '' } }),
      // Through an SSH tunnel (127.0.0.1): TLS checks the real host name.
      ...(c.tunnelHost && { ...(!require('node:net').isIP(c.tunnelHost) && { servername: c.tunnelHost }), checkServerIdentity: (_h, cert) => require('node:tls').checkServerIdentity(c.tunnelHost, cert) }),
    })
    await this.client.connect()
    const fromUrl = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(url)?.[1]
    this.dbName = c.database || (fromUrl && decodeURIComponent(fromUrl)) || 'test'
  }

  async disconnect() {
    await this.client?.close().catch(() => {})
    this.client = null
  }

  get db() {
    return this.client.db(this.dbName)
  }

  async version() {
    const info = await this.db.admin().command({ buildInfo: 1 })
    return 'MongoDB ' + info.version
  }

  async database() {
    return this.dbName
  }

  async listSchemas() {
    const r = await this.db.admin().listDatabases({ nameOnly: true }).catch(() => ({ databases: [{ name: this.dbName }] }))
    return r.databases.map((d) => ({ name: d.name, system: SYSTEM_DBS.has(d.name) })).sort((a, b) => a.name.localeCompare(b.name))
  }

  async currentSchema() {
    return this.dbName
  }

  async useSchema(name) {
    this.dbName = name
  }

  async listTables(schema) {
    const db = this.client.db(schema ?? this.dbName)
    const cols = await db.listCollections({}, { nameOnly: false }).toArray()
    return cols
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => ({ name: c.name, schema: db.databaseName, type: c.type === 'view' ? 'view' : 'table' }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  }

  // Inferred from a sample: the same field may hold several types.
  async listColumns(table, schema) {
    const docs = await this.client.db(schema ?? this.dbName).collection(table).find({}).limit(SAMPLE).toArray()
    const types = new Map()
    for (const d of docs) for (const [k, v] of Object.entries(d)) {
      if (!types.has(k)) types.set(k, new Set())
      types.get(k).add(bsonType(v))
    }
    if (!types.size) types.set('_id', new Set(['objectId']))
    const names = [...types.keys()]
    if (names.indexOf('_id') > 0) names.unshift(...names.splice(names.indexOf('_id'), 1))
    return names.map((name) => {
      const set = types.get(name)
      return {
        name,
        type: [...set].filter((x) => x !== 'null').join(' | ') || 'null',
        nullable: set.has('null') || docs.some((d) => !(name in d)),
        default: null,
        primary: name === '_id',
        auto: name === '_id',
        references: null,
      }
    })
  }

  async schemaMap() {
    const map = {}
    for (const tb of (await this.listTables()).slice(0, 50)) map[tb.name] = (await this.listColumns(tb.name).catch(() => [])).map((c) => c.name)
    return map
  }

  async listIndexes(table, schema) {
    const ix = await this.client.db(schema ?? this.dbName).collection(table).indexes().catch(() => [])
    return ix.map((i) => ({ name: i.name, unique: !!i.unique || i.name === '_id_', primary: i.name === '_id_', columns: Object.keys(i.key) }))
  }

  // The Structure tab: how to recreate the collection and its indexes.
  async createScript(table, schema) {
    const db = this.client.db(schema ?? this.dbName)
    const info = (await db.listCollections({ name: table }).toArray())[0] || {}
    const lines = [`db.createCollection(${JSON.stringify(table)}${info.options && Object.keys(info.options).length ? ', ' + EJSON.stringify(info.options, { relaxed: true }) : ''})`]
    for (const i of await db.collection(table).indexes().catch(() => [])) {
      if (i.name === '_id_') continue
      const { key, name, v, ns, ...opts } = i
      lines.push(`db.${table}.createIndex(${EJSON.stringify(key)}, ${EJSON.stringify({ name, ...opts }, { relaxed: true })})`)
    }
    return lines.join('\n')
  }

  filterOf(where) {
    if (!where) return {}
    const f = parseValue(where)
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error(t('O filtro deve ser um objeto, por exemplo {"status": "pago"}'))
    return f
  }

  async page({ table, schema, limit, offset, orderBy, dir, where }) {
    const coll = this.client.db(schema ?? this.dbName).collection(table)
    const filter = this.filterOf(where)
    const sort = orderBy ? { [orderBy]: dir === 'desc' ? -1 : 1 } : undefined
    const docs = await coll.find(filter, { sort, skip: offset, limit }).toArray()
    const total = where ? await coll.countDocuments(filter) : await coll.estimatedDocumentCount()
    // The page's documents, so edits keep each field's BSON type and _id.
    this.shown = { key: `${coll.dbName}.${table}`, docs: new Map(docs.map((d) => [String(cell(d._id)), d])) }
    return { ...toGrid(docs), total }
  }

  // Grid edits: $set / deleteOne by _id, in a transaction where the server
  // supports one (replica sets, Atlas); otherwise in order, stopping at the
  // first failure and saying how many went in.
  async applyChanges(changes) {
    const { table, schema } = changes[0]
    const db = this.client.db(schema ?? this.dbName)
    const coll = db.collection(table)
    const docs = this.shown?.key === `${db.databaseName}.${table}` ? this.shown.docs : new Map()
    let done = 0
    const run = async (session) => {
      done = 0
      for (const ch of changes) {
        const doc = docs.get(String(ch.pk._id))
        const id = doc ? doc._id : idFrom(ch.pk._id)
        if (ch.kind === 'delete') {
          const r = await coll.deleteOne({ _id: id }, { session })
          if (r.deletedCount !== 1) throw new Error(t('O documento {id} não existe mais', { id: String(ch.pk._id) }))
        } else {
          if (ch.column === '_id') throw new Error(t('O _id de um documento não pode ser alterado'))
          const r = await coll.updateOne({ _id: id }, { $set: { [ch.column]: typed(doc?.[ch.column], ch.value) } }, { session })
          if (r.matchedCount !== 1) throw new Error(t('O documento {id} não existe mais', { id: String(ch.pk._id) }))
        }
        done++
      }
      return done
    }
    const session = this.client.startSession()
    try {
      return await session.withTransaction(() => run(session))
    } catch (e) {
      // Standalone servers have no transactions: apply in order instead.
      if (e.code === 20 || /replica set|Transaction numbers|retryable writes|does not support transactions/i.test(e.message)) {
        try {
          return await run(undefined)
        } catch (err) {
          throw new Error(done ? t('{error} ({n} alteração já aplicada; sem transação neste servidor)|{error} ({n} alterações já aplicadas; sem transação neste servidor)', { error: err.message, n: done }) : err.message)
        }
      }
      throw e
    } finally {
      await session.endSession()
    }
  }

  // Exports: the columns are every field found in the matching documents.
  async *streamTable(table, schema, where) {
    const coll = this.client.db(schema ?? this.dbName).collection(table)
    const filter = this.filterOf(where)
    const keys = (await coll.aggregate([{ $match: filter }, ...KEYS]).toArray())[0]?.keys || []
    yield* this.cursorBatches(coll.find(filter), 1000, keyOrder(keys))
  }

  async *cursorBatches(cursor, batch, fields = null) {
    let docs = []
    let first = true
    for await (const d of cursor) {
      docs.push(d)
      if (docs.length >= batch) {
        yield toGrid(docs, fields)
        docs = []
        first = false
      }
    }
    if (docs.length || first) yield toGrid(docs, fields)
  }

  // Field list of a find / aggregate command, for exports of a query.
  async fieldsOf(cmd) {
    const coll = this.db.collection(cmd.collection)
    let pipeline = cmd.method === 'aggregate' ? [...(cmd.args[0] || [])] : [{ $match: cmd.args[0] || {} }]
    const projection = cmd.method === 'find' ? cmd.args[1] || cmd.chain.find((c) => c.method === 'project' || c.method === 'projection')?.args[0] : null
    if (projection) pipeline.push({ $project: projection })
    pipeline = pipeline.filter((st) => !('$out' in st) && !('$merge' in st))
    const keys = (await coll.aggregate([...pipeline, ...KEYS]).toArray())[0]?.keys || []
    return keyOrder(keys)
  }

  cursorOf(cmd) {
    const coll = this.db.collection(cmd.collection)
    if (cmd.method !== 'find' && cmd.method !== 'aggregate') return null
    let cursor = cmd.method === 'find' ? coll.find(cmd.args[0] || {}, cmd.args[1] ? { projection: cmd.args[1] } : {}) : coll.aggregate(cmd.args[0] || [], cmd.args[1] || {})
    for (const c of cmd.chain) {
      const a = c.args[0]
      if (c.method === 'sort') cursor = cursor.sort(a)
      else if (c.method === 'limit') cursor = cursor.limit(a)
      else if (c.method === 'skip') cursor = cursor.skip(a)
      else if (c.method === 'project' || c.method === 'projection') cursor = cursor.project(a)
      else if (!['toArray', 'pretty', 'batchSize'].includes(c.method)) throw new Error(t('Método não suportado: {name}', { name: c.method }))
    }
    return cursor
  }

  async execute(text) {
    const cmd = parseCommand(text)
    if (cmd.kind === 'show') {
      if (cmd.what === 'dbs' || cmd.what === 'databases') return toGrid((await this.listSchemas()).map((d) => ({ name: d.name })))
      if (cmd.what === 'collections' || cmd.what === 'tables') return toGrid((await this.listTables()).map((x) => ({ name: x.name, type: x.type })))
      throw new Error(t('Comando show não suportado: {name}', { name: cmd.what }))
    }
    if (cmd.kind === 'db') {
      const [a, b] = cmd.args
      switch (cmd.method) {
        case 'runCommand':
        case 'adminCommand':
          return toGrid([await (cmd.method === 'adminCommand' ? this.db.admin() : this.db).command(a)])
        case 'getCollectionNames':
          return toGrid((await this.listTables()).map((x) => ({ name: x.name })))
        case 'createCollection':
          await this.db.createCollection(String(a), b || {})
          return { affected: 0 }
        case 'stats':
          return toGrid([await this.db.command({ dbStats: 1 })])
        case 'dropDatabase':
          await this.db.dropDatabase()
          return { affected: 0 }
      }
      throw new Error(t('Método não suportado: {name}', { name: `db.${cmd.method}` }))
    }
    const coll = this.db.collection(cmd.collection)
    const [a, b, c] = cmd.args
    const cursor = this.cursorOf(cmd)
    if (cursor) return toGrid(await cursor.toArray())
    switch (cmd.method) {
      case 'findOne': return toGrid([await coll.findOne(a || {}, b ? { projection: b } : {})].filter(Boolean))
      case 'countDocuments': return one('count', await coll.countDocuments(a || {}))
      case 'count': return one('count', await coll.countDocuments(a || {}))
      case 'estimatedDocumentCount': return one('count', await coll.estimatedDocumentCount())
      case 'distinct': return { fields: [String(a)], rows: (await coll.distinct(String(a), b || {})).map((v) => [cell(v)]) }
      case 'insertOne': await coll.insertOne(a); return { affected: 1 }
      case 'insertMany': return { affected: (await coll.insertMany(a)).insertedCount }
      case 'updateOne': return { affected: (await coll.updateOne(a, b, c)).modifiedCount }
      case 'updateMany': return { affected: (await coll.updateMany(a, b, c)).modifiedCount }
      case 'replaceOne': return { affected: (await coll.replaceOne(a, b, c)).modifiedCount }
      case 'deleteOne': return { affected: (await coll.deleteOne(a)).deletedCount }
      case 'deleteMany': return { affected: (await coll.deleteMany(a)).deletedCount }
      case 'getIndexes': return toGrid(await coll.indexes())
      case 'createIndex': return one('index', await coll.createIndex(a, b || {}))
      case 'dropIndex': await coll.dropIndex(a); return { affected: 0 }
      case 'drop': await coll.drop(); return { affected: 0 }
      case 'stats': return toGrid([await this.db.command({ collStats: cmd.collection })])
    }
    throw new Error(t('Método não suportado: {name}', { name: cmd.method }))
  }

  async *stream(text, { batch = 1000 } = {}) {
    const cmd = parseCommand(text)
    const cursor = cmd.kind === 'coll' ? this.cursorOf(cmd) : null
    if (cursor) yield* this.cursorBatches(cursor, batch, await this.fieldsOf(cmd))
    else yield await this.execute(text)
  }

  async firstRows(text, limit) {
    const cmd = parseCommand(text)
    if (cmd.kind === 'coll' && cmd.method === 'find') cmd.chain.push({ method: 'limit', args: [limit + 1] })
    if (cmd.kind === 'coll' && cmd.method === 'aggregate') cmd.args[0] = [...(cmd.args[0] || []), { $limit: limit + 1 }]
    const cursor = cmd.kind === 'coll' ? this.cursorOf(cmd) : null
    return cursor ? toGrid(await cursor.toArray()) : this.execute(text)
  }

  async transaction(fn) {
    return fn()
  }

  async readOnly(fn) {
    return fn()
  }
}

module.exports = MongoDriver
