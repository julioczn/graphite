// Shared between the utility process (via require(esm)) and the renderer.

// Splits a script on top-level semicolons, ignoring those inside quotes,
// comments and Postgres dollar-quoted bodies. Returns [{ text, start, end }].
export function splitStatements(input) {
  const out = []
  let start = 0
  let i = 0
  const n = input.length

  const push = (end) => {
    const raw = input.slice(start, end)
    if (stripComments(raw).trim()) out.push({ text: raw.trim(), start, end })
  }

  while (i < n) {
    const c = input[i]
    const next = input[i + 1]
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
