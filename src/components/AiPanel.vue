<script setup>
// Assistant chat, docked on the right of the workspace.
import { ref, computed, watch, nextTick } from 'vue'
import { ai, ask, stopChat, resetChat, insertIntoEditor, openInNewTab, copyText } from '../lib/ai'
import { store } from '../lib/store'
import { renderMarkdown } from '../lib/markdown'
import { t } from '../lib/i18n'
import Icon from './Icon.vue'

const input = ref('')
const box = ref(null)
const list = ref(null)

const a = computed(() => ai.settings?.assistant)
const keyIdOf = (p, url) => (p === 'anthropic' ? 'anthropic' : (() => { try { return 'openai:' + new URL(url).origin } catch { return 'openai:' + (url || '') } })())
const configured = computed(() => {
  if (!a.value?.model) return false
  if (a.value.provider === 'anthropic') return (a.value.keyIds || []).includes('anthropic')
  return !!a.value.baseUrl
})
const modelLabel = computed(() => a.value?.model || '')
const tab = computed(() => store.tabs.find((x) => x.id === store.activeTabId))
const hasEditorSql = computed(() => tab.value?.type === 'query' && !!tab.value.sql?.trim())

const suggestions = computed(() => [
  t('Resuma o schema deste banco: tabelas principais e como se relacionam'),
  t('Explique a consulta do editor e como deixá-la mais rápida'),
  t('Quais tabelas têm mais linhas?'),
  t('Escreva uma consulta com os 10 clientes que mais compraram'),
])

function toolLabel(name) {
  switch (name) {
    case 'list_connections': return t('listou conexões')
    case 'list_schemas': return t('listou schemas')
    case 'list_tables': return t('listou tabelas')
    case 'describe_table': return t('leu a estrutura')
    case 'get_schema': return t('leu o schema')
    case 'run_query': return t('executou SQL')
    default: return name
  }
}

function toolTitle(p) {
  if (p.name === 'run_query' && p.done) {
    if (p.status === 'rejected') return t('SQL recusado por você — nada foi executado')
    if (p.status === 'approved') return t('executou SQL (aprovado por você)')
    if (p.status === 'error') return t('SQL com erro')
  }
  if (p.name === 'run_query' && !p.done) return t('executando SQL…')
  const what = p.input?.table || ''
  return `${toolLabel(p.name)}${what ? ' · ' + what : ''}`
}

async function send(text = input.value) {
  if (!text.trim() || ai.chat.busy) return
  input.value = ''
  autosize()
  await ask(text)
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

function autosize() {
  nextTick(() => {
    const el = box.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(180, el.scrollHeight) + 'px'
  })
}

// Keep the latest message in view while it streams, unless the user scrolled up.
let stick = true
function onScroll() {
  const el = list.value
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
watch(() => {
  const last = ai.chat.items[ai.chat.items.length - 1]
  return [ai.chat.items.length, last?.parts?.length, last?.parts?.[last.parts.length - 1]?.text?.length, ai.chat.status]
}, () => nextTick(() => {
  if (stick && list.value) list.value.scrollTop = list.value.scrollHeight
}))

watch(() => ai.panel, (open) => open && nextTick(() => box.value?.focus()))

function openSettings(tabId = 'assistant') {
  ai.settingsTab = tabId
  ai.showSettings = true
}
</script>

<template>
  <aside class="aip">
    <header>
      <Icon name="sparkle" :size="15" />
      <span class="title">{{ t('Assistente') }}</span>
      <span v-if="configured" class="model" :title="a.provider === 'anthropic' ? 'Anthropic' : a.baseUrl">{{ modelLabel }}</span>
      <span class="grow" />
      <button class="btn ghost icon sm" :title="t('Nova conversa')" :disabled="ai.chat.busy || !ai.chat.items.length" @click="resetChat"><Icon name="newChat" :size="14" /></button>
      <button class="btn ghost icon sm" :title="t('Configurar AI')" @click="openSettings()"><Icon name="settings" :size="14" /></button>
      <button class="btn ghost icon sm" :title="t('Fechar')" @click="ai.panel = false"><Icon name="close" :size="13" /></button>
    </header>

    <div v-if="!configured" class="setup">
      <Icon name="sparkle" :size="26" />
      <p>{{ t('Use a sua própria AI para explorar o banco e escrever SQL. Funciona com a API da Anthropic (Claude) ou qualquer provedor compatível com OpenAI, inclusive modelos locais (Ollama, LM Studio).') }}</p>
      <button class="btn primary" @click="openSettings('assistant')">{{ t('Configurar assistente') }}</button>
      <p class="muted small">{{ t('Prefere o Claude Code, Cursor ou outro agente?') }} <a href="#" @click.prevent="openSettings('mcp')">{{ t('Ligue o servidor MCP') }}</a>.</p>
    </div>

    <template v-else>
      <div ref="list" class="msgs" @scroll="onScroll">
        <div v-if="!ai.chat.items.length" class="intro">
          <p class="muted">{{ t('Pergunte sobre') }} <b>{{ store.connection?.saved?.name || store.connection?.database || t('o banco aberto') }}</b>. {{ t('O assistente lê o schema e roda leituras sozinho; escritas pedem sua aprovação.') }}</p>
          <button v-for="s in suggestions" :key="s" class="sugg" @click="send(s)">{{ s }}</button>
        </div>

        <template v-for="(m, i) in ai.chat.items" :key="i">
          <div v-if="m.role === 'user'" class="user">
            <div class="bubble">{{ m.text }}</div>
            <div v-if="m.error" class="ctx-err" :title="m.error"><Icon name="alert" :size="11" /> {{ t('erro anexado') }}</div>
          </div>
          <div v-else class="asst">
            <template v-for="(p, j) in m.parts" :key="j">
              <div v-if="p.type === 'text'" class="md">
                <template v-for="(b, k) in renderMarkdown(p.text)" :key="k">
                  <div v-if="b.type === 'html'" v-html="b.html" />
                  <div v-else class="code">
                    <div class="code-bar">
                      <span class="lang">{{ b.lang || t('código') }}</span>
                      <span class="grow" />
                      <template v-if="!b.open && (b.lang === 'sql' || !b.lang)">
                        <button class="btn ghost sm" :title="t('Inserir no editor da aba atual')" @click="insertIntoEditor(b.code)"><Icon name="code" :size="12" /> {{ t('Inserir') }}</button>
                        <button class="btn ghost sm" :title="t('Abrir numa nova aba de consulta')" @click="openInNewTab(b.code)"><Icon name="plus" :size="12" /> {{ t('Nova aba') }}</button>
                      </template>
                      <button v-if="!b.open" class="btn ghost icon sm" :title="t('Copiar')" @click="copyText(b.code)"><Icon name="copy" :size="12" /></button>
                    </div>
                    <pre>{{ b.code }}</pre>
                  </div>
                </template>
              </div>
              <details v-else-if="p.type === 'tool'" class="tool" :class="{ err: p.done && (!p.ok || p.status === 'rejected') }">
                <summary>
                  <span v-if="!p.done" class="spin" /><Icon v-else :name="p.status === 'rejected' ? 'close' : p.ok ? 'check' : 'alert'" :size="11" />
                  {{ toolTitle(p) }}
                </summary>
                <pre v-if="p.input?.sql" class="tool-sql">{{ p.input.sql }}</pre>
                <pre v-if="p.text" class="tool-out">{{ p.text }}</pre>
              </details>
              <div v-else-if="p.type === 'error'" class="err-msg"><Icon name="alert" :size="13" /> {{ p.text }}</div>
              <div v-else-if="p.type === 'note'" class="note">{{ p.text }}</div>
            </template>
          </div>
        </template>

        <div v-if="ai.chat.busy" class="busy">
          <span class="spin" /> {{ ai.chat.status || t('escrevendo…') }}
          <span v-if="ai.approvals.length" class="wait">— {{ t('aguardando sua aprovação') }}</span>
        </div>
      </div>

      <div class="composer">
        <textarea ref="box" v-model="input" rows="1" spellcheck="false" :placeholder="ai.chat.busy ? t('Aguardando a resposta…') : t('Pergunte ou peça uma consulta (Enter envia, Shift+Enter quebra linha)')"
                  @keydown="onKey" @input="autosize" />
        <button v-if="ai.chat.busy" class="btn icon" :title="t('Parar')" @click="stopChat"><Icon name="stop" :size="14" /></button>
        <button v-else class="btn primary icon" :title="t('Enviar')" :disabled="!input.trim()" @click="send()"><Icon name="send" :size="14" /></button>
      </div>
      <div class="foot-hint">
        <template v-if="hasEditorSql">{{ t('O SQL do editor vai junto como contexto.') }}</template>
        <template v-else>{{ t('Conexão: {name}', { name: store.connection?.saved?.name || store.connection?.database || '' }) }}</template>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.aip { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--surface-2); }
header { display: flex; align-items: center; gap: 8px; height: 40px; flex: none; padding: 0 8px 0 12px; border-bottom: 1px solid var(--line-2); }
.title { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-2); }
.model { font: 11px var(--mono); color: var(--fg-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.grow { flex: 1; }
.setup { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 32px 20px; text-align: center; color: var(--fg-3); }
.setup p { margin: 0; font-size: 12.5px; line-height: 1.55; }
.setup .small { font-size: 11.5px; }
.setup a { color: var(--fg); }
.msgs { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.intro { display: flex; flex-direction: column; gap: 6px; }
.intro p { margin: 0 0 6px; font-size: 12.5px; line-height: 1.5; }
.sugg { text-align: left; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); color: var(--fg-2); font: inherit; font-size: 12px; cursor: pointer; }
.sugg:hover { border-color: var(--line-3); color: var(--fg); }
.user { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.bubble { max-width: 92%; padding: 8px 11px; border-radius: 10px 10px 2px 10px; background: var(--surface-5); color: var(--fg); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; user-select: text; }
.ctx-err { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--fg-4); }
.asst { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; line-height: 1.55; color: var(--fg); user-select: text; }
.md :deep(p) { margin: 0; }
.md :deep(.md-gap) { height: 6px; }
.md :deep(.md-h) { font-weight: 700; margin: 6px 0 2px; }
.md :deep(ul), .md :deep(ol) { margin: 2px 0; padding-left: 18px; }
.md :deep(code) { padding: 0 4px; border-radius: 3px; background: var(--surface-4); font: 11.5px var(--mono); }
.code { margin: 4px 0; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); overflow: hidden; }
.code-bar { display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 4px 0 10px; border-bottom: 1px solid var(--line-2); }
.lang { font: 10.5px var(--mono); color: var(--fg-4); text-transform: uppercase; }
.code pre { margin: 0; padding: 8px 10px; font: 11.5px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
.tool { border: 1px solid var(--line-2); border-radius: 6px; background: var(--surface-1); font-size: 11.5px; color: var(--fg-3); }
.tool summary { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; list-style: none; }
.tool summary::-webkit-details-marker { display: none; }
.tool.err { border-color: var(--fg-3); color: var(--fg-2); }
.tool pre { margin: 0; padding: 6px 8px; border-top: 1px solid var(--line-2); font: 11px/1.45 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
.tool-sql { color: var(--fg); }
.err-msg { display: flex; gap: 6px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line-3); border-left: 3px solid var(--fg); border-radius: 6px; font-size: 12px; }
.note { font-size: 11.5px; color: var(--fg-4); font-style: italic; }
.busy { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--fg-3); }
.wait { color: var(--fg); font-weight: 600; }
.spin { display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--fg-4); border-top-color: var(--fg); border-radius: 50%; animation: spin 0.7s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.composer { display: flex; align-items: flex-end; gap: 6px; padding: 8px 10px 4px; border-top: 1px solid var(--line-2); }
.composer textarea {
  flex: 1; min-width: 0; resize: none; max-height: 180px;
  padding: 7px 10px; border: 1px solid var(--line-2); border-radius: 8px;
  background: var(--surface-1); color: var(--fg); outline: 0;
  font: 12.5px/1.45 var(--font); user-select: text;
}
.composer textarea:focus { border-color: var(--fg-4); }
.composer .btn { height: 32px; width: 32px; }
.foot-hint { padding: 0 12px 8px; font-size: 10.5px; color: var(--fg-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
