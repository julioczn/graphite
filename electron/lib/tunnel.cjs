// SSH tunnels. A connection whose config has `ssh` reaches its database
// through an SSH server (a bastion): Graphite logs in there and listens on a
// local port (127.0.0.1, a random one); every socket the driver opens to that
// port is forwarded over the SSH connection to the database's host and port,
// as seen from the SSH server ("localhost" = the SSH server itself).
//
// config.ssh = { host, port = 22, user, auth: 'password' | 'key' | 'agent',
//                keyFile (auth 'key'; empty = ~/.ssh/id_ed25519, id_ecdsa, id_rsa),
//                secret (the password, or the key's passphrase) }
//
// The driver gets a copy of the config pointing at the local port, plus
// `tunnelHost` (the real host name) so TLS still checks the certificate
// against it (lib/tls.cjs). MongoDB URLs are rewritten with
// directConnection=true; Oracle over TLS goes through a local HTTPS proxy
// (CONNECT), the way its driver keeps checking the real host name.
//
// One SSH connection per (SSH server, user, credentials, database endpoint), shared by the
// connections and background jobs using it, closed shortly after the last one.
// Host keys are trusted on first use and remembered in
// <userData>/ssh-known-hosts.json; a changed key is refused.
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { t } = require('../../shared/i18n.mjs')

const IDLE_CLOSE_MS = 3000
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa']

let knownFile = null
const pool = new Map() // key → Tunnel

function setStore(dir) {
  knownFile = path.join(dir, 'ssh-known-hosts.json')
}

const wants = (c) => !!(c && c.ssh && typeof c.ssh === 'object' && String(c.ssh.host || '').trim())

const fail = (msg) => Object.assign(new Error(msg), { user: true })
const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

// "host:port", "[v6]:port" or "host" → { host, port }
function splitHostPort(s, defPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s)
  if (!m) return { host: s, port: defPort }
  return { host: m[1], port: Number(m[2]) || defPort }
}

// Where the database is (from the SSH server) and how to point the driver at
// the local end: { host, port, proxy, apply(localPort) → config }.
function endpoint(c, engine) {
  const family = engine?.family
  if (family === 'mongo') {
    const url = String(c.url || '').trim() || 'mongodb://localhost:27017'
    if (/^mongodb\+srv:/i.test(url)) throw fail(t('O túnel SSH não funciona com endereços mongodb+srv://. Use mongodb://host:porta do servidor.'))
    const m = /^(mongodb:\/\/)([^@/?]*@)?([^/?]+)(.*)$/i.exec(url)
    if (!m) throw fail(t('URL do MongoDB inválida.'))
    if (m[3].includes(',')) throw fail(t('O túnel SSH leva a um servidor só: informe um host, não uma lista.'))
    const { host, port } = splitHostPort(m[3], 27017)
    let rest = m[4] || ''
    if (!/[?&]directConnection=/i.test(rest)) rest += rest.includes('?') ? '&directConnection=true' : (rest.startsWith('/') ? '' : '/') + '?directConnection=true'
    return { host, port, apply: (lp) => ({ ...c, url: `${m[1]}${m[2] || ''}127.0.0.1:${lp}${rest}`, tunnelHost: host }) }
  }
  // ClickHouse and Trino also take a full http(s):// URL as the host.
  if ((family === 'clickhouse' || family === 'trino') && /^https?:\/\//i.test(c.host || '')) {
    const u = new URL(c.host)
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    return {
      host: u.hostname,
      port,
      apply: (lp) => {
        const v = new URL(c.host)
        v.hostname = '127.0.0.1'
        v.port = String(lp)
        return { ...c, host: v.toString().replace(/\/+$/, ''), tunnelHost: u.hostname }
      },
    }
  }
  const hosts = String(c.host || 'localhost').split(',').map((h) => h.trim()).filter(Boolean)
  if (hosts.length > 1) throw fail(t('O túnel SSH leva a um servidor só: informe um host, não uma lista.'))
  const { host, port: inHost } = hosts[0] && hosts[0].includes(':') && !c.port ? splitHostPort(hosts[0], 0) : { host: hosts[0] || 'localhost', port: 0 }
  const port = Number(c.port) || inHost || Number(engine?.port) || 0
  if (!port) throw fail(t('Informe a porta do banco para usar o túnel SSH.'))
  // Oracle checks the certificate against the host it dialed; through an HTTPS
  // proxy it dials (and checks) the real one.
  if (family === 'oracle' && c.ssl) return { host, port, proxy: true, apply: (lp) => ({ ...c, host, port: String(port), httpsProxy: '127.0.0.1', httpsProxyPort: lp, tunnelHost: host }) }
  return { host, port, apply: (lp) => ({ ...c, host: '127.0.0.1', port: String(lp), tunnelHost: host }) }
}

// --- host keys (trust on first use) ---------------------------------------------

function readKnown() {
  try {
    return JSON.parse(fs.readFileSync(knownFile, 'utf8'))
  } catch {
    return {}
  }
}

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

// --- the SSH connection -------------------------------------------------------------

function authOptions(ssh) {
  const auth = ssh.auth || 'password'
  if (auth === 'agent') {
    const agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK
    if (!agent) throw fail(t('Não achei o agente SSH (SSH_AUTH_SOCK). Inicie o ssh-agent ou use uma chave.'))
    return { agent }
  }
  if (auth === 'key') {
    const files = ssh.keyFile ? [home(String(ssh.keyFile).trim())] : DEFAULT_KEYS.map((k) => path.join(os.homedir(), '.ssh', k))
    const file = files.find((f) => fs.existsSync(f))
    if (!file) throw fail(ssh.keyFile ? t('Não achei a chave SSH {file}.', { file: ssh.keyFile }) : t('Não achei uma chave em ~/.ssh (id_ed25519, id_ecdsa ou id_rsa). Escolha o arquivo da chave.'))
    let privateKey
    try {
      privateKey = fs.readFileSync(file)
    } catch (e) {
      throw fail(t('Não consegui ler a chave SSH {file}: {error}', { file: path.basename(file), error: e.code || e.message }))
    }
    return { privateKey, passphrase: ssh.secret || undefined, keyFile: file }
  }
  return { password: ssh.secret || '', tryKeyboard: true }
}

function sshError(e, ssh, where) {
  const msg = String(e?.message || e)
  const code = e?.code || e?.level
  if (/authentication methods failed/i.test(msg)) return fail(t('O servidor SSH {host} recusou o login de {user}. Confira o usuário e a senha ou a chave.', { host: where, user: ssh.user || '?' }))
  if (/no passphrase given/i.test(msg)) return fail(t('A chave SSH tem senha (passphrase): informe-a no campo da senha.'))
  if (/Cannot parse privateKey.*(decrypt|passphrase|bad)/i.test(msg)) return fail(t('A senha da chave SSH (passphrase) não confere.'))
  if (/Cannot parse privateKey/i.test(msg)) return fail(t('Não entendi o arquivo da chave SSH: {error}', { error: msg.replace(/^Cannot parse privateKey: /, '') }))
  if (/Timed out while waiting for handshake/i.test(msg) || code === 'ETIMEDOUT') return fail(t('O servidor SSH {host} não respondeu a tempo.', { host: where }))
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return fail(t('Não encontrei o servidor SSH {host}.', { host: where }))
  if (code === 'ECONNREFUSED') return fail(t('O servidor SSH {host} recusou a conexão. A porta está certa?', { host: where }))
  return fail(t('Falha no túnel SSH ({host}): {error}', { host: where, error: msg }))
}

class Tunnel {
  constructor(key, ssh, dst) {
    this.key = key
    this.ssh = ssh
    this.dst = dst // { host, port, proxy }
    this.refs = 0
    this.closed = false
    this.forwardError = null
    this.hostKey = null // { fingerprint, isNew }
    this.ready = this.open()
  }

  async open() {
    const { Client } = require('ssh2')
    const ssh = this.ssh
    const sshPort = Number(ssh.port) || 22
    const where = `${ssh.host}:${sshPort}`
    const auth = authOptions(ssh)
    const known = knownFile ? readKnown() : {}
    let mismatch = null
    const client = (this.client = new Client())
    await new Promise((resolve, reject) => {
      client
        .on('ready', resolve)
        .on('error', (e) => reject(mismatch || sshError(e, ssh, where)))
        .on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => auth.password || '')))
      // connect() throws right away on a key it can't parse (or decrypt).
      try {
        client.connect({
          host: String(ssh.host).trim(),
          port: sshPort,
          username: String(ssh.user || '').trim() || os.userInfo().username,
          ...auth,
          readyTimeout: 20000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 4,
          hostVerifier: (key) => {
            const fp = fingerprint(key)
            const before = known[where]
            if (before && before !== fp) {
              mismatch = fail(t('A chave do servidor SSH {host} mudou desde a última conexão ({fingerprint}). Se a mudança é esperada, apague a linha dele em {file} e conecte de novo.', { host: where, fingerprint: fp, file: knownFile }))
              return false
            }
            this.hostKey = { fingerprint: fp, isNew: !before }
            return true
          },
        })
      } catch (e) {
        reject(sshError(e, ssh, where))
      }
    })
    if (this.hostKey?.isNew && knownFile) {
      const all = readKnown()
      all[where] = this.hostKey.fingerprint
      try {
        fs.writeFileSync(knownFile, JSON.stringify(all, null, 2), { mode: 0o600 })
      } catch {}
    }
    client.on('close', () => this.close())
    client.on('error', () => this.close())

    const forward = (sock, done) => {
      client.forwardOut('127.0.0.1', sock.remotePort || 0, this.dst.host, this.dst.port, (err, stream) => {
        if (err) {
          this.forwardError = err.message || String(err)
          sock.destroy()
          return
        }
        this.forwardError = null
        done?.()
        sock.on('error', () => stream.destroy())
        stream.on('error', () => sock.destroy())
        sock.pipe(stream).pipe(sock)
      })
    }
    // Plain forwarding, or (Oracle TLS) an HTTPS proxy that only goes to the database.
    const onSocket = this.dst.proxy
      ? (sock) => {
          let head = ''
          const onData = (d) => {
            head += d.toString('latin1')
            if (head.length > 8192) return sock.destroy()
            if (!head.includes('\r\n\r\n')) return
            sock.removeListener('data', onData)
            if (!/^CONNECT \S+ HTTP\/1\.[01]\r\n/i.test(head)) return sock.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
            sock.pause()
            forward(sock, () => {
              sock.write('HTTP/1.1 200 Connection established\r\n\r\n')
              sock.resume()
            })
          }
          sock.on('data', onData)
          sock.on('error', () => {})
        }
      : (sock) => {
          sock.on('error', () => {})
          forward(sock)
        }
    const server = (this.server = net.createServer(onSocket))
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    this.localPort = server.address().port
    if (this.closed) throw fail(t('O túnel SSH caiu.'))
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idle)
    if (pool.get(this.key) === this) pool.delete(this.key)
    try {
      this.server?.close()
    } catch {}
    try {
      this.client?.end()
    } catch {}
  }
}

/**
 * Opens (or reuses) the tunnel for a connection config. Returns
 * { config, release, info, forwardError() }; `config` is what the driver uses.
 */
async function acquire(config, engine) {
  const ssh = config.ssh
  const dst = endpoint(config, engine)
  // The credentials are part of the key (hashed): a wrong password must not
  // ride on a tunnel someone opened with the right one.
  const cred = crypto.createHash('sha256').update(String(ssh.secret || '')).digest('hex')
  const key = JSON.stringify([String(ssh.host).trim(), Number(ssh.port) || 22, ssh.user || '', ssh.auth || 'password', ssh.keyFile || '', cred, dst.host, dst.port, !!dst.proxy])
  let tun = pool.get(key)
  if (!tun || tun.closed) {
    tun = new Tunnel(key, ssh, dst)
    pool.set(key, tun)
  }
  tun.refs++
  clearTimeout(tun.idle)
  try {
    await tun.ready
  } catch (e) {
    tun.refs--
    tun.close()
    throw e
  }
  let released = false
  return {
    config: dst.apply(tun.localPort),
    info: { via: `${ssh.user ? ssh.user + '@' : ''}${ssh.host}${Number(ssh.port) && Number(ssh.port) !== 22 ? ':' + ssh.port : ''}`, target: `${dst.host}:${dst.port}`, hostKey: tun.hostKey },
    forwardError: () => tun.forwardError,
    release() {
      if (released) return
      released = true
      if (--tun.refs <= 0) {
        clearTimeout(tun.idle)
        tun.idle = setTimeout(() => tun.refs <= 0 && tun.close(), IDLE_CLOSE_MS)
        tun.idle.unref?.()
      }
    },
  }
}

// Wraps a driver so connect() opens the tunnel first and disconnect() lets it go.
// `driver.sourceConfig` keeps the original config (with `ssh`) for new connections.
function wrap(d, config, engine) {
  const connect = d.connect.bind(d)
  const disconnect = d.disconnect.bind(d)
  let lease = null
  d.sourceConfig = config
  d.connect = async () => {
    lease = await acquire(config, engine)
    d.config = lease.config
    try {
      await connect()
    } catch (e) {
      const why = lease.forwardError()
      lease.release()
      lease = null
      d.config = config
      if (why) throw fail(t('O servidor SSH não conseguiu abrir {target}: {error}. Lembre que o host e a porta do banco são vistos a partir do servidor SSH.', { target: `${endpoint(config, engine).host}:${endpoint(config, engine).port}`, error: why }))
      throw e
    }
  }
  d.disconnect = async () => {
    try {
      await disconnect()
    } finally {
      lease?.release()
      lease = null
    }
  }
  d.tunnelInfo = () => lease?.info || null
  return d
}

function closeAll() {
  for (const tun of [...pool.values()]) tun.close()
}

module.exports = { setStore, wants, wrap, acquire, endpoint, closeAll }
