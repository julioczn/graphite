<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { call } from '../lib/api'
import { store, toast, refreshEntities, tableKey, caps } from '../lib/store'
import { t, i18n } from '../lib/i18n'
import { exportRows } from '../lib/export'
import Icon from './Icon.vue'
import { key, shortcut } from '../lib/keys'
import SqlEditor from './SqlEditor.vue'
import ResultGrid from './ResultGrid.vue'
import TxControls from './TxControls.vue'
import SnippetPicker from './SnippetPicker.vue'
import { ai, ask } from '../lib/ai'

const props = defineProps({ tab: Object, active: Boolean })
const tab = props.tab

// --- snippets ------------------------------------------------------------------
const snippetAnchor = ref(null) // DOMRect of the toolbar button while the picker is open
function toggleSnippets(e) {
  snippetAnchor.value = snippetAnchor.value ? null : e.currentTarget.getBoundingClientRect()
}
function insertSnippet(s) {
  snippetAnchor.value = null
  editor.value?.insertSnippet(s.body)
}
// SQL sent from the assistant panel ("Inserir") lands in the active query tab.
watch(() => ai.insert, (ins) => {
  if (!ins || !props.active) return
  ai.insert = null
  editor.value?.insertText(ins.sql)
})

function fixWithAi(r) {
  ask(t('Esta consulta deu erro. Explique a causa e mostre a versão corrigida.'), { sql: r.sql, error: r.message })
}

// A tab opened with generated SQL (sidebar → Gerar …) expands it once mounted,
// so its tab stops work like a typed snippet.
onMounted(() => {
  if (!tab.snippet) return
  const body = tab.snippet
  delete tab.snippet
  nextTick(() => editor.value?.insertSnippet(body))
})

const editor = ref(null)
const results = ref([])
const current = ref(0)
const running = ref(false)
const ranAt = ref(null)
const split = ref(45) // editor height %
const body = ref(null)
const saveDialog = ref(null) // { title }
const titleInput = ref(null)
let savedSql = tab.sql

const result = computed(() => results.value[current.value])
const DDL = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME', 'TRUNCATE'])
const applying = ref(false)
// Re-running for a full export is only safe for plain reads.
const canExportAll = computed(() => result.value?.kind === 'rows' && ['SELECT', 'WITH', 'VALUES', 'TABLE'].includes(result.value.command)
  && !(result.value.command === 'WITH' && /\b(insert|update|delete)\b/i.test(result.value.sql)))

// --- Editing query results -------------------------------------------------
// The utility tells us which result columns come straight from a table whose
// primary key is also in the result (`result.edit`). Those cells can be edited
// in place and written back with UPDATE / DELETE by primary key.
const readOnly = computed(() => !!store.connection.saved?.config?.readOnly)
const edit = computed(() => (result.value?.kind === 'rows' && !readOnly.value && caps().transactions !== false ? result.value.edit : null))
const colEditable = computed(() => edit.value?.columns.map(Boolean) ?? null)
const pkFields = computed(() => {
  if (!edit.value) return []
  const idx = new Set(edit.value.tables.flatMap((t) => t.pk.map((k) => k.index)))
  return result.value.fields.filter((_, i) => idx.has(i))
})
const canDelete = computed(() => edit.value?.tables.length === 1)
const pendingCount = computed(() => {
  const r = result.value
  return r?.kind === 'rows' ? Object.keys(r.edits).length + Object.keys(r.deleted).length : 0
})
const pendingAll = computed(() => results.value.some((r) => r.kind === 'rows' && (Object.keys(r.edits).length || Object.keys(r.deleted).length)))
const editTargets = computed(() => {
  if (!edit.value) return ''
  return edit.value.tables.map((t) => tableKey({ name: t.table, schema: t.schema })).join(', ')
})

function pkOf(r, t) {
  const row = result.value.rows[r]
  return Object.fromEntries(t.pk.map((k) => [k.column, row[k.index]]))
}

// A row from an outer join may have no key for one of the tables.
function canEdit(r, c) {
  const col = edit.value?.columns[c]
  if (!col) return false
  const row = result.value.rows[r]
  return edit.value.tables[col.table].pk.every((k) => row[k.index] !== null)
}

function onEdit(r, c, value) {
  const res = result.value
  const k = `${r}:${c}`
  const next = { ...res.edits }
  const orig = res.rows[r][c]
  if (value === orig || (value !== null && orig !== null && String(orig) === value)) delete next[k]
  else next[k] = value
  res.edits = next
}

function onToggleDelete(r) {
  if (!canEdit(r, edit.value.tables[0].pk[0].index)) return
  const res = result.value
  const next = { ...res.deleted }
  if (next[r]) delete next[r]
  else next[r] = true
  res.deleted = next
}

function discard() {
  result.value.edits = {}
  result.value.deleted = {}
}

function guardPending() {
  return !pendingAll.value || confirm(t('Descartar as alterações pendentes no resultado?'))
}

async function apply() {
  const res = result.value
  const info = res.edit
  const changes = []
  for (const r of Object.keys(res.deleted).map(Number)) {
    const t = info.tables[0]
    changes.push({ kind: 'delete', table: t.table, schema: t.schema, pk: pkOf(r, t) })
  }
  const updates = []
  for (const [k, value] of Object.entries(res.edits)) {
    const [r, c] = k.split(':').map(Number)
    if (res.deleted[r]) continue
    const col = info.columns[c]
    const t = info.tables[col.table]
    const isKey = t.pk.some((p) => p.column === col.column)
    updates.push({ isKey, change: { kind: 'update', table: t.table, schema: t.schema, pk: pkOf(r, t), column: col.column, value } })
  }
  // Key columns last, so the other updates of a row still find it by its old key.
  updates.sort((a, b) => a.isKey - b.isKey)
  changes.push(...updates.map((u) => u.change))

  applying.value = true
  try {
    const { affected, tx } = await call('query/apply', { sId: store.connection.sId, changes })
    store.tx = tx
    // Reflect the write in the grid instead of re-running the script.
    for (const [k, value] of Object.entries(res.edits)) {
      const [r, c] = k.split(':').map(Number)
      if (res.deleted[r]) continue
      const src = info.columns[c]
      info.columns.forEach((o, i) => { if (o && o.table === src.table && o.column === src.column) res.rows[r][i] = value })
    }
    const gone = Object.keys(res.deleted).map(Number).sort((a, b) => b - a)
    for (const r of gone) res.rows.splice(r, 1)
    res.rowCount -= gone.length
    res.edits = {}
    res.deleted = {}
    const msg = `${t('{n} alteração aplicada|{n} alterações aplicadas', { n: changes.length })} (${t('{n} linha|{n} linhas', { n: affected })})`
    toast(tx.autoCommit ? msg : t('{msg} na transação — use Commit para gravar', { msg }), 'success', tx.autoCommit ? 3200 : 5000)
    updateStatus()
  } catch (e) {
    toast(t('Falha ao aplicar: {error}', { error: e.message }), 'error', 8000)
  } finally {
    applying.value = false
  }
}

watch(() => tab.sql, (v) => { tab.dirty = !!tab.savedId && v !== savedSql })
watch(() => props.active, (a) => a && nextTick(() => editor.value?.focus()), { immediate: true })

function updateStatus() {
  const r = result.value
  if (!r) return (tab.status = null)
  const parts = []
  if (results.value.length > 1) parts.push(t('Resultado {i}/{count}', { i: current.value + 1, count: results.value.length }))
  if (r.kind === 'rows') parts.push(r.truncated ? t('{shown} de {total} linhas', { shown: r.rows.length, total: r.rowCount }) : t('{n} linha|{n} linhas', { n: r.rowCount }))
  if (r.kind === 'affected') parts.push(t('{n} afetada|{n} afetadas', { n: r.affected }))
  if (r.kind === 'error') parts.push(t('Erro'))
  parts.push(`${r.durationMs} ms`)
  if (pendingCount.value) parts.push(t('{n} alteração pendente|{n} alterações pendentes', { n: pendingCount.value }))
  tab.status = parts
}
watch([current, results, pendingCount, () => i18n.locale], updateStatus)

async function execute(sql) {
  if (!sql.trim() || running.value || !guardPending()) return
  running.value = true
  const t0 = performance.now()
  try {
    const { results: res, tx } = await call('query/run', { sId: store.connection.sId, sql })
    store.tx = tx
    for (const r of res) if (r.kind === 'rows') Object.assign(r, { edits: {}, deleted: {} })
    results.value = res
    ranAt.value = new Date()
    // Jump to the first error, otherwise to the last result set with rows.
    const err = res.findIndex((r) => r.kind === 'error')
    const lastRows = res.findLastIndex((r) => r.kind === 'rows')
    current.value = err >= 0 ? err : lastRows >= 0 ? lastRows : Math.max(0, res.length - 1)
    const rowCount = res.reduce((n, r) => n + (r.rowCount || r.affected || 0), 0)
    call('app/addHistory', {
      entry: {
        connectionId: store.connection.saved?.id ?? null, sql: sql.trim(),
        durationMs: Math.round(performance.now() - t0), rowCount, ok: err < 0,
      },
    }).then(() => store.historyVersion++)
    if (res.some((r) => r.kind !== 'error' && DDL.has(r.command))) refreshEntities().catch(() => {})
  } catch (e) {
    results.value = [{ kind: 'error', message: e.message, sql, durationMs: 0 }]
    current.value = 0
  } finally {
    running.value = false
  }
}

const runAll = () => execute(editor.value.textForRun())
const runCurrent = () => execute(editor.value.currentStatement())

async function save() {
  if (tab.savedId) {
    await call('app/saveQuery', { query: { id: tab.savedId, title: tab.title, sql: tab.sql } })
    savedSql = tab.sql
    tab.dirty = false
    store.savedVersion++
    toast(t('Consulta salva'), 'success')
    return
  }
  // Default titles ("Consulta #3") don't make a good name for a saved query.
  const untitled = ['Consulta #', t('Consulta #{n}', { n: '' })].some((p) => tab.title.startsWith(p))
  saveDialog.value = { title: untitled ? '' : tab.title }
  nextTick(() => titleInput.value?.focus())
}

async function confirmSave() {
  const title = saveDialog.value.title.trim()
  if (!title) return
  tab.savedId = await call('app/saveQuery', { query: { title, sql: tab.sql } })
  tab.title = title
  savedSql = tab.sql
  tab.dirty = false
  saveDialog.value = null
  store.savedVersion++
  toast(t('Consulta salva'), 'success')
}

function startSplit(e) {
  const rect = body.value.getBoundingClientRect()
  const move = (ev) => { split.value = Math.min(85, Math.max(12, ((ev.clientY - rect.top) / rect.height) * 100)) }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'row-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function label(r, i) {
  if (r.kind === 'rows') return `${r.command || t('Resultado')} ${i + 1} · ${r.rowCount}`
  if (r.kind === 'affected') return `${r.command || t('Comando')} ${i + 1} · ${r.affected}`
  return t('Erro {i}', { i: i + 1 })
}
</script>

<template>
  <div ref="body" class="qt">
    <div class="ed" :style="{ height: split + '%' }">
      <SqlEditor ref="editor" v-model="tab.sql" :dialect="store.connection.dialect" :schema="store.schemaMap"
                 @run="runAll" @run-current="runCurrent" @save="save" />
    </div>

    <div class="bar" @mousedown.self.prevent="startSplit">
      <button class="btn primary sm" :disabled="running" :title="`${t('Executar')} (${shortcut('mod', 'enter')})`" @click="runAll">
        <Icon name="play" :size="12" /> {{ running ? t('Executando…') : t('Executar') }}
      </button>
      <button class="btn sm" :disabled="running" :title="`${t('Executar instrução atual')} (${shortcut('mod', 'shift', 'enter')})`" @click="runCurrent">
        <Icon name="playLine" :size="12" /> {{ t('Atual') }}
      </button>
      <span class="sep" />
      <button class="btn ghost sm" :title="`${tab.savedId ? t('Salvar') : t('Salvar como…')} (${shortcut('mod', 's')})`" @click="save">
        <Icon name="save" :size="13" /> {{ t('Salvar') }}
      </button>
      <button class="btn ghost sm snip-btn" :class="{ on: snippetAnchor }" data-snippet-toggle
              :title="t('Inserir snippet de SQL (ou digite o atalho no editor, ex.: sel, ins, lj)')" @click="toggleSnippets">
        <Icon name="bolt" :size="13" /> {{ t('Snippets') }}
      </button>
      <SnippetPicker v-if="snippetAnchor" :anchor="snippetAnchor" :dialect="store.connection.dialect"
                     @pick="insertSnippet" @close="snippetAnchor = null" />
      <span class="sep" />
      <TxControls />

      <div class="chips" @mousedown.self.prevent="startSplit">
        <button v-for="(r, i) in results.length > 1 ? results : []" :key="i" class="chip"
                :class="{ on: i === current, err: r.kind === 'error' }" :title="r.sql" @click="current = i">
          {{ label(r, i) }}
        </button>
      </div>

      <template v-if="result?.kind === 'rows'">
        <button class="btn ghost sm" :title="t('Exportar CSV')" @click="exportRows(result.fields, result.rows, 'csv', tab.title)">
          <Icon name="download" :size="13" /> CSV
        </button>
        <button class="btn ghost sm" :title="t('Exportar JSON')" @click="exportRows(result.fields, result.rows, 'json', tab.title)">
          JSON
        </button>
        <button v-if="canExportAll" class="btn ghost sm" :title="t('Executa a consulta de novo e exporta todas as linhas (sem o limite de {limit})', { limit: 5000 })"
                @click="store.dialog = { type: 'export', props: { query: result.sql, name: tab.title } }">
          <Icon name="export" :size="13" /> {{ t('Tudo…') }}
        </button>
      </template>
    </div>

    <div class="res">
      <div v-if="running" class="overlay"><span class="spinner" /> {{ t('Executando consulta…') }}</div>

      <div v-if="!results.length" class="empty">
        <Icon name="play" :size="22" />
        <div>{{ t('Execute uma consulta para ver os resultados') }}</div>
        <div class="hints">
          <span><span class="kbd">{{ key('mod') }}</span> <span class="kbd">{{ key('enter') }}</span> {{ t('executar tudo / seleção') }}</span>
          <span><span class="kbd">{{ key('mod') }}</span> <span class="kbd">{{ key('shift') }}</span> <span class="kbd">{{ key('enter') }}</span> {{ t('instrução atual') }}</span>
        </div>
      </div>

      <template v-else-if="result">
        <ResultGrid v-if="result.kind === 'rows'" :fields="result.fields" :rows="result.rows"
                    :editable="!!edit" :edits="result.edits" :deleted="result.deleted" :pk="pkFields"
                    :col-editable="colEditable" :can-edit="canEdit" :can-delete="canDelete"
                    @edit="onEdit" @toggle-delete="onToggleDelete" />

        <div v-else-if="result.kind === 'affected'" class="msg">
          <Icon name="check" :size="20" />
          <div>
            <div class="msg-title">{{ t('{command} executado', { command: result.command }) }}</div>
            <div class="muted">{{ t('{n} linha afetada|{n} linhas afetadas', { n: result.affected }) }} · {{ result.durationMs }} ms</div>
          </div>
        </div>

        <div v-else class="msg error">
          <Icon name="alert" :size="20" />
          <div class="err-body">
            <div class="msg-title">{{ t('Erro na consulta') }}</div>
            <pre class="err-text">{{ result.message }}</pre>
            <pre class="err-sql">{{ result.sql }}</pre>
            <button class="btn sm fix-ai" :disabled="ai.chat.busy" :title="t('Pedir ao assistente de AI para explicar e corrigir')" @click="fixWithAi(result)">
              <Icon name="sparkle" :size="12" /> {{ t('Corrigir com AI') }}
            </button>
          </div>
        </div>

        <div v-if="result.truncated" class="trunc">
          {{ t('Mostrando as primeiras {shown} de {total} linhas. Use LIMIT para refinar.', { shown: result.rows.length, total: result.rowCount }) }}
        </div>

        <div v-if="result.kind === 'rows'" class="foot" :class="{ pending: pendingCount }">
          <template v-if="pendingCount">
            <span class="pending-label"><Icon name="info" :size="13" /> {{ t('{n} alteração pendente em {tables}|{n} alterações pendentes em {tables}', { n: pendingCount, tables: editTargets }) }}</span>
            <span class="grow" />
            <span v-if="!store.tx.autoCommit" class="hint">{{ t('Modo manual: fica na transação até o Commit') }}</span>
            <button class="btn sm" :disabled="applying" @click="discard"><Icon name="undo" :size="12" /> {{ t('Descartar') }}</button>
            <button class="btn primary sm" :disabled="applying" :title="t('Gravar as alterações no banco')" @click="apply">
              <Icon name="check" :size="12" /> {{ applying ? t('Aplicando…') : t('Aplicar') }}
            </button>
          </template>
          <span v-else-if="edit" class="hint">
            <Icon name="table" :size="12" /> {{ t('Editável: {tables}', { tables: editTargets }) }} · {{ t('duplo clique edita') }} · <span class="kbd">{{ key('del') }}</span> {{ t('define NULL') }}<template v-if="canDelete"> · {{ t('nº da linha +') }} <span class="kbd">{{ key('del') }}</span> {{ t('exclui') }}</template> · {{ t('botão direito: mais ações') }}
          </span>
          <span v-else-if="readOnly" class="hint">{{ t('Conexão somente leitura') }}</span>
          <span v-else class="hint">{{ t('Somente leitura: o resultado não traz a chave primária de uma tabela') }}</span>
        </div>
      </template>
    </div>

    <div v-if="saveDialog" class="modal" @mousedown.self="saveDialog = null">
      <form class="dialog" @submit.prevent="confirmSave" @keydown.esc="saveDialog = null">
        <h3>{{ t('Salvar consulta') }}</h3>
        <div class="field">
          <label for="sq-title">{{ t('Título') }}</label>
          <input id="sq-title" ref="titleInput" v-model="saveDialog.title" class="input" :placeholder="t('Ex.: Pedidos por cliente')" />
        </div>
        <div class="actions">
          <button type="button" class="btn" @click="saveDialog = null">{{ t('Cancelar') }}</button>
          <button type="submit" class="btn primary" :disabled="!saveDialog.title.trim()">{{ t('Salvar') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.qt { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ed { min-height: 60px; }
.bar {
  display: flex; align-items: center; gap: 6px;
  height: 40px; flex: none; padding: 0 10px;
  background: var(--surface-1);
  border-top: 1px solid var(--line-2);
  border-bottom: 1px solid var(--line-2);
  cursor: row-resize;
}
.bar > * { cursor: default; }
.bar .btn { cursor: pointer; }
.sep { width: 1px; height: 18px; background: var(--line-3); margin: 0 4px; }
.chips { flex: 1; display: flex; gap: 4px; overflow-x: auto; padding: 0 6px; cursor: row-resize; align-self: stretch; align-items: center; }
.chips::-webkit-scrollbar { height: 0; }
.chip {
  flex: none; height: 24px; padding: 0 10px;
  border: 1px solid var(--line-2); border-radius: 12px;
  background: transparent; color: var(--fg-3); cursor: pointer; font-size: 11.5px;
}
.chip:hover { color: var(--fg); border-color: var(--line-3); }
.chip.on { background: var(--surface-5); color: var(--fg); border-color: var(--surface-6); }
.snip-btn.on { background: var(--sel-2); color: var(--fg); }
.chip.err { border-style: dashed; }
.res { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.res > .grid { flex: 1; }
.overlay {
  position: absolute; inset: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  background: rgba(10, 10, 10, 0.6); color: var(--fg-2);
}
.spinner { width: 16px; height: 16px; border: 2px solid var(--fg-4); border-top-color: var(--fg); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.hints { display: flex; gap: 18px; margin-top: 6px; color: var(--fg-3); flex-wrap: wrap; justify-content: center; }

.msg { display: flex; gap: 14px; margin: 18px; padding: 16px 18px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-1); color: var(--fg-2); }
.msg .icon { margin-top: 2px; color: var(--fg); }
.msg-title { color: var(--fg); font-weight: 600; margin-bottom: 2px; }
.msg.error { border-left: 3px solid var(--fg); }
.err-body { min-width: 0; flex: 1; }
.err-text { margin: 6px 0 10px; white-space: pre-wrap; font: 12.5px/1.5 var(--mono); color: var(--fg); user-select: text; }
.fix-ai { margin-top: 10px; align-self: flex-start; }
.err-sql { margin: 0; padding: 10px; max-height: 160px; overflow: auto; border-radius: 6px; background: var(--bg); color: var(--fg-3); font: 12px/1.5 var(--mono); white-space: pre-wrap; user-select: text; }
.foot {
  display: flex; align-items: center; gap: 8px; flex: none;
  height: 36px; padding: 0 10px;
  border-top: 1px solid var(--line-2);
  background: var(--surface-2);
  font-size: 12px; color: var(--fg-3);
}
.foot.pending { background: var(--surface-4); border-top-color: var(--fg-4); }
.foot .hint { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pending-label { display: inline-flex; align-items: center; gap: 6px; color: var(--fg); font-weight: 600; white-space: nowrap; }
.grow { flex: 1; }
.trunc { flex: none; padding: 6px 12px; border-top: 1px solid var(--line-2); background: var(--surface-3); color: var(--fg-2); font-size: 12px; }

.modal { position: fixed; inset: 0; z-index: 950; display: grid; place-items: center; background: rgba(0, 0, 0, 0.6); }
.dialog { width: min(420px, 90vw); padding: 22px; border: 1px solid var(--line-3); border-radius: 10px; background: var(--surface-3); box-shadow: 0 24px 80px rgba(0,0,0,.7); }
.dialog h3 { margin: 0 0 16px; font-size: 15px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
</style>
