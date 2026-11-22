// AWS Signature Version 4 for a single request (no SDK).
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
const { createHash, createHmac } = require('node:crypto')

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha256', key).update(s).digest()
// RFC 3986: encodeURIComponent leaves !'()* alone, SigV4 wants them encoded.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

// Returns the headers to send (the given ones plus host, x-amz-date,
// x-amz-security-token and Authorization).
function sign({ method, url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const u = new URL(url)
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate, ...(sessionToken && { 'x-amz-security-token': sessionToken }) }
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]))
  const names = Object.keys(lower).sort()
  const query = [...u.searchParams]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [
    method.toUpperCase(),
    u.pathname.split('/').map(enc).join('/') || '/',
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    sha256(body),
  ].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  }
}

module.exports = { sign }
