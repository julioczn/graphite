// DbGate: connections.jsonl in ~/.dbgate (one JSON object per line). Saved
// passwords are "crypt:" + simple-encryptor output under a key kept in the
// ".key" file of the same folder, itself encrypted with the key in DbGate's
// source (same scheme as Beekeeper Studio).
const path = require("node:path");
const fs = require("node:fs/promises");
const { HOME, exists, readText, makeConn, t } = require("./common.cjs");
const { decrypt } = require("./beekeeper.cjs");

const DEFAULT_KEY = "mQAUaXhavRGJDxDTXSCg7Ej0xMmGCrx6OKA07DIMBiDcYYkvkaXjTAzPUEHEHEf9";

const ENGINES = {
  postgres: "postgres", mysql: "mysql", mariadb: "mariadb", mssql: "sqlserver", sqlite: "sqlite", oracle: "oracle",
  mongo: "mongodb", "mongo-legacy": "mongodb", redis: "redis", clickhouse: "clickhouse", cockroach: "cockroachdb", redshift: "redshift",
  duckdb: "duckdb", cassandra: "cassandra", libsql: "libsql", firebird: "firebird", dynamodb: "dynamodb", tidb: "tidb",
};

async function keyFor(dir) {
  const f = path.join(dir, ".key");
  if (!(await exists(f))) return DEFAULT_KEY;
  const k = decrypt(DEFAULT_KEY, (await fs.readFile(f, "utf8")).trim());
  return k?.encryptionKey || DEFAULT_KEY;
}

module.exports = {
  id: "dbgate",
  label: "DbGate",
  formats: ["DbGate (connections.jsonl)"],
  candidates: () => [path.join(HOME(), ".dbgate", "connections.jsonl")],
  match: (file, head, text) => /connections\.jsonl$/i.test(file) || /"engine"\s*:\s*"[\w-]+@dbgate-plugin/.test(text),
  async read(file) {
    const key = await keyFor(path.dirname(file));
    const secret = (v) => (typeof v === "string" && v.startsWith("crypt:") ? decrypt(key, v.slice(6)) || "" : v || "");
    const rows = (await readText(file))
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && r.engine);
    if (!rows.length) throw new Error(t("Este arquivo não parece ser do DbGate."));
    const connections = rows.map((c) => {
      const engine = String(c.engine).split("@")[0];
      const type = ENGINES[engine];
      const password = secret(c.password);
      if (c.useDatabaseUrl && c.databaseUrl) {
        const conn = require("./common.cjs").fromUrl(c.displayName || c.server, c.databaseUrl, { user: c.user, password, folder: c.parent || "" });
        return conn;
      }
      return makeConn({
        name: c.displayName || c.server || c.databaseFile, type, engineLabel: engine, folder: c.parent || "",
        host: c.server, port: c.port, user: c.user, password, database: c.defaultDatabase,
        file: c.databaseFile, url: c.databaseUrl,
        ssl: !!c.useSsl, sslMode: c.useSsl ? (c.sslRejectUnauthorized ? "verify-full" : "require") : undefined,
        sslCa: c.sslCaFile, sslCert: c.sslCertFile, sslKey: c.sslKeyFile,
        ssh: c.useSshTunnel
          ? {
              host: c.sshHost, port: c.sshPort, user: c.sshLogin,
              auth: { userPassword: "password", keyFile: "key", agent: "agent" }[c.sshMode],
              keyFile: c.sshKeyfile, secret: c.sshMode === "keyFile" ? secret(c.sshKeyfilePassword) : secret(c.sshPassword),
            }
          : false,
      });
    });
    return { connections, queries: [] };
  },
};
