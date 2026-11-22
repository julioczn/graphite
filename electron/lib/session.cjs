// One open connection plus its transaction state.
//
// Auto-commit: every statement commits on its own (driver default).
// Manual: the first statement opens a transaction that stays open until
// commit()/rollback(). Where the engine has savepoints in the PostgreSQL sense
// (caps.savepoints) each statement runs inside one, so an error does not abort
// the whole transaction. MySQL uses `autocommit = 0` so the server itself keeps
// a transaction open even after implicit commits. Engines without a manual
// mode (caps.manualMode = false) only run in auto-commit.
const { commandOf } = require('./sql.cjs')
const { t } = require('../../shared/i18n.mjs')

const TX_CONTROL = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'SAVE'])

// Transaction statements; drivers whose engine spells them differently
// (SQL Server's SAVE TRANSACTION, Oracle's implicit BEGIN) override driver.txSql.
const DEFAULT_TX = {
  begin: 'begin',
  commit: 'commit',
  rollback: 'rollback',
  savepoint: (n) => `savepoint ${n}`,
  rollbackTo: (n) => `rollback to savepoint ${n}`,
  release: (n) => `release savepoint ${n}`,
}
const txSql = (d) => ({ ...DEFAULT_TX, ...(d.txSql || {}) })
const MYSQL_IMPLICIT_COMMIT = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME', 'TRUNCATE', 'GRANT', 'REVOKE', 'LOCK', 'UNLOCK'])
const DDL = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME', 'TRUNCATE'])

class Session {
  constructor(driver) {
    this.driver = driver
    this.autoCommit = true
    this.inTx = false
    this.txStatements = 0 // statements that changed something (row-returning ones are not counted)
    this.pkCache = new Map()
    this.queue = Promise.resolve()
  }

  get tx() {
    return { autoCommit: this.autoCommit, open: this.inTx, statements: this.txStatements }
  }

  // Serialise multi-step work (savepoints, apply) on the single connection.
  lock(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async ensureTx() {
    if (this.inTx) return
    const begin = txSql(this.driver).begin
    // Oracle has no BEGIN: the driver just stops auto-committing (beginTx).
    if (this.driver.beginTx) await this.driver.beginTx()
    else if (this.driver.dialect !== 'mysql' && begin) await this.driver.execute(begin)
    this.inTx = true
  }

  async savepoint(name, fn) {
    const d = this.driver
    const sql = txSql(d)
    // Engines without savepoints (DuckDB): run inside the open transaction as is.
    if (!sql.savepoint) return fn()
    await d.execute(sql.savepoint(name))
    try {
      const out = await fn()
      if (sql.release) await d.execute(sql.release(name))
      return out
    } catch (e) {
      await d.execute(sql.rollbackTo(name)).catch(() => {})
      if (sql.release) await d.execute(sql.release(name)).catch(() => {})
      throw e
    }
  }

  // Run reads issued by the app itself, isolated from an open PG transaction.
  guarded(fn) {
    return this.lock(() => (this.inTx && this.driver.caps.savepoints ? this.savepoint('graphite_read', fn) : fn()))
  }

  // Run one statement typed by the user, honouring the commit mode.
  async run(text) {
    const d = this.driver
    const cmd = commandOf(text)
    const control = TX_CONTROL.has(cmd)
    if (!control && !this.autoCommit) await this.ensureTx()

    const exec = () => d.execute(text, [], { origins: true })
    let r
    try {
      r = !control && this.inTx && d.caps.savepoints ? await this.savepoint('graphite_stmt', exec) : await exec()
    } catch (e) {
      // MySQL rolls back the whole transaction on deadlock.
      if (d.dialect === 'mysql' && e.errno === 1213) this.resetTx()
      throw e
    }

    if (DDL.has(cmd)) this.pkCache.clear()
    if (control) this.trackControl(cmd, text)
    else if (this.inTx) {
      if (d.dialect === 'mysql' && MYSQL_IMPLICIT_COMMIT.has(cmd)) this.resetTx()
      else if (!r.fields) this.txStatements++
    }
    return r
  }

  trackControl(cmd, text) {
    if (cmd === 'BEGIN' || cmd === 'START') this.inTx = true
    else if (cmd === 'COMMIT' || cmd === 'END') this.resetTx()
    else if (cmd === 'ROLLBACK' && !/^\s*rollback\s+(work\s+)?to\b/i.test(text)) this.resetTx()
  }

  resetTx() {
    this.inTx = false
    this.txStatements = 0
  }

  // Run fn atomically: its own transaction in auto-commit mode, a savepoint
  // inside the open transaction in manual mode.
  async atomic(fn, statements = 1) {
    if (!this.driver.caps.transactions) throw new Error(t('Este banco não suporta transações; a edição pela grade está desativada'))
    if (this.autoCommit && !this.inTx) return this.driver.transaction(fn)
    await this.ensureTx()
    const out = await this.savepoint('graphite_apply', fn)
    this.txStatements += statements
    return out
  }

  async commit() {
    if (this.inTx || this.driver.dialect === 'mysql') await this.driver.execute(txSql(this.driver).commit)
    this.resetTx()
  }

  async rollback() {
    if (this.inTx || this.driver.dialect === 'mysql') await this.driver.execute(txSql(this.driver).rollback)
    this.resetTx()
  }

  async setAutoCommit(on) {
    if (on === this.autoCommit) return
    if (on && this.inTx) throw new Error(t('Há uma transação aberta: faça commit ou rollback antes'))
    if (!on && !this.driver.caps.manualMode) throw new Error(t('Este banco não suporta transações manuais'))
    if (this.driver.dialect === 'mysql') await this.driver.execute(`set autocommit = ${on ? 1 : 0}`)
    this.autoCommit = on
  }

  async primaryKey(table, schema) {
    const key = `${schema ?? ''}.${table}`
    if (!this.pkCache.has(key)) {
      const cols = await this.driver.listColumns(table, schema ?? undefined).catch(() => [])
      this.pkCache.set(key, cols.filter((c) => c.primary).map((c) => c.name))
    }
    return this.pkCache.get(key)
  }

  // Work out which result columns can be written back. A column is editable
  // when it comes straight from a table whose whole primary key is also in
  // the result. Returns null when nothing is editable.
  async editInfo(fields, origins) {
    if (!origins || !origins.some(Boolean)) return null
    const tables = []
    const tableIndex = new Map()
    for (const o of origins) {
      if (!o) continue
      const key = `${o.schema ?? ''}.${o.table}`
      if (tableIndex.has(key)) continue
      const pkNames = await this.primaryKey(o.table, o.schema)
      if (!pkNames.length) continue
      const pk = []
      for (const name of pkNames) {
        const index = origins.findIndex((x) => x && x.table === o.table && x.schema === o.schema && x.column === name)
        if (index < 0) break
        pk.push({ column: name, index })
      }
      if (pk.length !== pkNames.length) continue
      tableIndex.set(key, tables.length)
      tables.push({ table: o.table, schema: o.schema ?? null, pk })
    }
    if (!tables.length) return null
    const columns = origins.map((o) => {
      const t = o && tableIndex.get(`${o.schema ?? ''}.${o.table}`)
      return t === undefined || !o ? null : { table: t, column: o.column }
    })
    return { tables, columns }
  }
}

module.exports = { Session }
