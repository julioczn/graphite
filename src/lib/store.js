// Global app state. Small enough that a reactive object beats a store library.
//
// Every open connection is a session (see newSession) with its own tables,
// tabs and transaction state. One or two sessions are on screen at a time
// (`panes`, side by side); `focus` is the pane the user is working in.
// Components inside a pane get their session with useSession(); code that
// only runs on user input (helpers, menus) may use store.session, the
// focused one.
import { reactive, watch, effectScope, provide, inject } from 'vue'
import { call, bridge } from './api'
import { t } from './i18n'
import { touched } from './workspaces'

let tabSeq = 0
let toastSeq = 0

// Rows a query result shows (the rest is counted, not kept). Per machine.
export const ROW_LIMITS = [100, 500, 1000, 5000, 10000, 50000]

export const store = reactive({
  sessions: [],
  panes: [], // session keys on screen, left to right (one or two)
  focus: 0, // index in panes
  split: 50, // left pane width (%) when side by side
  picker: null, // { pane } while the connection screen is open over the sessions
  toasts: [],
  historyVersion: 0,
  savedVersion: 0,
  jobs: [], // backup / restore / export progress, see JobsPanel
  rowLimit: storedLimit(), // rows a query shows, see setRowLimit
  shortcuts: false, // ShortcutsDialog open
  get session() {
    return this.sessions.find((s) => s.key === this.panes[this.focus]) || null
  },
  get connection() {
    return this.session?.connection ?? null
  },
})

// --- query row limit ---------------------------------------------------------------
function storedLimit() {
  try {
    const n = Number(localStorage.getItem('graphite.rowLimit'))
    return ROW_LIMITS.includes(n) ? n : 100
  } catch {
    return 100
  }
}
export function setRowLimit(n) {
  if (!ROW_LIMITS.includes(n)) return
  store.rowLimit = n
  try {
    localStorage.setItem('graphite.rowLimit', String(n))
  } catch {}
}

// --- sessions ----------------------------------------------------------------------
const SESSION = Symbol('session')
export const provideSession = (s) => provide(SESSION, s)
export const useSession = () => inject(SESSION)

const extra = new Map() // key -> { ai, scope }: plain data kept out of the reactive state

function newSession(saved, info, tx) {
  return reactive({
    key: info.sId,
    connection: { saved, ...info }, // { saved, sId, version, database, schema, dialect, engine, caps }
    tables: [],
    schemaMap: {},
    tabs: [],
    activeTabId: null,
    sidebarPanel: 'entities',
    tx,
    txVersion: 0, // bumped after commit / rollback so open views can reload
    txPrompt: null, // { title, message, resolve } -> TxDialog
    quickSearch: false,
    dialog: null, // { type: 'backup' | 'restore' | 'export', ...props }
    persist: false, // its tabs are saved with the connection (one session per saved connection)
  })
}

export const sessionBySId = (sId) => store.sessions.find((s) => s.key === sId) || null
export const isFocused = (s) => store.panes[store.focus] === s?.key

// Put a session on screen in pane `pane` (0 left, 1 right; 1 splits the
// window). A session already on screen just gets the focus.
export function showSession(key, pane = store.focus) {
  const at = store.panes.indexOf(key)
  if (at >= 0) return void (store.focus = at)
  if (pane >= store.panes.length) {
    store.panes.push(key)
    store.focus = store.panes.length - 1
  } else {
    store.panes[pane] = key
    store.focus = pane
  }
}

export const focusPane = (i) => {
  if (i !== store.focus && i < store.panes.length) store.focus = i
}

// Side by side on / off. Opening it shows a connection that is open but not
// on screen, or the connection screen to pick one for the right side.
export function toggleSplit() {
  if (store.panes.length > 1) {
    store.panes = [store.panes[store.focus]]
    store.focus = 0
    return
  }
  const spare = store.sessions.findLast((s) => !store.panes.includes(s.key))
  if (spare) showSession(spare.key, 1)
  else store.picker = { pane: 1 }
}

export function newConnectionPicker(pane = store.focus) {
  store.picker = { pane }
}

// The assistant works on the focused connection ("active").
watch(() => store.session?.key ?? null, (key) => {
  bridge.ai.setActive(key ? extra.get(key)?.ai ?? null : null)
})

// toast(text, kind, ms, action): action is an optional { label, run } button.
export function toast(text, kind = 'info', ms = 3200, action = null) {
  const id = ++toastSeq
  store.toasts.push({ id, text, kind, action })
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id)
    if (i >= 0) store.toasts.splice(i, 1)
  }, ms)
}

// Tables of the current database / schema are shown unqualified.
const isCurrentSchema = (schema, s = store.session) => !schema || schema === (s?.connection?.schema ?? 'public')

export function tableKey(t, s = store.session) {
  return isCurrentSchema(t.schema, s) ? t.name : `${t.schema}.${t.name}`
}

// Commit mode and the last database / schema are remembered per saved
// connection, in its workspace (they travel with it). Older versions kept
// them in localStorage: still read as a fallback.
const modeKey = (saved) => `graphite.autoCommit.${saved?.id ?? 'adhoc'}`
const schemaKey = (saved) => `graphite.schema.${saved?.id ?? 'adhoc'}`
function legacy(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function rememberedMode(saved) {
  if (typeof saved?.prefs?.autoCommit === 'boolean') return saved.prefs.autoCommit
  return legacy(modeKey(saved)) !== 'manual'
}
function setPref(saved, prefs) {
  if (!saved?.id) return
  saved.prefs = { ...(saved.prefs || {}), ...prefs }
  call('app/setConnPrefs', { id: saved.id, prefs }).then(() => touched()).catch(() => {})
}

// --- open tabs, saved per connection ------------------------------------------------
const tabState = (s) => (tab) =>
  tab.type === 'query'
    ? { type: 'query', title: tab.title, sql: tab.sql, savedId: tab.savedId ?? null, active: tab.id === s.activeTabId || undefined }
    : tab.type === 'table'
      ? { type: 'table', title: tab.title, table: tab.table, schema: tab.schema ?? null, kind: tab.kind, view: tab.view, active: tab.id === s.activeTabId || undefined }
      : { type: 'er', title: tab.title, scope: tab.scope, active: tab.id === s.activeTabId || undefined }
function flushTabs(s) {
  const x = extra.get(s.key)
  if (x) clearTimeout(x.timer)
  const id = s.connection.saved?.id
  if (!id || !s.persist) return
  const tabs = s.tabs.filter((x) => ['query', 'table', 'er'].includes(x.type)).map(tabState(s))
  s.connection.saved.tabs = tabs
  call('app/setConnTabs', { id, tabs }).catch(() => {})
}
function watchTabs(s) {
  const x = extra.get(s.key)
  x.scope = effectScope(true)
  x.scope.run(() =>
    watch(() => [s.tabs.map(tabState(s)), s.activeTabId], () => {
      clearTimeout(x.timer)
      x.timer = setTimeout(() => flushTabs(s), 800)
    }, { deep: true }),
  )
}
window.addEventListener('beforeunload', () => store.sessions.forEach(flushTabs))

function restoreTabs(s, saved) {
  const list = Array.isArray(saved?.tabs) ? saved.tabs : []
  let active = null
  for (const x of list) {
    const tab =
      x.type === 'query' ? addTab(s, { type: 'query', title: x.title, sql: x.sql || '', savedId: x.savedId ?? null, dirty: false })
      : x.type === 'table' ? addTab(s, { type: 'table', title: x.title, table: x.table, schema: x.schema ?? null, kind: x.kind, view: x.view || 'data' })
      : x.type === 'er' ? addTab(s, { type: 'er', title: x.title, scope: x.scope })
      : null
    if (tab && x.active) active = tab.id
  }
  if (active) s.activeTabId = active
  return s.tabs.length > 0
}

// What the session's engine supports (shared/engines.mjs).
export const caps = (s = store.session) => s?.connection?.caps || {}

// Open a connection in a new session, shown in `pane` (by default the one
// the connection screen was opened for, else the focused one).
export async function openConnection(saved, config, pane = store.picker?.pane ?? store.focus) {
  const { tx, ...info } = await call('conn/open', { config, autoCommit: rememberedMode(saved) })
  const s = newSession(saved, info, tx)
  extra.set(s.key, { ai: { name: saved?.name || info.database || t('Conexão aberta'), type: config.type, config, savedId: saved?.id ?? null } })
  try {
    // Reopen on the database / schema picked last time, if it still exists.
    const last = saved?.id ? saved.prefs?.schema || legacy(schemaKey(saved)) : null
    if (last && last !== info.schema && info.dialect !== 'sqlite') {
      await call('conn/useSchema', { sId: info.sId, schema: last })
        .then((r) => Object.assign(s.connection, r))
        .catch(() => {})
    }
    if (saved?.id) call('app/touchConnection', { id: saved.id })
    await refreshEntities(s)
  } catch (e) {
    extra.delete(s.key)
    call('conn/close', { sId: s.key }).catch(() => {})
    throw e
  }
  // The tabs left open last time (on this or another machine), else a blank
  // query. A second session on the same saved connection starts blank and
  // doesn't save its tabs.
  s.persist = !!saved?.id && !store.sessions.some((x) => x.connection.saved?.id === saved.id)
  if (!(s.persist && restoreTabs(s, saved))) newQueryTab(s)
  store.sessions.push(s)
  showSession(s.key, Math.min(pane, store.panes.length))
  store.picker = null
  if (s.persist) watchTabs(s)
  return s
}

// Close a session (asks about an open transaction first). Resolves false
// when the user cancels.
export async function closeConnection(s = store.session) {
  if (!s) return false
  if (s.tx.open && !(await settleTx(s, t('Desconectar com uma transação aberta?')))) return false
  flushTabs(s)
  await call('conn/close', { sId: s.key }).catch(() => {})
  dropSession(s)
  return true
}

function dropSession(s) {
  extra.get(s.key)?.scope?.stop()
  extra.delete(s.key)
  const i = store.sessions.indexOf(s)
  if (i >= 0) store.sessions.splice(i, 1)
  const p = store.panes.indexOf(s.key)
  if (p < 0) return
  // Alone on screen: the next open connection takes its place. Side by side:
  // the other pane takes the whole window.
  const spare = store.panes.length === 1 && store.sessions.findLast((x) => !store.panes.includes(x.key))
  if (spare) store.panes[p] = spare.key
  else {
    store.panes.splice(p, 1)
    store.focus = Math.max(0, Math.min(store.focus, store.panes.length - 1))
  }
}

// The database process restarted: every session is gone.
export function dropAllSessions() {
  for (const s of [...store.sessions]) dropSession(s)
  store.picker = null
}

function txLabel(s) {
  const n = s.tx.statements
  return n
    ? t('A transação aberta tem {n} alteração sem commit.|A transação aberta tem {n} alterações sem commit.', { n })
    : t('Há uma transação aberta, sem alterações.')
}

// Ask the user to commit or roll back the session's open transaction.
// Resolves false when they cancel.
export function settleTx(s, title) {
  showSession(s.key)
  return new Promise((resolve) => {
    s.txPrompt = {
      title,
      message: txLabel(s),
      resolve: async (choice) => {
        s.txPrompt = null
        if (!choice) return resolve(false)
        try {
          await (choice === 'commit' ? commit(s) : rollback(s))
          resolve(true)
        } catch {
          resolve(false)
        }
      },
    }
  })
}

export async function setAutoCommit(s, on) {
  if (on === s.tx.autoCommit) return
  if (on && s.tx.open && !(await settleTx(s, t('Mudar para auto-commit?')))) return
  s.tx = await call('tx/setAutoCommit', { sId: s.key, on })
  setPref(s.connection.saved, { autoCommit: on })
  toast(on ? t('Auto-commit ativado') : t('Modo manual: use Commit ou Rollback para encerrar a transação'))
}

async function endTx(s, action) {
  try {
    s.tx = await call(`tx/${action}`, { sId: s.key })
    s.txVersion++
    toast(action === 'commit' ? t('Commit realizado') : t('Rollback realizado'), 'success')
  } catch (e) {
    const msg = action === 'commit' ? t('Falha no commit: {error}', { error: e.message }) : t('Falha no rollback: {error}', { error: e.message })
    toast(msg, 'error', 7000)
    s.tx = await call('tx/state', { sId: s.key }).catch(() => s.tx)
    throw e
  }
}

export const commit = (s) => endTx(s, 'commit')
export const rollback = (s) => endTx(s, 'rollback')

// Switch database (MySQL: USE) or schema (PostgreSQL: search_path).
export async function useSchema(s, name) {
  const c = s.connection
  if (name === c.schema) return
  if (c.dialect === 'postgres' && s.tx.open && !(await settleTx(s, t('Trocar de schema?')))) return
  const r = await call('conn/useSchema', { sId: s.key, schema: name })
  Object.assign(c, r)
  if (r.schema) setPref(c.saved, { schema: r.schema })
  await refreshEntities(s)
}

// --- long-running jobs ------------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
export { formatBytes }

const jobSession = new Map() // jobId -> sId of the session that started it

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
    const s = sessionBySId(jobSession.get(job.id))
    if (s) {
      refreshEntities(s).catch(() => {})
      s.txVersion++ // open table tabs reload
    }
  }
  // Successful jobs leave the panel on their own; failures stay until dismissed.
  if (!r?.errors?.length) setTimeout(() => dismissJob(job.id), 6000)
}


export async function startJob(s, handler, args) {
  // Dialog state is reactive (Proxy), which structured clone refuses: send plain data.
  const plain = JSON.parse(JSON.stringify(args))
  const { jobId } = await call(handler, { sId: s.key, ...plain })
  jobSession.set(jobId, s.key)
  return jobId
}

export const cancelJob = (id) => call('job/cancel', { jobId: id })
export function dismissJob(id) {
  const i = store.jobs.findIndex((j) => j.id === id && j.state !== 'running')
  if (i >= 0) store.jobs.splice(i, 1)
}

export function openErTab(s) {
  const c = s.connection
  const scope = c.schema || c.database || t('banco')
  const existing = s.tabs.find((t) => t.type === 'er' && t.scope === scope)
  if (existing) return (s.activeTabId = existing.id)
  addTab(s, { type: 'er', title: `${t('Diagrama ER')} · ${scope}`, scope })
}

export async function refreshEntities(s) {
  const sId = s.key
  // PostgreSQL lists only the chosen schema; MySQL lists the current database.
  s.tables = await call('conn/listTables', { sId, schema: s.connection.schema ?? null })
  s.schemaMap = await call('conn/schemaMap', { sId }).catch(() => ({}))
}

function addTab(s, tab) {
  tab.id = ++tabSeq
  s.tabs.push(tab)
  s.activeTabId = tab.id
  return tab
}

export function newQueryTab(s, sql = '', title, savedId = null) {
  const n = s.tabs.filter((t) => t.type === 'query').length + 1
  return addTab(s, { type: 'query', title: title || t('Consulta #{n}', { n }), sql, savedId, dirty: false })
}

export function openTableTab(s, table, view = 'data') {
  const existing = s.tabs.find((t) => t.type === 'table' && t.table === table.name && t.schema === table.schema)
  if (existing) {
    existing.view = view
    s.activeTabId = existing.id
    return existing
  }
  return addTab(s, { type: 'table', title: tableKey(table, s), table: table.name, schema: table.schema, kind: table.type, view })
}

export function closeTab(s, id) {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  s.tabs.splice(i, 1)
  if (s.activeTabId === id) {
    const next = s.tabs[i] || s.tabs[i - 1]
    s.activeTabId = next ? next.id : null
  }
}

export function selectSql(s, table) {
  const d = s.connection.dialect
  const q = (x) => (d === 'mysql' || d === 'clickhouse' || d === 'bigquery' ? '`' + x + '`' : d === 'mssql' ? `[${x}]` : `"${x}"`)
  const name = isCurrentSchema(table.schema, s) ? q(table.name) : `${q(table.schema)}.${q(table.name)}`
  if (d === 'mssql') return `select top 100 *\nfrom ${name};`
  if (d === 'oracle' || d === 'firebird') return `select *\nfrom ${name}\nfetch first 100 rows only;`
  return `select *\nfrom ${name}\nlimit 100;`
}
