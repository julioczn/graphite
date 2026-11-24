// Beekeeper Studio: app.db (SQLite) in its user data folder. Saved passwords
// are encrypted with simple-encryptor (AES-256-CBC + HMAC) under a key kept in
// the ".key" file next to it, itself encrypted with the key in Beekeeper's
// source. Favorite queries become saved queries.
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { HOME, APPDATA, exists, makeConn, t } = require("./common.cjs");

const DEFAULT_KEY = "38782F413F442A472D4B6150645367566B59703373367639792442264529482B";

// simple-encryptor: hex HMAC (64) + hex IV (32) + base64 AES-256-CBC, key = sha256(keyString).
function decrypt(keyString, s) {
  if (typeof s !== "string" || s.length < 97 || !/^[0-9a-f]{96}/i.test(s)) return null;
  try {
    const key = crypto.createHash("sha256").update(keyString).digest();
    const mac = crypto.createHmac("sha256", key).update(s.slice(64)).digest("hex");
    if (mac !== s.slice(0, 64).toLowerCase()) return null;
    const d = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(s.slice(64, 96), "hex"));
    const out = Buffer.concat([d.update(Buffer.from(s.slice(96), "base64")), d.final()]).toString("utf8");
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  } catch {
    return null;
  }
}

const TYPES = {
  postgresql: "postgres", psql: "postgres", postgres: "postgres", mysql: "mysql", mariadb: "mariadb", tidb: "tidb", starrocks: "starrocks",
  sqlite: "sqlite", sqlserver: "sqlserver", mssql: "sqlserver", greengage: "greengage", scylladb: "scylladb",
  redshift: "redshift", cockroachdb: "cockroachdb", oracle: "oracle", cassandra: "cassandra", bigquery: "bigquery",
  firebird: "firebird", clickhouse: "clickhouse", libsql: "libsql", duckdb: "duckdb", mongodb: "mongodb",
  surrealdb: "surrealdb", redis: "redis", trino: "trino", snowflake: "snowflake", dynamodb: "dynamodb",
};
const json = (s) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

module.exports = {
  id: "beekeeper",
  label: "Beekeeper Studio",
  candidates: () => [
    path.join(APPDATA(), "beekeeper-studio", "app.db"),
    path.join(HOME(), ".var", "app", "io.beekeeperstudio.Studio", "config", "beekeeper-studio", "app.db"),
    path.join(HOME(), "snap", "beekeeper-studio", "current", ".config", "beekeeper-studio", "app.db"),
  ],
  match: (file, head) => head.subarray(0, 15).toString("latin1") === "SQLite format 3" && /beekeeper/i.test(file),
  async read(file) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      let key = null;
      const keyFile = path.join(path.dirname(file), ".key");
      if (await exists(keyFile)) key = decrypt(DEFAULT_KEY, fs.readFileSync(keyFile, "utf8").trim())?.encryptionKey || null;
      const has = (table) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table);
      if (!has("saved_connection")) throw new Error(t("Este arquivo não parece ser do Beekeeper Studio."));
      const folders = has("connection_folder") ? new Map(db.prepare("select id, name from connection_folder").all().map((f) => [f.id, f.name])) : new Map();
      const connections = db.prepare("select * from saved_connection order by position, name").all().map((c) => {
        const type = TYPES[c.connectionType];
        const secret = (v) => (v ? (key && decrypt(key, v)) || "" : "");
        const f = {
          name: c.name, type, engineLabel: c.connectionType, folder: folders.get(c.connectionFolderId) || "",
          host: c.host, port: c.port, user: c.username, database: c.defaultDatabase,
          password: secret(c.password), socket: !!c.socketPathEnabled,
          ssh: c.sshEnabled
            ? {
                host: c.sshHost, port: c.sshPort, user: c.sshUsername,
                auth: { keyfile: "key", agent: "agent", userpass: "password" }[c.sshMode],
                keyFile: c.sshKeyfile, secret: c.sshMode === "keyfile" ? secret(c.sshKeyfilePassword) : secret(c.sshPassword),
              }
            : false,
          ssl: !!c.ssl, sslMode: c.ssl ? (c.sslRejectUnauthorized ? "verify-full" : "require") : undefined,
          sslCa: c.sslCaFile, sslCert: c.sslCertFile, sslKey: c.sslKeyFile,
          file: c.path || c.defaultDatabase, url: secret(c.url),
        };
        if (type === "libsql") Object.assign(f, { url: f.url || json(c.libsqlOptions).url || c.host, file: undefined });
        if (type === "bigquery") {
          const o = json(c.bigQueryOptions);
          Object.assign(f, { keyFile: o.keyFilename || o.keyFile, project: o.projectId, database: c.defaultDatabase });
        }
        if (type === "snowflake") {
          const o = json(c.snowflakeOptions);
          Object.assign(f, { account: o.account || c.host, warehouse: o.warehouse, role: o.role });
        }
        if (type === "surrealdb") {
          const o = json(c.surrealDbOptions);
          Object.assign(f, { namespace: o.namespace, url: f.url || (c.host ? `${o.protocol || (c.ssl ? "https" : "http")}://${c.host}${c.port ? ":" + c.port : ""}` : "") });
        }
        if (type === "dynamodb") {
          const o = json(c.dynamoDbOptions || c.iamAuthOptions);
          Object.assign(f, { region: o.region, accessKey: o.accessKeyId, endpoint: f.url || o.endpoint, password: f.password || o.secretAccessKey });
        }
        return makeConn(f);
      });
      const queries = has("favorite_query")
        ? db.prepare("select title, text from favorite_query order by position, title").all().filter((q) => q.text?.trim()).map((q) => ({ title: q.title || t("Consulta importada"), sql: q.text }))
        : [];
      return { connections, queries };
    } finally {
      db.close();
    }
  },
};
module.exports.decrypt = decrypt;
