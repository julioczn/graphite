<script setup>
// Export whole tables (one file each) or the full result of a query.
import { reactive, ref, computed, watch } from 'vue'
import { bridge } from '../lib/api'
import { store, startJob, toast, tableKey } from '../lib/store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import { t } from '../lib/i18n'

const props = defineProps({
  tables: { type: Array, default: () => [] }, // preselected [{ name, schema }]
  where: { type: String, default: '' },
  query: { type: String, default: '' }, // export this query instead of tables
  name: { type: String, default: 'resultado' },
})
const emit = defineEmits(['close'])

const FORMATS = [
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'jsonl', label: 'JSON Lines', ext: 'jsonl' },
  // INSERT statements only make sense for SQL databases.
  ...(store.connection?.caps?.sql === false ? [] : [{ id: 'sql', label: 'SQL INSERT', ext: 'sql' }]),
]
const all = store.tables.filter((t) => t.type === 'table' || t.type === 'view')
const key = (t) => `${t.schema ?? ''}.${t.name}`

const form = reactive({
  format: 'csv',
  delimiter: ',',
  header: true,
  bom: false,
  nullAs: '',
  where: props.where,
  sqlTable: props.name.replace(/\W+/g, '_') || 'resultado',
  target: '',
  selected: props.tables.map(key),
  busy: false,
})
const filter = ref('')

const isQuery = computed(() => !!props.query)
const chosen = computed(() => all.filter((t) => form.selected.includes(key(t))))
const many = computed(() => !isQuery.value && chosen.value.length > 1)
const fmt = computed(() => FORMATS.find((f) => f.id === form.format))
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return all.filter((t) => !q || tableKey(t).toLowerCase().includes(q))
})
const canStart = computed(() => form.target && !form.busy && (isQuery.value || chosen.value.length))

// The destination changes nature (file vs folder) with the selection.
watch([many, () => form.format], () => { form.target = '' })

async function chooseTarget() {
  const base = isQuery.value ? props.name : chosen.value[0]?.name || 'export'
  const target = await bridge.choosePath(many.value
    ? { mode: 'folder', title: t('Pasta de destino (um arquivo por tabela)') }
    : { mode: 'save', title: t('Salvar exportação'), defaultName: `${base.replace(/[^\w.-]+/g, '_')}.${fmt.value.ext}`, filters: [{ name: fmt.value.label, extensions: [fmt.value.ext] }] })
  if (target) form.target = target
}

async function start() {
  form.busy = true
  try {
    const csv = { delimiter: form.delimiter, header: form.header, bom: form.bom, nullAs: form.nullAs }
    await startJob('export/start', {
      format: form.format, csv,
      ...(isQuery.value
        ? { query: props.query, file: form.target, sqlTable: form.sqlTable }
        : {
            tables: chosen.value.map((tbl) => ({ name: tbl.name, schema: tbl.schema, where: chosen.value.length === 1 ? form.where : '' })),
            ...(many.value ? { dir: form.target } : { file: form.target }),
          }),
    })
    emit('close')
  } catch (e) {
    toast(e.message, 'error', 6000)
  } finally {
    form.busy = false
  }
}

function setAllShown(on) {
  const keys = new Set(shown.value.map(key))
  form.selected = on ? [...new Set([...form.selected, ...keys])] : form.selected.filter((k) => !keys.has(k))
}
</script>

<template>
  <Modal :title="isQuery ? t('Exportar resultado da consulta') : t('Exportar dados')"
         :subtitle="isQuery ? t('A consulta roda de novo, numa conexão só leitura, sem limite de linhas') : t('Tabelas inteiras, lidas em lotes — sem limite de linhas')"
         width="580px" @close="emit('close')">
    <div class="field">
      <label>{{ t('Formato') }}</label>
      <div class="seg">
        <button v-for="f in FORMATS" :key="f.id" :class="{ on: form.format === f.id }" @click="form.format = f.id">{{ f.label }}</button>
      </div>
    </div>

    <div v-if="form.format === 'csv'" class="opts">
      <label>{{ t('Separador') }}
        <select v-model="form.delimiter" class="input">
          <option value=",">{{ t('Vírgula ( , )') }}</option>
          <option value=";">{{ t('Ponto e vírgula ( ; )') }}</option>
          <option :value="'\t'">{{ t('Tab') }}</option>
          <option value="|">{{ t('Barra ( | )') }}</option>
        </select>
      </label>
      <label>{{ t('NULL como') }}
        <select v-model="form.nullAs" class="input">
          <option value="">{{ t('vazio') }}</option>
          <option value="NULL">NULL</option>
          <option value="\N">\N</option>
        </select>
      </label>
      <label class="check"><input v-model="form.header" type="checkbox" /> {{ t('Cabeçalho') }}</label>
      <label class="check" :title="t('Faz o Excel reconhecer acentos')"><input v-model="form.bom" type="checkbox" /> BOM UTF-8 (Excel)</label>
    </div>
    <div v-if="form.format === 'sql' && isQuery" class="field">
      <label>{{ t('Tabela nos INSERTs') }}</label>
      <input v-model="form.sqlTable" class="input mono" />
    </div>

    <div v-if="isQuery" class="field">
      <label>{{ t('Consulta') }}</label>
      <pre class="sql">{{ query }}</pre>
    </div>
    <template v-else>
      <div class="field">
        <label>{{ t('Tabelas') }} <span class="count">{{ t('{n} selecionada|{n} selecionadas', { n: chosen.length }) }}</span></label>
        <div class="picker">
          <div class="pick-head">
            <input v-model="filter" class="input" :placeholder="t('Filtrar')" />
            <button class="btn ghost sm" @click="setAllShown(true)">{{ t('Marcar') }}</button>
            <button class="btn ghost sm" @click="setAllShown(false)">{{ t('Desmarcar') }}</button>
          </div>
          <div class="list">
            <label v-for="tbl in shown" :key="key(tbl)" class="check item">
              <input v-model="form.selected" type="checkbox" :value="key(tbl)" />
              <Icon :name="tbl.type === 'view' ? 'view' : 'table'" :size="12" /> {{ tableKey(tbl) }}
            </label>
          </div>
        </div>
      </div>
      <div v-if="chosen.length === 1" class="field">
        <label>{{ t('Filtro WHERE') }} <span class="count">{{ t('opcional') }}</span></label>
        <input v-model="form.where" class="input mono" spellcheck="false" :placeholder="t('status = \'pago\'')" />
      </div>
    </template>

    <div class="field">
      <label>{{ many ? t('Pasta de destino') : t('Arquivo de destino') }}</label>
      <div class="row">
        <input class="input mono" :value="form.target" readonly :placeholder="many ? t('Um arquivo por tabela nesta pasta…') : t('Escolha onde salvar…')" @click="chooseTarget" />
        <button class="btn" @click="chooseTarget"><Icon name="folder" :size="13" /> {{ t('Escolher…') }}</button>
      </div>
    </div>

    <template #foot>
      <span class="grow" />
      <button class="btn" @click="emit('close')">{{ t('Cancelar') }}</button>
      <button class="btn primary" :disabled="!canStart" @click="start"><Icon name="export" :size="13" /> {{ t('Exportar') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.field { margin-bottom: 14px; }
.field > label { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; color: var(--fg-2); font-size: 12px; font-weight: 600; }
.count { color: var(--fg-4); font-weight: 400; }
.row { display: flex; gap: 8px; }
.row .input { flex: 1; cursor: pointer; }
.seg { display: inline-flex; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); }
.seg button { height: 26px; padding: 0 12px; border: 0; border-radius: 5px; background: transparent; color: var(--fg-3); cursor: pointer; font-size: 12px; }
.seg button.on { background: var(--surface-5); color: var(--fg); }
.opts { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px; margin: -4px 0 14px; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-2); }
.opts > label:not(.check) { display: flex; flex-direction: column; gap: 4px; color: var(--fg-3); font-size: 11.5px; }
.opts select { height: 28px; min-width: 150px; }
.check { display: flex; align-items: center; gap: 7px; color: var(--fg-2); cursor: pointer; height: 28px; }
.picker { border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-1); }
.pick-head { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line-2); }
.pick-head .input { flex: 1; height: 28px; }
.list { max-height: 210px; overflow: auto; padding: 4px 10px; }
.item { height: 24px; font: 12px var(--mono); }
.item .icon { color: var(--fg-4); }
.sql { margin: 0; max-height: 140px; overflow: auto; padding: 10px; border-radius: 6px; background: var(--bg); color: var(--fg-2); font: 12px/1.5 var(--mono); white-space: pre-wrap; }
.grow { flex: 1; }
</style>
