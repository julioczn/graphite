// Built-in assistant (main process): a chat that can inspect the database and
// run SQL through the AI hub's tools, with the user's own provider and key.
//  - Anthropic: official SDK, streaming manual tool loop (writes pause the
//    loop until the user approves them in the window).
//  - OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter, …):
//    /chat/completions with streaming and function tools.
// The API key never reaches the renderer: it is decrypted here per request.
const Anthropic = require('@anthropic-ai/sdk').default
const { t, getLocale, LOCALES } = require('../../shared/i18n.mjs')

const MAX_TURNS = 24
// Models that take output_config.effort (used when the Models API can't say)
// and the server-side refusal fallback.
const EFFORT_MODELS = /^claude-((opus|sonnet|haiku|fable|mythos)-5|opus-4-[5-8]|sonnet-4-6)/
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5'])

// Shown when the Models API can't be reached (no key saved yet, offline).
// With a key, the dropdown lists every model the account can use, live.
const KNOWN_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ['claude-fable-5-2', 'Claude Fable 5.2'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['claude-fable-5', 'Claude Fable 5'],
  ['claude-opus-5', 'Claude Opus 5'],
  ['claude-sonnet-5', 'Claude Sonnet 5'],
  ['claude-opus-4-8', 'Claude Opus 4.8'],
  ['claude-opus-4-7', 'Claude Opus 4.7'],
  ['claude-opus-4-6', 'Claude Opus 4.6'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
].map(([id, name]) => ({ id, name }))

const SYSTEM = `You are the SQL assistant of Graphite, a desktop database client (PostgreSQL, MySQL/MariaDB and SQLite).
You help the user explore the database, write and fix queries, and explain results and execution plans.

Tools: list_connections, list_schemas, list_tables, describe_table, get_schema and run_query. They use Graphite's own connections.
- Before writing SQL about tables you haven't seen yet, check get_schema or describe_table. Don't make up table or column names.
- Write in the dialect of the connection in use.
- Use run_query for reads when that helps you answer (with LIMIT in exploratory queries). Reads run in read-only mode.
- Writes (INSERT, UPDATE, DELETE, DDL) only run if the user approves them in a Graphite dialog. Only run a write when the user asks for a change; if they reject it, don't try again: show the SQL and ask.
- When you show SQL to the user, use \`\`\`sql blocks. Graphite adds buttons to them to insert into the editor or open in a new tab.
- The user's message may start with a [Graphite context] block (interface language, connection, editor SQL, error). Use it, but don't repeat it.
- Reply in the language of the user's message; when that's unclear (e.g. the message is only SQL), use the interface language from the context block. Be direct and brief. Summarize results instead of pasting long tables.`

class Assistant {
  constructor(hub) {
    this.hub = hub
    this.convs = new Map() // id -> { provider, messages, abort }
    this.effort = new Map() // Claude model id -> supports output_config.effort (from the Models API)
  }

  // Models for the settings dropdown. Anthropic: the Models API with the key
  // saved for Anthropic (or the one being typed), newest first, falling back
  // to KNOWN_MODELS. OpenAI-compatible: GET <baseUrl>/models.
  async models({ provider, baseUrl = '', apiKey = '' } = {}) {
    const key = apiKey || this.hub.apiKey(provider, baseUrl)
    if (provider === 'anthropic') {
      if (!key) return { source: 'builtin', models: KNOWN_MODELS }
      try {
        const client = new Anthropic({ apiKey: key, timeout: 15000, maxRetries: 1 })
        const models = []
        for await (const m of client.models.list({ limit: 100 })) {
          models.push({ id: m.id, name: m.display_name || m.id, created: m.created_at })
          this.rememberEffort(m)
        }
        return models.length ? { source: 'api', models } : { source: 'builtin', models: KNOWN_MODELS }
      } catch (e) {
        return { source: 'builtin', models: KNOWN_MODELS, error: explain(e, { provider }) }
      }
    }
    if (!/^https?:\/\//i.test(baseUrl)) return { source: 'none', models: [] }
    try {
      const res = await fetch(joinUrl(baseUrl, 'models'), { headers: authHeaders({ apiKey: key }), signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data = (await res.json()).data || []
      const models = data.map((m) => ({ id: String(m.id), name: String(m.name || m.id) })).sort((a, b) => a.id.localeCompare(b.id))
      return { source: 'api', models }
    } catch (e) {
      return { source: 'none', models: [], error: t('Não consegui listar os modelos de {url}: {message}', { url: baseUrl, message: e.message }) }
    }
  }

  rememberEffort(m) {
    const sup = m.capabilities?.effort?.supported
    if (typeof sup === 'boolean') this.effort.set(m.id, sup)
  }

  // Whether to send output_config.effort: what the Models API says about the
  // model (asked once per model and app run), else the built-in rule.
  async supportsEffort(cfg) {
    if (!this.effort.has(cfg.model)) {
      try {
        this.rememberEffort(await new Anthropic({ apiKey: cfg.apiKey, timeout: 10000, maxRetries: 0 }).models.retrieve(cfg.model))
      } catch {}
    }
    return this.effort.get(cfg.model) ?? EFFORT_MODELS.test(cfg.model)
  }

  reset(id) {
    this.stop(id)
    this.convs.delete(id)
  }

  stop(id) {
    this.convs.get(id)?.abort?.abort()
  }

  config() {
    const a = this.hub.data.assistant
    const apiKey = this.hub.apiKey()
    if (a.provider === 'anthropic' && !apiKey) throw new Error(t('Configure a chave de API da Anthropic em AI → Configurar'))
    if (a.provider === 'openai' && !a.baseUrl) throw new Error(t('Configure a URL do provedor em AI → Configurar'))
    if (!a.model) throw new Error(t('Escolha um modelo em AI → Configurar'))
    return { provider: a.provider, model: a.model, baseUrl: a.baseUrl, apiKey }
  }

  // One user message → streamed events through emit() until the turn ends.
  async send(id, { text, context }, emit) {
    const cfg = this.config()
    let conv = this.convs.get(id)
    // Switching provider mid-conversation would mix message formats.
    if (conv && conv.provider !== cfg.provider) conv = null
    if (!conv) {
      conv = { provider: cfg.provider, messages: [] }
      this.convs.set(id, conv)
    }
    if (conv.abort) throw new Error(t('Aguarde a resposta atual (ou pare-a)'))
    conv.abort = new AbortController()
    const content = withContext(text, context)
    const tool = (name, input) => this.hub.callTool(name, input, { source: t('Assistente') })
    try {
      emit({ type: 'start' })
      if (cfg.provider === 'anthropic') cfg.effort = await this.supportsEffort(cfg)
      if (cfg.provider === 'anthropic') await runAnthropic(conv, cfg, content, tool, this.hub.tools, emit)
      else await runOpenAI(conv, cfg, content, tool, this.hub.tools, emit)
      emit({ type: 'done' })
    } catch (e) {
      if (conv.abort.signal.aborted) emit({ type: 'done', stopped: true })
      else emit({ type: 'error', message: explain(e, cfg) })
    } finally {
      conv.abort = null
    }
  }

  // Cheap credentials / model check for the settings dialog (no tokens spent).
  async test() {
    const cfg = this.config()
    if (cfg.provider === 'anthropic') {
      try {
        const client = new Anthropic({ apiKey: cfg.apiKey })
        const m = await client.models.retrieve(cfg.model)
        this.rememberEffort(m)
        return `OK — ${m.display_name || m.id}`
      } catch (e) {
        throw new Error(explain(e, cfg))
      }
    }
    const res = await fetch(joinUrl(cfg.baseUrl, 'models'), { headers: authHeaders(cfg) })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`)
    const ids = ((await res.json()).data || []).map((m) => m.id)
    if (ids.length && !ids.includes(cfg.model)) return t('Conectado, mas o modelo "{model}" não está na lista do provedor ({models})', { model: cfg.model, models: ids.slice(0, 6).join(', ') + (ids.length > 6 ? '…' : '') })
    return `OK — ${cfg.model}`
  }
}

function withContext(text, ctx = {}) {
  const locale = getLocale()
  const lines = [`Interface language: ${locale} (${LOCALES.find((l) => l.id === locale)?.name || locale})`]
  if (ctx.connection) lines.push(`Connection: ${ctx.connection}`)
  if (ctx.sql?.trim()) lines.push(`SQL in the editor:\n\`\`\`sql\n${ctx.sql.trim().slice(0, 8000)}\n\`\`\``)
  if (ctx.error) lines.push(`Error when running it:\n${String(ctx.error).slice(0, 2000)}`)
  return `[Graphite context]\n${lines.join('\n')}\n[/Context]\n\n${text}`
}

// --- Anthropic ------------------------------------------------------------------

async function runAnthropic(conv, cfg, content, callTool, toolDefs, emit) {
  const client = new Anthropic({ apiKey: cfg.apiKey })
  const tools = toolDefs.map((d) => ({ name: d.name, description: d.description, input_schema: d.schema, eager_input_streaming: true }))
  const signal = conv.abort.signal
  conv.messages.push({ role: 'user', content })
  let jsonRetries = 0

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const params = {
      model: cfg.model,
      max_tokens: 64000,
      system: SYSTEM,
      tools,
      messages: conv.messages,
      cache_control: { type: 'ephemeral' },
    }
    if (cfg.effort) params.output_config = { effort: 'medium' }
    if (FALLBACK_MODELS.has(cfg.model)) {
      params.betas = ['server-side-fallback-2026-07-01']
      params.fallbacks = 'default'
    }
    emit({ type: 'status', text: t('pensando…') })
    const stream = client.beta.messages.stream(params, { signal })
    stream.on('text', (delta) => emit({ type: 'text', delta }))

    let message
    try {
      message = await stream.finalMessage()
      jsonRetries = 0
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors and
      // aborts propagate.
      if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err
      emit({ type: 'status', text: t('repetindo a chamada (entrada de ferramenta inválida)…') })
      continue
    }

    if (message.stop_reason === 'refusal') {
      conv.messages.push({ role: 'assistant', content: message.content })
      emit({ type: 'text', delta: '\n\n_' + t('(O modelo recusou continuar esta resposta.)') + '_' })
      return
    }
    if (message.stop_reason === 'pause_turn') {
      conv.messages.push({ role: 'assistant', content: message.content })
      continue
    }
    const uses = message.content.filter((b) => b.type === 'tool_use')
    // A tool input cut off at max_tokens can parse as a valid partial object: don't run it.
    if (uses.length && message.stop_reason === 'max_tokens') throw new Error(t('A resposta foi cortada (max_tokens) no meio de uma chamada de ferramenta'))
    conv.messages.push({ role: 'assistant', content: message.content })
    if (!uses.length) return

    const results = []
    for (const use of uses) {
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Canceled by the user' })
        continue
      }
      emit({ type: 'tool', id: use.id, name: use.name, input: use.input })
      const r = await callTool(use.name, use.input)
      emit({ type: 'tool_result', id: use.id, ok: !r.isError, status: r.status, text: r.text.slice(0, 400) })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: r.text, ...(r.isError && { is_error: true }) })
    }
    conv.messages.push({ role: 'user', content: results })
    if (signal.aborted) throw new Error('aborted')
  }
  throw new Error(t('Parei depois de {max} rodadas de ferramentas', { max: MAX_TURNS }))
}

// --- OpenAI-compatible ------------------------------------------------------------

function joinUrl(base, p) {
  return base.replace(/\/+$/, '') + '/' + p
}

function authHeaders(cfg) {
  return cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}
}

// Server-sent events from a fetch body: yields each `data:` payload.
async function* sse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim()
}

async function runOpenAI(conv, cfg, content, callTool, toolDefs, emit) {
  const tools = toolDefs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.schema } }))
  const signal = conv.abort.signal
  conv.messages.push({ role: 'user', content })

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    emit({ type: 'status', text: t('pensando…') })
    const res = await fetch(joinUrl(cfg.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify({ model: cfg.model, stream: true, tools, messages: [{ role: 'system', content: SYSTEM }, ...conv.messages] }),
      signal,
    })
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`), { status: res.status })

    let text = ''
    let finish = null
    const calls = [] // index -> { id, name, args }
    for await (const data of sse(res.body)) {
      if (data === '[DONE]') break
      let chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error))
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const d = choice.delta || {}
      if (d.content) {
        text += d.content
        emit({ type: 'text', delta: d.content })
      }
      for (const tc of d.tool_calls || []) {
        const c = (calls[tc.index ?? 0] ||= { id: '', name: '', args: '' })
        if (tc.id) c.id = tc.id
        if (tc.function?.name) c.name += tc.function.name
        if (tc.function?.arguments) c.args += tc.function.arguments
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }

    const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${turn}_${i}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
    conv.messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length && { tool_calls: toolCalls }) })
    if (!toolCalls.length) return
    if (finish === 'length') throw new Error(t('A resposta foi cortada no meio de uma chamada de ferramenta'))

    for (const tc of toolCalls) {
      let input
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        conv.messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Error: the arguments are not valid JSON' })
        continue
      }
      if (signal.aborted) {
        conv.messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Canceled by the user' })
        continue
      }
      emit({ type: 'tool', id: tc.id, name: tc.function.name, input })
      const r = await callTool(tc.function.name, input)
      emit({ type: 'tool_result', id: tc.id, ok: !r.isError, status: r.status, text: r.text.slice(0, 400) })
      conv.messages.push({ role: 'tool', tool_call_id: tc.id, content: r.text })
    }
    if (signal.aborted) throw new Error('aborted')
  }
  throw new Error(t('Parei depois de {max} rodadas de ferramentas', { max: MAX_TURNS }))
}

// Human message for provider errors (typed SDK errors, most specific first).
function explain(e, cfg) {
  if (e instanceof Anthropic.AuthenticationError) return t('Chave de API inválida ou revogada')
  if (e instanceof Anthropic.PermissionDeniedError) return t('Esta chave não tem acesso a esse modelo ou recurso')
  if (e instanceof Anthropic.NotFoundError) return t('Modelo "{model}" não encontrado', { model: cfg.model })
  if (e instanceof Anthropic.RateLimitError) return t('Limite de uso da API atingido; tente de novo em instantes')
  if (e instanceof Anthropic.BadRequestError) return t('Requisição recusada pela API: {message}', { message: e.message })
  if (e instanceof Anthropic.APIConnectionError) return t('Sem conexão com a API da Anthropic')
  if (e instanceof Anthropic.APIError) return t('Erro da API ({status}): {message}', { status: String(e.status ?? '?'), message: e.message })
  if (e.status === 401) return t('Chave de API inválida (401)')
  if (e.cause?.code === 'ECONNREFUSED') return t('Não consegui conectar em {url} (o servidor está rodando?)', { url: cfg.baseUrl })
  return e.message
}

module.exports = { Assistant }
