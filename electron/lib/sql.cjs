// Value normalisation shared by every driver; statement splitting lives in shared/sql.mjs.

const { splitStatements, stripComments, commandOf } = require('../../shared/sql.mjs')

// Make a value safe to send through structured clone and easy to render.
function normalise(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString()
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 64)).toString('hex')
    return `\\x${hex}${v.length > 64 ? '…' : ''} (${v.length} bytes)`
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

// `binary`, when given, collects the indexes of columns holding raw bytes:
// those are shown as a preview string and must never be written back.
function normaliseRows(rows, fields, binary) {
  return rows.map((r) => fields.map((f, i) => {
    const v = Array.isArray(r) ? r[i] : r[f]
    if (binary && v instanceof Uint8Array) binary.add(i)
    return normalise(v)
  }))
}

// Build the ER model from flat column rows ({table, kind, name, type, nullable,
// primary}) and foreign keys. Relations to tables outside the model are dropped.
function erFrom(schema, cols, fks) {
  const tables = new Map()
  for (const c of cols) {
    if (!tables.has(c.table)) tables.set(c.table, { name: c.table, schema, type: c.kind, columns: [] })
    tables.get(c.table).columns.push({ name: c.name, type: c.type, nullable: !!c.nullable, primary: !!c.primary })
  }
  const relations = fks
    .filter((f) => tables.has(f.table) && tables.has(f.refTable) && (!f.refSchema || !schema || f.refSchema === schema))
    .map((f) => ({ name: f.name, from: { table: f.table, columns: f.columns }, to: { table: f.refTable, columns: f.refColumns } }))
  return { schema, tables: [...tables.values()], relations }
}

module.exports = { splitStatements, stripComments, commandOf, normalise, normaliseRows, erFrom }
