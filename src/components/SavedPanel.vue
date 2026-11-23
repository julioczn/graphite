<script setup>
import { ref, watch, onMounted } from 'vue'
import { call } from '../lib/api'
import { store, newQueryTab } from '../lib/store'
import Icon from './Icon.vue'
import { key } from '../lib/keys'
import { t } from '../lib/i18n'
import { workspaces, activeId, touched } from '../lib/workspaces'

const items = ref([])

async function load() {
  items.value = await call('app/savedQueries', { workspaceId: activeId() })
}

function open(q) {
  const existing = store.tabs.find((t) => t.savedId === q.id)
  if (existing) store.activeTabId = existing.id
  else newQueryTab(q.sql, q.title, q.id)
}

async function remove(q) {
  if (!confirm(t('Excluir a consulta "{title}"?', { title: q.title }))) return
  await call('app/deleteQuery', { id: q.id })
  touched()
  for (const tab of store.tabs) if (tab.savedId === q.id) tab.savedId = null
  load()
}

watch(() => [store.savedVersion, workspaces.version], load)
onMounted(load)
</script>

<template>
  <div class="panel">
    <div class="head"><span class="label">{{ t('Consultas salvas') }}</span></div>
    <div class="list">
      <div v-if="!items.length" class="empty">
        <Icon name="bookmark" :size="22" />
        {{ t('Use') }} <span><span class="kbd">{{ key('mod') }}</span> <span class="kbd">S</span></span> {{ t('numa aba de consulta para salvá-la.') }}
      </div>
      <div v-for="q in items" :key="q.id" class="entry" @click="open(q)">
        <div class="top">
          <Icon name="code" :size="13" />
          <span class="title">{{ q.title }}</span>
          <button class="del" :title="t('Excluir')" @click.stop="remove(q)"><Icon name="trash" :size="13" /></button>
        </div>
        <code>{{ q.sql }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.head { display: flex; align-items: center; height: 40px; padding: 0 14px; }
.label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-2); }
.list { flex: 1; overflow: auto; padding: 0 8px 12px; }
.entry { padding: 8px 10px; border-radius: var(--radius); cursor: pointer; }
.entry:hover { background: var(--sel); }
.top { display: flex; align-items: center; gap: 8px; color: var(--fg-3); }
.title { flex: 1; color: var(--fg); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.del { display: none; border: 0; background: transparent; color: var(--fg-3); cursor: pointer; padding: 2px; border-radius: 4px; }
.del:hover { background: var(--sel-2); color: var(--fg); }
.entry:hover .del { display: grid; }
code {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  margin-top: 4px; padding-left: 21px;
  font: 11.5px/1.45 var(--mono); color: var(--fg-4); white-space: pre-wrap; word-break: break-all;
}
</style>
