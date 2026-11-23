// SQL snippets: generic templates (typed as a short trigger in the editor or
// picked from the Snippets menu) and statements generated from a table's real
// columns (sidebar right-click).
//
// Bodies use CodeMirror's snippet syntax: `${name}` is a tab stop whose text
// is pre-selected, `${}` an empty one (a trailing `${}` is where the cursor
// ends up). Tab / Shift-Tab move between stops, Esc leaves them. Fields
// sharing a name are edited together. A literal brace is written `\{` / `\}`.
// Don't use numbered stops (`${0}`, `${1:x}`): CodeMirror visits them before
// every unnumbered one, so the cursor would start at the end.
import { quoteIdent, tableName } from './sqlText'
import { t } from './i18n'
import { store } from './store'
import { activeWorkspace } from './workspaces'

// SQL Server and Oracle have no LIMIT: rewrite the templates' row limits.
//   SQL Server: SELECT TOP n … / OFFSET … ROWS FETCH NEXT … ROWS ONLY
//   Oracle:     … FETCH FIRST n ROWS ONLY / OFFSET … ROWS FETCH NEXT … ROWS ONLY
export function withLimit(text, dialect) {
  // Trino has LIMIT but puts OFFSET first.
  if (dialect === 'trino') return text.replace(/\nLIMIT (\d+) OFFSET (\d+);/, '\nOFFSET $2 LIMIT $1;')
  if (dialect !== 'mssql' && dialect !== 'oracle' && dialect !== 'firebird') return text
  const paged = /\nLIMIT (\d+) OFFSET (\d+);/
  if (paged.test(text)) return text.replace(paged, '\nOFFSET $2 ROWS FETCH NEXT $1 ROWS ONLY;')
  const m = /\nLIMIT (\d+);/.exec(text)
  if (!m) return text
  if (dialect === 'oracle' || dialect === 'firebird') return text.replace(m[0], `\nFETCH FIRST ${m[1]} ROWS ONLY;`)
  return text.replace(m[0], ';').replace(/^SELECT( DISTINCT)?/, `SELECT$1 TOP ${m[1]}`)
}

// --- generic templates ------------------------------------------------------

// Each entry: [trigger, title, body] or [trigger, title, { postgres, mysql, sqlite }]
// where a dialect may be missing (snippet not offered there). Built on each
// call so titles follow the current language; field names in the bodies are
// written in Portuguese and translated by localizeFields().
const groups = () => [
  [t('Consulta'), [
    ['sel', t('SELECT básico'), 'SELECT ${*}\nFROM ${tabela}\nWHERE ${condicao}\nORDER BY ${coluna}\nLIMIT 100;${}'],
    ['seld', 'SELECT DISTINCT', 'SELECT DISTINCT ${coluna}\nFROM ${tabela}\nORDER BY ${coluna};${}'],
    ['cnt', t('Contar linhas'), 'SELECT count(*)\nFROM ${tabela}\nWHERE ${condicao};${}'],
    ['grp', t('GROUP BY com HAVING'), 'SELECT ${coluna}, count(*) AS total\nFROM ${tabela}\nGROUP BY ${coluna}\nHAVING count(*) > 1\nORDER BY total DESC;${}'],
    ['pag', t('Paginação (LIMIT / OFFSET)'), 'SELECT *\nFROM ${tabela}\nORDER BY ${id}\nLIMIT 50 OFFSET 0;${}'],
    ['busca', t('Buscar texto'), {
      postgres: "SELECT *\nFROM ${tabela}\nWHERE ${coluna} ILIKE '%${texto}%';${}",
      mysql: "SELECT *\nFROM ${tabela}\nWHERE ${coluna} LIKE '%${texto}%';${}",
      sqlite: "SELECT *\nFROM ${tabela}\nWHERE ${coluna} LIKE '%${texto}%';${}",
    }],
    ['entre', t('Intervalo de datas'), "SELECT *\nFROM ${tabela}\nWHERE ${data} >= '${2025-01-01}'\n  AND ${data} < '${2025-02-01}';${}"],
    ['cte', 'WITH (CTE)', 'WITH ${base} AS (\n  SELECT ${*}\n  FROM ${tabela}\n  WHERE ${condicao}\n)\nSELECT *\nFROM ${base};${}'],
    ['case', 'CASE WHEN', "CASE\n  WHEN ${condicao} THEN ${'valor'}\n  ELSE ${'outro'}\nEND${}"],
    ['exists', 'WHERE EXISTS', 'SELECT *\nFROM ${tabela} a\nWHERE EXISTS (\n  SELECT 1\n  FROM ${outra} b\n  WHERE b.${a_id} = a.${id}\n);${}'],
    ['in', t('WHERE IN (subconsulta)'), 'SELECT *\nFROM ${tabela}\nWHERE ${coluna} IN (\n  SELECT ${coluna_ref}\n  FROM ${outra}\n  WHERE ${condicao}\n);${}'],
    ['rank', t('ROW_NUMBER (janela)'), 'SELECT *\nFROM (\n  SELECT t.*,\n         row_number() OVER (PARTITION BY ${grupo} ORDER BY ${ordem} DESC) AS n\n  FROM ${tabela} t\n) x\nWHERE n <= 3;${}'],
    ['dup', t('Achar duplicados'), 'SELECT ${coluna}, count(*) AS vezes\nFROM ${tabela}\nGROUP BY ${coluna}\nHAVING count(*) > 1\nORDER BY vezes DESC;${}'],
  ]],
  ['Joins', [
    ['ij', 'INNER JOIN', 'SELECT a.*, b.*\nFROM ${tabela} a\nJOIN ${outra} b ON b.${id} = a.${outra_id}\nLIMIT 100;${}'],
    ['lj', 'LEFT JOIN', 'SELECT a.*, b.*\nFROM ${tabela} a\nLEFT JOIN ${outra} b ON b.${id} = a.${outra_id}\nLIMIT 100;${}'],
    ['rj', 'RIGHT JOIN', 'SELECT a.*, b.*\nFROM ${tabela} a\nRIGHT JOIN ${outra} b ON b.${id} = a.${outra_id}\nLIMIT 100;${}'],
    ['fj', 'FULL OUTER JOIN', {
      postgres: 'SELECT a.*, b.*\nFROM ${tabela} a\nFULL OUTER JOIN ${outra} b ON b.${id} = a.${outra_id}\nLIMIT 100;${}',
      sqlite: 'SELECT a.*, b.*\nFROM ${tabela} a\nFULL OUTER JOIN ${outra} b ON b.${id} = a.${outra_id}\nLIMIT 100;${}',
      // MySQL has no FULL JOIN: LEFT JOIN union the right-only rows.
      mysql: 'SELECT a.*, b.*\nFROM ${tabela} a\nLEFT JOIN ${outra} b ON b.${id} = a.${outra_id}\nUNION ALL\nSELECT a.*, b.*\nFROM ${tabela} a\nRIGHT JOIN ${outra} b ON b.${id} = a.${outra_id}\nWHERE a.${outra_id} IS NULL;${}',
    }],
    ['cj', 'CROSS JOIN', 'SELECT a.*, b.*\nFROM ${tabela} a\nCROSS JOIN ${outra} b;${}'],
    ['antij', t('Sem correspondência (anti join)'), 'SELECT a.*\nFROM ${tabela} a\nLEFT JOIN ${outra} b ON b.${a_id} = a.${id}\nWHERE b.${a_id} IS NULL;${}'],
    ['j3', t('Três tabelas'), 'SELECT a.*, b.*, c.*\nFROM ${tabela} a\nJOIN ${outra} b ON b.${id} = a.${outra_id}\nJOIN ${terceira} c ON c.${id} = b.${terceira_id}\nLIMIT 100;${}'],
  ]],
  [t('Alterar dados'), [
    ['ins', 'INSERT', 'INSERT INTO ${tabela} (${coluna1}, ${coluna2})\nVALUES (${valor1}, ${valor2});${}'],
    ['insm', t('INSERT várias linhas'), 'INSERT INTO ${tabela} (${coluna1}, ${coluna2})\nVALUES\n  (${valor1}, ${valor2}),\n  (${valor3}, ${valor4});${}'],
    ['inss', 'INSERT … SELECT', 'INSERT INTO ${destino} (${colunas})\nSELECT ${colunas}\nFROM ${origem}\nWHERE ${condicao};${}'],
    ['insr', 'INSERT … RETURNING', {
      postgres: 'INSERT INTO ${tabela} (${coluna1}, ${coluna2})\nVALUES (${valor1}, ${valor2})\nRETURNING *;${}',
      sqlite: 'INSERT INTO ${tabela} (${coluna1}, ${coluna2})\nVALUES (${valor1}, ${valor2})\nRETURNING *;${}',
    }],
    ['ups', t('UPSERT (insere ou atualiza)'), {
      postgres: 'INSERT INTO ${tabela} (${id}, ${coluna})\nVALUES (${valor_id}, ${valor})\nON CONFLICT (${id}) DO UPDATE\n  SET ${coluna} = EXCLUDED.${coluna};${}',
      sqlite: 'INSERT INTO ${tabela} (${id}, ${coluna})\nVALUES (${valor_id}, ${valor})\nON CONFLICT (${id}) DO UPDATE\n  SET ${coluna} = excluded.${coluna};${}',
      mysql: 'INSERT INTO ${tabela} (${id}, ${coluna})\nVALUES (${valor_id}, ${valor})\nON DUPLICATE KEY UPDATE\n  ${coluna} = VALUES(${coluna});${}',
    }],
    ['upd', 'UPDATE', 'UPDATE ${tabela}\nSET ${coluna} = ${valor}\nWHERE ${id} = ${valor_id};${}'],
    ['updj', t('UPDATE com JOIN'), {
      postgres: 'UPDATE ${tabela} a\nSET ${coluna} = b.${coluna_b}\nFROM ${outra} b\nWHERE b.${id} = a.${outra_id};${}',
      sqlite: 'UPDATE ${tabela} AS a\nSET ${coluna} = b.${coluna_b}\nFROM ${outra} AS b\nWHERE b.${id} = a.${outra_id};${}',
      mysql: 'UPDATE ${tabela} a\nJOIN ${outra} b ON b.${id} = a.${outra_id}\nSET a.${coluna} = b.${coluna_b};${}',
    }],
    ['del', 'DELETE', 'DELETE FROM ${tabela}\nWHERE ${id} = ${valor_id};${}'],
    ['delj', t('DELETE com JOIN'), {
      postgres: 'DELETE FROM ${tabela} a\nUSING ${outra} b\nWHERE b.${id} = a.${outra_id}\n  AND ${condicao};${}',
      mysql: 'DELETE a\nFROM ${tabela} a\nJOIN ${outra} b ON b.${id} = a.${outra_id}\nWHERE ${condicao};${}',
      sqlite: 'DELETE FROM ${tabela}\nWHERE ${outra_id} IN (\n  SELECT ${id}\n  FROM ${outra}\n  WHERE ${condicao}\n);${}',
    }],
    ['tx', t('Transação'), {
      postgres: 'BEGIN;\n\n${}\n\nCOMMIT;',
      sqlite: 'BEGIN;\n\n${}\n\nCOMMIT;',
      mysql: 'START TRANSACTION;\n\n${}\n\nCOMMIT;',
    }],
  ]],
  [t('Estrutura'), [
    ['ct', 'CREATE TABLE', {
      postgres: 'CREATE TABLE ${tabela} (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${nome} text NOT NULL,\n  created_at timestamptz NOT NULL DEFAULT now()\n);${}',
      mysql: 'CREATE TABLE ${tabela} (\n  id bigint unsigned AUTO_INCREMENT PRIMARY KEY,\n  ${nome} varchar(255) NOT NULL,\n  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP\n);${}',
      sqlite: "CREATE TABLE ${tabela} (\n  id integer PRIMARY KEY AUTOINCREMENT,\n  ${nome} text NOT NULL,\n  created_at text NOT NULL DEFAULT (datetime('now'))\n);${}",
    }],
    ['addcol', t('Adicionar coluna'), 'ALTER TABLE ${tabela}\n  ADD COLUMN ${coluna} ${text};${}'],
    ['dropcol', t('Remover coluna'), 'ALTER TABLE ${tabela}\n  DROP COLUMN ${coluna};${}'],
    ['rencol', t('Renomear coluna'), 'ALTER TABLE ${tabela}\n  RENAME COLUMN ${antiga} TO ${nova};${}'],
    ['idx', 'CREATE INDEX', 'CREATE INDEX ${tabela}_${coluna}_idx\n  ON ${tabela} (${coluna});${}'],
    ['uidx', 'CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX ${tabela}_${coluna}_key\n  ON ${tabela} (${coluna});${}'],
    ['fk', t('Chave estrangeira'), {
      postgres: 'ALTER TABLE ${tabela}\n  ADD CONSTRAINT ${tabela}_${outra}_fk\n  FOREIGN KEY (${outra_id}) REFERENCES ${outra} (${id})\n  ON DELETE ${CASCADE};${}',
      mysql: 'ALTER TABLE ${tabela}\n  ADD CONSTRAINT ${tabela}_${outra}_fk\n  FOREIGN KEY (${outra_id}) REFERENCES ${outra} (${id})\n  ON DELETE ${CASCADE};${}',
      // SQLite can't add a constraint to an existing table.
    }],
    ['view', 'CREATE VIEW', 'CREATE VIEW ${nome} AS\nSELECT ${*}\nFROM ${tabela}\nWHERE ${condicao};${}'],
    ['drop', 'DROP TABLE', 'DROP TABLE IF EXISTS ${tabela};${}'],
  ]],
  [t('Diagnóstico'), [
    ['exp', t('Plano de execução'), {
      postgres: 'EXPLAIN (ANALYZE, BUFFERS)\n${SELECT 1};',
      mysql: 'EXPLAIN ANALYZE\n${SELECT 1};',
      sqlite: 'EXPLAIN QUERY PLAN\n${SELECT 1};',
    }],
    ['cols', t('Colunas de uma tabela'), {
      postgres: "SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = current_schema() AND table_name = '${tabela}'\nORDER BY ordinal_position;${}",
      mysql: "SELECT column_name, column_type, is_nullable, column_default, extra\nFROM information_schema.columns\nWHERE table_schema = database() AND table_name = '${tabela}'\nORDER BY ordinal_position;${}",
      sqlite: "SELECT * FROM pragma_table_info('${tabela}');${}",
    }],
    ['tam', t('Tamanho das tabelas'), {
      postgres: "SELECT relname AS tabela,\n       pg_size_pretty(pg_total_relation_size(relid)) AS total,\n       n_live_tup AS linhas_aprox\nFROM pg_stat_user_tables\nORDER BY pg_total_relation_size(relid) DESC;",
      mysql: 'SELECT table_name AS tabela,\n       round((data_length + index_length) / 1024 / 1024, 2) AS mb,\n       table_rows AS linhas_aprox\nFROM information_schema.tables\nWHERE table_schema = database()\nORDER BY data_length + index_length DESC;',
      sqlite: "SELECT name AS tabela, sum(pgsize) / 1024 AS kb\nFROM dbstat\nGROUP BY name\nORDER BY kb DESC;",
    }],
    ['proc', t('Consultas em andamento'), {
      postgres: "SELECT pid, usename, state, now() - query_start AS duracao, query\nFROM pg_stat_activity\nWHERE state <> 'idle' AND pid <> pg_backend_pid()\nORDER BY duracao DESC;",
      mysql: 'SHOW FULL PROCESSLIST;',
    }],
  ]],
]

// Portuguese field name → its name in the current language. Names missing
// here (`${*}`, `${id}`, `${a_id}`, `${text}`, `${CASCADE}`, `${SELECT 1}`, dates…)
// are SQL and stay as they are. Translations must stay valid field names: no
// braces and no leading digit.
const fieldNames = () => ({
  tabela: t('tabela'),
  condicao: t('condicao'),
  coluna: t('coluna'),
  colunas: t('colunas'),
  coluna1: t('coluna1'),
  coluna2: t('coluna2'),
  coluna_ref: t('coluna_ref'),
  coluna_b: t('coluna_b'),
  texto: t('texto'),
  data: t('data'),
  base: t('base'),
  "'valor'": "'" + t('valor') + "'",
  "'outro'": "'" + t('outro') + "'",
  valor: t('valor'),
  valor1: t('valor1'),
  valor2: t('valor2'),
  valor3: t('valor3'),
  valor4: t('valor4'),
  valor_id: t('valor_id'),
  outra: t('outra'),
  outra_id: t('outra_id'),
  terceira: t('terceira'),
  terceira_id: t('terceira_id'),
  grupo: t('grupo'),
  ordem: t('ordem'),
  destino: t('destino'),
  origem: t('origem'),
  nome: t('nome'),
  antiga: t('antiga'),
  nova: t('nova'),
})

// Renames the tab stops only: order, empty `${}` stops and the rest of the
// text are untouched.
function localizeFields(body, names) {
  return body.replace(/\$\{([^{}]*)\}/g, (m, name) => (Object.hasOwn(names, name) ? '${' + names[name] + '}' : m))
}

export function snippetsFor(dialect) {
  const names = fieldNames()
  // The workspace's own snippets come first (Meus snippets dialog).
  const own = t('Meus snippets')
  const out = (activeWorkspace()?.snippets || []).map((s) => ({ group: own, trigger: s.trigger, title: s.title || s.trigger, body: s.body, own: true }))
  for (const [group, items] of groups()) {
    for (const [trigger, title, body] of items) {
      const text = typeof body === 'string' ? body : body[dialect]
      if (text) out.push({ group, trigger, title, body: localizeFields(withLimit(text, dialect), names) })
    }
  }
  return out
}

// A template as plain SQL: tab stops shown as their default text.
export function plain(body) {
  return body.replace(/[#$]\{(?:\d+:?)?([^{}]*)\}/g, '$1').replace(/\\([{}])/g, '$1')
}

// One-line preview for lists.
export const preview = (body) => plain(body).replace(/\s+/g, ' ').trim()

// --- generated from a table's columns ----------------------------------------

// Literal text inside a template must not open a tab stop.
const esc = (s) => String(s).replace(/[{}]/g, '\\$&')
// A tab stop showing `label`. Braces can't appear inside a field name, and a
// name starting with a digit would be read as a numbered stop (`${1}`).
const field = (label) => '${' + String(label).replace(/[{}\\]/g, '_').replace(/^(\d)/, '_$1') + '}'

const NUMERIC = /^(tiny|small|medium|big)?int|^integer|^number|^serial|^bigserial|^smallserial|^numeric|^decimal|^real|^float|^double|^bit\b|^year|^money|^bool/i

// Placeholder for a value: quoted for text-like types, bare for numbers.
function valueStop(col) {
  return NUMERIC.test(col.type || '') ? field(col.name) : `'${field(col.name)}'`
}

// Short unique alias per table: customers → c, order_items → oi.
function aliasFor(name, used) {
  const base = String(name).split(/[_\W]+/).filter(Boolean).map((w) => w[0].toLowerCase()).join('') || 't'
  let a = base
  for (let i = 2; used.has(a); i++) a = base + i
  used.add(a)
  return a
}

// "customers(id)" → { table: 'customers', column: 'id' }
function parseRef(ref) {
  const m = /^(.*)\(([^()]*)\)$/.exec(ref || '')
  return m ? { table: m[1], column: m[2] } : null
}

export function tableSnippets(table, columns) {
  const target = esc(tableName(table.name, table.schema))
  const q = (c) => esc(quoteIdent(c))
  const pk = columns.filter((c) => c.primary)
  const keyCols = pk.length ? pk : columns.slice(0, 1)
  const where = keyCols.map((c) => `${q(c.name)} = ${valueStop(c)}`).join('\n  AND ')
  const writable = columns.filter((c) => !c.auto)
  // Identity / auto-increment / generated columns can't be written.
  const nonKey = columns.filter((c) => !c.primary && !c.auto)

  const out = {
    select: withLimit(`SELECT ${columns.map((c) => q(c.name)).join(',\n       ')}\nFROM ${target}\nLIMIT 100;${'${}'}`, store.connection?.dialect),
    insert: `INSERT INTO ${target} (${writable.map((c) => q(c.name)).join(', ')})\nVALUES (${writable.map(valueStop).join(', ')});${'${}'}`,
    update: nonKey.length
      ? `UPDATE ${target}\nSET ${nonKey.map((c) => `${q(c.name)} = ${valueStop(c)}`).join(',\n    ')}\nWHERE ${where};${'${}'}`
      : null,
    delete: `DELETE FROM ${target}\nWHERE ${where};${'${}'}`,
    join: null,
  }

  // Follow the table's foreign keys: one JOIN per referencing column, LEFT
  // when the column is nullable so rows without a match are kept.
  const fks = columns.map((c) => ({ c, ref: parseRef(c.references) })).filter((x) => x.ref)
  if (fks.length) {
    const used = new Set()
    const me = aliasFor(table.name, used)
    const joins = fks.map(({ c, ref }) => {
      const a = aliasFor(ref.table, used)
      const kind = c.nullable ? 'LEFT JOIN' : 'JOIN'
      return { a, sql: `${kind} ${esc(tableName(ref.table, c.refSchema ?? table.schema))} ${a} ON ${a}.${q(ref.column)} = ${me}.${q(c.name)}` }
    })
    out.join = withLimit(`SELECT ${me}.*, ${joins.map((j) => `${j.a}.*`).join(', ')}\nFROM ${target} ${me}\n${joins.map((j) => j.sql).join('\n')}\nLIMIT 100;${'${}'}`, store.connection?.dialect)
  }
  return out
}
