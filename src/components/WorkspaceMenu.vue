<script setup>
// Workspace switcher at the top of the connection screen: pick, create,
// rename, export / import, GitHub sync, delete.
import { ref, computed, nextTick } from 'vue'
import Icon from './Icon.vue'
import ContextMenu from './ContextMenu.vue'
import Modal from './Modal.vue'
import SyncStatus from './SyncStatus.vue'
import { t } from '../lib/i18n'
import { workspaces, activeWorkspace, setActive, saveWorkspace, deleteWorkspace, exportWorkspace, importWorkspace, syncNow } from '../lib/workspaces'

const menu = ref(null)
const naming = ref(null) // { id?, name }
const nameInput = ref(null)
const w = computed(() => activeWorkspace())
const syncing = computed(() => !!workspaces.syncing[w.value?.id])

function open(e) {
  const r = e.currentTarget.getBoundingClientRect()
  const cur = w.value
  menu.value = {
    x: r.left,
    y: r.bottom + 4,
    items: [
      ...workspaces.list.map((x) => ({
        label: x.name,
        icon: x.id === cur?.id ? 'check' : x.remote ? 'link' : undefined,
        hint: t('{n} conexão|{n} conexões', { n: x.connections }),
        run: () => setActive(x.id),
      })),
      { sep: true },
      { label: t('Novo workspace…'), icon: 'plus', run: () => askName({ name: '' }) },
      { label: t('Renomear…'), icon: 'settings', run: () => askName({ id: cur.id, name: cur.name }) },
      { sep: true },
      { label: cur?.remote ? t('GitHub: {repo}', { repo: cur.remote.repo }) : t('Sincronizar com o GitHub…'), icon: 'github', run: () => (workspaces.dialog = 'github') },
      ...(cur?.remote ? [{ label: t('Sincronizar agora'), icon: 'refresh', disabled: syncing.value, run: () => syncNow(cur.id).catch(() => {}) }] : []),
      { label: t('Exportar como YAML…'), icon: 'export', run: () => exportWorkspace(cur.id, 'yaml') },
      { label: t('Exportar como JSON…'), icon: 'export', run: () => exportWorkspace(cur.id, 'json') },
      { label: t('Importar arquivo…'), icon: 'upload', run: importWorkspace },
      { label: t('Importar de outra ferramenta…'), icon: 'download', hint: 'DBeaver, DataGrip…', run: () => (workspaces.dialog = 'tools') },
      ...(workspaces.list.length > 1 ? [{ sep: true }, { label: t('Excluir workspace…'), icon: 'trash', danger: true, run: () => deleteWorkspace(cur.id) }] : []),
    ],
  }
}

async function askName(v) {
  naming.value = v
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

async function submitName() {
  const n = naming.value
  if (!n.name.trim()) return
  naming.value = null
  await saveWorkspace(n.id, n.name.trim())
}
</script>

<template>
  <div class="wsm">
    <button class="wsm-btn" :title="t('Workspace')" @click="open">
      <Icon name="layout" :size="14" />
      <span class="wsm-name">{{ w?.name || '…' }}</span>
      <Icon name="chevron" :size="12" class="wsm-chev" />
    </button>
    <SyncStatus variant="card" />
    <ContextMenu :menu="menu" @close="menu = null" />
    <Modal v-if="naming" :title="naming.id ? t('Renomear workspace') : t('Novo workspace')" width="400px" @close="naming = null">
      <form @submit.prevent="submitName">
        <input ref="nameInput" v-model="naming.name" class="input" :placeholder="t('Ex.: Trabalho, Cliente X, Pessoal')" maxlength="80" />
        <p v-if="!naming.id" class="hint">{{ t('Um workspace novo começa vazio. Conexões e consultas salvas ficam no workspace em que foram criadas.') }}</p>
      </form>
      <template #foot>
        <span class="spacer" />
        <button class="btn" @click="naming = null">{{ t('Cancelar') }}</button>
        <button class="btn primary" :disabled="!naming.name.trim()" @click="submitName">{{ naming.id ? t('Salvar') : t('Criar') }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.wsm { padding: 0 16px 14px; }
.wsm-btn {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 10px;
  border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-2); color: var(--fg);
  font: 600 13px var(--font); cursor: pointer; text-align: left;
}
.wsm-btn:hover { border-color: var(--fg-4); }
.wsm-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-chev { color: var(--fg-3); transform: rotate(90deg); }
.hint { margin: 10px 0 0; color: var(--fg-3); font-size: 12px; line-height: 1.5; }
.spacer { flex: 1; }
</style>
