<script setup>
// GitHub sync status of the active workspace, shown under the workspace picker
// ("card") and in the status bar while connected ("bar"). Hidden when the
// workspace isn't linked to a repository. Clicking opens the GitHub dialog.
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { t, intl } from '../lib/i18n'
import { workspaces, activeWorkspace, syncNow } from '../lib/workspaces'

const props = defineProps({ variant: { type: String, default: 'card' } })

const now = ref(Date.now())
let timer
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 30_000)))
onBeforeUnmount(() => clearInterval(timer))

const w = computed(() => activeWorkspace())
const r = computed(() => w.value?.remote || null)

function ago(iso) {
  const s = Math.max(0, (now.value - new Date(iso).getTime()) / 1000)
  if (s < 60) return t('agora')
  const rtf = new Intl.RelativeTimeFormat(intl(), { numeric: 'auto', style: 'short' })
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  return rtf.format(-Math.round(s / 86400), 'day')
}

// state: syncing | signedOut | error | ok | never
const state = computed(() => {
  if (!r.value) return null
  if (workspaces.syncing[w.value.id]) return 'syncing'
  if (!workspaces.github.login) return 'signedOut'
  if (r.value.lastError) return 'error'
  return r.value.lastSyncAt ? 'ok' : 'never'
})

const label = computed(() => ({
  syncing: t('Sincronizando…'),
  signedOut: t('Desconectado do GitHub'),
  error: t('Falha ao sincronizar'),
  ok: t('Sincronizado {ago}', { ago: r.value?.lastSyncAt ? ago(r.value.lastSyncAt) : '' }),
  never: t('Ainda não sincronizado'),
})[state.value])

const where = computed(() => (r.value ? `${r.value.repo}${r.value.dir ? '/' + r.value.dir : ''}` : ''))
const title = computed(() => {
  const lines = [t('GitHub: {repo}', { repo: where.value })]
  if (state.value === 'error') lines.push(r.value.lastError)
  if (state.value === 'signedOut') lines.push(t('Entre de novo para voltar a sincronizar.'))
  if (r.value?.auto === false) lines.push(t('Sincronização automática desligada'))
  lines.push(t('Clique para ver os detalhes'))
  return lines.join('\n')
})

const open = () => (workspaces.dialog = 'github')
const syncHere = () => syncNow(w.value.id).catch(() => {})
</script>

<template>
  <div v-if="state && props.variant === 'card'" class="sync-card" :class="state" role="button" tabindex="0" :title="title" @click="open" @keydown.enter="open">
    <span class="mark"><Icon name="github" :size="15" /><span class="badge" /></span>
    <span class="text">
      <span class="label">{{ label }}</span>
      <span class="repo">{{ where }}</span>
    </span>
    <button v-if="state !== 'signedOut'" class="again" :title="t('Sincronizar agora')" :disabled="state === 'syncing'" @click.stop="syncHere">
      <Icon name="refresh" :size="13" :class="{ spin: state === 'syncing' }" />
    </button>
  </div>
  <button v-else-if="state && props.variant === 'bar'" class="sync-bar" :class="state" :title="title" @click="open">
    <span class="mark"><Icon name="github" :size="13" /><span class="badge" /></span>
    {{ label }}
  </button>
</template>

<style scoped>
.mark { position: relative; display: inline-flex; }
/* Monochrome UI: the state shows as a small badge on the GitHub mark. */
.badge { position: absolute; right: -3px; bottom: -2px; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--surface-2); background: var(--fg); }
.syncing .badge { animation: pulse 1s ease-in-out infinite; }
.never .badge { background: var(--fg-4); }
.error .badge, .signedOut .badge { width: 8px; height: 8px; background: var(--surface-2); border-color: var(--fg); }
@keyframes pulse { 50% { opacity: 0.2; } }

.sync-card {
  display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 7px 6px 7px 11px;
  border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-1); cursor: pointer;
}
.sync-card:hover { border-color: var(--line-3); background: var(--surface-2); }
.sync-card.error, .sync-card.signedOut { border-color: var(--fg-3); }
.sync-card .mark { color: var(--fg); }
.text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.label { font-size: 12.5px; font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.repo { font: 11px var(--mono); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.again { display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 6px; background: none; color: var(--fg-3); cursor: pointer; }
.again:hover:not(:disabled) { background: var(--sel-2); color: var(--fg); }
.again:disabled { cursor: default; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.sync-bar {
  display: inline-flex; align-items: center; gap: 7px; height: 100%; padding: 0 8px;
  border: 0; border-left: 1px solid var(--line-3); background: none; color: var(--fg-2); font: 12px var(--font); cursor: pointer; white-space: nowrap;
}
.sync-bar:hover { background: var(--sel); color: var(--fg); }
.sync-bar.error, .sync-bar.signedOut { color: var(--fg); font-weight: 600; }
.sync-bar .badge { border-color: var(--surface-4); }
.sync-bar.error .badge, .sync-bar.signedOut .badge { background: var(--surface-4); border-color: var(--fg); }
</style>
