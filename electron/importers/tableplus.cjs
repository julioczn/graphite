// TablePlus (macOS): Connections.plist, with groups in ConnectionGroups.plist
// next to it. Passwords are in the macOS keychain and stay there.
const path = require("node:path");
const { HOME, exists, makeConn, t } = require("./common.cjs");
const { readPlist } = require("./plist.cjs");

const DRIVERS = {
  postgresql: "postgres", mysql: "mysql", mongo: "mongodb", cockroach: "cockroachdb", cloudflared1: null, vertica: null, elasticsearch: null, mariadb: "mariadb", sqlite: "sqlite", sqlserver: "sqlserver", microsoftsqlserver: "sqlserver",
  redis: "redis", cassandra: "cassandra", mongodb: "mongodb", clickhouse: "clickhouse", redshift: "redshift",
  cockroachdb: "cockroachdb", snowflake: "snowflake", oracle: "oracle", duckdb: "duckdb",
  libsql: "libsql", bigquery: "bigquery", dynamodb: "dynamodb", surrealdb: "surrealdb", tidb: "tidb", trino: "trino", greenplum: "greengage",
};

module.exports = {
  id: "tableplus",
  label: "TablePlus",
  formats: ["TablePlus (Connections.plist)"],
  candidates: () => [
    path.join(HOME(), "Library", "Application Support", "com.tinyapp.TablePlus", "Data", "Connections.plist"),
    path.join(HOME(), "Library", "Application Support", "com.tinyapp.TablePlus-setapp", "Data", "Connections.plist"),
  ],
  match: (file, head, text) => /Connection(s|Groups)\.plist$/i.test(file) || (/<key>ConnectionName<\/key>/.test(text) && /<key>Driver<\/key>/.test(text)),
  async read(file) {
    // picked the groups file: the connections sit next to it
    if (/ConnectionGroups\.plist$/i.test(file)) file = path.join(path.dirname(file), "Connections.plist");
    const list = await readPlist(file);
    if (!Array.isArray(list)) throw new Error(t("Este arquivo não parece ser do TablePlus."));
    // groups nest through their own GroupID
    const groups = new Map();
    const groupFile = path.join(path.dirname(file), "ConnectionGroups.plist");
    if (await exists(groupFile)) {
      try {
        for (const g of (await readPlist(groupFile)) || []) groups.set(g.ID, g);
      } catch {}
    }
    const groupPath = (id, seen = new Set()) => {
      const g = groups.get(id);
      if (!g || seen.has(id)) return "";
      seen.add(id);
      return [groupPath(g.GroupID, seen), g.Name].filter(Boolean).join(" / ");
    };
    const connections = list.map((c) => {
      const driver = String(c.Driver || "");
      const type = DRIVERS[driver.toLowerCase().replace(/[\s_-]+/g, "")];
      // tLSMode — MySQL: 0 preferred, 1 off, 2 required, 3 verify CA, 4 verify identity;
      // PostgreSQL: 0 preferred, 1 off, 2 required, 3 preferred, 4 verify CA, 5 verify full
      const tls = Number(c.tLSMode ?? 0);
      const pg = ["postgres", "redshift", "cockroachdb", "greengage"].includes(type);
      const sslMode = tls === 2 ? "require" : pg ? { 4: "verify-ca", 5: "verify-full" }[tls] : { 3: "verify-ca", 4: "verify-full" }[tls];
      const paths = Array.isArray(c.TlsKeyPaths) ? c.TlsKeyPaths : [];
      const certs = paths.length >= 3 ? { sslKey: paths[0], sslCert: paths[1], sslCa: paths[2] } : paths.length === 1 ? { sslCa: paths[0] } : {};
      return makeConn({
        name: c.ConnectionName, type, engineLabel: driver, folder: groupPath(c.GroupID),
        host: c.DatabaseHost, port: c.DatabasePort, user: c.DatabaseUser, database: c.DatabaseName,
        file: c.DatabasePath, url: c.DatabaseHost && type === "libsql" ? c.DatabaseHost : undefined,
        ssl: !!sslMode, sslMode, ...certs,
        ssh: !!c.isOverSSH, socket: !!c.isUseSocket,
        passwordElsewhere: true,
      });
    });
    return { connections, queries: [] };
  },
};
