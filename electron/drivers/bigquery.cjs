// Google BigQuery through its REST API (jobs.query / getQueryResults), with a
// service account key (JSON file). No dependency: the OAuth JWT is signed
// here with node:crypto.
//
// - "Database" is the project; the picker lists its datasets.
// - Values: INT64 back to numbers when exact, NUMERIC/BIGNUMERIC as exact
//   text, TIMESTAMP (seconds) as UTC text, RECORD / REPEATED as JSON.
// - No interactive transactions across requests: read-only grid, no manual mode.
// - AI: BigQuery has no read-only mode to rely on, so every AI query needs approval.
// - config.endpoint points the client at an emulator (e.g. bigquery-emulator).
// Beta: written against Google's documentation; tested with the open-source emulator.
const fs = require('node:fs')
const { createSign } = require('node:crypto')
const { normaliseRows, erFrom, commandOf } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

const API = 'https://bigquery.googleapis.com/bigquery/v2'
const SCOPE = 'https://www.googleapis.com/auth/bigquery'
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const pad = (n, w = 2) => String(n).padStart(w, '0')

const literal = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)

// One cell of the REST "f/v" row format, by schema field.
function convert(cell, field) {
  const v = cell?.v
  if (v === null || v === undefined) return null
  if (field.mode === 'REPEATED') return v.map((x) => convert(x, { ...field, mode: 'NULLABLE' }))
  switch (field.type) {
    case 'INTEGER':
    case 'INT64':
      return /^-?\d{1,15}$/.test(v) ? Number(v) : v
    case 'FLOAT':
    case 'FLOAT64':
      return Number(v)
    case 'BOOLEAN':
    case 'BOOL':
      return v === 'true'
    case 'TIMESTAMP': {
      // Seconds since the epoch, possibly in scientific notation.
      const ms = Math.round(Number(v) * 1e6) / 1e3
      const d = new Date(ms)
      const frac = d.getUTCMilliseconds()
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac ? '.' + pad(frac, 3) : ''} UTC`
    }
    case 'RECORD':
    case 'STRUCT':
      return Object.fromEntries((field.fields || []).map((f, i) => [f.name, convert(v.f[i], f)]))
    default:
      return v // STRING, NUMERIC, BIGNUMERIC, DATE, DATETIME, TIME, BYTES (base64), JSON, GEOGRAPHY
  }
}

class BigqueryDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'bigquery'
    this.token = null
    this.timeoutMs = 0
  }

  quote(id) {
    return '`' + String(id).replace(/`/g, '\\`') + '`'
  }

  // Values are inlined as literals.
  placeholder(i) {
    return `{{p${i}}}`
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  get api() {
    return (this.config.endpoint || '').trim().replace(/\/+$/, '') || API
  }

  async accessToken() {
    if (this.config.endpoint && !this.key) return 'emulator'
    if (this.token && this.token.expires > Date.now() + 60000) return this.token.value
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = b64url(JSON.stringify({ iss: this.key.client_email, scope: SCOPE, aud: this.key.token_uri, iat: now, exp: now + 3600 }))
    const signature = b64url(createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.key.private_key))
    const res = await fetch(this.key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(t('Falha ao autenticar no Google: {error}', { error: body.error_description || body.error || res.status }))
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 }
    return this.token.value
  }

  async call(path, init = {}) {
    const res = await fetch(this.api + path, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error?.message || `BigQuery ${res.status}`)
    return body
  }

  bind(sql, params) {
    return params.length ? sql.replace(/\{\{p(\d+)\}\}/g, (m, i) => literal(params[Number(i) - 1])) : sql
  }

  // Runs a query job and pages through its results.
  async run(sql, { onPage } = {}) {
    const p = encodeURIComponent(this.project)
    let body = await this.call(`/projects/${p}/queries`, {
      method: 'POST',
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        maxResults: 10000,
        timeoutMs: 60000,
        ...(this.dataset && { defaultDataset: { projectId: this.project, datasetId: this.dataset } }),
        ...(this.config.location && { location: this.config.location }),
      }),
    })
    const job = body.jobReference || {}
    const qs = (token) => `?maxResults=10000&timeoutMs=60000${job.location ? `&location=${encodeURIComponent(job.location)}` : ''}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    while (!body.jobComplete) body = await this.call(`/projects/${p}/queries/${encodeURIComponent(job.jobId)}${qs()}`)
    const fields = body.schema?.fields || []
    let stop = false
    for (;;) {
      const rows = (body.rows || []).map((r) => r.f.map((cell, i) => convert(cell, fields[i])))
      if (onPage && (await onPage(fields, rows)) === false) stop = true
      if (stop || !body.pageToken) break
      body = await this.call(`/projects/${p}/queries/${encodeURIComponent(job.jobId)}${qs(body.pageToken)}`)
    }
    return { fields, affected: body.numDmlAffectedRows, statementType: body.statementType }
  }

  async connect() {
    const c = this.config
    if (c.keyFile) {
      this.key = JSON.parse(fs.readFileSync(c.keyFile, 'utf8'))
      if (!this.key.client_email || !this.key.private_key) throw new Error(t('O arquivo não é uma chave de conta de serviço do Google'))
      this.key.token_uri ||= 'https://oauth2.googleapis.com/token'
    } else if (!c.endpoint) {
      throw new Error(t('Escolha o arquivo JSON da conta de serviço'))
    }
    this.project = c.project || this.key?.project_id
    if (!this.project) throw new Error(t('Informe o ID do projeto'))
    this.dataset = c.database || undefined
    await this.run('select 1')
  }

  async disconnect() {}

  async execute(text, params = [], opts = {}) {
    const sql = this.bind(text, params).trim().replace(/[\s;]+$/, '')
    const rows = []
    const r = await this.run(sql, { onPage: (f, data) => { rows.push(...data) } })
    const cmd = commandOf(sql)
    if (!r.fields.length || ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(cmd)) return { affected: Number(r.affected ?? 0) }
    const fields = r.fields.map((f) => f.name)
    if (opts.raw) return { fields, rows }
    const out = normaliseRows(rows, fields)
    return opts.origins ? { fields, rows: out, origins: fields.map(() => null), binary: [] } : { fields, rows: out }
  }

  async query(sql) {
    const r = await this.execute(sql, [], { raw: true })
    return (r.rows || []).map((row) => Object.fromEntries(r.fields.map((f, i) => [f, row[i]])))
  }

  async *stream(sql, { batch = 1000, raw } = {}) {
    const all = []
    let fields = []
    await this.run(sql.trim().replace(/[\s;]+$/, ''), { onPage: (f, data) => { fields = f.map((x) => x.name); all.push(...data) } })
    for (let i = 0; i < all.length || i === 0; i += batch) {
      const rows = all.slice(i, i + batch)
      yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
      if (!all.length) break
    }
  }

  async firstRows(sql, limit) {
    const rows = []
    let fields = []
    await this.run(sql.trim().replace(/[\s;]+$/, ''), {
      onPage: (f, data) => {
        fields = f.map((x) => x.name)
        rows.push(...data)
        return rows.length <= limit
      },
    })
    return { fields, rows: normaliseRows(rows.slice(0, limit + 1), fields) }
  }

  async transaction(fn) {
    return fn()
  }

  async readOnly(fn, timeoutMs) {
    this.timeoutMs = timeoutMs
    try {
      return await fn()
    } finally {
      this.timeoutMs = 0
    }
  }

  async version() {
    return 'BigQuery' + (this.config.endpoint ? ' (emulator)' : '')
  }

  async database() {
    return this.project
  }

  // --- catalog: the picker lists datasets ------------------------------------------

  async listSchemas() {
    const out = []
    let token = ''
    do {
      const r = await this.call(`/projects/${encodeURIComponent(this.project)}/datasets?maxResults=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`)
      for (const d of r.datasets || []) out.push({ name: d.datasetReference.datasetId, system: false })
      token = r.nextPageToken
    } while (token)
    return out
  }

  async currentSchema() {
    return this.dataset || null
  }

  async useSchema(name) {
    this.dataset = name
  }

  async listTables(schema) {
    const ds = schema ?? this.dataset
    if (!ds) return []
    const out = []
    let token = ''
    do {
      const r = await this.call(`/projects/${encodeURIComponent(this.project)}/datasets/${encodeURIComponent(ds)}/tables?maxResults=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`)
      for (const tb of r.tables || []) out.push({ name: tb.tableReference.tableId, schema: ds, type: /VIEW/.test(tb.type) ? 'view' : 'table' })
      token = r.nextPageToken
    } while (token)
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  }

  async tableMeta(table, schema) {
    const ds = schema ?? this.dataset
    return this.call(`/projects/${encodeURIComponent(this.project)}/datasets/${encodeURIComponent(ds)}/tables/${encodeURIComponent(table)}`)
  }

  async listColumns(table, schema) {
    const meta = await this.tableMeta(table, schema)
    const pk = new Set(meta.tableConstraints?.primaryKey?.columns || [])
    const refs = new Map()
    for (const fk of meta.tableConstraints?.foreignKeys || []) {
      for (const c of fk.columnReferences || []) refs.set(c.referencingColumn, { table: fk.referencedTable.tableId, schema: fk.referencedTable.datasetId, column: c.referencedColumn })
    }
    return (meta.schema?.fields || []).map((f) => ({
      name: f.name,
      type: f.mode === 'REPEATED' ? `ARRAY<${f.type}>` : f.type,
      nullable: f.mode !== 'REQUIRED',
      default: f.defaultValueExpression ?? null,
      primary: pk.has(f.name),
      auto: false,
      references: refs.has(f.name) ? `${refs.get(f.name).table}(${refs.get(f.name).column})` : null,
      refSchema: refs.get(f.name)?.schema ?? null,
    }))
  }

  async schemaMap() {
    const map = {}
    for (const tb of await this.listTables()) map[tb.name] = (await this.listColumns(tb.name).catch(() => [])).map((c) => c.name)
    return map
  }

  async listIndexes() {
    return []
  }

  async createScript(table, schema) {
    const ds = schema ?? this.dataset
    const r = await this.query(`select ddl from ${this.quote(this.project)}.${this.quote(ds)}.INFORMATION_SCHEMA.TABLES where table_name = ${literal(table)}`).catch(() => [])
    if (r[0]?.ddl) return String(r[0].ddl).trim()
    const cols = await this.listColumns(table, ds)
    return `CREATE TABLE ${this.quote(ds)}.${this.quote(table)} (\n${cols.map((c) => `  ${this.quote(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(',\n')}\n);`
  }

  async erModel(schema) {
    const ds = schema ?? this.dataset
    const cols = []
    const fks = []
    for (const tb of await this.listTables(ds)) {
      const list = await this.listColumns(tb.name, ds).catch(() => [])
      for (const c of list) cols.push({ table: tb.name, kind: tb.type, ...c })
      for (const c of list.filter((x) => x.references)) {
        const [, refTable, refCol] = /^(.*)\((.*)\)$/.exec(c.references)
        fks.push({ name: `fk_${tb.name}_${c.name}`, table: tb.name, columns: [c.name], refSchema: c.refSchema, refTable, refColumns: [refCol] })
      }
    }
    return erFrom(ds, cols, fks)
  }
}

module.exports = BigqueryDriver
