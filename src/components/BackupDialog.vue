<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { bridge, call } from '../lib/api'
import { startJob, toast, useSession } from '../lib/store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import { t } from '../lib/i18n'

const sess = useSession()

const emit = defineEmits(['close'])
const c = sess.connection
const isPg = c.dialect === 'postgres'
const scopeName = c.dialect === 'sqlite' ? c.database.replace(/\.\w+$/, '') : c.schema || c.database || t('banco')

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

const form = reactive({
  file: '',
  gzip: true,
  content: 'all', // all | structure | data
  drop: true,
  allTables: true,
  tables: [],
  schemas: c.schema ? [c.schema] : [],
})
const tables = ref([])
const schemas = ref([])
const filter = ref('')
const busy = ref(false)

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return tables.value.filter((t) => !q || t.name.toLowerCase().includes(q))
})
const canStart = computed(() => form.file && !busy.value && (form.allTables || form.tables.length) && (!isPg || form.schemas.length))

onMounted(async () => {
  tables.value = sess.tables.filter((t) => t.type === 'table')
  if (isPg) schemas.value = (await call('conn/listSchemas', { sId: c.sId })).filter((s) => !s.system)
})

// Keep the extension in step with the gzip switch.
watch(() => form.gzip, (gz) => {
  if (!form.file) return
  form.file = gz ? form.file.replace(/\.sql$/i, '.sql.gz') : form.file.replace(/\.sql\.gz$/i, '.sql')
})

// Table subsets only make sense inside a single schema.
watch(() => form.schemas.length, (n) => { if (n !== 1) form.allTables = true })

async function chooseFile() {
  const ext = form.gzip ? 'sql.gz' : 'sql'
  const file = await bridge.choosePath({
    mode: 'save', title: t('Salvar backup'), defaultName: `${scopeName}_${stamp()}.${ext}`,
    filters: [{ name: t('Backup SQL'), extensions: form.gzip ? ['gz'] : ['sql'] }],
  })
  if (!file) return
  form.file = file
  form.gzip = /\.gz$/i.test(file)
}

function toggleSchema(name) {
  const i = form.schemas.indexOf(name)
  if (i >= 0) form.schemas.splice(i, 1)
  else form.schemas.push(name)
}

function setAllShown(on) {
  const names = new Set(shown.value.map((t) => t.name))
  form.tables = on ? [...new Set([...form.tables, ...names])] : form.tables.filter((n) => !names.has(n))
}

async function start() {
  busy.value = true
  try {
    await startJob(sess, 'backup/start', {
      file: form.file,
      gzip: form.gzip,
      structure: form.content !== 'data',
      data: form.content !== 'structure',
      drop: form.drop && form.content !== 'data',
      tables: form.allTables ? null : form.tables,
      schemas: isPg ? form.schemas : undefined,
    })
    emit('close')
  } catch (e) {
    toast(e.message, 'error', 6000)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="t('Backup do banco')" :subtitle="`${c.saved?.name || c.database} · ${isPg ? 'PostgreSQL' : c.dialect === 'mysql' ? 'MySQL / MariaDB' : 'SQLite'}`" width="560px" @close="emit('close')">
    <div class="field">
      <label>{{ t('Arquivo de destino') }}</label>
      <div class="row">
        <input class="input mono" :value="form.file" readonly :placeholder="t('Escolha onde salvar…')" @click="chooseFile" />
        <button class="btn" @click="chooseFile"><Icon name="folder" :size="13" /> {{ t('Escolher…') }}</button>
      </div>
    </div>

    <div v-if="isPg" class="field">
      <label>{{ t('Schemas') }}</label>
      <div class="chips">
        <button v-for="s in schemas" :key="s.name" class="chip" :class="{ on: form.schemas.includes(s.name) }" @click="toggleSchema(s.name)">
          <Icon v-if="form.schemas.includes(s.name)" name="check" :size="11" /> {{ s.name }}
        </button>
      </div>
    </div>

    <div class="field">
      <label>{{ t('Conteúdo') }}</label>
      <div class="seg">
        <button :class="{ on: form.content === 'all' }" @click="form.content = 'all'">{{ t('Estrutura + dados') }}</button>
        <button :class="{ on: form.content === 'structure' }" @click="form.content = 'structure'">{{ t('Só estrutura') }}</button>
        <button :class="{ on: form.content === 'data' }" @click="form.content = 'data'">{{ t('Só dados') }}</button>
      </div>
    </div>

    <div class="checks">
      <label class="check"><input v-model="form.gzip" type="checkbox" /> {{ t('Compactar (.sql.gz)') }}</label>
      <label class="check" :class="{ off: form.content === 'data' }"><input v-model="form.drop" type="checkbox" :disabled="form.content === 'data'" /> {{ t('Incluir DROP … IF EXISTS antes de cada objeto') }}</label>
    </div>

    <div class="field">
      <label>{{ t('Tabelas') }}</label>
      <div class="seg">
        <button :class="{ on: form.allTables }" @click="form.allTables = true">{{ t('Todas') }}</button>
        <button :class="{ on: !form.allTables }" :disabled="isPg && form.schemas.length !== 1"
                :title="isPg && form.schemas.length !== 1 ? t('Selecione um único schema para escolher tabelas') : ''"
                @click="form.allTables = false">{{ t('Escolher…') }}</button>
      </div>
      <div v-if="!form.allTables" class="picker">
        <div class="pick-head">
          <input v-model="filter" class="input" :placeholder="t('Filtrar tabelas')" />
          <button class="btn ghost sm" @click="setAllShown(true)">{{ t('Marcar') }}</button>
          <button class="btn ghost sm" @click="setAllShown(false)">{{ t('Desmarcar') }}</button>
        </div>
        <div class="list">
          <label v-for="tbl in shown" :key="tbl.name" class="check item">
            <input v-model="form.tables" type="checkbox" :value="tbl.name" /> {{ tbl.name }}
          </label>
        </div>
        <div class="hint">{{ t('{count} de {total} selecionadas · views, funções e triggers só entram no backup completo', { count: form.tables.length, total: tables.length }) }}</div>
      </div>
    </div>

    <p class="note">
      <Icon name="info" :size="13" />
      {{ t('Gera um script SQL lido num snapshot consistente, numa conexão separada: dá para continuar usando o app.') }}
      <template v-if="isPg"> {{ t('Inclui extensões, tipos enum, sequências, funções, índices, FKs, views e triggers; não inclui donos nem permissões.') }}</template>
      <template v-else-if="c.dialect === 'mysql'"> {{ t('Inclui tabelas, views, triggers, procedures e functions (sem DEFINER).') }}</template>
    </p>

    <template #foot>
      <span class="grow" />
      <button class="btn" @click="emit('close')">{{ t('Cancelar') }}</button>
      <button class="btn primary" :disabled="!canStart" @click="start"><Icon name="archive" :size="13" /> {{ t('Gerar backup') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.field { margin-bottom: 14px; }
.field > label { display: block; margin-bottom: 6px; color: var(--fg-2); font-size: 12px; font-weight: 600; }
.row { display: flex; gap: 8px; }
.row .input { flex: 1; cursor: pointer; }
.seg { display: inline-flex; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); }
.seg button { height: 26px; padding: 0 12px; border: 0; border-radius: 5px; background: transparent; color: var(--fg-3); cursor: pointer; font-size: 12px; }
.seg button.on { background: var(--surface-5); color: var(--fg); }
.seg button:disabled { opacity: 0.4; cursor: default; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border: 1px solid var(--line-3); border-radius: 13px; background: transparent; color: var(--fg-3); cursor: pointer; font: 12px var(--mono); }
.chip.on { background: var(--surface-5); color: var(--fg); border-color: var(--fg-4); }
.checks { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.check { display: flex; align-items: center; gap: 8px; color: var(--fg-2); cursor: pointer; }
.check.off { opacity: 0.45; }
.picker { margin-top: 8px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-1); }
.pick-head { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line-2); }
.pick-head .input { flex: 1; height: 28px; }
.list { max-height: 200px; overflow: auto; padding: 6px 10px; }
.item { padding: 3px 0; font: 12px var(--mono); }
.hint { padding: 6px 10px; border-top: 1px solid var(--line-2); color: var(--fg-4); font-size: 11.5px; }
.note { display: flex; gap: 8px; margin: 4px 0 0; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 8px; color: var(--fg-3); font-size: 12px; line-height: 1.5; }
.note .icon { margin-top: 2px; }
.grow { flex: 1; }
</style>
