// Redis (and Valkey / KeyDB / Dragonfly) through ioredis.
//
// - The picker switches logical databases (db0, db1…).
// - Keys are the "tables" (first 1,000 found by SCAN; the table tab's filter
//   is a MATCH pattern for collection members). Each key type is shown as a
//   grid: string → value, hash → field/value, list → index/value, set →
//   member, zset → member/score, stream → id/fields, ReJSON → JSON.
// - The editor runs redis-cli style commands, one per line.
// - No grid editing; every AI command needs approval.
const Redis = require('ioredis')
const { t } = require('../../shared/i18n.mjs')

const MAX_KEYS = 1000

// redis-cli style tokenizer: spaces separate, quotes group, \ escapes in "".
function tokenize(line) {
  const out = []
  let cur = ''
  let quote = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) { quote = null; continue }
      if (c === '\\' && quote === '"' && i + 1 < line.length) {
        const n = line[++i]
        cur += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[n] ?? n
        continue
      }
      cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else cur += c
  }
  if (quote) throw new Error(t('Aspas não fechadas'))
  if (cur || has) out.push(cur)
  return out
}

const text = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v)

// A reply as a grid. Flat key/value replies of known commands become two columns.
const PAIRS = new Set(['HGETALL', 'CONFIG', 'XINFO'])
function replyGrid(cmd, reply) {
  if (reply === null || reply === undefined) return { fields: ['value'], rows: [[null]] }
  if (!Array.isArray(reply)) return { fields: ['value'], rows: [[typeof reply === 'object' ? JSON.stringify(reply) : text(reply)]] }
  const upper = cmd.toUpperCase()
  if (PAIRS.has(upper) && reply.length % 2 === 0) {
    const rows = []
    for (let i = 0; i < reply.length; i += 2) rows.push([text(reply[i]), text(reply[i + 1])])
    return { fields: upper === 'HGETALL' ? ['field', 'value'] : ['key', 'value'], rows }
  }
  return { fields: ['#', 'value'], rows: reply.map((v, i) => [i + 1, Array.isArray(v) ? JSON.stringify(v.map(text)) : text(v)]) }
}

class RedisDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'redis'
  }

  quote(id) {
    return /^[\w:.\-]+$/.test(id) ? String(id) : JSON.stringify(String(id))
  }

  placeholder() {
    return '?'
  }

  qualified(table) {
    return table
  }

  async connect() {
    const c = this.config
    this.dbIndex = Number(String(c.database || '0').replace(/^db/i, '')) || 0
    this.client = new Redis({
      host: c.host || 'localhost',
      port: Number(c.port) || 6379,
      username: c.user || undefined,
      password: c.password || undefined,
      db: this.dbIndex,
      tls: c.ssl ? { rejectUnauthorized: false } : undefined,
      lazyConnect: true,
      connectTimeout: 10000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    })
    this.client.on('error', () => {}) // surfaced through the failing command
    await this.client.connect()
  }

  async disconnect() {
    this.client?.disconnect()
    this.client = null
  }

  async version() {
    const info = await this.client.info('server')
    const v = /redis_version:([^\r\n]+)/.exec(info)?.[1]
    const flavor = /valkey_version:([^\r\n]+)/.exec(info) ? 'Valkey' : /dragonfly_version/.test(info) ? 'Dragonfly' : 'Redis'
    return `${flavor} ${/valkey_version:([^\r\n]+)/.exec(info)?.[1] || v || ''}`.trim()
  }

  async database() {
    return `db${this.dbIndex}`
  }

  // db0…dbN; the ones with keys come first in INFO keyspace.
  async listSchemas() {
    const count = Number((await this.client.config('GET', 'databases').catch(() => [null, '16']))[1]) || 16
    return Array.from({ length: count }, (_, i) => ({ name: `db${i}`, system: false }))
  }

  async currentSchema() {
    return `db${this.dbIndex}`
  }

  async useSchema(name) {
    const n = Number(String(name).replace(/^db/i, ''))
    await this.client.select(n)
    this.dbIndex = n
  }

  // Keys as tables (type in the name column would be noisy; it goes in `kind`).
  async listTables() {
    const keys = []
    let cursor = '0'
    do {
      const [next, batch] = await this.client.scan(cursor, 'COUNT', 500)
      keys.push(...batch)
      cursor = next
    } while (cursor !== '0' && keys.length < MAX_KEYS)
    return keys.slice(0, MAX_KEYS).sort().map((name) => ({ name, schema: null, type: 'table' }))
  }

  async typeOf(key) {
    const type = await this.client.type(key)
    if (type === 'none') throw new Error(t('A chave "{key}" não existe', { key }))
    return type
  }

  async listColumns(key) {
    const type = await this.typeOf(key)
    const cols = { string: ['value'], hash: ['field', 'value'], list: ['index', 'value'], set: ['member'], zset: ['member', 'score'], stream: ['id', 'fields'], 'ReJSON-RL': ['json'] }[type] || ['value']
    // The first column identifies the row (field, index, member, id); a string
    // or JSON key is a single row, identified by its value.
    return cols.map((name, i) => ({ name, type: i === 0 ? type : 'string', nullable: false, default: null, primary: i === 0, auto: false, references: null }))
  }

  async schemaMap() {
    return {}
  }

  async listIndexes() {
    return []
  }

  // The Structure tab: type, TTL, size and memory of the key.
  async createScript(key) {
    const type = await this.typeOf(key)
    const ttl = await this.client.ttl(key)
    const mem = await this.client.memory('USAGE', key).catch(() => null)
    const encoding = await this.client.object('ENCODING', key).catch(() => null)
    return [`TYPE ${type}`, `TTL ${ttl < 0 ? (ttl === -1 ? 'none' : ttl) : ttl + 's'}`, encoding && `ENCODING ${encoding}`, mem != null && `MEMORY ${mem} bytes`].filter(Boolean).join('\n')
  }

  async page({ table: key, limit, offset, where }) {
    const type = await this.typeOf(key)
    const match = where || '*'
    const c = this.client
    if (type === 'string') return { fields: ['value'], rows: [[await c.get(key)]], total: 1 }
    if (type === 'list') {
      const vals = await c.lrange(key, offset, offset + limit - 1)
      return { fields: ['index', 'value'], rows: vals.map((v, i) => [offset + i, v]), total: await c.llen(key) }
    }
    if (type === 'zset') {
      const flat = await c.zrange(key, offset, offset + limit - 1, 'WITHSCORES')
      const rows = []
      for (let i = 0; i < flat.length; i += 2) rows.push([flat[i], Number(flat[i + 1])])
      return { fields: ['member', 'score'], rows, total: await c.zcard(key) }
    }
    if (type === 'stream') {
      const entries = await c.xrange(key, '-', '+', 'COUNT', offset + limit)
      return { fields: ['id', 'fields'], rows: entries.slice(offset).map(([id, kv]) => [id, JSON.stringify(Object.fromEntries(kv.reduce((a, v, i) => (i % 2 ? a : [...a, [v, kv[i + 1]]]), [])))]), total: await c.xlen(key) }
    }
    if (type === 'ReJSON-RL') return { fields: ['json'], rows: [[await c.call('JSON.GET', key)]], total: 1 }
    // hash / set: SCAN-based, so MATCH filters members; skip to the offset.
    const rows = []
    let cursor = '0'
    let seen = 0
    do {
      const [next, batch] = type === 'hash' ? await c.hscan(key, cursor, 'MATCH', match, 'COUNT', 500) : await c.sscan(key, cursor, 'MATCH', match, 'COUNT', 500)
      const items = type === 'hash' ? batch.reduce((a, v, i) => (i % 2 ? a : [...a, [v, batch[i + 1]]]), []) : batch.map((m) => [m])
      for (const it of items) {
        if (seen++ >= offset && rows.length < limit) rows.push(it)
      }
      cursor = next
    } while (cursor !== '0' && rows.length < limit)
    const total = where && where !== '*' ? (cursor === '0' ? seen : null) : type === 'hash' ? await c.hlen(key) : await c.scard(key)
    return { fields: type === 'hash' ? ['field', 'value'] : ['member'], rows, total }
  }

  // Grid edits as one MULTI/EXEC under WATCH: all or nothing, and nothing
  // at all if the key changes between reading it and writing.
  async applyChanges(changes) {
    const key = changes[0].table
    const c = this.client
    await c.watch(key)
    try {
      const type = await this.typeOf(key)
      const ops = []
      const value = (v) => {
        if (v === null || v === undefined) throw new Error(t('O Redis não tem valores NULL'))
        return String(v)
      }
      const no = () => { throw new Error(t('Este tipo de chave do Redis não permite essa alteração')) }
      const marker = `__graphite_deleted_${Date.now()}__`
      let listDeletes = 0
      for (const ch of changes) {
        const del = ch.kind === 'delete'
        if (type === 'string') ops.push(del ? ['del', key] : ['set', key, value(ch.value), 'KEEPTTL'])
        else if (type === 'ReJSON-RL') ops.push(del ? ['del', key] : ['call', 'JSON.SET', key, '$', value(ch.value)])
        else if (type === 'hash') {
          const field = String(ch.pk.field)
          if (del) ops.push(['hdel', key, field])
          else if (ch.column === 'value') ops.push(['hset', key, field, value(ch.value)])
          else {
            const current = await c.hget(key, field)
            ops.push(['hset', key, value(ch.value), current ?? ''], ['hdel', key, field])
          }
        } else if (type === 'list') {
          const index = Number(ch.pk.index)
          if (del) { ops.push(['lset', key, index, marker]); listDeletes++ }
          else if (ch.column === 'value') ops.push(['lset', key, index, value(ch.value)])
          else no()
        } else if (type === 'set') {
          const member = String(ch.pk.member)
          ops.push(['srem', key, member])
          if (!del) ops.push(['sadd', key, value(ch.value)])
        } else if (type === 'zset') {
          const member = String(ch.pk.member)
          if (del) ops.push(['zrem', key, member])
          else if (ch.column === 'score') {
            const score = Number(ch.value)
            if (!Number.isFinite(score)) throw new Error(t('Valor inválido para um campo {kind}: {value}', { kind: 'score', value: ch.value }))
            ops.push(['zadd', key, 'XX', score, member])
          } else {
            const score = await c.zscore(key, member)
            ops.push(['zrem', key, member], ['zadd', key, score ?? 0, value(ch.value)])
          }
        } else if (type === 'stream') {
          if (del) ops.push(['xdel', key, String(ch.pk.id)])
          else no()
        } else no()
      }
      if (listDeletes) ops.push(['lrem', key, 0, marker])
      const res = await c.multi(ops).exec()
      if (!res) throw new Error(t('A chave "{key}" mudou enquanto as alterações eram aplicadas; nada foi gravado', { key }))
      const failed = res.find(([err]) => err)
      if (failed) throw failed[0]
      return changes.length
    } finally {
      await c.unwatch().catch(() => {})
    }
  }

  async *streamTable(key) {
    let offset = 0
    for (;;) {
      const r = await this.page({ table: key, limit: 1000, offset, where: '' })
      yield { fields: r.fields, rows: r.rows }
      offset += r.rows.length
      if (r.rows.length < 1000 || (r.total !== null && offset >= r.total)) break
    }
  }

  async execute(line) {
    const args = tokenize(line)
    if (!args.length) return { affected: 0 }
    const [cmd, ...rest] = args
    const upper = cmd.toUpperCase()
    if (upper === 'SELECT') {
      await this.useSchema(rest[0])
      return { affected: 0 }
    }
    const reply = await this.client.call(cmd, ...rest)
    if (typeof reply === 'number' && /^(DEL|UNLINK|HSET|HDEL|SADD|SREM|ZADD|ZREM|LPUSH|RPUSH|LREM|INCR|DECR|INCRBY|DECRBY|EXPIRE|PERSIST)$/.test(upper)) return { affected: reply }
    // Member/score pairs: flat (RESP2) or nested (RESP3) depending on the server.
    if (upper.startsWith('Z') && rest.some((a) => a.toUpperCase() === 'WITHSCORES') && Array.isArray(reply)) {
      const pairs = Array.isArray(reply[0]) ? reply : reply.reduce((a, v, i) => (i % 2 ? a : [...a, [v, reply[i + 1]]]), [])
      return { fields: ['member', 'score'], rows: pairs.map(([m, sc]) => [text(m), Number(sc)]) }
    }
    // *SCAN: [next cursor, items] → the items (pairs for HSCAN / ZSCAN), cursor in the column name.
    if (/SCAN$/.test(upper) && Array.isArray(reply) && reply.length === 2 && Array.isArray(reply[1])) {
      const items = reply[1]
      const label = `next cursor ${text(reply[0])}`
      if (upper === 'HSCAN' || upper === 'ZSCAN') {
        const rows = []
        for (let i = 0; i < items.length; i += 2) rows.push([text(items[i]), text(items[i + 1])])
        return { fields: [upper === 'HSCAN' ? 'field' : 'member', upper === 'HSCAN' ? 'value' : 'score'], rows, cursor: label }
      }
      return { fields: [label], rows: items.map((v) => [text(v)]) }
    }
    return replyGrid(cmd, reply)
  }

  async *stream(line) {
    yield await this.execute(line)
  }

  async firstRows(line, limit) {
    const r = await this.execute(line)
    return r.rows ? { ...r, rows: r.rows.slice(0, limit + 1) } : r
  }

  async transaction(fn) {
    return fn()
  }

  async readOnly(fn) {
    return fn()
  }
}

RedisDriver.tokenize = tokenize
module.exports = RedisDriver
