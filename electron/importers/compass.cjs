// MongoDB Compass: a file from "Export connections" ({ type: "Compass
// Connections", connections: [...] }), or the app's own Connections/*.json.
// Exports protected with a passphrase, and secrets Compass keeps encrypted by
// the system keychain, stay behind: the connection string comes without them.
const path = require("node:path");
const fs = require("node:fs/promises");
const { APPDATA, isDir, readJson, makeConn, t } = require("./common.cjs");

const DIRS = ["MongoDB Compass", "MongoDB Compass Readonly", "MongoDB Compass Isolated Edition"];

function fromInfo(info) {
  const opts = info.connectionOptions || {};
  const cs = String(opts.connectionString || "");
  let url = cs;
  let user = "";
  let password = "";
  let database = "";
  try {
    const u = new URL(cs);
    user = decodeURIComponent(u.username || "");
    password = decodeURIComponent(u.password || "");
    database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    u.username = "";
    u.password = "";
    url = u.toString();
  } catch {}
  const notes = [];
  const tun = opts.sshTunnel;
  return makeConn({
    name: info.favorite?.name || info.name || url.replace(/^mongodb(\+srv)?:\/\//, "").split(/[/?]/)[0],
    type: "mongodb",
    url,
    user,
    password,
    database,
    folder: info.favorite?.group || "",
    passwordElsewhere: !password && !!info.connectionSecrets,
    // The tunnel's password and passphrase stay in Compass's encrypted secrets.
    ssh: tun ? (tun.host ? { host: tun.host, port: tun.port, user: tun.username, auth: tun.identityKeyFile ? "key" : "password", keyFile: tun.identityKeyFile } : true) : false,
    notes,
  });
}

async function readDir(dir) {
  const all = [];
  for (const f of (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const d = await readJson(path.join(dir, f));
      const info = d.connectionInfo || d;
      if (info.connectionOptions?.connectionString) all.push({ ...info, connectionSecrets: d.connectionSecrets });
    } catch {}
  }
  // "recent" entries are Compass's history; favorites are the saved ones
  const favorites = all.filter((i) => i.savedConnectionType !== "recent");
  return (favorites.length ? favorites : all).map(fromInfo);
}

module.exports = {
  id: "compass",
  label: "MongoDB Compass",
  formats: ["MongoDB Compass (exported JSON)"],
  async candidates() {
    // The folder of saved connections: point at the folder's first file.
    const out = [];
    for (const d of DIRS) {
      const dir = path.join(APPDATA(), d, "Connections");
      if (!(await isDir(dir))) continue;
      const first = (await fs.readdir(dir).catch(() => [])).find((f) => f.endsWith(".json"));
      if (first) out.push(path.join(dir, first));
    }
    return out;
  },
  match: (file, head, text) => /"Compass Connections"/.test(text) || (/"connectionOptions"\s*:/.test(text) && /"connectionString"\s*:/.test(text)),
  async read(file) {
    const doc = await readJson(file);
    if (doc?.type === "Compass Connections" || Array.isArray(doc?.connections)) {
      const warnings = doc.passphrase || doc.connections?.some((c) => typeof c.connectionSecrets === "string") ? [t("Exportação protegida por senha: os segredos não vêm junto.")] : [];
      return { connections: (doc.connections || []).map(fromInfo), queries: [], warnings };
    }
    // a file from Compass's own Connections folder: read the whole folder
    if (path.basename(path.dirname(file)) === "Connections") return { connections: await readDir(path.dirname(file)), queries: [] };
    const info = doc.connectionInfo || doc;
    if (!info.connectionOptions) throw new Error(t("Este arquivo não parece ser do MongoDB Compass."));
    return { connections: [fromInfo(info)], queries: [] };
  },
};
