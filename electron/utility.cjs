// Utility process: owns every database connection.
// Renderers send { id, name, args } over a MessagePort; we answer with
// "<area>/<action>" convention (conn/listTables, query/run, app/history...).
const path = require("node:path");
const appdb = require("./lib/appdb.cjs");
const { ensureDemo } = require("./lib/demo.cjs");
const { splitStatements, commandOf } = require("./lib/sql.cjs");
const { Session } = require("./lib/session.cjs");
const { startJob, cancelJob } = require("./lib/jobs.cjs");
const { backup } = require("./lib/dump.cjs");
const { restore } = require("./lib/restore.cjs");
const { exportData } = require("./lib/exporter.cjs");
const aiquery = require("./lib/aiquery.cjs");
const i18n = require("../shared/i18n.mjs");
i18n.setLocale(process.env.GRAPHITE_LOCALE || i18n.DEFAULT_LOCALE);
const { t } = i18n;

const { engineOf } = require("../shared/engines.mjs");

// Driver per engine family; engine-specific quirks live inside each driver
// (driver.engine), capabilities come from shared/engines.mjs (driver.caps).
const DRIVERS = {
  sqlite: () => require("./drivers/sqlite.cjs"),
  postgres: () => require("./drivers/postgres.cjs"),
  mysql: () => require("./drivers/mysql.cjs"),
  libsql: () => require("./drivers/libsql.cjs"),
  mssql: () => require("./drivers/mssql.cjs"),
  oracle: () => require("./drivers/oracle.cjs"),
  clickhouse: () => require("./drivers/clickhouse.cjs"),
  trino: () => require("./drivers/trino.cjs"),
  firebird: () => require("./drivers/firebird.cjs"),
  duckdb: () => require("./drivers/duckdb.cjs"),
  snowflake: () => require("./drivers/snowflake.cjs"),
  bigquery: () => require("./drivers/bigquery.cjs"),
  mongo: () => require("./drivers/mongodb.cjs"),
  redis: () => require("./drivers/redis.cjs"),
  cql: () => require("./drivers/cassandra.cjs"),
  partiql: () => require("./drivers/dynamodb.cjs"),
  surql: () => require("./drivers/surrealdb.cjs"),
};
// Rows a query result carries back to the window (the renderer picks the
// limit, see ROW_LIMITS in src/lib/store.js); the rest is only counted.
const DEFAULT_ROWS = 100;
const MAX_ROWS = 50000;
const rowLimit = (n) => Math.min(MAX_ROWS, Math.max(1, Math.floor(Number(n)) || DEFAULT_ROWS));

const userData =
  process.env.GRAPHITE_USER_DATA || path.join(process.cwd(), ".graphite");
const db = appdb.open(userData);
const tunnel = require("./lib/tunnel.cjs");
tunnel.setStore(userData);
const sessions = new Map(); // sId -> Session
let nextSession = 1;

function makeDriver(config) {
  const engine = engineOf(config.type);
  const load = engine && (DRIVERS[engine.id] || DRIVERS[engine.family]);
  if (!load) throw new Error(t("Tipo de conexão não suportado: {type}", { type: config.type }));
  const Driver = load();
  const d = new Driver(config);
  d.engine = engine.id;
  d.caps = { ...engine.caps };
  // Through an SSH tunnel: connect() opens it first (lib/tunnel.cjs).
  if (tunnel.wants(config)) {
    if (!engine.caps.ssh) throw new Error(t("{engine} não suporta túnel SSH.", { engine: engine.label }));
    tunnel.wrap(d, config, engine);
  }
  return d;
}

function session(sId) {
  const s = sessions.get(sId);
  if (!s) throw new Error(t("Conexão não está aberta"));
  return s;
}

const driver = (sId) => session(sId).driver;

// Jobs get their own connection on the same database / schema, so a long
// backup or restore neither blocks the editor nor mixes with its transaction.
async function jobDriver(sId) {
  const s = session(sId);
  const d = makeDriver(s.driver.sourceConfig || s.driver.config);
  await d.connect();
  try {
    const schema = await s.driver.currentSchema();
    if (schema && d.dialect !== "sqlite") await d.useSchema(schema);
  } catch (e) {
    await d.disconnect();
    throw e;
  }
  return d;
}

function withJobDriver(sId, fn) {
  return async (job) => {
    const d = await jobDriver(sId);
    try {
      return await fn(d, job);
    } finally {
      await d.disconnect();
    }
  };
}

// Apply staged edits / deletes. Every change names its own table, so a query
// result built from a join can write to several tables in one go.
// change: { kind: 'update', table, schema, pk: {col: val}, column, value }
//       | { kind: 'delete', table, schema, pk }
function applyChanges(s, changes) {
  const d = s.driver;
  // Non-SQL engines (MongoDB, Redis) apply grid edits with their own commands.
  if (d.applyChanges) return s.lock(() => d.applyChanges(changes));
  return s.lock(() =>
    s.atomic(async () => {
      let affected = 0;
      for (const ch of changes) {
        const params = [];
        const bind = (v) => (params.push(v), d.placeholder(params.length));
        const from = d.qualified(ch.table, ch.schema);
        const set =
          ch.kind === "update"
            ? `${d.quote(ch.column)} = ${bind(ch.value)}`
            : null;
        const where = Object.entries(ch.pk)
          .map(([k, v]) =>
            v === null ? `${d.quote(k)} is null` : `${d.quote(k)} = ${bind(v)}`,
          )
          .join(" and ");
        const sql = set
          ? `update ${from} set ${set} where ${where}`
          : `delete from ${from} where ${where}`;
        const r = await d.execute(sql, params);
        // The key must hit exactly one row; anything else means the row changed
        // underneath us (or the key value did not round-trip), so undo it all.
        if (r.affected !== 1) {
          const key = Object.entries(ch.pk)
            .map(([k, v]) => `${k} = ${v}`)
            .join(", ");
          throw new Error(
            t("{cmd} em {table} ({key}) afetou {affected} linhas em vez de 1. Nada foi aplicado.", {
              cmd: ch.kind === "update" ? "UPDATE" : "DELETE",
              table: ch.table,
              key,
              affected: r.affected,
            }),
          );
        }
        affected += r.affected;
      }
      return affected;
    }, changes.length),
  );
}

const handlers = {
  ...appdb.handlers(db),

  "app/demoPath": () => ensureDemo(userData),

  "conn/test": async ({ config }) => {
    const d = makeDriver(config);
    await d.connect();
    try {
      const version = await d.version();
      const via = d.tunnelInfo?.();
      if (!via) return version;
      const key = via.hostKey?.isNew ? " " + t("(chave do servidor registrada: {fingerprint})", { fingerprint: via.hostKey.fingerprint }) : "";
      return `${version} · ${t("via túnel SSH {via}", { via: via.via })}${key}`;
    } finally {
      await d.disconnect();
    }
  },

  "conn/open": async ({ config, autoCommit = true }) => {
    const d = makeDriver(config);
    await d.connect();
    const s = new Session(d);
    try {
      // A remembered "manual" mode doesn't apply to engines without it.
      await s.setAutoCommit(autoCommit || !d.caps.manualMode);
    } catch (e) {
      await d.disconnect();
      throw e;
    }
    const sId = String(nextSession++);
    sessions.set(sId, s);
    return {
      sId,
      version: await d.version(),
      database: await d.database(),
      schema: await d.currentSchema(),
      dialect: d.dialect,
      engine: d.engine,
      caps: d.caps,
      tx: s.tx,
    };
  },

  "conn/close": async ({ sId }) => {
    const s = sessions.get(sId);
    sessions.delete(sId);
    await s?.driver.disconnect();
  },

  "conn/listTables": ({ sId, schema }) => driver(sId).listTables(schema),
  "conn/listSchemas": ({ sId }) => driver(sId).listSchemas(),
  "conn/useSchema": ({ sId, schema }) => {
    const s = session(sId);
    return s.lock(async () => {
      // search_path is transactional in PostgreSQL: a later rollback would undo the switch.
      if (s.inTx && s.driver.dialect === "postgres")
        throw new Error(
          t("Há uma transação aberta: faça commit ou rollback antes"),
        );
      await s.driver.useSchema(schema);
      s.pkCache.clear();
      return {
        schema: await s.driver.currentSchema(),
        database: await s.driver.database(),
      };
    });
  },
  "conn/listColumns": ({ sId, table, schema }) =>
    driver(sId).listColumns(table, schema),
  "conn/listIndexes": ({ sId, table, schema }) =>
    driver(sId).listIndexes(table, schema),
  "conn/schemaMap": ({ sId }) => driver(sId).schemaMap(),
  "conn/createScript": ({ sId, table, schema }) =>
    driver(sId).createScript(table, schema),

  // Transaction control.
  "tx/state": ({ sId }) => session(sId).tx,
  "tx/setAutoCommit": ({ sId, on }) => {
    const s = session(sId);
    return s.lock(async () => (await s.setAutoCommit(!!on), s.tx));
  },
  "tx/commit": ({ sId }) => {
    const s = session(sId);
    return s.lock(async () => (await s.commit(), s.tx));
  },
  "tx/rollback": ({ sId }) => {
    const s = session(sId);
    return s.lock(async () => (await s.rollback(), s.tx));
  },

  // Run a script: every statement in order, stop at the first error.
  // Result sets that map back to a table carry `edit` (see Session.editInfo).
  "query/run": ({ sId, sql, limit }) => {
    const s = session(sId);
    const max = rowLimit(limit);
    return s.lock(async () => {
      const statements = splitStatements(sql, s.driver.dialect);
      const results = [];
      for (const st of statements) {
        const t0 = performance.now();
        try {
          const r = await s.run(st.text);
          const durationMs = Math.round(performance.now() - t0);
          if (r.fields) {
            const truncated = r.rows.length > max;
            const edit = await s
              .editInfo(r.fields, r.origins)
              .catch(() => null);
            if (edit)
              for (const c of r.binary || [])
                if (edit.columns[c]) edit.columns[c] = null;
            if (edit)
              edit.tables = edit.tables.filter(
                (t) => !t.pk.some((k) => r.binary?.includes(k.index)),
              );
            results.push({
              kind: "rows",
              sql: st.text,
              command: commandOf(st.text),
              fields: r.fields,
              rows: truncated ? r.rows.slice(0, max) : r.rows,
              rowCount: r.rows.length,
              truncated,
              durationMs,
              edit: edit && edit.tables.length ? edit : null,
            });
          } else {
            results.push({
              kind: "affected",
              sql: st.text,
              command: commandOf(st.text),
              affected: r.affected,
              durationMs,
            });
          }
        } catch (e) {
          results.push({
            kind: "error",
            sql: st.text,
            message: e.message,
            durationMs: Math.round(performance.now() - t0),
          });
          break;
        }
      }
      return { results, tx: s.tx };
    });
  },

  // SQL from an AI agent (see lib/aiquery.cjs). mode 'read' never writes: it
  // answers { needsApproval } when a statement isn't a read; the main process
  // asks the user and comes back with mode 'write'.
  "ai/query": ({ sId, sql, mode, maxRows }) => {
    const s = session(sId);
    return s.lock(() => aiquery.run(s.driver, sql, { mode, maxRows }));
  },
  "ai/classify": ({ sId, sql }) => aiquery.classify(sql, driver(sId).dialect, driver(sId).caps),

  // ER diagram model of the current database / schema.
  "er/model": async ({ sId }) => {
    const d = driver(sId);
    return d.erModel(await d.currentSchema());
  },

  "backup/start": async (args, { port }) => {
    const s = session(args.sId);
    const current = await s.driver.currentSchema();
    const schemas =
      s.driver.dialect === "postgres"
        ? args.schemas?.length
          ? args.schemas
          : [current]
        : undefined;
    const label =
      s.driver.dialect === "sqlite"
        ? path.basename(s.driver.config.file)
        : current || (await s.driver.database());
    return startJob(
      port,
      { kind: "backup", title: t("Backup de {name}", { name: label }) },
      withJobDriver(args.sId, (d, job) =>
        backup(
          d,
          {
            file: args.file,
            gzip: !!args.gzip,
            structure: args.structure !== false,
            data: args.data !== false,
            drop: args.drop !== false,
            tables: args.tables?.length ? args.tables : null,
            schemas,
          },
          job,
        ),
      ),
    );
  },

  "restore/start": async (args, { port }) => {
    session(args.sId);
    return startJob(
      port,
      { kind: "restore", title: t("Restauração de {name}", { name: path.basename(args.file) }) },
      withJobDriver(args.sId, (d, job) =>
        restore(
          d,
          {
            file: args.file,
            transaction: !!args.transaction,
            stopOnError: args.stopOnError !== false,
          },
          job,
        ),
      ),
    );
  },

  "export/start": async (args, { port }) => {
    session(args.sId);
    const format = args.format.toUpperCase();
    const title = args.query
      ? t("Exportar consulta ({format})", { format })
      : args.tables.length === 1
        ? t("Exportar {name} ({format})", { name: args.tables[0].name, format })
        : t("Exportar {n} tabelas ({format})", { n: args.tables.length, format });
    return startJob(
      port,
      {
        kind: "export",
        title,
      },
      withJobDriver(args.sId, (d, job) => exportData(d, args, job)),
    );
  },

  "job/cancel": ({ jobId }) => cancelJob(jobId),

  "query/apply": async ({ sId, changes }) => {
    const s = session(sId);
    const affected = await applyChanges(s, changes);
    return { affected, tx: s.tx };
  },

  // Paged table browsing with optional raw WHERE filter and ordering.
  "table/page": ({
    sId,
    table,
    schema,
    limit = 100,
    offset = 0,
    orderBy,
    dir,
    where,
  }) => {
    const d = driver(sId);
    // Non-SQL engines (MongoDB, Redis, CQL…) page through their own API.
    if (d.page) {
      const t0 = performance.now();
      return session(sId).lock(async () => ({
        ...(await d.page({ table, schema, limit: Number(limit), offset: Number(offset), orderBy, dir, where: where?.trim() || "" })),
        durationMs: Math.round(performance.now() - t0),
      }));
    }
    const from = d.qualified(table, schema);
    const filter = where && where.trim() ? ` where ${where}` : "";
    const order = orderBy
      ? ` order by ${d.quote(orderBy)} ${dir === "desc" ? "desc" : "asc"}`
      : "";
    const t0 = performance.now();
    // A bad WHERE must not abort an open PostgreSQL transaction.
    return session(sId).guarded(async () => {
      // Drivers whose SQL has no LIMIT/OFFSET (SQL Server, Oracle) build their own.
      const cols = d.selectList ? await d.selectList(table, schema) : "*";
      const sql = d.pageSql
        ? d.pageSql({ cols, from, filter, order, limit: Number(limit), offset: Number(offset) })
        : `select ${cols} from ${from}${filter}${order} limit ${Number(limit)} offset ${Number(offset)}`;
      const page = await d.execute(sql);
      const count = await d.execute(`select count(*) from ${from}${filter}`);
      return {
        ...page,
        total: Number(count.rows[0][0]),
        durationMs: Math.round(performance.now() - t0),
      };
    });
  },

  "table/apply": async ({ sId, table, schema, changes }) => {
    const s = session(sId);
    const affected = await applyChanges(
      s,
      changes.map((ch) => ({ ...ch, table, schema })),
    );
    return { affected, tx: s.tx };
  },
};

function reply(port, id, payload) {
  try {
    port.postMessage({ id, ...payload });
  } catch (e) {
    port.postMessage({
      id,
      error: { message: t("Resposta não serializável: {error}", { error: e.message }) },
    });
  }
}

function listen(port) {
  port.on("message", async ({ data }) => {
    const { id, name, args } = data;
    const fn = handlers[name];
    if (!fn)
      return reply(port, id, {
        error: { message: t("Operação desconhecida: {name}", { name }) },
      });
    try {
      reply(port, id, { result: await fn(args || {}, { port }) });
    } catch (e) {
      reply(port, id, { error: { message: e.message, code: e.code } });
    }
  });
  port.start();
}

process.parentPort.on("message", ({ data, ports }) => {
  if (data.type === "port" && ports[0]) listen(ports[0]);
  else if (data.type === "locale") i18n.setLocale(data.locale);
});

process.on("uncaughtException", (e) => console.error("[utility] uncaught", e));
process.on("unhandledRejection", (e) =>
  console.error("[utility] unhandled", e),
);
