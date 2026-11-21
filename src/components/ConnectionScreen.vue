<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { call, bridge } from '../lib/api'
import { openConnection, toast } from '../lib/store'
import Icon from './Icon.vue'
import LanguageMenu from './LanguageMenu.vue'
import { t } from '../lib/i18n'
import { ai } from '../lib/ai'

const TYPES = [
  { id: 'sqlite', label: 'SQLite', port: '' },
  { id: 'postgres', label: 'PostgreSQL', port: '5432' },
  { id: 'mysql', label: 'MySQL', port: '3306' },
]

const saved = ref([])
const selectedId = ref(null)
const busy = ref('')
const message = ref(null) // { kind, text }
const form = reactive(blank())

function blank(type = 'postgres') {
  return {
    id: null, name: '', type,
    host: 'localhost', port: TYPES.find((x) => x.id === type).port,
    user: '', password: '', database: '', file: '',
    ssl: false, readOnly: false, savePassword: true,
  }
}

const isSqlite = computed(() => form.type === 'sqlite')
const title = computed(() => (form.id ? form.name || t('Conexão') : t('Nova conexão')))

async function load() {
  saved.value = await call('app/connections')
}

function setType(type) {
  if (form.type === type) return
  const prevDefault = TYPES.find((x) => x.id === form.type).port
  form.type = type
  if (!form.port || form.port === prevDefault) form.port = TYPES.find((x) => x.id === type).port
  message.value = null
}

function newConnection() {
  Object.assign(form, blank(form.type === 'sqlite' ? 'postgres' : form.type))
  selectedId.value = null
  message.value = null
}

async function pick(c) {
  selectedId.value = c.id
  message.value = null
  Object.assign(form, blank(c.type), c.config, {
    id: c.id, name: c.name, type: c.type,
    password: c.password ? await bridge.decrypt(c.password) : '',
    savePassword: !!c.password || c.type === 'sqlite',
  })
}

function config() {
  const c = { type: form.type }
  if (isSqlite.value) Object.assign(c, { file: form.file, readOnly: form.readOnly })
  else Object.assign(c, { host: form.host, port: form.port, user: form.user, password: form.password, database: form.database, ssl: form.ssl })
  return c
}

function defaultName() {
  if (isSqlite.value) return form.file.split(/[\\/]/).pop() || 'SQLite'
  return `${form.user ? form.user + '@' : ''}${form.host}${form.database ? '/' + form.database : ''}`
}

async function browse() {
  const file = await bridge.openFile({
    create: true,
    filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: t('Todos os arquivos'), extensions: ['*'] }],
  })
  if (file) form.file = file
}

async function run(kind, fn) {
  busy.value = kind
  message.value = null
  try {
    await fn()
  } catch (e) {
    message.value = { kind: 'error', text: e.message }
  } finally {
    busy.value = ''
  }
}

const test = () => run('test', async () => {
  const version = await call('conn/test', { config: config() })
  message.value = { kind: 'ok', text: t('Conexão OK — {version}', { version }) }
})

const save = () => run('save', async () => {
  const { password, ...cfg } = config()
  const conn = {
    id: form.id,
    name: form.name.trim() || defaultName(),
    type: form.type,
    config: cfg,
    password: form.savePassword && password ? await bridge.encrypt(password) : null,
  }
  form.id = await call('app/saveConnection', { conn })
  form.name = conn.name
  selectedId.value = form.id
  await load()
  toast(t('Conexão salva'), 'success')
})

const connect = () => run('connect', async () => {
  const s = saved.value.find((c) => c.id === form.id) || { name: form.name.trim() || defaultName(), type: form.type }
  await openConnection(s, config())
})

const openDemo = () => run('demo', async () => {
  const file = await call('app/demoPath')
  await openConnection({ name: t('Demo · loja'), type: 'sqlite' }, { type: 'sqlite', file })
})

async function remove(c) {
  if (!confirm(t('Remover a conexão "{name}"?', { name: c.name }))) return
  await call('app/deleteConnection', { id: c.id })
  if (form.id === c.id) newConnection()
  await load()
}

function subtitle(c) {
  if (c.type === 'sqlite') return c.config.file
  return `${c.config.user ? c.config.user + '@' : ''}${c.config.host}:${c.config.port}${c.config.database ? '/' + c.config.database : ''}`
}

const typeLabel = (type) => TYPES.find((x) => x.id === type)?.label || type

onMounted(load)
</script>

<template>
  <div class="screen">
    <aside class="side">
      <div class="brand">
        <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 2l12 7v14l-12 7-12-7V9z" fill="#1c1c1c" stroke="#9a9a9a" stroke-width="1.5" />
          <path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="#e6e6e6" />
        </svg>
        <div>
          <div class="brand-name">Graphite</div>
          <div class="brand-sub">{{ t('cliente SQL') }}</div>
        </div>
      </div>

      <div class="side-actions">
        <button class="btn primary" @click="newConnection"><Icon name="plus" :size="14" /> {{ t('Nova conexão') }}</button>
        <button class="btn" :disabled="!!busy" @click="openDemo"><Icon name="bolt" :size="14" /> {{ t('Abrir demo') }}</button>
        <button class="btn ghost" :title="t('Assistente de AI e servidor MCP para agentes externos')" @click="ai.settingsTab = 'mcp'; ai.showSettings = true">
          <Icon name="sparkle" :size="14" /> {{ t('AI e agentes') }}<span v-if="ai.mcp.running" class="mcp-on" :title="t('Servidor MCP rodando')" />
        </button>
      </div>

      <div class="side-heading">{{ t('Conexões salvas') }} <span class="count">{{ saved.length }}</span></div>
      <div class="saved">
        <div v-if="!saved.length" class="saved-empty">{{ t('Nenhuma conexão salva ainda.') }}</div>
        <div v-for="c in saved" :key="c.id" class="saved-item" :class="{ active: selectedId === c.id }"
             @click="pick(c)" @dblclick="pick(c).then(connect)">
          <div class="saved-icon"><Icon :name="c.type === 'sqlite' ? 'file' : 'server'" :size="15" /></div>
          <div class="saved-text">
            <div class="saved-name">{{ c.name }}</div>
            <div class="saved-sub">{{ subtitle(c) }}</div>
          </div>
          <span class="badge">{{ typeLabel(c.type) }}</span>
          <button class="btn ghost icon sm del" :title="t('Remover')" @click.stop="remove(c)"><Icon name="trash" :size="13" /></button>
        </div>
      </div>
      <div class="side-foot"><LanguageMenu /></div>
    </aside>

    <main class="main">
      <form class="card" @submit.prevent="connect">
        <header class="card-head">
          <h1>{{ title }}</h1>
          <p class="muted">{{ t('Escolha o tipo de banco e preencha os dados de acesso.') }}</p>
        </header>

        <div class="segmented" role="tablist">
          <button v-for="type in TYPES" :key="type.id" type="button" role="tab"
                  :class="{ on: form.type === type.id }" :aria-selected="form.type === type.id" @click="setType(type.id)">
            {{ type.label }}
          </button>
        </div>

        <div class="grid">
          <div class="field span-2">
            <label for="f-name">{{ t('Nome') }}</label>
            <input id="f-name" v-model="form.name" class="input" :placeholder="defaultName() || t('Minha conexão')" />
          </div>

          <template v-if="isSqlite">
            <div class="field span-2">
              <label for="f-file">{{ t('Arquivo') }}</label>
              <div class="row">
                <input id="f-file" v-model="form.file" class="input mono" :placeholder="t('/caminho/para/banco.sqlite')" />
                <button type="button" class="btn" @click="browse"><Icon name="folder" :size="14" /> {{ t('Procurar') }}</button>
              </div>
            </div>
            <label class="check span-2"><input v-model="form.readOnly" type="checkbox" /> {{ t('Abrir somente leitura') }}</label>
          </template>

          <template v-else>
            <div class="field">
              <label for="f-host">Host</label>
              <input id="f-host" v-model="form.host" class="input" placeholder="localhost" />
            </div>
            <div class="field">
              <label for="f-port">{{ t('Porta') }}</label>
              <input id="f-port" v-model="form.port" class="input" inputmode="numeric" />
            </div>
            <div class="field">
              <label for="f-user">{{ t('Usuário') }}</label>
              <input id="f-user" v-model="form.user" class="input" autocomplete="off" />
            </div>
            <div class="field">
              <label for="f-pass">{{ t('Senha') }}</label>
              <input id="f-pass" v-model="form.password" class="input" type="password" autocomplete="off" />
            </div>
            <div class="field span-2">
              <label for="f-db">{{ t('Banco de dados') }}</label>
              <input id="f-db" v-model="form.database" class="input" :placeholder="form.type === 'postgres' ? 'postgres' : t('opcional')" />
            </div>
            <div class="checks span-2">
              <label class="check"><input v-model="form.ssl" type="checkbox" /> {{ t('Usar SSL') }}</label>
              <label class="check"><input v-model="form.savePassword" type="checkbox" /> {{ t('Salvar senha') }}</label>
            </div>
          </template>
        </div>

        <div v-if="message" class="message" :class="message.kind">
          <Icon :name="message.kind === 'ok' ? 'check' : 'alert'" :size="15" />
          <span>{{ message.text }}</span>
        </div>

        <footer class="card-foot">
          <button type="button" class="btn" :disabled="!!busy" @click="test">
            {{ busy === 'test' ? t('Testando…') : t('Testar') }}
          </button>
          <span class="spacer" />
          <button type="button" class="btn" :disabled="!!busy" @click="save"><Icon name="save" :size="14" /> {{ t('Salvar') }}</button>
          <button type="submit" class="btn primary" :disabled="!!busy">
            {{ busy === 'connect' || busy === 'demo' ? t('Conectando…') : t('Conectar') }}
          </button>
        </footer>
      </form>
    </main>
  </div>
</template>

<style scoped>
.screen { display: flex; height: 100%; }

.side {
  width: 300px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border-right: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 12px; padding: 22px 20px 18px; }
.logo { width: 34px; height: 34px; }
.brand-name { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.brand-sub { font-size: 11px; color: var(--fg-3); letter-spacing: 0.08em; text-transform: uppercase; }

.side-foot { padding: 8px 16px 12px; border-top: 1px solid var(--line-2); }
.side-foot .btn { width: 100%; justify-content: flex-start; height: 28px; color: var(--fg-3); }
.side-foot .btn:hover { color: var(--fg); }
.side-actions { display: grid; gap: 8px; padding: 0 16px 18px; }
.side-actions .btn { justify-content: center; height: 32px; }

.side-heading {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 20px 8px;
  border-top: 1px solid var(--line);
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-3);
}
.count { color: var(--fg-4); }
.saved { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
.saved-empty { padding: 12px; color: var(--fg-4); }
.saved-item {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius);
  cursor: pointer;
}
.saved-item:hover { background: var(--sel); }
.saved-item.active { background: var(--sel-2); }
.saved-icon {
  display: grid; place-items: center;
  width: 30px; height: 30px; flex: none;
  border: 1px solid var(--line-2); border-radius: var(--radius);
  background: var(--surface-3); color: var(--fg-2);
}
.saved-text { min-width: 0; flex: 1; }
.saved-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.saved-sub { font: 11px var(--mono); color: var(--fg-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.badge {
  font-size: 10px; padding: 1px 6px; border-radius: 10px;
  border: 1px solid var(--line-3); color: var(--fg-3);
}
.saved-item .del { display: none; }
.saved-item:hover .badge { display: none; }
.saved-item:hover .del { display: inline-flex; }

.main {
  flex: 1;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: 32px;
  background:
    radial-gradient(ellipse at 50% 0%, rgba(255, 255, 255, 0.035), transparent 60%),
    var(--bg);
}
.card {
  width: min(560px, 100%);
  padding: 28px;
  border: 1px solid var(--line-2);
  border-radius: 12px;
  background: var(--surface-2);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}
.card-head h1 { margin: 0 0 4px; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
.card-head p { margin: 0 0 20px; }

.segmented {
  display: grid; grid-template-columns: repeat(3, 1fr);
  padding: 3px; margin-bottom: 20px;
  border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-1);
}
.segmented button {
  height: 30px; border: 0; border-radius: 6px; background: transparent;
  color: var(--fg-3); cursor: pointer; font-weight: 500;
}
.segmented button:hover { color: var(--fg); }
.segmented button.on { background: var(--surface-5); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line-3); }

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 14px; }
.span-2 { grid-column: span 2; }
.row { display: flex; gap: 8px; }
.checks { display: flex; gap: 20px; }

.message {
  display: flex; align-items: flex-start; gap: 8px;
  margin-top: 18px; padding: 10px 12px;
  border: 1px solid var(--line-3); border-radius: var(--radius);
  background: var(--surface-3); color: var(--fg-2);
  user-select: text; word-break: break-word;
}
.message .icon { margin-top: 2px; }
.message.error { border-left: 3px solid var(--fg); color: var(--fg); }

.card-foot { display: flex; gap: 8px; margin-top: 24px; }
.card-foot .btn { height: 32px; }
.spacer { flex: 1; }
.mcp-on { width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: var(--fg); display: inline-block; }
</style>
