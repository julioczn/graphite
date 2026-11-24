// DBeaver: <workspace>/<project>/.dbeaver/data-sources*.json, with saved
// credentials in credentials-config.json next to it (AES-128-CBC under a key
// published in DBeaver's source; the first 16 bytes are the IV). SQL scripts
// in <project>/Scripts become saved queries.
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { HOME, APPDATA, XDG_DATA, exists, isDir, subdirs, readJson, makeConn, fromUrl, str, t } = require("./common.cjs");

const KEY = Buffer.from("babb4a9f774ab853c96c2d653dfe544a", "hex");

function decryptCredentials(buf) {
  try {
    const d = crypto.createDecipheriv("aes-128-cbc", KEY, buf.subarray(0, 16));
    const text = Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString("utf8");
    return JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    return {};
  }
}

// provider / driver id → Graphite engine
const RULES = [
  [/sybase/, null],
  [/redshift/, "redshift"], [/cockroach/, "cockroachdb"], [/greenplum|greengage/, "greengage"], [/postgre|pgsql|timescale|supabase|neon|yugabyte|edb/, "postgres"],
  [/maria/, "mariadb"], [/tidb/, "tidb"], [/starrocks/, "starrocks"], [/mysql/, "mysql"],
  [/duckdb/, "duckdb"], [/libsql|turso/, "libsql"], [/sqlite/, "sqlite"],
  [/sqlserver|mssql|microsoft|jtds|azure_sql|synapse/, "sqlserver"], [/oracle/, "oracle"], [/firebird|jaybird/, "firebird"],
  [/clickhouse/, "clickhouse"], [/trino|presto/, "trino"], [/scylla/, "scylladb"], [/cassandra/, "cassandra"],
  [/snowflake/, "snowflake"], [/bigquery/, "bigquery"], [/mongo/, "mongodb"], [/redis|valkey/, "redis"], [/surreal/, "surrealdb"], [/dynamo/, "dynamodb"],
];
const typeOf = (...ids) => {
  const s = ids.filter(Boolean).join(" ").toLowerCase();
  return RULES.find(([re]) => re.test(s))?.[1] || null;
};

async function workspaces() {
  const roots = [
    path.join(HOME(), "Library", "DBeaverData", "workspace6"),
    path.join(XDG_DATA(), "DBeaverData", "workspace6"),
    path.join(APPDATA(), "DBeaverData", "workspace6"),
    path.join(HOME(), ".var", "app", "io.dbeaver.DBeaverCommunity", "data", "DBeaverData", "workspace6"),
    path.join(HOME(), "snap", "dbeaver-ce", "current", ".local", "share", "DBeaverData", "workspace6"),
    path.join(HOME(), ".dbeaver4"), // very old installs
  ];
  const out = [];
  for (const r of roots) if (await isDir(r)) out.push(r);
  return out;
}

// Scripts → saved queries (bounded: a few hundred small files).
async function scripts(projectDir) {
  const out = [];
  async function walk(dir, rel) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 300) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, rel ? `${rel}/${e.name}` : e.name);
      else if (/\.sql$/i.test(e.name)) {
        const st = await fs.stat(p).catch(() => null);
        if (!st || st.size > 256 * 1024) continue;
        const sql = await fs.readFile(p, "utf8").catch(() => "");
        if (sql.trim()) out.push({ title: (rel ? rel + "/" : "") + e.name.replace(/\.sql$/i, ""), sql });
      }
    }
  }
  await walk(path.join(projectDir, "Scripts"), "");
  return out;
}

function sslOf(handlers = {}) {
  for (const [id, h] of Object.entries(handlers)) {
    if (!/ssl/i.test(id) || !h?.enabled) continue;
    const p = h.properties || {};
    // postgre_ssl: sslMode disable…verify-full; mysql_ssl: ssl.verify.server
    const mode = String(p.sslMode || "").toLowerCase();
    if (["disable", "allow", "prefer"].includes(mode)) return { ssl: false };
    const verify = String(p["ssl.verify.server"] ?? "") === "true";
    return {
      ssl: true,
      sslMode: mode === "verify-full" ? "verify-full" : mode === "verify-ca" ? "verify-ca" : verify ? "verify-full" : "require",
      sslCa: p["ssl.ca.cert"] || p.rootCert || "",
      sslCert: p["ssl.client.cert"] || p.clientCert || "",
      sslKey: p["ssl.client.key"] || p.clientKey || "",
    };
  }
  return {};
}

// `file` is data-sources.json, normally in <project>/.dbeaver (then every
// data-sources*.json there, the credentials and the project's scripts count);
// a lone copied file works too.
async function readSources(file) {
  const meta = path.dirname(file);
  const inProject = path.basename(meta) === ".dbeaver";
  let files = [path.basename(file)];
  if (inProject) {
    try {
      files = (await fs.readdir(meta)).filter((f) => /^data-sources.*\.json$/.test(f)).sort();
    } catch {}
  }
  // data-sources<suffix>.json pairs with credentials-config<suffix>.json
  const credsFor = async (f) => {
    const credFile = path.join(meta, f.replace(/^data-sources/, "credentials-config"));
    return (await exists(credFile)) ? decryptCredentials(await fs.readFile(credFile)) : null;
  };
  const connections = [];
  let recognized = false;
  let anyCreds = false;
  for (const f of files) {
    const creds = await credsFor(f);
    if (creds) anyCreds = true;
    let doc;
    try {
      doc = await readJson(path.join(meta, f));
    } catch {
      continue;
    }
    if (!doc || typeof doc.connections !== "object") continue;
    recognized = true;
    for (const [id, c] of Object.entries(doc.connections)) {
      const cfg = c.configuration || {};
      const cred = creds?.[id]?.["#connection"] || {};
      const user = str(cred.user ?? cfg.user);
      const password = cred.password ?? cfg.password ?? "";
      const handlers = cfg.handlers || {};
      // SSH tunnel: handlers.ssh_tunnel (properties) + credentials "network/ssh_tunnel".
      const tun = handlers.ssh_tunnel?.enabled ? handlers.ssh_tunnel : null;
      const tunCred = creds?.[id]?.["network/ssh_tunnel"] || {};
      const tp = tun?.properties || {};
      const ssh = tun
        ? {
            host: tp.host, port: tp.port, user: tunCred.user ?? tun.user,
            auth: { PASSWORD: "password", PUBLIC_KEY: "key", AGENT: "agent" }[tp.authType] || undefined,
            keyFile: tp.keyPath, secret: tunCred.password ?? tun.password ?? "",
          }
        : Object.entries(handlers).some(([k, h]) => /ssh|proxy/i.test(k) && h?.enabled);
      const folder = c.folder || "";
      const type = typeOf(c.provider, c.driver);
      if ((cfg.configurationType === "URL" || !(cfg.host || cfg.database)) && cfg.url) {
        let conn = fromUrl(c.name, cfg.url, { user, password, folder, ssh });
        // keep the engine DBeaver knew (e.g. MariaDB over a mysql: URL)
        if (type && conn.type !== type && !conn.skip) conn = makeConn({ ...conn.config, name: c.name, type, password, folder, ssh, notes: conn.notes });
        connections.push(conn);
        continue;
      }
      const isFile = type === "sqlite" || type === "duckdb";
      connections.push(
        makeConn({
          name: c.name, type, engineLabel: c.driver || c.provider, folder,
          host: cfg.host, port: cfg.port, user, password, database: cfg.database,
          file: isFile ? cfg.database || String(cfg.url || "").replace(/^jdbc:(sqlite|duckdb):/, "") : undefined,
          url: cfg.url, ssh, ...sslOf(handlers),
        }),
      );
    }
  }
  if (!recognized) throw new Error(t("Este arquivo não parece ser do DBeaver."));
  const warnings = anyCreds ? [] : [t("Sem o credentials-config.json ao lado, usuários e senhas não vêm junto.")];
  return { connections, queries: inProject ? await scripts(path.dirname(meta)) : [], warnings };
}

module.exports = {
  id: "dbeaver",
  label: "DBeaver",
  formats: ["DBeaver (data-sources.json)"],
  async candidates() {
    const out = [];
    for (const ws of await workspaces()) {
      for (const proj of await subdirs(ws)) {
        const f = path.join(proj, ".dbeaver", "data-sources.json");
        if (await exists(f)) out.push(f);
      }
    }
    return out;
  },
  match: (file, head, text) => /data-sources.*\.json$/i.test(path.basename(file)) || (/"connections"\s*:/.test(text) && /"provider"\s*:/.test(text) && /"configuration"\s*:/.test(text)),
  read: readSources,
};
module.exports.decryptCredentials = decryptCredentials;
