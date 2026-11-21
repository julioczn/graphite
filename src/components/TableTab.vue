<script setup>
import { ref, computed, watch } from 'vue'
import { call } from '../lib/api'
import { store, toast, newQueryTab, selectSql, caps } from '../lib/store'
import { t, i18n } from '../lib/i18n'
import { exportRows } from '../lib/export'
import Icon from './Icon.vue'
import { key } from '../lib/keys'
import { condition, qualifiedName } from '../lib/sqlText'
import ResultGrid from './ResultGrid.vue'
import StructureView from './StructureView.vue'
import TxControls from './TxControls.vue'

const props = defineProps({ tab: Object, active: Boolean })
const tab = props.tab
const ident = { sId: store.connection.sId, table: tab.table, schema: tab.schema }

const loaded = ref(false)
const loading = ref(false)
const error = ref(null)
const fields = ref([])
const binary = ref([]) // byte columns arrive as preview text and must not be written back
const rows = ref([])
const total = ref(0)
const durationMs = ref(0)
const limit = ref(100)
const offset = ref(0)
const sort = ref(null)
const filterText = ref('')
const where = ref('')
const columns = ref([])
const indexes = ref([])
const ddl = ref('')
const edits = ref({})
const deleted = ref({})
const applying = ref(false)

const pk = computed(() => columns.value.filter((c) => c.primary).map((c) => c.name))
const readOnly = computed(() => !!store.connection.saved?.config?.readOnly)
// Edits are applied in one transaction, so engines without transactions are read-only here.
const editable = computed(() => tab.kind !== 'view' && pk.value.length > 0 && !readOnly.value && caps().transactions !== false)
const colEditable = computed(() => (binary.value.length ? fields.value.map((_, i) => !binary.value.includes(i)) : null))
const insertTarget = computed(() => qualifiedName(tab.table, tab.schema))
const pendingCount = computed(() => Object.keys(edits.value).length + Object.keys(deleted.value).length)
const from = computed(() => (total.value ? offset.value + 1 : 0))
const to = computed(() => offset.value + rows.value.length)

async function loadMeta() {
  const [cols, idx, script] = await Promise.all([
    call('conn/listColumns', ident),
    call('conn/listIndexes', ident).catch(() => []),
    call('conn/createScript', ident).catch(() => ''),
  ])
  columns.value = cols
  indexes.value = idx
  ddl.value = script
}

async function loadPage() {
  loading.value = true
  error.value = null
  try {
    const r = await call('table/page', {
      ...ident, limit: limit.value, offset: offset.value,
      orderBy: sort.value?.col, dir: sort.value?.dir, where: where.value,
    })
    fields.value = r.fields
    binary.value = r.binary || []
    rows.value = r.rows
    total.value = r.total
    durationMs.value = r.durationMs
    edits.value = {}
    deleted.value = {}
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function init() {
  loaded.value = true
  try {
    await loadMeta()
  } catch (e) {
    toast(e.message, 'error')
  }
  await loadPage()
}

watch(() => props.active, (a) => { if (a && !loaded.value) init() }, { immediate: true })
// After commit / rollback the page may show values that no longer exist.
watch(() => store.txVersion, () => { if (loaded.value && !pendingCount.value) loadPage() })

watch([from, to, total, durationMs, pendingCount, () => tab.view, () => i18n.locale], () => {
  if (tab.view === 'structure') {
    tab.status = [t('{n} coluna|{n} colunas', { n: columns.value.length }), t('{n} índice|{n} índices', { n: indexes.value.length })]
    return
  }
  tab.status = [
    t('{from}–{to} de {total} linhas', { from: from.value, to: to.value, total: total.value }),
    `${durationMs.value} ms`,
    ...(pendingCount.value ? [t('{n} alteração pendente|{n} alterações pendentes', { n: pendingCount.value })] : []),
  ]
})

function guardPending() {
  return !pendingCount.value || confirm(t('Descartar as alterações pendentes?'))
}

function applyFilter() {
  if (!guardPending()) return
  where.value = filterText.value
  offset.value = 0
  loadPage()
}

function clearFilter() {
  filterText.value = ''
  if (where.value) applyFilter()
}

// dir comes from the header menu; a header click cycles asc → desc → none.
function onSort(col, dir) {
  if (!guardPending()) return
  if (dir !== undefined) sort.value = dir ? { col, dir } : null
  else if (sort.value?.col !== col) sort.value = { col, dir: 'asc' }
  else if (sort.value.dir === 'asc') sort.value = { col, dir: 'desc' }
  else sort.value = null
  loadPage()
}

// Right-click "filter by this value": narrows the current WHERE.
function onFilter(field, value, negate) {
  if (!guardPending()) return
  const type = columns.value.find((c) => c.name === field)?.type
  const cond = condition(field, value, negate, type)
  const current = where.value.trim()
  where.value = filterText.value = current ? `(${current}) AND ${cond}` : cond
  offset.value = 0
  loadPage()
}

function page(dir) {
  if (!guardPending()) return
  offset.value = Math.max(0, offset.value + dir * limit.value)
  loadPage()
}

function setLimit(e) {
  limit.value = Number(e.target.value)
  offset.value = 0
  loadPage()
}

function refresh() {
  if (guardPending()) loadPage()
}

function onEdit(r, c, value) {
  const k = `${r}:${c}`
  const next = { ...edits.value }
  if (value === rows.value[r][c] || (value !== null && rows.value[r][c] !== null && String(rows.value[r][c]) === value)) delete next[k]
  else next[k] = value
  edits.value = next
}

function onToggleDelete(r) {
  const next = { ...deleted.value }
  if (next[r]) delete next[r]
  else next[r] = true
  deleted.value = next
}

function pkOf(r) {
  return Object.fromEntries(pk.value.map((name) => [name, rows.value[r][fields.value.indexOf(name)]]))
}

async function apply() {
  const changes = []
  for (const r of Object.keys(deleted.value)) changes.push({ kind: 'delete', pk: pkOf(Number(r)) })
  const updates = []
  for (const [k, value] of Object.entries(edits.value)) {
    const [r, c] = k.split(':').map(Number)
    if (deleted.value[r]) continue
    updates.push({ kind: 'update', pk: pkOf(r), column: fields.value[c], value })
  }
  // Key columns last, so the other updates of a row still find it by its old key.
  updates.sort((a, b) => pk.value.includes(a.column) - pk.value.includes(b.column))
  changes.push(...updates)
  applying.value = true
  try {
    const { affected, tx } = await call('table/apply', { ...ident, changes })
    store.tx = tx
    const msg = `${t('{n} alteração aplicada|{n} alterações aplicadas', { n: changes.length })} (${t('{n} linha|{n} linhas', { n: affected })})`
    toast(tx.autoCommit ? msg : t('{msg} na transação — use Commit para gravar', { msg }), 'success', tx.autoCommit ? 3200 : 5000)
    await loadPage()
  } catch (e) {
    toast(t('Falha ao aplicar: {error}', { error: e.message }), 'error', 7000)
  } finally {
    applying.value = false
  }
}

function discard() {
  edits.value = {}
  deleted.value = {}
}

function openSql() {
  newQueryTab(selectSql({ name: tab.table, schema: tab.schema }), tab.table)
}
</script>

<template>
  <div class="tt">
    <div class="toolbar">
      <div class="seg">
        <button :class="{ on: tab.view === 'data' }" @click="tab.view = 'data'"><Icon name="table" :size="13" /> {{ t('Dados') }}</button>
        <button :class="{ on: tab.view === 'structure' }" @click="tab.view = 'structure'"><Icon name="structure" :size="13" /> {{ t('Estrutura') }}</button>
      </div>

      <form v-show="tab.view === 'data'" class="filter" @submit.prevent="applyFilter">
        <span class="where">WHERE</span>
        <input v-model="filterText" class="mono" spellcheck="false"
               :placeholder="columns[1] ? `${columns[1].name} = '${t('valor')}'` : t('condição SQL')" />
        <button v-if="filterText || where" type="button" class="clear" :title="t('Limpar filtro')" @click="clearFilter"><Icon name="close" :size="12" /></button>
        <button type="submit" class="btn sm">{{ t('Filtrar') }}</button>
      </form>
      <span v-show="tab.view !== 'data'" class="grow" />

      <button class="btn ghost icon sm" :title="t('Recarregar')" @click="refresh"><Icon name="refresh" :size="14" /></button>
      <button class="btn ghost icon sm" :title="t('Abrir como consulta')" @click="openSql"><Icon name="code" :size="14" /></button>
      <button class="btn ghost sm" :title="t('Exportar a tabela inteira (respeita o filtro WHERE)')"
              @click="store.dialog = { type: 'export', props: { tables: [{ name: tab.table, schema: tab.schema }], where } }"><Icon name="export" :size="13" /> {{ t('Exportar') }}</button>
      <span class="sep" />
      <TxControls />
    </div>

    <template v-if="tab.view === 'data'">
      <div class="data">
        <div v-if="loading" class="loading"><span class="spinner" /></div>
        <div v-if="error" class="err">
          <Icon name="alert" :size="18" />
          <pre>{{ error }}</pre>
        </div>
        <ResultGrid v-else :fields="fields" :rows="rows" :offset="offset" sortable :sort="sort"
                    :editable="editable" :edits="edits" :deleted="deleted" :pk="pk" :col-editable="colEditable"
                    filterable :insert-target="insertTarget" :binary="binary"
                    @sort="onSort" @edit="onEdit" @toggle-delete="onToggleDelete" @filter="onFilter" />
      </div>

      <div class="foot">
        <template v-if="pendingCount">
          <span class="pending"><Icon name="info" :size="13" /> {{ t('{n} alteração pendente|{n} alterações pendentes', { n: pendingCount }) }}</span>
          <button class="btn sm" :disabled="applying" @click="discard"><Icon name="undo" :size="12" /> {{ t('Descartar') }}</button>
          <button class="btn primary sm" :disabled="applying" @click="apply"><Icon name="check" :size="12" /> {{ t('Aplicar') }}</button>
        </template>
        <span v-else class="hint">
          <template v-if="editable">{{ t('Duplo clique edita') }} · <span class="kbd">{{ key('del') }}</span> {{ t('define NULL') }} · {{ t('clique no nº da linha +') }} <span class="kbd">{{ key('del') }}</span> {{ t('exclui') }} · {{ t('botão direito: mais ações') }}</template>
          <template v-else-if="tab.kind === 'view'">{{ t('View — somente leitura') }}</template>
          <template v-else-if="readOnly">{{ t('Conexão somente leitura') }}</template>
          <template v-else>{{ t('Sem chave primária — edição desativada') }}</template>
        </span>
        <span class="grow" />
        <select class="limit" :value="limit" :title="t('Linhas por página')" @change="setLimit">
          <option v-for="n in [50, 100, 250, 500, 1000]" :key="n" :value="n">{{ t('{count} / pág.', { count: n }) }}</option>
        </select>
        <span class="range">{{ t('{from}–{to} de {total}', { from, to, total }) }}</span>
        <button class="btn ghost icon sm" :disabled="offset === 0 || loading" :title="t('Anterior')" @click="page(-1)"><Icon name="left" :size="14" /></button>
        <button class="btn ghost icon sm" :disabled="to >= total || loading" :title="t('Próxima')" @click="page(1)"><Icon name="right" :size="14" /></button>
      </div>
    </template>

    <StructureView v-else :table="tab.title" :columns="columns" :indexes="indexes" :ddl="ddl" />
  </div>
</template>

<style scoped>
.tt { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.toolbar {
  display: flex; align-items: center; gap: 8px;
  height: 44px; flex: none; padding: 0 10px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line-2);
}
.seg { display: flex; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); }
.seg button {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 10px; border: 0; border-radius: 5px;
  background: transparent; color: var(--fg-3); cursor: pointer; font-size: 12px;
}
.seg button:hover { color: var(--fg); }
.seg button.on { background: var(--surface-5); color: var(--fg); }
.filter {
  flex: 1; display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 3px 0 10px;
  border: 1px solid var(--line-2); border-radius: var(--radius);
  background: var(--surface-1);
}
.filter:focus-within { border-color: var(--fg-4); }
.where { font: 600 11px var(--mono); color: var(--fg-4); letter-spacing: 0.04em; }
.filter input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); font-size: 12px; user-select: text; }
.filter input::placeholder { color: var(--fg-4); }
.clear { display: grid; border: 0; background: transparent; color: var(--fg-3); cursor: pointer; padding: 3px; }
.grow { flex: 1; }
.sep { width: 1px; height: 18px; background: var(--line-3); margin: 0 2px; }

.data { position: relative; flex: 1; min-height: 0; }
.loading { position: absolute; top: 10px; right: 16px; z-index: 5; }
.spinner { display: block; width: 14px; height: 14px; border: 2px solid var(--fg-4); border-top-color: var(--fg); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.err { display: flex; gap: 12px; margin: 18px; padding: 14px 16px; border: 1px solid var(--line-2); border-left: 3px solid var(--fg); border-radius: 8px; background: var(--surface-1); }
.err pre { margin: 0; white-space: pre-wrap; font: 12.5px/1.5 var(--mono); user-select: text; }

.foot {
  display: flex; align-items: center; gap: 8px;
  height: 38px; flex: none; padding: 0 10px;
  background: var(--surface-2);
  border-top: 1px solid var(--line-2);
  font-size: 12px; color: var(--fg-3);
}
.hint { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; }
.pending { display: inline-flex; align-items: center; gap: 6px; color: var(--fg); font-weight: 600; margin-right: 4px; }
.limit { height: 24px; padding: 0 6px; border: 1px solid var(--line-2); border-radius: 5px; background: var(--surface-1); color: var(--fg-2); font-size: 12px; }
.range { color: var(--fg-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
