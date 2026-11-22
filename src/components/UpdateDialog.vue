<script setup>
// Updates dialog: version state, download progress, release notes, auto-check.
// Opened from UpdateButton or from the "new version" toast.
import { computed } from 'vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import { t, fmtNumber, fmtDateTime } from '../lib/i18n'
import { renderMarkdown } from '../lib/markdown'
import { update, hasUpdate, checkUpdate, downloadUpdate, installUpdate, setAutoUpdate, openReleasePage } from '../lib/update'

const mb = (n) => fmtNumber(n / 1024 / 1024, { maximumFractionDigits: 1 })
const pct = computed(() => (update.progress?.total ? Math.round((update.progress.received / update.progress.total) * 100) : 0))
// Release notes: the GitHub body is the CHANGELOG section; show it as Markdown.
const notes = computed(() => renderMarkdown((update.latest?.notes || '').trim()))
</script>

<template>
<Modal v-if="update.dialog" :title="t('Atualizações')" :subtitle="t('Versão instalada: {version}', { version: update.current })" width="560px" @close="update.dialog = false">
  <div class="state">
    <template v-if="update.status === 'checking'">
      <Icon name="refresh" :size="15" class="spin" /> {{ t('Verificando…') }}
    </template>
    <template v-else-if="update.status === 'none'">
      <Icon name="check" :size="15" /> {{ t('Você está na versão mais recente.') }}
    </template>
    <template v-else-if="update.status === 'error'">
      <Icon name="alert" :size="15" /> <span class="err">{{ update.error }}</span>
    </template>
    <template v-else-if="hasUpdate()">
      <Icon name="download" :size="15" />
      <span><b>{{ t('Graphite {version}', { version: update.latest.version }) }}</b>
        <span v-if="update.latest.publishedAt" class="muted"> · {{ fmtDateTime(update.latest.publishedAt, { dateStyle: 'medium' }) }}</span></span>
    </template>
    <template v-else>
      <Icon name="info" :size="15" /> {{ t('Ainda não verificado.') }}
    </template>
  </div>

  <div v-if="update.status === 'downloading' || update.status === 'ready'" class="progress">
    <div class="bar"><div :style="{ width: pct + '%' }" /></div>
    <span class="muted">{{ update.status === 'ready' ? t('Baixado e verificado') : `${mb(update.progress.received)} / ${mb(update.progress.total)} MB` }}</span>
  </div>

  <div v-if="hasUpdate() && update.latest.notes" class="notes md">
    <template v-for="(b, k) in notes" :key="k">
      <div v-if="b.type === 'html'" v-html="b.html" />
      <pre v-else>{{ b.code }}</pre>
    </template>
  </div>

  <p v-if="hasUpdate() && !update.canInstall" class="muted small">
    {{ t('Esta instalação não se atualiza sozinha (versão de desenvolvimento ou pacote sem suporte). Baixe pela página da versão.') }}
  </p>

  <label class="check auto">
    <input type="checkbox" :checked="update.auto" @change="setAutoUpdate($event.target.checked)" />
    {{ t('Verificar atualizações automaticamente') }}
  </label>
  <p class="muted small">{{ t('Consulta as releases do Graphite no GitHub ao abrir o app e a cada 6 horas. Nada sobre você ou seus bancos é enviado.') }}</p>

  <template #foot>
    <button class="btn" :disabled="['checking', 'downloading', 'installing'].includes(update.status)" @click="checkUpdate()">
      <Icon name="refresh" :size="13" /> {{ t('Verificar agora') }}
    </button>
    <button v-if="hasUpdate()" class="btn ghost" @click="openReleasePage()"><Icon name="export" :size="13" /> {{ t('Página da versão') }}</button>
    <span class="grow" />
    <button v-if="update.status === 'available' && update.canInstall" class="btn primary" @click="downloadUpdate()">
      <Icon name="download" :size="13" /> {{ t('Baixar e instalar') }}
    </button>
    <button v-else-if="update.status === 'downloading'" class="btn primary" disabled>{{ t('Baixando… {pct}%', { pct }) }}</button>
    <button v-else-if="update.status === 'ready' || update.status === 'installing'" class="btn primary" :disabled="update.status === 'installing'" @click="installUpdate()">
      <Icon name="power" :size="13" /> {{ t('Reiniciar e atualizar') }}
    </button>
  </template>
</Modal>
</template>

<style scoped>
.state { display: flex; align-items: center; gap: 8px; min-height: 24px; font-size: 13px; }
.err { color: #f87171; }
.muted { color: var(--fg-3); }
.small { font-size: 12px; line-height: 1.5; }
.progress { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 12px; }
.bar { flex: 1; height: 6px; border-radius: 3px; background: var(--surface-5); overflow: hidden; }
.bar > div { height: 100%; background: var(--accent); transition: width 0.2s; }
.notes { margin-top: 14px; max-height: 260px; overflow: auto; padding: 10px 14px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-2); font-size: 12.5px; line-height: 1.55; }
.notes :deep(h3) { margin: 8px 0 4px; font-size: 13px; }
.notes :deep(ul) { margin: 4px 0; padding-left: 18px; }
.notes :deep(code) { font-family: var(--mono); font-size: 11.5px; }
.auto { display: flex; align-items: center; gap: 8px; margin-top: 16px; font-size: 13px; }
.grow { flex: 1; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
