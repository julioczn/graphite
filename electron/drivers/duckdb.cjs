// DuckDB, embedded (a local .duckdb file, or :memory:), through the official
// @duckdb/node-api (native, one binary per platform).
//
// - Values come from getRowsJson(): BIGINT/DECIMAL/HUGEINT as exact text
//   (small integers turned back into numbers), dates as text, LIST/STRUCT as JSON.
// - DuckDB has no savepoints.
// - AI: DuckDB has no read-only transaction, and a read could reach local
//   files through read_csv()/read_parquet(); so every AI query needs the
//   user's approval (caps.aiReadOnly = false). Reads still run in a
//   transaction that is rolled back.
const path = require('node:path')
const { normaliseRows, erFrom, commandOf } = require('../lib/sql.cjs')
const { t } = require('../../shared/i18n.mjs')

let api = null
const load = () => (api ||= require('@duckdb/node-api'))

const INTEGER = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT)$/
// Statements that answer with rows; anything else reports a status column.
const ROW_COMMANDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'FROM', 'SHOW', 'DESCRIBE', 'SUMMARIZE', 'EXPLAIN', 'PRAGMA', 'CALL', 'PIVOT', 'UNPIVOT'])
const exactInt = (v) => (typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : v)

class DuckdbDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'duckdb'
    this.txSql = { savepoint: null, rollbackTo: null, release: null }
  }

  quote(id) {
    return `"${String(id).replace(/"/g, '""')}"`
  }

  placeholder() {
    return '?'
  }

  qualified(table, schema) {
    return schema && schema !== 'main' ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  async connect() {
    const file = this.config.file
    if (!file) throw new Error(t('Informe o caminho do arquivo DuckDB'))
    const { DuckDBInstance } = load()
    this.instance = await DuckDBInstance.create(file, this.config.readOnly ? { access_mode: 'READ_ONLY' } : {})
    this.conn = await this.instance.connect()
  }

  async disconnect() {
    try {
      this.conn?.closeSync?.()
      this.instance?.closeSync?.()
    } catch {}
    this.conn = this.instance = null
  }

  rows(reader) {
    const types = reader.columnTypes().map((ty) => String(ty))
    return reader.getRowsJson().map((row) => row.map((v, i) => (INTEGER.test(types[i]) ? exactInt(v) : v)))
  }

  async execute(text, params = [], opts = {}) {
    const sql = text.trim().replace(/[\s;]+$/, '')
    const reader = await this.conn.runAndReadAll(sql, params.length ? params : undefined)
    const fields = reader.columnNames()
    // DML / DDL answer with a single "Count" or "Success" column: report it
    // as affected rows instead (RETURNING keeps its rows).
    const cmd = commandOf(sql)
    if (!ROW_COMMANDS.has(cmd) && fields.length === 1 && (fields[0] === 'Count' || fields[0] === 'Success') && !/\breturning\b/i.test(sql)) {
      return { affected: fields[0] === 'Count' ? Number(reader.getRowsJson()[0]?.[0] ?? 0) : 0 }
    }
    if (!fields.length) return { affected: 0 }
    const rows = this.rows(reader)
    if (opts.raw) return { fields, rows }
    const out = normaliseRows(rows, fields)
    return opts.origins ? { fields, rows: out, origins: fields.map(() => null), binary: [] } : { fields, rows: out }
  }

  async query(sql, params = []) {
    const r = await this.execute(sql, params, { raw: true })
    return (r.rows || []).map((row) => Object.fromEntries(r.fields.map((f, i) => [f, row[i]])))
  }

  // DuckDB produces data chunks (2048 rows); regroup them into batches.
  async *stream(sql, { batch = 1000, raw } = {}) {
    const result = await this.conn.stream(sql.trim().replace(/[\s;]+$/, ''))
    const fields = result.columnNames()
    const types = result.columnTypes().map((ty) => String(ty))
    let rows = []
    let first = true
    for (;;) {
      const chunk = await result.fetchChunk()
      if (!chunk || chunk.rowCount === 0) break
      const { JsonDuckDBValueConverter } = load()
      for (const row of chunk.convertRows(JsonDuckDBValueConverter)) rows.push(row.map((v, i) => (INTEGER.test(types[i]) ? exactInt(v) : v)))
      while (rows.length >= batch) {
        const out = rows.splice(0, batch)
        yield { fields, rows: raw ? out : normaliseRows(out, fields) }
        first = false
      }
    }
    if (rows.length || first) yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
  }

  async transaction(fn) {
    await this.conn.run('begin transaction')
    try {
      const out = await fn()
      await this.conn.run('commit')
      return out
    } catch (e) {
      await this.conn.run('rollback').catch(() => {})
      throw e
    }
  }

  // Approved AI reads (aiReadOnly is false): still inside a rolled-back transaction.
  async readOnly(fn) {
    await this.conn.run('begin transaction')
    try {
      return await fn()
    } finally {
      await this.conn.run('rollback').catch(() => {})
    }
  }

  async version() {
    return 'DuckDB ' + (await this.query('select version() as v'))[0].v
  }

  async database() {
    return path.basename(this.config.file)
  }

  async listSchemas() {
    const rows = await this.query(
      `select distinct schema_name as name from duckdb_schemas() where database_name = current_database() order by 1`,
    )
    return rows.map((r) => ({ name: r.name, system: ['information_schema', 'pg_catalog'].includes(r.name) }))
  }

  async currentSchema() {
    return (await this.query('select current_schema() as s'))[0].s
  }

  async useSchema(name) {
    await this.conn.run(`use ${this.quote(name)}`)
  }

  async listTables(schema) {
    const s = schema ?? (await this.currentSchema())
    const rows = await this.query(
      `select table_name as name, table_type from information_schema.tables
       where table_catalog = current_database() and table_schema = ? order by table_type, table_name`,
      [s],
    )
    return rows.map((r) => ({ name: r.name, schema: s, type: r.table_type === 'VIEW' ? 'view' : 'table' }))
  }

  async listColumns(table, schema) {
    const s = schema ?? (await this.currentSchema())
    const cols = await this.query(
      `select column_name, data_type, is_nullable, column_default from duckdb_columns()
       where database_name = current_database() and schema_name = ? and table_name = ? order by column_index`,
      [s, table],
    )
    const cons = await this.query(
      `select constraint_type, constraint_column_names, referenced_table, referenced_column_names from duckdb_constraints()
       where database_name = current_database() and schema_name = ? and table_name = ?
         and constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`,
      [s, table],
    )
    const has = (type, col) => cons.find((k) => k.constraint_type === type && (k.constraint_column_names || []).includes(col))
    return cols.map((c) => {
      const fk = has('FOREIGN KEY', c.column_name)
      const at = fk ? fk.constraint_column_names.indexOf(c.column_name) : -1
      return {
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === true || c.is_nullable === 'YES',
        default: c.column_default ?? null,
        primary: !!has('PRIMARY KEY', c.column_name),
        auto: /^nextval\(/i.test(c.column_default || ''),
        references: fk ? `${fk.referenced_table}(${fk.referenced_column_names[at]})` : null,
      }
    })
  }

  async schemaMap() {
    const s = await this.currentSchema()
    const rows = await this.query(
      `select table_name, column_name from duckdb_columns() where database_name = current_database() and schema_name = ? order by table_name, column_index`,
      [s],
    )
    const map = {}
    for (const r of rows) (map[r.table_name] ||= []).push(r.column_name)
    return map
  }

  async listIndexes(table, schema) {
    const s = schema ?? (await this.currentSchema())
    const out = []
    for (const k of await this.query(
      `select constraint_type, constraint_column_names from duckdb_constraints()
       where database_name = current_database() and schema_name = ? and table_name = ? and constraint_type in ('PRIMARY KEY', 'UNIQUE')`,
      [s, table],
    )) out.push({ name: k.constraint_type, unique: true, primary: k.constraint_type === 'PRIMARY KEY', columns: k.constraint_column_names })
    for (const ix of await this.query(
      `select index_name, is_unique, expressions from duckdb_indexes() where database_name = current_database() and schema_name = ? and table_name = ?`,
      [s, table],
    )) out.push({ name: ix.index_name, unique: !!ix.is_unique, primary: false, columns: [String(ix.expressions)] })
    return out
  }

  async createScript(table, schema) {
    const s = schema ?? (await this.currentSchema())
    const r = (await this.query(
      `select sql from duckdb_tables() where database_name = current_database() and schema_name = ? and table_name = ?
       union all select sql from duckdb_views() where database_name = current_database() and schema_name = ? and view_name = ?`,
      [s, table, s, table],
    ))[0]
    return r?.sql ? String(r.sql).trim().replace(/;?$/, ';') : ''
  }

  async erModel(schema) {
    const s = schema ?? (await this.currentSchema())
    const cols = []
    const fks = []
    for (const tb of await this.listTables(s)) {
      const list = await this.listColumns(tb.name, s)
      for (const c of list) cols.push({ table: tb.name, kind: tb.type, ...c })
      for (const c of list.filter((x) => x.references)) {
        const [, refTable, refCol] = /^(.*)\((.*)\)$/.exec(c.references)
        fks.push({ name: `fk_${tb.name}_${c.name}`, table: tb.name, columns: [c.name], refSchema: null, refTable, refColumns: [refCol] })
      }
    }
    return erFrom(s, cols, fks)
  }
}

module.exports = DuckdbDriver
