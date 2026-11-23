<p align="center">
  <img src="docs/assets/icon.svg" width="88" height="88" alt="Logo do Graphite">
</p>

<h1 align="center">Graphite</h1>

<p align="center">
  Cliente desktop rápido e feito para o teclado para <b>24 bancos de dados</b>: SQL, NoSQL e data warehouses na nuvem<br>
  com assistente de AI e servidor MCP para os seus próprios agentes.
</p>

<p align="center">
  <a href="https://github.com/julioczn/graphite/releases/latest"><img alt="Última versão" src="https://img.shields.io/github/v/release/julioczn/graphite?label=release&color=555"></a>
  <a href="https://github.com/julioczn/graphite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/julioczn/graphite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Licença MIT" src="https://img.shields.io/badge/license-MIT-555"></a>
  <img alt="macOS e Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555">
</p>

<p align="center">
  <a href="https://julioczn.github.io/graphite/">Site</a> ·
  <a href="https://github.com/julioczn/graphite/releases/latest">Download</a> ·
  <a href="README.md">English</a>
</p>

![Graphite: editor SQL com resultados](docs/assets/screenshots/query.png)

## Recursos

- **SQLite, PostgreSQL, MySQL, MariaDB, TiDB, CockroachDB, GreengageDB e LibSQL/Turso** ([lista completa](#bancos-suportados)) com conexões salvas (senhas cifradas pelo chaveiro do sistema), botão
  **Testar**, **Importar de URL** (cole `postgres://…`, `mysql://…`, `mongodb+srv://…`, JDBC, `DATABASE_URL=…`, strings
  libpq ou ADO.NET e o formulário se preenche sozinho) e um banco **demo** pronto.
- **Editor SQL** (CodeMirror 6): autocomplete de tabelas e colunas, destaque da instrução atual, vários resultados por
  execução, erros inline. `⌘/Ctrl+Enter` executa tudo ou a seleção; `⌘/Ctrl+Shift+Enter`, a instrução sob o cursor.
- **Snippets de SQL**: digite um atalho (`sel`, `ij`, `ups`, `ct`…) e escolha no autocomplete; os modelos mudam por banco.
- **Navegação de tabelas**: paginação, ordenação, filtro `WHERE`, aba de estrutura (colunas, índices, DDL).
- **Edição inline** de tabelas e de resultados de consulta (quando a chave primária está no resultado), gravada numa
  única transação. Botão direito em células, cabeçalhos e linhas: copiar como valor / JSON / `INSERT`, definir `NULL`,
  filtrar pelo valor…
- **Gerar SQL** de qualquer tabela: `SELECT`, `SELECT` com `JOIN`s seguindo as FKs, `INSERT`, `UPDATE`, `DELETE`.
- **Auto-commit ou transação manual** por conexão, com commit/rollback (no PostgreSQL cada instrução roda num
  savepoint, então um erro não derruba a transação).
- **Diagrama ER** com layout automático, relações inferidas, busca, modo "só chaves" e exportação SVG/PNG.
- **Backup e restore** em `.sql` / `.sql.gz` sem `pg_dump` nem `mysqldump`, em streaming, com progresso e cancelamento.
- **Exportar** tabelas ou o resultado completo de uma consulta em CSV, JSON, JSON Lines ou `INSERT`s, sem limite de linhas.
- Histórico por conexão, consultas salvas, busca rápida (`⌘/Ctrl+P`), abas.
- **Português (Brasil), English e Español**: segue o idioma do sistema; troque quando quiser pelo ícone de globo.

<details>
<summary>Atalhos dos snippets</summary>

| Consulta | Joins | Alterar dados | Estrutura | Diagnóstico |
|---|---|---|---|---|
| `sel` `seld` `cnt` `grp` `pag` `busca` `entre` `cte` `case` `exists` `in` `rank` `dup` | `ij` `lj` `rj` `fj` `cj` `antij` `j3` | `ins` `insm` `inss` `insr` `ups` `upd` `updj` `del` `delj` `tx` | `ct` `addcol` `dropcol` `rencol` `idx` `uidx` `fk` `view` `drop` | `exp` `cols` `tam` `proc` |

`Tab` / `Shift+Tab` passam pelos campos e `Esc` sai. O botão **Snippets** da barra mostra todos com busca.
</details>

| Diagrama ER | Aprovando a alteração de um agente |
|---|---|
| ![Diagrama ER](docs/assets/screenshots/er.png) | ![Janela de aprovação](docs/assets/screenshots/approval.png) |

## Bancos suportados

| Banco | Status | Observações |
|---|---|---|
| SQLite | ✅ | Arquivos locais |
| PostgreSQL | ✅ | |
| MySQL | ✅ | |
| MariaDB | ✅ | |
| TiDB | ✅ | A AI pede aprovação para toda consulta (o TiDB não impõe transações somente leitura) |
| CockroachDB | ✅ | Sem o backup do Graphite (use o `BACKUP` do próprio CockroachDB) |
| GreengageDB | ✅ | |
| LibSQL / Turso | ✅ | URL remota + token; sem modo de transação manual |
| SQL Server / Azure SQL | ✅ | Decimais largos em consultas livres perdem precisão (limitação do driver); use `CAST` |
| Oracle Database | ✅ | Modo Thin (sem Instant Client); "banco" = nome do serviço |
| ClickHouse | ✅ | HTTP; sem transações (grade somente leitura); a AI lê com `readonly=1` |
| Trino / Starburst | ✅ | "Banco" = `catálogo` ou `catálogo.schema`; grade somente leitura |
| Firebird 3+ | ✅ | "Banco" = caminho ou alias no servidor |
| DuckDB | ✅ | Arquivo `.duckdb` local; a AI pede aprovação para toda consulta |
| Snowflake | 🧪 beta | Programmatic Access Token; grade somente leitura; ainda não testado numa conta real |
| BigQuery | 🧪 beta | Chave de conta de serviço (JSON); grade somente leitura; testado com o emulador open source |
| MongoDB | ✅ | Comandos no estilo do mongosh (`db.orders.find({…})`); filtro JSON; edição na grade mantém os tipos BSON |
| Redis / Valkey | ✅ | Comandos do redis-cli, um por linha; chaves exibidas e editadas por tipo (`MULTI/EXEC` atômico) |
| Apache Cassandra / ScyllaDB | ✅ | CQL; keyspaces no seletor; paginação sem total; edições num único batch logado |
| Amazon DynamoDB | ✅ | PartiQL; access key + secret (ou DynamoDB Local); edições numa transação, mantendo os tipos |
| SurrealDB | ✅ | SurrealQL via HTTP; namespace + banco; edições numa transação, mantendo os tipos |
| Amazon Redshift | 🧪 beta | Ainda não testado contra um cluster real |
| StarRocks | ✅ | Sem transações (grade somente leitura); a AI pede aprovação para toda consulta |

Nos não relacionais, a AI pede aprovação para todo comando, porque nenhum deles oferece um modo somente leitura em
que o app possa confiar. Todos têm edição pela grade; as colunas-chave (`_id`, chaves primária/de partição/de
ordenação, `id`) ficam somente leitura, porque identificam a linha.

## AI: use o seu próprio modelo ou agente

Dois jeitos de usar a sua própria AI, com as mesmas ferramentas por baixo (listar conexões, schemas e tabelas,
descrever tabela, resumo do schema com FKs, executar SQL):

- **Assistente embutido** (✦ na barra lateral): chat ao lado do editor com a **API da Anthropic** (Claude) ou qualquer
  provedor **compatível com OpenAI**, inclusive modelos locais (Ollama, LM Studio). Lê o schema, roda leituras sozinho,
  entrega o SQL com botões **Inserir** / **Nova aba**, e consultas com erro ganham o botão **Corrigir com AI**. A lista
  de modelos vem ao vivo do provedor. A chave de API fica cifrada no seu computador, uma por provedor, e nunca volta
  para a janela nem vai para outro provedor.
- **Servidor MCP** para agentes externos (Claude Code, Cursor, VS Code, Claude Desktop via `mcp-remote`): ligue em
  **AI e agentes → Agentes externos**, que mostra a configuração pronta para copiar. Só escuta em `127.0.0.1`, exige
  token e recusa requisições de navegador (`Origin`) ou com outro `Host`.

![Configuração do servidor MCP](docs/assets/screenshots/mcp.png)

**Como os seus dados ficam protegidos** ([`electron/lib/aiquery.cjs`](electron/lib/aiquery.cjs)):

- **Leituras** (`SELECT`, `WITH`, `EXPLAIN`, `SHOW`…) rodam num modo somente leitura **imposto pelo próprio banco**
  (`BEGIN READ ONLY`, `SET SESSION TRANSACTION READ ONLY`, `PRAGMA query_only`), com timeout de 30 s e só as primeiras
  linhas lidas. Uma escrita disfarçada de leitura (`WITH … DELETE`, `EXPLAIN ANALYZE DELETE`, `nextval()`) falha em vez de rodar.
- **Qualquer outra instrução** abre uma **janela de aprovação** no Graphite mostrando quem pediu, a conexão e cada
  instrução. Aprovado, o script roda numa transação; recusado, nada roda e o agente é avisado. Conexões somente
  leitura nunca permitem escrita.
- Os agentes usam **sessões próprias**, nunca a sua transação aberta. Toda chamada aparece em **AI → Atividade**.

> [!IMPORTANT]
> Quem tiver o token do MCP consegue **ler** todas as conexões salvas sem pedir aprovação. Trate-o como uma senha e
> gere outro se ele vazar.

## Instalar

Baixe a versão mais recente em **[Releases](https://github.com/julioczn/graphite/releases/latest)**.

### macOS (Apple Silicon e Intel)

Abra `Graphite-<versão>-arm64.dmg` (Apple Silicon) ou `-x64.dmg` (Intel) e arraste o Graphite para Aplicativos.

O app tem assinatura ad-hoc, mas **não é notarizado** (sem Developer ID pago da Apple), então o Gatekeeper bloqueia a
primeira abertura. Vá em **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**, ou rode:

```bash
xattr -dr com.apple.quarantine /Applications/Graphite.app
```

No Mac os atalhos usam `⌘` no lugar de `Ctrl` (a interface já mostra `⌘`), e a tecla `⌫` da grade faz o papel do `Del`.

### Linux (x64)

```bash
sudo apt install ./graphite_<versão>_amd64.deb   # Debian/Ubuntu: instala em /opt/Graphite e cria o comando `graphite`
sudo apt remove graphite                         # desinstala
```

Ou use o `Graphite-<versão>.AppImage` portátil (`chmod +x` e execute). O `.deb` cria um perfil do AppArmor
(`/etc/apparmor.d/graphite`) para o sandbox do Electron funcionar no Ubuntu 23.10+, como fazem VS Code e Chrome.

### TLS / SSL

Com **Usar SSL**, escolha como o certificado do servidor é verificado: *só criptografar*, *verificar a CA* ou
*verificar a CA e o nome do host* (o padrão para conexões novas). Aponte o **certificado da CA** (sem ele, valem as
autoridades confiáveis do sistema) e, para TLS mútuo, o **certificado e a chave do cliente** (arquivos PEM; o Graphite
guarda só os caminhos). O Firebird criptografa o próprio protocolo; o MongoDB recebe as opções de TLS na URL de
conexão (`tls=true&tlsCAFile=…`).

### Atualizações

O Graphite consulta as releases deste repositório ao abrir e a cada 6 horas, mostra **Atualização disponível** na
barra lateral e baixa e instala a versão nova para você: o arquivo é conferido com o SHA-256 que o GitHub publica e o
Graphite reinicia já na versão nova (`.app` no macOS, AppImage ou `.deb` via `pkexec`). A verificação automática pode
ser desligada no mesmo diálogo; ela é uma consulta simples à API do GitHub, sem nada sobre você ou seus bancos.

### Workspaces e sincronização com o GitHub

Um **workspace** reúne conexões salvas, consultas salvas, os seus próprios snippets, as abas deixadas abertas em cada
conexão e as preferências por conexão (modo de commit, último schema). Escolha ou crie um no topo da tela de conexões;
o que você já tinha está no primeiro.

- **Exportar / importar** um workspace em YAML ou JSON, no mesmo menu. Importar cria um workspace novo.
- **Sincronizar com o GitHub**: ligue um workspace a uma pasta num repositório *privado* seu, entrando com o GitHub ou
  com um token "fine-grained" que só escreve no conteúdo desse repositório. O workspace vira arquivos legíveis
  (`<pasta>/workspace.yml`, `<pasta>/queries/*.sql`, um commit por sincronização). O Graphite sincroniza ao abrir, a
  cada 10 minutos e logo depois de uma mudança. Uma consulta editada em duas máquinas ao mesmo tempo mantém as duas
  versões em vez de sobrescrever uma.
- **Senhas e tokens nunca saem do seu computador**: ficam fora das exportações e do repositório. Em outra máquina você
  digita cada senha uma vez. Repositórios públicos são recusados.

### Onde ficam os seus dados

Conexões salvas, histórico e configurações ficam no seu computador: `~/Library/Application Support/Graphite` (macOS)
ou `~/.config/Graphite` (Linux). O Graphite não tem telemetria; ele só conversa com os seus bancos, com o seu provedor
de AI (se você configurar) e com o GitHub para verificar atualizações (dá para desligar) e, se você ligar um
workspace, para sincronizá-lo.

## Compilar a partir do código

Precisa de **Node.js 22+**.

```bash
git clone https://github.com/julioczn/graphite.git
cd graphite
npm install
npm run dev        # Vite com HMR + Electron
npm start          # build do renderer + Electron
npm run dist:mac   # release/Graphite-<versão>-{arm64,x64}.dmg e .zip (num Mac)
npm run dist       # release/Graphite-<versão>.AppImage e graphite_<versão>_amd64.deb
npm run i18n:check # cobertura das traduções
```

`GRAPHITE_PROFILE_DIR=/outra/pasta npm start` roda com um perfil separado (configurações, conexões, demo), útil para testes.

### Estrutura

```
electron/
  main.cjs        janelas, diálogos, safeStorage, processo utility + MessagePorts
  preload.cjs     window.graphite: RPC via MessagePort + IPC em whitelist
  utility.cjs     processo de banco: handlers conn/*, query/*, table/*, app/*
  ai/             hub (ferramentas, sessões dos agentes, aprovações), mcp (servidor), assistant (chat)
  drivers/        sqlite, postgres (pg), mysql (mysql2), libsql, mssql (tedious), oracle (oracledb),
                  clickhouse, trino, firebird (node-firebird), duckdb (@duckdb/node-api),
                  snowflake, bigquery, mongodb, redis (ioredis), cassandra (cassandra-driver), dynamodb, surrealdb
  lib/            banco do app, demo, backup/restore/exportação, guarda de leitura das consultas da AI
shared/
  engines.mjs     engines de banco: família, padrões e capacidades
  sql.mjs         separador de instruções (utility e renderer)
  i18n.mjs        traduções de todos os processos + locales/en.mjs, locales/es.mjs
src/              renderer Vue 3 (components/, lib/)
docs/             site (GitHub Pages) e screenshots
```

Todo acesso a banco acontece num processo separado que fala com a janela por um `MessagePort`; a janela roda em
sandbox, com isolamento de contexto e sem acesso ao Node.js.

## Traduções

O texto em português é a própria chave: `t('Nova conexão')`, `t('Tabela {name}', { name })`, plural com
`t('{n} linha|{n} linhas', { n })`. Inglês e espanhol ficam em [`shared/locales`](shared/locales). Para um novo
idioma, copie `en.mjs`, traduza os valores e registre em [`shared/i18n.mjs`](shared/i18n.mjs);
`npm run i18n:check` mostra o que falta. Correções de falantes nativos são muito bem-vindas.

## Contribuindo

Issues e pull requests são bem-vindos. Veja o [CONTRIBUTING.md](CONTRIBUTING.md). Para falhas de segurança, siga o
[SECURITY.md](SECURITY.md) em vez de abrir uma issue pública.

## Licença

[MIT](LICENSE) © Julio Zimmermann
