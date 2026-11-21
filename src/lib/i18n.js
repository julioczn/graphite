// Renderer side of shared/i18n.mjs: a reactive locale so every t() in a
// template re-renders when the language changes.
import { reactive } from 'vue'
import { translate, intlLocale, LOCALES } from '../../shared/i18n.mjs'
import { bridge } from './api'

export { LOCALES }
export const i18n = reactive({ pref: 'system', locale: 'en' })

export function t(key, params) {
  return translate(i18n.locale, key, params)
}

export const intl = () => intlLocale(i18n.locale)
export const fmtNumber = (n, opts) => Number(n).toLocaleString(intl(), opts)
export const fmtTime = (d, opts = { hour: '2-digit', minute: '2-digit', second: '2-digit' }) => new Date(d).toLocaleTimeString(intl(), opts)
export const fmtDateTime = (d, opts) => new Date(d).toLocaleString(intl(), opts)

function apply({ pref, locale }) {
  i18n.pref = pref
  i18n.locale = locale
  document.documentElement.lang = locale
}

export async function initI18n() {
  apply(await bridge.app.locale())
  bridge.app.onLocale(apply)
}

export async function setLanguage(pref) {
  apply(await bridge.app.setLocale(pref))
}
