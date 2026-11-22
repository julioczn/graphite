// SQL run on behalf of an AI agent (MCP clients or the built-in assistant).
//
// Two layers keep an agent from changing data without the user's approval:
//  1. classify(): only statements whose command is a known read go down the
//     read path; anything else (or anything unrecognised) needs approval.
//  2. The read path runs inside a read-only mode the *database* enforces
//     (READ ONLY transaction / PRAGMA query_only), so a write hidden in a read
//     (`WITH … DELETE`, a function with side effects, EXPLAIN ANALYZE of a
//     DELETE) fails instead of running.
// Approved writes run in one transaction, so a failing statement undoes the
// earlier ones (except MySQL DDL, which commits implicitly).
const { splitStatements, commandOf } = require('./sql.cjs')
const { t } = require('../../shared/i18n.mjs')

const READ = {
  postgres: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'EXPLAIN', 'SHOW']),
  mysql: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC']),
  sqlite: new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN', 'PRAGMA']),
  // EXPLAIN PLAN writes to PLAN_TABLE in Oracle; SQL Server has no EXPLAIN.
  mssql: new Set(['SELECT', 'WITH']),
  oracle: new Set(['SELECT', 'WITH']),
  clickhouse: new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'EXISTS']),
  trino: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'DESCRIBE', 'EXPLAIN']),
  // EXECUTE BLOCK can write: not a read.
  firebird: new Set(['SELECT', 'WITH']),
  duckdb: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'FROM', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'SUMMARIZE']),
}
// Statements that return rows and can be read in batches (cursor / iterator /
// sql_select_limit), so a huge result never has to fit in memory.
const ROW_QUERIES = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])
// PRAGMAs that do work even without an assignment.
const SQLITE_ACTIVE_PRAGMAS = /^\s*pragma\s+(\w+\.)?(optimize|wal_checkpoint|incremental_vacuum|shrink_memory)\b/i
const READ_TIMEOUT_MS = 30000

// caps.aiReadOnly = false: the engine has no read-only mode we can rely on,
// so nothing counts as a read and every statement needs approval.
function classify(sql, dialect, caps) {
  const guarded = caps?.aiReadOnly !== false
  const statements = splitStatements(sql, dialect).map((st) => {
    const command = commandOf(st.text)
    let read = READ[dialect]?.has(command) ?? false
    let why = read ? null : command ? t('{command} altera o banco ou não é reconhecido como leitura', { command }) : t('instrução não reconhecida')
    if (read && !guarded) {
      read = false
      why = t('este banco não garante um modo somente leitura, então toda consulta precisa de aprovação')
    }
    if (read && dialect === 'mysql' && /\binto\s+(outfile|dumpfile)\b/i.test(st.text)) {
      read = false
      why = t('SELECT … INTO OUTFILE grava um arquivo no servidor')
    }
    // SELECT … INTO creates a table in SQL Server.
    if (read && dialect === 'mssql' && /\binto\s+[\[#@\w"]/i.test(stripStrings(st.text))) {
      read = false
      why = t('SELECT … INTO cria uma tabela')
    }
    if (read && dialect === 'sqlite' && command === 'PRAGMA' && (/=/.test(st.text) || SQLITE_ACTIVE_PRAGMAS.test(st.text))) {
      read = false
      why = t('PRAGMA com efeito')
    }
    return { sql: st.text.trim(), command, read, why }
  })
  return { statements, read: statements.every((s) => s.read) }
}

// Run fn with the connection in a database-enforced read-only mode.
async function readOnly(d, fn) {
  // Drivers with their own mechanism (e.g. LibSQL's read transactions).
  if (typeof d.readOnly === 'function') return d.readOnly(fn, READ_TIMEOUT_MS)
  if (d.dialect === 'postgres') {
    await d.execute('begin read only')
    try {
      await d.execute(`set local statement_timeout = ${READ_TIMEOUT_MS}`)
      return await fn()
    } finally {
      await d.execute('rollback').catch(() => {})
    }
  }
  if (d.dialect === 'mysql') {
    // Session-level, so it also covers statements MySQL runs outside the
    // transaction (DDL commits implicitly, then fails as read-only).
    // MariaDB names the timeout max_statement_time (seconds); MySQL and TiDB
    // use max_execution_time (ms). The flavor comes from the server version.
    const timeout = d.flavor === 'mariadb'
      ? [`set session max_statement_time = ${READ_TIMEOUT_MS / 1000}`, 'set session max_statement_time = 0']
      : [`set session max_execution_time = ${READ_TIMEOUT_MS}`, 'set session max_execution_time = 0']
    // Every setup step is inside the try: if one fails half-way, the finally
    // still puts the session back to read-write.
    try {
      await d.execute('set session transaction read only')
      await d.execute(timeout[0])
      await d.execute('start transaction read only')
      return await fn()
    } finally {
      await d.execute('rollback').catch(() => {})
      await d.execute('set session transaction read write').catch(() => {})
      await d.execute(timeout[1]).catch(() => {})
      await d.execute('set session sql_select_limit = default').catch(() => {})
    }
  }
  try {
    await d.execute('pragma query_only = 1')
    return await fn()
  } finally {
    await d.execute('pragma query_only = 0').catch(() => {})
  }
}

// Rough removal of string literals, so a keyword inside quotes doesn't count.
const stripStrings = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''")

// First `limit` rows of a row-returning statement without reading the rest.
async function firstRows(d, sql, limit) {
  if (d.firstRows) return d.firstRows(sql, limit)
  if (d.dialect === 'mysql') {
    await d.execute(`set session sql_select_limit = ${limit}`)
    return d.execute(sql)
  }
  if (d.dialect === 'postgres' && !d.caps?.cursors) return d.execute(sql)
  for await (const batch of d.stream(sql, { batch: limit })) return batch
  return { fields: [], rows: [] }
}

function shape(st, r, maxRows, ms) {
  if (!r.fields) return { sql: st.sql, command: st.command, affected: r.affected, ms }
  const truncated = r.rows.length > maxRows
  return {
    sql: st.sql,
    command: st.command,
    columns: r.fields,
    rows: truncated ? r.rows.slice(0, maxRows) : r.rows,
    truncated,
    ms,
  }
}

// mode 'read': refuses (needsApproval) unless every statement is a read.
// mode 'write': the caller already has the user's approval.
async function run(d, sql, { mode = 'read', maxRows = 200 } = {}) {
  const plan = classify(sql, d.dialect, d.caps)
  if (!plan.statements.length) throw new Error(t('Nenhuma instrução SQL'))
  if (mode === 'read' && !plan.read) return { needsApproval: true, statements: plan.statements }
  maxRows = Math.max(1, Math.min(Number(maxRows) || 200, 5000))
  const results = []
  const each = async (fetch) => {
    for (const st of plan.statements) {
      const t0 = performance.now()
      try {
        const r = await fetch(st)
        results.push(shape(st, r, maxRows, Math.round(performance.now() - t0)))
      } catch (e) {
        results.push({ sql: st.sql, command: st.command, error: e.message })
        throw e
      }
    }
  }
  try {
    if (mode === 'read') {
      await readOnly(d, () => each((st) => (ROW_QUERIES.has(st.command) ? firstRows(d, st.sql, maxRows + 1) : d.execute(st.sql))))
    } else if (d.caps?.transactions === false) {
      await each((st) => d.execute(st.sql))
    } else {
      await d.transaction(() => each((st) => d.execute(st.sql)))
    }
  } catch (e) {
    // The failing statement is already in `results` with its error; a
    // failure outside any statement (BEGIN, SET) is reported on its own.
    if (!results.some((r) => r.error)) results.push({ error: e.message })
    return { results, failed: true, rolledBack: mode === 'write' && d.caps?.transactions !== false }
  }
  return { results }
}

module.exports = { classify, run, readOnly }
