<script setup>
// Approval of SQL that an AI agent wants to run and that is not a plain read.
// Shown above everything; one request at a time, oldest first.
import { computed, ref, watch, nextTick } from 'vue'
import { ai, decide } from '../lib/ai'
import { t } from '../lib/i18n'
import Icon from './Icon.vue'

const req = computed(() => ai.approvals[0])
const rejectBtn = ref(null)
const busy = ref(false)

const writes = computed(() => req.value?.statements.filter((s) => !s.read).length ?? 0)
const mysqlDdl = computed(() => req.value?.dialect === 'mysql' && req.value.statements.some((s) => /^(CREATE|ALTER|DROP|RENAME|TRUNCATE)$/.test(s.command)))

// Start on "Recusar": Enter right after the dialog pops up must not approve.
watch(() => req.value?.id, async (id) => {
  if (!id) return
  await nextTick()
  rejectBtn.value?.focus()
}, { immediate: true })

async function answer(ok) {
  if (!req.value || busy.value) return
  busy.value = true
  try {
    await decide(req.value.id, ok)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="req" class="ap-back" @keydown.esc.prevent="answer(false)">
    <div class="ap" role="alertdialog" aria-labelledby="ap-title">
      <header>
        <Icon name="alert" :size="18" />
        <div class="h">
          <h3 id="ap-title">{{ t('Aprovar alteração no banco?') }}</h3>
          <div class="sub">
            <span class="chip"><Icon name="bolt" :size="11" /> {{ req.source }}</span>
            {{ t('quer executar uma instrução que altera o banco em|quer executar {n} instruções que alteram o banco em', { n: writes }) }}
            <b>{{ req.connection }}</b> <span class="muted">({{ req.dialect }})</span>
          </div>
        </div>
        <span v-if="ai.approvals.length > 1" class="more">{{ t('+{n} na fila', { n: ai.approvals.length - 1 }) }}</span>
      </header>

      <div class="body">
        <div v-for="(s, i) in req.statements" :key="i" class="st" :class="{ write: !s.read }">
          <div class="st-head">
            <span class="tag">{{ s.read ? t('leitura') : t('altera') }}</span>
            <span class="cmd">{{ s.command || 'SQL' }}</span>
            <span v-if="!s.read && s.why" class="why">{{ s.why }}</span>
          </div>
          <pre>{{ s.sql }}</pre>
        </div>
      </div>

      <div class="notes">
        <span><Icon name="info" :size="12" /> {{ t('Roda numa transação: se uma instrução falhar, as anteriores são desfeitas.') }}</span>
        <span v-if="mysqlDdl" class="warn"><Icon name="alert" :size="12" /> {{ t('No MySQL, CREATE/ALTER/DROP gravam na hora e não são desfeitos.') }}</span>
      </div>

      <footer>
        <button ref="rejectBtn" class="btn" :disabled="busy" @click="answer(false)">{{ t('Recusar') }}</button>
        <button class="btn primary" :disabled="busy" @click="answer(true)"><Icon name="play" :size="12" /> {{ t('Executar') }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.ap-back {
  position: fixed; inset: 0; z-index: 3000;
  display: grid; place-items: center;
  background: rgba(0, 0, 0, 0.6);
}
.ap {
  display: flex; flex-direction: column;
  width: min(720px, 94vw); max-height: 86vh;
  border: 1px solid var(--line-3); border-top: 3px solid var(--fg);
  border-radius: 10px;
  background: var(--surface-2);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
}
header { display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px 12px; }
header > :first-child { margin-top: 2px; flex: none; }
.h { flex: 1; min-width: 0; }
h3 { margin: 0 0 6px; font-size: 15px; }
.sub { color: var(--fg-2); font-size: 12.5px; line-height: 1.7; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 0 7px; border: 1px solid var(--line-3); border-radius: 10px;
  background: var(--surface-4); color: var(--fg); font-size: 11.5px; font-weight: 600;
}
.more { flex: none; font-size: 11.5px; color: var(--fg-3); }
.body { flex: 1; min-height: 0; overflow: auto; padding: 0 18px; display: flex; flex-direction: column; gap: 8px; }
.st { border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); }
.st.write { border-color: var(--fg-3); }
.st-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line-2); font-size: 11.5px; }
.tag { padding: 0 6px; border-radius: 4px; background: var(--surface-4); color: var(--fg-3); font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
.st.write .tag { background: var(--fg); color: var(--accent-fg); }
.cmd { font: 600 11.5px var(--mono); }
.why { color: var(--fg-3); margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
pre { margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto; font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; user-select: text; }
.notes { display: flex; flex-direction: column; gap: 4px; padding: 10px 18px 0; font-size: 11.5px; color: var(--fg-3); }
.notes span { display: inline-flex; align-items: center; gap: 6px; }
.warn { color: var(--fg); }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 18px 16px; }
</style>
