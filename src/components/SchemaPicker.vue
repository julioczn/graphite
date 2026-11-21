<script setup>
// Database (MySQL) / schema (PostgreSQL) switcher shown above the entity filter.
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { call } from '../lib/api'
import { store, useSchema, toast } from '../lib/store'
import Icon from './Icon.vue'
import { t } from '../lib/i18n'

const open = ref(false)
const loading = ref(false)
const switching = ref(false)
const items = ref([])
const query = ref('')
const active = ref(0)
const root = ref(null)
const input = ref(null)
const list = ref(null)

const isPg = computed(() => store.connection.dialect === 'postgres')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return items.value.filter((s) => !q || s.name.toLowerCase().includes(q))
})
const sections = computed(() => [
  { label: isPg.value ? t('Schemas') : t('Bancos'), items: filtered.value.filter((s) => !s.system) },
  { label: t('Sistema'), items: filtered.value.filter((s) => s.system) },
].filter((g) => g.items.length))
// Flat order used by the keyboard, matching the rendered order.
const flat = computed(() => sections.value.flatMap((g) => g.items))

async function toggle() {
  if (open.value) return close()
  open.value = true
  query.value = ''
  loading.value = true
  window.addEventListener('mousedown', onOutside)
  nextTick(() => input.value?.focus())
  try {
    items.value = await call('conn/listSchemas', { sId: store.connection.sId })
    active.value = Math.max(0, flat.value.findIndex((s) => s.name === store.connection.schema))
    nextTick(scrollActive)
  } catch (e) {
    toast(e.message, 'error')
    close()
  } finally {
    loading.value = false
  }
}

function close() {
  open.value = false
  window.removeEventListener('mousedown', onOutside)
}

function onOutside(e) {
  if (!root.value?.contains(e.target)) close()
}

async function pick(s) {
  close()
  if (s.name === store.connection.schema) return
  switching.value = true
  try {
    await useSchema(s.name)
  } catch (e) {
    toast(t('Não foi possível trocar para {name}: {error}', { name: s.name, error: e.message }), 'error', 6000)
  } finally {
    switching.value = false
  }
}

function scrollActive() {
  list.value?.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' })
}

function onKey(e) {
  const n = flat.value.length
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (e.key === 'ArrowDown' && n) { e.preventDefault(); active.value = (active.value + 1) % n; nextTick(scrollActive) }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); active.value = (active.value - 1 + n) % n; nextTick(scrollActive) }
  else if (e.key === 'Enter' && flat.value[active.value]) { e.preventDefault(); pick(flat.value[active.value]) }
}

onBeforeUnmount(close)
</script>

<template>
  <div ref="root" class="picker">
    <button class="trigger" :class="{ open }" :disabled="switching" :title="isPg ? t('Trocar de schema') : t('Trocar de banco')" @click="toggle">
      <Icon name="database" :size="13" class="ico" />
      <span class="kind">{{ isPg ? t('Schema') : t('Banco') }}</span>
      <span class="value" :class="{ none: !store.connection.schema }">
        {{ switching ? t('trocando…') : store.connection.schema || (isPg ? t('selecione um schema') : t('selecione um banco')) }}
      </span>
      <Icon name="chevron" :size="12" class="chev" />
    </button>

    <div v-if="open" class="pop" @keydown="onKey">
      <div class="find">
        <Icon name="search" :size="12" />
        <input ref="input" v-model="query" :placeholder="isPg ? t('Buscar schema') : t('Buscar banco')" spellcheck="false" @input="active = 0" />
      </div>
      <div ref="list" class="opts">
        <div v-if="loading" class="msg">{{ t('carregando…') }}</div>
        <div v-else-if="!flat.length" class="msg">{{ isPg ? t('Nenhum schema') : t('Nenhum banco') }}</div>
        <template v-for="g in sections" :key="g.label">
          <div class="sect">{{ g.label }}</div>
          <button v-for="s in g.items" :key="s.name" class="opt"
                  :class="{ active: flat[active] === s, current: s.name === store.connection.schema }"
                  @mouseenter="active = flat.indexOf(s)" @click="pick(s)">
            <span class="opt-name">{{ s.name }}</span>
            <Icon v-if="s.name === store.connection.schema" name="check" :size="12" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker { position: relative; margin: 0 10px 8px; }
.trigger {
  display: flex; align-items: center; gap: 7px; width: 100%;
  height: 30px; padding: 0 8px;
  border: 1px solid var(--line-2); border-radius: var(--radius);
  background: var(--surface-3); color: var(--fg); cursor: pointer; text-align: left;
}
.trigger:hover:not(:disabled), .trigger.open { border-color: var(--fg-4); background: var(--surface-4); }
.ico { color: var(--fg-3); flex: none; }
.kind { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-4); flex: none; }
.value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); }
.value.none { color: var(--fg-4); font-style: italic; font-family: inherit; }
.chev { transform: rotate(90deg); color: var(--fg-3); flex: none; transition: transform 0.12s; }
.trigger.open .chev { transform: rotate(-90deg); }

.pop {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40;
  border: 1px solid var(--line-3); border-radius: 8px;
  background: var(--surface-3); box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.find { display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border-bottom: 1px solid var(--line-2); color: var(--fg-4); }
.find input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); }
.find input::placeholder { color: var(--fg-4); }
.opts { max-height: 320px; overflow: auto; padding: 4px; }
.sect { padding: 8px 8px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-4); }
.opt {
  display: flex; align-items: center; gap: 8px; width: 100%;
  height: 26px; padding: 0 8px; border: 0; border-radius: 5px;
  background: transparent; color: var(--fg-2); cursor: pointer; text-align: left;
  font: 12px var(--mono);
}
.opt.active { background: var(--sel-2); color: var(--fg); }
.opt.current { color: var(--fg); font-weight: 600; }
.opt-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg { padding: 10px; color: var(--fg-4); text-align: center; }
</style>
