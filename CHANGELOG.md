# Changelog

All notable changes to Graphite are listed here. Versions before 0.5.0 predate the public repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- SurrealDB: a wrong user or password showed "Unexpected token 'T'… is not valid JSON" instead of the reason. The
  server answers auth errors in plain text; they now read "SurrealDB authentication failed: …". A URL that isn't a
  SurrealDB server says so, and query errors no longer start with "There was a problem with the database:".
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

[Unreleased]: https://github.com/julioczn/graphite/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/julioczn/graphite/releases/tag/v0.10.0
[0.9.0]: https://github.com/julioczn/graphite/releases/tag/v0.9.0
[0.8.0]: https://github.com/julioczn/graphite/releases/tag/v0.8.0
[0.7.0]: https://github.com/julioczn/graphite/releases/tag/v0.7.0
[0.6.0]: https://github.com/julioczn/graphite/releases/tag/v0.6.0
[0.5.0]: https://github.com/julioczn/graphite/releases/tag/v0.5.0
