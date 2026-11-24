// MySQL Workbench: connections.xml (GRT format). Passwords are in the system
// keychain (or Workbench's vault) and stay there.
const path = require("node:path");
const { HOME, APPDATA, readText, makeConn, t } = require("./common.cjs");
const { parseXml, findAll, kids, textOf } = require("./xml.cjs");

// <value type="dict" key="parameterValues"><value type="string" key="hostName">…
const dictOf = (el) => Object.fromEntries(kids(el, "value").filter((v) => v.attrs.key).map((v) => [v.attrs.key, textOf(v)]));

module.exports = {
  id: "workbench",
  label: "MySQL Workbench",
  formats: ["MySQL Workbench (connections.xml)"],
  candidates: () => [
    path.join(HOME(), "Library", "Application Support", "MySQL", "Workbench", "connections.xml"),
    path.join(HOME(), ".mysql", "workbench", "connections.xml"),
    path.join(APPDATA(), "MySQL", "Workbench", "connections.xml"),
  ],
  match: (file, head, text) => /db\.mgmt\.Connection/.test(text),
  async read(file) {
    const doc = parseXml(await readText(file));
    const conns = findAll(doc, "value").filter((v) => v.attrs["struct-name"] === "db.mgmt.Connection");
    if (!conns.length) throw new Error(t("Este arquivo não parece ser do MySQL Workbench."));
    const connections = conns.map((c) => {
      const own = Object.fromEntries(kids(c).filter((v) => v.attrs.key && v.attrs.type !== "dict").map((v) => [v.attrs.key, textOf(v)]));
      const params = dictOf(kids(c, "value").find((v) => v.attrs.key === "parameterValues"));
      const driver = textOf(kids(c, "link").find((l) => l.attrs.key === "driver"));
      // useSSL: 0 no, 1 if available, 2 require, 3 verify CA, 4 verify identity
      const level = Number(params.useSSL || 0);
      const ssl = level >= 2;
      return makeConn({
        name: own.name,
        type: "mysql",
        host: params.hostName || "127.0.0.1",
        port: params.port,
        user: params.userName,
        database: params.schema,
        ssl,
        sslMode: level === 4 ? "verify-full" : level === 3 ? "verify-ca" : ssl ? "require" : undefined,
        sslCa: params.sslCA,
        sslCert: params.sslCert,
        sslKey: params.sslKey,
        ssh: /sshtun/.test(driver) || params.sshHost
          ? params.sshHost
            ? { host: String(params.sshHost).split(":")[0], port: String(params.sshHost).split(":")[1], user: params.sshUserName, auth: params.sshKeyFile ? "key" : "password", keyFile: params.sshKeyFile }
            : true
          : false,
        socket: /socket/.test(driver),
        passwordElsewhere: true,
      });
    });
    return { connections, queries: [] };
  },
};
