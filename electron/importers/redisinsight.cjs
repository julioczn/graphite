// RedisInsight (v2): ~/.redis-insight/redisinsight.db, table database_instance.
// Passwords encrypted with a key in the system keychain ("KEYTAR") stay there;
// unencrypted ones ("PLAIN") come along.
const path = require("node:path");
const { HOME, makeConn, t } = require("./common.cjs");

module.exports = {
  id: "redisinsight",
  label: "RedisInsight",
  candidates: () => [path.join(HOME(), ".redis-insight", "redisinsight.db")],
  match: (file, head) => head.subarray(0, 15).toString("latin1") === "SQLite format 3" && /redis-?insight/i.test(file),
  async read(file) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (!db.prepare("select 1 from sqlite_master where name = 'database_instance'").get()) throw new Error(t("Este arquivo não parece ser do RedisInsight."));
      const connections = db
        .prepare("select * from database_instance order by name")
        .all()
        .map((r) => {
          const plain = r.encryption === "PLAIN" || r.encryption == null;
          const notes = [];
          if (r.connectionType && r.connectionType !== "STANDALONE") notes.push(t("Modo {mode} do Redis: o Graphite conecta só ao nó informado.", { mode: r.connectionType.toLowerCase() }));
          return makeConn({
            name: r.name, type: "redis", host: r.host, port: r.port, user: r.username, database: r.db != null ? String(r.db) : "",
            password: plain ? r.password : "", passwordElsewhere: !plain && !!r.password,
            ssl: !!r.tls, sslMode: r.tls ? (r.verifyServerCert ? "verify-full" : "require") : undefined,
            ssh: !!r.ssh, notes,
          });
        });
      return { connections, queries: [] };
    } finally {
      db.close();
    }
  },
};
