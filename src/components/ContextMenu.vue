<script setup>
// Right-click menu. `menu` is { x, y, items } where each item is
// { label, icon?, hint?, disabled?, danger?, run } or { sep: true }.
// Closes on outside click, Escape, scroll, resize or window blur.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({ menu: Object })
const emit = defineEmits(['close'])

const el = ref(null)
const pos = ref({ left: 0, top: 0 })
const active = ref(-1)

// Drop separators at the edges and doubled ones left over by hidden items.
const items = computed(() => {
  const out = []
  for (const it of props.menu?.items || []) {
    if (!it) continue
    if (it.sep && (!out.length || out[out.length - 1].sep)) continue
    out.push(it)
  }
  while (out.length && out[out.length - 1].sep) out.pop()
  return out
})

watch(() => props.menu, async (m) => {
  active.value = -1
  if (!m) return
  pos.value = { left: m.x, top: m.y }
  await nextTick()
  const r = el.value?.getBoundingClientRect()
  if (!r) return
  // Keep the menu on screen: flip left / up when it would overflow.
  const left = m.x + r.width > window.innerWidth - 6 ? Math.max(6, m.x - r.width) : m.x
  const top = m.y + r.height > window.innerHeight - 6 ? Math.max(6, m.y - r.height) : m.y
  pos.value = { left, top }
  el.value.focus({ preventScroll: true })
}, { immediate: true })

function run(it) {
  if (it.disabled || it.sep) return
  emit('close')
  it.run()
}

function step(dir) {
  const list = items.value
  if (!list.some((it) => !it.sep && !it.disabled)) return
  let i = active.value
  do i = (i + dir + list.length) % list.length
  while (list[i].sep || list[i].disabled)
  active.value = i
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); emit('close') }
  else if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
  else if (e.key === 'Enter' && active.value >= 0) { e.preventDefault(); run(items.value[active.value]) }
}

function onDocDown(e) {
  if (props.menu && !el.value?.contains(e.target)) emit('close')
}
const close = () => props.menu && emit('close')

onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  document.addEventListener('scroll', close, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', close)
  document.removeEventListener('scroll', close, true)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="menu" ref="el" class="ctx" tabindex="-1" role="menu"
         :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
         @keydown="onKey" @contextmenu.prevent @mousedown.stop>
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it.sep" class="sep" />
        <button v-else type="button" role="menuitem" class="item"
                :class="{ danger: it.danger, on: i === active }" :disabled="it.disabled"
                @mouseenter="active = it.disabled ? -1 : i" @click="run(it)">
          <span class="ic"><Icon v-if="it.icon" :name="it.icon" :size="13" /></span>
          <span class="label">{{ it.label }}</span>
          <span v-if="it.hint" class="hint">{{ it.hint }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx {
  position: fixed;
  z-index: 2000;
  min-width: 220px;
  max-width: 360px;
  padding: 4px;
  border: 1px solid var(--line-3);
  border-radius: 8px;
  background: var(--surface-3);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.6);
  outline: none;
  font-size: 12.5px;
}
.item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; height: 26px; padding: 0 8px;
  border: 0; border-radius: 5px;
  background: transparent; color: var(--fg);
  text-align: left; cursor: default; font: inherit;
}
.item.on { background: var(--sel-3); }
.item:disabled { color: var(--fg-4); }
.item.danger:not(:disabled) .ic { color: var(--fg); }
.item.danger:not(:disabled) .label { font-weight: 600; }
.ic { display: grid; place-items: center; width: 14px; color: var(--fg-3); flex: none; }
.label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { color: var(--fg-4); font: 11px var(--mono); padding-left: 16px; }
.sep { height: 1px; margin: 4px 6px; background: var(--line-3); }
</style>
