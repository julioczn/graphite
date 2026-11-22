<script setup>
// Update entry point. Connection screen: a full-width button showing the
// version, or "Update available". Workspace rail (compact): an icon shown only
// when there is an update. Both open UpdateDialog. One root element so the
// parent's scoped button styles (.btn / .act) apply.
import { computed } from 'vue'
import Icon from './Icon.vue'
import { t } from '../lib/i18n'
import { update, hasUpdate } from '../lib/update'

defineProps({ compact: Boolean })

const pct = computed(() => (update.progress?.total ? Math.round((update.progress.received / update.progress.total) * 100) : 0))
const label = computed(() => {
  if (update.status === 'downloading') return t('Baixando atualização… {pct}%', { pct: pct.value })
  if (update.status === 'ready') return t('Reiniciar para atualizar')
  if (hasUpdate()) return t('Atualização disponível')
  return t('Graphite {version}', { version: update.current })
})
</script>

<template>
  <button v-if="!compact" class="btn ghost upd" :class="{ hot: hasUpdate() }" :title="t('Atualizações')" @click="update.dialog = true">
    <Icon :name="hasUpdate() ? 'download' : 'refresh'" :size="14" />
    <span class="upd-label">{{ label }}</span>
    <span v-if="hasUpdate()" class="dot" />
  </button>
  <button v-else-if="hasUpdate()" class="act upd-rail" :title="label" @click="update.dialog = true">
    <Icon name="download" :size="18" />
    <span class="dot rail" />
  </button>
</template>

<style scoped>
.upd { position: relative; }
.upd.hot { color: var(--fg) !important; }
.upd-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; margin-left: auto; border-radius: 50%; background: #4ade80; flex: none; }
.upd-rail { position: relative; }
.dot.rail { position: absolute; top: 7px; right: 7px; margin: 0; }
</style>
