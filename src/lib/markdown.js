// Tiny Markdown renderer for assistant replies. Everything is HTML-escaped
// first; only a fixed set of inline marks is turned back into tags, so text
// from the model (or from database rows it quotes) can never inject HTML.
// Fenced code blocks are returned separately so the UI can add buttons.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
}

function textToHtml(text) {
  const out = []
  let list = null
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol'
      if (list?.tag !== tag) flush()
      list ||= { tag, items: [] }
      list.items.push((ul || ol)[1])
      continue
    }
    flush()
    if (h) out.push(`<div class="md-h">${inline(h[2])}</div>`)
    else if (!line.trim()) out.push('<div class="md-gap"></div>')
    else out.push(`<p>${inline(line)}</p>`)
  }
  flush()
  return out.join('')
}

// → [{ type: 'html', html } | { type: 'code', lang, code, open }]
// `open` marks a code block still being streamed (no closing fence yet).
export function renderMarkdown(text) {
  const blocks = []
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)(```|$)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) blocks.push({ type: 'html', html: textToHtml(text.slice(last, m.index)) })
    blocks.push({ type: 'code', lang: (m[1] || '').toLowerCase(), code: m[2].replace(/\n$/, ''), open: m[3] !== '```' })
    last = re.lastIndex
    if (!m[0]) break
  }
  if (last < text.length) blocks.push({ type: 'html', html: textToHtml(text.slice(last)) })
  return blocks
}
