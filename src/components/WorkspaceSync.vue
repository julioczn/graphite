<script setup>
// GitHub sync for the active workspace: sign in (GitHub App device flow or a
// personal token), pick a private repository and folder, sync.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
import { t } from '../lib/i18n'
import { toast } from '../lib/store'
import { workspaces, activeWorkspace, loadWorkspaces, syncNow, github, cleanError } from '../lib/workspaces'

const w = computed(() => activeWorkspace())
const gh = computed(() => workspaces.github)
const repos = ref(null)
const loadingRepos = ref(false)
const repo = ref('')
const dir = ref('')
const token = ref('')
const showToken = ref(false)
const busy = ref('')
const error = ref('')

const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
const NEW_REPO = 'https://github.com/new?name=graphite-workspaces&visibility=private&description=Graphite%20workspaces'
const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'

async function run(kind, fn) {
  busy.value = kind
  error.value = ''
  try {
    return await fn()
  } catch (e) {
    error.value = cleanError(e)
  } finally {
    busy.value = ''
  }
}

async function loadRepos({ quiet = false } = {}) {
  if (!gh.value.login || w.value?.remote || loadingRepos.value) return
  loadingRepos.value = true
  if (quiet) {
    // coming back from the browser: refresh without flashing errors
    try {
      repos.value = await github.repos()
      if (!repos.value.some((r) => r.fullName === repo.value)) repo.value = (repos.value.find((r) => /graphite/i.test(r.fullName)) || repos.value[0])?.fullName || ''
      if (repos.value.length) error.value = ''
    } catch {}
    loadingRepos.value = false
    return
  }
  await run('repos', async () => {
    repos.value = await github.repos()
    if (!repo.value && repos.value.length) repo.value = (repos.value.find((r) => /graphite/i.test(r.fullName)) || repos.value[0]).fullName
  })
  loadingRepos.value = false
}

const saveToken = () => run('token', async () => {
  await github.token(token.value)
  token.value = ''
  showToken.value = false
})

const link = () => run('link', async () => {
  const r = await github.link(w.value.id, repo.value.trim(), dir.value.trim() || slug(w.value.name))
  await loadWorkspaces()
  workspaces.version++
  toast(r.pulled ? t('Workspace ligado ao GitHub e atualizado com o que já estava lá') : t('Workspace ligado ao GitHub'), 'success')
})

const unlink = () => run('unlink', async () => {
  if (!confirm(t('Desligar este workspace do GitHub? Nada é apagado, nem aqui nem no repositório.'))) return
  await github.unlink(w.value.id)
  await loadWorkspaces()
})

const sync = () => run('sync', () => syncNow(w.value.id))
const setAuto = (on) => github.setAuto(w.value.id, on).then(loadWorkspaces)
const logout = () => run('logout', github.logout)
const copyCode = () => navigator.clipboard.writeText(gh.value.pending.userCode).then(() => toast(t('Código copiado'), 'success'))

// The app only sees repositories it is installed on. The user installs it in
// the browser, so refresh the list when the window gets focus back.
const noAccess = computed(() => gh.value.method === 'app' && repos.value && !repos.value.length)
const onFocus = () => loadRepos({ quiet: true })
const install = () => github.open(gh.value.installUrl)
watch(() => gh.value.login, () => loadRepos())
onMounted(() => {
  loadRepos()
  window.addEventListener('focus', onFocus)
})
onBeforeUnmount(() => window.removeEventListener('focus', onFocus))
</script>

<template>
  <Modal :title="t('Sincronizar com o GitHub')" :subtitle="t('Workspace: {name}', { name: w?.name })" width="560px" @close="workspaces.dialog = null">
    <p class="lead">{{ t('Guarda este workspace (conexões, consultas salvas, snippets, abas e preferências) num repositório privado seu, para usar em outras máquinas ou com o time. Senhas e tokens nunca vão para o GitHub.') }}</p>

    <!-- 1. account -->
    <section class="step">
      <h4><span class="n">1</span> {{ t('Conta do GitHub') }}</h4>
      <template v-if="gh.login">
        <div class="row between">
          <span>{{ t('Conectado como') }} <b>@{{ gh.login }}</b> <span class="muted">· {{ gh.method === 'app' ? t('app do Graphite') : t('token pessoal') }}</span></span>
          <button class="btn sm" :disabled="!!busy" @click="logout">{{ t('Sair') }}</button>
        </div>
      </template>
      <template v-else-if="gh.pending">
        <p>{{ t('Abri o GitHub no navegador. Digite este código lá e autorize o Graphite:') }}</p>
        <div class="code-row">
          <code class="code">{{ gh.pending.userCode }}</code>
          <button class="btn sm" @click="copyCode"><Icon name="copy" :size="13" /> {{ t('Copiar') }}</button>
          <button class="btn sm ghost" @click="github.open(gh.pending.uri)">{{ t('Abrir de novo') }}</button>
          <span class="spacer" />
          <button class="btn sm ghost" @click="github.cancel()">{{ t('Cancelar') }}</button>
        </div>
        <p class="muted small"><span class="dot-wait" /> {{ t('Esperando a autorização…') }}</p>
      </template>
      <template v-else>
        <div class="row">
          <button v-if="gh.deviceFlow" class="btn primary" :disabled="!!busy" @click="github.login()"><Icon name="link" :size="14" /> {{ t('Entrar com GitHub') }}</button>
          <button class="btn" :class="{ ghost: gh.deviceFlow }" @click="showToken = !showToken">{{ t('Usar um token pessoal') }}</button>
        </div>
        <div v-if="showToken || !gh.deviceFlow" class="token">
          <ol class="small">
            <li>{{ t('Crie um token "fine-grained" no GitHub') }} (<a href="#" @click.prevent="github.open(TOKEN_PAGE)">{{ t('abrir a página') }}</a>).</li>
            <li>{{ t('Em "Repository access", escolha "Only select repositories" e marque o repositório dos workspaces.') }}</li>
            <li>{{ t('Em "Permissions", dê "Contents: Read and write". Nada mais.') }}</li>
          </ol>
          <div class="row">
            <input v-model="token" class="input mono" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" @keydown.enter="saveToken" />
            <button class="btn primary" :disabled="!token.trim() || !!busy" @click="saveToken">{{ busy === 'token' ? t('Verificando…') : t('Salvar') }}</button>
          </div>
          <p class="muted small">{{ t('O token fica cifrado pelo chaveiro do sistema e só é usado para falar com o GitHub.') }}</p>
        </div>
      </template>
    </section>

    <!-- 2. repository -->
    <section class="step" :class="{ off: !gh.login }">
      <h4><span class="n">2</span> {{ t('Repositório') }}</h4>
      <template v-if="w?.remote">
        <div class="linked">
          <div><Icon name="link" :size="13" /> <b>{{ w.remote.repo }}</b> <span class="muted">/ {{ w.remote.dir }}</span></div>
          <div class="muted small">
            <template v-if="w.remote.lastError">{{ t('Erro na última sincronização: {error}', { error: w.remote.lastError }) }}</template>
            <template v-else-if="w.remote.lastSyncAt">{{ t('Última sincronização: {time}', { time: new Date(w.remote.lastSyncAt).toLocaleString() }) }}</template>
          </div>
          <label class="check small"><input type="checkbox" :checked="w.remote.auto !== false" @change="setAuto($event.target.checked)" /> {{ t('Sincronizar sozinho (ao abrir o app, a cada 10 minutos e logo depois de mudanças)') }}</label>
        </div>
      </template>
      <template v-else-if="gh.login && noAccess">
        <div class="access">
          <p>{{ t('O Graphite ainda não tem acesso a nenhum repositório seu. O GitHub só deixa o app ver os repositórios que você escolher:') }}</p>
          <ol class="small">
            <li>{{ t('Crie um repositório privado, se ainda não tiver') }} (<a href="#" @click.prevent="github.open(NEW_REPO)">{{ t('criar agora') }}</a>).</li>
            <li>{{ t('Instale o Graphite Sync na sua conta e, em "Only select repositories", marque esse repositório.') }}</li>
            <li>{{ t('Volte para cá: a lista atualiza sozinha.') }}</li>
          </ol>
          <div class="row">
            <button class="btn primary" @click="install"><Icon name="link" :size="13" /> {{ t('Dar acesso a um repositório') }}</button>
            <button class="btn" :disabled="loadingRepos" @click="loadRepos()"><Icon name="refresh" :size="13" /> {{ loadingRepos ? t('Verificando…') : t('Verificar de novo') }}</button>
          </div>
        </div>
      </template>
      <template v-else-if="gh.login">
        <div class="field">
          <label>{{ t('Repositório privado') }}</label>
          <div class="row">
            <select v-if="repos && repos.length" v-model="repo" class="input">
              <option v-for="r in repos" :key="r.fullName" :value="r.fullName">{{ r.fullName }}</option>
            </select>
            <input v-else v-model="repo" class="input mono" :placeholder="t('dono/nome')" spellcheck="false" />
            <button class="btn" :title="t('Atualizar lista')" :disabled="loadingRepos" @click="loadRepos()"><Icon name="refresh" :size="13" /></button>
          </div>
          <div class="hint">
            <template v-if="repos && !repos.length">{{ t('Nenhum repositório privado disponível.') }} </template>
            <a href="#" @click.prevent="github.open(NEW_REPO)">{{ t('Criar um repositório privado') }}</a>
            <template v-if="gh.method === 'app' && gh.installUrl"> · <a href="#" @click.prevent="install">{{ t('Dar acesso do Graphite a outro repositório') }}</a></template>
          </div>
        </div>
        <div class="field">
          <label>{{ t('Pasta no repositório') }}</label>
          <input v-model="dir" class="input mono" :placeholder="slug(w?.name) || 'workspace'" spellcheck="false" />
          <div class="hint">{{ t('Um repositório pode guardar vários workspaces, um por pasta. Se a pasta já tiver um workspace, os dois são combinados.') }}</div>
        </div>
      </template>
      <p v-else class="muted small">{{ t('Entre no GitHub primeiro.') }}</p>
    </section>

    <div v-if="error" class="err"><Icon name="alert" :size="14" /> {{ error }}</div>

    <template #foot>
      <button v-if="w?.remote" class="btn ghost" :disabled="!!busy" @click="unlink">{{ t('Desligar do GitHub') }}</button>
      <span class="spacer" />
      <button class="btn" @click="workspaces.dialog = null">{{ t('Fechar') }}</button>
      <button v-if="w?.remote" class="btn primary" :disabled="!!busy || !gh.login || workspaces.syncing[w.id]" @click="sync">
        <Icon name="refresh" :size="13" /> {{ workspaces.syncing[w.id] ? t('Sincronizando…') : t('Sincronizar agora') }}
      </button>
      <button v-else class="btn primary" :disabled="!!busy || !gh.login || noAccess || !repo.trim()" @click="link">
        {{ busy === 'link' ? t('Ligando…') : t('Ligar e sincronizar') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.lead { margin: 0 0 16px; color: var(--fg-2); font-size: 13px; line-height: 1.55; }
.step { padding: 14px 0; border-top: 1px solid var(--line-2); }
.step.off { opacity: 0.5; }
h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 13px; }
.n { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--surface-1); border: 1px solid var(--line-3); font-size: 11px; }
.row { display: flex; align-items: center; gap: 8px; }
.row .input { flex: 1; min-width: 0; }
.between { justify-content: space-between; font-size: 13px; }
.muted { color: var(--fg-3); }
.small { font-size: 12px; line-height: 1.5; }
.token { margin-top: 12px; }
.token ol { margin: 0 0 10px; padding-left: 18px; color: var(--fg-2); }
.code-row { display: flex; align-items: center; gap: 8px; margin: 6px 0 8px; }
.code { padding: 6px 12px; border-radius: 6px; background: var(--surface-1); border: 1px solid var(--line-3); font: 700 20px var(--mono); letter-spacing: 0.12em; }
.spacer { flex: 1; }
.field { margin-bottom: 12px; }
.field label { display: block; margin-bottom: 6px; color: var(--fg-3); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.hint { margin-top: 6px; color: var(--fg-4); font-size: 12px; line-height: 1.45; }
a { color: var(--fg-2); }
.access { padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-2); font-size: 13px; line-height: 1.5; }
.access p { margin: 0 0 8px; }
.access ol { margin: 0 0 12px; padding-left: 18px; color: var(--fg-2); }
.linked { display: grid; gap: 6px; font-size: 13px; }
.linked > div:first-child { display: flex; align-items: center; gap: 6px; }
.check { display: flex; align-items: center; gap: 8px; margin-top: 4px; color: var(--fg-2); }
.err { display: flex; gap: 8px; align-items: flex-start; margin-top: 6px; padding: 10px 12px; border-left: 3px solid var(--fg); background: var(--surface-1); font-size: 13px; }
.dot-wait { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; background: var(--fg-3); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
</style>
