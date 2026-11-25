// Renderer side of the AI features: settings / MCP status, the approval
// queue, the activity log and the assistant chat. The work itself happens in
// the main process (electron/ai/); this mirrors its state for the UI.
import { reactive } from 'vue'
import { bridge } from './api'
import { store, toast, newQueryTab } from './store'
import { t } from './i18n'

const api = bridge.ai

export const ai = reactive({
  ready: false,
  settings: null, // { mcp: { enabled, port, token }, assistant: { provider, model, baseUrl, keyIds } }
  mcp: { running: false, port: null, url: null, error: null, clients: [] },
  approvals: [], // pending write approvals, oldest first
  activity: [],
  panel: false, // assistant panel open
  showSettings: false,
  settingsTab: 'assistant',
  chat: newChat(),
  insert: null, // { sql, nonce } → the active query tab inserts it
})

function newChat() {
  return { id: crypto.randomUUID(), items: [], busy: false, status: '' }
}

export async function initAi() {
  if (ai.ready) return
  ai.ready = true
  Object.assign(ai, await api.state())
  ai.approvals = await api.pending()
  ai.activity = await api.activity()
  api.on('ai:approval', (req) => {
    if (!ai.approvals.some((a) => a.id === req.id)) ai.approvals.push(req)
  })
  api.on('ai:approvalDone', ({ id }) => {
    ai.approvals = ai.approvals.filter((a) => a.id !== id)
  })
  api.on('ai:activity', (e) => {
    const i = ai.activity.findIndex((x) => x.id === e.id)
    if (i >= 0) ai.activity.splice(i, 1, e)
    else ai.activity.unshift(e)
    if (ai.activity.length > 200) ai.activity.length = 200
  })
  api.on('ai:mcp', (st) => {
    ai.mcp = st
  })
  api.on('ai:chat', onChatEvent)
}

export async function updateAi(patch) {
  Object.assign(ai, await api.update(patch))
}

export function decide(id, ok) {
  ai.approvals = ai.approvals.filter((a) => a.id !== id)
  return api.decide(id, ok)
}

// --- connection the window has open (agents may use it as "active") ---------

export function shareActiveConnection(saved, config) {
  return api.setActive(config ? { name: saved?.name || t('Conexão aberta'), type: config.type, config, savedId: saved?.id ?? null } : null)
}

// --- assistant chat ---------------------------------------------------------------

function lastAssistant() {
  const it = ai.chat.items[ai.chat.items.length - 1]
  return it?.role === 'assistant' ? it : null
}

function onChatEvent(ev) {
  if (ev.convId !== ai.chat.id) return
  const msg = lastAssistant()
  switch (ev.type) {
    case 'start':
      ai.chat.items.push({ role: 'assistant', parts: [] })
      break
    case 'status':
      ai.chat.status = ev.text
      break
    case 'text': {
      ai.chat.status = ''
      const parts = msg.parts
      const last = parts[parts.length - 1]
      if (last?.type === 'text') last.text += ev.delta
      else parts.push({ type: 'text', text: ev.delta })
      break
    }
    case 'tool':
      ai.chat.status = ''
      msg.parts.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, done: false })
      break
    case 'tool_result': {
      const part = msg.parts.find((p) => p.type === 'tool' && p.id === ev.id)
      if (part) Object.assign(part, { done: true, ok: ev.ok, status: ev.status, text: ev.text })
      break
    }
    case 'done':
      ai.chat.busy = false
      ai.chat.status = ''
      if (ev.stopped && msg) msg.parts.push({ type: 'note', text: t('Interrompido.') })
      break
    case 'error':
      ai.chat.busy = false
      ai.chat.status = ''
      ;(msg || ai.chat.items[ai.chat.items.push({ role: 'assistant', parts: [] }) - 1]).parts.push({ type: 'error', text: ev.message })
      break
  }
}

// What the assistant should know about the window, added to each message.
function context(extra = {}) {
  const c = store.connection
  const tab = store.session?.tabs.find((x) => x.id === store.session.activeTabId)
  return {
    connection: c ? `${c.saved?.name || c.database || 'open'} (${c.dialect}${c.schema ? `, schema ${c.schema}` : ''}) — use connection "active"` : null,
    sql: extra.sql ?? (tab?.type === 'query' ? tab.sql : ''),
    error: extra.error || null,
  }
}

export async function ask(text, extra) {
  text = text.trim()
  if (!text || ai.chat.busy) return
  ai.panel = true
  ai.chat.items.push({ role: 'user', text, ...(extra?.error && { error: extra.error }) })
  ai.chat.busy = true
  ai.chat.status = t('enviando…')
  try {
    await api.chatSend(ai.chat.id, text, context(extra))
  } catch (e) {
    onChatEvent({ convId: ai.chat.id, type: 'error', message: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
  }
}

export function stopChat() {
  return api.chatStop(ai.chat.id)
}

export function resetChat() {
  api.chatReset(ai.chat.id)
  ai.chat = newChat()
}

// --- SQL from the chat into the editor ---------------------------------------------

export function insertIntoEditor(sql) {
  const tab = store.session?.tabs.find((x) => x.id === store.session.activeTabId)
  if (tab?.type !== 'query') return openInNewTab(sql)
  ai.insert = { sql, nonce: Math.random() }
}

export function openInNewTab(sql) {
  if (store.session) newQueryTab(store.session, sql.endsWith('\n') ? sql : sql + '\n', 'AI')
}

export function copyText(text) {
  return navigator.clipboard.writeText(text).then(() => toast(t('Copiado'), 'info', 1400))
}
