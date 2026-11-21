const pg = require('pg')
const { normaliseRows, erFrom } = require('../lib/sql.cjs')

// Keep temporal types as the server formats them instead of JS Dates.
const RAW_TYPES = new Set([1082, 1083, 1114, 1184, 1266])
const types = {
  getTypeParser: (oid, format) => (RAW_TYPES.has(oid) ? (v) => v : pg.types.getTypeParser(oid, format)),
}
// Every value exactly as the server prints it: what a dump must write back.
const TEXT_TYPES = { getTypeParser: () => (v) => v }
// Values shown in the grid. Only numbers, booleans and bytea (kept as bytes so
// it is detected as binary) are parsed; everything else stays server text.
// pg's default parsers turn interval, point, arrays and json into JS objects,
// whose JSON form is not valid PostgreSQL input, so filtering or editing such
// a cell would send back something like '{"days":1}' instead of '1 day'.
const PARSED_FOR_GRID = new Set([16, 17, 21, 23, 26, 700, 701]) // bool, bytea, int2, int4, oid, float4, float8
const GRID_TYPES = {
  getTypeParser: (oid, format) => (PARSED_FOR_GRID.has(oid) ? pg.types.getTypeParser(oid, format) : (v) => v),
}
const stripSemi = (sql) => sql.replace(/[\s;]+$/, '')

class PostgresDriver {
  constructor(config) {
    this.config = config
    this.dialect = 'postgres'
  }

  quote(id) {
    return `"${String(id).replace(/"/g, '""')}"`
  }

  placeholder(i) {
    return `$${i}`
  }

  qualified(table, schema) {
    return schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table)
  }

  async connect() {
    const c = this.config
    this.client = new pg.Client({
      host: c.host || 'localhost',
      port: Number(c.port) || 5432,
      user: c.user,
      password: c.password,
      database: c.database || 'postgres',
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      types,
      application_name: 'Graphite',
    })
    this.client.on('error', (e) => console.error('[pg]', e.message))
    await this.client.connect()
  }

  async disconnect() {
    await this.client?.end().catch(() => {})
    this.client = null
  }

  async version() {
    const r = await this.client.query('show server_version')
    return 'PostgreSQL ' + r.rows[0].server_version
  }

  async database() {
    return this.client.database
  }

  // opts.raw: rows untouched ('text' = every value as server text); otherwise
  // values are read for display in the grid (see GRID_TYPES).
  async execute(text, params = [], opts = {}) {
    const types = opts.raw === 'text' ? TEXT_TYPES : opts.raw ? undefined : GRID_TYPES
    const res = await this.client.query({ text, values: params, rowMode: 'array', ...(types && { types }) })
    const last = Array.isArray(res) ? res[res.length - 1] : res
    if (last.fields && last.fields.length) {
      const fields = last.fields.map((f) => f.name)
      if (opts.raw) return { fields, rows: last.rows }
      const binary = new Set()
      const rows = normaliseRows(last.rows, fields, binary)
      if (!opts.origins) return { fields, rows }
      return { fields, rows, origins: await this.origins(last.fields), binary: [...binary] }
    }
    return { affected: last.rowCount ?? 0 }
  }

  // Map RowDescription (table oid, attnum) pairs back to schema.table.column.
  async origins(pgFields) {
    const refs = pgFields.filter((f) => f.tableID && f.columnID)
    if (!refs.length) return pgFields.map(() => null)
    const r = await this.client.query(
      `select c.oid::int as rel, a.attnum::int as num, n.nspname as schema, c.relname as "table", a.attname as "column"
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       where c.oid = any($1::oid[]) and a.attnum > 0`,
      [[...new Set(refs.map((f) => f.tableID))]],
    )
    const byKey = new Map(r.rows.map((x) => [`${x.rel}:${x.num}`, x]))
    return pgFields.map((f) => {
      const x = byKey.get(`${f.tableID}:${f.columnID}`)
      return x ? { schema: x.schema, table: x.table, column: x.column } : null
    })
  }

  // Schemas of the connected database. Switching one sets search_path, so
  // unqualified names in the editor resolve there (public stays as fallback).
  async listSchemas() {
    const r = await this.client.query(`
      select nspname as name, nspname in ('information_schema') or nspname like 'pg\\_%' as system
      from pg_namespace
      where nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp\\_%'
      order by system, nspname`)
    return r.rows
  }

  async currentSchema() {
    const r = await this.client.query('select current_schema() as s')
    return r.rows[0].s || 'public'
  }

  async useSchema(name) {
    const path = name === 'public' ? this.quote(name) : `${this.quote(name)}, public`
    await this.client.query(`set search_path to ${path}`)
  }

  // Batches of rows through a server-side cursor (needs an open transaction).
  async *stream(sql, { batch = 1000, raw } = {}) {
    await this.client.query(`declare graphite_cur no scroll cursor for ${stripSemi(sql)}`)
    try {
      for (let first = true; ; first = false) {
        const r = await this.client.query({ text: `fetch forward ${batch} from graphite_cur`, rowMode: 'array', ...(raw === 'text' && { types: TEXT_TYPES }) })
        const fields = r.fields.map((f) => f.name)
        if (r.rows.length || first) yield { fields, rows: raw ? r.rows : normaliseRows(r.rows, fields) }
        if (r.rows.length < batch) break
      }
    } finally {
      await this.client.query('close graphite_cur').catch(() => {})
    }
  }

  async erModel(schema) {
    const cols = await this.client.query(
      `select c.relname as "table", case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
              a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
              coalesce(a.attnum = any(pk.conkey), false) as "primary"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       left join pg_constraint pk on pk.conrelid = c.oid and pk.contype = 'p'
       where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition
       order by c.relname, a.attnum`,
      [schema],
    )
    const fks = await this.client.query(
      `select con.conname as name, c.relname as "table", rc.relname as ref_table, rn.nspname as ref_schema,
              (select array_agg(a.attname::text order by k.i) from unnest(con.conkey) with ordinality k(n, i)
                 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) as columns,
              (select array_agg(a.attname::text order by k.i) from unnest(con.confkey) with ordinality k(n, i)
                 join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) as ref_columns
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class rc on rc.oid = con.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
       where con.contype = 'f' and n.nspname = $1`,
      [schema],
    )
    return erFrom(schema, cols.rows, fks.rows.map((f) => ({
      name: f.name, table: f.table, columns: f.columns, refSchema: f.ref_schema, refTable: f.ref_table, refColumns: f.ref_columns,
    })))
  }

  async listTables(schema) {
    const r = await this.client.query(
      `select table_schema as schema, table_name as name,
              case table_type when 'VIEW' then 'view' else 'table' end as type
       from information_schema.tables
       where ($1::text is null and table_schema not in ('pg_catalog', 'information_schema')
                and table_schema not like 'pg_toast%')
          or table_schema = $1::text
       order by table_schema = 'public' desc, table_schema, table_type, table_name`,
      [schema ?? null],
    )
    return r.rows
  }

  async listColumns(table, schema = 'public') {
    const r = await this.client.query(
      `select c.column_name as name,
              case when c.data_type = 'USER-DEFINED' then c.udt_name
                   when c.character_maximum_length is not null
                     then c.data_type || '(' || c.character_maximum_length || ')'
                   else c.data_type end as type,
              c.is_nullable = 'YES' as nullable,
              c.column_default as "default",
              -- filled in by the database: identity / serial / generated columns
              (c.is_identity = 'YES' or c.is_generated = 'ALWAYS' or coalesce(c.column_default, '') like 'nextval(%') as auto,
              exists (
                select 1 from information_schema.table_constraints tc
                join information_schema.key_column_usage k
                  on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
                where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema
                  and tc.table_name = c.table_name and k.column_name = c.column_name
              ) as "primary",
              (select ccu.table_name || '(' || ccu.column_name || ')'
                 from information_schema.table_constraints tc
                 join information_schema.key_column_usage k
                   on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
                 join information_schema.constraint_column_usage ccu
                   on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.table_schema
                where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = c.table_schema
                  and tc.table_name = c.table_name and k.column_name = c.column_name
                limit 1) as "references",
              (select ccu.table_schema
                 from information_schema.table_constraints tc
                 join information_schema.key_column_usage k
                   on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
                 join information_schema.constraint_column_usage ccu
                   on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.table_schema
                where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = c.table_schema
                  and tc.table_name = c.table_name and k.column_name = c.column_name
                limit 1) as "refSchema"
       from information_schema.columns c
       where c.table_schema = $1 and c.table_name = $2
       order by c.ordinal_position`,
      [schema, table],
    )
    return r.rows
  }

  async schemaMap() {
    const current = await this.currentSchema()
    const r = await this.client.query(`
      select table_schema, table_name, column_name from information_schema.columns
      where table_schema not in ('pg_catalog', 'information_schema')
      order by table_schema, table_name, ordinal_position`)
    const map = {}
    for (const row of r.rows) {
      const key = row.table_schema === current ? row.table_name : `${row.table_schema}.${row.table_name}`
      ;(map[key] ||= []).push(row.column_name)
    }
    return map
  }

  async listIndexes(table, schema = 'public') {
    const r = await this.client.query(
      `select i.relname as name, ix.indisunique as "unique", ix.indisprimary as "primary",
              array_agg(a.attname::text order by array_position(ix.indkey, a.attnum)) as columns
       from pg_class t
       join pg_namespace n on n.oid = t.relnamespace
       join pg_index ix on ix.indrelid = t.oid
       join pg_class i on i.oid = ix.indexrelid
       join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
       where n.nspname = $1 and t.relname = $2
       group by i.relname, ix.indisunique, ix.indisprimary
       order by ix.indisprimary desc, i.relname`,
      [schema, table],
    )
    return r.rows
  }

  async createScript(table, schema = 'public') {
    const cols = await this.listColumns(table, schema)
    const lines = cols.map((c) =>
      `  ${this.quote(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ' DEFAULT ' + c.default : ''}`)
    const pk = cols.filter((c) => c.primary).map((c) => this.quote(c.name))
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`)
    return `CREATE TABLE ${this.qualified(table, schema)} (\n${lines.join(',\n')}\n);`
  }

  async transaction(fn) {
    await this.client.query('BEGIN')
    try {
      const out = await fn()
      await this.client.query('COMMIT')
      return out
    } catch (e) {
      await this.client.query('ROLLBACK')
      throw e
    }
  }
}

module.exports = PostgresDriver
