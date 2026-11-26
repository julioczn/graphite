// Picking a table in FROM / JOIN from the autocomplete also writes an alias:
// `from order_items` becomes `from order_items oi`, so the columns come right
// after with `oi.` (lang-sql already completes columns through aliases).
import { insertCompletionText, pickedCompletion } from '@codemirror/autocomplete'

// Engines whose SQL takes `table alias` after FROM and JOIN. Cassandra,
// DynamoDB (PartiQL), SurrealDB, MongoDB and Redis don't.
const DIALECTS = new Set(['postgres', 'mysql', 'sqlite', 'mssql', 'oracle', 'clickhouse', 'trino', 'firebird', 'duckdb', 'snowflake', 'bigquery'])

// Short words an alias must never be (they'd read as SQL).
const RESERVED = new Set(('as at by do go if in is no of on or to add all and any asc end for key not row set top use ' +
  'case cast desc drop else from full into join left like null over some then when with').split(' '))

// Words that may follow the table without being its alias.
const CLAUSE = new Set(('where join left right inner outer full cross natural on using group order having limit offset ' +
  'fetch union intersect except window qualify for returning set values with lateral tablesample final sample prewhere').split(' '))

// order_items -> oi, OrderItems -> oi, customers -> c, sales_2024 -> s.
export function aliasBase(name) {
  const words = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(/[^A-Za-z\d]+/).filter((w) => /^[A-Za-z]/.test(w))
  return words.map((w) => w[0]).join('').toLowerCase() || 't'
}

export function pickAlias(name, taken) {
  const base = aliasBase(name)
  if (!taken.has(base) && !RESERVED.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(base + n)) return base + n
}

const unquote = (s) => s.replace(/^[`"[](.*)[`"\]]$/, '$1')

// The statement around `pos`: from the previous `;` to the next one.
function statementBounds(doc, pos) {
  const text = doc.toString()
  const start = text.lastIndexOf(';', pos - 1) + 1
  const next = text.indexOf(';', pos)
  return [start, next < 0 ? text.length : next]
}

// Is `from..to` (the word being completed) where a table name goes?
// Returns the schema qualifier typed before it ('' or 'sales.'), or null.
export function tableSlot(doc, from, to) {
  const [start, end] = statementBounds(doc, from)
  let before = doc.sliceString(start, from)
  if (/^\s*delete\b/i.test(before)) return null // DELETE FROM t: no alias in most engines
  let qualifier = ''
  const q = /((?:[\w$]+|"[^"]*"|`[^`]*`|\[[^\]]*\]))\.$/.exec(before)
  if (q) {
    qualifier = unquote(q[1]) + '.'
    before = before.slice(0, q.index)
  }
  before = before.trimEnd()
  let slot = /\b(from|join)$/i.test(before)
  if (!slot && before.endsWith(',')) {
    const kws = before.match(/\b(select|from|where|group|order|having|limit|join|on|using|set|values|union|returning)\b/gi)
    slot = !!kws && kws[kws.length - 1].toLowerCase() === 'from'
  }
  if (!slot) return null
  // Already aliased (or still inside a longer word)? Leave it alone.
  const after = doc.sliceString(to, end)
  if (/^[\w$]/.test(after)) return null
  const next = /^\s+([A-Za-z_]\w*)/.exec(after)
  if (next && (next[1].toLowerCase() === 'as' || !CLAUSE.has(next[1].toLowerCase()))) return null
  return qualifier
}

// Every word already in the statement, except the one being replaced.
function takenWords(doc, from, to) {
  const [start, end] = statementBounds(doc, from)
  const text = doc.sliceString(start, from) + ' ' + doc.sliceString(to, end)
  return new Set((text.match(/[A-Za-z_][\w$]*/g) || []).map((w) => w.toLowerCase()))
}

// Wraps lang-sql's schema completion: table options in a FROM / JOIN slot
// insert `name alias`. The alias is picked when the option is applied, so it
// sees the statement as it is then.
export function withTableAliases(source, schema, dialect) {
  if (!DIALECTS.has(dialect)) return source
  const tables = new Set(Object.keys(schema || {}))
  return async (ctx) => {
    const r = await source(ctx)
    if (!r?.options?.length) return r
    const qualifier = tableSlot(ctx.state.doc, r.from, ctx.pos)
    if (qualifier === null) return r
    const options = r.options.map((o) => {
      const name = unquote(o.label)
      if (o.type !== 'type' || !tables.has(qualifier + name)) return o
      const text = typeof o.apply === 'string' ? o.apply : o.label
      return {
        ...o,
        apply(view, completion, from, to) {
          const { state } = view
          const ok = tableSlot(state.doc, from, to) !== null
          const insert = ok ? `${text} ${pickAlias(name, takenWords(state.doc, from, to))}` : text
          view.dispatch({ ...insertCompletionText(state, insert, from, to), annotations: pickedCompletion.of(completion) })
        },
      }
    })
    return { ...r, options }
  }
}
