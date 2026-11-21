const mysql = require('mysql2/promise')
const { normaliseRows, erFrom } = require('../lib/sql.cjs')

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

class MysqlDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'mysql'
  }

  quote(id) {
    return '`' + String(id).replace(/`/g, '``') + '`'
  }

  placeholder() {
    return '?'
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  async connect() {
    const c = this.config
    this.conn = await mysql.createConnection({
      host: c.host || 'localhost',
      port: Number(c.port) || 3306,
      user: c.user,
      password: c.password,
      database: c.database || undefined,
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10000,
      // affectedRows counts matched rows, so an update that keeps the same
      // value still reports 1 and the apply check below holds.
      flags: ['+FOUND_ROWS'],
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    })
  }

  async disconnect() {
    await this.conn?.end().catch(() => {})
    this.conn = null
  }

  async version() {
    const [rows] = await this.conn.query('select version() as v')
    return 'MySQL ' + rows[0].v
  }

  async database() {
    const [rows] = await this.conn.query('select database() as d')
    return rows[0].d
  }

  async execute(text, params = [], opts = {}) {
    const [rows, fields] = await this.conn.query({ sql: text, values: params, rowsAsArray: true })
    if (Array.isArray(rows) && fields) {
      const names = fields.map((f) => f.name)
      if (opts.raw) return { fields: names, rows }
      const binary = new Set()
      const out = normaliseRows(rows, names, binary)
      if (!opts.origins) return { fields: names, rows: out }
      const origins = fields.map((f) => (f.orgTable && f.orgName ? { schema: f.db || null, table: f.orgTable, column: f.orgName } : null))
      return { fields: names, rows: out, origins, binary: [...binary] }
    }
    return { affected: rows.affectedRows ?? 0 }
  }

  // Rows streamed from the server in batches; the connection is busy until the
  // generator finishes, so this only runs on a job's own connection.
  async *stream(sql, { batch = 1000, raw } = {}) {
    const query = this.conn.connection.query({ sql: sql.replace(/[\s;]+$/, ''), rowsAsArray: true })
    let fields = null
    query.on('fields', (f) => { fields = (f || []).map((x) => x.name) })
    let rows = []
    for await (const row of query.stream({ highWaterMark: batch })) {
      rows.push(row)
      if (rows.length >= batch) {
        yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
        rows = []
      }
    }
    fields ||= []
    yield { fields, rows: raw ? rows : normaliseRows(rows, fields) }
  }

  async erModel(schema) {
    const [cols] = await this.conn.query(
      `select c.table_name as \`table\`, if(t.table_type = 'VIEW', 'view', 'table') as kind, c.column_name as name,
              c.column_type as type, c.is_nullable = 'YES' as nullable, c.column_key = 'PRI' as \`primary\`
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = coalesce(?, database())
       order by c.table_name, c.ordinal_position`,
      [schema ?? null],
    )
    const [keys] = await this.conn.query(
      `select constraint_name as name, table_name as \`table\`, column_name as col,
              referenced_table_schema as ref_schema, referenced_table_name as ref_table, referenced_column_name as ref_col
       from information_schema.key_column_usage
       where table_schema = coalesce(?, database()) and referenced_table_name is not null
       order by table_name, constraint_name, ordinal_position`,
      [schema ?? null],
    )
    const fks = new Map()
    for (const k of keys) {
      const id = `${k.table}.${k.name}`
      if (!fks.has(id)) fks.set(id, { name: k.name, table: k.table, columns: [], refSchema: k.ref_schema, refTable: k.ref_table, refColumns: [] })
      fks.get(id).columns.push(k.col)
      fks.get(id).refColumns.push(k.ref_col)
    }
    const db = schema ?? (await this.database())
    return erFrom(db, cols.map((c) => ({ ...c, nullable: !!c.nullable, primary: !!c.primary })), [...fks.values()])
  }

  // In MySQL a "schema" is a database; switching is a plain USE on the same connection.
  async listSchemas() {
    const [rows] = await this.conn.query('show databases')
    return rows.map((r) => ({ name: Object.values(r)[0], system: SYSTEM_DBS.has(Object.values(r)[0]) }))
  }

  async currentSchema() {
    return this.database()
  }

  async useSchema(name) {
    await this.conn.query(`use ${this.quote(name)}`)
  }

  async listTables(schema) {
    const [rows] = await this.conn.query(
      `select table_schema as \`schema\`, table_name as name, if(table_type = 'VIEW', 'view', 'table') as type
       from information_schema.tables where table_schema = coalesce(?, database())
       order by table_type, table_name`,
      [schema ?? null],
    )
    return rows.map((r) => ({ name: r.name, schema: r.schema, type: r.type }))
  }

  async listColumns(table, schema) {
    const [rows] = await this.conn.query(
      `select c.column_name as name, c.column_type as type, c.is_nullable = 'YES' as nullable,
              c.column_default as \`default\`, c.column_key = 'PRI' as \`primary\`,
              (c.extra like '%auto_increment%' or c.extra like '%VIRTUAL GENERATED%' or c.extra like '%STORED GENERATED%') as auto,
              (select concat(k.referenced_table_name, '(', k.referenced_column_name, ')')
                 from information_schema.key_column_usage k
                where k.table_schema = c.table_schema and k.table_name = c.table_name
                  and k.column_name = c.column_name and k.referenced_table_name is not null
                limit 1) as \`references\`,
              (select k.referenced_table_schema
                 from information_schema.key_column_usage k
                where k.table_schema = c.table_schema and k.table_name = c.table_name
                  and k.column_name = c.column_name and k.referenced_table_name is not null
                limit 1) as refSchema
       from information_schema.columns c
       where c.table_schema = coalesce(?, database()) and c.table_name = ?
       order by c.ordinal_position`,
      [schema ?? null, table],
    )
    return rows.map((r) => ({ ...r, nullable: !!r.nullable, primary: !!r.primary, auto: !!r.auto }))
  }

  async schemaMap() {
    const [rows] = await this.conn.query(`
      select table_name as t, column_name as c from information_schema.columns
      where table_schema = database() order by table_name, ordinal_position`)
    const map = {}
    for (const r of rows) (map[r.t] ||= []).push(r.c)
    return map
  }

  async listIndexes(table, schema) {
    const [rows] = await this.conn.query(
      `select index_name as name, non_unique = 0 as \`unique\`,
              group_concat(column_name order by seq_in_index) as cols
       from information_schema.statistics
       where table_schema = coalesce(?, database()) and table_name = ?
       group by index_name, non_unique`,
      [schema ?? null, table],
    )
    return rows.map((r) => ({
      name: r.name,
      unique: !!r.unique,
      primary: r.name === 'PRIMARY',
      columns: r.cols.split(','),
    }))
  }

  async createScript(table, schema) {
    const [rows] = await this.conn.query(`show create table ${this.qualified(table, schema)}`)
    return (rows[0]['Create Table'] || rows[0]['Create View']) + ';'
  }

  async transaction(fn) {
    await this.conn.beginTransaction()
    try {
      const out = await fn()
      await this.conn.commit()
      return out
    } catch (e) {
      await this.conn.rollback()
      throw e
    }
  }
}

module.exports = MysqlDriver
