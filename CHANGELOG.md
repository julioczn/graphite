# Changelog

All notable changes to Graphite are listed here. Versions before 0.5.0 predate the public repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.17.0] - 2026-11-26

### Added
- **Table aliases from autocomplete.** Picking a table after `FROM` or `JOIN` writes an alias with it
  (`order_items oi`, `customers c`; `c2` when `c` is taken), so its columns come right up with `oi.`. Tables that
  already have an alias, `DELETE`, and engines without table aliases (Cassandra, DynamoDB, SurrealDB) are left as
  they are.

## [0.16.0] - 2026-11-25

### Added
- **Several connections at once.** Opening a connection no longer closes the current one: each open connection gets
  a tab on top (with `+` to open another) and keeps its own query tabs, results and transaction. **Side by side**
  (`⌘/Ctrl+\`, or right-click a connection tab) shows two connections next to each other, each with its own sidebar
  and status bar; `⌘/Ctrl+Alt+←/→` moves between them. The AI assistant works on the pane you're in.
- **Keyboard shortcuts list.** A keyboard button in the activity bar (and on the connection screen), or
  `⌘/Ctrl+Shift+/`, lists every shortcut by area, with a filter.
- **Row limit in the status bar.** Query results show 100 rows by default (was 5,000); pick 100 to 50,000 in the
  status bar, remembered on this machine. Raising it runs a cut-off read again, and the notice under a cut-off result
  has a "Show up to …" button.

## [0.15.0] - 2026-11-24

### Added
- **SSH tunnel.** "Connect through an SSH tunnel" in the connection form: SSH server, user, and a private key (with
  its passphrase), a password or the SSH agent. Works for every engine reached at a host and port, and MongoDB with a
  `mongodb://` URL. TLS still checks the certificate against the real host name, the SSH server's key is recorded on
  first use and a changed key is refused, and connections and background jobs share one SSH session. The password or
  passphrase is saved encrypted and never synced to GitHub. Importing from DBeaver, Beekeeper Studio, DbGate, pgAdmin,
  HeidiSQL, Sequel Ace, MySQL Workbench, MongoDB Compass and VS Code (SQLTools) brings the tunnel settings along.

### Fixed
- Dropdowns had their arrow pressed against the right border.

## [0.14.1] - 2026-11-24

### Fixed
- **Workspaces from another machine now show up.** Signed in to GitHub, Graphite finds the workspaces already in your
  repositories (one per folder) and lists the ones not on this machine in the workspace menu, as "Name (on GitHub)":
  one click brings the workspace over, linked and syncing. The GitHub dialog lists them too, per repository, and warns
  before linking to a folder that already holds another workspace. A fresh install's empty default workspace is reused
  instead of left behind. Before, each machine only synced the workspaces linked on it, so the other machine's never
  appeared.

## [0.14.0] - 2026-11-23

### Added
- **Windows** (x64, Windows 10 and 11): a per-user installer (no admin rights, choice of folder, Start menu and desktop
  shortcuts) and a portable zip. In-app updates run the new installer silently and restart.
- **Fedora / RHEL / Rocky / AlmaLinux / CentOS Stream** `.rpm` and **Arch / Manjaro** pacman packages, next to the
  `.deb` and the AppImage. In-app updates use each one's package manager. On Arch the package is `graphite-dbclient`,
  since `graphite` there is the SIL Graphite font library; the command is still `graphite`.
- Every build is smoke-tested before a release: it starts, opens its local database, encrypts a secret and runs
  queries on SQLite and DuckDB, on macOS, Windows (portable and installed) and Linux; the Linux packages are installed
  and started in clean Rocky Linux 9, Fedora, Arch and Ubuntu containers.

### Fixed
- The `.deb` didn't declare the ALSA library and libgbm, which Electron needs: on a minimal Ubuntu 24.04 the app
  didn't start (`libasound.so.2` missing). It now asks for the real ALSA library, not an OSS emulation of it.
- Upgrading an `.rpm` would have removed the `graphite` command (the old version's removal script runs last).

## [0.13.0] - 2026-11-23

### Added
- **Import from other tools**: connections saved by DBeaver, DataGrip / IntelliJ, Beekeeper Studio, TablePlus,
  pgAdmin 4, MySQL Workbench, Sequel Ace / Sequel Pro, DbGate, MongoDB Compass, RedisInsight and VS Code SQLTools /
  Azure Data Studio are found on this machine; a picked file works too, including Navicat `.ncx` exports and HeidiSQL
  exported settings. A preview lists each connection (engine, address, folder, whether a password comes along, what
  Graphite can't do, like SSH tunnels) and imports the chosen ones into the current workspace or a new one. Passwords
  the tool stores in its own files are decrypted in the main process and stored encrypted by the OS keychain; DBeaver
  scripts and Beekeeper favorite queries become saved queries. Also offered from the empty connection list.
- **GitHub sync status** under the workspace picker and in the status bar: synced (with how long ago), syncing
  (background syncs included), failed or signed out, with a button to sync now.

### Fixed
- Saved file connections showed their path with the leading `/` moved to the end in the sidebar.

## [0.12.0] - 2026-11-23

### Added
- **Workspaces**: named sets of saved connections, saved queries, snippets, open tabs and per-connection preferences
  (commit mode, last schema), picked at the top of the connection screen. Existing data moves into the first one.
- **Export / import** a workspace as YAML or JSON. Passwords and tokens are never written; URLs lose embedded
  passwords.
- **GitHub sync**: link a workspace to a folder in a private repository. Sign in with GitHub through the Graphite
  Sync app (device flow; it only sees the repositories you install it on) or a fine-grained personal token, stored encrypted by the OS keychain. Each sync is one commit of readable files
  (`workspace.yml`, `queries/*.sql`). A three-way merge against the last sync means edits on both sides keep both
  copies, deletions propagate, and other files in the folder are left alone. Syncs on open, every 10 minutes and
  20 s after a change. Public repositories are refused.
- **My snippets**: your own snippets per workspace (trigger, description, body with tab stops), offered in the editor's
  autocomplete and at the top of the Snippets menu.
- Tabs left open on a saved connection come back when you reconnect, on this machine or another.

### Changed
- Commit mode and last schema per connection moved from browser storage to the workspace (older values are still
  read).

## [0.11.0] - 2026-11-23

### Added
- **Import from URL** on the connection form: paste a connection string and the form fills itself in, engine
  included. Understands `postgres://`, `mysql://`, `mariadb://`, `sqlserver://`, `oracle://`, `redis(s)://`,
  `mongodb(+srv)://`, `clickhouse://`, `trino://`, `cassandra://`, `snowflake://`, `libsql://`, `ws(s)://` (SurrealDB),
  `sqlite:///` and `duckdb:///` URLs, a `jdbc:` prefix, SQLAlchemy driver suffixes, JDBC SQL Server/Oracle syntax,
  libpq `host=… dbname=…` and ADO.NET `Server=…;Database=…` strings, and a pasted `DATABASE_URL=…` line. TLS
  parameters (`sslmode`, `ssl-mode`, `encrypt`, `rediss://`…) set the certificate check; Redshift, CockroachDB Cloud
  and TiDB Cloud hosts pick their engine. Credentials move to the encrypted password field, never into a stored
  URL, and parameters without a matching field are listed. Pasting a URL into the Host field does the same.

### Changed
- Graphite now presents itself as a database client, not a SQL client: the sidebar subtitle, the package
  descriptions (.deb, npm) and the instructions the MCP server gives agents, which now list the non-SQL engines and
  their query languages.

## [0.10.2] - 2026-11-22

0.10.1 was built but never published; its changes ship here.

### Fixed
- SurrealDB: a wrong user or password showed "Unexpected token 'T'… is not valid JSON" instead of the reason. The
  server answers auth errors in plain text; they now read "SurrealDB authentication failed: …". A URL that isn't a
  SurrealDB server (a web page, a proxy error) says so instead of showing the page, and query errors no longer
  start with "There was a problem with the database:".
- Updates: the download refuses a release that isn't newer than the running version (the GitHub API can still
  return the previous release for a few minutes after publishing).

## [0.10.0] - 2026-11-22

### Added
- Grid editing for **Cassandra / ScyllaDB**, **DynamoDB** and **SurrealDB**, all or nothing:
  - Cassandra/ScyllaDB: one logged `BATCH`, after checking every row still exists (CQL `UPDATE` would otherwise
    recreate a deleted row); values go through `fromJson()`, so the server converts the text to the column type
    (bigint, decimal, timestamp, uuid, inet, date…; collections and UDTs edited as JSON).
  - DynamoDB: one `TransactWriteItems` (up to 100 items), each conditioned on the item still existing; an attribute
    keeps its type (S, N, BOOL, maps/lists and sets as JSON); NULL removes the attribute.
  - SurrealDB: one `BEGIN … COMMIT` that rolls back if a record is gone; the new value takes the type of the field's
    current value, also inside objects and arrays (datetime, decimal, duration, record, uuid…); NULL removes the field.

### Changed
- Key columns are read-only in the grid where a row's key can't change (MongoDB `_id`, Cassandra/DynamoDB keys,
  SurrealDB `id`), instead of failing when the edit is applied.

## [0.9.0] - 2026-11-22

### Added
- **In-app updates**: Graphite checks GitHub Releases on start and every 6 hours (can be turned off), shows
  "Update available" with the release notes, downloads the package for this install with a progress bar, verifies it
  against the SHA-256 digest GitHub publishes (refuses it otherwise), and restarts on the new version. macOS swaps the
  `.app` (restoring the old one if the swap fails); Linux replaces the AppImage or installs the `.deb` with `pkexec`.
  Works without an Apple Developer ID signature, unlike Squirrel/electron-updater.

## [0.8.0] - 2026-11-22

### Added
- **TLS certificates**: with "Use SSL" on, choose how the server certificate is checked (encrypt only, verify the CA,
  or verify the CA and host name — the default for new connections) and point to a CA certificate and a client
  certificate + key (PEM) for mutual TLS. Supported by PostgreSQL and compatibles, MySQL and compatibles, SQL Server,
  Oracle (`tcps`), Redis, Cassandra/ScyllaDB, ClickHouse and Trino. Connections saved before keep their previous
  behaviour (encrypt, don't verify).
- Grid editing for **MongoDB** and **Redis**. MongoDB keeps each field's BSON type (number, Decimal128, Date,
  ObjectId, Long, arrays/objects as Extended JSON) and applies a batch in a transaction on replica sets (Atlas); on a
  standalone server it applies in order and reports how many changes went in if one fails. Redis applies the batch as
  one `MULTI/EXEC` under `WATCH` (nothing is written if the key changes meanwhile), per key type: hash fields
  (including renames), list items, set and sorted-set members and scores, strings (keeping the TTL) and stream entries
  (delete).

### Fixed
- "Use SSL" used to accept any server certificate silently; new connections now verify it. MySQL also checks the host
  name when connecting by IP address.

## [0.7.0] - 2026-11-22

### Added
- **SQL Server** (2016+ / Azure SQL, via tedious) and **Oracle Database** (12c+, Thin mode — no Instant Client),
  tested against SQL Server 2022 and Oracle Database 23ai. Paging with `OFFSET … FETCH`, generated SQL and snippets
  use `TOP` / `FETCH FIRST`, scripts understand `GO` batches and PL/SQL blocks ending in `/`.
- AI reads on Oracle run in `SET TRANSACTION READ ONLY`; on SQL Server they run in a transaction that is always
  rolled back, and `SELECT … INTO` needs approval.

- **ClickHouse** (HTTP; AI reads with `readonly=1`), **Trino** (REST, catalogs as `catalog.schema`; AI reads in a
  read-only transaction), **Firebird** 3+ (AI reads in a read-only transaction) and **DuckDB** (embedded; every AI
  query needs approval because reads can reach local files), tested against ClickHouse 25.8, Trino 476,
  Firebird 5 and DuckDB 1.5.
- Wide `NUMERIC`/`DECIMAL` values are read as exact text when browsing and exporting (SQL Server, Firebird).

- **Snowflake** (SQL API v2 with a Programmatic Access Token) and **BigQuery** (REST API with a service account key)
  in beta, without SDKs. BigQuery tested against the open-source emulator; Snowflake against a mock of the documented
  API. Both: read-only grid, AI asks for approval on every query.

- **Non-relational databases**: **MongoDB** (mongosh-style commands such as `db.orders.find({...}).sort({...})`,
  parsed without evaluating code; JSON filters in the table tab), **Redis / Valkey** (redis-cli commands; keys
  browsed by type), **Apache Cassandra** and **ScyllaDB** (CQL, keyspaces), **Amazon DynamoDB** (PartiQL over the
  HTTP API with SigV4 signing, no SDK) and **SurrealDB** (SurrealQL over HTTP). Tested against MongoDB 8, Redis 7.4,
  Cassandra 5, ScyllaDB 6.2, DynamoDB Local and SurrealDB 2.3. Read-only grid and every AI query needs approval.
- Engines that can't count rows cheaply (Cassandra, DynamoDB) page without a total.

### Changed
- The app is larger (~45 MB more per download) because DuckDB is embedded with its native library.

### Known limitations
- SQL Server: in free-form queries, `decimal`/`numeric` values beyond ~15 significant digits lose precision (driver
  limitation); table browsing and exports read them as exact text. Only the last result set of a batch is shown.

## [0.6.0] - 2026-11-21

### Added
- New databases: **MariaDB**, **TiDB**, **CockroachDB**, **GreengageDB**, **StarRocks** and **LibSQL / Turso**
  (tested against real servers), plus **Amazon Redshift** in beta. The connection form now has a database type picker.
- Each engine declares what it supports; the interface hides what an engine can't do (manual transactions, backup,
  grid editing) and the AI asks for approval on every query where the database can't enforce a read-only mode
  (TiDB, Redshift, StarRocks).
- The AI tools report the exact server (e.g. "CockroachDB v24.3.5") so agents write the right SQL flavor.

### Fixed
- AI reads failed on MariaDB servers (MariaDB has no `max_execution_time`), and a failure while entering the
  read-only mode could leave the connection stuck in read-only. Setup now always rolls back on error.

## [0.5.0] - 2026-11-21

### Added
- Interface in **English**, **Português (Brasil)** and **Español**. Follows the system language by default; switch any
  time from the globe icon without restarting. Errors from the database process, backup file comments, SQL snippet
  field names and the AI assistant follow the chosen language.
- `npm run i18n:check` reports missing or inconsistent translations.

### Changed
- Text that only AI models read (assistant system prompt, tool descriptions, MCP server instructions) is now in English.

## 0.4.1 - 2026-11-21

### Added
- The assistant's model picker lists every model your API key can use, loaded live from the provider (Anthropic
  Models API or `GET /models` on OpenAI-compatible servers), with a built-in list as fallback.

### Changed
- Whether to send the `effort` parameter is decided from the model's capabilities reported by the API.

## 0.4.0 - 2026-11-21

### Added
- **AI assistant** next to the editor, using the Anthropic API or any OpenAI-compatible provider (including Ollama and
  LM Studio). Reads the schema, runs read-only queries, inserts SQL into the editor and can fix failing queries.
- **MCP server** so external agents (Claude Code, Cursor, VS Code, Claude Desktop) can use Graphite's connections.
  Local-only, token-protected, with ready-to-paste client configs.
- Reads from AI run in a database-enforced read-only mode; every write needs your approval in the app and runs in a
  transaction. Activity log of every agent call.

## 0.3.0 - 2026-11-21

### Added
- macOS builds (Apple Silicon and Intel), with `⌘` shortcuts shown in the interface.
- Right-click actions in the result grid: copy value / row / JSON / `INSERT`, set `NULL` or empty, restore the original
  value, filter by value, mark rows for deletion, column actions on headers.
- SQL snippets with shortcuts (`sel`, `ij`, `ups`, `ct`…) adapted to each database.
- Generate `SELECT` (with `JOIN`s that follow foreign keys), `INSERT`, `UPDATE` and `DELETE` from a table.

### Fixed
- Filtering `FLOAT` and `JSON` columns on MySQL, and filters on PostgreSQL types shown as text (intervals, arrays, points).

## 0.2.0 - 2026-10-20

First packaged release for Linux (AppImage and `.deb`): saved connections for SQLite, PostgreSQL and MySQL/MariaDB,
SQL editor with autocomplete, editable grid, manual transactions, schema/database picker, ER diagram, backup and
restore, data export, history and saved queries.

[Unreleased]: https://github.com/julioczn/graphite/compare/v0.17.0...HEAD
[0.17.0]: https://github.com/julioczn/graphite/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/julioczn/graphite/releases/tag/v0.16.0
[0.15.0]: https://github.com/julioczn/graphite/releases/tag/v0.15.0
[0.14.1]: https://github.com/julioczn/graphite/releases/tag/v0.14.1
[0.14.0]: https://github.com/julioczn/graphite/releases/tag/v0.14.0
[0.13.0]: https://github.com/julioczn/graphite/releases/tag/v0.13.0
[0.12.0]: https://github.com/julioczn/graphite/releases/tag/v0.12.0
[0.11.0]: https://github.com/julioczn/graphite/releases/tag/v0.11.0
[0.10.2]: https://github.com/julioczn/graphite/releases/tag/v0.10.2
[0.10.0]: https://github.com/julioczn/graphite/releases/tag/v0.10.0
[0.9.0]: https://github.com/julioczn/graphite/releases/tag/v0.9.0
[0.8.0]: https://github.com/julioczn/graphite/releases/tag/v0.8.0
[0.7.0]: https://github.com/julioczn/graphite/releases/tag/v0.7.0
[0.6.0]: https://github.com/julioczn/graphite/releases/tag/v0.6.0
[0.5.0]: https://github.com/julioczn/graphite/releases/tag/v0.5.0
