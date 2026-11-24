// Sequel Ace (and Sequel Pro before it): Favorites.plist, a tree of groups
// and favorites. Passwords are in the macOS keychain and stay there.
const path = require("node:path");
const { HOME, makeConn, t } = require("./common.cjs");
const { readPlist } = require("./plist.cjs");

function walk(node, folder, out) {
  for (const c of node?.Children || []) {
    if (Array.isArray(c.Children)) walk(c, [folder, c.Name || c.name].filter(Boolean).join(" / "), out);
    else out.push({ ...c, folder });
  }
}

module.exports = {
  id: "sequelace",
  label: "Sequel Ace",
  formats: ["Sequel Ace / Sequel Pro (Favorites.plist)"],
  candidates: () => [
    path.join(HOME(), "Library", "Containers", "com.sequel-ace.sequel-ace", "Data", "Library", "Application Support", "Sequel Ace", "Data", "Favorites.plist"),
    path.join(HOME(), "Library", "Application Support", "Sequel Pro", "Data", "Favorites.plist"),
  ],
  match: (file, head, text) => /Favorites\.plist$/i.test(file) || /Favorites Root/.test(text),
  async read(file) {
    const doc = await readPlist(file);
    const root = doc?.["Favorites Root"];
    if (!root) throw new Error(t("Este arquivo não parece ser do Sequel Ace."));
    const favs = [];
    walk(root, "", favs);
    const connections = favs.map((f) => {
      const type = Number(f.type ?? 0); // 0 TCP, 1 socket, 2 SSH
      const ssl = !!Number(f.useSSL || 0);
      return makeConn({
        name: f.name, type: "mysql", folder: f.folder,
        host: f.host || "127.0.0.1", port: f.port, user: f.user, database: f.database,
        ssl, sslMode: ssl ? "require" : undefined,
        sslCa: f.sslCACertFileLocationEnabled ? f.sslCACertFileLocation : "",
        sslCert: f.sslCertificateFileLocationEnabled ? f.sslCertificateFileLocation : "",
        sslKey: f.sslKeyFileLocationEnabled ? f.sslKeyFileLocation : "",
        ssh: type === 2
          ? { host: f.sshHost, port: f.sshPort, user: f.sshUser, auth: f.sshKeyLocationEnabled && f.sshKeyLocation ? "key" : "password", keyFile: f.sshKeyLocationEnabled ? f.sshKeyLocation : "" }
          : false,
        socket: type === 1,
        passwordElsewhere: true,
      });
    });
    return { connections, queries: [] };
  },
};
