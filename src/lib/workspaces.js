// Workspaces: named sets of connections, saved queries, snippets, open tabs and
// per-connection preferences. One is active; the connection screen, the saved
// queries and the snippets show the active one. A workspace can be exported
// to a JSON / YAML file or synced with a private GitHub repository (main
// process, electron/github-sync.cjs).
import { reactive } from 'vue'
import { call, bridge } from './api'
import { t } from './i18n'
import { toast } from './store'

const KEY = 'graphite.workspace'
const api = () => bridge.workspaces

export const workspaces = reactive({
  list: [],
  activeId: null,
  version: 0, // bumped when the active workspace's contents change elsewhere (sync, import)
  github: { login: null, method: null, deviceFlow: false, installUrl: null, pending: null },
  syncing: {}, // id → true while a sync runs
  dialog: null, // 'github' | 'snippets' | { type: 'name', id?, name }
  snippetDraft: null, // body to prefill a new snippet with
})

export const activeWorkspace = () => workspaces.list.find((w) => w.id === workspaces.activeId) || workspaces.list[0] || null
export const activeId = () => activeWorkspace()?.id ?? 1
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export async function loadWorkspaces() {
  workspaces.list = await call('app/workspaces')
  if (!workspaces.list.some((w) => w.id === workspaces.activeId)) {
    let stored = null
    try {
      stored = Number(localStorage.getItem(KEY))
    } catch {}
    workspaces.activeId = workspaces.list.some((w) => w.id === stored) ? stored : workspaces.list[0]?.id ?? 1
  }
}

export function setActive(id) {
  workspaces.activeId = id
  try {
    localStorage.setItem(KEY, String(id))
  } catch {}
  workspaces.version++
}

// Something in the active workspace changed here: GitHub sync picks it up shortly.
export function touched(id = activeId()) {
  if (workspaces.list.find((w) => w.id === id)?.remote) api().touched(id)
}

export async function saveWorkspace(id, name) {
  const newId = await call('app/saveWorkspace', { workspace: { id, name } })
  await loadWorkspaces()
  if (!id) setActive(newId)
  else touched(id)
  return newId
}

export async function deleteWorkspace(id) {
  const w = workspaces.list.find((x) => x.id === id)
  const what = t('{connections} conexões e {queries} consultas salvas', { connections: w.connections, queries: w.queries })
  if (!confirm(t('Excluir o workspace "{name}" e tudo o que ele tem ({what})? Isso não apaga nada no GitHub.', { name: w.name, what }))) return
  try {
    await call('app/deleteWorkspace', { id })
  } catch (e) {
    return toast(clean(e), 'error')
  }
  await loadWorkspaces()
  setActive(workspaces.list[0].id)
}

export async function exportWorkspace(id, format) {
  try {
    const file = await api().exportFile(id, format)
    if (file) toast(t('Workspace exportado: {file}', { file }), 'success', 5000)
  } catch (e) {
    toast(clean(e), 'error', 8000)
  }
}

export async function importWorkspace() {
  try {
    const id = await api().importFile()
    if (!id) return
    await loadWorkspaces()
    setActive(id)
    toast(t('Workspace importado: {name}. Informe as senhas ao conectar.', { name: activeWorkspace().name }), 'success', 6000)
  } catch (e) {
    toast(clean(e), 'error', 8000)
  }
}

export async function saveSnippets(snippets) {
  const id = activeId()
  const saved = await call('app/saveSnippets', { id, snippets })
  const w = workspaces.list.find((x) => x.id === id)
  if (w) w.snippets = saved
  touched(id)
  return saved
}

// --- GitHub ----------------------------------------------------------------------

export async function syncNow(id = activeId(), { quiet = false } = {}) {
  workspaces.syncing[id] = true
  try {
    const r = await api().sync(id)
    if (r.conflicts.length) toast(t('Editado aqui e no GitHub ao mesmo tempo, mantive as duas versões: {names}', { names: r.conflicts.join(', ') }), 'info', 9000)
    else if (!quiet) toast(r.pulled || r.pushed ? t('Workspace sincronizado com o GitHub') : t('Workspace já está em dia com o GitHub'), 'success')
    return r
  } catch (e) {
    toast(t('Falha ao sincronizar: {error}', { error: clean(e) }), 'error', 9000)
    throw e
  } finally {
    delete workspaces.syncing[id]
  }
}

export const github = {
  login: () => api().githubLogin().catch((e) => toast(clean(e), 'error', 8000)),
  cancel: () => api().githubCancel(),
  token: (tok) => api().githubToken(tok),
  logout: () => api().githubLogout(),
  repos: () => api().repos(),
  link: (id, repo, dir) => api().link(id, repo, dir),
  unlink: (id) => api().unlink(id),
  setAuto: (id, on) => api().setAuto(id, on),
  open: (url) => api().open(url),
}
export { clean as cleanError }

export async function initWorkspaces() {
  await loadWorkspaces()
  workspaces.github = await api().github()
  api().on('github', (s) => (workspaces.github = s))
  api().on('error', (msg) => toast(msg, 'error', 8000))
  api().on('changed', async (d) => {
    await loadWorkspaces()
    if (d.id === workspaces.activeId && !d.remoteOnly && d.pulled) workspaces.version++
  })
}
