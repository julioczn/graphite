// Database engines Graphite can connect to. Each one belongs to a driver
// family (the wire protocol / SQL dialect the rest of the app reasons about:
// 'sqlite' | 'postgres' | 'mysql') and declares what it supports, so the UI
// hides what an engine can't do and AI reads stay safe.
//
// caps:
//   transactions  atomic work: grid edits and approved AI scripts run in one transaction
//   manualMode    manual commit/rollback mode (a transaction kept open across statements)
//   savepoints    per-statement savepoints inside a manual transaction (PostgreSQL family)
//   schemas       'schema' (PostgreSQL-like), 'database' (MySQL-like) or null
//   backup        Graphite's own backup (electron/lib/dump.cjs) works
//   restore       running a .sql file statement by statement works
//   er            ER diagram from the catalog
//   aiReadOnly    the database enforces a read-only mode for AI reads; when
//                 false, every AI query needs the user's approval
//   cursors       rows can be fetched in batches with DECLARE … CURSOR
//   ssl           TLS options in the connection form (Firebird encrypts its own wire)
//   edit          grid editing in the table tab (defaults to `transactions`); engines
//                 without SQL transactions apply edits through driver.applyChanges
//   sql           the query language is SQL (false: MongoDB, Redis, CQL…):
//                 SQL generation, snippets and SQL INSERT export are hidden
//
// filter: { label, placeholder } of the table tab's filter box (default WHERE).
//
// families: 'mysql' | 'postgres' | 'sqlite' | 'mssql' | 'oracle' | 'clickhouse' | 'trino' | 'firebird' |
// 'duckdb' | 'snowflake' | 'bigquery' | 'mongo' | 'redis' | 'cql' | 'partiql' | 'surql'.
//
// form: engines with their own connection form list its inputs ({ key, type:
// 'text' | 'secret' | 'file', optional, wide }); labels live in ConnectionScreen.
//
// fields: what the connection form asks for ('server' = host/port/user/
// password/database/ssl, 'file' = a local file, 'url' = URL + auth token).
// status: 'stable' (tested against a real server) or 'beta' (best effort).

const BASE = {
  ssl: true,
  sql: true,
  transactions: true,
  manualMode: true,
  savepoints: false,
  schemas: null,
  backup: false,
  restore: true,
  er: true,
  aiReadOnly: true,
  cursors: false,
}

const engine = (id, label, family, extra = {}) => ({
  id,
  label,
  family,
  fields: 'server',
  port: '',
  user: '',
  ssl: false,
  status: 'stable',
  ...extra,
  caps: { ...BASE, ...(extra.caps || {}) },
})

const PG = { schemas: 'schema', savepoints: true, backup: true, cursors: true }
const NOSQL = { sql: false, transactions: false, manualMode: false, aiReadOnly: false, er: false, restore: false }
const MY = { schemas: 'database', backup: true }

export const ENGINES = [
  engine('mysql', 'MySQL', 'mysql', { port: '3306', caps: MY }),
  engine('mariadb', 'MariaDB', 'mysql', { port: '3306', caps: MY }),
  // TiDB accepts READ ONLY transactions but doesn't enforce them.
  engine('tidb', 'TiDB', 'mysql', { port: '4000', user: 'root', caps: { schemas: 'database', aiReadOnly: false, backup: true } }),
  // OLAP: no interactive transactions (so no grid editing) and no read-only
  // session mode, so every AI query goes through approval.
  engine('starrocks', 'StarRocks', 'mysql', { port: '9030', user: 'root', caps: { schemas: 'database', transactions: false, manualMode: false, aiReadOnly: false } }),
  engine('postgres', 'PostgreSQL', 'postgres', { port: '5432', caps: PG }),
  // Graphite's backup relies on pg_get_*def() functions CockroachDB lacks (it has its own BACKUP).
  engine('cockroachdb', 'CockroachDB', 'postgres', { port: '26257', user: 'root', caps: { schemas: 'schema', savepoints: true, cursors: true } }),
  // Untested against a real cluster: no savepoints (Redshift lacks them), and AI
  // reads go through approval until the read-only guard is verified there.
  engine('redshift', 'Amazon Redshift', 'postgres', { port: '5439', ssl: true, status: 'beta', caps: { schemas: 'schema', aiReadOnly: false } }),
  engine('greengage', 'GreengageDB', 'postgres', { port: '5432', user: 'gpadmin', caps: { schemas: 'schema', savepoints: true, cursors: true, backup: true } }),
  // The schema picker switches databases (USE); tables keep their schema (dbo…).
  engine('sqlserver', 'SQL Server', 'mssql', { port: '1433', user: 'sa', caps: { schemas: 'database', savepoints: false, restore: false } }),
  // Thin mode (no Instant Client). "Database" is the service name. Oracle rolls
  // back only the failed statement, so no savepoints are needed.
  engine('oracle', 'Oracle', 'oracle', { port: '1521', caps: { schemas: 'schema', restore: false } }),
  // "Database" = path or alias on the server. Failed statements roll back on
  // their own, so no savepoints; READ ONLY transactions are enforced.
  engine('firebird', 'Firebird', 'firebird', { port: '3050', user: 'SYSDBA', caps: { restore: false, ssl: false } }),
  // HTTP interface; the picker switches databases. No interactive transactions;
  // AI reads run with readonly=1, enforced by the server.
  engine('clickhouse', 'ClickHouse', 'clickhouse', { port: '8123', user: 'default', caps: { schemas: 'database', transactions: false, manualMode: false, restore: false } }),
  // Federated queries over catalogs; "database" = catalog or catalog.schema.
  // AI reads run in START TRANSACTION READ ONLY, which Trino enforces.
  engine('trino', 'Trino', 'trino', { port: '8080', user: 'graphite', caps: { schemas: 'schema', transactions: false, manualMode: false, restore: false } }),
  // Cloud warehouses over their REST APIs. No interactive transactions and no
  // read-only mode: read-only grid, every AI query needs approval.
  engine('snowflake', 'Snowflake', 'snowflake', {
    status: 'beta',
    form: [
      { key: 'account', wide: true, placeholder: 'xy12345.us-east-1' },
      { key: 'user' },
      { key: 'token', type: 'secret' },
      { key: 'warehouse', optional: true },
      { key: 'role', optional: true },
      { key: 'database', wide: true, placeholder: 'ANALYTICS.PUBLIC' },
    ],
    caps: { schemas: 'schema', transactions: false, manualMode: false, aiReadOnly: false, restore: false },
  }),
  engine('bigquery', 'BigQuery', 'bigquery', {
    status: 'beta',
    form: [
      { key: 'keyFile', type: 'file', wide: true, exts: ['json'], placeholder: '/path/service-account.json' },
      { key: 'project', optional: true },
      { key: 'database', optional: true, placeholder: 'dataset' },
      { key: 'location', optional: true, placeholder: 'US' },
      { key: 'endpoint', optional: true, wide: true, placeholder: 'http://localhost:9050' },
    ],
    caps: { schemas: 'schema', transactions: false, manualMode: false, aiReadOnly: false, restore: false },
  }),
  // Non-relational: their own query languages (caps.sql = false), no grid
  // editing yet, no read-only mode — every AI query needs approval.
  engine('mongodb', 'MongoDB', 'mongo', {
    form: [
      { key: 'url', wide: true, placeholder: 'mongodb://localhost:27017' },
      { key: 'user', optional: true },
      { key: 'password', type: 'secret', optional: true },
      { key: 'database', optional: true, placeholder: 'test' },
    ],
    filter: { label: 'filter', placeholder: '{ "status": "pago" }' },
    caps: { ...NOSQL, schemas: 'database', edit: true },
  }),
  engine('redis', 'Redis / Valkey', 'redis', {
    port: '6379',
    filter: { label: 'MATCH', placeholder: 'user:*' },
    caps: { ...NOSQL, schemas: 'database', edit: true },
  }),
  // CQL: the picker switches keyspaces; no OFFSET and no cheap COUNT.
  engine('cassandra', 'Apache Cassandra', 'cql', { port: '9042', filter: { label: 'WHERE', placeholder: "status = 'pago' ALLOW FILTERING" }, caps: { ...NOSQL, schemas: 'database' } }),
  engine('scylladb', 'ScyllaDB', 'cql', { port: '9042', filter: { label: 'WHERE', placeholder: "status = 'pago' ALLOW FILTERING" }, caps: { ...NOSQL, schemas: 'database' } }),
  // PartiQL over the HTTP API (SigV4); endpoint for DynamoDB Local.
  engine('dynamodb', 'Amazon DynamoDB', 'partiql', {
    form: [
      { key: 'region', placeholder: 'us-east-1' },
      { key: 'accessKey', placeholder: 'AKIA…' },
      { key: 'secretKey', type: 'secret', wide: true },
      { key: 'endpoint', optional: true, wide: true, placeholder: 'http://localhost:8000' },
    ],
    filter: { label: 'WHERE', placeholder: "status = 'pago'" },
    caps: { ...NOSQL },
  }),
  // SurrealQL over HTTP; namespace + database; the picker switches databases.
  engine('surrealdb', 'SurrealDB', 'surql', {
    form: [
      { key: 'url', wide: true, placeholder: 'http://localhost:8000' },
      { key: 'user', placeholder: 'root' },
      { key: 'password', type: 'secret' },
      { key: 'namespace', placeholder: 'test' },
      { key: 'database', placeholder: 'test' },
    ],
    filter: { label: 'WHERE', placeholder: "status = 'pago'" },
    caps: { ...NOSQL, schemas: 'database' },
  }),
  engine('sqlite', 'SQLite', 'sqlite', { fields: 'file', exts: ['db', 'sqlite', 'sqlite3', 'db3'], caps: { backup: true } }),
  // Embedded (native binary). No read-only transactions, and reads can reach
  // local files (read_csv…), so every AI query needs approval.
  engine('duckdb', 'DuckDB', 'duckdb', { fields: 'file', exts: ['duckdb', 'ddb', 'db'], caps: { schemas: 'schema', aiReadOnly: false } }),
  engine('libsql', 'LibSQL / Turso', 'sqlite', { fields: 'url', caps: { manualMode: false } }),
]

const BY_ID = new Map(ENGINES.map((e) => [e.id, e]))

export function engineOf(id) {
  return BY_ID.get(id) || null
}

export const capsOf = (id) => engineOf(id)?.caps || { ...BASE }
