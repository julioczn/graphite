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
//
// fields: what the connection form asks for ('server' = host/port/user/
// password/database/ssl, 'file' = a local file, 'url' = URL + auth token).
// status: 'stable' (tested against a real server) or 'beta' (best effort).

const BASE = {
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
  engine('sqlite', 'SQLite', 'sqlite', { fields: 'file', caps: { backup: true } }),
  engine('libsql', 'LibSQL / Turso', 'sqlite', { fields: 'url', caps: { manualMode: false } }),
]

const BY_ID = new Map(ENGINES.map((e) => [e.id, e]))

export function engineOf(id) {
  return BY_ID.get(id) || null
}

export const capsOf = (id) => engineOf(id)?.caps || { ...BASE }
