// In-app updates from GitHub Releases (main process).
//
// electron-updater / Squirrel.Mac can't be used: they require a Developer ID
// signature, and Graphite's macOS build is ad-hoc signed. So:
//  1. check  — GET the latest release from the GitHub API (on start, then
//               every 6 h while enabled; the user can turn it off);
//  2. download — the asset for this install (macOS zip for the CPU, the
//               AppImage, or the .deb), verified against the SHA-256 digest
//               GitHub publishes for it; anything else is refused;
//  3. install — after the app quits, a small script swaps the new version in
//               (macOS: the .app bundle, restoring the old one if the swap
//               fails; AppImage: the file; .deb: pkexec dpkg -i) and relaunches.
//
// GRAPHITE_UPDATE_FEED points the check at another API base (used by tests).
const { app, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { t } = require('../shared/i18n.mjs')

const REPO = 'julioczn/graphite'
const API = (process.env.GRAPHITE_UPDATE_FEED || 'https://api.github.com').replace(/\/+$/, '')
const CHECK_EVERY = 6 * 60 * 60 * 1000
const FIRST_CHECK = 15 * 1000
// Downloads only from GitHub (or the test feed's host).
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', new URL(API).host])

// "0.10.2" > "0.9.9"; pre-releases ignored.
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('-')[0].split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out))))

// How this copy was installed, i.e. what an update replaces.
function installKind() {
  if (!app.isPackaged) return { kind: 'dev' }
  if (process.platform === 'darwin') {
    const bundle = path.resolve(app.getPath('exe'), '..', '..', '..')
    return bundle.endsWith('.app') ? { kind: 'mac', target: bundle } : { kind: 'manual' }
  }
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return { kind: 'appimage', target: process.env.APPIMAGE }
    if (app.getPath('exe').startsWith('/opt/')) return { kind: 'deb', target: path.dirname(app.getPath('exe')) }
  }
  return { kind: 'manual' }
}

function assetFor(kind, version, assets) {
  const want = {
    mac: `Graphite-${version}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`,
    appimage: `Graphite-${version}.AppImage`,
    deb: `graphite_${version}_amd64.deb`,
  }[kind]
  return want ? assets.find((a) => a.name === want) || null : null
}

// GET following redirects, only to allowed hosts.
function get(url, { json = false, onData, timeout = 30000 } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    if (!ALLOWED_HOSTS.has(u.host)) return reject(new Error(t('Download recusado: endereço inesperado ({host})', { host: u.host })))
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.get(u, { headers: { 'User-Agent': 'Graphite-Updater', Accept: json ? 'application/vnd.github+json' : '*/*' }, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume()
        return resolve(get(new URL(res.headers.location, url).toString(), { json, onData, timeout }, hops + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      if (onData) return resolve(onData(res))
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(json ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : Buffer.concat(chunks))
        } catch (e) {
          reject(e)
        }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

class Updater extends EventEmitter {
  constructor({ getPref, setPref }) {
    super()
    this.getPref = getPref
    this.setPref = setPref
    this.install = installKind()
    this.state = {
      status: 'idle', // idle | checking | none | available | downloading | ready | installing | error
      current: app.getVersion(),
      latest: null, // { version, notes, url, publishedAt }
      progress: null, // { received, total }
      error: null,
      auto: this.getPref('autoUpdate') !== false,
      canInstall: ['mac', 'appimage', 'deb'].includes(this.install.kind),
      installKind: this.install.kind,
      checkedAt: null,
    }
    this.timer = null
  }

  set(patch) {
    Object.assign(this.state, patch)
    this.emit('state', this.publicState())
  }

  publicState() {
    return { ...this.state }
  }

  start() {
    if (this.state.auto) this.schedule(FIRST_CHECK)
  }

  schedule(ms) {
    clearTimeout(this.timer)
    this.timer = setTimeout(async () => {
      await this.check().catch(() => {})
      if (this.state.auto) this.schedule(CHECK_EVERY)
    }, ms)
    this.timer.unref?.()
  }

  setAuto(on) {
    this.setPref('autoUpdate', !!on)
    this.set({ auto: !!on })
    if (on) this.schedule(FIRST_CHECK)
    else clearTimeout(this.timer)
  }

  async check() {
    if (['downloading', 'installing'].includes(this.state.status)) return this.publicState()
    const ready = this.state.status === 'ready'
    this.set({ status: 'checking', error: null })
    try {
      const rel = await get(`${API}/repos/${REPO}/releases/latest`, { json: true })
      const version = String(rel.tag_name || '').replace(/^v/, '')
      const latest = { version, notes: rel.body || '', url: rel.html_url, publishedAt: rel.published_at, assets: rel.assets || [] }
      this.release = latest
      const available = newer(version, this.state.current)
      // A download already verified for this same version stays ready to install.
      const keep = ready && this.downloaded?.version === version
      if (ready && !keep) this.discardDownload()
      this.set({ status: available ? (keep ? 'ready' : 'available') : 'none', latest: { ...latest, assets: undefined }, checkedAt: Date.now() })
    } catch (e) {
      if (ready) return this.set({ status: 'ready' }), this.publicState()
      this.set({ status: 'error', error: t('Não consegui verificar atualizações: {error}', { error: e.message }) })
    }
    return this.publicState()
  }

  async download() {
    if (!this.release || !this.state.canInstall) throw new Error(t('Atualização automática indisponível nesta instalação'))
    const asset = assetFor(this.install.kind, this.release.version, this.release.assets)
    if (!asset) throw new Error(t('Esta versão não tem um pacote para este sistema'))
    // Without the digest GitHub publishes, the download can't be verified: refuse.
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '')?.[1]
    if (!digest) throw new Error(t('O pacote não tem checksum publicado; baixe pela página da versão'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `graphite-update-${this.release.version}-`))
    const file = path.join(dir, asset.name)
    this.set({ status: 'downloading', progress: { received: 0, total: asset.size }, error: null })
    try {
      const hash = crypto.createHash('sha256')
      await get(asset.browser_download_url, {
        timeout: 120000,
        onData: (res) => new Promise((resolve, reject) => {
          const out = fs.createWriteStream(file)
          let received = 0
          let last = 0
          res.on('data', (c) => {
            hash.update(c)
            received += c.length
            if (Date.now() - last > 200) {
              last = Date.now()
              this.set({ progress: { received, total: asset.size } })
            }
          })
          res.pipe(out)
          out.on('finish', resolve)
          out.on('error', reject)
          res.on('error', reject)
        }),
      })
      if (hash.digest('hex') !== digest) throw new Error(t('O arquivo baixado não confere com o checksum publicado; a atualização foi cancelada'))
      this.downloaded = { file, dir, version: this.release.version }
      if (this.install.kind === 'mac') this.downloaded.app = await this.unpackMac(file, dir)
      this.set({ status: 'ready', progress: { received: asset.size, total: asset.size } })
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      this.set({ status: 'error', progress: null, error: e.message })
      throw e
    }
    return this.publicState()
  }

  discardDownload() {
    if (this.downloaded) fs.rmSync(this.downloaded.dir, { recursive: true, force: true })
    this.downloaded = null
  }

  // Unzips the new .app next to the download and checks it before anything is replaced.
  async unpackMac(zip, dir) {
    const out = path.join(dir, 'app')
    await run('/usr/bin/ditto', ['-x', '-k', zip, out])
    const bundle = path.join(out, 'Graphite.app')
    const plist = path.join(bundle, 'Contents', 'Info.plist')
    const id = (await run('/usr/bin/defaults', ['read', plist, 'CFBundleIdentifier'])).trim()
    const version = (await run('/usr/bin/defaults', ['read', plist, 'CFBundleShortVersionString'])).trim()
    if (id !== 'dev.graphite.sqlclient' || version !== this.release.version) throw new Error(t('O pacote baixado não é a versão esperada do Graphite'))
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    return bundle
  }

  // Quits and lets a detached script swap the new version in and relaunch it.
  async installAndRestart() {
    if (this.state.status !== 'ready' || !this.downloaded) throw new Error(t('Baixe a atualização primeiro'))
    const { kind, target } = this.install
    const script = path.join(this.downloaded.dir, 'install.sh')
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
    const wait = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`
    // Keep the profile / feed overrides (development and tests) across the relaunch.
    const keep = ['GRAPHITE_PROFILE_DIR', 'GRAPHITE_UPDATE_FEED'].filter((k) => process.env[k])
    const env = keep.map((k) => `--env ${q(`${k}=${process.env[k]}`)} `).join('')
    let body
    if (kind === 'mac') {
      fs.accessSync(path.dirname(target), fs.constants.W_OK)
      body = `${wait}
OLD=${q(target)}; NEW=${q(this.downloaded.app)}; BAK="$OLD.update-backup"
rm -rf "$BAK"
if mv "$OLD" "$BAK" && /usr/bin/ditto "$NEW" "$OLD"; then rm -rf "$BAK"; else rm -rf "$OLD"; mv "$BAK" "$OLD"; fi
/usr/bin/xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
/usr/bin/open ${env}"$OLD"
rm -rf ${q(this.downloaded.dir)}`
    } else if (kind === 'appimage') {
      fs.accessSync(path.dirname(target), fs.constants.W_OK)
      body = `${wait}
chmod +x ${q(this.downloaded.file)} && mv -f ${q(this.downloaded.file)} ${q(target)}
nohup ${q(target)} >/dev/null 2>&1 &
rm -rf ${q(this.downloaded.dir)}`
    } else if (kind === 'deb') {
      body = `${wait}
pkexec dpkg -i ${q(this.downloaded.file)}
nohup ${q(path.join(target, 'graphite'))} >/dev/null 2>&1 &
rm -rf ${q(this.downloaded.dir)}`
    } else {
      throw new Error(t('Atualização automática indisponível nesta instalação'))
    }
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()
    this.set({ status: 'installing' })
    setTimeout(() => app.quit(), 150)
  }

  openReleasePage() {
    if (this.state.latest?.url) shell.openExternal(this.state.latest.url)
  }
}

module.exports = { Updater, newer, assetFor }
