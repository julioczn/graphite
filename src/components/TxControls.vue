<script setup>
// Commit mode switch plus Commit / Rollback while a transaction is open.
// The transaction belongs to the connection, so every tab shows the same state.
import { ref } from 'vue'
import { setAutoCommit, commit, rollback, caps, useSession } from '../lib/store'
import { t } from '../lib/i18n'
import Icon from './Icon.vue'

const sess = useSession()

const busy = ref(false)

async function act(fn) {
  busy.value = true
  try {
    await fn()
  } catch {
    // toast already shown by the store
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="txc">
    <div class="seg" :title="t('Modo de commit da conexão')">
      <button :class="{ on: sess.tx.autoCommit }" :disabled="busy" @click="act(() => setAutoCommit(sess, true))">{{ t('Auto-commit') }}</button>
      <button v-if="caps(sess).manualMode" :class="{ on: !sess.tx.autoCommit }" :disabled="busy" @click="act(() => setAutoCommit(sess, false))">{{ t('Manual') }}</button>
    </div>
    <template v-if="sess.tx.open">
      <span class="open" :title="t('{n} alteração sem commit|{n} alterações sem commit', { n: sess.tx.statements })">
        <span class="dot" /> {{ sess.tx.statements }}
      </span>
      <button class="btn primary sm" :disabled="busy" :title="t('Gravar a transação')" @click="act(() => commit(sess))">
        <Icon name="check" :size="12" /> {{ t('Commit') }}
      </button>
      <button class="btn sm" :disabled="busy" :title="t('Desfazer a transação')" @click="act(() => rollback(sess))">
        <Icon name="undo" :size="12" /> {{ t('Rollback') }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.txc { display: flex; align-items: center; gap: 6px; }
.seg { display: flex; padding: 2px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--bg); }
.seg button {
  height: 22px; padding: 0 9px; border: 0; border-radius: 4px;
  background: transparent; color: var(--fg-4); cursor: pointer; font-size: 11.5px;
}
.seg button:hover:not(.on) { color: var(--fg-2); }
.seg button.on { background: var(--surface-5); color: var(--fg); }
.open {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 9px;
  border: 1px dashed var(--fg-3); border-radius: 12px;
  color: var(--fg); font: 600 11.5px var(--mono);
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
</style>
