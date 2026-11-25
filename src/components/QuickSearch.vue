<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { call } from '../lib/api'
import { openTableTab, newQueryTab, tableKey, useSession } from '../lib/store'
import Icon from './Icon.vue'
import { t } from '../lib/i18n'
import { activeId } from '../lib/workspaces'

const sess = useSession()

const q = ref('')
const idx = ref(0)
const saved = ref([])
const input = ref(null)

// Subsequence match with a score that favours contiguous, early hits.
function score(text, query) {
  if (!query) return 1
  text = text.toLowerCase()
  let ti = 0, s = 0, run = 0
  for (const ch of query.toLowerCase()) {
    const at = text.indexOf(ch, ti)
    if (at < 0) return 0
    run = at === ti ? run + 1 : 0
    s += 1 + run * 2 - Math.min(at - ti, 5) * 0.1
    ti = at + 1
  }
  return s - text.length * 0.01
}

const results = computed(() => {
  const items = [
    ...sess.tables.map((t) => ({ kind: t.type, label: tableKey(t, sess), t })),
    ...saved.value.map((s) => ({ kind: 'saved', label: s.title, s })),
  ]
  return items
    .map((it) => ({ ...it, score: score(it.label, q.value.trim()) }))
    .filter((it) => it.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
})

function close() {
  sess.quickSearch = false
}

function choose(it) {
  if (!it) return
  if (it.kind === 'saved') newQueryTab(sess, it.s.sql, it.s.title, it.s.id)
  else openTableTab(sess, it.t)
  close()
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); idx.value = Math.min(idx.value + 1, results.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx.value = Math.max(idx.value - 1, 0) }
  else if (e.key === 'Enter') { e.preventDefault(); choose(results.value[idx.value]) }
  else if (e.key === 'Escape') close()
}

onMounted(async () => {
  await nextTick()
  input.value?.focus()
  saved.value = await call('app/savedQueries', { workspaceId: activeId() })
})
</script>

<template>
  <div class="qs" @mousedown.self="close">
    <div class="box" @keydown="onKey">
      <div class="in">
        <Icon name="search" :size="16" />
        <input ref="input" v-model="q" :placeholder="t('Buscar tabelas, views e consultas salvas…')" spellcheck="false" @input="idx = 0" />
        <span class="kbd">Esc</span>
      </div>
      <div class="results">
        <div v-if="!results.length" class="none">{{ t('Nada encontrado') }}</div>
        <div v-for="(r, i) in results" :key="r.kind + r.label" class="res" :class="{ on: i === idx }"
             @mouseenter="idx = i" @click="choose(r)">
          <Icon :name="r.kind === 'saved' ? 'bookmark' : r.kind === 'view' ? 'view' : 'table'" :size="14" />
          <span class="lbl">{{ r.label }}</span>
          <span class="kind">{{ r.kind === 'saved' ? t('consulta') : r.kind === 'view' ? t('view') : t('tabela') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qs {
  position: fixed; inset: 0; z-index: 900;
  display: flex; justify-content: center; align-items: flex-start;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.55);
}
.box {
  width: min(560px, 92vw);
  border: 1px solid var(--line-3); border-radius: 10px;
  background: var(--surface-3);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.7);
  overflow: hidden;
}
.in { display: flex; align-items: center; gap: 10px; padding: 0 14px; height: 46px; border-bottom: 1px solid var(--line-2); color: var(--fg-3); }
.in input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--fg); font-size: 15px; }
.in input::placeholder { color: var(--fg-4); }
.results { max-height: 50vh; overflow: auto; padding: 6px; }
.none { padding: 14px; color: var(--fg-4); text-align: center; }
.res { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 10px; border-radius: 6px; color: var(--fg-2); cursor: pointer; }
.res.on { background: var(--sel-2); color: var(--fg); }
.lbl { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kind { font-size: 11px; color: var(--fg-4); }
</style>
