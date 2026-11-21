<script setup>
// Progress cards for backup / restore / export, bottom-left above the statusbar.
import { ref } from 'vue'
import { bridge } from '../lib/api'
import { store, cancelJob, dismissJob, formatBytes } from '../lib/store'
import { t } from '../lib/i18n'
import Icon from './Icon.vue'

const open = ref({}) // job id -> show error details

const ICON = { backup: 'archive', restore: 'upload', export: 'export' }

function fraction(j) {
  if (j.state !== 'running') return 1
  if (!j.total) return null // unknown: indeterminate bar
  return Math.min(0.99, j.done / j.total)
}

function line(j) {
  if (j.state === 'error') return j.error
  if (j.state === 'cancelled') return t('Cancelado')
  if (j.state === 'done') {
    const r = j.result
    if (j.kind === 'restore') return `${t('{n} instrução executada|{n} instruções executadas', { n: r.statements })}${r.errors.length ? ` · ${t('{n} erro|{n} erros', { n: r.errors.length })}` : ''}`
    if (j.kind === 'backup') return `${t('{n} linha|{n} linhas', { n: r.rows })} · ${formatBytes(r.size)}`
    return `${t('{n} linha|{n} linhas', { n: r.rows })} · ${t('{n} arquivo|{n} arquivos', { n: r.files.length })}`
  }
  if (j.kind === 'restore') return `${t('{done} de {total}', { done: formatBytes(j.done || 0), total: formatBytes(j.total || 0) })} · ${t('{n} instrução|{n} instruções', { n: j.detail?.statements || 0 })}`
  const progress = j.tables > 1 ? `${Math.min(j.tablesDone + 1, j.tables)}/${j.tables} · ` : ''
  return `${progress}${j.table || t('preparando…')} · ${t('{n} linha|{n} linhas', { n: j.rows })}`
}

const elapsed = (j) => {
  const s = Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
</script>

<template>
  <div v-if="store.jobs.length" class="jobs">
    <div v-for="j in store.jobs" :key="j.id" class="job" :class="j.state">
      <div class="top">
        <Icon :name="j.state === 'error' ? 'alert' : j.state === 'done' ? 'check' : ICON[j.kind]" :size="14" />
        <span class="title">{{ j.title }}</span>
        <span class="time">{{ elapsed(j) }}</span>
        <button v-if="j.state === 'running'" class="btn ghost sm" :title="t('Cancelar')" @click="cancelJob(j.id)">{{ t('Cancelar') }}</button>
        <template v-else>
          <button v-if="j.result?.file || j.result?.files" class="btn ghost icon sm" :title="t('Mostrar na pasta')"
                  @click="bridge.showItem(j.result.file || j.result.files[0])"><Icon name="folder" :size="13" /></button>
          <button class="btn ghost icon sm" :title="t('Fechar')" @click="dismissJob(j.id)"><Icon name="close" :size="12" /></button>
        </template>
      </div>
      <div class="bar" :class="{ indeterminate: fraction(j) === null }">
        <span :style="{ width: (fraction(j) ?? 0.3) * 100 + '%' }" />
      </div>
      <div class="line" :title="line(j)">{{ line(j) }}</div>
      <template v-if="j.result?.errors?.length">
        <button class="more" @click="open[j.id] = !open[j.id]">{{ open[j.id] ? t('Ocultar erros') : t('Ver erros') }}</button>
        <div v-if="open[j.id]" class="errs">
          <div v-for="(e, i) in j.result.errors" :key="i" class="err"><b>{{ e.message }}</b><pre>{{ e.sql }}</pre></div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.jobs { position: fixed; left: 60px; bottom: 36px; z-index: 800; display: flex; flex-direction: column; gap: 8px; width: 380px; }
.job {
  padding: 10px 12px; border: 1px solid var(--line-3); border-radius: 8px;
  background: var(--surface-4); box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
}
.job.error { border-left: 3px solid var(--fg); }
.top { display: flex; align-items: center; gap: 8px; }
.title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.time { color: var(--fg-4); font: 11px var(--mono); }
.bar { position: relative; height: 4px; margin: 9px 0 7px; border-radius: 2px; background: var(--surface-1); overflow: hidden; }
.bar span { position: absolute; inset: 0 auto 0 0; background: var(--fg-2); border-radius: 2px; transition: width 0.2s; }
.job.done .bar span { background: var(--fg); }
.job.error .bar span, .job.cancelled .bar span { background: var(--fg-4); }
.bar.indeterminate span { animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { from { left: -30%; } to { left: 100%; } }
.line { color: var(--fg-3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job.error .line { color: var(--fg); white-space: pre-wrap; max-height: 120px; overflow: auto; font: 11.5px/1.45 var(--mono); }
.more { margin-top: 6px; padding: 0; border: 0; background: none; color: var(--fg-2); cursor: pointer; text-decoration: underline; font-size: 12px; }
.errs { max-height: 220px; overflow: auto; margin-top: 6px; }
.err { padding: 6px 0; border-top: 1px solid var(--line-2); font-size: 11.5px; }
.err pre { margin: 4px 0 0; white-space: pre-wrap; color: var(--fg-3); font: 11px/1.4 var(--mono); }
</style>
