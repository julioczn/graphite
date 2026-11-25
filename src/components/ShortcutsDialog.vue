<script setup>
// Every keyboard shortcut, grouped by where it works. Opened from the keyboard
// button (activity bar / connection screen) or Mod+Shift+/ ("Mod+?").
import { ref, computed } from 'vue'
import { store } from '../lib/store'
import { t } from '../lib/i18n'
import { key, isMac } from '../lib/keys'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

// Each combo is a list of keys (shown as kbd); `or` lists alternatives.
const groups = computed(() => [
  {
    title: t('Geral'),
    items: [
      { keys: [['mod', 'P'], ['mod', 'K']], label: t('Busca rápida: tabelas, views e consultas salvas') },
      { keys: [['mod', 'T']], label: t('Nova consulta') },
      { keys: [['mod', 'W']], label: t('Fechar a aba') },
      { keys: [[isMac ? 'ctrl' : 'mod', 'Tab'], [isMac ? 'ctrl' : 'mod', 'shift', 'Tab']], label: t('Próxima / aba anterior') },
      { keys: [['mod', 'B']], label: t('Mostrar ou esconder a barra lateral') },
      { keys: [['mod', 'shift', '?']], label: t('Esta lista de atalhos') },
    ],
  },
  {
    title: t('Conexões'),
    items: [
      { keys: [['mod', '\\']], label: t('Lado a lado: duas conexões ao mesmo tempo') },
      { keys: [['mod', 'alt', '←'], ['mod', 'alt', '→']], label: t('Ir para o painel da esquerda / direita') },
      { keys: [[t('botão do meio')]], label: t('Na aba de uma conexão ou consulta: fecha') },
      { keys: [['Esc']], label: t('Na tela de conexão aberta por cima: volta') },
    ],
  },
  {
    title: t('Editor SQL'),
    items: [
      { keys: [['mod', 'enter']], label: t('Executar tudo, ou só a seleção') },
      { keys: [['mod', 'shift', 'enter']], label: t('Executar a instrução sob o cursor') },
      { keys: [['mod', 'S']], label: t('Salvar a consulta') },
      { keys: [['ctrl', 'Space']], label: t('Autocompletar tabelas, colunas e snippets') },
      { keys: [['Tab'], ['shift', 'Tab']], label: t('Snippet: próximo / campo anterior (Esc sai)') },
      { keys: [['mod', '/']], label: t('Comentar / descomentar linhas') },
      { keys: [['mod', 'F'], ['mod', 'G']], label: t('Localizar / próxima ocorrência') },
      { keys: [['mod', 'D']], label: t('Selecionar a próxima ocorrência') },
      { keys: [['alt', '↑'], ['alt', '↓']], label: t('Mover a linha') },
      { keys: [['shift', 'alt', '↑'], ['shift', 'alt', '↓']], label: t('Duplicar a linha') },
      { keys: [['mod', 'Z'], isMac ? ['mod', 'shift', 'Z'] : ['mod', 'Y']], label: t('Desfazer / refazer') },
    ],
  },
  {
    title: t('Grade de resultados'),
    items: [
      { keys: [['←', '↑', '↓', '→'], ['Tab']], label: t('Mover a célula selecionada') },
      { keys: [['PgUp'], ['PgDn']], label: t('Uma página acima / abaixo') },
      { keys: [['Home'], ['End']], label: t('Primeira / última coluna') },
      { keys: [['mod', 'Home'], ['mod', 'End']], label: t('Primeira / última linha') },
      { keys: [['enter'], ['F2']], label: t('Editar a célula (Enter grava, Esc cancela)') },
      { keys: [['del']], label: t('Definir NULL; no nº da linha, marcar para excluir') },
      { keys: [['mod', 'C']], label: t('Copiar a célula, ou a linha inteira') },
      { keys: [['Esc']], label: t('Limpar a seleção') },
    ],
  },
  {
    title: t('Listas e assistente'),
    items: [
      { keys: [['↑'], ['↓'], ['enter']], label: t('Escolher na busca rápida, snippets, schemas e menus') },
      { keys: [['enter']], label: t('Assistente de AI: enviar a mensagem') },
      { keys: [['shift', 'enter']], label: t('Assistente de AI: nova linha') },
      { keys: [['enter']], label: t('Diagrama ER: centralizar a tabela encontrada') },
    ],
  },
])

const q = ref('')
const shown = computed(() => {
  const s = q.value.trim().toLowerCase()
  if (!s) return groups.value
  return groups.value
    .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(s) || g.title.toLowerCase().includes(s)) }))
    .filter((g) => g.items.length)
})
const close = () => (store.shortcuts = false)
</script>

<template>
  <Modal :title="t('Atalhos de teclado')" width="760px" @close="close">
    <div class="find">
      <Icon name="search" :size="14" />
      <input v-model="q" class="input" :placeholder="t('Filtrar atalhos')" autofocus @keydown.esc.stop="q ? (q = '') : close()" />
    </div>
    <div class="cols">
      <section v-for="g in shown" :key="g.title" class="group">
        <h4>{{ g.title }}</h4>
        <div v-for="(it, i) in g.items" :key="i" class="row">
          <span class="combo">
            <template v-for="(combo, j) in it.keys" :key="j">
              <span v-if="j" class="or">/</span>
              <span v-for="k in combo" :key="k" class="kbd">{{ key(k) }}</span>
            </template>
          </span>
          <span class="label">{{ it.label }}</span>
        </div>
      </section>
      <div v-if="!shown.length" class="none">{{ t('Nenhum atalho encontrado') }}</div>
    </div>
  </Modal>
</template>

<style scoped>
.find { position: relative; margin-bottom: 12px; }
.find .icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--fg-4); }
.find .input { width: 100%; padding-left: 30px; }
.cols { columns: 2 320px; column-gap: 28px; }
.group { break-inside: avoid; margin-bottom: 16px; }
h4 {
  margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--fg-3);
}
.row { display: grid; grid-template-columns: 150px 1fr; align-items: baseline; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--line-2); font-size: 12.5px; }
.combo { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 3px; }
.or { color: var(--fg-4); margin: 0 2px; }
.label { color: var(--fg-2); }
.none { color: var(--fg-3); padding: 12px 0; }
</style>
