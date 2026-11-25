<script setup>
import { ref, watch, onMounted } from 'vue'
import { call } from '../lib/api'
import { newQueryTab, store, useSession } from '../lib/store'
import { t, intl } from '../lib/i18n'
import Icon from './Icon.vue'

const sess = useSession()

const items = ref([])
const connectionId = () => sess.connection.saved?.id ?? null

async function load() {
  items.value = await call('app/history', { connectionId: connectionId() })
}

async function clear() {
  if (!confirm(t('Limpar o histórico desta conexão?'))) return
  await call('app/clearHistory', { connectionId: connectionId() })
  load()
}

function when(ts) {
  const d = new Date(ts.replace(' ', 'T') + 'Z')
  const diff = (Date.now() - d) / 1000
  if (diff < 60) return t('agora')
  if (diff < 3600) return t('{n} min', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('{n} h', { n: Math.floor(diff / 3600) })
  return d.toLocaleDateString(intl())
}

watch(() => store.historyVersion, load)
onMounted(load)
</script>

<template>
  <div class="panel">
    <div class="head">
      <span class="label">{{ t('Histórico') }}</span>
      <button class="btn ghost sm" :disabled="!items.length" @click="clear">{{ t('Limpar') }}</button>
    </div>
    <div class="list">
      <div v-if="!items.length" class="empty">
        <Icon name="history" :size="22" />
        {{ t('Consultas executadas aparecem aqui.') }}
      </div>
      <button v-for="h in items" :key="h.id" class="entry" :class="{ failed: !h.ok }" :title="t('Abrir em nova aba')"
              @click="newQueryTab(sess, h.sql)">
        <code>{{ h.sql }}</code>
        <span class="meta">
          <Icon v-if="!h.ok" name="alert" :size="11" />
          {{ when(h.created_at) }} · {{ h.duration_ms }} ms<template v-if="!h.ok"> · {{ t('falhou') }}</template><template v-else-if="h.row_count != null"> · {{ t('{n} linha|{n} linhas', { n: h.row_count }) }}</template>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.head { display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 8px 0 14px; }
.label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-2); }
.list { flex: 1; overflow: auto; padding: 0 8px 12px; }
.entry {
  display: flex; flex-direction: column; gap: 4px; width: 100%;
  padding: 8px 10px; margin-bottom: 2px;
  border: 0; border-radius: var(--radius); background: transparent;
  text-align: left; cursor: pointer;
}
.entry:hover { background: var(--sel); }
code {
  font: 12px/1.45 var(--mono); color: var(--fg-2);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  white-space: pre-wrap; word-break: break-all;
}
.entry.failed code { color: var(--fg-3); }
.entry.failed .meta { color: var(--fg-2); }
.meta { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fg-4); }
</style>
