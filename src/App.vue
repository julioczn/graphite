<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
import { store, toast } from './lib/store'
import { bridge } from './lib/api'
import { t } from './lib/i18n'
import ConnectionScreen from './components/ConnectionScreen.vue'
import Workspace from './components/Workspace.vue'
import Icon from './components/Icon.vue'
import AiApproval from './components/AiApproval.vue'
import AiSettings from './components/AiSettings.vue'
import { ai, initAi } from './lib/ai'
import UpdateDialog from './components/UpdateDialog.vue'
import { update, initUpdate } from './lib/update'
import WorkspaceSync from './components/WorkspaceSync.vue'
import SnippetsDialog from './components/SnippetsDialog.vue'
import ImportToolsDialog from './components/ImportToolsDialog.vue'
import { workspaces, initWorkspaces } from './lib/workspaces'

let off
onMounted(() => {
  initAi().catch((e) => console.error('AI init', e))
  initUpdate().catch((e) => console.error('update init', e))
  initWorkspaces().catch((e) => console.error('workspaces init', e))
  off = bridge.onEvent((ev) => {
    if (ev === 'util-restarted') {
      store.connection = null
      bridge.ai.setActive(null)
      toast(t('O processo de banco reiniciou. Reconecte-se.'), 'error', 6000)
    }
  })
})
onBeforeUnmount(() => off?.())
</script>

<template>
  <Workspace v-if="store.connection" />
  <ConnectionScreen v-else />
  <AiSettings v-if="ai.showSettings" />
  <AiApproval />
  <UpdateDialog v-if="update.dialog" />
  <WorkspaceSync v-if="workspaces.dialog === 'github'" />
  <SnippetsDialog v-if="workspaces.dialog === 'snippets'" />
  <ImportToolsDialog v-if="workspaces.dialog === 'tools'" />

  <div class="toasts">
    <TransitionGroup name="toast">
      <div v-for="item in store.toasts" :key="item.id" class="toast" :class="item.kind">
        <Icon :name="item.kind === 'error' ? 'alert' : item.kind === 'success' ? 'check' : 'info'" :size="15" />
        <span>{{ item.text }}</span>
        <button v-if="item.action" class="toast-act" @click="item.action.run()">{{ item.action.label }}</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 74px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1000;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  padding: 10px 14px;
  border: 1px solid var(--line-3);
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--fg);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
}
.toast.error { border-color: var(--fg-3); border-left: 3px solid var(--fg); }
.toast.success { border-left: 3px solid var(--fg-2); }
.toast-act {
  flex: none; margin-left: 4px; padding: 3px 9px; pointer-events: auto;
  border: 1px solid var(--line-3); border-radius: 5px;
  background: var(--surface-5); color: var(--fg); cursor: pointer; font-size: 12px;
}
.toast-act:hover { background: var(--surface-6); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(6px); }
.toast-enter-active, .toast-leave-active { transition: all 0.18s ease; }
</style>
