// Shared between the utility process (via require(esm)) and the renderer.

// PL/SQL units: their bodies contain semicolons and end at a line with only "/".
const PLSQL_START = /^(declare|begin|create\s+(or\s+replace\s+)?((editionable|noneditionable)\s+)?(procedure|function|package|trigger|type))\b/i
const PLSQL_BEGIN_TX = /^begin\s*(;|$|work\b|transaction\b)/i
// T-SQL modules must be alone in their batch: they run up to the next GO.
const TSQL_MODULE = /^(create|alter|create\s+or\s+alter)\s+(procedure|proc|function|trigger|view)\b/i

// Splits a script on top-level semicolons, ignoring those inside quotes,
// comments and Postgres dollar-quoted bodies. Returns [{ text, start, end }].
// dialect 'mssql': a line with only GO also separates batches, and
// CREATE/ALTER PROCEDURE, FUNCTION, TRIGGER, VIEW run up to that line whole.
// dialect 'oracle': a line with only / separates statements, and PL/SQL
// blocks (DECLARE/BEGIN…, CREATE PROCEDURE…) run up to that line whole.
export function splitStatements(input, dialect) {
  const out = []
  let start = 0
  let i = 0
  const n = input.length

  const push = (end) => {
    const raw = input.slice(start, end)
    if (stripComments(raw).trim()) out.push({ text: raw.trim(), start, end })
  }
  const lineAt = (pos) => {
    const eol = input.indexOf('\n', pos)
    return { text: input.slice(pos, eol === -1 ? n : eol), end: eol === -1 ? n : eol + 1 }
  }

  while (i < n) {
    const c = input[i]
    const next = input[i + 1]
    const lineStart = i === 0 || input[i - 1] === '\n'
    if (lineStart && (dialect === 'mssql' || dialect === 'oracle')) {
      const line = lineAt(i)
      const sep = dialect === 'mssql' ? /^\s*go\s*$/i : /^\s*\/\s*$/
      if (sep.test(line.text)) {
        push(i)
        start = i = line.end
        continue
      }
    }
    if ((dialect === 'oracle' || dialect === 'mssql') && !/\s/.test(c) && !input.slice(start, i).trim()) {
      const head = input.slice(i, i + 120)
      const block = dialect === 'oracle' ? PLSQL_START.test(head) && !PLSQL_BEGIN_TX.test(head) : TSQL_MODULE.test(head)
      if (block) {
        const term = (dialect === 'oracle' ? /^[ \t]*\/[ \t]*$/m : /^[ \t]*go[ \t]*$/im).exec(input.slice(i))
        const end = term ? i + term.index : n
        push(end)
        start = i = term ? i + term.index + term[0].length : n
        continue
      }
    }
    if (c === '-' && next === '-') {
      while (i < n && input[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      i++
      while (i < n) {
        if (input[i] === c && input[i + 1] === c) i += 2
        else if (input[i] === '\\' && c !== '"') i += 2
        else if (input[i] === c) break
        else i++
      }
      i++
    } else if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(input.slice(i))
      if (m) {
        const close = input.indexOf(m[0], i + m[0].length)
        i = close === -1 ? n : close + m[0].length
      } else i++
    } else if (c === ';') {
      push(i)
      start = i + 1
      i++
    } else i++
  }
  push(n)
  return out
}

export function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

export function commandOf(sql) {
  const m = /^\s*([A-Za-z]+)/.exec(stripComments(sql))
  return m ? m[1].toUpperCase() : ''
}
