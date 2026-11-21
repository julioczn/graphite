// Preload: exposes a small, explicit API to the renderer.
// `call(name, args)` is an RPC over the MessagePort handed out by main; the
// other methods are whitelisted ipcRenderer.invoke channels.
const { contextBridge, ipcRenderer } = require('electron')

let port = null
let seq = 0
const pending = new Map()
const queue = []
const listeners = new Set()
const jobListeners = new Set()
const localeListeners = new Set()
// The sandboxed preload can't load shared/i18n.mjs; its one message lives here.
let locale = 'en'
const RESTARTED = { 'pt-BR': 'O processo de banco de dados reiniciou', en: 'The database process restarted', es: 'El proceso de base de datos se reinició' }
ipcRenderer.on('app:locale', (_e, info) => {
  locale = info.locale
  for (const fn of localeListeners) fn(info)
})

function attach(p) {
  port = p
  port.onmessage = ({ data }) => {
    if (data.event === 'job') {
      for (const fn of jobListeners) fn(data.job)
      return
    }
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.error) {
      const err = new Error(data.error.message)
      err.code = data.error.code
      entry.reject(err)
    } else {
      entry.resolve(data.result)
    }
  }
  port.start()
  while (queue.length) port.postMessage(queue.shift())
}

ipcRenderer.on('port', (e) => attach(e.ports[0]))
ipcRenderer.on('util-restarted', () => {
  for (const { reject } of pending.values()) reject(new Error(RESTARTED[locale] || RESTARTED.en))
  pending.clear()
  for (const fn of listeners) fn('util-restarted')
})

contextBridge.exposeInMainWorld('graphite', {
  call(name, args = {}) {
    return new Promise((resolve, reject) => {
      const msg = { id: ++seq, name, args }
      pending.set(msg.id, { resolve, reject })
      if (port) port.postMessage(msg)
      else queue.push(msg)
    })
  },
  onEvent(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  onJob(fn) {
    jobListeners.add(fn)
    return () => jobListeners.delete(fn)
  },
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  choosePath: (opts) => ipcRenderer.invoke('dialog:choosePath', opts),
  showItem: (file) => ipcRenderer.invoke('shell:showItem', file),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  encrypt: (plain) => ipcRenderer.invoke('secret:encrypt', plain),
  decrypt: (stored) => ipcRenderer.invoke('secret:decrypt', stored),
  appInfo: () => ipcRenderer.invoke('app:info'),
  // Interface language: { pref: 'system' | 'pt-BR' | 'en' | 'es', locale }.
  app: {
    locale: () => ipcRenderer.invoke('app:locale').then((info) => ((locale = info.locale), info)),
    setLocale: (pref) => ipcRenderer.invoke('app:setLocale', pref),
    onLocale(fn) {
      localeListeners.add(fn)
      return () => localeListeners.delete(fn)
    },
  },

  // AI: settings, MCP server, approvals, activity and the assistant chat.
  // The API key only goes in (ai.update); it never comes back.
  ai: {
    state: () => ipcRenderer.invoke('ai:state'),
    update: (patch) => ipcRenderer.invoke('ai:update', patch),
    setActive: (info) => ipcRenderer.invoke('ai:setActive', info),
    decide: (id, ok) => ipcRenderer.invoke('ai:decide', { id, ok }),
    pending: () => ipcRenderer.invoke('ai:pending'),
    activity: () => ipcRenderer.invoke('ai:activity'),
    test: () => ipcRenderer.invoke('ai:test'),
    models: (q) => ipcRenderer.invoke('ai:models', q),
    chatSend: (convId, text, context) => ipcRenderer.invoke('ai:chatSend', { convId, text, context }),
    chatStop: (convId) => ipcRenderer.invoke('ai:chatStop', { convId }),
    chatReset: (convId) => ipcRenderer.invoke('ai:chatReset', { convId }),
    on(channel, fn) {
      const allowed = ['ai:approval', 'ai:approvalDone', 'ai:activity', 'ai:mcp', 'ai:chat']
      if (!allowed.includes(channel)) throw new Error('canal não permitido: ' + channel)
      const listener = (_e, payload) => fn(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
  },
})
