<script setup>
import { store } from '../lib/store'
import { t } from '../lib/i18n'

const answer = (choice) => store.txPrompt.resolve(choice)
</script>

<template>
  <div class="modal" @mousedown.self="answer(null)">
    <div class="dialog" tabindex="-1" @keydown.esc="answer(null)">
      <h3>{{ store.txPrompt.title }}</h3>
      <p>{{ store.txPrompt.message }} {{ t('Escolha o que fazer com ela antes de continuar.') }}</p>
      <div class="actions">
        <button class="btn" @click="answer(null)">{{ t('Cancelar') }}</button>
        <span class="grow" />
        <button class="btn" @click="answer('rollback')">{{ t('Rollback') }}</button>
        <button class="btn primary" @click="answer('commit')">{{ t('Commit') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center; background: rgba(0, 0, 0, 0.6); }
.dialog { width: min(440px, 90vw); padding: 22px; border: 1px solid var(--line-3); border-radius: 10px; background: var(--surface-3); box-shadow: 0 24px 80px rgba(0,0,0,.7); outline: 0; }
h3 { margin: 0 0 10px; font-size: 15px; }
p { margin: 0; color: var(--fg-2); line-height: 1.5; }
.actions { display: flex; gap: 8px; margin-top: 20px; }
.grow { flex: 1; }
</style>
