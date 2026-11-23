#!/usr/bin/env node
// Installs DuckDB's native binding for each target of a build, so one machine
// can package other architectures (npm only installs the host's binding).
// electron-builder then keeps just the matching one per package (see build.files).
//   node scripts/native-bindings.mjs <platform> <arch> [arch…]
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [platform, ...archs] = process.argv.slice(2)
if (!platform || !archs.length) {
  console.error('usage: native-bindings.mjs <platform> <arch> [arch…]')
  process.exit(1)
}
const { version } = JSON.parse(readFileSync(path.join(root, 'node_modules/@duckdb/node-bindings/package.json'), 'utf8'))
const missing = archs
  .map((arch) => `@duckdb/node-bindings-${platform}-${arch}`)
  .filter((name) => !existsSync(path.join(root, 'node_modules', name, 'duckdb.node')))
if (missing.length) {
  const specs = missing.map((name) => `${name}@${version}`)
  console.log('installing', specs.join(' '))
  // --force: install bindings for another OS/CPU than this machine's.
  // npm is npm.cmd on Windows, which needs a shell.
  execFileSync('npm', ['install', '--no-save', '--force', '--no-audit', '--no-fund', ...specs], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}
