// HeidiSQL: the text file from "Export settings" (or portable_settings.txt of
// the portable version). Lines look like
//   Servers\<folder>\<session>\Host<|||>1<|||>127.0.0.1
// Passwords use HeidiSQL's simple reversible encoding (hex bytes shifted by
// the digit at the end), so they come along.
const { readText, makeConn, t } = require("./common.cjs");

// apphelpers.pas decrypt(): the last digit is the salt; "0" there flags the
// Unicode form (4 hex digits per character, the real salt just before it).
function decodePassword(s) {
  if (!s || !/^[0-9a-f]*\d$/i.test(s)) return "";
  let salt = Number(s.at(-1));
  let out = "";
  if (salt === 0) {
    s = s.slice(0, -1);
    salt = Number(s.at(-1));
    for (let j = 0; j + 4 <= s.length - 1; j += 4) {
      let n = parseInt(s.substr(j, 4), 16) - salt;
      if (n < 0) n += 65536;
      out += String.fromCharCode(n);
    }
    return out;
  }
  for (let j = 0; j < s.length - 2; j += 2) {
    let n = parseInt(s.substr(j, 2), 16) - salt;
    if (n < 0) n += 255;
    out += String.fromCharCode(n);
  }
  return out;
}

// TNetType in HeidiSQL's source (dbstructures.pas)
const NET = {
  0: ["mysql"], 1: ["mysql", "socket"], 2: ["mysql", "ssh"], 3: ["sqlserver", "socket"], 4: ["sqlserver"], 5: ["sqlserver"], 6: ["sqlserver"], 7: ["sqlserver"],
  8: ["postgres"], 9: ["postgres", "ssh"], 10: ["sqlite"], 11: ["mysql"], 12: [null, null, "Interbase"], 13: [null, null, "Interbase"], 14: ["firebird"], 15: ["firebird", "local"], 16: ["mysql"],
  17: [null, null, "SQLite (encrypted)"], 18: [null, null, "ClickHouse (MySQL protocol)"],
};

module.exports = {
  id: "heidisql",
  label: "HeidiSQL",
  formats: ["HeidiSQL (exported settings)"],
  candidates: () => [],
  match: (file, head, text) => /<\|\|\|>/.test(text) && /^Servers\\/m.test(text),
  async read(file) {
    const sessions = new Map();
    for (const line of (await readText(file)).split(/\r?\n/)) {
      const parts = line.split("<|||>");
      if (parts.length < 3) continue;
      const m = /^Servers\\(.+)\\([^\\]+)$/.exec(parts[0]);
      if (!m) continue;
      if (!sessions.has(m[1])) sessions.set(m[1], {});
      sessions.get(m[1])[m[2]] = parts.slice(2).join("<|||>");
    }
    const connections = [];
    for (const [key, s] of sessions) {
      if (s.Folder === "1" || (s.Host == null && s.NetType == null)) continue; // a folder
      const [type, how, label] = NET[Number(s.NetType || 0)] || [null, null, `NetType ${s.NetType}`];
      const parts = key.split("\\");
      const host = s.Host ?? "";
      connections.push(
        makeConn({
          name: parts[parts.length - 1], folder: parts.slice(0, -1).join(" / "), type, engineLabel: label,
          host: type === "sqlite" ? "" : host, port: s.Port, user: s.User, password: decodePassword(s.Password),
          database: String(s.Databases || "").split(";")[0], file: type === "sqlite" ? host.split("|")[0] : undefined,
          // SSL_Verification: 0 encrypt only, 1 verify CA, 2 verify identity
          ssl: s.SSL_Active === "1", sslMode: { 1: "verify-ca", 2: "verify-full" }[s.SSL_Verification] || "require",
          sslCa: s.SSL_CA, sslCert: s.SSL_Cert, sslKey: s.SSL_Key,
          ssh: s.SSHtunnelActive === "1" || (how === "ssh" && s.SSHtunnelActive !== "0")
            ? {
                host: s.SSHtunnelHost, port: s.SSHtunnelHostPort, user: s.SSHtunnelUser,
                auth: s.SSHtunnelPrivateKey ? "key" : "password", keyFile: s.SSHtunnelPrivateKey,
                secret: s.SSHtunnelPassword ? decodePassword(s.SSHtunnelPassword) : "",
              }
            : false,
          socket: how === "socket",
        }),
      );
    }
    if (!connections.length) throw new Error(t("Nenhuma sessão do HeidiSQL neste arquivo."));
    return { connections, queries: [] };
  },
};
module.exports.decodePassword = decodePassword;
