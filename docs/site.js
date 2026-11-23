// Graphite website: language switch (en/pt/es) and download links that point
// straight at the latest GitHub release's files. Works without JS too: the
// HTML is in English and every download link falls back to the releases page.
(function () {
  'use strict'

  document.documentElement.classList.add('js')
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches

  var REPO = 'julioczn/graphite'

  var T = {
    pt: {
      'nav.features': 'Recursos',
      'nav.dbs': 'Bancos',
      'db.title': 'Seus bancos, todos no mesmo lugar',
      'db.sub': 'Cada um com a sua linguagem, o seu catálogo e as suas manias — testados contra servidores reais, menos os marcados como beta.',
      'db.rel': 'Relacionais',
      'db.ana': 'Analíticos',
      'db.cloud': 'Data warehouses na nuvem',
      'db.nosql': 'NoSQL',
      'db.nosql.d': 'Todos editáveis na grade, com as colunas de chave travadas. As consultas usam a linguagem de cada banco.',
      'nav.ai': 'AI e agentes',
      'nav.download': 'Download',
      'nav.language': 'Idioma',
      'hero.title': 'Todos os bancos.<br><span class="grad">Um app rápido.</span>',
      'hero.lead': 'SQL, NoSQL e data warehouses na nuvem, lado a lado num app desktop gratuito. Traga a sua própria AI — um assistente embutido e um servidor MCP para Claude Code, Cursor e companhia — e nada é gravado sem o seu OK.',
      'hero.download': 'Download',
      'hero.other': 'Todas as plataformas',
      'hero.fine': 'macOS (Apple Silicon e Intel) · Linux (.deb, AppImage) · Grátis, sem conta, sem telemetria',
      'features.title': 'Tudo o que você usa no dia a dia',
      'features.sub': 'Feito para ser rápido no teclado e cuidadoso com os seus dados.',
      'f1.t': '24 bancos, um app',
      'f1.d': 'Relacionais, analíticos, data warehouses na nuvem e NoSQL, com conexões salvas, senhas cifradas pelo chaveiro do sistema e um banco demo para testar.',
      'f2.t': 'Um editor SQL de verdade',
      'f2.d': 'Autocomplete de tabelas e colunas, execute tudo ou só a instrução sob o cursor, vários resultados por execução e snippets como <code>sel</code>, <code>ij</code> ou <code>ups</code>.',
      'f3.t': 'Edite qualquer grade, SQL ou NoSQL',
      'f3.d': 'Duplo clique para editar, defina NULL, exclua linhas e aplique tudo de uma vez — tudo ou nada. Tabelas, resultados de consulta, MongoDB, Redis, Cassandra, DynamoDB e SurrealDB.',
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
      'f9.t': 'Conexões seguras',
      'f9.d': 'TLS que verifica o certificado do servidor por padrão, sua própria CA e certificados de cliente para TLS mútuo. Senhas e chaves ficam cifradas no seu computador.',
      'f10.t': 'Workspaces no seu próprio GitHub',
      'f10.d': 'Agrupe conexões, consultas salvas, snippets e abas abertas por projeto e sincronize por um repositório privado seu — arquivos legíveis, um commit por sincronização. As senhas nunca saem do seu computador.',
      'f11.t': 'Traga suas conexões',
      'f11.d': 'Importe do DBeaver, DataGrip, TablePlus, Beekeeper Studio, pgAdmin, Navicat, MySQL Workbench, HeidiSQL e mais 5. As senhas salvas vêm junto quando a ferramenta as guarda nos próprios arquivos.',
      'f12.t': 'Continua de onde você parou',
      'f12.d': 'As abas voltam quando você reconecta, até em outro computador. Os seus próprios snippets expandem no editor. E o app se atualiza sozinho, conferido com o SHA-256 do GitHub.',
      "cmp.yes": "Sim",
      "cmp.no": "Não",
      "cmp.r.price": "Preço",
      "cmp.free": "Grátis",
      "cmp.p.dbeaver": "Grátis · PRO a partir de US$ 113/ano",
      "cmp.p.datagrip": "Grátis para uso não comercial · US$ 109/ano",
      "cmp.p.tableplus": "Grátis com limites (2 abas) · a partir de US$ 99",
      "cmp.p.beekeeper": "Grátis · pago a partir de US$ 9/mês",
      "cmp.p.navicat": "Lite grátis · Premium US$ 749,99/ano",
      "cmp.p.dbgate": "Grátis · Premium US$ 120/ano",
      "cmp.r.oss": "Código aberto",
      "cmp.o.bk": "GPL-3.0 (Community)",
      "cmp.r.os": "Plataformas",
      "cmp.r.nosql": "MongoDB e Redis, grátis",
      "cmp.pro": "Só no PRO",
      "cmp.n.bk": "Redis; MongoDB pago",
      "cmp.r.wh": "Snowflake e BigQuery, grátis",
      "cmp.w.bk": "BigQuery; Snowflake pago",
      "cmp.w.nv": "Snowflake",
      "cmp.r.more": "DynamoDB, SurrealDB, Turso, grátis",
      "cmp.m.db": "Turso",
      "cmp.m.dg": "DynamoDB",
      "cmp.m.tp": "DynamoDB, Turso",
      "cmp.paid": "Pago",
      "cmp.r.ai": "AI embutida com a sua chave ou um modelo local, grátis",
      "cmp.a.db": "OpenAI ou Copilot; outros no PRO",
      "cmp.yes1": "✓ ¹",
      "cmp.a.pg": "✓ desligada por padrão",
      "cmp.r.mcp": "Servidor MCP para agentes (Claude Code, Cursor…)",
      "cmp.ro": "Só leitura",
      "cmp.r.sync": "Sincronizar conexões e consultas salvas",
      "cmp.s.g": "Seu repositório privado no GitHub, grátis",
      "cmp.s.db": "Git no Enterprise e no Ultimate",
      "cmp.s.dg": "Arquivos do projeto no seu VCS",
      "cmp.s.tp": "Conexões via iCloud ou Dropbox",
      "cmp.s.bk": "Workspaces na nuvem, pago",
      "cmp.s.nv": "Navicat Cloud",
      "cmp.s.dbg": "Nuvem, 5 conexões grátis",
      "cmp.r.import": "Importar conexões de outras ferramentas",
      "cmp.i.g": "13 ferramentas",
      "cmp.i.db": "6 ferramentas",
      "cmp.r.er": "Diagramas ER, grátis",
      "cmp.prem": "Só no Premium",
      "cmp.r.backup": "Backup e restauração",
      "cmp.b.g": "Embutido, sem precisar do pg_dump",
      "cmp.b.db": "Via pg_dump / mysqldump",
      "cmp.b.dg": "Via ferramentas externas",
      "cmp.b.dbg": "Em parte",
      "cmp.r.size": "Download para macOS (Apple Silicon)",
      "nav.compare": "Comparativo",
      "cmp.eyebrow": "Benchmark",
      "cmp.title": "Como o Graphite se compara",
      "cmp.sub": "As versões gratuitas dos clientes de banco mais usados, lado a lado — inclusive onde o Graphite fica para trás.",
      "cmp.feature": "Versão gratuita",
      "cmp.size.t": "Tamanho do download",
      "cmp.size.d": "macOS, Apple Silicon, última versão de cada um. Menor é melhor.",
      "cmp.note": "Conferido em 23 de novembro de 2026 no site, na página de preços, na documentação e nas versões de cada fornecedor. ✓ quer dizer incluído na versão gratuita; — quer dizer não oferecido, ou não encontrado na documentação do fornecedor. Preços em dólares, no plano pago mais barato. ¹ O TablePlus não diz se AI e MCP funcionam na versão gratuita.",
      "cmp.fix": "Algo desatualizado? Abra uma issue.",
      'ai.eyebrow': 'AI do seu jeito',
      'ai.title': 'Conecte a sua própria AI. A palavra final é sua.',
      'ai.sub': 'Use o assistente embutido com a API da Anthropic ou qualquer provedor compatível com OpenAI — inclusive modelos locais com Ollama ou LM Studio — ou deixe Claude Code, Cursor, VS Code e Claude Desktop usarem as suas conexões via MCP.',
      'ai.c1.t': 'Leitura é somente leitura, de verdade.',
      'ai.c1.d': 'Onde o banco consegue garantir (PostgreSQL, MySQL, Oracle, Trino…), as leituras rodam sem pedir, com timeout e limite de linhas, e escritas disfarçadas falham. Nos demais, toda consulta espera por você.',
      'ai.c2.t': 'Toda escrita precisa da sua aprovação.',
      'ai.c2.d': 'Você vê quem pediu, onde e cada instrução. Scripts aprovados rodam numa transação.',
      'ai.c3.t': 'As suas chaves continuam suas.',
      'ai.c3.d': 'Cifradas no seu computador, uma por provedor, nunca mostradas de novo nem enviadas a outro lugar.',
      'ai.c4.t': 'Servidor MCP só local.',
      'ai.c4.d': 'Escuta em 127.0.0.1 com token e recusa requisições de navegador. Toda chamada fica registrada.',
      'mcp.title': 'Conecte um agente com uma linha',
      'mcp.d': 'Ligue o servidor MCP em AI e agentes → Agentes externos e copie o comando do seu cliente. O Graphite mostra a configuração exata com o seu token.',
      'dl.title': 'Download',
      'dl.sub': 'Gratuito, sem conta, sem telemetria.',
      'dl.mac': 'Apple Silicon (M1 ou mais novo) ou Intel.',
      'dl.gk.t': '“Não é possível abrir o Graphite”?',
      'dl.gk.d': 'O app ainda não é notarizado pela Apple. Abra Ajustes do Sistema → Privacidade e Segurança e clique em “Abrir Mesmo Assim”, ou rode:',
      'dl.linux': 'x64. O .deb cria o atalho no menu e o comando graphite.',
      'dl.src.t': 'A partir do código',
      'dl.src.d': 'Node.js 22+. Funciona no macOS e no Linux.',
      'dl.upd.t': 'Instale uma vez e ele se mantém atualizado.',
      'dl.upd.d': 'O Graphite percebe quando sai uma versão nova, mostra o que mudou, baixa o pacote certo, confere com o SHA-256 do GitHub e reinicia já na versão nova. A partir da 0.9.0; dá para desligar a verificação.',
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
      'hero.changelog': 'Veja o que mudou em cada versão',
      'hero.verb': 'Consulte, edite e explore',
      'hero.verb.sr': 'PostgreSQL, MySQL, MongoDB, Redis, DynamoDB e mais 19 bancos',
      'hero.star': 'Estrela no GitHub',
      'st.db': 'bancos num só app',
      'st.nosql': 'bancos NoSQL, editáveis na grade',
      'st.ai': 'jeitos de usar AI: nuvem, local ou MCP',
      'st.tel': 'contas, anúncios ou telemetria',
      'show.query': 'Editor SQL',
      'show.table': 'Edição de dados',
      'show.er': 'Diagramas ER',
      'show.mcp': 'MCP para agentes',
      'marquee': 'Bancos suportados',
      'alt.table': 'Editando as linhas de uma tabela na grade',
      'final.t': 'Chega de pular entre clientes de banco.',
      'final.d': 'Postgres de manhã, Mongo depois do almoço, aquela tabela do DynamoDB às 2 da manhã — um app, um atalho, um lugar para todas as suas conexões.',
    },
    es: {
      'nav.features': 'Funciones',
      'nav.dbs': 'Bases de datos',
      'db.title': 'Tus bases de datos, todas en un mismo lugar',
      'db.sub': 'Cada una con su lenguaje, su catálogo y sus manías — probadas con servidores reales, salvo las marcadas como beta.',
      'db.rel': 'Relacionales',
      'db.ana': 'Analíticas',
      'db.cloud': 'Data warehouses en la nube',
      'db.nosql': 'NoSQL',
      'db.nosql.d': 'Todas editables en la tabla, con las columnas clave bloqueadas. Las consultas usan el lenguaje de cada base.',
      'nav.ai': 'IA y agentes',
      'nav.download': 'Descargar',
      'nav.language': 'Idioma',
      'hero.title': 'Todas las bases.<br><span class="grad">Una app rápida.</span>',
      'hero.lead': 'SQL, NoSQL y data warehouses en la nube, lado a lado en una app de escritorio gratuita. Trae tu propia IA — un asistente integrado y un servidor MCP para Claude Code, Cursor y compañía — y nada se escribe sin tu OK.',
      'hero.download': 'Descargar',
      'hero.other': 'Todas las plataformas',
      'hero.fine': 'macOS (Apple Silicon e Intel) · Linux (.deb, AppImage) · Gratis, sin cuenta, sin telemetría',
      'features.title': 'Todo lo que usas a diario',
      'features.sub': 'Hecho para ser rápido con el teclado y cuidadoso con tus datos.',
      'f1.t': '24 bases de datos, una app',
      'f1.d': 'Relacionales, analíticas, data warehouses en la nube y NoSQL, con conexiones guardadas, contraseñas cifradas por el llavero del sistema y una base de datos demo para probar.',
      'f2.t': 'Un editor SQL de verdad',
      'f2.d': 'Autocompletado de tablas y columnas, ejecuta todo o solo la instrucción bajo el cursor, varios resultados por ejecución y snippets como <code>sel</code>, <code>ij</code> o <code>ups</code>.',
      'f3.t': 'Edita cualquier tabla, SQL o NoSQL',
      'f3.d': 'Doble clic para editar, establece NULL, elimina filas y aplica todo de una vez — todo o nada. Tablas, resultados de consultas, MongoDB, Redis, Cassandra, DynamoDB y SurrealDB.',
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
      'f9.t': 'Conexiones seguras',
      'f9.d': 'TLS que verifica el certificado del servidor por defecto, tu propia CA y certificados de cliente para TLS mutuo. Las contraseñas y claves quedan cifradas en tu equipo.',
      'f10.t': 'Workspaces en tu propio GitHub',
      'f10.d': 'Agrupa conexiones, consultas guardadas, snippets y pestañas abiertas por proyecto y sincronízalos con un repositorio privado tuyo — archivos legibles, un commit por sincronización. Las contraseñas nunca salen de tu equipo.',
      'f11.t': 'Trae tus conexiones',
      'f11.d': 'Importa desde DBeaver, DataGrip, TablePlus, Beekeeper Studio, pgAdmin, Navicat, MySQL Workbench, HeidiSQL y 5 más. Las contraseñas guardadas vienen incluidas cuando la herramienta las guarda en sus propios archivos.',
      'f12.t': 'Sigue donde lo dejaste',
      'f12.d': 'Las pestañas vuelven al reconectar, incluso en otro equipo. Tus propios snippets se expanden en el editor. Y la app se actualiza sola, verificada con el SHA-256 de GitHub.',
      "cmp.yes": "Sí",
      "cmp.no": "No",
      "cmp.r.price": "Precio",
      "cmp.free": "Gratis",
      "cmp.p.dbeaver": "Gratis · PRO desde US$ 113/año",
      "cmp.p.datagrip": "Gratis para uso no comercial · US$ 109/año",
      "cmp.p.tableplus": "Gratis con límites (2 pestañas) · desde US$ 99",
      "cmp.p.beekeeper": "Gratis · pago desde US$ 9/mes",
      "cmp.p.navicat": "Lite gratis · Premium US$ 749,99/año",
      "cmp.p.dbgate": "Gratis · Premium US$ 120/año",
      "cmp.r.oss": "Código abierto",
      "cmp.o.bk": "GPL-3.0 (Community)",
      "cmp.r.os": "Plataformas",
      "cmp.r.nosql": "MongoDB y Redis, gratis",
      "cmp.pro": "Solo en PRO",
      "cmp.n.bk": "Redis; MongoDB de pago",
      "cmp.r.wh": "Snowflake y BigQuery, gratis",
      "cmp.w.bk": "BigQuery; Snowflake de pago",
      "cmp.w.nv": "Snowflake",
      "cmp.r.more": "DynamoDB, SurrealDB, Turso, gratis",
      "cmp.m.db": "Turso",
      "cmp.m.dg": "DynamoDB",
      "cmp.m.tp": "DynamoDB, Turso",
      "cmp.paid": "De pago",
      "cmp.r.ai": "IA integrada con tu clave o un modelo local, gratis",
      "cmp.a.db": "OpenAI o Copilot; otros en PRO",
      "cmp.yes1": "✓ ¹",
      "cmp.a.pg": "✓ desactivada por defecto",
      "cmp.r.mcp": "Servidor MCP para agentes (Claude Code, Cursor…)",
      "cmp.ro": "Solo lectura",
      "cmp.r.sync": "Sincronizar conexiones y consultas guardadas",
      "cmp.s.g": "Tu repositorio privado en GitHub, gratis",
      "cmp.s.db": "Git en Enterprise y Ultimate",
      "cmp.s.dg": "Archivos del proyecto en tu VCS",
      "cmp.s.tp": "Conexiones vía iCloud o Dropbox",
      "cmp.s.bk": "Workspaces en la nube, de pago",
      "cmp.s.nv": "Navicat Cloud",
      "cmp.s.dbg": "Nube, 5 conexiones gratis",
      "cmp.r.import": "Importar conexiones de otras herramientas",
      "cmp.i.g": "13 herramientas",
      "cmp.i.db": "6 herramientas",
      "cmp.r.er": "Diagramas ER, gratis",
      "cmp.prem": "Solo en Premium",
      "cmp.r.backup": "Copia de seguridad y restauración",
      "cmp.b.g": "Integrado, sin pg_dump",
      "cmp.b.db": "Vía pg_dump / mysqldump",
      "cmp.b.dg": "Vía herramientas externas",
      "cmp.b.dbg": "En parte",
      "cmp.r.size": "Descarga para macOS (Apple Silicon)",
      "nav.compare": "Comparativa",
      "cmp.eyebrow": "Benchmark",
      "cmp.title": "Cómo se compara Graphite",
      "cmp.sub": "Las versiones gratuitas de los clientes de bases de datos más usados, lado a lado — incluso donde Graphite se queda atrás.",
      "cmp.feature": "Versión gratuita",
      "cmp.size.t": "Tamaño de la descarga",
      "cmp.size.d": "macOS, Apple Silicon, última versión de cada uno. Menos es mejor.",
      "cmp.note": "Verificado el 23 de noviembre de 2026 en el sitio, la página de precios, la documentación y las versiones de cada proveedor. ✓ significa incluido en la versión gratuita; — significa no ofrecido, o no encontrado en la documentación del proveedor. Precios en dólares, plan de pago más barato. ¹ TablePlus no dice si la IA y MCP funcionan en su versión gratuita.",
      "cmp.fix": "¿Algo desactualizado? Abre un issue.",
      'ai.eyebrow': 'IA a tu manera',
      'ai.title': 'Conecta tu propia IA. La última palabra es tuya.',
      'ai.sub': 'Usa el asistente integrado con la API de Anthropic o cualquier proveedor compatible con OpenAI — incluidos modelos locales con Ollama o LM Studio — o deja que Claude Code, Cursor, VS Code y Claude Desktop usen tus conexiones mediante MCP.',
      'ai.c1.t': 'Las lecturas son de solo lectura, de verdad.',
      'ai.c1.d': 'Donde la base de datos puede garantizarlo (PostgreSQL, MySQL, Oracle, Trino…), las lecturas se ejecutan sin preguntar, con tiempo y filas limitados, y las escrituras disfrazadas fallan. En las demás, cada consulta te espera.',
      'ai.c2.t': 'Cada escritura necesita tu aprobación.',
      'ai.c2.d': 'Ves quién lo pidió, dónde y cada instrucción. Los scripts aprobados se ejecutan en una transacción.',
      'ai.c3.t': 'Tus claves siguen siendo tuyas.',
      'ai.c3.d': 'Cifradas en tu equipo, una por proveedor, nunca se vuelven a mostrar ni se envían a otro lugar.',
      'ai.c4.t': 'Servidor MCP solo local.',
      'ai.c4.d': 'Escucha en 127.0.0.1 con un token y rechaza solicitudes del navegador. Cada llamada queda registrada.',
      'mcp.title': 'Conecta un agente con una línea',
      'mcp.d': 'Activa el servidor MCP en IA y agentes → Agentes externos y copia el comando de tu cliente. Graphite muestra la configuración exacta con tu token.',
      'dl.title': 'Descargar',
      'dl.sub': 'Gratis, sin cuenta, sin telemetría.',
      'dl.mac': 'Apple Silicon (M1 o más reciente) o Intel.',
      'dl.gk.t': '¿“No se puede abrir Graphite”?',
      'dl.gk.d': 'La app aún no está notarizada por Apple. Abre Configuración del Sistema → Privacidad y seguridad y haz clic en “Abrir de todos modos”, o ejecuta:',
      'dl.linux': 'x64. El .deb crea la entrada del menú y el comando graphite.',
      'dl.src.t': 'Desde el código',
      'dl.src.d': 'Node.js 22+. Funciona en macOS y Linux.',
      'dl.upd.t': 'Instálalo una vez y se mantiene actualizado.',
      'dl.upd.d': 'Graphite detecta cuando sale una versión nueva, muestra qué cambió, descarga el paquete correcto, lo verifica con el SHA-256 de GitHub y se reinicia en la versión nueva. Desde la 0.9.0; puedes desactivar la verificación.',
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
      'hero.changelog': 'Mira qué cambió en cada versión',
      'hero.verb': 'Consulta, edita y explora',
      'hero.verb.sr': 'PostgreSQL, MySQL, MongoDB, Redis, DynamoDB y 19 bases de datos más',
      'hero.star': 'Estrella en GitHub',
      'st.db': 'bases de datos en una app',
      'st.nosql': 'motores NoSQL, editables en la tabla',
      'st.ai': 'formas de usar IA: nube, local o MCP',
      'st.tel': 'cuentas, anuncios o telemetría',
      'show.query': 'Editor SQL',
      'show.table': 'Edición de datos',
      'show.er': 'Diagramas ER',
      'show.mcp': 'MCP para agentes',
      'marquee': 'Bases de datos compatibles',
      'alt.table': 'Editando las filas de una tabla',
      'final.t': 'Deja de saltar entre clientes de bases de datos.',
      'final.d': 'Postgres por la mañana, Mongo después del almuerzo, esa tabla de DynamoDB a las 2 de la madrugada — una app, un atajo, un lugar para todas tus conexiones.',
    },
  }
  var EN_EXTRA = { 'dl.for': 'Download for {os}', 'dl.version': 'Current version: {v}.' }

  // English is the HTML itself; remember it so switching back works.
  var original = {}
  document.querySelectorAll('[data-i18n]').forEach(function (el) { original[el.dataset.i18n] = el.innerHTML })
  document.querySelectorAll('[data-i18n-alt]').forEach(function (el) { original[el.dataset.i18nAlt] = el.alt })
  document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { original[el.dataset.i18nAria] = el.getAttribute('aria-label') })

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
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', lang === 'en' ? original[el.dataset.i18nAria] : tr(el.dataset.i18nAria))
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
    document.querySelectorAll('[data-dl="primary"]').forEach(function (primary) {
      var label = primary.querySelector('[data-dl-label]')
      if (os) {
        primary.dataset.target = os === 'mac' ? 'mac-arm64' : 'deb'
        label.textContent = tr('dl.for', { os: os === 'mac' ? 'macOS' : 'Linux' })
      } else {
        primary.dataset.target = ''
        primary.href = '#download'
        label.textContent = tr('hero.download')
      }
    })
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

  // --- hero: typed database names ---------------------------------------------
  var NAMES = ['PostgreSQL', 'MongoDB', 'MySQL', 'Redis', 'DynamoDB', 'SQL Server', 'ClickHouse', 'Oracle', 'Cassandra', 'SQLite', 'Snowflake', 'SurrealDB', 'DuckDB', 'BigQuery']
  var typed = document.querySelector('[data-typed]')
  if (typed && !reduced) {
    var n = 0
    var pos = NAMES[0].length
    var deleting = true
    var tick = function () {
      if (deleting) {
        pos--
        if (pos === 0) { deleting = false; n = (n + 1) % NAMES.length }
      } else {
        pos++
      }
      typed.textContent = NAMES[n].slice(0, pos)
      var delay = deleting ? 45 : 85
      if (!deleting && pos === NAMES[n].length) { deleting = true; delay = 1900 }
      setTimeout(tick, delay)
    }
    setTimeout(tick, 2200)
  }

  // --- hero: screenshot tabs (auto-advance until the visitor picks one) ---------
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-shot]'))
  var timer = null
  function show(name) {
    tabs.forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.shot === name)) })
    document.querySelectorAll('[data-shot-img]').forEach(function (img) { img.hidden = img.dataset.shotImg !== name })
  }
  tabs.forEach(function (b, i) {
    b.addEventListener('click', function () { clearInterval(timer); show(b.dataset.shot) })
    b.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!d) return
      var next = tabs[(i + d + tabs.length) % tabs.length]
      clearInterval(timer)
      show(next.dataset.shot)
      next.focus()
    })
  })
  if (tabs.length && !reduced && 'IntersectionObserver' in window) {
    var stage = document.querySelector('.stage')
    var visible = false
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting }).observe(stage)
    timer = setInterval(function () {
      if (!visible || document.hidden) return
      var i = tabs.findIndex(function (b) { return b.getAttribute('aria-selected') === 'true' })
      show(tabs[(i + 1) % tabs.length].dataset.shot)
    }, 5000)
  }

  // --- marquee: second copy for a seamless loop ---------------------------------
  var track = document.querySelector('.marquee-track')
  if (track && !reduced) {
    Array.prototype.slice.call(track.children).forEach(function (li) {
      var c = li.cloneNode(true)
      c.setAttribute('aria-hidden', 'true')
      track.appendChild(c)
    })
  }

  // --- scroll reveal ------------------------------------------------------------
  var items = document.querySelectorAll('.reveal')
  if ('IntersectionObserver' in window && !reduced) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return
        e.target.classList.add('in')
        io.unobserve(e.target)
      })
    }, { rootMargin: '0px 0px -40px 0px' })
    items.forEach(function (el) {
      // Already on screen (a reload halfway down): show it right away.
      if (el.getBoundingClientRect().top < window.innerHeight) return el.classList.add('in')
      // Stagger siblings a little (cards in a grid).
      var sib = Array.prototype.indexOf.call(el.parentNode.children, el)
      if (el.classList.contains('card')) el.style.transitionDelay = Math.min(sib, 5) * 60 + 'ms'
      io.observe(el)
    })
  } else {
    items.forEach(function (el) { el.classList.add('in') })
  }

  apply(storedLang() || browserLang())
  loadRelease()
})()
