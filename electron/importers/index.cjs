// Import saved connections (and saved queries, when the tool has them) from
// other database tools. detect() looks where each tool keeps its data on this
// machine; readFile() accepts a file the user picks (an export, or the tool's
// own file copied from another machine). Results stay here, passwords
// included; the window gets a preview without them and refers to the result
// by a token when it imports.
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { exists, t } = require("./common.cjs");

const IMPORTERS = [
  require("./dbeaver.cjs"),
  require("./datagrip.cjs"),
  require("./beekeeper.cjs"),
  require("./tableplus.cjs"),
  require("./navicat.cjs"),
  require("./pgadmin.cjs"),
  require("./workbench.cjs"),
  require("./heidisql.cjs"),
  require("./sequelace.cjs"),
  require("./dbgate.cjs"),
  require("./compass.cjs"),
  require("./redisinsight.cjs"),
  require("./vscode.cjs"),
];

const sessions = new Map(); // token → { tool, label, path, connections, queries }

function remember(imp, file, result) {
  const token = crypto.randomUUID();
  const r = { tool: imp.id, label: result.label || imp.label, path: file, connections: result.connections || [], queries: result.queries || [], warnings: result.warnings || [] };
  sessions.set(token, r);
  if (sessions.size > 20) sessions.delete(sessions.keys().next().value);
  return preview(token, r);
}

// What the window sees: no passwords.
function preview(token, r) {
  return {
    token,
    tool: r.tool,
    label: r.label,
    path: r.path,
    warnings: r.warnings,
    queries: r.queries.map((q) => ({ title: q.title, lines: String(q.sql).split("\n").length })),
    connections: r.connections.map((c, i) => ({
      i,
      name: c.name,
      type: c.type,
      config: c.config || null,
      folder: c.folder || "",
      hasPassword: !!c.password,
      passwordElsewhere: !!c.passwordElsewhere,
      skip: c.skip || null,
      notes: c.notes || [],
    })),
  };
}

async function candidatesOf(imp) {
  try {
    return [...new Set(await imp.candidates())];
  } catch {
    return [];
  }
}

// Every tool found on this machine, already read.
async function detect() {
  const found = [];
  await Promise.all(
    IMPORTERS.map(async (imp) => {
      for (const file of await candidatesOf(imp)) {
        if (!(await exists(file))) continue;
        try {
          const p = remember(imp, file, await imp.read(file));
          if (p.connections.length || p.queries.length) found.push(p);
        } catch {
          // unreadable or a different format: not offered
        }
      }
    }),
  );
  const order = IMPORTERS.map((i) => i.id);
  return found.sort((a, b) => order.indexOf(a.tool) - order.indexOf(b.tool));
}

// A file the user picked: find which tool wrote it.
async function readFile(file) {
  const fh = await fs.open(file, "r");
  let head;
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const text = head.toString("utf8");
  const errors = [];
  for (const imp of IMPORTERS) {
    let ok = false;
    try {
      ok = imp.match(file, head, text);
    } catch {}
    if (!ok) continue;
    try {
      return remember(imp, file, await imp.read(file));
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length) throw errors[0];
  throw new Error(t("Não reconheci este arquivo. Formatos aceitos: {list}.", { list: formats().join(", ") }));
}

const formats = () => IMPORTERS.flatMap((i) => i.formats || [i.label]);

// The chosen connections, with passwords, for the import itself.
function take(token, { picks, withPasswords, withQueries }) {
  const r = sessions.get(token);
  if (!r) throw new Error(t("A leitura expirou. Abra a importação de novo."));
  const chosen = new Set(picks);
  return {
    label: r.label,
    connections: r.connections
      .filter((c, i) => chosen.has(i) && !c.skip)
      .map((c) => ({ name: c.name, type: c.type, config: c.config, password: withPasswords ? c.password || "" : "" })),
    queries: withQueries ? r.queries : [],
  };
}

module.exports = { detect, readFile, take, formats, IMPORTERS };
