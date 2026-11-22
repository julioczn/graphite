// Oracle Database over node-oracledb in Thin mode (pure JS, no Instant Client).
//
// - "Database" in the form is the service name (e.g. FREEPDB1, ORCLPDB1).
// - Schemas are users; the picker runs ALTER SESSION SET CURRENT_SCHEMA.
// - Oracle has no BEGIN: in auto-commit mode every statement commits
//   (autoCommit), in a transaction nothing does until COMMIT / ROLLBACK.
// - Numbers wider than a double come back as text; dates as 'YYYY-MM-DD HH:MM:SS'.
// - AI reads run in SET TRANSACTION READ ONLY, which Oracle enforces.
const oracledb = require('oracledb')
const { normaliseRows, erFrom, commandOf } = require('../lib/sql.cjs')
const { tlsOptions, modeOf } = require('../lib/tls.cjs')

// PL/SQL blocks keep their final semicolon; plain SQL must not have one.
const PLSQL = /^\s*(declare|begin|create\s+(or\s+replace\s+)?(editionable\s+|noneditionable\s+)?(procedure|function|package|trigger|type))\b/i

// Thin mode builds JS Dates in local time and ignores NLS formats, so dates
// are formatted here: DATE / TIMESTAMP as 'YYYY-MM-DD HH:MM:SS[.fff]' (they
// carry no time zone), zoned timestamps as ISO 8601.
const pad = (n, w = 2) => String(n).padStart(w, '0')
const localText = (d, frac) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
  (frac && d.getMilliseconds() ? '.' + pad(d.getMilliseconds(), 3) : '')

function exactNumber(v) {
  if (v == null || !/^-?\d+(\.\d+)?$/.test(v)) return v
  return v.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15 ? Number(v) : v
}

function fetchTypeHandler(meta) {
  // NUMBER is fetched as text (no binary rounding) and turned into a JS number
  // only when that keeps every digit (≤ 15 significant digits).
  if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING, converter: exactNumber }
  if (meta.dbType === oracledb.DB_TYPE_DATE) return { converter: (v) => (v == null ? v : localText(v, false)) }
  if (meta.dbType === oracledb.DB_TYPE_TIMESTAMP) return { converter: (v) => (v == null ? v : localText(v, true)) }
  if (meta.dbType === oracledb.DB_TYPE_TIMESTAMP_TZ || meta.dbType === oracledb.DB_TYPE_TIMESTAMP_LTZ) return { converter: (v) => (v == null ? v : v.toISOString()) }
  if (meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING }
  if (meta.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER }
  return undefined
}

function oracleTls(c) {
  const o = tlsOptions(c)
  const pem = [o.ca, o.cert, o.key].filter(Boolean).map((b) => b.toString('utf8').trim()).join('\n')
  return { sslServerDNMatch: modeOf(c) === 'verify-full', ...(pem && { walletContent: pem }) }
}

const SYSTEM_SCHEMA_SQL = "oracle_maintained = 'Y'"

class OracleDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'oracle'
    this.inTx = false
    // No RELEASE SAVEPOINT in Oracle.
    this.txSql = { begin: null, release: null }
  }

  quote(id) {
    return `"${String(id).replace(/"/g, '""')}"`
  }

  placeholder(i) {
    return ':' + i
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  async connect() {
    const c = this.config
    this.conn = await oracledb.getConnection({
      user: c.user,
      password: c.password,
      // TLS = tcps. The Thin driver always verifies the server's certificate
      // (system CAs, or the PEM "wallet": CA + client certificate and key);
      // only the host name match depends on the mode.
      connectString: `${c.ssl ? 'tcps://' : ''}${c.host || 'localhost'}:${Number(c.port) || 1521}/${c.database || 'FREEPDB1'}`,
      ...(c.ssl && oracleTls(c)),
      connectTimeout: 15,
    })
    await this.conn.execute(
      `alter session set nls_date_format = 'YYYY-MM-DD HH24:MI:SS'
         nls_timestamp_format = 'YYYY-MM-DD HH24:MI:SS.FF'
         nls_timestamp_tz_format = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'`,
    )
  }

  async disconnect() {
    await this.conn?.close().catch(() => {})
    this.conn = null
  }

  clean(sql) {
    const s = sql.trim()
    return PLSQL.test(s) ? s.replace(/\/\s*$/, '').trim() : s.replace(/[\s;]+$/, '')
  }

  async run(sql, params = [], opts = {}) {
    const cmd = commandOf(sql)
    const r = await this.conn.execute(this.clean(sql), params, {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      autoCommit: !this.inTx,
      fetchTypeHandler,
      ...opts,
    })
    // COMMIT / ROLLBACK typed by the user (or sent by the session) end the transaction.
    if ((cmd === 'COMMIT' || (cmd === 'ROLLBACK' && !/\bto\b/i.test(sql))) ) this.inTx = false
    return r
  }

  async query(sql, params = []) {
    const r = await this.conn.execute(this.clean(sql), params, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler })
    return r.rows || []
  }

  async execute(text, params = [], opts = {}) {
    const r = await this.run(text, params)
    if (r.metaData) {
      const fields = r.metaData.map((m) => m.name)
      if (opts.raw) return { fields, rows: r.rows }
      const binary = new Set()
      const rows = normaliseRows(r.rows, fields, binary)
      return opts.origins ? { fields, rows, origins: fields.map(() => null), binary: [...binary] } : { fields, rows }
    }
    return { affected: r.rowsAffected ?? 0 }
  }

  async *stream(sql, { batch = 1000, raw } = {}) {
    const r = await this.run(sql, [], { resultSet: true })
    const fields = r.metaData.map((m) => m.name)
    try {
      for (let first = true; ; first = false) {
        const rows = await r.resultSet.getRows(batch)
        if (rows.length || first) yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
        if (rows.length < batch) break
      }
    } finally {
      await r.resultSet.close().catch(() => {})
    }
  }

  firstRows(sql, limit) {
    return this.run(sql, [], { maxRows: Number(limit) }).then((r) => {
      const fields = r.metaData?.map((m) => m.name) || []
      return { fields, rows: normaliseRows(r.rows || [], fields) }
    })
  }

  pageSql({ cols = '*', from, filter, order, limit, offset }) {
    return `select ${cols} from ${from}${filter}${order} offset ${offset} rows fetch next ${limit} rows only`
  }

  // Session: manual mode just stops auto-committing.
  async beginTx() {
    this.inTx = true
  }

  async transaction(fn) {
    const outer = this.inTx
    this.inTx = true
    try {
      const out = await fn()
      if (!outer) await this.conn.commit()
      return out
    } catch (e) {
      if (!outer) await this.conn.rollback().catch(() => {})
      throw e
    } finally {
      this.inTx = outer
    }
  }

  // AI reads: a transaction Oracle itself keeps read-only, with a call timeout.
  async readOnly(fn, timeoutMs) {
    if (this.inTx) throw new Error('read-only guard inside an open transaction')
    this.inTx = true
    this.conn.callTimeout = timeoutMs
    try {
      await this.conn.execute('set transaction read only')
      return await fn()
    } finally {
      this.conn.callTimeout = 0
      await this.conn.rollback().catch(() => {})
      this.inTx = false
    }
  }

  async beginSnapshot() {
    // A read-only transaction sees one consistent snapshot.
    this.inTx = true
    await this.conn.execute('set transaction read only')
  }

  async version() {
    const v = this.conn.oracleServerVersionString
    return 'Oracle Database ' + v
  }

  async database() {
    const r = await this.query("select sys_context('USERENV', 'CON_NAME') as d from dual")
    return r[0].D
  }

  // --- catalog: schemas are users ------------------------------------------------

  async listSchemas() {
    const rows = await this.query(
      `select username as name, case when ${SYSTEM_SCHEMA_SQL} then 1 else 0 end as sys
       from all_users order by sys, username`,
    )
    return rows.map((r) => ({ name: r.NAME, system: r.SYS === 1 }))
  }

  async currentSchema() {
    return (await this.query("select sys_context('USERENV', 'CURRENT_SCHEMA') as s from dual"))[0].S
  }

  async useSchema(name) {
    await this.conn.execute(`alter session set current_schema = ${this.quote(name)}`)
  }

  async listTables(schema) {
    const owner = schema ?? (await this.currentSchema())
    const rows = await this.query(
      `select owner, table_name as name, 'table' as type from all_tables
        where owner = :o and nested = 'NO' and secondary = 'N' and table_name not like 'BIN$%'
       union all
       select owner, view_name, 'view' from all_views where owner = :o
       order by 3, 2`,
      { o: owner },
    )
    return rows.map((r) => ({ schema: r.OWNER, name: r.NAME, type: r.TYPE }))
  }

  async listColumns(table, schema) {
    const owner = schema ?? (await this.currentSchema())
    const cols = await this.query(
      `select c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale,
              c.nullable, c.data_default, c.identity_column, c.virtual_column
       from all_tab_cols c
       where c.owner = :1 and c.table_name = :2 and c.hidden_column = 'NO'
       order by c.column_id`,
      [owner, table],
    )
    const cons = await this.query(
      `select ac.constraint_type as ct, acc.column_name as col, r.owner as ref_owner, r.table_name as ref_table, rcc.column_name as ref_col
       from all_constraints ac
       join all_cons_columns acc on acc.owner = ac.owner and acc.constraint_name = ac.constraint_name
       left join all_constraints r on r.owner = ac.r_owner and r.constraint_name = ac.r_constraint_name
       left join all_cons_columns rcc on rcc.owner = r.owner and rcc.constraint_name = r.constraint_name and rcc.position = acc.position
       where ac.owner = :1 and ac.table_name = :2 and ac.constraint_type in ('P', 'R')`,
      [owner, table],
    )
    return cols.map((c) => {
      const fk = cons.find((k) => k.CT === 'R' && k.COL === c.COLUMN_NAME)
      return {
        name: c.COLUMN_NAME,
        type: typeName(c),
        nullable: c.NULLABLE === 'Y',
        default: c.DATA_DEFAULT == null ? null : String(c.DATA_DEFAULT).trim(),
        primary: cons.some((k) => k.CT === 'P' && k.COL === c.COLUMN_NAME),
        auto: c.IDENTITY_COLUMN === 'YES' || c.VIRTUAL_COLUMN === 'YES',
        references: fk ? `${fk.REF_TABLE}(${fk.REF_COL})` : null,
        refSchema: fk ? fk.REF_OWNER : null,
      }
    })
  }

  async schemaMap() {
    const owner = await this.currentSchema()
    const rows = await this.query(
      'select table_name as t, column_name as c from all_tab_columns where owner = :1 order by table_name, column_id',
      [owner],
    )
    const map = {}
    for (const r of rows) (map[r.T] ||= []).push(r.C)
    return map
  }

  async listIndexes(table, schema) {
    const owner = schema ?? (await this.currentSchema())
    const rows = await this.query(
      `select i.index_name as name, i.uniqueness as u,
              (select count(*) from all_constraints c where c.owner = i.table_owner and c.index_name = i.index_name and c.constraint_type = 'P') as pk,
              listagg(ic.column_name, ',') within group (order by ic.column_position) as cols
       from all_indexes i join all_ind_columns ic on ic.index_owner = i.owner and ic.index_name = i.index_name
       where i.table_owner = :1 and i.table_name = :2
       group by i.index_name, i.uniqueness, i.table_owner`,
      [owner, table],
    )
    return rows.map((r) => ({ name: r.NAME, unique: r.U === 'UNIQUE', primary: r.PK > 0, columns: r.COLS.split(',') }))
  }

  async createScript(table, schema) {
    const owner = schema ?? (await this.currentSchema())
    const kind = (await this.query(
      "select object_type as k from all_objects where owner = :1 and object_name = :2 and object_type in ('TABLE', 'VIEW')",
      [owner, table],
    ))[0]?.K || 'TABLE'
    try {
      const r = await this.query('select dbms_metadata.get_ddl(:1, :2, :3) as ddl from dual', [kind, table, owner])
      return String(r[0].DDL).trim() + ';'
    } catch {
      // No access to DBMS_METADATA for another schema: rebuild from the catalog.
      const cols = await this.listColumns(table, owner)
      const lines = cols.map((c) => `  ${this.quote(c.name)} ${c.type}${c.default ? ' DEFAULT ' + c.default : ''}${c.nullable ? '' : ' NOT NULL'}`)
      const pk = cols.filter((c) => c.primary).map((c) => this.quote(c.name))
      if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`)
      return `CREATE TABLE ${this.qualified(table, owner)} (\n${lines.join(',\n')}\n);`
    }
  }

  async erModel(schema) {
    const owner = schema ?? (await this.currentSchema())
    const cols = await this.query(
      `select c.table_name as "table", case when v.view_name is null then 'table' else 'view' end as kind,
              c.column_name as name, c.data_type as type, case c.nullable when 'Y' then 1 else 0 end as nullable,
              (select count(*) from all_constraints ac join all_cons_columns acc
                  on acc.owner = ac.owner and acc.constraint_name = ac.constraint_name
                where ac.owner = c.owner and ac.table_name = c.table_name and ac.constraint_type = 'P'
                  and acc.column_name = c.column_name) as "primary"
       from all_tab_columns c
       left join all_views v on v.owner = c.owner and v.view_name = c.table_name
       where c.owner = :1 and c.table_name not like 'BIN$%'
       order by c.table_name, c.column_id`,
      [owner],
    )
    const keys = await this.query(
      `select ac.constraint_name as name, ac.table_name as "table", r.owner as ref_owner, r.table_name as ref_table,
              acc.column_name as col, rcc.column_name as ref_col
       from all_constraints ac
       join all_cons_columns acc on acc.owner = ac.owner and acc.constraint_name = ac.constraint_name
       join all_constraints r on r.owner = ac.r_owner and r.constraint_name = ac.r_constraint_name
       join all_cons_columns rcc on rcc.owner = r.owner and rcc.constraint_name = r.constraint_name and rcc.position = acc.position
       where ac.owner = :1 and ac.constraint_type = 'R'
       order by ac.constraint_name, acc.position`,
      [owner],
    )
    const fks = new Map()
    for (const k of keys) {
      if (!fks.has(k.NAME)) fks.set(k.NAME, { name: k.NAME, table: k.table, columns: [], refSchema: k.REF_OWNER, refTable: k.REF_TABLE, refColumns: [] })
      fks.get(k.NAME).columns.push(k.COL)
      fks.get(k.NAME).refColumns.push(k.REF_COL)
    }
    return erFrom(owner, cols.map((c) => ({ table: c.table, kind: c.KIND, name: c.NAME, type: c.TYPE, nullable: c.NULLABLE === 1, primary: c.primary > 0 })), [...fks.values()])
  }
}

function typeName(c) {
  const t = c.DATA_TYPE
  if (/^(N?VARCHAR2|N?CHAR)$/.test(t)) return `${t}(${c.CHAR_LENGTH || c.DATA_LENGTH}${c.CHAR_USED === 'C' && !t.startsWith('N') ? ' CHAR' : ''})`
  if (t === 'NUMBER' && c.DATA_PRECISION != null) return c.DATA_SCALE ? `NUMBER(${c.DATA_PRECISION},${c.DATA_SCALE})` : `NUMBER(${c.DATA_PRECISION})`
  if (t === 'RAW') return `RAW(${c.DATA_LENGTH})`
  return t
}

module.exports = OracleDriver
