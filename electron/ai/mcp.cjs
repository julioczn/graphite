// MCP server (Streamable HTTP) exposing the AI hub's tools to external agents:
// Claude Code, Claude Desktop (via mcp-remote), Cursor, VS Code…
//
// Only reachable from this machine and only with the token:
//  - listens on 127.0.0.1;
//  - rejects any Host other than 127.0.0.1/localhost:<port> and any request
//    carrying an Origin (a web page trying to reach the local server through
//    DNS rebinding or a cross-site request);
//  - requires `Authorization: Bearer <token>` (compared in constant time).
const http = require('node:http')
const crypto = require('node:crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js')
const { z } = require('zod')
const { t } = require('../../shared/i18n.mjs')

const MAX_BODY = 4 * 1024 * 1024

const INSTRUCTIONS = [
  'Graphite is a SQL client (PostgreSQL, MySQL/MariaDB, SQLite) open on the user\'s computer.',
  'Start with list_connections; then get_schema or describe_table before writing SQL.',
  'run_query runs reads directly (read-only mode enforced by the database, 30 s timeout).',
  'Any write (INSERT/UPDATE/DELETE/DDL) is shown to the user to approve in Graphite; if they reject it, don\'t insist.',
  'Use the connection\'s SQL dialect (given in the responses).',
].join(' ')

// JSON Schema (hub's tool definitions) → zod raw shape for the MCP SDK.
function zodShape(schema) {
  const shape = {}
  const required = new Set(schema.required || [])
  for (const [k, p] of Object.entries(schema.properties || {})) {
    let v = p.type === 'integer' ? z.number().int() : z.string()
    if (p.type === 'integer' && p.minimum != null) v = v.min(p.minimum)
    if (p.type === 'integer' && p.maximum != null) v = v.max(p.maximum)
    if (p.description) v = v.describe(p.description)
    shape[k] = required.has(k) ? v : v.optional()
  }
  return shape
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error(t('Corpo da requisição grande demais')), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error(t('JSON inválido')), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function fail(res, status, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

class McpHost {
  constructor(hub, version) {
    this.hub = hub
    this.version = version
    this.server = null
    this.transports = new Map() // session id -> { transport, client }
    this.state = { running: false, port: null, error: null }
  }

  status() {
    return {
      ...this.state,
      url: this.state.running ? `http://127.0.0.1:${this.state.port}/mcp` : null,
      clients: [...new Set([...this.transports.values()].map((t) => t.client).filter(Boolean))],
    }
  }

  buildServer(entry) {
    const server = new McpServer({ name: 'graphite', title: 'Graphite', version: this.version }, { instructions: INSTRUCTIONS })
    for (const tool of this.hub.tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: zodShape(tool.schema),
          annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, openWorldHint: false },
        },
        async (args) => {
          const client = server.server.getClientVersion()
          entry.client = client?.title || client?.name || entry.client
          const r = await this.hub.callTool(tool.name, args || {}, { source: entry.client ? `MCP · ${entry.client}` : 'MCP' })
          return { content: [{ type: 'text', text: r.text }], isError: r.isError }
        },
      )
    }
    return server
  }

  async handle(req, res, { port, token }) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/mcp') return fail(res, 404, 'Use /mcp')
    const host = String(req.headers.host || '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return fail(res, 403, t('Host não permitido'))
    if (req.headers.origin) return fail(res, 403, t('Requisições de navegador não são permitidas'))
    const auth = String(req.headers.authorization || '')
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) {
      return fail(res, 401, t('Token inválido. Copie a configuração em Graphite → AI → Agentes externos.'), { 'www-authenticate': 'Bearer' })
    }

    const body = req.method === 'POST' ? await readBody(req) : undefined
    const sid = req.headers['mcp-session-id']
    const known = sid && this.transports.get(sid)
    if (known) return known.transport.handleRequest(req, res, body)
    if (sid) return fail(res, 404, t('Sessão MCP desconhecida (o Graphite pode ter reiniciado); reconecte'))
    if (req.method !== 'POST' || !isInitializeRequest(body)) return fail(res, 400, t('Comece com uma requisição initialize'))

    const entry = { transport: null, client: body.params?.clientInfo?.title || body.params?.clientInfo?.name || null }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.transports.set(id, entry)
        this.hub.emit('mcp', this.status())
      },
    })
    entry.transport = transport
    transport.onclose = () => {
      if (transport.sessionId) this.transports.delete(transport.sessionId)
      this.hub.emit('mcp', this.status())
    }
    await this.buildServer(entry).connect(transport)
    return transport.handleRequest(req, res, body)
  }

  async start({ port, token }) {
    await this.stop()
    const server = http.createServer((req, res) => {
      this.handle(req, res, { port, token }).catch((e) => {
        if (!res.headersSent) fail(res, e.status || 500, e.message)
        else res.end()
      })
    })
    await new Promise((resolve) => {
      server.once('error', (e) => {
        this.state = { running: false, port, error: e.code === 'EADDRINUSE' ? t('A porta {port} já está em uso', { port: String(port) }) : e.message }
        resolve()
      })
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        this.state = { running: true, port, error: null }
        resolve()
      })
    })
    this.hub.emit('mcp', this.status())
    return this.status()
  }

  async stop() {
    for (const { transport } of this.transports.values()) await transport.close().catch(() => {})
    this.transports.clear()
    if (this.server) {
      const s = this.server
      this.server = null
      await new Promise((resolve) => {
        s.close(() => resolve())
        s.closeAllConnections?.()
      })
    }
    this.state = { running: false, port: this.state.port, error: null }
    this.hub.emit('mcp', this.status())
  }
}

module.exports = { McpHost }
