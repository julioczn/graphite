// Global app state. Small enough that a reactive object beats a store library.
import { reactive } from 'vue'
import { call, bridge } from './api'
import { t } from './i18n'

let tabSeq = 0
let toastSeq = 0

export const store = reactive({
  connection: null, // { saved, sId, version, database, dialect }
  tables: [],
  schemaMap: {},
  tabs: [],
  activeTabId: null,
  sidebarPanel: 'entities',
  status: null, // { text, detail }
  toasts: [],
  historyVersion: 0,
  savedVersion: 0,
  quickSearch: false,
  tx: { autoCommit: true, open: false, statements: 0 },
  txVersion: 0, // bumped after commit / rollback so open views can reload
  txPrompt: null, // { message, resolve } -> TxDialog
  jobs: [], // backup / restore / export progress, see JobsPanel
  dialog: null, // { type: 'backup' | 'restore' | 'export', ...props }
})

// action: optional { label, run } rendered as a button in the toast.
export function toast(text, kind = 'info', ms = 3200, action = null) {
  const id = ++toastSeq
  store.toasts.push({ id, text, kind, action })
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id)
    if (i >= 0) store.toasts.splice(i, 1)
  }, ms)
}

// Tables of the current database / schema are shown unqualified.
const isCurrentSchema = (schema) => !schema || schema === (store.connection?.schema ?? 'public')

export function tableKey(t) {
  return isCurrentSchema(t.schema) ? t.name : `${t.schema}.${t.name}`
}

// Commit mode is remembered per saved connection (a viewer convenience).
const modeKey = (saved) => `graphite.autoCommit.${saved?.id ?? 'adhoc'}`
function rememberedMode(saved) {
  try {
    return localStorage.getItem(modeKey(saved)) !== 'manual'
  } catch {
    return true
  }
}

const schemaKey = (saved) => `graphite.schema.${saved?.id ?? 'adhoc'}`

export async function openConnection(saved, config) {
  const { tx, ...info } = await call('conn/open', { config, autoCommit: rememberedMode(saved) })
  store.connection = { saved, ...info }
  store.tx = tx
  // AI agents may use this connection as "active" (in a session of their own).
  bridge.ai.setActive({ name: saved?.name || info.database || t('Conexão aberta'), type: config.type, config, savedId: saved?.id ?? null })
  // Reopen on the database / schema picked last time, if it still exists.
  let last = null
  try {
    last = saved?.id ? localStorage.getItem(schemaKey(saved)) : null
  } catch {}
  if (last && last !== info.schema && info.dialect !== 'sqlite') {
    await call('conn/useSchema', { sId: info.sId, schema: last })
      .then((r) => Object.assign(store.connection, r))
      .catch(() => {})
  }
  store.tabs = []
  store.activeTabId = null
  store.sidebarPanel = 'entities'
  if (saved?.id) call('app/touchConnection', { id: saved.id })
  await refreshEntities()
  newQueryTab()
}

export async function closeConnection() {
  if (!store.connection) return
  if (store.tx.open && !(await settleTx(t('Desconectar com uma transação aberta?')))) return
  await call('conn/close', { sId: store.connection.sId }).catch(() => {})
  store.connection = null
  bridge.ai.setActive(null)
  store.tables = []
  store.schemaMap = {}
  store.tabs = []
  store.status = null
}

function txLabel() {
  const n = store.tx.statements
  return n
    ? t('A transação aberta tem {n} alteração sem commit.|A transação aberta tem {n} alterações sem commit.', { n })
    : t('Há uma transação aberta, sem alterações.')
}

// Ask the user to commit or roll back the open transaction. Resolves false
// when they cancel.
export function settleTx(title) {
  return new Promise((resolve) => {
    store.txPrompt = {
      title,
      message: txLabel(),
      resolve: async (choice) => {
        store.txPrompt = null
        if (!choice) return resolve(false)
        try {
          await (choice === 'commit' ? commit() : rollback())
          resolve(true)
        } catch {
          resolve(false)
        }
      },
    }
  })
}

export async function setAutoCommit(on) {
  if (on === store.tx.autoCommit) return
  if (on && store.tx.open && !(await settleTx(t('Mudar para auto-commit?')))) return
  store.tx = await call('tx/setAutoCommit', { sId: store.connection.sId, on })
  try {
    localStorage.setItem(modeKey(store.connection.saved), on ? 'auto' : 'manual')
  } catch {}
  toast(on ? t('Auto-commit ativado') : t('Modo manual: use Commit ou Rollback para encerrar a transação'))
}

async function endTx(action) {
  try {
    store.tx = await call(`tx/${action}`, { sId: store.connection.sId })
    store.txVersion++
    toast(action === 'commit' ? t('Commit realizado') : t('Rollback realizado'), 'success')
  } catch (e) {
    const msg = action === 'commit' ? t('Falha no commit: {error}', { error: e.message }) : t('Falha no rollback: {error}', { error: e.message })
    toast(msg, 'error', 7000)
    store.tx = await call('tx/state', { sId: store.connection.sId }).catch(() => store.tx)
    throw e
  }
}

export const commit = () => endTx('commit')
export const rollback = () => endTx('rollback')

// Switch database (MySQL: USE) or schema (PostgreSQL: search_path).
export async function useSchema(name) {
  const c = store.connection
  if (!c || name === c.schema) return
  if (c.dialect === 'postgres' && store.tx.open && !(await settleTx(t('Trocar de schema?')))) return
  const r = await call('conn/useSchema', { sId: c.sId, schema: name })
  Object.assign(c, r)
  try {
    if (c.saved?.id) localStorage.setItem(schemaKey(c.saved), r.schema)
  } catch {}
  await refreshEntities()
}

// --- long-running jobs ------------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
export { formatBytes }

bridge.onJob((job) => {
  const i = store.jobs.findIndex((j) => j.id === job.id)
  const prev = store.jobs[i]
  if (i >= 0) store.jobs[i] = { ...prev, ...job }
  else store.jobs.push(job)
  if (prev?.state === 'running' && job.state !== 'running') finishJob(job)
})

function finishJob(job) {
  const show = (file) => ({ label: t('Mostrar na pasta'), run: () => bridge.showItem(file) })
  if (job.state === 'error') return toast(t('{title}: falhou', { title: job.title }), 'error', 6000)
  if (job.state === 'cancelled') return toast(t('{title}: cancelado', { title: job.title }), 'info')
  const r = job.result
  if (job.kind === 'backup') toast(`${t('Backup concluído')} · ${t('{n} linha|{n} linhas', { n: r.rows })} · ${formatBytes(r.size)}`, 'success', 8000, show(r.file))
  if (job.kind === 'export') toast(`${t('Exportação concluída')} · ${t('{n} linha|{n} linhas', { n: r.rows })}`, 'success', 8000, show(r.file || r.files[0]))
  if (job.kind === 'restore') {
    toast(`${t('Restore concluído')} · ${t('{n} instrução|{n} instruções', { n: r.statements })}${r.errors.length ? ` · ${t('{n} erro|{n} erros', { n: r.errors.length })}` : ''}`, r.errors.length ? 'error' : 'success', 8000)
    if (store.connection) refreshEntities().catch(() => {})
    store.txVersion++ // open table tabs reload
  }
  // Successful jobs leave the panel on their own; failures stay until dismissed.
  if (!r?.errors?.length) setTimeout(() => dismissJob(job.id), 6000)
}

export async function startJob(handler, args) {
  // Dialog state is reactive (Proxy), which structured clone refuses: send plain data.
  const plain = JSON.parse(JSON.stringify(args))
  const { jobId } = await call(handler, { sId: store.connection.sId, ...plain })
  return jobId
}

export const cancelJob = (id) => call('job/cancel', { jobId: id })
export function dismissJob(id) {
  const i = store.jobs.findIndex((j) => j.id === id && j.state !== 'running')
  if (i >= 0) store.jobs.splice(i, 1)
}

export function openErTab() {
  const c = store.connection
  const scope = c.schema || c.database || t('banco')
  const existing = store.tabs.find((t) => t.type === 'er' && t.scope === scope)
  if (existing) return (store.activeTabId = existing.id)
  addTab({ type: 'er', title: `${t('Diagrama ER')} · ${scope}`, scope })
}

export async function refreshEntities() {
  const sId = store.connection.sId
  // PostgreSQL lists only the chosen schema; MySQL lists the current database.
  store.tables = await call('conn/listTables', { sId, schema: store.connection.schema ?? null })
  store.schemaMap = await call('conn/schemaMap', { sId }).catch(() => ({}))
}

function addTab(tab) {
  tab.id = ++tabSeq
  store.tabs.push(tab)
  store.activeTabId = tab.id
  return tab
}

export function newQueryTab(sql = '', title, savedId = null) {
  const n = store.tabs.filter((t) => t.type === 'query').length + 1
  return addTab({ type: 'query', title: title || t('Consulta #{n}', { n }), sql, savedId, dirty: false })
}

export function openTableTab(table, view = 'data') {
  const existing = store.tabs.find((t) => t.type === 'table' && t.table === table.name && t.schema === table.schema)
  if (existing) {
    existing.view = view
    store.activeTabId = existing.id
    return existing
  }
  return addTab({ type: 'table', title: tableKey(table), table: table.name, schema: table.schema, kind: table.type, view })
}

export function closeTab(id) {
  const i = store.tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  store.tabs.splice(i, 1)
  if (store.activeTabId === id) {
    const next = store.tabs[i] || store.tabs[i - 1]
    store.activeTabId = next ? next.id : null
  }
}

export function selectSql(table) {
  const d = store.connection?.dialect
  const q = (s) => (d === 'mysql' ? '`' + s + '`' : `"${s}"`)
  const name = isCurrentSchema(table.schema) ? q(table.name) : `${q(table.schema)}.${q(table.name)}`
  return `select *\nfrom ${name}\nlimit 100;`
}
