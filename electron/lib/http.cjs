// fetch()-like request over node:http / node:https, for HTTP drivers that
// need custom TLS (CA, client certificate, verification mode) — the global
// fetch can't take those. Returns { ok, status, headers.get(), text(), json() }.
const http = require('node:http')
const https = require('node:https')

function request(url, { method = 'GET', headers = {}, body, signal, tls } = {}) {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers, ...(u.protocol === 'https:' && tls ? tls : {}), signal }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (name) => { const v = res.headers[name.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null } },
          text: async () => text,
          json: async () => JSON.parse(text),
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

module.exports = { request }
