<script setup>
// The active workspace's own snippets: a trigger typed in the editor (or
// picked from the Snippets menu) expands into the body.
import { ref, computed, nextTick } from 'vue'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
import { t } from '../lib/i18n'
import { toast } from '../lib/store'
import { workspaces, activeWorkspace, saveSnippets, cleanError } from '../lib/workspaces'

const uid = () => crypto.randomUUID()
const items = ref((activeWorkspace()?.snippets || []).map((s) => ({ ...s })))
const list = ref(null)
if (workspaces.snippetDraft != null) {
  items.value.push({ id: uid(), trigger: '', title: '', body: workspaces.snippetDraft })
  workspaces.snippetDraft = null
}

const problems = computed(() => {
  const seen = new Set()
  return items.value.map((s) => {
    const trig = s.trigger.trim()
    if (!trig) return t('Informe o atalho')
    if (!/^\w+$/.test(trig)) return t('O atalho só pode ter letras, números e _')
    if (seen.has(trig)) return t('Atalho repetido')
    seen.add(trig)
    if (!s.body.trim()) return t('O snippet está vazio')
    return ''
  })
})
const valid = computed(() => problems.value.every((p) => !p))

async function add() {
  items.value.push({ id: uid(), trigger: '', title: '', body: '' })
  await nextTick()
  list.value?.querySelector('.item:last-child input')?.focus()
}
const remove = (i) => items.value.splice(i, 1)

async function save() {
  try {
    await saveSnippets(items.value.map((s) => ({ ...s, trigger: s.trigger.trim(), title: s.title.trim() })))
    toast(t('Snippets salvos'), 'success')
    workspaces.dialog = null
  } catch (e) {
    toast(cleanError(e), 'error')
  }
}
</script>

<template>
  <Modal :title="t('Meus snippets')" :subtitle="t('Workspace: {name}', { name: activeWorkspace()?.name })" width="640px" @close="workspaces.dialog = null">
    <p class="lead">{{ t('Digite o atalho no editor e escolha a sugestão para expandir o texto. Use {field} para um campo que o Tab percorre e {end} para onde o cursor termina.', { field: '${' + t('campo') + '}', end: '${}' }) }}</p>
    <div ref="list" class="items">
      <div v-if="!items.length" class="empty">{{ t('Nenhum snippet ainda.') }}</div>
      <div v-for="(s, i) in items" :key="s.id" class="item">
        <div class="row">
          <input v-model="s.trigger" class="input mono trig" :placeholder="t('atalho')" spellcheck="false" maxlength="30" />
          <input v-model="s.title" class="input" :placeholder="t('Descrição (opcional)')" maxlength="80" />
          <button class="btn ghost icon sm" :title="t('Remover')" @click="remove(i)"><Icon name="trash" :size="13" /></button>
        </div>
        <textarea v-model="s.body" class="input mono body" rows="4" spellcheck="false" placeholder="SELECT ${colunas}&#10;FROM ${tabela}&#10;WHERE ${};"></textarea>
        <div v-if="problems[i]" class="problem">{{ problems[i] }}</div>
      </div>
    </div>
    <template #foot>
      <button class="btn" @click="add"><Icon name="plus" :size="13" /> {{ t('Novo snippet') }}</button>
      <span class="spacer" />
      <button class="btn" @click="workspaces.dialog = null">{{ t('Cancelar') }}</button>
      <button class="btn primary" :disabled="!valid" @click="save">{{ t('Salvar') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.lead { margin: 0 0 14px; color: var(--fg-3); font-size: 12.5px; line-height: 1.55; }
.items { display: grid; gap: 12px; }
.item { padding: 12px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-2); }
.row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.row .input { flex: 1; min-width: 0; }
.row .trig { flex: 0 0 140px; }
.body { width: 100%; resize: vertical; font-size: 12.5px; line-height: 1.5; }
.problem { margin-top: 6px; color: var(--fg-2); font-size: 12px; }
.empty { padding: 18px; color: var(--fg-3); text-align: center; font-size: 13px; }
.spacer { flex: 1; }
</style>
