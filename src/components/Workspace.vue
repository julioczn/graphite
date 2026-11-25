<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { store, closeConnection, closeTab, newQueryTab, provideSession, isFocused, setRowLimit, ROW_LIMITS } from '../lib/store'
import { t, i18n } from '../lib/i18n'
import Icon from './Icon.vue'
import SyncStatus from './SyncStatus.vue'
import { key, shortcut } from '../lib/keys'
import EntitySidebar from './EntitySidebar.vue'
import HistoryPanel from './HistoryPanel.vue'
import SavedPanel from './SavedPanel.vue'
import QueryTab from './QueryTab.vue'
import TableTab from './TableTab.vue'
import QuickSearch from './QuickSearch.vue'
import TxDialog from './TxDialog.vue'
import ErTab from './ErTab.vue'
import BackupDialog from './BackupDialog.vue'
import RestoreDialog from './RestoreDialog.vue'
import ExportDialog from './ExportDialog.vue'
import LanguageMenu from './LanguageMenu.vue'
import UpdateButton from './UpdateButton.vue'
import { engineOf } from '../../shared/engines.mjs'
import { ai } from '../lib/ai'

// One open connection (session). Side by side, two of these share the window.
const props = defineProps({ session: Object })
const sess = props.session
provideSession(sess)
const focused = computed(() => isFocused(sess))

const sidebarWidth = ref(280)
const activeTab = computed(() => sess.tabs.find((t) => t.id === sess.activeTabId))
const conn = computed(() => sess.connection)

const panels = computed(() => [
  { id: 'entities', icon: 'database', label: t('Entidades') },
  { id: 'history', icon: 'history', label: t('Histórico') },
  { id: 'saved', icon: 'bookmark', label: t('Consultas salvas') },
])

function togglePanel(id) {
  sess.sidebarPanel = sess.sidebarPanel === id ? null : id
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

// Shortcuts act on the focused pane only, and not under the connection screen.
function onKey(e) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod || !focused.value || store.picker) return
  const k = e.key.toLowerCase()
  if (k === 't' && !e.shiftKey) { e.preventDefault(); newQueryTab(sess) }
  else if (k === 'w') { e.preventDefault(); if (sess.activeTabId) closeTab(sess, sess.activeTabId) }
  else if (k === 'p' || (k === 'k' && !e.shiftKey)) { e.preventDefault(); sess.quickSearch = true }
  else if (k === 'b') { e.preventDefault(); togglePanel(sess.sidebarPanel ? sess.sidebarPanel : 'entities') }
  else if (e.key === 'Tab' && !e.altKey) {
    e.preventDefault()
    const i = sess.tabs.findIndex((t) => t.id === sess.activeTabId)
    const n = sess.tabs.length
    if (n) sess.activeTabId = sess.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n].id
  }
}

function onTabMouse(e, tab) {
  if (e.button === 1) { e.preventDefault(); closeTab(sess, tab.id) }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="ws" :class="{ focused }">
    <div class="body">
      <nav class="activity">
        <button v-for="p in panels" :key="p.id" class="act" :class="{ on: sess.sidebarPanel === p.id }"
                :title="p.label" @click="togglePanel(p.id)">
          <Icon :name="p.icon" :size="19" />
        </button>
        <span class="grow" />
        <button class="act" :class="{ on: ai.panel }" :title="t('Assistente de AI')" @click="ai.panel = focused ? !ai.panel : true">
          <Icon name="sparkle" :size="18" />
          <span v-if="ai.approvals.length" class="badge">{{ ai.approvals.length }}</span>
        </button>
        <UpdateButton compact />
        <LanguageMenu compact />
        <button class="act" :title="t('Busca rápida ({key})', { key: shortcut('mod', 'p') })" @click="sess.quickSearch = true"><Icon name="search" :size="18" /></button>
        <button class="act" :title="t('Atalhos de teclado ({key})', { key: shortcut('mod', 'shift', '?') })" @click="store.shortcuts = true"><Icon name="keyboard" :size="18" /></button>
        <button class="act" :title="t('Desconectar')" @click="closeConnection(sess)"><Icon name="power" :size="18" /></button>
      </nav>

      <aside v-show="sess.sidebarPanel" class="sidebar" :style="{ width: sidebarWidth + 'px' }">
        <EntitySidebar v-show="sess.sidebarPanel === 'entities'" />
        <HistoryPanel v-if="sess.sidebarPanel === 'history'" />
        <SavedPanel v-if="sess.sidebarPanel === 'saved'" />
        <div class="resizer" @mousedown.prevent="startResize" />
      </aside>

      <section class="content">
        <div class="tabs" @dblclick.self="newQueryTab(sess)">
          <div v-for="tab in sess.tabs" :key="tab.id" class="tab" :class="{ on: tab.id === sess.activeTabId }"
               :title="tab.title" @mousedown="onTabMouse($event, tab)" @click="sess.activeTabId = tab.id">
            <Icon :name="tab.type === 'query' ? 'code' : tab.type === 'er' ? 'diagram' : tab.kind === 'view' ? 'view' : 'table'" :size="14" />
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="tab.dirty" class="dot" />
            <button class="tab-x" :title="t('Fechar ({key})', { key: shortcut('mod', 'w') })" @click.stop="closeTab(sess, tab.id)"><Icon name="close" :size="12" /></button>
          </div>
          <button class="tab-new" :title="t('Nova consulta ({key})', { key: shortcut('mod', 't') })" @click="newQueryTab(sess)"><Icon name="plus" :size="15" /></button>
        </div>

        <div class="panes">
          <template v-for="tab in sess.tabs" :key="tab.id">
            <QueryTab v-if="tab.type === 'query'" v-show="tab.id === sess.activeTabId" :tab="tab" :active="tab.id === sess.activeTabId" />
            <ErTab v-else-if="tab.type === 'er'" v-show="tab.id === sess.activeTabId" :tab="tab" :active="tab.id === sess.activeTabId" />
            <TableTab v-else v-show="tab.id === sess.activeTabId" :tab="tab" :active="tab.id === sess.activeTabId" />
          </template>
          <div v-if="!sess.tabs.length" class="empty">
            <Icon name="code" :size="28" />
            <div>{{ t('Nenhuma aba aberta') }}</div>
            <div class="hints">
              <span><span class="kbd">{{ key('mod') }}</span> <span class="kbd">T</span> {{ t('nova consulta') }}</span>
              <span><span class="kbd">{{ key('mod') }}</span> <span class="kbd">P</span> {{ t('busca rápida') }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <footer class="statusbar">
      <span class="sb-item strong shrink">
        <Icon :name="engineOf(conn.engine)?.fields === 'file' ? 'file' : 'server'" :size="13" />
        {{ conn.saved?.name || conn.database }}
      </span>
      <span class="sb-item shrink sb-version">{{ conn.version }}</span>
      <span v-if="conn.database" class="sb-item shrink sb-db">
        <Icon name="database" :size="13" /> {{ conn.database }}<template v-if="conn.caps?.schemas === 'schema' && conn.schema && conn.schema !== conn.database"> · {{ conn.schema }}</template>
      </span>
      <span class="sb-item" :class="{ strong: sess.tx.open }" :title="t('Modo de commit')">
        <template v-if="sess.tx.open"><span class="tx-dot" /> {{ t('Transação aberta') }} · {{ t('{n} alteração|{n} alterações', { n: sess.tx.statements }) }}</template>
        <template v-else>{{ sess.tx.autoCommit ? t('Auto-commit') : t('Commit manual') }}</template>
      </span>
      <span class="grow" />
      <template v-if="activeTab?.status">
        <span v-for="(s, i) in activeTab.status" :key="i" class="sb-item">{{ s }}</span>
      </template>
      <label v-if="activeTab?.type === 'query'" class="sb-item sb-limit" :title="t('Máximo de linhas que uma consulta mostra (as demais só são contadas)')">
        {{ t('Limite') }}
        <select :value="store.rowLimit" @change="setRowLimit(Number($event.target.value))">
          <option v-for="n in ROW_LIMITS" :key="n" :value="n">{{ n.toLocaleString(i18n.locale) }}</option>
        </select>
      </label>
      <SyncStatus variant="bar" />
    </footer>

    <QuickSearch v-if="sess.quickSearch" />
    <TxDialog v-if="sess.txPrompt" />
    <BackupDialog v-if="sess.dialog?.type === 'backup'" @close="sess.dialog = null" />
    <RestoreDialog v-if="sess.dialog?.type === 'restore'" @close="sess.dialog = null" />
    <ExportDialog v-if="sess.dialog?.type === 'export'" v-bind="sess.dialog.props" @close="sess.dialog = null" />
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
.statusbar { overflow: hidden; }
.sb-item { flex: none; }
.sb-item.shrink { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* Narrow panes (side by side): drop the least useful items first. */
.ws { container-type: inline-size; }
@container (max-width: 980px) { .sb-version { display: none; } }
@container (max-width: 760px) { .sb-db { display: none; } }
.sb-item.strong { color: var(--fg); font-weight: 600; }
.tx-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg); }
.sb-limit { cursor: pointer; }
.sb-limit select {
  height: 18px; padding: 0 4px; border: 1px solid var(--line-3); border-radius: 4px;
  background: var(--surface-2); color: var(--fg); font: inherit; font-size: 11.5px; cursor: pointer;
}
.sb-limit select:focus { outline: 1px solid var(--fg-4); }
</style>
