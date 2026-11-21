<script setup>
// Interface language picker: "System" (follows the OS) or a fixed language.
// `compact` renders an icon-only button (workspace rail).
import { ref } from 'vue'
import Icon from './Icon.vue'
import ContextMenu from './ContextMenu.vue'
import { i18n, t, LOCALES, setLanguage } from '../lib/i18n'
import { toast } from '../lib/store'

defineProps({ compact: Boolean })
const menu = ref(null)

function open(e) {
  const r = e.currentTarget.getBoundingClientRect()
  const pick = (pref) => () => setLanguage(pref).catch((err) => toast(err.message, 'error'))
  const mark = (pref) => (i18n.pref === pref ? 'check' : undefined)
  menu.value = {
    x: r.right + 4,
    y: r.top,
    items: [
      { label: t('Idioma do sistema'), icon: mark('system'), hint: i18n.pref === 'system' ? current() : '', run: pick('system') },
      { sep: true },
      ...LOCALES.map((l) => ({ label: l.name, icon: mark(l.id), run: pick(l.id) })),
    ],
  }
}
const current = () => LOCALES.find((l) => l.id === i18n.locale)?.name || i18n.locale
</script>

<template>
  <!-- One root element so the parent's scoped button styles (.act / .btn) apply. -->
  <button :class="compact ? 'act' : 'btn ghost lang'" :title="compact ? t('Idioma') + ': ' + current() : t('Idioma da interface')" @click="open">
    <Icon name="globe" :size="compact ? 18 : 14" />
    <template v-if="!compact">{{ current() }}</template>
    <ContextMenu :menu="menu" @close="menu = null" />
  </button>
</template>
