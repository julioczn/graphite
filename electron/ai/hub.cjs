// AI hub (main process): everything an AI agent can do in Graphite goes
// through here, whether the agent is an MCP client (Claude Code, Cursor…) or
// the built-in assistant.
//
// - Agents get their own database sessions, separate from the window's, so
//   they never see or join the user's open transaction.
// - SQL goes through the utility's `ai/query`: reads run in a read-only mode
//   the database enforces; anything else is shown to the user, who approves
//   or rejects it in the app before it runs.
// - Every tool call lands in an activity log the UI shows.
const { EventEmitter } = require('node:events')
const { MessageChannelMain } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { t } = require('../../shared/i18n.mjs')

const IDLE_MS = 10 * 60 * 1000
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_RESULT_CHARS = 60000

// --- RPC to the utility process, on a port of our own ----------------------

class UtilBridge {
  constructor() {
    this.port = null
    this.seq = 0
    this.pending = new Map()
  }

  attach(util) {
    for (const { reject } of this.pending.values()) reject(new Error(t('O processo de banco de dados reiniciou')))
    this.pending.clear()
    const { port1, port2 } = new MessageChannelMain()
    util.postMessage({ type: 'port', windowId: 'ai' }, [port1])
    port2.on('message', ({ data }) => {
      const p = this.pending.get(data.id)
      if (!p) return
      this.pending.delete(data.id)
      if (data.error) p.reject(Object.assign(new Error(data.error.message), { code: data.error.code }))
      else p.resolve(data.result)
    })
    port2.start()
    this.port = port2
  }

  detach() {
    for (const { reject } of this.pending.values()) reject(new Error(t('O processo de banco de dados foi encerrado')))
    this.pending.clear()
    this.port?.close()
    this.port = null
  }

  call(name, args = {}) {
    if (!this.port) return Promise.reject(new Error(t('Processo de banco de dados indisponível')))
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.port.postMessage({ id, name, args })
    })
  }
}

// --- tool definitions (JSON Schema; MCP and the assistant both use these) ---

const CONNECTION = {
  type: 'string',
  description: 'Connection to use: its id ("active", "saved:3") or the name shown by list_connections. If omitted, uses the connection open in the Graphite window.',
}
const SCHEMA = { type: 'string', description: 'Schema (PostgreSQL) or database (MySQL). If omitted, the connection\'s current one.' }

const TOOLS = [
  {
    name: 'list_connections',
    title: 'List connections',
    description: 'Lists the database connections available in Graphite (the one open in the window and the saved ones), with type and database.',
    readOnly: true,
    schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_schemas',
    title: 'List schemas',
    description: 'Lists the schemas (PostgreSQL) or databases (MySQL) of a connection. SQLite only has "main".',
    readOnly: true,
    schema: { type: 'object', properties: { connection: CONNECTION }, additionalProperties: false },
  },
  {
    name: 'list_tables',
    title: 'List tables',
    description: 'Lists the tables and views of a schema.',
    readOnly: true,
    schema: { type: 'object', properties: { connection: CONNECTION, schema: SCHEMA }, additionalProperties: false },
  },
  {
    name: 'describe_table',
    title: 'Describe table',
    description: 'Columns (type, NULL, default, primary key, FK), indexes and the DDL of a table or view.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: { connection: CONNECTION, table: { type: 'string', description: 'Table or view name' }, schema: SCHEMA },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_schema',
    title: 'Schema summary',
    description: 'Compact summary of every table in a schema: columns with types, primary keys and relations (FKs). A good starting point before writing SQL.',
    readOnly: true,
    schema: { type: 'object', properties: { connection: CONNECTION, schema: SCHEMA }, additionalProperties: false },
  },
  {
    name: 'run_query',
    title: 'Run SQL',
    description:
      'Runs SQL (one or more statements separated by ;). Reads (SELECT, WITH, EXPLAIN, SHOW…) run directly, in a read-only mode enforced by the database, with a 30 s timeout. ' +
      'Any other statement (INSERT, UPDATE, DELETE, DDL…) is shown to the user in Graphite and only runs if they approve it; an approved script runs in a transaction. ' +
      'Prefer LIMIT in exploratory queries.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: {
        connection: CONNECTION,
        sql: { type: 'string', description: 'SQL in the connection\'s dialect' },
        max_rows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum rows returned per statement (default 200)' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
]

// Minimal check of model-supplied input against the schemas above (the
// assistant streams tool input, so the API doesn't validate it for us).
function validate(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return t('entrada deve ser um objeto')
  const { properties, required = [] } = tool.schema
  for (const k of required) if (input[k] === undefined || input[k] === '') return t('campo obrigatório: {field}', { field: k })
  for (const [k, v] of Object.entries(input)) {
    const p = properties[k]
    if (!p) return t('campo desconhecido: {field}', { field: k })
    if (v === null || v === undefined) continue
    if (p.type === 'string' && typeof v !== 'string') return t('{field} deve ser texto', { field: k })
    if (p.type === 'integer' && !Number.isInteger(v)) return t('{field} deve ser um inteiro', { field: k })
  }
  return null
}

// --- settings ---------------------------------------------------------------

const DEFAULTS = {
  mcp: { enabled: false, port: 7329, token: '' },
  // keys: one per destination ("anthropic", "openai:<origin>"), so switching
  // provider or URL never sends a key to a service it wasn't made for.
  assistant: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '', keys: {} },
}

function keyId(provider, baseUrl) {
  if (provider === 'anthropic') return 'anthropic'
  try {
    return 'openai:' + new URL(baseUrl).origin
  } catch {
    return 'openai:' + String(baseUrl || '')
  }
}

class AiHub extends EventEmitter {
  constructor({ userData, safeStorage }) {
    super()
    this.util = new UtilBridge()
    this.safeStorage = safeStorage
    this.file = path.join(userData, 'ai.json')
    this.sessions = new Map() // connection id -> { sId, dialect, name, readOnly, lastUsed }
    this.opening = new Map()
    this.active = null // connection open in the window: { name, type, config, savedId }
    this.approvals = new Map() // id -> { resolve, timer, request }
    this.activity = []
    this.data = this.load()
    this.sweep = setInterval(() => this.closeIdle(), 60 * 1000)
    this.sweep.unref?.()
  }

  // --- settings -------------------------------------------------------------

  load() {
    let saved = {}
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {}
    const data = {
      mcp: { ...DEFAULTS.mcp, ...saved.mcp },
      assistant: { ...DEFAULTS.assistant, ...saved.assistant, keys: { ...saved.assistant?.keys } },
    }
    if (!data.mcp.token) {
      data.mcp.token = crypto.randomBytes(24).toString('base64url')
      this.data = data
      this.save()
    }
    return data
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }

  // What the renderer may see: never a key, only which destinations have one.
  publicSettings() {
    const { keys, ...assistant } = this.data.assistant
    return { mcp: { ...this.data.mcp }, assistant: { ...assistant, keyIds: Object.keys(keys).filter((k) => keys[k]) } }
  }

  update(patch = {}) {
    if (patch.mcp) Object.assign(this.data.mcp, pick(patch.mcp, ['enabled', 'port']))
    if (patch.assistant) {
      const a = pick(patch.assistant, ['provider', 'model', 'baseUrl'])
      Object.assign(this.data.assistant, a)
      if (typeof patch.assistant.apiKey === 'string') {
        const id = keyId(this.data.assistant.provider, this.data.assistant.baseUrl)
        if (patch.assistant.apiKey) this.data.assistant.keys[id] = this.encrypt(patch.assistant.apiKey)
        else delete this.data.assistant.keys[id]
      }
    }
    if (patch.regenerateToken) this.data.mcp.token = crypto.randomBytes(24).toString('base64url')
    this.data.mcp.port = Math.min(65535, Math.max(1024, Number(this.data.mcp.port) || DEFAULTS.mcp.port))
    this.save()
    this.emit('settings', this.publicSettings())
    return this.publicSettings()
  }

  encrypt(plain) {
    if (!plain) return ''
    if (this.safeStorage.isEncryptionAvailable()) return 'enc:' + this.safeStorage.encryptString(plain).toString('base64')
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64')
  }

  decrypt(stored) {
    if (!stored) return ''
    if (stored.startsWith('enc:')) return this.safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    return stored
  }

  // Key saved for a provider + URL (default: the configured one; empty if none).
  apiKey(provider = this.data.assistant.provider, baseUrl = this.data.assistant.baseUrl) {
    return this.decrypt(this.data.assistant.keys[keyId(provider, baseUrl)])
  }

  // --- connections and agent sessions -------------------------------------------

  attachUtil(util) {
    this.util.attach(util)
    this.sessions.clear() // their sIds died with the old process
    this.opening.clear()
  }

  detachUtil() {
    this.util.detach()
    this.sessions.clear()
    this.opening.clear()
  }

  // Called by the window when it opens / closes a connection.
  setActive(info) {
    this.active = info && info.config ? info : null
    this.closeSession('active')
  }

  async listConnections() {
    const saved = await this.util.call('app/connections')
    const out = []
    if (this.active) out.push(describe('active', this.active.name || t('Conexão aberta'), this.active.type, this.active.config, true))
    for (const c of saved) {
      if (this.active?.savedId === c.id) continue // same database as "active"
      out.push(describe(`saved:${c.id}`, c.name, c.type, c.config, false))
    }
    return out
  }

  async resolve(ref) {
    const list = await this.listConnections()
    if (!ref) {
      if (this.active) return list[0]
      if (list.length === 1) return list[0]
      throw new Error(list.length ? t('Nenhuma conexão aberta no Graphite. Informe "connection": {names}', { names: list.map((c) => `"${c.name}"`).join(', ') }) : t('Nenhuma conexão disponível no Graphite'))
    }
    const r = String(ref).trim().toLowerCase()
    const hit = list.find((c) => c.id === r) || list.find((c) => c.name.toLowerCase() === r)
    if (!hit) throw new Error(t('Conexão "{ref}" não encontrada. Disponíveis: {list}', { ref, list: list.map((c) => `"${c.name}" (${c.id})`).join(', ') || t('nenhuma') }))
    return hit
  }

  async configOf(id) {
    if (id === 'active') {
      if (!this.active) throw new Error(t('Nenhuma conexão aberta no Graphite'))
      return this.active.config
    }
    const n = Number(id.split(':')[1])
    const c = (await this.util.call('app/connections')).find((x) => x.id === n)
    if (!c) throw new Error(t('Conexão salva não encontrada'))
    // Without a saved password the connection only works if the server needs none.
    const ssh = c.config.ssh && { ...c.config.ssh, secret: c.config.ssh.secretEnc ? this.decrypt(c.config.ssh.secretEnc) : '' }
    if (ssh) delete ssh.secretEnc
    return { ...c.config, type: c.type, ...(c.type !== 'sqlite' && { password: c.password ? this.decrypt(c.password) : '' }), ...(ssh && { ssh }) }
  }

  async session(conn) {
    const cached = this.sessions.get(conn.id)
    if (cached) {
      cached.lastUsed = Date.now()
      return cached
    }
    if (this.opening.has(conn.id)) return this.opening.get(conn.id)
    const p = (async () => {
      const config = await this.configOf(conn.id)
      const info = await this.util.call('conn/open', { config, autoCommit: true })
      // server: e.g. "CockroachDB v24.3.5" — tells the agent which SQL flavor to write.
      const s = { sId: info.sId, dialect: info.dialect, server: info.version, name: conn.name, readOnly: !!config.readOnly, schema: info.schema, lastUsed: Date.now() }
      this.sessions.set(conn.id, s)
      return s
    })()
    this.opening.set(conn.id, p)
    try {
      return await p
    } finally {
      this.opening.delete(conn.id)
    }
  }

  closeSession(id) {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    this.util.call('conn/close', { sId: s.sId }).catch(() => {})
  }

  closeIdle() {
    const now = Date.now()
    for (const [id, s] of this.sessions) if (now - s.lastUsed > IDLE_MS) this.closeSession(id)
  }

  // Agent sessions are dedicated, so switching their schema is harmless.
  async useSchema(s, schema) {
    if (!schema || s.dialect === 'sqlite' || schema === s.schema) return
    const r = await this.util.call('conn/useSchema', { sId: s.sId, schema })
    s.schema = r.schema
  }

  // --- approvals --------------------------------------------------------------

  // Resolves true when the user approves in the window. The main process
  // forwards 'approval' events to a window and calls decide().
  requestApproval(request) {
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(id, false, t('tempo esgotado')), APPROVAL_TIMEOUT_MS)
      this.approvals.set(id, { resolve, timer, request: { id, ...request, at: Date.now() } })
      this.emit('approval', this.approvals.get(id).request)
    })
  }

  decide(id, ok, reason) {
    const a = this.approvals.get(id)
    if (!a) return false
    this.approvals.delete(id)
    clearTimeout(a.timer)
    this.emit('approvalDone', { id, ok, reason })
    a.resolve({ ok: !!ok, reason })
    return true
  }

  pendingApprovals() {
    return [...this.approvals.values()].map((a) => a.request)
  }

  // --- activity log -------------------------------------------------------------

  log(entry) {
    const e = { id: crypto.randomUUID(), at: Date.now(), ...entry }
    this.activity.unshift(e)
    this.activity.length = Math.min(this.activity.length, 200)
    this.emit('activity', e)
    return e
  }

  updateLog(e, patch) {
    Object.assign(e, patch)
    this.emit('activity', e)
  }

  // --- tools ----------------------------------------------------------------------

  get tools() {
    return TOOLS
  }

  // ctx.source: who is asking ("Claude Code", "Assistente"…), shown in the
  // approval dialog and the activity log. Returns { text, isError, status }
  // (status: ok | approved | rejected | error).
  async callTool(name, input = {}, ctx = {}) {
    const tool = TOOLS.find((x) => x.name === name)
    if (!tool) return { text: t('Ferramenta desconhecida: {name}', { name }), isError: true }
    const invalid = validate(tool, input)
    if (invalid) return { text: t('Entrada inválida para {name}: {error}', { name, error: invalid }), isError: true }
    const entry = this.log({ source: ctx.source || t('Agente'), tool: name, connection: input.connection || null, sql: input.sql || null, status: 'running' })
    const t0 = Date.now()
    try {
      const out = await this[`tool_${name}`](input, ctx, entry)
      const text = clip(typeof out === 'string' ? out : JSON.stringify(out, null, 1))
      if (entry.status === 'running') this.updateLog(entry, { status: 'ok' })
      this.updateLog(entry, { ms: Date.now() - t0 })
      return { text, isError: entry.status === 'error', status: entry.status }
    } catch (e) {
      this.updateLog(entry, { status: 'error', detail: e.message, ms: Date.now() - t0 })
      return { text: t('Erro: {message}', { message: e.message }), isError: true, status: 'error' }
    }
  }

  async tool_list_connections() {
    const list = await this.listConnections()
    if (!list.length) return 'No connections. The user needs to open or save a connection in Graphite.'
    return list
  }

  async tool_list_schemas({ connection }, ctx, entry) {
    const conn = await this.resolve(connection)
    this.updateLog(entry, { connection: conn.name })
    const s = await this.session(conn)
    if (s.dialect === 'sqlite') return ['main']
    return this.util.call('conn/listSchemas', { sId: s.sId })
  }

  async tool_list_tables({ connection, schema }, ctx, entry) {
    const conn = await this.resolve(connection)
    this.updateLog(entry, { connection: conn.name })
    const s = await this.session(conn)
    const tables = await this.util.call('conn/listTables', { sId: s.sId, schema: schema ?? s.schema ?? null })
    return { connection: conn.name, dialect: s.dialect, server: s.server, schema: schema ?? s.schema ?? null, tables: tables.map((x) => `${x.type === 'view' ? 'view' : 'table'} ${x.name}`) }
  }

  async tool_describe_table({ connection, table, schema }, ctx, entry) {
    const conn = await this.resolve(connection)
    this.updateLog(entry, { connection: conn.name })
    const s = await this.session(conn)
    const args = { sId: s.sId, table, schema: schema ?? s.schema ?? undefined }
    const [columns, indexes, ddl] = await Promise.all([
      this.util.call('conn/listColumns', args),
      this.util.call('conn/listIndexes', args).catch(() => []),
      this.util.call('conn/createScript', args).catch(() => ''),
    ])
    if (!columns.length) throw new Error(args.schema ? t('Tabela "{table}" não encontrada em {schema}', { table, schema: args.schema }) : t('Tabela "{table}" não encontrada', { table }))
    return {
      table,
      schema: args.schema ?? null,
      dialect: s.dialect,
      server: s.server,
      columns: columns.map((c) => ({
        name: c.name, type: c.type, nullable: !!c.nullable,
        ...(c.default != null && { default: c.default }),
        ...(c.primary && { primary_key: true }),
        ...(c.auto && { generated_by_database: true }),
        ...(c.references && { references: (c.refSchema ? c.refSchema + '.' : '') + c.references }),
      })),
      indexes,
      ddl,
    }
  }

  async tool_get_schema({ connection, schema }, ctx, entry) {
    const conn = await this.resolve(connection)
    this.updateLog(entry, { connection: conn.name })
    const s = await this.session(conn)
    await this.useSchema(s, schema)
    const model = await this.util.call('er/model', { sId: s.sId })
    const fk = new Map()
    for (const r of model.relations) fk.set(r.from.table, [...(fk.get(r.from.table) || []), r])
    const lines = [`-- ${conn.name} · ${s.server || s.dialect}${model.schema ? ' · schema ' + model.schema : ''} · ${model.tables.length} tables`]
    for (const tb of model.tables) {
      const cols = tb.columns.map((c) => `${c.name} ${c.type}${c.primary ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}`).join(', ')
      lines.push(`${tb.type === 'view' ? 'view' : 'table'} ${tb.name} (${cols})`)
      for (const r of fk.get(tb.name) || []) lines.push(`  FK (${r.from.columns.join(', ')}) → ${r.to.table}(${r.to.columns.join(', ')})`)
    }
    return lines.join('\n')
  }

  async tool_run_query({ connection, sql, max_rows }, ctx, entry) {
    const conn = await this.resolve(connection)
    this.updateLog(entry, { connection: conn.name })
    const s = await this.session(conn)
    let r = await this.util.call('ai/query', { sId: s.sId, sql, mode: 'read', maxRows: max_rows ?? 200 })
    if (r.needsApproval) {
      const writes = r.statements.filter((st) => !st.read)
      if (s.readOnly) {
        this.updateLog(entry, { status: 'rejected', detail: t('conexão somente leitura') })
        return 'Rejected: this connection is open as read-only in Graphite. Nothing was run.'
      }
      this.updateLog(entry, { status: 'pending' })
      const decision = await this.requestApproval({
        source: ctx.source || t('Agente'),
        connection: conn.name,
        dialect: s.dialect,
        statements: r.statements,
        reason: writes.map((w) => w.why).join('; '),
      })
      if (!decision.ok) {
        this.updateLog(entry, { status: 'rejected', detail: decision.reason || t('recusado pelo usuário') })
        return `The user REJECTED running this in Graphite${decision.reason ? ` (${decision.reason})` : ''}. Nothing was run. Do not try again without asking the user.`
      }
      this.updateLog(entry, { status: 'approved' })
      r = await this.util.call('ai/query', { sId: s.sId, sql, mode: 'write', maxRows: max_rows ?? 200 })
    }
    if (r.failed) this.updateLog(entry, { status: 'error', detail: r.results.find((x) => x.error)?.error })
    return formatResults(r, s.dialect)
  }
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]))
}

function describe(id, name, type, config, active) {
  const where = type === 'sqlite' ? config.file : `${config.host || 'localhost'}${config.port ? ':' + config.port : ''}${config.database ? '/' + config.database : ''}`
  return { id, name, type, where, active, ...(config.readOnly && { readOnly: true }) }
}

function clip(text) {
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + `\n… (result cut at ${MAX_RESULT_CHARS} characters; use LIMIT or select fewer columns)` : text
}

function formatResults(r, dialect) {
  const parts = []
  r.results.forEach((x, i) => {
    const head = `[${i + 1}] ${x.command || 'SQL'}`
    if (x.error) parts.push(`${head} — ERROR: ${x.error}`)
    else if (x.columns) {
      const rows = x.rows.map((row) => Object.fromEntries(x.columns.map((c, j) => [c, row[j]])))
      parts.push(`${head} — ${x.truncated ? `more than ${x.rows.length} rows (showing ${x.rows.length}; narrow it with LIMIT/WHERE)` : `${x.rows.length} row(s)`} · ${x.ms} ms\n${JSON.stringify(rows)}`)
    } else parts.push(`${head} — ${x.affected} row(s) affected · ${x.ms} ms`)
  })
  if (r.failed) parts.push(r.rolledBack ? (dialect === 'mysql' ? 'The script was rolled back (except DDL, which MySQL commits immediately).' : 'The whole script was rolled back.') : 'Execution stopped at the error.')
  return parts.join('\n\n')
}

module.exports = { AiHub, keyId, UtilBridge }
