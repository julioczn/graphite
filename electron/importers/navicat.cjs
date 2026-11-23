// Navicat: the .ncx file from "Export Connections". Passwords in it are
// encrypted with the fixed AES-128-CBC key and IV of Navicat 12 and later
// (documented by the open-source decryptors); files from older versions use
// Blowfish and their passwords are left behind.
const crypto = require("node:crypto");
const { readText, makeConn, t } = require("./common.cjs");
const { parseXml, findAll } = require("./xml.cjs");

const KEY = Buffer.from("libcckeylibcckey");
const IV = Buffer.from("libcciv libcciv ");

function decrypt(hex) {
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 32) return "";
  try {
    const d = crypto.createDecipheriv("aes-128-cbc", KEY, IV);
    return Buffer.concat([d.update(Buffer.from(hex, "hex")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

const TYPES = {
  MYSQL: "mysql", MARIADB: "mariadb", PGSQL: "postgres", POSTGRESQL: "postgres", ORACLE: "oracle", SQLITE: "sqlite",
  MSSQL: "sqlserver", SQLSERVER: "sqlserver", MONGODB: "mongodb", REDIS: "redis", REDSHIFT: "redshift", SNOWFLAKE: "snowflake",
  OCEANBASE: null,
};
const yes = (v) => /^(true|1|yes)$/i.test(String(v || ""));

module.exports = {
  id: "navicat",
  label: "Navicat",
  formats: ["Navicat (.ncx)"],
  candidates: () => [],
  match: (file, head, text) => /\.ncx$/i.test(file) || (/<Connections\b/.test(text) && /\bConnType=/.test(text)),
  async read(file) {
    const conns = findAll(parseXml(await readText(file)), "Connection");
    if (!conns.length) throw new Error(t("Este arquivo não parece ser uma exportação do Navicat."));
    let lost = 0;
    const connections = conns.map(({ attrs: a }) => {
      const kind = String(a.ConnType || "").toUpperCase();
      const type = TYPES[kind];
      const password = yes(a.SavePassword ?? "true") ? decrypt(a.Password) : "";
      if (a.Password && !password) lost++;
      const pgMode = String(a.SSL_PGSSLMode || "").toLowerCase();
      const ssl = yes(a.SSL) && !["disable", "allow", "prefer"].includes(pgMode);
      return makeConn({
        name: a.ConnectionName, type, engineLabel: a.ConnType,
        host: a.Host, port: a.Port, user: a.UserName, password,
        database: a.Database || a.InitialDatabase || a.ServiceName || a.DatabaseName,
        file: a.DatabaseFileName || a.DatabaseFile,
        ssl, sslMode: ssl ? (["verify-ca", "verify-full"].includes(pgMode) ? pgMode : yes(a.SSL_VerifyCACert) ? "verify-full" : "require") : undefined,
        sslCa: a.SSL_CACert, sslCert: a.SSL_ClientCert, sslKey: a.SSL_ClientKey,
        ssh: yes(a.SSH), notes: yes(a.HTTP) ? [t("Usava túnel HTTP do Navicat, que o Graphite não tem.")] : [],
      });
    });
    const warnings = lost ? [t("{n} senha não pôde ser lida (exportação de uma versão antiga do Navicat).|{n} senhas não puderam ser lidas (exportação de uma versão antiga do Navicat).", { n: lost })] : [];
    return { connections, queries: [], warnings };
  },
};
module.exports.decrypt = decrypt;
