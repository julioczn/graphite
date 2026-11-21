<script setup>
import { reactive, computed } from 'vue'
import { bridge } from '../lib/api'
import { store, startJob, toast } from '../lib/store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import { t } from '../lib/i18n'

const emit = defineEmits(['close'])
const c = store.connection
const isMysql = c.dialect === 'mysql'
const target = c.dialect === 'postgres' ? t('{database} · schema {schema}', { database: c.database, schema: c.schema }) : c.schema || c.database

const form = reactive({
  file: '',
  // DDL in MySQL commits implicitly, so a wrapping transaction would be a lie.
  transaction: !isMysql,
  stopOnError: true,
  confirmed: false,
  busy: false,
})
const canStart = computed(() => form.file && form.confirmed && !form.busy && (c.dialect !== 'mysql' || c.schema))

async function chooseFile() {
  const file = await bridge.choosePath({
    mode: 'open', title: t('Escolher backup'),
    filters: [{ name: t('Script SQL'), extensions: ['sql', 'gz'] }, { name: t('Todos os arquivos'), extensions: ['*'] }],
  })
  if (file) form.file = file
}

async function start() {
  form.busy = true
  try {
    await startJob('restore/start', {
      file: form.file,
      transaction: form.transaction,
      stopOnError: form.transaction || form.stopOnError,
    })
    emit('close')
  } catch (e) {
    toast(e.message, 'error', 6000)
  } finally {
    form.busy = false
  }
}
</script>

<template>
  <Modal :title="t('Restaurar backup')" :subtitle="t('Destino: {name} · {target}', { name: c.saved?.name || c.database, target: target || t('nenhum banco selecionado') })" width="540px" @close="emit('close')">
    <div class="field">
      <label>{{ t('Arquivo (.sql ou .sql.gz)') }}</label>
      <div class="row">
        <input class="input mono" :value="form.file" readonly :placeholder="t('Escolha o arquivo de backup…')" @click="chooseFile" />
        <button class="btn" @click="chooseFile"><Icon name="folder" :size="13" /> {{ t('Escolher…') }}</button>
      </div>
    </div>

    <div class="checks">
      <label class="check" :class="{ off: isMysql }">
        <input v-model="form.transaction" type="checkbox" :disabled="isMysql" />
        <span>{{ t('Executar numa transação única') }} <span class="muted">{{ t('— se algo falhar, nada é gravado') }}</span></span>
      </label>
      <div v-if="isMysql" class="sub">{{ t('No MySQL/MariaDB, CREATE/DROP fazem commit implícito, então não há como desfazer tudo.') }}</div>
      <label class="check" :class="{ off: form.transaction }">
        <input v-model="form.stopOnError" type="checkbox" :disabled="form.transaction" />
        <span>{{ t('Parar no primeiro erro') }} <span class="muted">{{ t('— desmarcado, segue e lista os erros no fim') }}</span></span>
      </label>
    </div>

    <div class="warn">
      <Icon name="alert" :size="15" />
      <div>
        {{ t('O script será executado em') }} <b>{{ target || '—' }}</b>{{ t(', numa conexão separada.') }}
        {{ t('Backups com') }} <code>DROP … IF EXISTS</code> {{ t('substituem as tabelas existentes com o mesmo nome.') }}
        <template v-if="c.dialect === 'postgres'"> {{ t('Objetos com schema no nome (como os backups do Graphite) voltam para o schema original.') }}</template>
        <template v-if="store.tx.open"><br /><b>{{ t('Há uma transação aberta nesta conexão') }}</b>{{ t(': os locks dela podem travar o restore.') }}</template>
      </div>
    </div>
    <div v-if="isMysql && !c.schema" class="warn"><Icon name="info" :size="15" /> {{ t('Escolha um banco no seletor da barra lateral antes de restaurar.') }}</div>

    <label class="check confirm">
      <input v-model="form.confirmed" type="checkbox" />
      {{ t('Entendo que isso altera') }} <b>{{ target }}</b>
    </label>

    <template #foot>
      <span class="grow" />
      <button class="btn" @click="emit('close')">{{ t('Cancelar') }}</button>
      <button class="btn primary" :disabled="!canStart" @click="start"><Icon name="upload" :size="13" /> {{ t('Restaurar') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.field { margin-bottom: 14px; }
.field > label { display: block; margin-bottom: 6px; color: var(--fg-2); font-size: 12px; font-weight: 600; }
.row { display: flex; gap: 8px; }
.row .input { flex: 1; cursor: pointer; }
.checks { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.check { display: flex; align-items: flex-start; gap: 8px; color: var(--fg-2); cursor: pointer; line-height: 1.4; }
.check input { margin-top: 2px; }
.check.off { opacity: 0.45; }
.muted { color: var(--fg-4); }
.sub { margin: -2px 0 0 24px; color: var(--fg-4); font-size: 11.5px; }
.warn { display: flex; gap: 10px; margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--line-3); border-left: 3px solid var(--fg-2); border-radius: 8px; background: var(--surface-2); color: var(--fg-2); font-size: 12px; line-height: 1.5; }
.warn .icon { margin-top: 1px; flex: none; color: var(--fg); }
.warn b { color: var(--fg); }
code { font: 11.5px var(--mono); color: var(--fg); }
.confirm { color: var(--fg); }
.grow { flex: 1; }
</style>
