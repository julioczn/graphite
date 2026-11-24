// Shared pieces of the importers: where apps keep their data, and turning what
// another tool saved into a Graphite connection ({ name, type, config,
// password, folder, notes }). Passwords stay in the main process; the preview
// sent to the window only says whether one was found.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { t } = require("../../shared/i18n.mjs");
const { engineOf } = require("../../shared/engines.mjs");
const { parseConnectionUrl } = require("../../shared/connurl.mjs");

const HOME = () => os.homedir();
// Per-user application data: ~/Library/Application Support, %APPDATA%, ~/.config.
const APPDATA = () =>
  process.platform === "darwin"
    ? path.join(HOME(), "Library", "Application Support")
    : process.platform === "win32"
      ? process.env.APPDATA || path.join(HOME(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || path.join(HOME(), ".config");
const LOCALAPPDATA = () => process.env.LOCALAPPDATA || path.join(HOME(), "AppData", "Local");
const XDG_DATA = () => process.env.XDG_DATA_HOME || path.join(HOME(), ".local", "share");

const exists = (p) =>
  fs.stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
const isDir = (p) =>
  fs.stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
async function subdirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}
const readText = (p) => fs.readFile(p, "utf8");
const readJson = async (p) => JSON.parse((await readText(p)).replace(/^﻿/, ""));
// JSON with comments and trailing commas (VS Code settings.json).
function parseJsonc(text) {
  let out = "";
  let i = 0;
  let str = false;
  while (i < text.length) {
    const c = text[i];
    if (str) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') str = false;
      i++;
    } else if (c === '"') {
      str = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1").replace(/^﻿/, "") || "null");
}

const str = (v) => (v == null ? "" : String(v).trim());
const portOf = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : "";
};

// Builds a Graphite connection from loose fields. `type` is a Graphite engine
// id; anything Graphite can't use goes to `notes` (shown in the preview).
// `ssh`: true (the tool used a tunnel, details unknown) or { host, port, user,
// auth: 'password' | 'key' | 'agent', keyFile, secret } → config.ssh, with the
// secret kept apart like the password (`sshSecret`).
function makeConn(f) {
  const type = f.type;
  const e = engineOf(type);
  const name = str(f.name) || str(f.host) || str(f.file) || t("Conexão importada");
  const notes = [...(f.notes || [])];
  if (!e) return { name, type: type || "?", skip: t("Banco não suportado pelo Graphite: {engine}", { engine: f.engineLabel || type || "?" }), notes, folder: f.folder || "" };
  let password = str(f.password) ? String(f.password) : "";
  if (type === "snowflake" && password) {
    // Graphite talks to Snowflake with a programmatic access token, not the password.
    password = "";
    notes.push(t("O Graphite usa um token de acesso (PAT) do Snowflake, não a senha: crie um e informe ao conectar."));
  }
  let config = { type };
  if (e.fields === "file") {
    config.file = str(f.file || f.database);
    if (!config.file) return { name, type, skip: t("Arquivo do banco não informado"), notes, folder: f.folder || "" };
  } else if (e.fields === "url") {
    config.url = str(f.url) || (f.host ? `libsql://${f.host}` : "");
  } else if (e.form) {
    for (const field of e.form) if (field.type !== "secret") config[field.key] = str(f[field.key] ?? (field.key === "url" ? f.url : ""));
    if (type === "mongodb" && !config.url && f.host) config.url = `mongodb://${f.host}${f.port ? ":" + f.port : ""}`;
    if (type === "surrealdb" && !config.url && f.host) config.url = `${f.ssl ? "https" : "http"}://${f.host}${f.port ? ":" + f.port : ""}`;
  } else {
    config = {
      type,
      host: str(f.host) || "localhost",
      port: portOf(f.port) || e.port || "",
      user: str(f.user),
      database: str(f.database),
      ssl: !!f.ssl,
    };
    if (f.ssl) Object.assign(config, { sslMode: f.sslMode || "require", sslCa: str(f.sslCa), sslCert: str(f.sslCert), sslKey: str(f.sslKey) });
  }
  let sshSecret = "";
  if (f.ssh) {
    const s = typeof f.ssh === "object" ? f.ssh : null;
    if (!e.caps.ssh) notes.push(t("Usava túnel SSH, que o Graphite não oferece para {engine}.", { engine: e.label }));
    else if (s && str(s.host)) {
      const auth = ["password", "key", "agent"].includes(s.auth) ? s.auth : str(s.keyFile) ? "key" : "password";
      config.ssh = { host: str(s.host), port: Number(portOf(s.port)) || 22, user: str(s.user), auth };
      if (auth === "key" && str(s.keyFile)) config.ssh.keyFile = str(s.keyFile);
      sshSecret = s.secret ? String(s.secret) : "";
      if (auth === "password" && !sshSecret) notes.push(t("Túnel SSH por {host}: a senha SSH não veio junto, informe ao conectar.", { host: config.ssh.host }));
    } else notes.push(t("Usa túnel SSH: marque \"Conectar por um túnel SSH\" na conexão e informe o servidor."));
  }
  if (f.socket) notes.push(t("Usava socket local; importada como TCP em {host}.", { host: config.host || "localhost" }));
  return { name, type, config, password, sshSecret, folder: str(f.folder), notes, passwordElsewhere: !password && !!f.passwordElsewhere && e.fields !== "file" };
}

// A JDBC / driver URL → a connection, with the tool's own name and user.
function fromUrl(name, url, extra = {}) {
  try {
    const r = parseConnectionUrl(url);
    const notes = r.ignored?.length ? [t("Parâmetros ignorados: {list}", { list: r.ignored.join(", ") })] : [];
    const { extra: own = {}, ...fields } = r.fields; // engines with their own form keep fields in `extra`
    return makeConn({ ...own, ...fields, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== "")), type: r.type, name, notes: [...notes, ...(extra.notes || [])] });
  } catch {
    const engine = /^(?:jdbc:)?([a-z][\w+.-]*):/i.exec(String(url))?.[1];
    const skip = engine ? t("Banco não suportado pelo Graphite: {engine}", { engine }) : t("URL de conexão não reconhecida");
    return { name, type: "?", skip, notes: [], folder: extra.folder || "" };
  }
}

module.exports = { HOME, APPDATA, LOCALAPPDATA, XDG_DATA, exists, isDir, subdirs, readText, readJson, parseJsonc, str, portOf, makeConn, fromUrl, t };
