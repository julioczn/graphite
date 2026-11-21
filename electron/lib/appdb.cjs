// Local app database: saved connections, query history and saved queries.
// here node:sqlite plus a tiny versioned migration list is enough.
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

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
  return db;
}

function handlers(db) {
  const parseConn = (r) => ({ ...r, config: JSON.parse(r.config) });
  return {
    "app/connections": () =>
      db
        .prepare(
          "select * from connections order by last_used_at desc nulls last, name",
        )
        .all()
        .map(parseConn),

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
          "insert into connections (name, type, config, password) values (?, ?, ?, ?)",
        )
        .run(conn.name, conn.type, config, conn.password ?? null);
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

    "app/savedQueries": () =>
      db.prepare("select * from saved_queries order by updated_at desc").all(),

    "app/saveQuery": ({ query }) => {
      if (query.id) {
        db.prepare(
          `update saved_queries set title = ?, sql = ?, updated_at = datetime('now') where id = ?`,
        ).run(query.title, query.sql, query.id);
        return query.id;
      }
      return Number(
        db
          .prepare("insert into saved_queries (title, sql) values (?, ?)")
          .run(query.title, query.sql).lastInsertRowid,
      );
    },

    "app/deleteQuery": ({ id }) => {
      db.prepare("delete from saved_queries where id = ?").run(id);
    },
  };
}

module.exports = { open, handlers };
