// Export whole tables or a whole query result to CSV / JSON / JSON Lines / SQL.
// Rows are streamed from a cursor, so there is no row limit and memory stays flat.
const path = require('node:path')
const fs = require('node:fs')
const { createWriter, writeRows } = require('./dump.cjs')
const { t } = require('../../shared/i18n.mjs')

const EXT = { csv: 'csv', json: 'json', jsonl: 'jsonl', sql: 'sql' }

// Driver values -> something JSON can carry without losing information.
function plain(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (v instanceof Uint8Array) return '\\x' + Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString()
  return v
}

function csvCell(v, o) {
  const p = plain(v)
  if (p === null) return o.nullAs
  const s = typeof p === 'object' ? JSON.stringify(p) : String(p)
  return s.includes(o.delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function writeOne(d, out, job, source, o) {
  if (o.format === 'sql') {
    // Literal values exactly as the server prints them.
    await writeRows(d, out, job, { from: `(${source.sql.replace(/[\s;]+$/, '')}) graphite_export`, target: source.target }, job.rows)
    return
  }
  let first = true
  let fields = null
  for await (const batch of d.stream(source.sql, { batch: 1000, raw: true })) {
    job.check()
    if (!fields) {
      fields = batch.fields
      if (o.format === 'csv') {
        if (o.bom) await out.write('﻿')
        if (o.header) await out.write(fields.map((f) => csvCell(f, o)).join(o.delimiter) + '\r\n')
      }
      if (o.format === 'json') await out.write('[')
    }
    let chunk = ''
    for (const row of batch.rows) {
      if (o.format === 'csv') chunk += row.map((v) => csvCell(v, o)).join(o.delimiter) + '\r\n'
      else {
        const obj = {}
        fields.forEach((f, i) => { obj[f] = plain(row[i]) })
        const json = JSON.stringify(obj)
        chunk += o.format === 'jsonl' ? json + '\n' : `${first ? '\n  ' : ',\n  '}${json}`
        first = false
      }
    }
    if (chunk) await out.write(chunk)
    job.rows(batch.rows.length)
  }
  if (o.format === 'json') await out.write(first ? ']\n' : '\n]\n')
}

// opts: { format, file | dir, tables: [{ name, schema, where }] | query, sqlTable,
//         csv: { delimiter, header, nullAs, bom } }
async function exportData(d, opts, job) {
  const o = { format: opts.format, delimiter: ',', header: true, nullAs: '', bom: false, ...(opts.csv || {}) }
  if (!EXT[o.format]) throw new Error(t('Formato desconhecido: {format}', { format: o.format }))
  if (d.beginSnapshot) await d.beginSnapshot()

  // selectList: drivers that must read some column types as text to keep
  // them exact (SQL Server decimals) list the columns themselves.
  const tableSources = []
  for (const t of opts.tables || []) tableSources.push({ ...t, cols: d.selectList ? await d.selectList(t.name, t.schema) : '*' })
  const sources = opts.query
    ? [{ name: path.basename(opts.file), sql: opts.query, target: d.quote(opts.sqlTable || 'resultado'), file: opts.file }]
    : tableSources.map((t) => ({
      name: t.name,
      sql: `select ${t.cols} from ${d.qualified(t.name, t.schema)}${t.where?.trim() ? ` where ${t.where}` : ''}`,
      target: d.qualified(t.name, d.dialect === 'postgres' ? t.schema : null),
      file: opts.tables.length === 1 && opts.file ? opts.file : path.join(opts.dir, `${t.name}.${EXT[o.format]}`),
    }))
  if (opts.dir) await fs.promises.mkdir(opts.dir, { recursive: true })
  job.plan(sources, {})

  const files = []
  for (const src of sources) {
    job.table(src.name)
    const out = createWriter(src.file, false)
    try {
      await writeOne(d, out, job, src, o)
      await out.close()
    } catch (e) {
      await out.abort().catch(() => {})
      throw e
    }
    files.push(src.file)
  }
  return { files, rows: job.totalRows, dir: opts.dir || null, file: files.length === 1 ? files[0] : null }
}

module.exports = { exportData }
