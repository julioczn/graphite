// Replay a SQL script (plain or .gz) statement by statement.
//
// The file is never loaded whole: StatementSplitter consumes chunks and emits
// complete statements, tracking quotes, comments, PostgreSQL dollar quotes and
// the mysql client's DELIMITER directive (used around routine bodies).
const fs = require('node:fs')
const zlib = require('node:zlib')
const { t } = require('../../shared/i18n.mjs')

class StatementSplitter {
  constructor(dialect) {
    this.dialect = dialect
    this.buf = '' // text of the statement still being read
    this.pos = 0 // scan position inside buf
    this.state = null // null | "'" | '"' | '`' | '--' | '/*' | '$tag$'
    this.esc = false // backslash escapes active in the current quote
    this.delimiter = ';'
    this.atStart = true // only whitespace / comments since the last statement
  }

  // Feed text, get back the statements it completes. Iterative and index based:
  // a 1 MB chunk of small INSERTs must not recurse or copy per statement.
  push(text) {
    const b = this.buf + text
    const mysql = this.dialect === 'mysql'
    const out = []
    let start = 0
    let i = this.pos
    scan: while (i < b.length) {
      const c = b[i]
      const st = this.state
      if (st === null) {
        if (this.atStart && (c === ' ' || c === '\t' || c === '\r' || c === '\n')) { i++; continue }
        if ((c === '-' || c === '/') && i + 1 >= b.length) break // maybe the start of a comment
        if (c === '-' && b[i + 1] === '-') {
          if (i + 2 >= b.length) break
          if (!mysql || /\s/.test(b[i + 2])) { this.state = '--'; i += 2; continue }
        }
        if (c === '#' && mysql) { this.state = '--'; i++; continue }
        if (c === '/' && b[i + 1] === '*') {
          if (i + 2 >= b.length) break
          // MySQL /*! ... */ is executable text, not a comment.
          if (!(mysql && b[i + 2] === '!')) { this.state = '/*'; i += 2; continue }
        }
        // DELIMITER and psql meta-commands are client directives on their own line.
        if (this.atStart && ((mysql && (c === 'D' || c === 'd')) || c === '\\')) {
          const nl = b.indexOf('\n', i)
          if (nl < 0) break // wait for the whole line
          const line = b.slice(i, nl).trim()
          const m = mysql && /^delimiter\s+(\S+)$/i.exec(line)
          if (m || c === '\\') {
            if (m) this.delimiter = m[1]
            else out.push({ meta: line })
            start = i = nl + 1
            continue
          }
        }
        this.atStart = false
        if (c === "'" || c === '"' || (c === '`' && mysql)) {
          this.state = c
          this.esc = mysql ? c !== '`' : c === "'" && /[Ee]/.test(b[i - 1] || '') && !/\w/.test(b[i - 2] || ' ')
          i++
          continue
        }
        if (c === '$' && this.dialect === 'postgres' && !/\w/.test(b[i - 1] || ' ')) {
          const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(b.slice(i, i + 64))
          if (m) { this.state = m[0]; i += m[0].length; continue }
          if (b.length - i < 64 && !b.slice(i + 1).includes('$')) break // tag may continue in the next chunk
        }
        if (c === this.delimiter[0]) {
          if (i + this.delimiter.length > b.length) break
          if (b.startsWith(this.delimiter, i)) {
            const stmt = b.slice(start, i).trim()
            if (stmt && !onlyComments(stmt, mysql)) out.push({ text: stmt })
            start = i = i + this.delimiter.length
            this.atStart = true
            continue scan
          }
        }
        i++
      } else if (st === '--') {
        const nl = b.indexOf('\n', i)
        if (nl < 0) { i = b.length; break }
        this.state = null
        i = nl + 1
        if (this.atStart) start = i // leading comments are not part of the statement
      } else if (st === '/*') {
        const end = b.indexOf('*/', i)
        if (end < 0) { i = Math.max(i, b.length - 1); break }
        this.state = null
        i = end + 2
        if (this.atStart) start = i
      } else if (st.length === 1) {
        if (c === '\\' && this.esc) { i += 2; continue }
        if (c === st) {
          if (i + 1 >= b.length) break // could be a doubled quote split across chunks
          if (b[i + 1] === st) { i += 2; continue }
          this.state = null
        }
        i++
      } else {
        const end = b.indexOf(st, i)
        if (end < 0) { i = Math.max(i, b.length - st.length); break }
        this.state = null
        i = end + st.length
      }
    }
    this.buf = b.slice(start)
    this.pos = i - start
    return out
  }

  // Whatever is left once the input ends.
  end() {
    const text = this.buf.trim()
    this.buf = ''
    this.pos = 0
    if (!text || onlyComments(text, this.dialect === 'mysql')) return []
    if (/^delimiter\s+\S+$/i.test(text) || text.startsWith('\\')) return [{ meta: text }]
    return [{ text }]
  }
}

function onlyComments(text, mysql) {
  if (mysql && text.includes('/*!')) return false
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(mysql ? /(--\s|#).*$/gm : /--.*$/gm, '')
    .trim()
  return stripped === ''
}

// opts: { file, transaction, stopOnError }
async function restore(d, opts, job) {
  const { size } = await fs.promises.stat(opts.file)
  const raw = fs.createReadStream(opts.file, { highWaterMark: 1 << 20 })
  const gz = opts.file.endsWith('.gz')
  const input = gz ? raw.pipe(zlib.createGunzip()) : raw
  input.setEncoding('utf8')
  const splitter = new StatementSplitter(d.dialect)
  const errors = []
  let statements = 0
  let skipped = 0
  let inTx = false

  if (d.dialect === 'sqlite') d.db.exec('PRAGMA foreign_keys = OFF') // no-op inside a transaction, so before BEGIN
  if (opts.transaction) {
    await d.execute(d.dialect === 'mysql' ? 'start transaction' : 'begin')
    inTx = true
  }

  const runOne = async (st) => {
    if (st.meta) {
      skipped++
      return
    }
    if (/^copy\s[\s\S]*\sfrom\s+stdin/i.test(st.text)) {
      throw new Error(t('Este arquivo usa COPY ... FROM stdin (formato do pg_dump). Gere o dump com --inserts ou use o backup do Graphite.'))
    }
    job.check()
    try {
      await d.execute(st.text)
      statements++
    } catch (e) {
      const err = { message: e.message, sql: st.text.length > 400 ? st.text.slice(0, 400) + '…' : st.text }
      if (opts.stopOnError || inTx) throw Object.assign(new Error(e.message), { detail: err })
      if (errors.length < 200) errors.push(err)
    }
  }

  try {
    for await (const chunk of input) {
      for (const st of splitter.push(chunk)) await runOne(st)
      job.progress({ done: raw.bytesRead, total: size, statements, errors: errors.length })
    }
    for (const st of splitter.end()) await runOne(st)
    if (inTx) await d.execute('commit')
    inTx = false
  } catch (e) {
    raw.destroy()
    if (inTx) await d.execute('rollback').catch(() => {})
    if (e.detail) {
      const where = '\n\n' + t('Instrução {n}:', { n: statements + 1 }) + '\n' + e.detail.sql
      throw new Error(`${e.message}${inTx || opts.transaction ? ' ' + t('(nada foi gravado: a transação foi desfeita)') : ''}${where}`)
    }
    throw e
  } finally {
    if (d.dialect === 'sqlite') d.db.exec('PRAGMA foreign_keys = ON')
  }
  return { statements, errors, skipped }
}

module.exports = { restore, StatementSplitter }
