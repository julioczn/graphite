<script setup>
import Icon from './Icon.vue'
import { t } from '../lib/i18n'

defineProps({ title: String, subtitle: String, width: { type: String, default: '520px' } })
const emit = defineEmits(['close'])
</script>

<template>
  <div class="modal" @mousedown.self="emit('close')">
    <div class="dialog" :style="{ width: `min(${width}, 94vw)` }" tabindex="-1" @keydown.esc="emit('close')">
      <header>
        <div>
          <h3>{{ title }}</h3>
          <div v-if="subtitle" class="sub">{{ subtitle }}</div>
        </div>
        <button class="btn ghost icon sm" :title="t('Fechar')" @click="emit('close')"><Icon name="close" :size="14" /></button>
      </header>
      <div class="body"><slot /></div>
      <footer><slot name="foot" /></footer>
    </div>
  </div>
</template>

<style scoped>
.modal { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center; background: rgba(0, 0, 0, 0.6); }
.dialog {
  display: flex; flex-direction: column; max-height: 88vh;
  border: 1px solid var(--line-3); border-radius: 10px;
  background: var(--surface-3); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.7); outline: 0;
}
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 18px 6px 22px; }
h3 { margin: 0; font-size: 15px; }
.sub { margin-top: 4px; color: var(--fg-3); font-size: 12px; }
.body { padding: 10px 22px; overflow: auto; }
footer { display: flex; align-items: center; gap: 8px; padding: 14px 22px 18px; }
footer:empty { display: none; }
</style>
