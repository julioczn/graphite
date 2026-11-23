// Connection strings → connection form fields ("Import from URL").
//
// Understands the URLs people copy from cloud consoles, .env files and docs:
//   postgres://, mysql://, mariadb://, sqlserver://, oracle://, redis(s)://,
//   mongodb(+srv)://, clickhouse://, trino://, cassandra://, snowflake://,
//   libsql://, ws(s):// (SurrealDB), sqlite:///path, duckdb:///path
// plus a "jdbc:" prefix, SQLAlchemy driver suffixes (postgresql+psycopg://),
// JDBC SQL Server / Oracle thin syntax, libpq "host=… dbname=…" and ADO.NET
// "Server=…;Database=…" strings.
//
// Returns { type, fields, ignored }: `fields` uses the form's keys (host,
// port, user, password, database, ssl, sslMode, sslCa, sslCert, sslKey, file,
// url, extra) and `ignored` lists the parameters Graphite has no field for.
// Credentials never stay inside a stored URL: they move to user/password,
// which the form saves encrypted.
import { engineOf } from './engines.mjs'

// Error messages are pt-BR source keys; the UI translates them (e.i18n).
const t = (key, params) => ({ key, params })
const fail = (msg) => Object.assign(new Error(msg.key), { i18n: msg })

const SCHEMES = {
  postgres: 'postgres', postgresql: 'postgres', pgsql: 'postgres', pg: 'postgres',
  cockroachdb: 'cockroachdb', cockroach: 'cockroachdb', redshift: 'redshift', greengage: 'greengage',
  mysql: 'mysql', mysql2: 'mysql', mariadb: 'mariadb', tidb: 'tidb', starrocks: 'starrocks',
  sqlserver: 'sqlserver', mssql: 'sqlserver',
  oracle: 'oracle',
  firebird: 'firebird', firebirdsql: 'firebird',
  clickhouse: 'clickhouse', clickhouses: 'clickhouse',
  trino: 'trino', presto: 'trino',
  redis: 'redis', rediss: 'redis', valkey: 'redis', valkeys: 'redis',
  mongodb: 'mongodb',
  cassandra: 'cassandra', scylla: 'scylladb', scylladb: 'scylladb',
  snowflake: 'snowflake',
  libsql: 'libsql',
  surrealdb: 'surrealdb', ws: 'surrealdb', wss: 'surrealdb',
  sqlite: 'sqlite', sqlite3: 'sqlite', file: 'sqlite',
  duckdb: 'duckdb',
}

const dec = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const truthy = (v) => /^(1|true|yes|on|required?)$/i.test(String(v))

// Remembers which query parameters were used, to report the rest.
function params(search) {
  const map = new Map()
  for (const [k, v] of new URLSearchParams(search)) map.set(k.toLowerCase(), { name: k, value: v })
  const used = new Set()
  return {
    take(...names) {
      for (const n of names) {
        const p = map.get(n.toLowerCase())
        if (p) {
          used.add(n.toLowerCase())
          return p.value
        }
      }
      return undefined
    },
    rest: () => [...map.entries()].filter(([k]) => !used.has(k)).map(([, p]) => p.name),
  }
}

// postgres://u:p@h:5432/db → its parts (any scheme, IPv6 hosts in brackets).
function split(text) {
  let u
  try {
    u = new URL(text)
  } catch {
    throw fail(t('URL inválida. Exemplo: postgres://usuário:senha@host:5432/banco'))
  }
  return {
    url: u,
    host: dec(u.hostname).replace(/^\[(.*)\]$/, '$1'),
    port: u.port,
    user: dec(u.username),
    password: dec(u.password),
    path: dec(u.pathname.replace(/^\//, '')),
    q: params(u.search),
  }
}

// --- TLS parameters ------------------------------------------------------------

// libpq sslmode → { ssl, sslMode }.
function pgTls(q, f) {
  const mode = q.take('sslmode')
  if (mode != null) {
    const m = mode.toLowerCase()
    if (['disable', 'allow', 'prefer'].includes(m)) f.ssl = false
    else if (['require', 'verify-ca', 'verify-full'].includes(m)) Object.assign(f, { ssl: true, sslMode: m })
  }
  const ssl = q.take('ssl')
  if (ssl != null && mode == null) Object.assign(f, truthy(ssl) ? { ssl: true, sslMode: 'verify-full' } : { ssl: false })
  files(q, f, ['sslrootcert'], ['sslcert'], ['sslkey'])
}

// MySQL ssl-mode / ssl / tls (Go driver) → { ssl, sslMode }.
function myTls(q, f) {
  const mode = q.take('ssl-mode', 'sslmode', 'ssl_mode')
  if (mode != null) {
    const m = mode.toUpperCase().replace(/-/g, '_')
    if (['DISABLED', 'PREFERRED', 'DISABLE', 'PREFER'].includes(m)) f.ssl = false
    else if (['REQUIRED', 'REQUIRE'].includes(m)) Object.assign(f, { ssl: true, sslMode: 'require' })
    else if (m === 'VERIFY_CA') Object.assign(f, { ssl: true, sslMode: 'verify-ca' })
    else if (['VERIFY_IDENTITY', 'VERIFY_FULL'].includes(m)) Object.assign(f, { ssl: true, sslMode: 'verify-full' })
  }
  const ssl = q.take('ssl', 'tls', 'usessl')
  if (ssl != null && mode == null) {
    // PlanetScale style: ssl={"rejectUnauthorized":true}; Go: tls=skip-verify.
    if (/rejectunauthorized"?\s*:\s*false/i.test(ssl) || /^skip-verify$/i.test(ssl)) Object.assign(f, { ssl: true, sslMode: 'require' })
    else if (/^\{|^(1|true|yes|on|required?|preferred)$/i.test(ssl)) Object.assign(f, { ssl: true, sslMode: 'verify-full' })
    else f.ssl = false
  }
  // Prisma: sslaccept=strict | accept_invalid_certs
  const accept = q.take('sslaccept')
  if (accept != null && mode == null && ssl == null) Object.assign(f, { ssl: true, sslMode: /^strict$/i.test(accept) ? 'verify-full' : 'require' })
  files(q, f, ['ssl-ca', 'sslca', 'ssl_ca', 'sslcert'], ['ssl-cert', 'ssl_cert'], ['ssl-key', 'sslkey', 'ssl_key'])
}

function files(q, f, ca, cert, key) {
  const c = q.take(...ca)
  if (c && c !== 'system') f.sslCa = c
  const ce = q.take(...cert)
  if (ce) f.sslCert = ce
  const k = q.take(...key)
  if (k) f.sslKey = k
}

// --- per family -------------------------------------------------------------------

function server(type, p, extra = () => {}) {
  const f = {}
  if (p.host) f.host = p.host
  if (p.port) f.port = p.port
  const user = p.user || p.q.take('user', 'username')
  const password = p.password || p.q.take('password')
  if (user) f.user = user
  if (password) f.password = password
  if (p.path) f.database = p.path
  extra(f, p.q)
  return { type, fields: f, ignored: p.q.rest() }
}

// SQL Server: "sqlserver://host[\inst][:port];databaseName=db;user=u;password=p;encrypt=true"
// or ADO.NET "Server=tcp:host,1433;Initial Catalog=db;User ID=u;Password=p;Encrypt=True".
function mssqlPairs(pairs, base = {}) {
  const f = { ...base }
  const ignored = []
  let encrypt
  let trust
  for (const [rawK, v] of pairs) {
    const k = rawK.toLowerCase().replace(/\s+/g, '')
    if (['server', 'datasource', 'address', 'addr', 'networkaddress'].includes(k)) {
      const m = /^(?:tcp:)?([^,\\:]+)(?:\\[^,]*)?(?:[,:](\d+))?$/i.exec(v.trim())
      if (m) Object.assign(f, { host: m[1] }, m[2] && { port: m[2] })
    } else if (k === 'port' || k === 'portnumber') f.port = v
    else if (['database', 'databasename', 'initialcatalog'].includes(k)) f.database = v
    else if (['user', 'userid', 'uid', 'username'].includes(k)) f.user = v
    else if (['password', 'pwd'].includes(k)) f.password = v
    else if (k === 'encrypt') encrypt = v
    else if (k === 'trustservercertificate') trust = v
    else ignored.push(rawK)
  }
  if (encrypt != null) {
    if (/^(true|yes|mandatory|strict|1)$/i.test(encrypt)) Object.assign(f, { ssl: true, sslMode: truthy(trust) ? 'require' : 'verify-full' })
    else f.ssl = false
  }
  return { type: 'sqlserver', fields: f, ignored }
}

// "a=1;b={x;y};c='z'" → [[a,1],[b,x;y],[c,z]]: braces and quotes may hold the separator.
function kv(s, sep) {
  const parts = []
  let cur = ''
  let close = null
  for (const ch of s) {
    if (close) {
      if (ch === close) close = null
      cur += ch
    } else if (ch === '{') (close = '}'), (cur += ch)
    else if (ch === "'" || ch === '"') (close = ch), (cur += ch)
    else if (ch === sep) parts.push(cur), (cur = '')
    else cur += ch
  }
  parts.push(cur)
  return parts.map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf('=')
    return i < 0 ? [x, ''] : [x.slice(0, i).trim(), x.slice(i + 1).trim().replace(/^\{(.*)\}$|^'(.*)'$|^"(.*)"$/, '$1$2$3')]
  })
}

// libpq: host=h port=5432 dbname=db user=u password='p q' sslmode=require
function libpq(text) {
  const pairs = [...text.matchAll(/(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S+))/g)].map((m) => [m[1], m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3]])
  const f = {}
  const q = new URLSearchParams()
  const ignored = []
  for (const [k, v] of pairs) {
    const key = k.toLowerCase()
    if (key === 'host' || key === 'hostaddr') f.host = v
    else if (key === 'port') f.port = v
    else if (key === 'dbname') f.database = v
    else if (key === 'user') f.user = v
    else if (key === 'password') f.password = v
    else if (/^ssl/.test(key)) q.set(key, v)
    else ignored.push(k)
  }
  const p = params(q.toString())
  pgTls(p, f)
  return { type: 'postgres', fields: f, ignored: [...ignored, ...p.rest()] }
}

// jdbc:oracle:thin:[user/pass]@[//]host[:port][/service | :SID]
function oracleThin(rest) {
  const m = /^thin:(?:([^/@]*)\/([^@]*))?@(?:(tcps?):\/\/|\/\/)?([^:/]+)(?::(\d+))?(?:[/:](.+))?$/i.exec(rest)
  if (!m) throw fail(t('Formato JDBC do Oracle não reconhecido. Use host:porta/serviço.'))
  const f = { host: m[4] }
  if (m[1]) f.user = m[1]
  if (m[2]) f.password = m[2]
  if (m[5]) f.port = m[5]
  if (m[6]) f.database = m[6]
  if (m[3]?.toLowerCase() === 'tcps') Object.assign(f, { ssl: true, sslMode: 'verify-full' })
  return { type: 'oracle', fields: f, ignored: [] }
}

function filePath(text) {
  // sqlite:///abs/path, sqlite:relative.db, file:///abs/path, file:/abs/path
  const rest = text.replace(/^[a-z0-9]+:/i, '').replace(/\?.*$/, '')
  return dec(rest.startsWith('//') ? rest.replace(/^\/\/[^/]*/, '') : rest)
}

// Pick the engine within a family: the one selected in the form if it's the
// same family, else a host hint (Redshift, CockroachDB Cloud, TiDB Cloud).
function refine(r, currentType) {
  const fam = engineOf(r.type)?.family
  const host = (r.fields.host || '').toLowerCase()
  if (fam === 'postgres') {
    if (/\.redshift(-serverless)?\.amazonaws\.com$/.test(host)) return { ...r, type: 'redshift' }
    if (/\.cockroachlabs\.cloud$/.test(host) || r.fields.port === '26257') return { ...r, type: 'cockroachdb' }
  }
  if (fam === 'mysql' && /\.tidbcloud\.com$/.test(host)) return { ...r, type: 'tidb' }
  const cur = engineOf(currentType)
  if (cur && cur.family === fam && r.generic) return { ...r, type: cur.id }
  return r
}

export function parseConnectionUrl(input, currentType) {
  let text = String(input || '').trim().replace(/^(['"])(.*)\1$/, '$2')
  if (!text) throw fail(t('Cole uma URL de conexão.'))
  // DATABASE_URL=postgres://… copied from a .env file.
  text = text.replace(/^[A-Z_][A-Z0-9_]*\s*=\s*/, '').replace(/^(['"])(.*)\1$/, '$2')
  text = text.replace(/^jdbc:/i, '')

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(text)
  if (!schemeMatch || !/^[a-z][a-z0-9+.-]*:\/\/|^(sqlite3?|duckdb|file|oracle|sqlserver):/i.test(text)) {
    // No scheme: key=value strings.
    if (/;/.test(text) && /=/.test(text)) return refine({ ...mssqlPairs(kv(text, ';')), generic: false }, currentType)
    if (/\b(host|dbname|user)\s*=/.test(text)) return refine({ ...libpq(text), generic: true }, currentType)
    throw fail(t('Formato de URL não reconhecido. Exemplo: postgres://usuário:senha@host:5432/banco'))
  }
  const full = schemeMatch[1].toLowerCase()
  const [base, driver] = full.split('+')
  const scheme = full === 'mongodb+srv' ? 'mongodb' : base
  const type = SCHEMES[scheme] || (scheme === 'http' || scheme === 'https' ? null : undefined)

  // https://my-db.turso.io → LibSQL; other http(s) URLs are ambiguous.
  if (type === null) {
    if (/^https?:\/\/[^/]*\.turso\.io/i.test(text)) return libsqlUrl(text)
    throw fail(t('URL http(s) ambígua: escolha o tipo de banco e cole a URL no campo do formulário.'))
  }
  if (type === undefined) throw fail(t('Esquema "{scheme}" não reconhecido.', { scheme: full }))

  const generic = ['postgres', 'postgresql', 'pgsql', 'pg', 'mysql', 'mysql2'].includes(base)
  let r
  switch (type) {
    case 'sqlite':
    case 'duckdb': {
      const file = filePath(text)
      if (!file) throw fail(t('A URL não tem o caminho do arquivo.'))
      // A .duckdb file is DuckDB even behind file: or sqlite:.
      return { type: /\.(duckdb|ddb)$/i.test(file) ? 'duckdb' : type, fields: { file }, ignored: [] }
    }
    case 'oracle':
      if (/^oracle:thin:/i.test(text)) return oracleThin(text.slice('oracle:'.length))
      r = server('oracle', split(text))
      break
    case 'sqlserver': {
      // JDBC: sqlserver://host:1433;databaseName=…;user=…
      const cut = text.indexOf(';')
      const p = split(cut < 0 ? text : text.slice(0, cut))
      const base = server('sqlserver', p)
      const extra = mssqlPairs(cut < 0 ? [] : kv(text.slice(cut + 1), ';'), base.fields)
      r = { type: 'sqlserver', fields: extra.fields, ignored: [...base.ignored, ...extra.ignored] }
      break
    }
    case 'mongodb':
      return mongoUrl(text)
    case 'libsql':
      return libsqlUrl(text)
    case 'surrealdb':
      return surrealUrl(text)
    case 'snowflake':
      return snowflakeUrl(text)
    case 'redis': {
      r = server('redis', split(text), (f, q) => {
        if (/^(rediss|valkeys)$/.test(scheme)) Object.assign(f, { ssl: true, sslMode: 'verify-full' })
        const db = q.take('db')
        if (db) f.database = db
        if (f.user === 'default' && !f.password) delete f.user
      })
      // redis://:password@host — no user.
      break
    }
    case 'clickhouse':
      r = server('clickhouse', split(text), (f, q) => {
        const secure = q.take('secure', 'ssl')
        if (scheme === 'clickhouses' || driver === 'https' || (secure != null && truthy(secure)) || f.port === '8443') Object.assign(f, { ssl: true, sslMode: 'verify-full' })
        const db = q.take('database')
        if (db) f.database = db
        // Native-protocol ports: Graphite speaks HTTP(S).
        if (f.port === '9000') f.port = '8123'
        if (f.port === '9440') f.port = '8443'
      })
      break
    case 'trino':
      r = server('trino', split(text), (f, q) => {
        if (f.database) f.database = f.database.split('/').filter(Boolean).join('.')
        const ssl = q.take('ssl')
        if (ssl != null && truthy(ssl)) Object.assign(f, { ssl: true, sslMode: 'verify-full' })
      })
      break
    case 'firebird':
      // firebird://host:3050//data/app.fdb → /data/app.fdb
      r = server('firebird', split(text))
      break
    case 'cassandra':
    case 'scylladb':
      r = server(type, split(text), (f, q) => {
        const ssl = q.take('ssl')
        if (ssl != null && truthy(ssl)) Object.assign(f, { ssl: true, sslMode: 'verify-full' })
      })
      break
    default: {
      const fam = engineOf(type)?.family
      r = server(type, split(text), (f, q) => (fam === 'postgres' ? pgTls(q, f) : fam === 'mysql' ? myTls(q, f) : null))
    }
  }
  return refine({ ...r, generic }, currentType)
}

function mongoUrl(text) {
  const p = split(text)
  const f = {}
  // Keep host list, path and options; credentials go to the encrypted fields.
  const u = new URL(text)
  u.username = ''
  u.password = ''
  const extra = { url: u.toString(), user: p.user || '', database: p.path || '' }
  if (p.password) f.password = p.password
  return { type: 'mongodb', fields: { ...f, extra }, ignored: [] }
}

function libsqlUrl(text) {
  const u = new URL(text)
  const token = u.searchParams.get('authToken') || u.searchParams.get('authtoken') || dec(u.password)
  u.searchParams.delete('authToken')
  u.searchParams.delete('authtoken')
  u.username = ''
  u.password = ''
  const f = { url: u.toString().replace(/\?$/, '').replace(/\/$/, '') }
  if (token) f.password = token
  return { type: 'libsql', fields: f, ignored: [] }
}

// ws://root:root@host:8000/rpc?ns=app&db=main (or …/ns/db)
function surrealUrl(text) {
  const p = split(text.replace(/^surrealdb:/i, 'ws:'))
  const u = new URL(p.url.toString())
  const [ns, db] = p.path.replace(/^rpc\/?/, '').split('/').filter(Boolean)
  const extra = {
    url: `${u.protocol}//${u.host}`,
    user: p.user || '',
    namespace: p.q.take('ns', 'namespace') || ns || '',
    database: p.q.take('db', 'database') || db || '',
  }
  const f = { extra }
  if (p.password) f.password = p.password
  return { type: 'surrealdb', fields: f, ignored: p.q.rest() }
}

// SQLAlchemy: snowflake://user:token@account/db/schema?warehouse=wh&role=r
function snowflakeUrl(text) {
  const p = split(text)
  const [db, schema] = p.path.split('/').filter(Boolean)
  const extra = {
    account: p.host.replace(/\.snowflakecomputing\.com$/i, ''),
    user: p.user || '',
    warehouse: p.q.take('warehouse') || '',
    role: p.q.take('role') || '',
    database: [db, schema].filter(Boolean).join('.'),
  }
  const f = { extra }
  if (p.password) f.password = p.password
  return { type: 'snowflake', fields: f, ignored: p.q.rest() }
}
