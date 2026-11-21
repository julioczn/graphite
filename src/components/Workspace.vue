<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { store, closeConnection, closeTab, newQueryTab } from '../lib/store'
import { t } from '../lib/i18n'
import Icon from './Icon.vue'
import { key, shortcut } from '../lib/keys'
import EntitySidebar from './EntitySidebar.vue'
import HistoryPanel from './HistoryPanel.vue'
import SavedPanel from './SavedPanel.vue'
import QueryTab from './QueryTab.vue'
import TableTab from './TableTab.vue'
import QuickSearch from './QuickSearch.vue'
import TxDialog from './TxDialog.vue'
import ErTab from './ErTab.vue'
import JobsPanel from './JobsPanel.vue'
import BackupDialog from './BackupDialog.vue'
import RestoreDialog from './RestoreDialog.vue'
import ExportDialog from './ExportDialog.vue'
import AiPanel from './AiPanel.vue'
import LanguageMenu from './LanguageMenu.vue'
import { ai } from '../lib/ai'

const sidebarWidth = ref(280)
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
const activeTab = computed(() => store.tabs.find((t) => t.id === store.activeTabId))
const conn = computed(() => store.connection)

const panels = computed(() => [
  { id: 'entities', icon: 'database', label: t('Entidades') },
  { id: 'history', icon: 'history', label: t('Histórico') },
  { id: 'saved', icon: 'bookmark', label: t('Consultas salvas') },
])

function togglePanel(id) {
  store.sidebarPanel = store.sidebarPanel === id ? null : id
}

function startResize(e) {
  const x0 = e.clientX
  const w0 = sidebarWidth.value
  const move = (ev) => (sidebarWidth.value = Math.min(560, Math.max(180, w0 + ev.clientX - x0)))
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (k === 't' && !e.shiftKey) { e.preventDefault(); newQueryTab() }
  else if (k === 'w') { e.preventDefault(); if (store.activeTabId) closeTab(store.activeTabId) }
  else if (k === 'p' || (k === 'k' && !e.shiftKey)) { e.preventDefault(); store.quickSearch = true }
  else if (k === 'b') { e.preventDefault(); togglePanel(store.sidebarPanel ? store.sidebarPanel : 'entities') }
  else if (e.key === 'Tab') {
    e.preventDefault()
    const i = store.tabs.findIndex((t) => t.id === store.activeTabId)
    const n = store.tabs.length
    if (n) store.activeTabId = store.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n].id
  }
}

function onTabMouse(e, tab) {
  if (e.button === 1) { e.preventDefault(); closeTab(tab.id) }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="ws">
    <div class="body">
      <nav class="activity">
        <button v-for="p in panels" :key="p.id" class="act" :class="{ on: store.sidebarPanel === p.id }"
                :title="p.label" @click="togglePanel(p.id)">
          <Icon :name="p.icon" :size="19" />
        </button>
        <span class="grow" />
        <button class="act" :class="{ on: ai.panel }" :title="t('Assistente de AI')" @click="ai.panel = !ai.panel">
          <Icon name="sparkle" :size="18" />
          <span v-if="ai.approvals.length" class="badge">{{ ai.approvals.length }}</span>
        </button>
        <LanguageMenu compact />
        <button class="act" :title="t('Busca rápida ({key})', { key: shortcut('mod', 'p') })" @click="store.quickSearch = true"><Icon name="search" :size="18" /></button>
        <button class="act" :title="t('Desconectar')" @click="closeConnection"><Icon name="power" :size="18" /></button>
      </nav>

      <aside v-show="store.sidebarPanel" class="sidebar" :style="{ width: sidebarWidth + 'px' }">
        <EntitySidebar v-show="store.sidebarPanel === 'entities'" />
        <HistoryPanel v-if="store.sidebarPanel === 'history'" />
        <SavedPanel v-if="store.sidebarPanel === 'saved'" />
        <div class="resizer" @mousedown.prevent="startResize" />
      </aside>

      <section class="content">
        <div class="tabs" @dblclick.self="newQueryTab()">
          <div v-for="tab in store.tabs" :key="tab.id" class="tab" :class="{ on: tab.id === store.activeTabId }"
               :title="tab.title" @mousedown="onTabMouse($event, tab)" @click="store.activeTabId = tab.id">
            <Icon :name="tab.type === 'query' ? 'code' : tab.type === 'er' ? 'diagram' : tab.kind === 'view' ? 'view' : 'table'" :size="14" />
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="tab.dirty" class="dot" />
            <button class="tab-x" :title="t('Fechar ({key})', { key: shortcut('mod', 'w') })" @click.stop="closeTab(tab.id)"><Icon name="close" :size="12" /></button>
          </div>
          <button class="tab-new" :title="t('Nova consulta ({key})', { key: shortcut('mod', 't') })" @click="newQueryTab()"><Icon name="plus" :size="15" /></button>
        </div>

        <div class="panes">
          <template v-for="tab in store.tabs" :key="tab.id">
            <QueryTab v-if="tab.type === 'query'" v-show="tab.id === store.activeTabId" :tab="tab" :active="tab.id === store.activeTabId" />
            <ErTab v-else-if="tab.type === 'er'" v-show="tab.id === store.activeTabId" :tab="tab" :active="tab.id === store.activeTabId" />
            <TableTab v-else v-show="tab.id === store.activeTabId" :tab="tab" :active="tab.id === store.activeTabId" />
          </template>
          <div v-if="!store.tabs.length" class="empty">
            <Icon name="code" :size="28" />
            <div>{{ t('Nenhuma aba aberta') }}</div>
            <div class="hints">
              <span><span class="kbd">{{ key('mod') }}</span> <span class="kbd">T</span> {{ t('nova consulta') }}</span>
              <span><span class="kbd">{{ key('mod') }}</span> <span class="kbd">P</span> {{ t('busca rápida') }}</span>
            </div>
          </div>
        </div>
      </section>

      <div v-show="ai.panel" class="ai-dock" :style="{ width: aiWidth + 'px' }">
        <div class="ai-resizer" @mousedown.prevent="startAiResize" />
        <AiPanel />
      </div>
    </div>

    <footer class="statusbar">
      <span class="sb-item strong">
        <Icon :name="conn.dialect === 'sqlite' ? 'file' : 'server'" :size="13" />
        {{ conn.saved?.name || conn.database }}
      </span>
      <span class="sb-item">{{ conn.version }}</span>
      <span v-if="conn.database" class="sb-item">
        <Icon name="database" :size="13" /> {{ conn.database }}<template v-if="conn.dialect === 'postgres' && conn.schema"> · {{ conn.schema }}</template>
      </span>
      <span class="sb-item" :class="{ strong: store.tx.open }" :title="t('Modo de commit')">
        <template v-if="store.tx.open"><span class="tx-dot" /> {{ t('Transação aberta') }} · {{ t('{n} alteração|{n} alterações', { n: store.tx.statements }) }}</template>
        <template v-else>{{ store.tx.autoCommit ? t('Auto-commit') : t('Commit manual') }}</template>
      </span>
      <span class="grow" />
      <template v-if="activeTab?.status">
        <span v-for="(s, i) in activeTab.status" :key="i" class="sb-item">{{ s }}</span>
      </template>
    </footer>

    <QuickSearch v-if="store.quickSearch" />
    <TxDialog v-if="store.txPrompt" />
    <JobsPanel />
    <BackupDialog v-if="store.dialog?.type === 'backup'" @close="store.dialog = null" />
    <RestoreDialog v-if="store.dialog?.type === 'restore'" @close="store.dialog = null" />
    <ExportDialog v-if="store.dialog?.type === 'export'" v-bind="store.dialog.props" @close="store.dialog = null" />
  </div>
</template>

<style scoped>
.ws { display: flex; flex-direction: column; height: 100%; }
.body { flex: 1; display: flex; min-height: 0; }

.activity {
  width: 48px; flex: none;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 8px 0;
  background: var(--bg);
  border-right: 1px solid var(--line);
}
.act {
  position: relative;
  display: grid; place-items: center;
  width: 36px; height: 36px;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--fg-4); cursor: pointer;
}
.act:hover { color: var(--fg-2); background: var(--sel); }
.act.on { color: var(--fg); background: var(--sel-2); }
.act.on::before {
  content: ''; position: absolute; left: -6px; top: 8px; bottom: 8px;
  width: 2px; border-radius: 2px; background: var(--fg);
}
.grow { flex: 1; }

.sidebar {
  position: relative;
  flex: none;
  display: flex; flex-direction: column;
  min-width: 0;
  background: var(--surface-1);
  border-right: 1px solid var(--line);
}
.resizer { position: absolute; top: 0; right: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
.resizer:hover { background: var(--sel-2); }

.content { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--surface-2); }
.ai-dock { position: relative; flex: none; min-width: 0; border-left: 1px solid var(--line-2); }
.ai-resizer { position: absolute; top: 0; left: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
.ai-resizer:hover { background: var(--sel-2); }
.act { position: relative; }
.act .badge {
  position: absolute; top: 4px; right: 4px; min-width: 15px; height: 15px; padding: 0 4px;
  border-radius: 8px; background: var(--fg); color: var(--accent-fg);
  font: 700 9.5px/15px var(--font); text-align: center;
}

.tabs {
  display: flex; align-items: stretch;
  height: 36px; flex: none;
  background: var(--surface-1);
  border-bottom: 1px solid var(--line);
  overflow-x: auto; overflow-y: hidden;
}
.tabs::-webkit-scrollbar { height: 0; }
.tab {
  position: relative;
  display: flex; align-items: center; gap: 7px;
  max-width: 220px; min-width: 110px;
  padding: 0 8px 0 12px;
  border-right: 1px solid var(--line);
  color: var(--fg-3); cursor: pointer;
}
.tab:hover { color: var(--fg-2); background: var(--sel); }
.tab.on { color: var(--fg); background: var(--surface-2); }
.tab.on::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--fg-2); }
.tab-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-2); }
.tab-x {
  display: grid; place-items: center;
  width: 20px; height: 20px; border: 0; border-radius: 4px;
  background: transparent; color: var(--fg-4); cursor: pointer; opacity: 0;
}
.tab:hover .tab-x, .tab.on .tab-x { opacity: 1; }
.tab-x:hover { background: var(--sel-2); color: var(--fg); }
.tab-new {
  display: grid; place-items: center; flex: none;
  width: 36px; border: 0; background: transparent; color: var(--fg-3); cursor: pointer;
}
.tab-new:hover { color: var(--fg); background: var(--sel); }

.panes { flex: 1; position: relative; min-height: 0; }
.panes > * { position: absolute; inset: 0; }
.hints { display: flex; gap: 18px; margin-top: 6px; color: var(--fg-3); }

.statusbar {
  display: flex; align-items: center; gap: 2px;
  height: 26px; flex: none;
  padding: 0 8px;
  background: var(--surface-4);
  border-top: 1px solid var(--line-2);
  font-size: 12px; color: var(--fg-2);
}
.sb-item {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 0 8px; height: 100%;
  white-space: nowrap;
}
.sb-item + .sb-item { border-left: 1px solid var(--line-3); }
.sb-item.strong { color: var(--fg); font-weight: 600; }
.tx-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg); }
</style>
