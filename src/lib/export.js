import { bridge } from './api'
import { toast } from './store'
import { t } from './i18n'

function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function exportRows(fields, rows, format, baseName) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const name = `${baseName.replace(/[^\w.-]+/g, '_')}_${stamp}.${format}`
  const content = format === 'csv'
    ? [fields.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n')
    : JSON.stringify(rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]]))), null, 2)
  const path = await bridge.saveFile({
    defaultName: name,
    content,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  })
  if (path) toast(t('{n} linha exportada para {path}|{n} linhas exportadas para {path}', { n: rows.length, path }), 'success', 4500)
}
