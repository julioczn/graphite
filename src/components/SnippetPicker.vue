<script setup>
// Searchable list of SQL snippets, opened from the query toolbar. Picking one
// emits it; the query tab expands it in the editor.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { snippetsFor, preview } from '../lib/snippets'
import { t } from '../lib/i18n'
import { workspaces } from '../lib/workspaces'

const props = defineProps({ anchor: Object, dialect: String }) // anchor: DOMRect of the button
const emit = defineEmits(['pick', 'close'])

const el = ref(null)
const input = ref(null)
const list = ref(null)
const query = ref('')
const active = ref(0)

const all = computed(() => snippetsFor(props.dialect).map((s) => ({ ...s, line: preview(s.body) })))
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const filtered = computed(() => {
  const q = norm(query.value.trim())
  if (!q) return all.value
  return all.value.filter((s) => norm(`${s.trigger} ${s.title} ${s.group} ${s.line}`).includes(q))
    // exact trigger first, then trigger prefix
    .sort((a, b) => (b.trigger === q) - (a.trigger === q) || b.trigger.startsWith(q) - a.trigger.startsWith(q))
})
// Group headers only without a search (a search mixes groups by relevance).
const rows = computed(() => {
  const out = []
  let group = null
  for (const [i, s] of filtered.value.entries()) {
    if (!query.value.trim() && s.group !== group) out.push({ header: (group = s.group) })
    out.push({ s, i })
  }
  return out
})

const pos = computed(() => {
  const a = props.anchor
  if (!a) return {}
  const width = Math.min(520, window.innerWidth - 16)
  const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8))
  const below = window.innerHeight - a.bottom - 12
  const above = a.top - 12
  // Open towards the side with more room.
  return below >= 320 || below >= above
    ? { left: left + 'px', top: a.bottom + 4 + 'px', width: width + 'px', maxHeight: Math.max(200, below) + 'px' }
    : { left: left + 'px', bottom: window.innerHeight - a.top + 4 + 'px', width: width + 'px', maxHeight: Math.max(200, above) + 'px' }
})

watch(query, () => { active.value = 0 })
watch(active, async () => {
  await nextTick()
  list.value?.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' })
})

function pick(s) {
  emit('pick', s)
}

function onKey(e) {
  const n = filtered.value.length
  if (e.key === 'Escape') { e.preventDefault(); emit('close') }
  else if (e.key === 'ArrowDown') { e.preventDefault(); if (n) active.value = (active.value + 1) % n }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) active.value = (active.value - 1 + n) % n }
  else if (e.key === 'Enter') { e.preventDefault(); const s = filtered.value[active.value]; if (s) pick(s) }
}

// The toolbar button toggles the picker itself; ignore it here so a click on
// it closes instead of closing and reopening.
function onDocDown(e) {
  if (!el.value?.contains(e.target) && !e.target.closest?.('[data-snippet-toggle]')) emit('close')
}
const onResize = () => emit('close')
onMounted(() => {
  nextTick(() => input.value?.focus())
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <Teleport to="body">
    <div ref="el" class="sp" :style="pos" @keydown="onKey">
      <div class="search">
        <Icon name="search" :size="13" />
        <input ref="input" v-model="query" spellcheck="false" :placeholder="t('Buscar snippet (ex.: join, upsert, índice)')" />
      </div>
      <div ref="list" class="list">
        <template v-for="(r, k) in rows" :key="k">
          <div v-if="r.header" class="group">{{ r.header }}</div>
          <button v-else type="button" class="row" :class="{ on: r.i === active }"
                  @mouseenter="active = r.i" @click="pick(r.s)">
            <span class="top">
              <span class="title">{{ r.s.title }}</span>
              <span class="trigger" :title="t('Digite isto no editor e escolha no autocomplete')">{{ r.s.trigger }}</span>
            </span>
            <span class="line">{{ r.s.line }}</span>
          </button>
        </template>
        <div v-if="!filtered.length" class="none">{{ t('Nenhum snippet para “{query}”', { query }) }}</div>
      </div>
      <div class="foot">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> {{ t('navegar') }}</span>
        <span><span class="kbd">↩</span> {{ t('inserir') }}</span>
        <span>{{ t('no editor:') }} <span class="kbd">Tab</span> {{ t('próximo campo') }}</span>
        <button type="button" class="own" @click="emit('close'); workspaces.dialog = 'snippets'">{{ t('Meus snippets…') }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sp {
  position: fixed;
  z-index: 1500;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-3);
  border-radius: 8px;
  background: var(--surface-3);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.search {
  display: flex; align-items: center; gap: 8px;
  height: 36px; flex: none; padding: 0 12px;
  border-bottom: 1px solid var(--line-2);
  color: var(--fg-3);
}
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); font-size: 13px; }
.search input::placeholder { color: var(--fg-4); }
.list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px; }
.group {
  padding: 8px 8px 4px;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--fg-4);
}
.row {
  display: flex; flex-direction: column; gap: 2px;
  width: 100%; padding: 6px 8px;
  border: 0; border-radius: 5px;
  background: transparent; color: var(--fg);
  text-align: left; cursor: default; font: inherit;
}
.row.on { background: var(--sel-3); }
.top { display: flex; align-items: center; gap: 8px; }
.title { flex: 1; font-size: 12.5px; font-weight: 600; }
.trigger {
  padding: 0 6px; border: 1px solid var(--line-3); border-radius: 4px;
  font: 11px/16px var(--mono); color: var(--fg-3);
}
.line {
  font: 11px var(--mono); color: var(--fg-4);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row.on .line { color: var(--fg-3); }
.none { padding: 18px; text-align: center; color: var(--fg-4); }
.foot {
  display: flex; gap: 14px; flex: none;
  padding: 6px 12px;
  border-top: 1px solid var(--line-2);
  font-size: 11px; color: var(--fg-4);
}
.foot .kbd { margin-right: 3px; }
.foot .own { margin-left: auto; padding: 0; border: 0; background: none; color: var(--fg-2); font: inherit; text-decoration: underline; cursor: pointer; }
.foot .own:hover { color: var(--fg); }
</style>
