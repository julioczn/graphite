#!/usr/bin/env node
// Checks the translations: every t('…') key used in the code must exist in
// each dictionary (shared/locales/*.mjs) with the same {placeholders} and the
// same plural form, and dictionaries shouldn't keep unused keys.
//   node scripts/i18n-check.mjs            → report, exit 1 on problems
//   node scripts/i18n-check.mjs --suspects → also list Portuguese-looking text
//                                            outside t() (likely untranslated)
//   node scripts/i18n-check.mjs --missing <locale> → JSON of missing keys
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const DIRS = ['src', 'electron', 'shared']
const SKIP = /(^|\/)(locales|node_modules)\//

function* files(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (SKIP.test(rel + '/')) continue
    if (e.isDirectory()) yield* files(rel)
    else if (/\.(vue|js|mjs|cjs)$/.test(e.name)) yield rel
  }
}

// t('…') or tr('…') (alias where `t` is a loop variable) — keys must be plain literals (no ${}).
const CALL = /(?<![\w$.])tr?\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)/g
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c))

const used = new Map() // key -> [file:line]
const problems = []
for (const f of DIRS.flatMap((d) => [...files(d)])) {
  // Blank out comments (keeping offsets) so examples in them don't count.
  const src = fs.readFileSync(path.join(root, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, (m) => ' '.repeat(m.length))
  for (const m of src.matchAll(CALL)) {
    const raw = m[1] ?? m[2] ?? m[3]
    const line = src.slice(0, m.index).split('\n').length
    if (m[3] !== undefined && raw.includes('${')) { problems.push(`${f}:${line}  template literal with \${} as a key — use {params}`); continue }
    const key = unescape(raw)
    if (!used.has(key)) used.set(key, [])
    used.get(key).push(`${f}:${line}`)
  }
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
const locales = fs.readdirSync(path.join(root, 'shared/locales')).filter((f) => f.endsWith('.mjs'))
const report = {}
for (const lf of locales) {
  const id = lf.replace(/\.mjs$/, '')
  const dict = (await import(pathToFileURL(path.join(root, 'shared/locales', lf)))).default
  const missing = [...used.keys()].filter((k) => !(k in dict))
  const unused = Object.keys(dict).filter((k) => !used.has(k))
  const bad = []
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'string' || !v.trim()) bad.push(`${JSON.stringify(k)}: empty or not a string`)
    else if (placeholders(k) !== placeholders(v)) bad.push(`${JSON.stringify(k)}: placeholders {${placeholders(k)}} vs {${placeholders(v)}}`)
    else if (k.includes('|') !== v.includes('|')) bad.push(`${JSON.stringify(k)}: plural form (one|other) doesn't match`)
  }
  report[id] = { missing, unused, bad }
}

if (args[0] === '--missing') {
  const id = args[1]
  console.log(JSON.stringify(Object.fromEntries(report[id].missing.map((k) => [k, used.get(k)[0]])), null, 2))
  process.exit(0)
}

let fail = problems.length > 0
for (const p of problems) console.log('✗', p)
console.log(`${used.size} keys used in the code`)
for (const [id, r] of Object.entries(report)) {
  console.log(`\n[${id}] missing ${r.missing.length} · unused ${r.unused.length} · invalid ${r.bad.length}`)
  for (const k of r.missing.slice(0, 40)) console.log('  missing:', JSON.stringify(k), '←', used.get(k)[0])
  if (r.missing.length > 40) console.log(`  … ${r.missing.length - 40} more`)
  for (const k of r.unused.slice(0, 20)) console.log('  unused:', JSON.stringify(k))
  for (const b of r.bad) console.log('  invalid:', b)
  if (r.missing.length || r.bad.length) fail = true
}

// Heuristic: Portuguese-looking text that isn't inside t(). Template text
// nodes and string literals with accents or common Portuguese words.
if (args.includes('--suspects')) {
  const PT = /[ãõçáéíóúâêô]|\b(não|sim|nenhum|nenhuma|salvar|cancelar|abrir|fechar|tabela|coluna|linhas?|consulta|conexão|erro|copiar|remover|adicionar|editar|novo|nova|carregando|executar|selecionar|valor|vazio|para|com|sem|uma?)\b/i
  console.log('\nSuspects (Portuguese outside t()):')
  for (const f of DIRS.flatMap((d) => [...files(d)])) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n')
    lines.forEach((l, i) => {
      const code = l.replace(CALL, '').replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/<!--.*?-->/g, '')
      const strings = [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
      if (strings.some((s) => s && /[a-zà-ú]{2}/i.test(s) && PT.test(s))) console.log(`  ${f}:${i + 1}  ${l.trim().slice(0, 140)}`)
    })
  }
}
process.exit(fail ? 1 : 0)
