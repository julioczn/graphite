// VS Code's SQLTools extension ("sqltools.connections") and Azure Data Studio
// ("datasource.connections"), both in the editor's user settings.json. Also
// VS Code forks that share the format (Insiders, VSCodium, Cursor, Windsurf).
const path = require("node:path");
const { APPDATA, readText, parseJsonc, makeConn, fromUrl, t } = require("./common.cjs");

const EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf", "azuredatastudio"];

const SQLTOOLS = {
  postgresql: "postgres", pg: "postgres", mysql: "mysql", mariadb: "mariadb", sqlite: "sqlite", mssql: "sqlserver",
  oracledb: "oracle", oracle: "oracle", cassandra: "cassandra", snowflake: "snowflake", clickhouse: "clickhouse",
  cockroachdb: "cockroachdb", redshift: "redshift", awsredshift: "redshift", tidb: "tidb", saphana: null, trino: "trino", duckdb: "duckdb", libsql: "libsql", firebird: "firebird",
};
const ADS = { mssql: "sqlserver", "mssql-cms": "sqlserver", pgsql: "postgres", mysql: "mysql" };

function sqltools(c) {
  const driver = String(c.driver || "").toLowerCase().replace(/\s+/g, "");
  const type = SQLTOOLS[driver];
  const ssh = c.ssh === "Enabled";
  if (c.connectString) {
    const conn = fromUrl(c.name, c.connectString, { user: c.username, folder: c.group || "", ssh });
    if (type && conn.config && conn.type !== type) return makeConn({ ...conn.config, name: c.name, type, folder: c.group || "", ssh, password: conn.password, notes: conn.notes });
    return conn;
  }
  const notes = [];
  const ssl = c.pgOptions?.ssl || c.mysqlOptions?.ssl || c.mssqlOptions?.encrypt;
  return makeConn({
    name: c.name, type, engineLabel: c.driver, folder: c.group || "",
    host: c.server || c.host, port: c.port, user: c.username || c.user, database: c.database,
    file: type === "sqlite" || type === "duckdb" ? c.database : undefined,
    password: c.askForPassword ? "" : c.password,
    // neither a password nor "ask": SQLTools keeps it in VS Code's secret storage
    passwordElsewhere: !c.askForPassword && c.password == null,
    ssh,
    ssl: !!ssl, sslMode: ssl ? (ssl?.rejectUnauthorized === false || c.mssqlOptions?.trustServerCertificate ? "require" : "verify-full") : undefined,
    socket: c.connectionMethod === "Socket File",
    notes,
  });
}

function ads(c, groups) {
  const o = c.options || {};
  const type = ADS[String(c.providerName || "").toLowerCase()];
  const notes = [];
  if (o.authenticationType && !/sqllogin|sql_login|^$/i.test(o.authenticationType)) notes.push(t("Usa autenticação {mode}; o Graphite conecta com usuário e senha.", { mode: o.authenticationType }));
  // SQL Server: server "host,port"; PostgreSQL / MySQL: host, port, dbname, sslmode
  const [host, port] = String(o.host || o.server || "").split(/[,:](?=\d+$)/);
  const pgMode = String(o.sslmode || "").toLowerCase().replace("_", "-");
  const tls = type === "sqlserver"
    ? { ssl: /true|mandatory|strict/i.test(String(o.encrypt ?? "")), sslMode: /true/i.test(String(o.trustServerCertificate ?? "")) ? "require" : "verify-full" }
    : ["require", "verify-ca", "verify-full"].includes(pgMode) ? { ssl: true, sslMode: pgMode } : { ssl: false };
  return makeConn({
    name: o.connectionName || o.server || o.host, type, engineLabel: c.providerName, folder: groups.get(c.groupId) || "",
    host, port: o.port || port, user: o.user, database: o.dbname || o.database,
    ...tls,
    // Azure Data Studio keeps saved passwords in the system keychain
    passwordElsewhere: !!(c.savePassword ?? o.savePassword),
    notes,
  });
}

module.exports = {
  id: "vscode",
  label: "VS Code / Azure Data Studio",
  formats: ["VS Code SQLTools / Azure Data Studio (settings.json)"],
  candidates: () => EDITORS.map((e) => path.join(APPDATA(), e, "User", "settings.json")),
  match: (file, head, text) => /"sqltools\.connections"|"datasource\.connections"/.test(text),
  async read(file) {
    const s = parseJsonc(await readText(file)) || {};
    const groups = new Map((s["datasource.connectionGroups"] || []).map((g) => [g.id, g.name === "ROOT" ? "" : g.name]));
    const connections = [...(s["sqltools.connections"] || []).map(sqltools), ...(s["datasource.connections"] || []).map((c) => ads(c, groups))];
    if (!connections.length && !("sqltools.connections" in s) && !("datasource.connections" in s)) throw new Error(t("Nenhuma conexão do SQLTools ou do Azure Data Studio neste arquivo."));
    // ".../<Editor>/User/settings.json" names the editor; a loose file is named by its content
    const editor = path.basename(path.dirname(file)) === "User" ? path.basename(path.dirname(path.dirname(file))) : null;
    const label =
      editor === "azuredatastudio" || (!editor && !s["sqltools.connections"]) ? "Azure Data Studio"
        : editor && editor !== "Code" ? `${editor} (SQLTools)` : "VS Code (SQLTools)";
    return { connections, queries: [], label };
  },
};
