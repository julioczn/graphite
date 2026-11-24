// TLS settings of a connection → Node TLS options, shared by the drivers.
//
// config.ssl        TLS on/off
// config.sslMode    'require'     encrypt, accept any server certificate
//                   'verify-ca'   the certificate must chain to a trusted CA
//                   'verify-full' …and match the host name (default for new connections)
//                   Connections saved before sslMode existed keep 'require'.
// config.sslCa      CA certificate(s), PEM file (else the system's trusted CAs)
// config.sslCert    client certificate, PEM file (mutual TLS)
// config.sslKey     client private key, PEM file (mutual TLS)
// config.tunnelHost set by an SSH tunnel (lib/tunnel.cjs): the driver dials
//                   127.0.0.1, but the certificate is checked against this name
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const path = require('node:path')
const { t } = require('../../shared/i18n.mjs')

function readPem(file, what) {
  if (!file) return undefined
  try {
    return fs.readFileSync(file)
  } catch (e) {
    throw new Error(t('Não consegui ler o arquivo de {what} ({file}): {error}', { what, file: path.basename(file), error: e.code || e.message }))
  }
}

const modeOf = (c) => (['require', 'verify-ca', 'verify-full'].includes(c.sslMode) ? c.sslMode : 'require')

// → null when TLS is off; otherwise { ca, cert, key, rejectUnauthorized, checkServerIdentity? }
function tlsOptions(c) {
  if (!c.ssl) return null
  const mode = modeOf(c)
  const o = {
    ca: readPem(c.sslCa, t('certificado da CA')),
    cert: readPem(c.sslCert, t('certificado do cliente')),
    key: readPem(c.sslKey, t('chave do cliente')),
    rejectUnauthorized: mode !== 'require',
  }
  if ((o.cert && !o.key) || (o.key && !o.cert)) throw new Error(t('Para autenticar com certificado, informe o certificado e a chave do cliente'))
  // verify-ca: trust the chain but not the name (e.g. connecting by IP or through a tunnel).
  if (mode === 'verify-ca') o.checkServerIdentity = () => undefined
  else if (c.tunnelHost) {
    // Through an SSH tunnel: SNI and the name check use the real host.
    if (!net.isIP(c.tunnelHost)) o.servername = c.tunnelHost
    if (mode === 'verify-full') o.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(c.tunnelHost, cert)
  }
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

module.exports = { tlsOptions, modeOf, readPem }
