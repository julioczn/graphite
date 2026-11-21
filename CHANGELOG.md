# Changelog

All notable changes to Graphite are listed here. Versions before 0.5.0 predate the public repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/julioczn/graphite/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/julioczn/graphite/releases/tag/v0.5.0
