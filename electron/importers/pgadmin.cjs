// pgAdmin 4: the servers.json its "Import/Export Servers" writes, or the
// desktop app's own pgadmin4.db (table "server"). Saved passwords are tied to
// pgAdmin's master password or keyring and stay there.
const path = require("node:path");
const { HOME, APPDATA, readJson, makeConn, t } = require("./common.cjs");

const json = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : s || {};
  } catch {
    return {};
  }
};
const sslOf = (mode) => {
  const m = String(mode || "").toLowerCase();
  if (["require", "verify-ca", "verify-full"].includes(m)) return { ssl: true, sslMode: m };
  return { ssl: false };
};

function server(s, group) {
  const p = json(s.ConnectionParameters || s.connection_params);
  const mode = p.sslmode || s.SSLMode || s.ssl_mode;
  return makeConn({
    name: s.Name || s.name,
    type: "postgres",
    folder: group || "",
    host: s.Host || s.host || s.HostAddr || p.hostaddr,
    port: s.Port || s.port,
    user: s.Username || s.username,
    database: s.MaintenanceDB || s.maintenance_db,
    ...sslOf(mode),
    sslCa: p.sslrootcert || s.SSLRootCert || s.sslrootcert,
    sslCert: p.sslcert || s.SSLCert || s.sslcert,
    sslKey: p.sslkey || s.SSLKey || s.sslkey,
    // TunnelAuthentication: 0 password, 1 identity file
    ssh: s.UseSSHTunnel || s.use_ssh_tunnel
      ? {
          host: s.TunnelHost || s.tunnel_host, port: s.TunnelPort || s.tunnel_port, user: s.TunnelUsername || s.tunnel_username,
          auth: Number(s.TunnelAuthentication ?? s.tunnel_authentication) === 1 ? "key" : "password",
          keyFile: s.TunnelIdentityFile || s.tunnel_identity_file,
        }
      : false,
    passwordElsewhere: true,
    notes: s.Service || s.service ? [t("Usa um serviço do pg_service.conf ({name}); confira host e porta.", { name: s.Service || s.service })] : [],
  });
}

module.exports = {
  id: "pgadmin",
  label: "pgAdmin 4",
  formats: ["pgAdmin 4 (servers.json)"],
  candidates: () => [path.join(HOME(), ".pgadmin", "pgadmin4.db"), path.join(APPDATA(), "pgAdmin", "pgadmin4.db")],
  match: (file, head, text) =>
    (head.subarray(0, 15).toString("latin1") === "SQLite format 3" && /pgadmin/i.test(file)) || (/"Servers"\s*:/.test(text) && /"MaintenanceDB"|"Host"|"Group"/.test(text)),
  async read(file) {
    if ((await require("node:fs/promises").readFile(file)).subarray(0, 15).toString("latin1") === "SQLite format 3") {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const groups = new Map(db.prepare("select id, name from servergroup").all().map((g) => [g.id, g.name]));
        const cols = new Set(db.prepare("pragma table_info(server)").all().map((c) => c.name));
        const rows = db.prepare(`select * from server ${cols.has("is_adhoc") ? "where is_adhoc = 0" : ""} order by name`).all();
        return {
          connections: rows.map((r) => server(cols.has("connection_params") ? r : { ...r, connection_params: { sslmode: r.ssl_mode, sslrootcert: r.sslrootcert, sslcert: r.sslcert, sslkey: r.sslkey } }, groups.get(r.servergroup_id))),
          queries: [],
        };
      } finally {
        db.close();
      }
    }
    const doc = await readJson(file);
    if (!doc?.Servers) throw new Error(t("Este arquivo não parece ser do pgAdmin."));
    return { connections: Object.values(doc.Servers).map((s) => server(s, s.Group)), queries: [] };
  },
};
