// JetBrains DataGrip and the IntelliJ database tools: dataSources.xml (shared:
// name, driver, JDBC URL) plus dataSources.local.xml next to it (the user
// name). Passwords live in the system keychain and stay there. Global data
// sources sit in the IDE's config folder; project ones in <project>/.idea.
const path = require("node:path");
const { HOME, APPDATA, exists, subdirs, readText, fromUrl, makeConn, t } = require("./common.cjs");
const { parseXml, findAll, kid, textOf } = require("./xml.cjs");

const DRIVERS = [
  [/redshift/, "redshift"], [/cockroach/, "cockroachdb"], [/greenplum/, "greengage"], [/postgres/, "postgres"],
  [/maria/, "mariadb"], [/mysql/, "mysql"], [/sqlite/, "sqlite"], [/duckdb/, "duckdb"],
  [/sqlserver|azure/, "sqlserver"], [/oracle/, "oracle"], [/clickhouse/, "clickhouse"], [/trino|presto/, "trino"],
  [/cassandra/, "cassandra"], [/snowflake/, "snowflake"], [/bigquery/, "bigquery"], [/mongo/, "mongodb"], [/redis/, "redis"], [/firebird/, "firebird"],
];
const typeOf = (ref) => DRIVERS.find(([re]) => re.test(String(ref || "").toLowerCase()))?.[1] || null;

async function configDirs() {
  // ~/Library/Application Support/JetBrains/<Product><version>, %APPDATA%\JetBrains\…, ~/.config/JetBrains/…
  const roots = [path.join(APPDATA(), "JetBrains"), path.join(HOME(), "Library", "Application Support", "JetBrains")];
  const out = new Set();
  for (const r of roots) for (const d of await subdirs(r)) out.add(d);
  return [...out];
}

module.exports = {
  id: "datagrip",
  label: "DataGrip",
  formats: ["DataGrip / IntelliJ (dataSources.xml)"],
  async candidates() {
    const out = [];
    const dirs = await configDirs();
    // newest IDE versions first
    dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      for (const f of [path.join(d, "options", "dataSources.xml"), path.join(d, "projects", "default", ".idea", "dataSources.xml")]) if (await exists(f)) out.push(f);
      for (const p of await subdirs(path.join(d, "projects"))) {
        const f = path.join(p, ".idea", "dataSources.xml");
        if (await exists(f)) out.push(f);
      }
    }
    for (const p of await subdirs(path.join(HOME(), "DataGripProjects"))) {
      const f = path.join(p, ".idea", "dataSources.xml");
      if (await exists(f)) out.push(f);
    }
    return out;
  },
  match: (file, head, text) => /dataSources(\.local)?\.xml$/i.test(path.basename(file)) || (/<data-source\b/.test(text) && /<jdbc-url>|<driver-ref>/.test(text)),
  async read(file) {
    let mainFile = file;
    if (/dataSources\.local\.xml$/i.test(file)) mainFile = file.replace(/dataSources\.local\.xml$/i, "dataSources.xml");
    const doc = parseXml(await readText(mainFile));
    const sources = findAll(doc, "data-source");
    if (!sources.length) throw new Error(t("Este arquivo não parece ser do DataGrip."));
    // user names from dataSources.local.xml, by uuid
    // per-user parts (user name, SSH, SSL) from dataSources.local.xml, by uuid
    const local = new Map();
    const localFile = path.join(path.dirname(mainFile), "dataSources.local.xml");
    if (await exists(localFile)) {
      for (const ds of findAll(parseXml(await readText(localFile)), "data-source")) {
        const on = (name) => textOf(kid(kid(ds, name), "enabled")) === "true";
        local.set(ds.attrs.uuid || ds.attrs.name, { user: textOf(kid(ds, "user-name")), ssh: on("ssh-properties"), ssl: on("ssl-config") });
      }
    }
    const connections = sources.map((ds) => {
      const name = ds.attrs.name || "";
      const url = textOf(kid(ds, "jdbc-url"));
      const ref = textOf(kid(ds, "driver-ref"));
      const loc = local.get(ds.attrs.uuid) || local.get(name) || {};
      const user = loc.user || textOf(kid(ds, "user-name"));
      const folder = ds.attrs["group-name"] || "";
      const ssh = !!loc.ssh;
      const type = typeOf(ref);
      if (!url) return makeConn({ name, type, engineLabel: ref, folder, user, ssh });
      let c = fromUrl(name, url, { user, folder, ssh, notes: [], ...(loc.ssl ? { ssl: true } : {}) });
      if (type && c.type !== type && !c.skip && c.config) c = makeConn({ ...c.config, name, type, folder, ssh, notes: c.notes });
      // passwords live in the IDE's credential store (keychain / KeePass)
      return { ...c, passwordElsewhere: !c.skip && !c.config?.file };
    });
    return { connections, queries: [] };
  },
};
