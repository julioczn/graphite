// Graphite website: language switch (en/pt/es) and download links that point
// straight at the latest GitHub release's files. Works without JS too: the
// HTML is in English and every download link falls back to the releases page.
(function () {
  'use strict'

  var REPO = 'julioczn/graphite'

  var T = {
    pt: {
      'nav.features': 'Recursos',
      'nav.ai': 'AI e agentes',
      'nav.download': 'Download',
      'nav.language': 'Idioma',
      'hero.eyebrow': 'Gratuito e open source',
      'hero.title': 'O cliente SQL que sabe a hora de pedir permissão.',
      'hero.lead': 'Um cliente desktop rápido para SQLite, PostgreSQL e MySQL/MariaDB. Use a sua própria AI: um assistente embutido e um servidor MCP para Claude Code, Cursor e companhia — leituras rodam sozinhas, toda escrita espera a sua aprovação.',
      'hero.download': 'Download',
      'hero.other': 'Todas as plataformas',
      'hero.source': 'Ver o código',
      'hero.fine': 'macOS (Apple Silicon e Intel) · Linux (.deb, AppImage) · English, Português, Español',
      'features.title': 'Tudo o que você usa no dia a dia',
      'features.sub': 'Feito para ser rápido no teclado e cuidadoso com os seus dados.',
      'f1.t': 'Três bancos, um app',
      'f1.d': 'SQLite, PostgreSQL e MySQL/MariaDB com conexões salvas, senhas cifradas pelo chaveiro do sistema e um banco demo para testar.',
      'f2.t': 'Um editor SQL de verdade',
      'f2.d': 'Autocomplete de tabelas e colunas, execute tudo ou só a instrução sob o cursor, vários resultados por execução e snippets como <code>sel</code>, <code>ij</code> ou <code>ups</code>.',
      'f3.t': 'Edite os dados ali mesmo',
      'f3.d': 'Duplo clique para editar, defina NULL, exclua linhas e aplique tudo numa transação. Funciona também em resultados de consulta, quando a chave primária está lá.',
      'f4.t': 'Gere SQL a partir das tabelas',
      'f4.d': 'Botão direito numa tabela para SELECT com JOINs que seguem as chaves estrangeiras, INSERT, UPDATE ou DELETE — prontos para preencher.',
      'f5.t': 'Diagramas ER',
      'f5.d': 'Layout automático, relações inferidas quando o banco não tem FKs, busca, modo só chaves e exportação SVG e PNG.',
      'f6.t': 'Backup, restore, exportação',
      'f6.d': 'Backups .sql e .sql.gz sem pg_dump nem mysqldump, restore em streaming e exportação para CSV, JSON ou INSERTs sem limite de linhas.',
      'f7.t': 'Transações do seu jeito',
      'f7.d': 'Auto-commit ou modo manual por conexão, com commit e rollback. No PostgreSQL cada instrução ganha um savepoint, então um erro não derruba a transação.',
      'f8.t': 'No seu idioma',
      'f8.d': 'English, Português e Español. Segue o sistema e troca na hora, sem reiniciar.',
      'ai.eyebrow': 'AI do seu jeito',
      'ai.title': 'Conecte a sua própria AI. A palavra final é sua.',
      'ai.sub': 'Use o assistente embutido com a API da Anthropic ou qualquer provedor compatível com OpenAI — inclusive modelos locais com Ollama ou LM Studio — ou deixe Claude Code, Cursor, VS Code e Claude Desktop usarem as suas conexões via MCP.',
      'ai.c1.t': 'Leitura é somente leitura, de verdade.',
      'ai.c1.d': 'Quem garante é o próprio banco, com timeout e limite de linhas. Escritas disfarçadas de leitura falham.',
      'ai.c2.t': 'Toda escrita precisa da sua aprovação.',
      'ai.c2.d': 'Você vê quem pediu, onde e cada instrução. Scripts aprovados rodam numa transação.',
      'ai.c3.t': 'As suas chaves continuam suas.',
      'ai.c3.d': 'Cifradas no seu computador, uma por provedor, nunca mostradas de novo nem enviadas a outro lugar.',
      'ai.c4.t': 'Servidor MCP só local.',
      'ai.c4.d': 'Escuta em 127.0.0.1 com token e recusa requisições de navegador. Toda chamada fica registrada.',
      'mcp.title': 'Conecte um agente com uma linha',
      'mcp.d': 'Ligue o servidor MCP em AI e agentes → Agentes externos e copie o comando do seu cliente. O Graphite mostra a configuração exata com o seu token.',
      'cap.er': 'Diagrama ER com layout automático e exportação SVG/PNG.',
      'cap.mcp': 'Configuração pronta para Claude Code, Cursor, VS Code e Claude Desktop.',
      'dl.title': 'Download',
      'dl.sub': 'Gratuito, sem conta, sem telemetria.',
      'dl.mac': 'Apple Silicon (M1 ou mais novo) ou Intel.',
      'dl.gk.t': '“Não é possível abrir o Graphite”?',
      'dl.gk.d': 'O app ainda não é notarizado pela Apple. Abra Ajustes do Sistema → Privacidade e Segurança e clique em “Abrir Mesmo Assim”, ou rode:',
      'dl.linux': 'x64. O .deb cria o atalho no menu e o comando graphite.',
      'dl.src.t': 'A partir do código',
      'dl.src.d': 'Node.js 22+. Funciona no macOS e no Linux.',
      'foot.license': 'licença MIT',
      'foot.releases': 'Versões',
      'foot.changelog': 'Changelog',
      'foot.issues': 'Reportar um problema',
      'alt.query': 'Graphite executando uma consulta SQL com JOINs e mostrando a grade de resultados',
      'alt.approval': 'Janela de aprovação: um agente MCP pede para executar um UPDATE e o Graphite espera o usuário',
      'alt.er': 'Diagrama ER do banco demo',
      'alt.mcp': 'Configuração do servidor MCP com a configuração do cliente pronta para copiar',
      'dl.for': 'Download para {os}',
      'dl.version': 'Versão atual: {v}.',
    },
    es: {
      'nav.features': 'Funciones',
      'nav.ai': 'IA y agentes',
      'nav.download': 'Descargar',
      'nav.language': 'Idioma',
      'hero.eyebrow': 'Gratis y de código abierto',
      'hero.title': 'El cliente SQL que sabe cuándo pedir permiso.',
      'hero.lead': 'Un cliente de escritorio rápido para SQLite, PostgreSQL y MySQL/MariaDB. Usa tu propia IA: un asistente integrado y un servidor MCP para Claude Code, Cursor y compañía — las lecturas se ejecutan solas, cada escritura espera tu aprobación.',
      'hero.download': 'Descargar',
      'hero.other': 'Todas las plataformas',
      'hero.source': 'Ver el código',
      'hero.fine': 'macOS (Apple Silicon e Intel) · Linux (.deb, AppImage) · English, Português, Español',
      'features.title': 'Todo lo que usas a diario',
      'features.sub': 'Hecho para ser rápido con el teclado y cuidadoso con tus datos.',
      'f1.t': 'Tres bases de datos, una app',
      'f1.d': 'SQLite, PostgreSQL y MySQL/MariaDB con conexiones guardadas, contraseñas cifradas por el llavero del sistema y una base de datos demo para probar.',
      'f2.t': 'Un editor SQL de verdad',
      'f2.d': 'Autocompletado de tablas y columnas, ejecuta todo o solo la instrucción bajo el cursor, varios resultados por ejecución y snippets como <code>sel</code>, <code>ij</code> o <code>ups</code>.',
      'f3.t': 'Edita los datos ahí mismo',
      'f3.d': 'Doble clic para editar, establece NULL, elimina filas y aplica todo en una transacción. También funciona en resultados de consultas, cuando la clave primaria está presente.',
      'f4.t': 'Genera SQL desde las tablas',
      'f4.d': 'Clic derecho en una tabla para SELECT con JOINs que siguen las claves foráneas, INSERT, UPDATE o DELETE — listos para completar.',
      'f5.t': 'Diagramas ER',
      'f5.d': 'Diseño automático, relaciones inferidas cuando la base de datos no tiene claves foráneas, búsqueda, vista solo de claves y exportación SVG y PNG.',
      'f6.t': 'Copias de seguridad, restauración, exportación',
      'f6.d': 'Copias .sql y .sql.gz sin pg_dump ni mysqldump, restauración en streaming y exportación a CSV, JSON o INSERTs sin límite de filas.',
      'f7.t': 'Transacciones a tu manera',
      'f7.d': 'Auto-commit o modo manual por conexión, con commit y rollback. En PostgreSQL cada instrucción tiene un savepoint, así un error no hunde la transacción.',
      'f8.t': 'En tu idioma',
      'f8.d': 'English, Português y Español. Sigue al sistema y cambia al instante, sin reiniciar.',
      'ai.eyebrow': 'IA a tu manera',
      'ai.title': 'Conecta tu propia IA. La última palabra es tuya.',
      'ai.sub': 'Usa el asistente integrado con la API de Anthropic o cualquier proveedor compatible con OpenAI — incluidos modelos locales con Ollama o LM Studio — o deja que Claude Code, Cursor, VS Code y Claude Desktop usen tus conexiones mediante MCP.',
      'ai.c1.t': 'Las lecturas son de solo lectura, de verdad.',
      'ai.c1.d': 'Lo garantiza la propia base de datos, con tiempo límite y límite de filas. Las escrituras disfrazadas de lectura fallan.',
      'ai.c2.t': 'Cada escritura necesita tu aprobación.',
      'ai.c2.d': 'Ves quién lo pidió, dónde y cada instrucción. Los scripts aprobados se ejecutan en una transacción.',
      'ai.c3.t': 'Tus claves siguen siendo tuyas.',
      'ai.c3.d': 'Cifradas en tu equipo, una por proveedor, nunca se vuelven a mostrar ni se envían a otro lugar.',
      'ai.c4.t': 'Servidor MCP solo local.',
      'ai.c4.d': 'Escucha en 127.0.0.1 con un token y rechaza solicitudes del navegador. Cada llamada queda registrada.',
      'mcp.title': 'Conecta un agente con una línea',
      'mcp.d': 'Activa el servidor MCP en IA y agentes → Agentes externos y copia el comando de tu cliente. Graphite muestra la configuración exacta con tu token.',
      'cap.er': 'Diagrama ER con diseño automático y exportación SVG/PNG.',
      'cap.mcp': 'Configuración lista para Claude Code, Cursor, VS Code y Claude Desktop.',
      'dl.title': 'Descargar',
      'dl.sub': 'Gratis, sin cuenta, sin telemetría.',
      'dl.mac': 'Apple Silicon (M1 o más reciente) o Intel.',
      'dl.gk.t': '¿“No se puede abrir Graphite”?',
      'dl.gk.d': 'La app aún no está notarizada por Apple. Abre Configuración del Sistema → Privacidad y seguridad y haz clic en “Abrir de todos modos”, o ejecuta:',
      'dl.linux': 'x64. El .deb crea la entrada del menú y el comando graphite.',
      'dl.src.t': 'Desde el código',
      'dl.src.d': 'Node.js 22+. Funciona en macOS y Linux.',
      'foot.license': 'licencia MIT',
      'foot.releases': 'Versiones',
      'foot.changelog': 'Changelog',
      'foot.issues': 'Reportar un problema',
      'alt.query': 'Graphite ejecutando una consulta SQL con JOINs y mostrando la tabla de resultados',
      'alt.approval': 'Diálogo de aprobación: un agente MCP pide ejecutar un UPDATE y Graphite espera al usuario',
      'alt.er': 'Diagrama ER de la base de datos demo',
      'alt.mcp': 'Configuración del servidor MCP con la configuración del cliente lista para copiar',
      'dl.for': 'Descargar para {os}',
      'dl.version': 'Versión actual: {v}.',
    },
  }
  var EN_EXTRA = { 'dl.for': 'Download for {os}', 'dl.version': 'Current version: {v}.' }

  // English is the HTML itself; remember it so switching back works.
  var original = {}
  document.querySelectorAll('[data-i18n]').forEach(function (el) { original[el.dataset.i18n] = el.innerHTML })
  document.querySelectorAll('[data-i18n-alt]').forEach(function (el) { original[el.dataset.i18nAlt] = el.alt })

  var lang = 'en'
  var release = null

  function tr(key, params) {
    var s = (T[lang] && T[lang][key]) || EN_EXTRA[key] || original[key] || key
    if (params) s = s.replace(/\{(\w+)\}/g, function (m, k) { return k in params ? params[k] : m })
    return s
  }

  function apply(next) {
    lang = T[next] ? next : 'en'
    document.documentElement.lang = { en: 'en', pt: 'pt-BR', es: 'es' }[lang]
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      // Only our own static strings are inserted (some contain <code>).
      el.innerHTML = lang === 'en' ? original[el.dataset.i18n] : tr(el.dataset.i18n)
    })
    document.querySelectorAll('[data-i18n-alt]').forEach(function (el) {
      el.alt = lang === 'en' ? original[el.dataset.i18nAlt] : tr(el.dataset.i18nAlt)
    })
    document.getElementById('lang').value = lang
    renderDownloads()
  }

  // --- downloads --------------------------------------------------------------
  function detectOs() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase()
    var ua = navigator.userAgent.toLowerCase()
    if (p.indexOf('mac') >= 0 || ua.indexOf('mac os') >= 0) return 'mac'
    if (p.indexOf('linux') >= 0 || ua.indexOf('linux') >= 0) return ua.indexOf('android') >= 0 ? null : 'linux'
    return null
  }

  var MATCH = {
    'mac-arm64': /-arm64\.dmg$/,
    'mac-x64': /-x64\.dmg$/,
    deb: /_amd64\.deb$/,
    appimage: /\.AppImage$/,
  }

  function renderDownloads() {
    var os = detectOs()
    var primary = document.querySelector('[data-dl="primary"]')
    var label = primary.querySelector('[data-dl-label]')
    if (os) {
      primary.dataset.target = os === 'mac' ? 'mac-arm64' : 'deb'
      label.textContent = tr('dl.for', { os: os === 'mac' ? 'macOS' : 'Linux' })
    } else {
      primary.dataset.target = ''
      primary.href = '#download'
      label.textContent = tr('hero.download')
    }
    if (!release) return
    document.querySelectorAll('[data-dl]').forEach(function (a) {
      var key = a.dataset.dl === 'primary' ? a.dataset.target : a.dataset.dl
      var asset = key && release.assets.find(function (x) { return MATCH[key].test(x.name) })
      if (asset) a.href = asset.browser_download_url
    })
    var version = release.tag_name.replace(/^v/, '')
    document.querySelectorAll('[data-version]').forEach(function (el) { el.textContent = 'v' + version })
    document.querySelectorAll('[data-version-line]').forEach(function (el) { el.textContent = tr('dl.version', { v: version }) })
  }

  function loadRelease() {
    if (!window.fetch) return
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (data) {
        if (data && Array.isArray(data.assets)) {
          release = data
          renderDownloads()
        }
      })
      .catch(function () {})
  }

  // --- language: saved choice, else the browser's -----------------------------
  function storedLang() {
    try { return localStorage.getItem('graphite-site-lang') } catch (e) { return null }
  }
  function browserLang() {
    var langs = navigator.languages || [navigator.language || 'en']
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i]).toLowerCase()
      if (l.indexOf('pt') === 0) return 'pt'
      if (l.indexOf('es') === 0) return 'es'
      if (l.indexOf('en') === 0) return 'en'
    }
    return 'en'
  }

  document.getElementById('lang').addEventListener('change', function (e) {
    try { localStorage.setItem('graphite-site-lang', e.target.value) } catch (err) {}
    apply(e.target.value)
  })

  apply(storedLang() || browserLang())
  loadRelease()
})()
