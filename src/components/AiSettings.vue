<script setup>
// AI settings: the built-in assistant's provider, the MCP server for external
// agents (with ready-to-paste client configs) and the activity log.
import { ref, reactive, computed, watch } from 'vue'
import { ai, updateAi, copyText } from '../lib/ai'
import { bridge } from '../lib/api'
import { t, fmtTime } from '../lib/i18n'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const tabs = computed(() => [
  { id: 'assistant', label: t('Assistente') },
  { id: 'mcp', label: t('Agentes externos (MCP)') },
  { id: 'activity', label: t('Atividade') },
])

// --- assistant ----------------------------------------------------------------
const PRESETS = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1', model: '' },
  { label: 'Ollama (local)', url: 'http://localhost:11434/v1', model: '' },
  { label: 'LM Studio (local)', url: 'http://localhost:1234/v1', model: '' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: '' },
]

const a = computed(() => ai.settings?.assistant || {})
// Same rule as the main process (electron/ai/hub.cjs keyId): one key per destination.
function keyIdOf(provider, baseUrl) {
  if (provider === 'anthropic') return 'anthropic'
  try { return 'openai:' + new URL(baseUrl).origin } catch { return 'openai:' + (baseUrl || '') }
}
const hasKey = computed(() => (a.value.keyIds || []).includes(keyIdOf(form.provider, form.baseUrl.trim())))
const form = reactive({ provider: 'anthropic', model: '', baseUrl: '', apiKey: '' })
const msg = ref(null) // { kind, text }
const busy = ref('')

function loadForm() {
  Object.assign(form, { provider: a.value.provider, model: a.value.model, baseUrl: a.value.baseUrl, apiKey: '' })
}
watch(() => ai.settings, loadForm, { immediate: true })

function setProvider(p) {
  if (form.provider === p) return
  form.provider = p
  form.model = p === 'anthropic' ? 'claude-opus-5-5' : ''
  form.baseUrl = p === 'anthropic' ? '' : form.baseUrl || PRESETS[1].url
  msg.value = null
}

function preset(p) {
  form.baseUrl = p.url
  msg.value = null
}

// Model dropdown: listed live by the main process (Anthropic Models API with
// the saved or typed key; GET /models on OpenAI-compatible servers).
const CUSTOM = '__custom__'
const models = reactive({ list: [], source: '', error: '', loading: false })
const customModel = ref(false)
let modelsSeq = 0
let modelsTimer = null
const clean = (m) => m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function loadModels() {
  clearTimeout(modelsTimer)
  const seq = ++modelsSeq
  models.loading = true
  try {
    const r = await bridge.ai.models({ provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() })
    if (seq === modelsSeq) Object.assign(models, { list: r.models, source: r.source, error: r.error || '' })
  } catch (e) {
    if (seq === modelsSeq) Object.assign(models, { list: [], source: 'none', error: clean(e.message) })
  } finally {
    if (seq === modelsSeq) models.loading = false
  }
}
watch(() => [form.provider, form.baseUrl], () => {
  clearTimeout(modelsTimer)
  modelsTimer = setTimeout(loadModels, 350)
}, { immediate: true })

const modelOptions = computed(() => {
  const opts = models.list.map((m) => ({ id: m.id, label: m.name && m.name !== m.id ? `${m.name} — ${m.id}` : m.id }))
  const cur = form.model.trim()
  if (cur && !opts.some((o) => o.id === cur)) opts.unshift({ id: cur, label: t('{model} (atual)', { model: cur }) })
  return opts
})
const selectValue = computed(() => (customModel.value ? CUSTOM : form.model.trim()))
function pickModel(e) {
  if (e.target.value === CUSTOM) customModel.value = true
  else { customModel.value = false; form.model = e.target.value }
}
watch(() => form.provider, () => { customModel.value = false })
const modelsHint = computed(() => {
  if (models.loading) return t('Carregando modelos…')
  if (models.error) return models.error
  if (form.provider === 'anthropic') {
    return models.source === 'api'
      ? t('{n} modelo disponível para a sua chave, direto da API da Anthropic.|{n} modelos disponíveis para a sua chave, direto da API da Anthropic.', { n: models.list.length })
      : t('Lista padrão. Salve a chave para ver todos os modelos que a sua conta pode usar.')
  }
  if (!form.baseUrl.trim()) return t('Informe a URL base para listar os modelos do servidor.')
  return models.list.length ? t('{n} modelo encontrado no servidor.|{n} modelos encontrados no servidor.', { n: models.list.length }) : t('O servidor não listou modelos; digite o ID em "Outro ID…".')
})

async function save({ test = false } = {}) {
  busy.value = test ? 'test' : 'save'
  msg.value = null
  try {
    const patch = { provider: form.provider, model: form.model.trim(), baseUrl: form.baseUrl.trim() }
    if (form.apiKey) patch.apiKey = form.apiKey.trim()
    await updateAi({ assistant: patch })
    form.apiKey = ''
    if ('apiKey' in patch) loadModels()
    msg.value = test ? { kind: 'ok', text: await bridge.ai.test() } : { kind: 'ok', text: t('Salvo') }
  } catch (e) {
    msg.value = { kind: 'error', text: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
  } finally {
    busy.value = ''
  }
}

async function removeKey() {
  if (!confirm(t('Remover a chave de API salva para este provedor?'))) return
  await updateAi({ assistant: { provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: '' } })
  msg.value = { kind: 'ok', text: t('Chave removida') }
  loadModels()
}

// --- MCP ------------------------------------------------------------------------
const m = computed(() => ai.settings?.mcp || {})
const port = ref(7329)
const showToken = ref(false)
const client = ref('claude-code')
watch(() => m.value.port, (p) => { if (p) port.value = p }, { immediate: true })

const url = computed(() => `http://127.0.0.1:${m.value.port}/mcp`)
const auth = computed(() => `Bearer ${m.value.token}`)
const clients = computed(() => [
  { id: 'claude-code', label: 'Claude Code', where: t('Rode no terminal:') },
  { id: 'cursor', label: 'Cursor', where: t('Em ~/.cursor/mcp.json (ou .cursor/mcp.json do projeto):') },
  { id: 'vscode', label: 'VS Code', where: t('Em .vscode/mcp.json do projeto (ou no mcp.json do usuário):') },
  { id: 'desktop', label: 'Claude Desktop', where: t('Em claude_desktop_config.json (precisa do Node.js; usa a ponte mcp-remote):') },
  { id: 'other', label: t('Outro'), where: t('Qualquer cliente MCP com transporte HTTP (Streamable HTTP):') },
])
const snippet = computed(() => {
  const u = url.value
  const h = auth.value
  switch (client.value) {
    case 'claude-code':
      return `claude mcp add --transport http graphite ${u} --header "Authorization: ${h}"`
    case 'cursor':
      return JSON.stringify({ mcpServers: { graphite: { url: u, headers: { Authorization: h } } } }, null, 2)
    case 'vscode':
      return JSON.stringify({ servers: { graphite: { type: 'http', url: u, headers: { Authorization: h } } } }, null, 2)
    case 'desktop':
      return JSON.stringify({ mcpServers: { graphite: { command: 'npx', args: ['-y', 'mcp-remote', u, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: h } } } }, null, 2)
    default:
      return `URL:    ${u}\nHeader: Authorization: ${h}`
  }
})

async function toggleMcp() {
  await updateAi({ mcp: { enabled: !m.value.enabled } })
}
async function savePort() {
  if (Number(port.value) !== m.value.port) await updateAi({ mcp: { port: Number(port.value) } })
}
async function regenerate() {
  if (!confirm(t('Gerar um novo token? Os agentes configurados com o token atual deixam de conectar até você atualizar a configuração deles.'))) return
  await updateAi({ regenerateToken: true })
}

// --- activity ---------------------------------------------------------------------
function statusLabel(s) {
  switch (s) {
    case 'running': return t('rodando')
    case 'ok': return 'ok'
    case 'error': return t('erro')
    case 'pending': return t('aguardando aprovação')
    case 'approved': return t('aprovado')
    case 'rejected': return t('recusado')
    default: return s
  }
}
</script>

<template>
  <Modal :title="t('AI')" :subtitle="t('Assistente embutido e agentes externos (MCP)')" width="760px" @close="ai.showSettings = false">
    <div class="seg">
      <button v-for="tb in tabs" :key="tb.id" :class="{ on: ai.settingsTab === tb.id }" @click="ai.settingsTab = tb.id">
        {{ tb.label }}
        <span v-if="tb.id === 'mcp' && ai.mcp.running" class="dot" :title="t('Servidor rodando')" />
      </button>
    </div>

    <!-- Assistant ------------------------------------------------------------>
    <div v-if="ai.settingsTab === 'assistant'" class="pane">
      <p class="lead">{{ t('O assistente conversa com o seu provedor de AI usando a sua chave. Ele vê o schema e roda leituras sozinho; escritas sempre pedem sua aprovação.') }}</p>
      <div class="field">
        <label>{{ t('Provedor') }}</label>
        <div class="seg small">
          <button :class="{ on: form.provider === 'anthropic' }" @click="setProvider('anthropic')">Anthropic (Claude)</button>
          <button :class="{ on: form.provider === 'openai' }" @click="setProvider('openai')">{{ t('Compatível com OpenAI') }}</button>
        </div>
      </div>

      <template v-if="form.provider === 'openai'">
        <div class="field">
          <label for="ai-url">{{ t('URL base') }}</label>
          <input id="ai-url" v-model="form.baseUrl" class="input mono" placeholder="http://localhost:11434/v1" spellcheck="false" />
          <div class="presets">
            <button v-for="p in PRESETS" :key="p.label" class="btn ghost sm" @click="preset(p)">{{ p.label }}</button>
          </div>
        </div>
      </template>

      <div class="field">
        <label for="ai-model">{{ t('Modelo') }}</label>
        <div class="row">
          <select id="ai-model" class="input mono" :value="selectValue" :disabled="models.loading && !modelOptions.length" @change="pickModel">
            <option v-if="!form.model.trim() && !customModel" value="" disabled>{{ models.loading ? t('Carregando…') : modelOptions.length ? t('Escolha um modelo') : t('Nenhum modelo listado') }}</option>
            <option v-for="o in modelOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
            <option :value="CUSTOM">{{ t('Outro ID…') }}</option>
          </select>
          <button class="btn sm" :title="t('Atualizar a lista de modelos')" :disabled="models.loading" @click="loadModels"><Icon name="refresh" :size="12" /></button>
        </div>
        <input v-if="customModel" v-model="form.model" class="input mono" spellcheck="false" :aria-label="t('ID do modelo')"
               :placeholder="form.provider === 'anthropic' ? 'claude-…' : t('ex.: llama3.1, gpt-5, qwen2.5-coder')" />
        <div class="hint">{{ modelsHint }}</div>
      </div>

      <div class="field">
        <label for="ai-key">{{ t('Chave de API') }} <span v-if="form.provider === 'openai'" class="muted">{{ t('(opcional em servidores locais)') }}</span></label>
        <div class="row">
          <input id="ai-key" v-model="form.apiKey" class="input mono" type="password" autocomplete="off" spellcheck="false" @change="loadModels"
                 :placeholder="hasKey ? t('•••••••• salva — digite para trocar') : form.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'" />
          <button v-if="hasKey" class="btn sm" :title="t('Remover a chave salva para este provedor')" @click="removeKey"><Icon name="trash" :size="12" /></button>
        </div>
        <div class="hint">{{ t('Fica cifrada neste computador (chaveiro do sistema), uma por provedor, e nunca é mostrada de volta.') }}</div>
      </div>

      <div v-if="msg" class="msg" :class="msg.kind"><Icon :name="msg.kind === 'ok' ? 'check' : 'alert'" :size="13" /> {{ msg.text }}</div>
    </div>

    <!-- MCP ------------------------------------------------------------------>
    <div v-else-if="ai.settingsTab === 'mcp'" class="pane">
      <p class="lead">{{ t('Deixa agentes como Claude Code, Cursor e Claude Desktop usarem as conexões do Graphite enquanto o app está aberto. Leituras rodam direto; escritas aparecem aqui para você aprovar.') }}</p>

      <div class="mcp-head">
        <label class="switch">
          <input type="checkbox" :checked="m.enabled" @change="toggleMcp" />
          <span>{{ t('Servidor MCP') }}</span>
        </label>
        <span class="status" :class="{ on: ai.mcp.running, err: ai.mcp.error }">
          <template v-if="ai.mcp.running">{{ t('Rodando em') }} <code>{{ ai.mcp.url }}</code></template>
          <template v-else-if="ai.mcp.error">{{ ai.mcp.error }}</template>
          <template v-else>{{ t('Desligado') }}</template>
        </span>
        <span v-if="ai.mcp.clients?.length" class="muted">· {{ t('conectados: {names}', { names: ai.mcp.clients.join(', ') }) }}</span>
      </div>

      <div class="grid2">
        <div class="field">
          <label for="mcp-port">{{ t('Porta') }}</label>
          <input id="mcp-port" v-model="port" class="input mono" inputmode="numeric" @change="savePort" @keydown.enter="savePort" />
        </div>
        <div class="field">
          <label>Token</label>
          <div class="row">
            <input class="input mono" :type="showToken ? 'text' : 'password'" :value="m.token" readonly />
            <button class="btn sm" :title="showToken ? t('Ocultar') : t('Mostrar')" @click="showToken = !showToken"><Icon name="view" :size="12" /></button>
            <button class="btn sm" :title="t('Copiar')" @click="copyText(m.token)"><Icon name="copy" :size="12" /></button>
            <button class="btn sm" :title="t('Gerar novo token')" @click="regenerate"><Icon name="refresh" :size="12" /></button>
          </div>
        </div>
      </div>

      <div class="field">
        <label>{{ t('Configurar o agente') }}</label>
        <div class="seg small">
          <button v-for="c in clients" :key="c.id" :class="{ on: client === c.id }" @click="client = c.id">{{ c.label }}</button>
        </div>
        <div class="hint">{{ clients.find((c) => c.id === client).where }}</div>
        <div class="code">
          <pre>{{ snippet }}</pre>
          <button class="btn sm" @click="copyText(snippet)"><Icon name="copy" :size="12" /> {{ t('Copiar') }}</button>
        </div>
        <div class="hint">{{ t('O token dá acesso às suas conexões salvas: trate como uma senha. O servidor só aceita conexões deste computador.') }}</div>
      </div>
    </div>

    <!-- Activity -------------------------------------------------------------->
    <div v-else class="pane">
      <div v-if="!ai.activity.length" class="none">{{ t('Nenhuma atividade ainda.') }}</div>
      <div v-for="e in ai.activity" :key="e.id" class="entry" :class="e.status">
        <div class="entry-head">
          <span class="t">{{ fmtTime(e.at) }}</span>
          <span class="src">{{ e.source }}</span>
          <span class="tool">{{ e.tool }}</span>
          <span v-if="e.connection" class="conn">{{ e.connection }}</span>
          <span class="grow" />
          <span class="badge">{{ statusLabel(e.status) }}</span>
          <span v-if="e.ms != null" class="ms">{{ e.ms }} ms</span>
        </div>
        <pre v-if="e.sql" class="sql">{{ e.sql }}</pre>
        <div v-if="e.detail" class="detail">{{ e.detail }}</div>
      </div>
    </div>

    <template #foot>
      <template v-if="ai.settingsTab === 'assistant'">
        <button class="btn" :disabled="!!busy" @click="save({ test: true })">{{ busy === 'test' ? t('Testando…') : t('Salvar e testar') }}</button>
        <button class="btn primary" :disabled="!!busy" @click="save()">{{ t('Salvar') }}</button>
      </template>
      <button v-else class="btn" @click="ai.showSettings = false">{{ t('Fechar') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.seg { display: flex; flex-wrap: wrap; padding: 2px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); width: fit-content; margin-bottom: 14px; }
.seg button { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 12px; border: 0; border-radius: 5px; background: transparent; color: var(--fg-3); cursor: pointer; font-size: 12.5px; }
.seg button:hover { color: var(--fg); }
.seg button.on { background: var(--surface-5); color: var(--fg); }
.seg.small { margin-bottom: 0; }
.seg.small button { height: 24px; font-size: 12px; padding: 0 10px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg); }
.pane { display: flex; flex-direction: column; gap: 14px; min-height: 300px; }
.lead { margin: 0; color: var(--fg-2); font-size: 12.5px; line-height: 1.55; }
.row { display: flex; gap: 6px; align-items: center; }
.row .input { flex: 1; min-width: 0; }
.presets { display: flex; flex-wrap: wrap; gap: 4px; }
.hint { font-size: 11.5px; color: var(--fg-4); }
.msg { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 6px; font-size: 12.5px; }
.msg.error { border-left: 3px solid var(--fg); }
.msg.ok { color: var(--fg-2); }
.mcp-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.switch { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; }
.switch input { accent-color: #d6d6d6; width: 15px; height: 15px; margin: 0; }
.status { font-size: 12px; color: var(--fg-3); }
.status.on { color: var(--fg); }
.status.err { color: var(--fg); font-weight: 600; }
.status code, .code pre { font-family: var(--mono); }
.grid2 { display: grid; grid-template-columns: 140px 1fr; gap: 12px; }
.code { position: relative; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); }
.code pre { margin: 0; padding: 10px 12px; padding-right: 90px; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; user-select: text; max-height: 220px; overflow: auto; }
.code .btn { position: absolute; top: 8px; right: 8px; }
.none { color: var(--fg-4); text-align: center; padding: 40px; }
.entry { border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-1); }
.entry.rejected, .entry.error { border-left: 3px solid var(--fg-3); }
.entry.pending { border-left: 3px solid var(--fg); }
.entry-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11.5px; color: var(--fg-3); }
.entry-head .src { color: var(--fg-2); font-weight: 600; }
.entry-head .tool { font-family: var(--mono); color: var(--fg); }
.entry-head .grow { flex: 1; }
.badge { padding: 0 6px; border-radius: 4px; background: var(--surface-4); color: var(--fg-2); font-size: 10.5px; }
.entry.pending .badge, .entry.rejected .badge, .entry.error .badge { background: var(--fg); color: var(--accent-fg); }
.sql { margin: 0; padding: 6px 10px; border-top: 1px solid var(--line-2); font: 11.5px/1.45 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; user-select: text; }
.detail { padding: 4px 10px 6px; font-size: 11.5px; color: var(--fg-3); }
</style>
