// Microsoft SQL Server / Azure SQL over TDS (tedious, pure JS).
//
// One connection per session, so transactions and USE persist between
// statements. Batches without parameters go through execSqlBatch (DDL, USE,
// multiple statements); parameterised ones through sp_executesql (@p1, @p2…).
//
// The schema picker switches the *database* (USE), like MySQL; tables are
// listed with their schema (dbo, sales…) and qualified as [schema].[table].
//
// AI reads: SQL Server has no read-only session mode, so reads run inside a
// transaction that is always rolled back (like LibSQL) — and classify() only
// lets SELECT / WITH through, refusing SELECT … INTO.
const { Connection, Request, TYPES } = require('tedious')
const { normaliseRows, erFrom } = require('../lib/sql.cjs')
const { tlsOptions, modeOf } = require('../lib/tls.cjs')

const SYSTEM_DBS = new Set(['master', 'tempdb', 'model', 'msdb'])

function paramType(v) {
  if (v === null || v === undefined) return TYPES.NVarChar
  if (typeof v === 'boolean') return TYPES.Bit
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? TYPES.Int : TYPES.Float
  if (typeof v === 'bigint') return TYPES.BigInt
  if (v instanceof Date) return TYPES.DateTimeOffset
  if (v instanceof Uint8Array) return TYPES.VarBinary
  return TYPES.NVarChar
}

// Dates without a time zone (date, datetime, datetime2, smalldatetime, time)
// as the wall-clock text they store; with useUTC their UTC fields are exactly
// that. datetimeoffset keeps ISO 8601.
const pad = (n, w = 2) => String(n).padStart(w, '0')
function cellValue(col) {
  const v = col.value
  if (!(v instanceof Date)) return v
  const type = col.metadata?.type?.name || ''
  if (type === 'DateTimeOffset') return v.toISOString()
  const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  const ms = v.getUTCMilliseconds()
  const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}${ms ? '.' + pad(ms, 3) : ''}`
  if (type === 'Date' || type === 'DateN') return date
  if (type === 'Time' || type === 'TimeN') return time
  return `${date} ${time}`
}

class MssqlDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'mssql'
    this.timeoutMs = 0 // per-request timeout while an AI read runs
    // SAVE TRANSACTION / ROLLBACK TRANSACTION name; there is no RELEASE.
    this.txSql = {
      begin: 'begin transaction',
      commit: 'commit transaction',
      rollback: 'rollback transaction',
      savepoint: (n) => `save transaction ${n}`,
      rollbackTo: (n) => `rollback transaction ${n}`,
      release: null,
    }
  }

  quote(id) {
    return '[' + String(id).replace(/]/g, ']]') + ']'
  }

  placeholder(i) {
    return '@p' + i
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  connect() {
    const c = this.config
    this.conn = new Connection({
      server: c.host || 'localhost',
      authentication: { type: 'default', options: { userName: c.user, password: c.password } },
      options: {
        port: Number(c.port) || 1433,
        database: c.database || undefined,
        encrypt: !!c.ssl,
        // Through an SSH tunnel the server is 127.0.0.1: check the certificate against the real name.
        ...(c.tunnelHost && { serverName: c.tunnelHost }),
        // 'require' accepts any certificate (self-signed ones are common on
        // internal servers); the verify modes check it against the CA.
        trustServerCertificate: !c.ssl || modeOf(c) === 'require',
        ...(c.ssl && { cryptoCredentialsDetails: (({ ca, cert, key }) => ({ ca, cert, key }))(tlsOptions(c)) }),
        connectTimeout: 15000,
        requestTimeout: 0,
        rowCollectionOnRequestCompletion: false,
        useUTC: true,
      },
    })
    return new Promise((resolve, reject) => {
      this.conn.once('connect', (err) => (err ? reject(err) : resolve()))
      this.conn.on('error', () => {}) // reported through the pending request
      this.conn.connect()
    })
  }

  async disconnect() {
    this.conn?.close()
    this.conn = null
  }

  // Runs one batch; resolves with every result set and the affected row count.
  request(text, params = [], { onRow, onColumns } = {}) {
    return new Promise((resolve, reject) => {
      const sets = []
      let current = null
      // rowCount: rows affected (or returned) by the whole batch.
      const req = new Request(text, (err, rowCount) => (err ? reject(err) : resolve({ sets, affected: rowCount || 0, req })))
      if (this.timeoutMs) req.setTimeout(this.timeoutMs)
      req.on('columnMetadata', (cols) => {
        const list = Array.isArray(cols) ? cols : Object.values(cols)
        current = { fields: list.map((c) => c.colName), rows: [] }
        sets.push(current)
        onColumns?.(current.fields, req)
      })
      req.on('row', (cols) => {
        const values = (Array.isArray(cols) ? cols : Object.values(cols)).map(cellValue)
        if (onRow) onRow(values, req)
        else current.rows.push(values)
      })
      params.forEach((v, i) => req.addParameter('p' + (i + 1), paramType(v), v))
      if (params.length) this.conn.execSql(req)
      else this.conn.execSqlBatch(req)
    })
  }

  async version() {
    const r = await this.query(
      "select cast(serverproperty('ProductVersion') as nvarchar(64)) as v, cast(serverproperty('Edition') as nvarchar(128)) as e, @@version as full_v",
    )
    const year = /SQL Server (\d{4})/.exec(r[0].full_v)?.[1]
    const azure = /azure/i.test(r[0].e)
    return `${azure ? 'Azure SQL' : 'SQL Server'}${year ? ' ' + year : ''} (${r[0].v})`
  }

  async database() {
    return (await this.query('select db_name() as d'))[0].d
  }

  async query(text, params = []) {
    const { sets } = await this.request(text, params)
    const set = sets.at(-1) || { fields: [], rows: [] }
    return set.rows.map((r) => Object.fromEntries(set.fields.map((f, i) => [f, r[i]])))
  }

  async execute(text, params = [], opts = {}) {
    const { sets, affected } = await this.request(text, params)
    // The last result set with columns (e.g. `insert …; select scope_identity()`).
    const set = [...sets].reverse().find((s) => s.fields.length)
    if (!set) return { affected }
    if (opts.raw) return { fields: set.fields, rows: set.rows }
    const binary = new Set()
    const rows = normaliseRows(set.rows, set.fields, binary)
    return opts.origins ? { fields: set.fields, rows, origins: set.fields.map(() => null), binary: [...binary] } : { fields: set.fields, rows }
  }

  // Rows arrive as events; pause the request between batches so memory stays flat.
  async *stream(sql, { batch = 1000, raw } = {}) {
    let fields = null
    let buf = []
    let done = false
    let error = null
    let wake = null
    let request = null
    const notify = () => { wake?.(); wake = null }
    const finished = this.request(sql.replace(/[\s;]+$/, ''), [], {
      onColumns: (f) => { fields = f },
      onRow: (values, req) => {
        request = req
        buf.push(values)
        if (buf.length >= batch) { req.pause(); notify() }
      },
    }).then(() => { done = true; notify() }, (e) => { error = e; done = true; notify() })
    try {
      for (;;) {
        if (buf.length < batch && !done) await new Promise((r) => (wake = r))
        if (error) throw error
        if (buf.length || done) {
          const rows = buf
          buf = []
          if (rows.length || !done || fields) yield { fields: fields || [], rows: raw ? rows : normaliseRows(rows, fields || []) }
          if (done) break
          request?.resume()
        }
      }
    } finally {
      if (!done) { this.conn.cancel(); await finished }
    }
  }

  // First rows of a SELECT without reading the rest (AI reads).
  async firstRows(sql, limit) {
    await this.request(`set rowcount ${Number(limit)}`)
    try {
      return await this.execute(sql)
    } finally {
      await this.request('set rowcount 0').catch(() => {})
    }
  }

  pageSql({ cols = '*', from, filter, order, limit, offset }) {
    // OFFSET … FETCH needs an ORDER BY.
    return `select ${cols} from ${from}${filter}${order || ' order by (select null)'} offset ${offset} rows fetch next ${limit} rows only`
  }

  // tedious turns DECIMAL / NUMERIC / MONEY into JS numbers, losing digits past
  // ~15. Where Graphite writes the query (table browsing, exports) those
  // columns are read as text instead. Free-form queries can CAST themselves.
  async selectList(table, schema) {
    const cols = await this.listColumns(table, schema).catch(() => [])
    if (!cols.some((c) => /^(decimal|numeric|money)/i.test(c.type))) return '*'
    return cols
      .map((c) => {
        const q = this.quote(c.name)
        const m = /^(decimal|numeric)\((\d+),/i.exec(c.type)
        const wide = m && Number(m[2]) > 15
        // money: style 2 keeps all four decimal places.
        if (/^money/i.test(c.type)) return `convert(varchar(64), ${q}, 2) as ${q}`
        return wide ? `cast(${q} as varchar(64)) as ${q}` : q
      })
      .join(', ')
  }

  async transaction(fn) {
    await this.request('begin transaction')
    try {
      const out = await fn()
      await this.request('commit transaction')
      return out
    } catch (e) {
      await this.request('if @@trancount > 0 rollback transaction').catch(() => {})
      throw e
    }
  }

  // AI reads: always rolled back, with a timeout (see the top comment).
  async readOnly(fn, timeoutMs) {
    await this.request('begin transaction')
    this.timeoutMs = timeoutMs
    try {
      return await fn()
    } finally {
      this.timeoutMs = 0
      await this.request('if @@trancount > 0 rollback transaction').catch(() => {})
    }
  }

  async beginSnapshot() {}

  // --- catalog: "schema" in the picker = database --------------------------------

  async listSchemas() {
    const rows = await this.query('select name from sys.databases where state = 0 order by name')
    return rows.map((r) => ({ name: r.name, system: SYSTEM_DBS.has(r.name) }))
  }

  async currentSchema() {
    return this.database()
  }

  async useSchema(name) {
    await this.request(`use ${this.quote(name)}`)
  }

  async listTables() {
    const rows = await this.query(
      `select s.name as [schema], o.name, case o.type when 'V' then 'view' else 'table' end as type
       from sys.objects o join sys.schemas s on s.schema_id = o.schema_id
       where o.type in ('U', 'V') and o.is_ms_shipped = 0
       order by case when s.name = 'dbo' then 0 else 1 end, s.name, o.type, o.name`,
    )
    return rows
  }

  async listColumns(table, schema = 'dbo') {
    return this.query(
      `select c.name, t.name + case
                when t.name in ('varchar', 'char', 'varbinary', 'binary') then '(' + case c.max_length when -1 then 'max' else cast(c.max_length as varchar) end + ')'
                when t.name in ('nvarchar', 'nchar') then '(' + case c.max_length when -1 then 'max' else cast(c.max_length / 2 as varchar) end + ')'
                when t.name in ('decimal', 'numeric') then '(' + cast(c.precision as varchar) + ',' + cast(c.scale as varchar) + ')'
                else '' end as type,
              cast(c.is_nullable as bit) as nullable,
              dc.definition as [default],
              cast(case when exists (select 1 from sys.index_columns ic join sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
                                     where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id) then 1 else 0 end as bit) as [primary],
              cast(case when c.is_identity = 1 or c.is_computed = 1 or t.name in ('timestamp', 'rowversion') then 1 else 0 end as bit) as auto,
              (select top 1 rt.name + '(' + rc.name + ')' from sys.foreign_key_columns f
                 join sys.tables rt on rt.object_id = f.referenced_object_id
                 join sys.columns rc on rc.object_id = f.referenced_object_id and rc.column_id = f.referenced_column_id
                where f.parent_object_id = c.object_id and f.parent_column_id = c.column_id) as [references],
              (select top 1 schema_name(rt.schema_id) from sys.foreign_key_columns f
                 join sys.tables rt on rt.object_id = f.referenced_object_id
                where f.parent_object_id = c.object_id and f.parent_column_id = c.column_id) as refSchema
       from sys.columns c
       join sys.types t on t.user_type_id = c.user_type_id
       left join sys.default_constraints dc on dc.object_id = c.default_object_id
       where c.object_id = object_id(@p1)
       order by c.column_id`,
      [`${this.quote(schema || 'dbo')}.${this.quote(table)}`],
    )
  }

  async schemaMap() {
    const rows = await this.query(
      `select s.name as sch, o.name as tbl, c.name as col
       from sys.columns c join sys.objects o on o.object_id = c.object_id join sys.schemas s on s.schema_id = o.schema_id
       where o.type in ('U', 'V') and o.is_ms_shipped = 0
       order by s.name, o.name, c.column_id`,
    )
    const map = {}
    for (const r of rows) (map[r.sch === 'dbo' ? r.tbl : `${r.sch}.${r.tbl}`] ||= []).push(r.col)
    return map
  }

  async listIndexes(table, schema = 'dbo') {
    const rows = await this.query(
      `select i.name, cast(i.is_unique as bit) as uniq, cast(i.is_primary_key as bit) as pk,
              string_agg(c.name, ',') within group (order by ic.key_ordinal) as cols
       from sys.indexes i
       join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id and ic.is_included_column = 0
       join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
       where i.object_id = object_id(@p1) and i.name is not null
       group by i.name, i.is_unique, i.is_primary_key`,
      [`${this.quote(schema || 'dbo')}.${this.quote(table)}`],
    )
    return rows.map((r) => ({ name: r.name, unique: !!r.uniq, primary: !!r.pk, columns: r.cols.split(',') }))
  }

  // SQL Server has no SHOW CREATE TABLE: views come from their definition,
  // tables are rebuilt from the catalog (columns, defaults, primary key).
  async createScript(table, schema = 'dbo') {
    const name = `${this.quote(schema || 'dbo')}.${this.quote(table)}`
    const view = await this.query('select object_definition(object_id(@p1)) as def', [name])
    const kind = await this.query("select type from sys.objects where object_id = object_id(@p1)", [name])
    if (kind[0]?.type?.trim() === 'V' && view[0]?.def) return view[0].def.trim() + ';'
    const cols = await this.listColumns(table, schema)
    const ident = await this.query(
      `select c.name, ic.seed_value, ic.increment_value from sys.identity_columns ic join sys.columns c
         on c.object_id = ic.object_id and c.column_id = ic.column_id where ic.object_id = object_id(@p1)`,
      [name],
    )
    const lines = cols.map((c) => {
      const id = ident.find((i) => i.name === c.name)
      return `  ${this.quote(c.name)} ${c.type}${id ? ` IDENTITY(${id.seed_value}, ${id.increment_value})` : ''}${c.nullable ? '' : ' NOT NULL'}${c.default ? ' DEFAULT ' + c.default : ''}`
    })
    const pk = cols.filter((c) => c.primary).map((c) => this.quote(c.name))
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`)
    for (const c of cols.filter((x) => x.references)) {
      const [, refTable, refCol] = /^(.*)\((.*)\)$/.exec(c.references)
      lines.push(`  FOREIGN KEY (${this.quote(c.name)}) REFERENCES ${this.quote(c.refSchema || 'dbo')}.${this.quote(refTable)} (${this.quote(refCol)})`)
    }
    return `CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`
  }

  async erModel() {
    const cols = await this.query(
      `select case when s.name = 'dbo' then o.name else s.name + '.' + o.name end as [table],
              case o.type when 'V' then 'view' else 'table' end as kind, c.name, t.name as type,
              cast(c.is_nullable as bit) as nullable,
              cast(case when exists (select 1 from sys.index_columns ic join sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
                                     where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id) then 1 else 0 end as bit) as [primary]
       from sys.objects o join sys.schemas s on s.schema_id = o.schema_id
       join sys.columns c on c.object_id = o.object_id
       join sys.types t on t.user_type_id = c.user_type_id
       where o.type in ('U', 'V') and o.is_ms_shipped = 0
       order by s.name, o.name, c.column_id`,
    )
    const keys = await this.query(
      `select fk.name, case when ps.name = 'dbo' then pt.name else ps.name + '.' + pt.name end as [table],
              case when rs.name = 'dbo' then rt.name else rs.name + '.' + rt.name end as ref_table,
              pc.name as col, rc.name as ref_col
       from sys.foreign_keys fk
       join sys.foreign_key_columns f on f.constraint_object_id = fk.object_id
       join sys.tables pt on pt.object_id = f.parent_object_id join sys.schemas ps on ps.schema_id = pt.schema_id
       join sys.tables rt on rt.object_id = f.referenced_object_id join sys.schemas rs on rs.schema_id = rt.schema_id
       join sys.columns pc on pc.object_id = f.parent_object_id and pc.column_id = f.parent_column_id
       join sys.columns rc on rc.object_id = f.referenced_object_id and rc.column_id = f.referenced_column_id
       order by fk.name, f.constraint_column_id`,
    )
    const fks = new Map()
    for (const k of keys) {
      if (!fks.has(k.name)) fks.set(k.name, { name: k.name, table: k.table, columns: [], refSchema: null, refTable: k.ref_table, refColumns: [] })
      fks.get(k.name).columns.push(k.col)
      fks.get(k.name).refColumns.push(k.ref_col)
    }
    return erFrom(null, cols, [...fks.values()])
  }
}

module.exports = MssqlDriver
