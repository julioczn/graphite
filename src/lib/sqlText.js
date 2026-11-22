// Renderer-side SQL text helpers for the current connection's dialect:
// identifier quoting and literals, used to build filters and INSERTs for the
// clipboard. Mirrors the drivers' quote() in electron/drivers/*.cjs.
import { store } from './store'

const dialect = () => store.connection?.dialect

export function quoteIdent(name) {
  const s = String(name)
  if (dialect() === 'mysql' || dialect() === 'clickhouse') return '`' + s.replace(/`/g, '``') + '`'
  if (dialect() === 'mssql') return '[' + s.replace(/]/g, ']]') + ']'
  return `"${s.replace(/"/g, '""')}"`
}

export function qualifiedName(table, schema) {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table)
}

// As written in a query: tables of the current schema / database unqualified.
export function tableName(table, schema) {
  const current = store.connection?.schema ?? (dialect() === 'postgres' ? 'public' : null)
  return !schema || schema === current ? quoteIdent(table) : qualifiedName(table, schema)
}

export function literal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${v}'`
  // No boolean literals in SQLite, SQL Server (bit) or Oracle before 23ai.
  if (typeof v === 'boolean') return ['sqlite', 'mssql', 'oracle'].includes(dialect()) ? (v ? '1' : '0') : (v ? 'TRUE' : 'FALSE')
  let s = String(v).replace(/'/g, "''")
  // MySQL treats backslash as an escape character inside strings by default.
  if (dialect() === 'mysql' || dialect() === 'clickhouse') s = s.replace(/\\/g, '\\\\')
  return `'${s}'`
}

// Both sides of an equality filter, given the column's declared type (as
// conn/listColumns reports it). Plain `col = 'text'` covers most types,
// dates included: the drivers read them as the server's own text, which it
// parses back exactly. The exceptions:
//  - single-precision floats (MySQL FLOAT, PostgreSQL real): `r = 1.1` compares
//    against the double 1.1 and never matches the stored 1.100000023841858.
//  - JSON never equals a plain string (MySQL) or has no `=` at all
//    (PostgreSQL json), so both sides are compared as JSON values.
//  - PostgreSQL xml and geometric types have no `=`: compare their text.
const PG_NO_EQUALITY = /^(xml|point|line|lseg|box|path|polygon|circle)$/

function operands(col, value, type) {
  const t = String(type || '').toLowerCase()
  const lit = literal(value)
  if (dialect() === 'mysql') {
    if (/^float\b/.test(t)) return [col, `CAST(${lit} AS FLOAT)`]
    if (t === 'json') return [col, `CAST(${lit} AS JSON)`]
  } else if (dialect() === 'postgres') {
    if (t === 'real') return [col, `CAST(${lit} AS real)`]
    if (t === 'json') return [`${col}::jsonb`, `${lit}::jsonb`]
    if (PG_NO_EQUALITY.test(t)) return [`${col}::text`, lit]
  }
  return [col, lit]
}

// `col = value`, `col <> value`, `col IS NULL` / `col IS NOT NULL`.
// `type` is the column type from conn/listColumns, when known.
export function condition(field, value, negate = false, type = null) {
  const col = quoteIdent(field)
  if (value === null || value === undefined) return `${col} IS ${negate ? 'NOT ' : ''}NULL`
  const [left, right] = operands(col, value, type)
  return `${left} ${negate ? '<>' : '='} ${right}`
}

export function insertSql(target, fields, values) {
  return `INSERT INTO ${target} (${fields.map(quoteIdent).join(', ')})\nVALUES (${values.map(literal).join(', ')});`
}
