// Parser for the subset of mongosh syntax Graphite's editor accepts:
//
//   show dbs | show collections
//   db.<collection>.<method>(args…)[.sort(…)][.limit(n)][.skip(n)][.project(…)]
//   db.getCollection("name").<method>(…)   db["name"].<method>(…)
//   db.<method>(…)            (runCommand, getCollectionNames, createCollection, stats…)
//
// Arguments use JSON5-like syntax (unquoted keys, single quotes, trailing
// commas, comments) plus the shell's helpers: ObjectId(), ISODate(),
// new Date(), NumberLong(), NumberInt(), NumberDecimal(), UUID(), /regex/flags.
//
// Nothing is evaluated: text from the editor or from an AI agent is parsed
// into plain values, so it can never run code in the app.
const { ObjectId, Decimal128, Long, Int32, UUID, BSONRegExp, Timestamp, MinKey, MaxKey } = require('mongodb')

class Parser {
  constructor(text) {
    this.s = text
    this.i = 0
  }

  fail(msg) {
    const near = this.s.slice(this.i, this.i + 24).replace(/\s+/g, ' ')
    throw new Error(`${msg} (${near ? `near "${near}"` : 'at the end'})`)
  }

  ws() {
    for (;;) {
      const m = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(this.s.slice(this.i))
      if (!m) return
      this.i += m[0].length
    }
  }

  peek(re) {
    this.ws()
    return re.exec(this.s.slice(this.i))
  }

  eat(token) {
    this.ws()
    if (!this.s.startsWith(token, this.i)) this.fail(`expected "${token}"`)
    this.i += token.length
  }

  maybe(token) {
    this.ws()
    if (this.s.startsWith(token, this.i)) {
      this.i += token.length
      return true
    }
    return false
  }

  ident() {
    const m = this.peek(/^[A-Za-z_$][\w$]*/)
    if (!m) this.fail('expected a name')
    this.i += m[0].length
    return m[0]
  }

  string() {
    this.ws()
    const q = this.s[this.i]
    if (q !== '"' && q !== "'") this.fail('expected a string')
    let out = ''
    for (this.i++; this.i < this.s.length; this.i++) {
      const c = this.s[this.i]
      if (c === q) {
        this.i++
        return out
      }
      if (c === '\\') {
        const n = this.s[++this.i]
        if (n === 'u') {
          out += String.fromCharCode(parseInt(this.s.slice(this.i + 1, this.i + 5), 16))
          this.i += 4
        } else out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', 0: '\0' }[n] ?? n
      } else out += c
    }
    this.fail('unterminated string')
  }

  args() {
    this.eat('(')
    const out = []
    while (!this.maybe(')')) {
      out.push(this.value())
      if (!this.maybe(',')) {
        this.eat(')')
        break
      }
    }
    return out
  }

  value() {
    this.ws()
    const c = this.s[this.i]
    if (c === '{') return this.object()
    if (c === '[') return this.array()
    if (c === '"' || c === "'") return this.string()
    if (c === '/') return this.regex()
    const num = this.peek(/^-?(0x[0-9a-f]+|\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+|Infinity)/i)
    if (num) {
      this.i += num[0].length
      return Number(num[0])
    }
    this.maybe('new ')
    const name = this.ident()
    switch (name) {
      case 'true': return true
      case 'false': return false
      case 'null': return null
      case 'undefined': return null
      case 'NaN': return NaN
    }
    const a = this.peek(/^\(/) ? this.args() : []
    switch (name) {
      case 'ObjectId': return a.length ? new ObjectId(String(a[0])) : new ObjectId()
      case 'ISODate':
      case 'Date': return a.length ? new Date(a[0]) : new Date()
      case 'NumberLong':
      case 'Long': return Long.fromString(String(a[0]))
      case 'NumberInt':
      case 'Int32': return new Int32(Number(a[0]))
      case 'NumberDecimal':
      case 'Decimal128': return Decimal128.fromString(String(a[0]))
      case 'UUID': return a.length ? new UUID(String(a[0])) : new UUID()
      case 'Timestamp': return typeof a[0] === 'object' ? new Timestamp(a[0]) : new Timestamp({ t: Number(a[0]), i: Number(a[1] ?? 0) })
      case 'MinKey': return new MinKey()
      case 'MaxKey': return new MaxKey()
    }
    this.fail(`unknown value ${name}`)
  }

  object() {
    this.eat('{')
    const out = {}
    while (!this.maybe('}')) {
      this.ws()
      const c = this.s[this.i]
      const key = c === '"' || c === "'" ? this.string() : this.peek(/^[A-Za-z_$][\w$.]*/)?.[0]
      if (key === undefined) this.fail('expected a key')
      if (c !== '"' && c !== "'") this.i += key.length
      this.eat(':')
      out[key] = this.value()
      if (!this.maybe(',')) {
        this.eat('}')
        break
      }
    }
    return out
  }

  array() {
    this.eat('[')
    const out = []
    while (!this.maybe(']')) {
      out.push(this.value())
      if (!this.maybe(',')) {
        this.eat(']')
        break
      }
    }
    return out
  }

  regex() {
    const m = /^\/((?:\\.|[^/\\\n])+)\/([a-z]*)/.exec(this.s.slice(this.i))
    if (!m) this.fail('invalid regular expression')
    this.i += m[0].length
    return new BSONRegExp(m[1], m[2])
  }
}

// One command → { kind: 'show', what } | { kind: 'db', method, args }
//              | { kind: 'coll', collection, method, args, chain: [{ method, args }] }
function parseCommand(text) {
  const src = text.trim().replace(/;+\s*$/, '')
  const show = /^show\s+(\w+)$/i.exec(src)
  if (show) return { kind: 'show', what: show[1].toLowerCase() }
  const p = new Parser(src)
  if (p.ident() !== 'db') p.fail('commands start with db. or show')
  let collection = null
  if (p.maybe('[')) {
    collection = p.string()
    p.eat(']')
  } else {
    p.eat('.')
  }
  let method = collection ? null : p.ident()
  if (method === 'getCollection' || method === 'getSiblingDB') {
    const a = p.args()
    if (method === 'getSiblingDB') p.fail('getSiblingDB is not supported; pick the database in the sidebar')
    collection = String(a[0])
    method = null
  }
  if (!collection && p.peek(/^\(/)) {
    const args = p.args()
    if (!p.peek(/^$/)) p.fail('unexpected text')
    return { kind: 'db', method, args }
  }
  if (!collection) collection = method
  p.eat('.')
  method = p.ident()
  const args = p.args()
  const chain = []
  while (p.maybe('.')) chain.push({ method: p.ident(), args: p.args() })
  if (!p.peek(/^$/)) p.fail('unexpected text')
  return { kind: 'coll', collection, method, args, chain }
}

// A filter / JSON-ish value typed in the table tab's filter box.
function parseValue(text) {
  const p = new Parser(text)
  const v = p.value()
  if (!p.peek(/^$/)) p.fail('unexpected text')
  return v
}

module.exports = { parseCommand, parseValue }
