// SQL backups written by Graphite itself (no pg_dump / mysqldump needed).
//
// The output is a plain SQL script (optionally gzipped) that restore.cjs can
// replay, and that psql / mysql / sqlite3 can also run. Data is read through a
// cursor inside a read-only snapshot, so the backup is consistent and memory
// use stays flat.
//
// PostgreSQL mirrors pg_dump's ordering: extensions, schemas, enum types,
// sequences, functions, tables (without foreign keys), data, sequence values,
// indexes, foreign keys, views, triggers. Owners and grants are left out
// (like --no-owner --no-privileges).
const fs = require('node:fs')
const zlib = require('node:zlib')
const { once } = require('node:events')
// `t` is a common loop variable here, so the translator is `tr`.
const { t: tr } = require('../../shared/i18n.mjs')

const ROWS_PER_INSERT = 200
const MAX_INSERT_BYTES = 512 * 1024

// --- output -------------------------------------------------------------------

function createWriter(file, gzip) {
  const fileStream = fs.createWriteStream(file)
  const target = gzip ? zlib.createGzip({ level: 6 }) : fileStream
  if (gzip) target.pipe(fileStream)
  let error = null
  fileStream.on('error', (e) => { error = e })
  target.on('error', (e) => { error = e })
  return {
    async write(s) {
      if (error) throw error
      if (!target.write(s)) await Promise.race([once(target, 'drain'), once(fileStream, 'error')])
      if (error) throw error
    },
    async close() {
      target.end()
      if (!fileStream.closed) await once(fileStream, 'close')
      if (error) throw error
    },
    async abort() {
      target.destroy()
      fileStream.destroy()
      await fs.promises.rm(file, { force: true })
    },
  }
}

// --- literals -----------------------------------------------------------------

function literal(dialect, v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : dialect === 'postgres' ? `'${v}'` : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')
    return dialect === 'postgres' ? `'\\x${hex}'` : `X'${hex}'`
  }
  if (v instanceof Date) v = v.toISOString()
  else if (typeof v === 'object') v = JSON.stringify(v)
  const s = String(v)
  if (dialect === 'mysql') {
    return "'" + s.replace(/[\\'\0\n\r\x1a]/g, (c) => ({ '\\': '\\\\', "'": "\\'", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' })[c]) + "'"
  }
  return "'" + s.replace(/'/g, "''") + "'"
}

// --- shared data section ---------------------------------------------------------

// Stream one table's rows as multi-row INSERTs. `columns` limits/arranges the
// inserted columns (PostgreSQL skips generated ones).
async function writeRows(d, out, job, { from, target, columns, prefix = '' }, onRows) {
  const select = columns ? columns.map((c) => d.quote(c)).join(', ') : '*'
  let head = null
  let values = []
  let size = 0
  const flush = async () => {
    if (!values.length) return
    await out.write(`${head}\n${values.join(',\n')};\n`)
    values = []
    size = 0
  }
  for await (const { fields, rows } of d.stream(`select ${select} from ${from}`, { batch: 1000, raw: 'text' })) {
    job.check()
    head ||= `INSERT INTO ${target} (${fields.map((f) => d.quote(f)).join(', ')})${prefix} VALUES`
    for (const row of rows) {
      const tuple = '(' + row.map((v) => literal(d.dialect, v)).join(', ') + ')'
      values.push(tuple)
      size += tuple.length
      if (values.length >= ROWS_PER_INSERT || size >= MAX_INSERT_BYTES) await flush()
    }
    onRows(rows.length)
  }
  await flush()
}

const banner = (d, scope, opts) => [
  '-- Graphite SQL backup',
  '-- ' + tr('Banco: {dialect} · {scope}', { dialect: d.dialect, scope }),
  '-- ' + tr('Gerado em: {date}', { date: new Date().toISOString() }),
  '-- ' + tr('Conteúdo: {parts}', { parts: [opts.structure && tr('estrutura'), opts.data && tr('dados')].filter(Boolean).join(' + ') }),
  '',
].join('\n') + '\n'

// --- SQLite -------------------------------------------------------------------------

async function dumpSqlite(d, out, opts, job) {
  const objects = await d.execute(
    `select type, name, tbl_name, sql from sqlite_master
     where sql is not null and name not like 'sqlite_%' order by case type when 'table' then 0 when 'index' then 1 when 'view' then 2 else 3 end, rowid`,
  )
  const all = objects.rows.map(([type, name, table, sql]) => ({ type, name, table, sql }))
  const tables = all.filter((o) => o.type === 'table' && (!opts.tables || opts.tables.includes(o.name)))
  const counts = {}
  for (const t of tables) counts[t.name] = Number((await d.execute(`select count(*) from ${d.quote(t.name)}`)).rows[0][0])
  job.plan(tables, counts)

  await out.write(banner(d, d.config.file, opts) + 'PRAGMA foreign_keys = OFF;\n\n')
  for (const t of tables) {
    job.table(t.name)
    if (opts.structure) {
      await out.write(`-- ${tr('Tabela {name}', { name: t.name })}\n`)
      if (opts.drop) await out.write(`DROP TABLE IF EXISTS ${d.quote(t.name)};\n`)
      await out.write(`${t.sql};\n`)
    }
    if (opts.data) await writeRows(d, out, job, { from: d.quote(t.name), target: d.quote(t.name) }, job.rows)
    await out.write('\n')
  }
  const names = new Set(tables.map((t) => t.name))
  if (opts.data) {
    const seq = await d.execute(`select name, seq from sqlite_sequence`).catch(() => ({ rows: [] }))
    const keep = seq.rows.filter(([n]) => names.has(n))
    if (keep.length) {
      await out.write('-- Contadores AUTOINCREMENT\n')
      for (const [n, v] of keep) {
        await out.write(`DELETE FROM sqlite_sequence WHERE name = ${literal('sqlite', n)};\n`)
        await out.write(`INSERT INTO sqlite_sequence (name, seq) VALUES (${literal('sqlite', n)}, ${v});\n`)
      }
      await out.write('\n')
    }
  }
  if (opts.structure) {
    for (const o of all.filter((o) => o.type !== 'table' && (o.type === 'view' ? !opts.tables : names.has(o.table)))) {
      if (opts.drop) await out.write(`DROP ${o.type.toUpperCase()} IF EXISTS ${d.quote(o.name)};\n`)
      await out.write(`${o.sql};\n`)
    }
  }
  await out.write('\nPRAGMA foreign_keys = ON;\n')
}

// --- MySQL / MariaDB ----------------------------------------------------------------

const stripDefiner = (sql) => sql.replace(/\s+DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/i, '')

async function dumpMysql(d, out, opts, job) {
  const db = await d.database()
  if (!db) throw new Error(tr('Selecione um banco antes de gerar o backup'))
  const [objects] = await d.conn.query(
    `select table_name as name, table_type as type, coalesce(table_rows, 0) as estimate
     from information_schema.tables where table_schema = ? order by table_name`,
    [db],
  )
  const tables = objects.filter((t) => t.type !== 'VIEW' && (!opts.tables || opts.tables.includes(t.name)))
  const views = opts.tables ? [] : objects.filter((t) => t.type === 'VIEW')
  job.plan(tables, Object.fromEntries(tables.map((t) => [t.name, Number(t.estimate)])))

  await out.write(banner(d, db, opts) + [
    'SET NAMES utf8mb4;',
    'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;',
    'SET @OLD_UNIQUE_CHECKS = @@UNIQUE_CHECKS, UNIQUE_CHECKS = 0;',
    "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
    "SET @OLD_TIME_ZONE = @@TIME_ZONE, TIME_ZONE = '+00:00';",
    '', '',
  ].join('\n'))

  for (const t of tables) {
    job.table(t.name)
    const q = d.quote(t.name)
    if (opts.structure) {
      const [[row]] = await d.conn.query(`show create table ${q}`)
      await out.write(`-- ${tr('Tabela {name}', { name: t.name })}\n`)
      if (opts.drop) await out.write(`DROP TABLE IF EXISTS ${q};\n`)
      await out.write(`${row['Create Table']};\n`)
    }
    if (opts.data) await writeRows(d, out, job, { from: q, target: q }, job.rows)
    await out.write('\n')
  }

  if (opts.structure && views.length) {
    // Create views in dependency order (a view may select from another view).
    const defs = new Map()
    for (const v of views) {
      const [[row]] = await d.conn.query(`show create view ${d.quote(v.name)}`)
      // Drop the `db`. prefixes so the view can be restored into another database.
      defs.set(v.name, stripDefiner(row['Create View']).replace(/\s+SQL SECURITY DEFINER/i, '').split('`' + db + '`.').join(''))
    }
    const done = new Set()
    const visit = async (name, path = new Set()) => {
      if (done.has(name) || path.has(name)) return
      path.add(name)
      for (const other of defs.keys()) if (other !== name && defs.get(name).includes('`' + other + '`')) await visit(other, path)
      done.add(name)
      await out.write(`-- View ${name}\n${opts.drop ? `DROP VIEW IF EXISTS ${d.quote(name)};\n` : ''}${defs.get(name)};\n\n`)
    }
    for (const name of defs.keys()) await visit(name)
  }

  if (opts.structure && !opts.tables) {
    // Bodies contain semicolons, so they go between DELIMITER lines like mysqldump.
    const [triggers] = await d.conn.query('select trigger_name as name from information_schema.triggers where trigger_schema = ?', [db])
    const [routines] = await d.conn.query('select routine_name as name, routine_type as type from information_schema.routines where routine_schema = ?', [db])
    const blocks = []
    for (const r of routines) {
      const [[row]] = await d.conn.query(`show create ${r.type.toLowerCase()} ${d.quote(r.name)}`)
      const body = row['Create Procedure'] || row['Create Function']
      if (body) blocks.push({ drop: `DROP ${r.type} IF EXISTS ${d.quote(r.name)}`, sql: stripDefiner(body) })
    }
    for (const t of triggers) {
      const [[row]] = await d.conn.query(`show create trigger ${d.quote(t.name)}`)
      blocks.push({ drop: `DROP TRIGGER IF EXISTS ${d.quote(t.name)}`, sql: stripDefiner(row['SQL Original Statement']) })
    }
    if (blocks.length) {
      await out.write('-- Rotinas e triggers\nDELIMITER ;;\n')
      for (const b of blocks) await out.write(`${opts.drop ? b.drop + ';;\n' : ''}${b.sql};;\n`)
      await out.write('DELIMITER ;\n\n')
    }
  }

  await out.write([
    'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;',
    'SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS;',
    'SET SQL_MODE = @OLD_SQL_MODE;',
    'SET TIME_ZONE = @OLD_TIME_ZONE;',
    '',
  ].join('\n'))
}

// --- PostgreSQL ------------------------------------------------------------------------

async function dumpPostgres(d, out, opts, job) {
  const q = async (text, params = []) => (await d.client.query(text, params)).rows
  const schemas = opts.schemas?.length ? opts.schemas : [await d.currentSchema()]
  const qi = (s, n) => `${d.quote(s)}.${d.quote(n)}`
  // Objects created by extensions are recreated by CREATE EXTENSION.
  const notFromExtension = (cls, col = 'oid') =>
    `not exists (select 1 from pg_depend dep where dep.classid = '${cls}'::regclass and dep.objid = ${col} and dep.deptype = 'e')`

  const tables = (await q(
    `select c.oid, n.nspname as schema, c.relname as name, greatest(c.reltuples, 0)::bigint as estimate
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition and ${notFromExtension('pg_class', 'c.oid')}
     order by n.nspname, c.relname`,
    [schemas],
  )).filter((t) => !opts.tables || opts.tables.includes(t.name))
  const full = !opts.tables
  job.plan(tables, Object.fromEntries(tables.map((t) => [t.name, Number(t.estimate)])))

  await out.write(banner(d, `${d.client.database} (${schemas.join(', ')})`, opts) + [
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    'SET check_function_bodies = false;',
    "SET client_min_messages = warning;",
    '', '',
  ].join('\n'))

  if (opts.structure && full) {
    const exts = await q(`select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname <> 'plpgsql' order by e.extname`)
    for (const e of exts) await out.write(`CREATE EXTENSION IF NOT EXISTS ${d.quote(e.extname)} WITH SCHEMA ${d.quote(e.nspname)};\n`)
    for (const s of schemas) if (s !== 'public') await out.write(`CREATE SCHEMA IF NOT EXISTS ${d.quote(s)};\n`)
    await out.write('\n')

    const enums = await q(
      `select n.nspname as schema, t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
       from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
       where n.nspname = any($1) and ${notFromExtension('pg_type', 't.oid')} group by 1, 2 order by 1, 2`,
      [schemas],
    )
    for (const e of enums) {
      if (opts.drop) await out.write(`DROP TYPE IF EXISTS ${qi(e.schema, e.name)} CASCADE;\n`)
      await out.write(`CREATE TYPE ${qi(e.schema, e.name)} AS ENUM (${e.labels.map((l) => literal('postgres', l)).join(', ')});\n`)
    }
    if (enums.length) await out.write('\n')
  }

  // Columns first: they decide which sequences a partial backup needs.
  for (const t of tables) {
    t.columns = await q(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
              pg_get_expr(ad.adbin, ad.adrelid) as def, a.attidentity as identity, a.attgenerated as generated,
              (select collname from pg_collation co where co.oid = a.attcollation and a.attcollation <> t.typcollation) as coll
       from pg_attribute a join pg_type t on t.oid = a.atttypid
       left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
       where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
      [t.oid],
    )
  }

  // Sequences that are not identity columns (those come with the table).
  const sequences = await q(
    `select s.schemaname as schema, s.sequencename as name, s.data_type, s.start_value, s.min_value, s.max_value,
            s.increment_by, s.cycle, s.cache_size, s.last_value, own.schema as own_schema, own.tbl as own_table, own.col as own_column,
            exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.classid = 'pg_class'::regclass and dep.deptype = 'i') as identity
     from pg_sequences s
     join pg_namespace n on n.nspname = s.schemaname join pg_class c on c.relnamespace = n.oid and c.relname = s.sequencename
     left join lateral (
       select tn.nspname as schema, tc.relname as tbl, a.attname as col
       from pg_depend dep join pg_class tc on tc.oid = dep.refobjid join pg_namespace tn on tn.oid = tc.relnamespace
       join pg_attribute a on a.attrelid = tc.oid and a.attnum = dep.refobjsubid
       where dep.objid = c.oid and dep.classid = 'pg_class'::regclass and dep.deptype in ('a', 'i') limit 1
     ) own on true
     where s.schemaname = any($1) and ${notFromExtension('pg_class', 'c.oid')}`,
    [schemas],
  )
  const dumped = new Set(tables.map((t) => `${t.schema}.${t.name}`))
  const defaults = tables.flatMap((t) => t.columns.map((c) => c.def || '')).join('\n')
  const seqs = full ? sequences : sequences.filter((s) =>
    (s.own_table && dumped.has(`${s.own_schema}.${s.own_table}`)) || defaults.includes(`${qi(s.schema, s.name)}'`) || defaults.includes(`${s.schema}.${s.name}'`))

  if (opts.structure) {
    for (const s of seqs.filter((s) => !s.identity)) {
      if (opts.drop) await out.write(`DROP SEQUENCE IF EXISTS ${qi(s.schema, s.name)} CASCADE;\n`)
      await out.write(`CREATE SEQUENCE IF NOT EXISTS ${qi(s.schema, s.name)} AS ${s.data_type} START WITH ${s.start_value} INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value} CACHE ${s.cache_size}${s.cycle ? ' CYCLE' : ''};\n`)
    }
    if (full) {
      const fns = await q(
        `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = any($1) and p.prokind in ('f', 'p') and ${notFromExtension('pg_proc', 'p.oid')} order by p.oid`,
        [schemas],
      )
      if (fns.length) await out.write('\n-- ' + tr('Funções') + '\n')
      for (const f of fns) await out.write(`${f.def.trim()};\n\n`)
    }

    for (const t of tables) {
      const lines = t.columns.map((c) => {
        let s = `  ${d.quote(c.name)} ${c.type}`
        if (c.coll) s += ` COLLATE ${d.quote(c.coll)}`
        if (c.generated === 's') s += ` GENERATED ALWAYS AS (${c.def}) STORED`
        else if (c.identity) s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
        else if (c.def) s += ` DEFAULT ${c.def}`
        if (c.notnull) s += ' NOT NULL'
        return s
      })
      const cons = await q(
        `select conname, pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = $1 and contype in ('p', 'u', 'c', 'x') order by contype = 'p' desc, conname`,
        [t.oid],
      )
      for (const c of cons) lines.push(`  CONSTRAINT ${d.quote(c.conname)} ${c.def}`)
      await out.write(`-- ${tr('Tabela {name}', { name: `${t.schema}.${t.name}` })}\n`)
      if (opts.drop) await out.write(`DROP TABLE IF EXISTS ${qi(t.schema, t.name)} CASCADE;\n`)
      await out.write(`CREATE TABLE ${qi(t.schema, t.name)} (\n${lines.join(',\n')}\n);\n\n`)
    }
    for (const s of seqs.filter((s) => !s.identity && s.own_table && dumped.has(`${s.own_schema}.${s.own_table}`))) {
      await out.write(`ALTER SEQUENCE ${qi(s.schema, s.name)} OWNED BY ${qi(s.own_schema, s.own_table)}.${d.quote(s.own_column)};\n`)
    }
  }

  if (opts.data) {
    for (const t of tables) {
      job.table(`${t.schema}.${t.name}`)
      const columns = t.columns.filter((c) => c.generated !== 's').map((c) => c.name)
      await out.write(`-- Dados ${t.schema}.${t.name}\n`)
      await writeRows(d, out, job, {
        from: qi(t.schema, t.name), target: qi(t.schema, t.name), columns,
        prefix: t.columns.some((c) => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '',
      }, job.rows)
      await out.write('\n')
    }
    const withValue = seqs.filter((s) => s.last_value !== null)
    if (withValue.length) await out.write('-- ' + tr('Valores das sequências') + '\n')
    for (const s of withValue) await out.write(`SELECT setval(${literal('postgres', qi(s.schema, s.name))}, ${s.last_value}, true);\n`)
    await out.write('\n')
  }

  if (opts.structure) {
    const oids = tables.map((t) => t.oid)
    const idx = await q(
      `select pg_get_indexdef(i.indexrelid) as def from pg_index i
       where i.indrelid = any($1) and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
       order by i.indrelid, i.indexrelid`,
      [oids],
    )
    if (idx.length) await out.write('-- ' + tr('Índices') + '\n')
    for (const i of idx) await out.write(`${i.def};\n`)

    const fks = await q(
      `select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as def
       from pg_constraint c where c.contype = 'f' and c.conrelid = any($1) order by c.conrelid, c.conname`,
      [oids],
    )
    if (fks.length) await out.write('\n-- Chaves estrangeiras\n')
    for (const f of fks) await out.write(`ALTER TABLE ${f.tbl} ADD CONSTRAINT ${d.quote(f.conname)} ${f.def};\n`)

    if (full) {
      const views = await q(
        `select c.oid, n.nspname as schema, c.relname as name, c.relkind as kind, pg_get_viewdef(c.oid, true) as def
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = any($1) and c.relkind in ('v', 'm') and ${notFromExtension('pg_class', 'c.oid')} order by c.oid`,
        [schemas],
      )
      const deps = await q(
        `select distinct r.ev_class as view, dep.refobjid as uses from pg_depend dep
         join pg_rewrite r on r.oid = dep.objid
         where dep.classid = 'pg_rewrite'::regclass and dep.refobjid <> r.ev_class and r.ev_class = any($1)`,
        [views.map((v) => v.oid)],
      )
      const byOid = new Map(views.map((v) => [v.oid, v]))
      const done = new Set()
      const visit = async (v, path = new Set()) => {
        if (done.has(v.oid) || path.has(v.oid)) return
        path.add(v.oid)
        for (const dep of deps.filter((x) => x.view === v.oid && byOid.has(x.uses))) await visit(byOid.get(dep.uses), path)
        done.add(v.oid)
        const name = qi(v.schema, v.name)
        await out.write(v.kind === 'm'
          ? `\n-- View materializada ${v.schema}.${v.name}\nCREATE MATERIALIZED VIEW ${name} AS\n${v.def.replace(/;\s*$/, '')};\n`
          : `\n-- View ${v.schema}.${v.name}\nCREATE OR REPLACE VIEW ${name} AS\n${v.def.replace(/;\s*$/, '')};\n`)
      }
      for (const v of views) await visit(v)
    }

    const triggers = await q(
      `select pg_get_triggerdef(t.oid) as def from pg_trigger t
       where t.tgrelid = any($1) and not t.tgisinternal order by t.tgrelid, t.tgname`,
      [oids],
    )
    if (triggers.length) await out.write('\n-- Triggers\n')
    for (const t of triggers) await out.write(`${t.def};\n`)
  }
}

// --- entry point ---------------------------------------------------------------------------

// opts: { file, gzip, structure, data, drop, tables: null|[names], schemas: [pg schemas] }
async function backup(d, opts, job) {
  const out = createWriter(opts.file, opts.gzip)
  try {
    if (d.dialect === 'postgres') {
      // Like pg_dump: an empty search_path makes every pg_get_*def() schema-qualify names.
      await d.client.query("select pg_catalog.set_config('search_path', '', false)")
      await d.client.query('begin isolation level repeatable read read only')
    }
    if (d.dialect === 'mysql') await d.conn.query('start transaction with consistent snapshot, read only')
    if (d.dialect === 'sqlite') d.db.exec('begin')
    const run = { sqlite: dumpSqlite, mysql: dumpMysql, postgres: dumpPostgres }[d.dialect]
    await run(d, out, opts, job)
    await out.write(`\n-- ${tr('Fim do backup ({n} linha)|Fim do backup ({n} linhas)', { n: job.totalRows })}\n`)
    await out.close()
  } catch (e) {
    await out.abort().catch(() => {})
    throw e
  }
  const { size } = await fs.promises.stat(opts.file)
  return { file: opts.file, size, rows: job.totalRows, tables: job.tableCount }
}

module.exports = { backup, literal, createWriter, writeRows }
