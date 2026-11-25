<script setup>
// The open connections: a bar with one tab per connection on top, and one or
// two of them on screen (side by side). Every session keeps its Workspace
// mounted while hidden, so switching back keeps editors and results.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { store, showSession, focusPane, toggleSplit, closeConnection, newConnectionPicker } from '../lib/store'
import { t } from '../lib/i18n'
import { shortcut } from '../lib/keys'
import { ai } from '../lib/ai'
import { engineOf } from '../../shared/engines.mjs'
import Icon from './Icon.vue'
import Workspace from './Workspace.vue'
import AiPanel from './AiPanel.vue'
import JobsPanel from './JobsPanel.vue'
import ContextMenu from './ContextMenu.vue'

const split = computed(() => store.panes.length > 1)
const paneOf = (s) => store.panes.indexOf(s.key)
const label = (s) => s.connection.saved?.name || s.connection.database || t('Conexão')
const detail = (s) => {
  const c = s.connection
  const where = [c.database, c.caps?.schemas === 'schema' && c.schema !== c.database ? c.schema : null].filter(Boolean).join(' · ')
  return [engineOf(c.engine)?.label, where].filter(Boolean).join(' — ')
}
// Same saved connection open twice: number the copies.
const copyNo = (s) => {
  const id = s.connection.saved?.id
  if (!id) return 0
  const same = store.sessions.filter((x) => x.connection.saved?.id === id)
  return same.length > 1 ? same.indexOf(s) + 1 : 0
}

function paneStyle(s) {
  const p = paneOf(s)
  if (p < 0) return { display: 'none' }
  if (!split.value) return { order: 0, flex: '1 1 0' }
  return p === 0 ? { order: 0, flex: `0 0 ${store.split}%` } : { order: 2, flex: '1 1 0' }
}

// Drag the divider between the two panes.
const body = ref(null)
function startSplit(e) {
  const rect = body.value.getBoundingClientRect()
  const aiW = ai.panel ? aiWidth.value : 0
  const move = (ev) => {
    const pct = ((ev.clientX - rect.left) / (rect.width - aiW)) * 100
    store.split = Math.min(80, Math.max(20, pct))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

const aiWidth = ref(380)
function startAiResize(e) {
  const x0 = e.clientX
  const w0 = aiWidth.value
  const move = (ev) => (aiWidth.value = Math.min(720, Math.max(300, w0 - (ev.clientX - x0))))
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

// A click on a connection tab shows it in the focused pane (or focuses it
// when already on screen). Middle click closes it.
function onTab(e, s) {
  if (e.button === 1) return void (e.preventDefault(), closeConnection(s))
  if (e.button === 0) showSession(s.key)
}

const menu = ref(null)
function tabMenu(e, s) {
  const p = paneOf(s)
  const other = split.value ? 1 - store.focus : 1
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    items: [
      p < 0 && { label: t('Mostrar aqui'), icon: 'left', run: () => showSession(s.key) },
      !(split.value && p >= 0) && { label: split.value ? t('Mostrar no outro painel') : t('Abrir lado a lado'), icon: 'layout', run: () => showSession(s.key, other) },
      split.value && p >= 0 && { label: t('Ocupar a janela toda'), icon: 'fit', run: () => { store.panes = [s.key]; store.focus = 0 } },
      { sep: true },
      { label: t('Fechar conexão'), icon: 'power', danger: true, run: () => closeConnection(s) },
    ],
  }
}

// Mod+\ toggles side by side; Mod+Alt+←/→ moves the focus between panes.
function onKey(e) {
  if (store.picker) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key === '\\') { e.preventDefault(); toggleSplit() }
  else if (mod && e.altKey && split.value && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    focusPane(e.key === 'ArrowLeft' ? 0 : 1)
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="shell" :class="{ split }">
    <div class="conns" role="tablist" :aria-label="t('Conexões abertas')">
      <div v-for="s in store.sessions" :key="s.key" class="conn" role="tab"
           :class="{ shown: paneOf(s) >= 0, on: paneOf(s) === store.focus, right: split && paneOf(s) === 1 }"
           :aria-selected="paneOf(s) === store.focus" :title="detail(s)"
           @mousedown="onTab($event, s)" @contextmenu.prevent="tabMenu($event, s)">
        <Icon :name="engineOf(s.connection.engine)?.fields === 'file' ? 'file' : 'server'" :size="13" />
        <span class="conn-name">{{ label(s) }}<span v-if="copyNo(s)" class="copy"> ({{ copyNo(s) }})</span></span>
        <span v-if="split && paneOf(s) >= 0" class="side" :title="paneOf(s) === 0 ? t('Painel da esquerda') : t('Painel da direita')">{{ paneOf(s) === 0 ? 'L' : 'R' }}</span>
        <span v-if="s.tx.open" class="tx" :title="t('Transação aberta')" />
        <button class="conn-x" :title="t('Fechar conexão')" @mousedown.stop @click.stop="closeConnection(s)"><Icon name="close" :size="11" /></button>
      </div>
      <button class="conn-new" :title="t('Abrir outra conexão')" @click="newConnectionPicker()"><Icon name="plus" :size="14" /></button>
      <span class="grow" />
      <button class="split-btn" :class="{ on: split }" :title="t('Lado a lado ({key})', { key: shortcut('mod', '\\') })" @click="toggleSplit">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" />
        </svg>
        <span>{{ t('Lado a lado') }}</span>
      </button>
    </div>

    <div ref="body" class="body">
      <div v-for="s in store.sessions" :key="s.key" class="pane" :class="{ focused: split && paneOf(s) === store.focus }"
           :style="paneStyle(s)" @mousedown.capture="focusPane(paneOf(s))" @focusin="focusPane(paneOf(s))">
        <Workspace :session="s" />
      </div>
      <div v-if="split" class="divider" style="order: 1" @mousedown.prevent="startSplit" />

      <div v-show="ai.panel" class="ai-dock" :style="{ width: aiWidth + 'px', order: 3 }">
        <div class="ai-resizer" @mousedown.prevent="startAiResize" />
        <AiPanel />
      </div>
    </div>

    <JobsPanel />
    <ContextMenu :menu="menu" @close="menu = null" />
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.conns {
  display: flex; align-items: stretch; flex: none;
  height: 32px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  overflow-x: auto; overflow-y: hidden;
}
.conns::-webkit-scrollbar { height: 0; }
.conn {
  position: relative;
  display: flex; align-items: center; gap: 7px;
  max-width: 240px; min-width: 120px;
  padding: 0 6px 0 12px;
  border-right: 1px solid var(--line);
  color: var(--fg-4); cursor: pointer; font-size: 12.5px;
  user-select: none;
}
.conn:hover { color: var(--fg-2); background: var(--sel); }
.conn.shown { color: var(--fg-2); background: var(--surface-1); }
.conn.on { color: var(--fg); background: var(--surface-2); }
.conn.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--fg-2); }
.conn-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.copy { color: var(--fg-4); }
.side {
  flex: none; padding: 0 4px; border: 1px solid var(--line-3); border-radius: 3px;
  font: 600 9.5px/14px var(--font); color: var(--fg-3);
}
.tx { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--fg); }
.conn-x {
  display: grid; place-items: center; flex: none;
  width: 18px; height: 18px; border: 0; border-radius: 4px;
  background: transparent; color: var(--fg-4); cursor: pointer; opacity: 0;
}
.conn:hover .conn-x, .conn.on .conn-x { opacity: 1; }
.conn-x:hover { background: var(--sel-2); color: var(--fg); }
.conn-new, .split-btn {
  display: flex; align-items: center; justify-content: center; gap: 6px; flex: none;
  border: 0; background: transparent; color: var(--fg-3); cursor: pointer;
}
.conn-new { width: 34px; }
.split-btn { padding: 0 12px; font-size: 12px; border-left: 1px solid var(--line); }
.conn-new:hover, .split-btn:hover { color: var(--fg); background: var(--sel); }
.split-btn.on { color: var(--fg); background: var(--sel-2); }
.grow { flex: 1; }

.body { flex: 1; display: flex; min-height: 0; }
.pane { position: relative; min-width: 0; display: flex; flex-direction: column; }
.pane > * { flex: 1; min-height: 0; }
/* Side by side, the pane you're not working in is dimmed a little. */
.split .pane:not(.focused) :deep(.statusbar) { opacity: 0.6; }
.split .pane.focused::after {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; z-index: 6;
  background: var(--fg-3); pointer-events: none;
}
.divider { flex: none; width: 5px; cursor: col-resize; background: var(--line-2); }
.divider:hover { background: var(--fg-4); }

.ai-dock { position: relative; flex: none; min-width: 0; border-left: 1px solid var(--line-2); }
.ai-resizer { position: absolute; top: 0; left: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
.ai-resizer:hover { background: var(--sel-2); }
</style>
