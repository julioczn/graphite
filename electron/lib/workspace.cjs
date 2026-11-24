// Workspace documents: what a workspace holds once it leaves this machine
// (export file, GitHub repository), and the three-way merge used by sync.
//
// A document never carries secrets: connection passwords / tokens stay in the
// local database, encrypted. URLs lose any password they embed.
//
//   { graphite: 1, name, connections: [{ id, name, type, config, prefs, tabs }],
//     queries: [{ id, title, sql }], snippets: [{ id, trigger, title, body }] }
//
// In a repository a workspace is a folder:
//   <dir>/workspace.yml               name, connections, snippets
//   <dir>/queries/<title>-<id>.sql    one saved query per file
const crypto = require("node:crypto");
const YAML = require("yaml");
const { t } = require("../../shared/i18n.mjs");

const DOC_VERSION = 1;
const newId = () => crypto.randomUUID();
// Errors meant for the user (already translated), as opposed to parser errors.
const fail = (msg) => Object.assign(new Error(msg), { user: true });

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
// Stable JSON (sorted keys) for comparisons.
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (isObj(v)) return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
const same = (a, b) => stable(a) === stable(b);

// Connection config without secrets.
function publicConfig(config) {
  const c = { ...(isObj(config) ? config : {}) };
  delete c.password;
  // SSH tunnel: where and who, never the password or key passphrase. The key
  // file goes only as a path under ~ (an absolute one is this machine's).
  if (isObj(c.ssh)) {
    const { secret, secretEnc, keyFile, ...ssh } = c.ssh;
    if (typeof keyFile === "string" && keyFile.startsWith("~/")) ssh.keyFile = keyFile;
    c.ssh = Object.fromEntries(Object.entries(ssh).filter(([, v]) => v !== "" && v != null));
    if (!c.ssh.host) delete c.ssh;
  }
  if (typeof c.url === "string") {
    try {
      const u = new URL(c.url);
      if (u.password) {
        u.password = "";
        c.url = u.toString();
      }
    } catch {}
  }
  for (const k of Object.keys(c)) if (c[k] === "" || c[k] == null) delete c[k];
  return c;
}

const TAB_TYPES = new Set(["query", "table", "er"]);
function cleanTabs(tabs) {
  return arr(tabs).filter((x) => isObj(x) && TAB_TYPES.has(x.type)).slice(0, 50).map((x) => {
    if (x.type === "query") return { type: "query", title: str(x.title), sql: str(x.sql) };
    if (x.type === "table") return { type: "table", title: str(x.title), table: str(x.table), schema: x.schema == null ? null : str(x.schema), kind: str(x.kind) || undefined, view: x.view === "structure" ? "structure" : "data" };
    return { type: "er", title: str(x.title), scope: str(x.scope) };
  });
}

function cleanPrefs(p) {
  const out = {};
  if (!isObj(p)) return out;
  if (typeof p.autoCommit === "boolean") out.autoCommit = p.autoCommit;
  if (typeof p.schema === "string" && p.schema) out.schema = p.schema;
  return out;
}

// Validates a document from a file or a repository; fills missing ids.
function normalizeDoc(raw) {
  if (!isObj(raw)) throw fail(t("Arquivo de workspace inválido."));
  if (Number(raw.graphite) > DOC_VERSION) throw fail(t("Este workspace foi criado por uma versão mais nova do Graphite. Atualize o app."));
  const ids = new Set();
  const id = (v) => {
    let s = str(v).trim();
    if (!s || ids.has(s)) s = newId();
    ids.add(s);
    return s;
  };
  return {
    graphite: DOC_VERSION,
    name: str(raw.name).trim() || "Workspace",
    connections: arr(raw.connections).filter((c) => isObj(c) && str(c.type)).map((c) => ({
      id: id(c.id),
      name: str(c.name).trim() || str(c.type),
      type: str(c.type),
      config: publicConfig({ ...(isObj(c.config) ? c.config : {}), type: str(c.type) }),
      prefs: cleanPrefs(c.prefs),
      tabs: cleanTabs(c.tabs),
    })),
    queries: arr(raw.queries).filter((q) => isObj(q) && str(q.sql)).map((q) => ({
      id: id(q.id),
      title: str(q.title).replace(/\s+/g, " ").trim() || t("Consulta sem título"),
      sql: str(q.sql),
    })),
    snippets: arr(raw.snippets).filter((s) => isObj(s) && str(s.trigger).trim() && str(s.body)).map((s) => ({
      id: id(s.id),
      trigger: str(s.trigger).trim().replace(/\W+/g, "_"),
      title: str(s.title).trim() || str(s.trigger).trim(),
      body: str(s.body),
    })),
  };
}

// --- files: export and repository -------------------------------------------------

function serialize(doc, format) {
  if (format === "json") return JSON.stringify(doc, null, 2) + "\n";
  return YAML.stringify(doc, { lineWidth: 0, blockQuote: "literal" });
}

// JSON or YAML (JSON is valid YAML, but its errors read better as JSON).
function parseFile(text) {
  const s = String(text).replace(/^﻿/, "");
  try {
    return normalizeDoc(/^\s*[{[]/.test(s) ? JSON.parse(s) : YAML.parse(s));
  } catch (e) {
    if (e.user) throw e;
    throw fail(t("Não consegui ler o arquivo: {error}", { error: e.message.split("\n")[0] }));
  }
}

const slug = (s) =>
  str(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "query";

const queryFile = (q) => `queries/${slug(q.title)}-${q.id.replace(/-/g, "").slice(0, 8)}.sql`;

// doc → { "<dir>/workspace.yml": text, "<dir>/queries/….sql": text }
function toFiles(doc, dir) {
  const head = { graphite: doc.graphite, name: doc.name, connections: doc.connections, snippets: doc.snippets };
  const files = {
    [`${dir}/workspace.yml`]:
      "# Graphite workspace. Edit in the app; passwords are never stored here.\n" + YAML.stringify(head, { lineWidth: 0, blockQuote: "literal" }),
  };
  for (const q of doc.queries) {
    files[`${dir}/${queryFile(q)}`] = `-- title: ${q.title}\n-- id: ${q.id}\n\n${q.sql.replace(/\n*$/, "\n")}`;
  }
  return files;
}

// Inverse of toFiles; `files` maps paths relative to the folder.
function fromFiles(files) {
  const head = files["workspace.yml"];
  if (head == null) return null;
  let raw;
  try {
    raw = YAML.parse(head) || {};
  } catch (e) {
    throw fail(t("O workspace.yml do repositório é inválido: {error}", { error: e.message.split("\n")[0] }));
  }
  raw.queries = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/^queries\/[^/]+\.sql$/.test(path)) continue;
    const lines = text.split("\n");
    const meta = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const m = /^--\s*(title|id):\s?(.*)$/.exec(lines[i]);
      if (!m) break;
      meta[m[1]] = m[2].trim();
    }
    if (lines[i] === "") i++;
    raw.queries.push({ id: meta.id, title: meta.title || path.slice(8, -4), sql: lines.slice(i).join("\n").replace(/\n$/, "") });
  }
  return normalizeDoc(raw);
}

// --- three-way merge -------------------------------------------------------------------

const byId = (list) => new Map(arr(list).map((x) => [x.id, x]));

// Per field: the side that changed since base wins; local wins if both did.
const pickField = (b, l, r) => (b !== undefined && same(l, b) ? r : l);

/**
 * Merges one list. `core` picks the fields that matter for conflicts; `side`
 * names fields merged on their own (tabs, prefs) where local simply wins.
 * Edited on both sides → keep both, the remote one renamed with `rename`.
 */
function mergeList(base, local, remote, { core, side = [], label, rename }) {
  const B = byId(base);
  const L = byId(local);
  const R = byId(remote);
  const out = [];
  const conflicts = [];
  const ids = [...L.keys(), ...[...R.keys()].filter((k) => !L.has(k))];
  for (const id of ids) {
    const b = B.get(id);
    const l = L.get(id);
    const r = R.get(id);
    if (l && r) {
      const sideFields = (winner) => Object.fromEntries(side.map((f) => [f, b ? pickField(b[f], l[f], r[f]) : l[f] ?? winner[f]]));
      if (same(core(l), core(r)) || (b && same(core(r), core(b)))) out.push({ ...l, ...sideFields(l) });
      else if (b && same(core(l), core(b))) out.push({ ...r, ...sideFields(r) });
      else {
        out.push(l);
        out.push(rename({ ...r, id: newId() }));
        conflicts.push(label(l));
      }
    } else if (l) {
      // Gone from the remote: deleted there unless changed here since.
      if (!(b && same(core(l), core(b)))) out.push(l);
    } else if (r) {
      if (!(b && same(core(r), core(b)))) out.push(r);
    }
  }
  return { list: out, conflicts };
}

const connCore = (c) => ({ name: c.name, type: c.type, config: c.config });
const queryCore = (q) => ({ title: q.title, sql: q.sql });
const snippetCore = (s) => ({ trigger: s.trigger, title: s.title, body: s.body });
const fromRemote = (s) => t("{name} (GitHub)", { name: s });

function merge3(base, local, remote) {
  if (!remote) return { doc: local, conflicts: [] };
  const b = base || { connections: [], queries: [], snippets: [] };
  const conns = mergeList(b.connections, local.connections, remote.connections, {
    core: connCore, side: ["prefs", "tabs"], label: (c) => c.name, rename: (c) => ({ ...c, name: fromRemote(c.name) }),
  });
  const queries = mergeList(b.queries, local.queries, remote.queries, {
    core: queryCore, label: (q) => q.title, rename: (q) => ({ ...q, title: fromRemote(q.title) }),
  });
  const snippets = mergeList(b.snippets, local.snippets, remote.snippets, {
    core: snippetCore, label: (s) => s.trigger, rename: (s) => ({ ...s, trigger: s.trigger + "_gh" }),
  });
  return {
    doc: {
      graphite: DOC_VERSION,
      name: base && same(local.name, base.name) ? remote.name : local.name,
      connections: conns.list,
      queries: queries.list,
      snippets: snippets.list,
    },
    conflicts: [...conns.conflicts, ...queries.conflicts, ...snippets.conflicts],
  };
}

module.exports = { DOC_VERSION, newId, publicConfig, cleanTabs, cleanPrefs, normalizeDoc, serialize, parseFile, toFiles, fromFiles, merge3, same, slug };
