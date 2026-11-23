#!/usr/bin/env node
// Smoke test for a packaged build: starts the app with a throwaway profile,
// waits for the window, then through the page's own bridge checks the local
// database (workspaces), and runs a query on SQLite and on DuckDB (a native
// module, the part most likely to break on a new platform). Exits non-zero
// on any failure. Used by CI on macOS, Windows and Linux.
//   node scripts/smoke.mjs <path to the app executable> [extra app args…]
// With SMOKE_ATTACH=1 it doesn't start anything and checks an app already
// listening on port 9555 (a package installed in a Linux container).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const attach = process.env.SMOKE_ATTACH === '1'
const [exe, ...extra] = process.argv.slice(2)
if (!exe && !attach) {
  console.error('usage: smoke.mjs <executable> [args…]')
  process.exit(2)
}
const PORT = 9555
const profile = attach ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'graphite-smoke-'))
// attached: the app runs elsewhere (a container), where /tmp exists too
const dbDir = attach ? '/tmp' : fs.mkdtempSync(path.join(os.tmpdir(), 'graphite-smoke-db-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let output = ''
const child = attach
  ? null
  : spawn(exe, [`--remote-debugging-port=${PORT}`, ...extra], {
      env: { ...process.env, GRAPHITE_PROFILE_DIR: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
child?.stdout.on('data', (d) => (output += d))
child?.stderr.on('data', (d) => (output += d))
child?.on('exit', (code) => {
  if (!done) fail(`app exited early with code ${code}`)
})

let done = false
function fail(msg) {
  done = true
  console.error(`SMOKE FAIL: ${msg}\n--- app output ---\n${output.slice(-4000)}`)
  try {
    child?.kill()
  } catch {}
  process.exit(1)
}
const LIMIT = attach ? 600 : 120 // seconds; a container first installs the package
setTimeout(() => fail(`timed out after ${LIMIT} s`), LIMIT * 1000).unref()

async function page() {
  for (let i = 0; i < LIMIT * 2; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch {}
    await sleep(500)
  }
  fail('no window')
}

const target = await page()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
let id = 0
const wait = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  wait.get(d.id)?.(d)
}
const ev = (expression) =>
  new Promise((resolve) => {
    const i = ++id
    wait.set(i, (d) => {
      const r = d.result
      if (r?.exceptionDetails) resolve({ error: r.exceptionDetails.exception?.description || r.exceptionDetails.text })
      else resolve({ value: r?.result?.value })
    })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
async function check(name, expression, ok) {
  const r = await ev(expression)
  if (r.error || !ok(r.value)) fail(`${name}: ${r.error || JSON.stringify(r.value)}`)
  console.log(`ok  ${name}: ${JSON.stringify(r.value)}`)
}

// The UI rendered (the connection screen shows the brand).
for (let i = 0; i < 60; i++) {
  const r = await ev(`!!document.querySelector('.wsm-btn') && document.body.innerText.includes('Graphite')`)
  if (r.value) break
  if (i === 59) fail('connection screen never rendered')
  await sleep(500)
}
console.log('ok  window rendered')
await check('app version', `graphite.appInfo().then((i) => i.version)`, (v) => /^\d+\.\d+\.\d+/.test(v))
await check('local database (workspaces)', `graphite.call('app/workspaces').then((l) => l.length)`, (n) => n >= 1)
await check('passwords encrypt and decrypt', `graphite.encrypt('s3cret').then(graphite.decrypt)`, (v) => v === 's3cret')
const run = (config) =>
  `(async () => { const c = await graphite.call('conn/open', { config: ${JSON.stringify(config)} });
     const r = await graphite.call('query/run', { sId: c.sId, sql: 'select 41 + 1 as answer' });
     await graphite.call('conn/close', { sId: c.sId });
     return JSON.stringify(r) })()`
await check('SQLite query', run({ type: 'sqlite', file: path.join(dbDir, 'smoke.db') }), (v) => /42/.test(v))
await check('DuckDB query (native module)', run({ type: 'duckdb', file: path.join(dbDir, 'smoke.duckdb') }), (v) => /42/.test(v))

done = true
ws.close()
child?.kill()
await sleep(1000)
if (!attach) for (const d of [profile, dbDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
console.log('SMOKE OK')
process.exit(0)
