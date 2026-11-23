// Local app database: workspaces, saved connections, query history and saved
// queries. Connections and saved queries belong to a workspace; each carries a
// uid that stays the same across machines (export files, GitHub sync).
// here node:sqlite plus a tiny versioned migration list is enough.
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const ws = require("./workspace.cjs");
const { t } = require("../../shared/i18n.mjs");

const MIGRATIONS = [
  `create table connections (
     id integer primary key autoincrement,
     name text not null,
     type text not null,
     config text not null,
     password text,
     created_at text default (datetime('now')),
     last_used_at text
   )`,
  `create table history (
     id integer primary key autoincrement,
     connection_id integer,
     sql text not null,
     duration_ms integer,
     row_count integer,
     ok integer not null default 1,
     created_at text default (datetime('now'))
   )`,
  `create table saved_queries (
     id integer primary key autoincrement,
     title text not null,
     sql text not null,
     updated_at text default (datetime('now'))
   )`,
  // Workspaces. Rows from before land in workspace 1 (created in open()).
  `create table workspaces (
     id integer primary key autoincrement,
     uid text not null,
     name text not null,
     snippets text not null default '[]',
     remote text,
     created_at text default (datetime('now'))
   );
   alter table connections add column workspace_id integer not null default 1;
   alter table connections add column uid text;
   alter table connections add column prefs text not null default '{}';
   alter table connections add column tabs text not null default '[]';
   alter table saved_queries add column workspace_id integer not null default 1;
   alter table saved_queries add column uid text;`,
];

function open(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "graphite.db"));
  db.exec("pragma journal_mode = wal");
  const version = db.prepare("pragma user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("begin");
    db.exec(MIGRATIONS[v]);
    db.exec(`pragma user_version = ${v + 1}`);
    db.exec("commit");
  }
  // A first workspace, and uids for rows that predate them.
  if (!db.prepare("select 1 from workspaces limit 1").get())
    db.prepare("insert into workspaces (id, uid, name) values (1, ?, ?)").run(crypto.randomUUID(), t("Padrão"));
  for (const table of ["connections", "saved_queries"])
    for (const { id } of db.prepare(`select id from ${table} where uid is null`).all())
      db.prepare(`update ${table} set uid = ? where id = ?`).run(crypto.randomUUID(), id);
  return db;
}

const json = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

function tx(db, fn) {
  db.exec("begin");
  try {
    const r = fn();
    db.exec("commit");
    return r;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

// The workspace as a portable document (no secrets).
function workspaceDoc(db, id) {
  const w = db.prepare("select * from workspaces where id = ?").get(id);
  if (!w) throw new Error(t("Workspace não encontrado"));
  return ws.normalizeDoc({
    name: w.name,
    connections: db.prepare("select * from connections where workspace_id = ? order by name, id").all(id).map((c) => ({
      id: c.uid, name: c.name, type: c.type, config: json(c.config, {}), prefs: json(c.prefs, {}), tabs: json(c.tabs, []),
    })),
    queries: db.prepare("select * from saved_queries where workspace_id = ? order by title, id").all(id).map((q) => ({ id: q.uid, title: q.title, sql: q.sql })),
    snippets: json(w.snippets, []),
  });
}

// Makes the workspace match `doc`: upsert by uid, delete what's missing.
// Passwords of connections that stay are kept; tabs and prefs are written only
// when they changed (the local ones carry links the document drops).
function applyWorkspaceDoc(db, id, raw) {
  const doc = ws.normalizeDoc(raw);
  return tx(db, () => {
    db.prepare("update workspaces set name = ?, snippets = ? where id = ?").run(doc.name, JSON.stringify(doc.snippets), id);
    const conns = new Map(db.prepare("select * from connections where workspace_id = ?").all(id).map((c) => [c.uid, c]));
    for (const c of doc.connections) {
      const cur = conns.get(c.id);
      conns.delete(c.id);
      // The config keeps local-only values the document can't carry (a URL's password).
      if (cur) {
        const local = json(cur.config, {});
        const config = ws.same(ws.publicConfig(local), c.config) ? local : c.config;
        const prefs = ws.same(ws.cleanPrefs(json(cur.prefs, {})), c.prefs) ? json(cur.prefs, {}) : c.prefs;
        const tabs = ws.same(ws.cleanTabs(json(cur.tabs, [])), c.tabs) ? json(cur.tabs, []) : c.tabs;
        db.prepare("update connections set name = ?, type = ?, config = ?, prefs = ?, tabs = ? where id = ?")
          .run(c.name, c.type, JSON.stringify(config), JSON.stringify(prefs), JSON.stringify(tabs), cur.id);
      } else {
        db.prepare("insert into connections (workspace_id, uid, name, type, config, prefs, tabs) values (?, ?, ?, ?, ?, ?, ?)")
          .run(id, c.id, c.name, c.type, JSON.stringify(c.config), JSON.stringify(c.prefs), JSON.stringify(c.tabs));
      }
    }
    for (const c of conns.values()) db.prepare("delete from connections where id = ?").run(c.id);
    const queries = new Map(db.prepare("select * from saved_queries where workspace_id = ?").all(id).map((q) => [q.uid, q]));
    for (const q of doc.queries) {
      const cur = queries.get(q.id);
      queries.delete(q.id);
      if (cur && (cur.title !== q.title || cur.sql !== q.sql))
        db.prepare("update saved_queries set title = ?, sql = ?, updated_at = datetime('now') where id = ?").run(q.title, q.sql, cur.id);
      else if (!cur) db.prepare("insert into saved_queries (workspace_id, uid, title, sql) values (?, ?, ?, ?)").run(id, q.id, q.title, q.sql);
    }
    for (const q of queries.values()) db.prepare("delete from saved_queries where id = ?").run(q.id);
    return id;
  });
}

function handlers(db) {
  const parseConn = (r) => ({ ...r, config: JSON.parse(r.config), prefs: json(r.prefs, {}), tabs: json(r.tabs, []) });
  const workspaceRow = (w) => ({ ...w, snippets: json(w.snippets, []), remote: json(w.remote, null) });
  return {
    // --- workspaces ---
    "app/workspaces": () =>
      db.prepare(
        `select w.*, (select count(*) from connections c where c.workspace_id = w.id) as connections,
                (select count(*) from saved_queries q where q.workspace_id = w.id) as queries
           from workspaces w order by w.id`,
      ).all().map(workspaceRow),

    "app/saveWorkspace": ({ workspace }) => {
      const name = String(workspace.name || "").trim() || "Workspace";
      if (workspace.id) {
        db.prepare("update workspaces set name = ? where id = ?").run(name, workspace.id);
        return workspace.id;
      }
      return Number(db.prepare("insert into workspaces (uid, name) values (?, ?)").run(crypto.randomUUID(), name).lastInsertRowid);
    },

    "app/deleteWorkspace": ({ id }) => {
      if (db.prepare("select count(*) as n from workspaces").get().n <= 1) throw new Error(t("Não dá para excluir o único workspace."));
      tx(db, () => {
        db.prepare("delete from connections where workspace_id = ?").run(id);
        db.prepare("delete from saved_queries where workspace_id = ?").run(id);
        db.prepare("delete from workspaces where id = ?").run(id);
      });
    },

    "app/saveSnippets": ({ id, snippets }) => {
      const clean = ws.normalizeDoc({ snippets }).snippets;
      db.prepare("update workspaces set snippets = ? where id = ?").run(JSON.stringify(clean), id);
      return clean;
    },

    "app/setWorkspaceRemote": ({ id, remote }) => {
      db.prepare("update workspaces set remote = ? where id = ?").run(remote ? JSON.stringify(remote) : null, id);
    },

    "app/workspaceDoc": ({ id }) => workspaceDoc(db, id),
    "app/applyWorkspaceDoc": ({ id, doc }) => applyWorkspaceDoc(db, id, doc),
    // A new workspace from an imported document (fresh uids: a copy, not a link).
    "app/importWorkspace": ({ doc, name }) => {
      const clean = ws.normalizeDoc(doc);
      let wsName = name || clean.name;
      if (db.prepare("select 1 from workspaces where name = ?").get(wsName)) wsName = t("{name} (importado)", { name: wsName });
      const fresh = {
        ...clean,
        name: wsName,
        connections: clean.connections.map((c) => ({ ...c, id: crypto.randomUUID() })),
        queries: clean.queries.map((q) => ({ ...q, id: crypto.randomUUID() })),
      };
      const id = Number(db.prepare("insert into workspaces (uid, name) values (?, ?)").run(crypto.randomUUID(), fresh.name).lastInsertRowid);
      return applyWorkspaceDoc(db, id, fresh);
    },

    // --- connections ---
    // Without workspaceId: every workspace (AI agents see all saved connections).
    "app/connections": ({ workspaceId } = {}) =>
      db
        .prepare(
          `select * from connections ${workspaceId != null ? "where workspace_id = ?" : ""} order by last_used_at desc nulls last, name`,
        )
        .all(...(workspaceId != null ? [workspaceId] : []))
        .map(parseConn),

    "app/setConnPrefs": ({ id, prefs }) => {
      const cur = json(db.prepare("select prefs from connections where id = ?").get(id)?.prefs, {});
      db.prepare("update connections set prefs = ? where id = ?").run(JSON.stringify({ ...cur, ...prefs }), id);
    },

    "app/setConnTabs": ({ id, tabs }) => {
      db.prepare("update connections set tabs = ? where id = ?").run(JSON.stringify(Array.isArray(tabs) ? tabs.slice(0, 50) : []), id);
    },

    "app/saveConnection": ({ conn }) => {
      const config = JSON.stringify(conn.config);
      if (conn.id) {
        db.prepare(
          "update connections set name = ?, type = ?, config = ?, password = ? where id = ?",
        ).run(conn.name, conn.type, config, conn.password ?? null, conn.id);
        return conn.id;
      }
      const r = db
        .prepare(
          "insert into connections (workspace_id, uid, name, type, config, password) values (?, ?, ?, ?, ?, ?)",
        )
        .run(conn.workspaceId ?? 1, crypto.randomUUID(), conn.name, conn.type, config, conn.password ?? null);
      return Number(r.lastInsertRowid);
    },

    "app/deleteConnection": ({ id }) => {
      db.prepare("delete from connections where id = ?").run(id);
    },

    "app/touchConnection": ({ id }) => {
      db.prepare(
        `update connections set last_used_at = datetime('now') where id = ?`,
      ).run(id);
    },

    "app/history": ({ connectionId, limit = 200 }) =>
      db
        .prepare(
          `select * from history where connection_id is ? order by id desc limit ?`,
        )
        .all(connectionId ?? null, limit),

    "app/addHistory": ({ entry }) => {
      db.prepare(
        `insert into history (connection_id, sql, duration_ms, row_count, ok) values (?, ?, ?, ?, ?)`,
      ).run(
        entry.connectionId ?? null,
        entry.sql,
        entry.durationMs,
        entry.rowCount ?? null,
        entry.ok ? 1 : 0,
      );
      db.prepare(
        `delete from history where id not in (select id from history order by id desc limit 2000)`,
      ).run();
    },

    "app/clearHistory": ({ connectionId }) => {
      db.prepare("delete from history where connection_id is ?").run(
        connectionId ?? null,
      );
    },

    "app/savedQueries": ({ workspaceId } = {}) =>
      db
        .prepare(`select * from saved_queries ${workspaceId != null ? "where workspace_id = ?" : ""} order by updated_at desc`)
        .all(...(workspaceId != null ? [workspaceId] : [])),

    "app/saveQuery": ({ query }) => {
      if (query.id) {
        db.prepare(
          `update saved_queries set title = ?, sql = ?, updated_at = datetime('now') where id = ?`,
        ).run(query.title, query.sql, query.id);
        return query.id;
      }
      return Number(
        db
          .prepare("insert into saved_queries (workspace_id, uid, title, sql) values (?, ?, ?, ?)")
          .run(query.workspaceId ?? 1, crypto.randomUUID(), query.title, query.sql).lastInsertRowid,
      );
    },

    "app/deleteQuery": ({ id }) => {
      db.prepare("delete from saved_queries where id = ?").run(id);
    },
  };
}

module.exports = { open, handlers };
