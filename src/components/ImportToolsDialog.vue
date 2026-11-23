<script setup>
// Import saved connections (and saved queries) from other database tools:
// the ones found on this machine, or a file the user picks. The main process
// reads and keeps the passwords; this screen only sees whether one exists.
import { ref, computed, onMounted } from 'vue'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
import { t } from '../lib/i18n'
import { call, bridge } from '../lib/api'
import { toast } from '../lib/store'
import { workspaces, activeWorkspace, loadWorkspaces, setActive, cleanError } from '../lib/workspaces'
import { engineOf } from '../../shared/engines.mjs'

const api = bridge.workspaces
const found = ref(null) // detected sources
const source = ref(null) // the preview being imported
const picked = ref(new Set())
const dest = ref('new') // 'new' | 'current'
const newName = ref('')
const withPasswords = ref(true)
const withQueries = ref(true)
const existing = ref([])
const busy = ref('')
const error = ref('')

const FORMATS = [
  'DBeaver (data-sources.json)', 'DataGrip / IntelliJ (dataSources.xml)', 'Navicat (.ncx)', 'pgAdmin 4 (servers.json)',
  'MySQL Workbench (connections.xml)', 'HeidiSQL', 'MongoDB Compass', 'TablePlus', 'Sequel Ace / Sequel Pro',
  'DbGate', 'Beekeeper Studio', 'RedisInsight', 'VS Code SQLTools / Azure Data Studio (settings.json)',
]

const home = (p) => p.replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~')
const label = (type) => engineOf(type)?.label || type
function where(c) {
  const k = c.config
  if (!k) return ''
  if (k.file) return home(k.file)
  if (k.url) return k.url
  if (k.account) return k.account
  if (k.host) return `${k.host}${k.port ? ':' + k.port : ''}${k.database ? ' / ' + k.database : ''}`
  return k.region || k.project || ''
}
const keyOf = (c) => {
  const k = c.config || {}
  return [c.type, k.host || k.file || k.url || k.account || '', k.port || '', k.database || '', k.user || ''].join('|').toLowerCase()
}

const cur = computed(() => activeWorkspace())
const dupes = computed(() => (dest.value === 'current' ? new Set(existing.value.map(keyOf)) : new Set()))
const usable = computed(() => source.value?.connections.filter((c) => !c.skip) || [])
const count = computed(() => usable.value.filter((c) => picked.value.has(c.i)).length)
const withPw = computed(() => usable.value.filter((c) => picked.value.has(c.i) && c.hasPassword).length)
const elsewhere = computed(() => usable.value.filter((c) => picked.value.has(c.i) && c.passwordElsewhere).length)
const allOn = computed(() => usable.value.length > 0 && usable.value.every((c) => picked.value.has(c.i)))
const folders = computed(() => {
  const out = []
  for (const c of source.value?.connections || []) {
    let g = out.find((x) => x.name === c.folder)
    if (!g) out.push((g = { name: c.folder, items: [] }))
    g.items.push(c)
  }
  return out
})

async function run(kind, fn) {
  busy.value = kind
  error.value = ''
  try {
    return await fn()
  } catch (e) {
    error.value = cleanError(e)
  } finally {
    busy.value = ''
  }
}

const detect = () => run('detect', async () => (found.value = await api.detectTools()))

async function open(p) {
  source.value = p
  newName.value = p.label
  dest.value = cur.value && !cur.value.connections ? 'current' : 'new'
  existing.value = cur.value ? await call('app/connections', { workspaceId: cur.value.id }) : []
  selectDefault()
}
function selectDefault() {
  const dup = dupes.value
  picked.value = new Set(usable.value.filter((c) => !dup.has(keyOf(c))).map((c) => c.i))
}
const pickFile = () => run('file', async () => {
  const p = await api.toolFile()
  if (p) await open(p)
})
function toggle(c) {
  const s = new Set(picked.value)
  s.has(c.i) ? s.delete(c.i) : s.add(c.i)
  picked.value = s
}
const toggleAll = () => (picked.value = allOn.value ? new Set() : new Set(usable.value.map((c) => c.i)))
function setDest(v) {
  dest.value = v
  selectDefault()
}

const doImport = () => run('import', async () => {
  const s = source.value
  const r = await api.importTool({
    token: s.token,
    picks: [...picked.value],
    withPasswords: withPasswords.value,
    withQueries: withQueries.value && s.queries.length > 0,
    workspaceId: dest.value === 'current' ? cur.value.id : null,
    newName: newName.value.trim() || s.label,
  })
  await loadWorkspaces()
  if (r.workspaceId !== workspaces.activeId) setActive(r.workspaceId)
  else workspaces.version++
  const parts = [t('{n} conexão|{n} conexões', { n: r.connections })]
  if (r.queries) parts.push(t('{n} consulta salva|{n} consultas salvas', { n: r.queries }))
  toast(t('Importado de {tool}: {what}', { tool: s.label, what: parts.join(', ') }), 'success', 6000)
  workspaces.dialog = null
})

onMounted(detect)
</script>

<template>
  <Modal :title="t('Importar de outra ferramenta')" :subtitle="source ? `${source.label} · ${home(source.path)}` : t('Traga as conexões salvas no DBeaver, DataGrip, Beekeeper e outros')" width="680px" @close="workspaces.dialog = null">
    <!-- 1. choose a source -->
    <template v-if="!source">
      <div v-if="busy === 'detect'" class="muted pad"><span class="dot-wait" /> {{ t('Procurando ferramentas neste computador…') }}</div>
      <template v-else-if="found">
        <div v-if="found.length" class="sources">
          <button v-for="s in found" :key="s.token" class="source" @click="open(s)">
            <Icon name="database" :size="18" />
            <span class="s-text">
              <b>{{ s.label }}</b>
              <span class="muted small mono">{{ home(s.path) }}</span>
            </span>
            <span class="s-count small">
              {{ t('{n} conexão|{n} conexões', { n: s.connections.length }) }}<template v-if="s.queries.length"> · {{ t('{n} consulta|{n} consultas', { n: s.queries.length }) }}</template>
            </span>
            <Icon name="chevron" :size="14" class="muted" />
          </button>
        </div>
        <p v-else class="muted pad">{{ t('Não encontrei nenhuma ferramenta conhecida neste computador.') }}</p>
      </template>
      <div class="file-box">
        <div>
          <b>{{ t('Ou escolha um arquivo') }}</b>
          <p class="muted small">{{ t('Uma exportação, ou o arquivo de configuração copiado de outro computador. Aceito:') }} {{ FORMATS.join(' · ') }}</p>
        </div>
        <button class="btn" :disabled="!!busy" @click="pickFile"><Icon name="upload" :size="13" /> {{ t('Escolher arquivo…') }}</button>
      </div>
    </template>

    <!-- 2. preview -->
    <template v-else>
      <div class="list-head">
        <label class="check"><input type="checkbox" :checked="allOn" @change="toggleAll" /> {{ t('{n} de {total} selecionadas', { n: count, total: usable.length }) }}</label>
        <span v-if="source.connections.length > usable.length" class="muted small">{{ t('{n} sem suporte no Graphite', { n: source.connections.length - usable.length }) }}</span>
      </div>
      <div class="conns">
        <template v-for="g in folders" :key="g.name">
          <div v-if="g.name" class="folder"><Icon name="folder" :size="12" /> {{ g.name }}</div>
          <label v-for="c in g.items" :key="c.i" class="conn" :class="{ off: c.skip }">
            <input type="checkbox" :disabled="!!c.skip" :checked="picked.has(c.i)" @change="toggle(c)" />
            <span class="c-main">
              <span class="c-line">
                <b>{{ c.name }}</b>
                <span class="tag">{{ label(c.type) }}</span>
                <span v-if="c.hasPassword" class="tag ghost" :title="t('A senha salva vem junto e fica cifrada pelo chaveiro do sistema')"><Icon name="key" :size="11" /> {{ t('senha') }}</span>
                <span v-if="dupes.has(keyOf(c))" class="tag ghost">{{ t('já existe') }}</span>
              </span>
              <span class="muted small mono ell">{{ c.skip || where(c) }}</span>
              <span v-for="(n, k) in c.notes" :key="k" class="note small"><Icon name="info" :size="11" /> {{ n }}</span>
            </span>
          </label>
        </template>
      </div>

      <div class="opts">
        <div class="opt-row">
          <span class="opt-label">{{ t('Para onde') }}</span>
          <label class="radio"><input type="radio" :checked="dest === 'new'" @change="setDest('new')" /> {{ t('Novo workspace') }}</label>
          <input v-if="dest === 'new'" v-model="newName" class="input sm" maxlength="80" />
          <label class="radio"><input type="radio" :checked="dest === 'current'" @change="setDest('current')" /> {{ t('Workspace atual ({name})', { name: cur?.name }) }}</label>
        </div>
        <label v-if="source.connections.some((c) => c.hasPassword)" class="check small">
          <input v-model="withPasswords" type="checkbox" />
          {{ t('Trazer as senhas salvas ({n})', { n: withPw }) }} <span class="muted">· {{ t('ficam cifradas pelo chaveiro do sistema e nunca vão para o GitHub') }}</span>
        </label>
        <p v-if="elsewhere" class="muted small">{{ t('{n} senha está no chaveiro da outra ferramenta e não dá para trazer: digite ao conectar.|{n} senhas estão no chaveiro da outra ferramenta e não dá para trazer: digite ao conectar.', { n: elsewhere }) }}</p>
        <label v-if="source.queries.length" class="check small">
          <input v-model="withQueries" type="checkbox" />
          {{ t('Trazer {n} consulta salva|Trazer {n} consultas salvas', { n: source.queries.length }) }}
        </label>
        <p v-for="(w, k) in source.warnings" :key="k" class="muted small">{{ w }}</p>
      </div>
    </template>

    <div v-if="error" class="err"><Icon name="alert" :size="14" /> {{ error }}</div>

    <template #foot>
      <button v-if="source" class="btn ghost" :disabled="!!busy" @click="source = null">{{ t('Voltar') }}</button>
      <span class="spacer" />
      <button class="btn" @click="workspaces.dialog = null">{{ t('Cancelar') }}</button>
      <button v-if="source" class="btn primary" :disabled="!!busy || (!count && !(withQueries && source.queries.length))" @click="doImport">
        {{ busy === 'import' ? t('Importando…') : count ? t('Importar {n} conexão|Importar {n} conexões', { n: count }) : t('Importar') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.pad { padding: 8px 0 14px; }
.muted { color: var(--fg-3); }
.small { font-size: 12px; line-height: 1.45; }
.mono { font-family: var(--mono); font-size: 11px; }
.ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sources { display: grid; gap: 8px; margin-bottom: 16px; }
.source {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px; width: 100%;
  border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-2); color: var(--fg); text-align: left; cursor: pointer; font: inherit;
}
.source:hover { border-color: var(--fg-4); background: var(--surface-3); }
.s-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.s-text .mono { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s-count { color: var(--fg-2); white-space: nowrap; }
.file-box { display: flex; gap: 16px; align-items: center; padding: 14px; border: 1px dashed var(--line-3); border-radius: 8px; font-size: 13px; }
.file-box p { margin: 4px 0 0; }
.file-box .btn { flex: none; }
.list-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; }
.conns { max-height: 330px; overflow: auto; border: 1px solid var(--line-2); border-radius: 8px; }
.folder { display: flex; align-items: center; gap: 6px; padding: 8px 12px 4px; color: var(--fg-3); font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
.conn { display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; border-top: 1px solid var(--line); cursor: pointer; }
.conn:first-child { border-top: 0; }
.conn:hover { background: var(--sel); }
.conn.off { opacity: 0.55; cursor: default; }
.conn input { margin-top: 3px; }
.c-main { flex: 1; min-width: 0; display: grid; gap: 2px; }
.c-line { display: flex; align-items: center; gap: 6px; font-size: 13px; min-width: 0; }
.c-line b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 1px 6px; border-radius: 4px; background: var(--surface-4); color: var(--fg-2); font-size: 11px; }
.tag.ghost { background: none; border: 1px solid var(--line-3); }
.note { display: flex; gap: 5px; align-items: flex-start; color: var(--fg-2); }
.note .icon { margin-top: 2px; }
.opts { display: grid; gap: 10px; margin-top: 14px; }
.opt-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 13px; }
.opt-label { color: var(--fg-3); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.opt-row .input { width: 180px; height: 28px; }
.radio, .check { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
.err { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; padding: 10px 12px; border-left: 3px solid var(--fg); background: var(--surface-1); font-size: 13px; }
.spacer { flex: 1; }
.dot-wait { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--fg-3); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
</style>
