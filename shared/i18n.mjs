// Translations shared by the renderer, the main process and the utility
// process. The pt-BR text itself is the key (gettext style): t('Nova conexão')
// shows it as-is in pt-BR and looks it up in the other languages' dictionaries,
// falling back to the Portuguese when a translation is missing.
//
//   t('Tabela {name} não encontrada', { name })      → interpolation
//   t('{n} linha|{n} linhas', { n })                 → plural (one|other)
//
// Keys must be string literals so scripts/i18n-check.mjs can find them.
import en from './locales/en.mjs'
import es from './locales/es.mjs'

export const LOCALES = [
  { id: 'pt-BR', name: 'Português (Brasil)', intl: 'pt-BR' },
  { id: 'en', name: 'English', intl: 'en-US' },
  { id: 'es', name: 'Español', intl: 'es' },
]
export const DEFAULT_LOCALE = 'en'
const DICTS = { 'pt-BR': null, en, es }

// 'system' or an explicit id → a supported locale, using the OS languages
// (e.g. ['pt-BR', 'en-US']) for 'system'.
export function resolveLocale(pref, systemLanguages = []) {
  if (pref && pref !== 'system' && pref in DICTS) return pref
  for (const lang of systemLanguages) {
    const l = String(lang).toLowerCase()
    if (l.startsWith('pt')) return 'pt-BR'
    if (l.startsWith('es')) return 'es'
    if (l.startsWith('en')) return 'en'
  }
  return DEFAULT_LOCALE
}

export const intlLocale = (locale) => LOCALES.find((l) => l.id === locale)?.intl || 'en-US'

const pluralRules = new Map()
function pickPlural(locale, text, n) {
  const i = text.indexOf('|')
  if (i < 0) return text
  let rules = pluralRules.get(locale)
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(intlLocale(locale))))
  return rules.select(Number(n)) === 'one' ? text.slice(0, i) : text.slice(i + 1)
}

export function translate(locale, key, params) {
  let s = DICTS[locale]?.[key] ?? key
  if (params) {
    if ('n' in params) s = pickPlural(locale, s, params.n)
    s = s.replace(/\{(\w+)\}/g, (m, k) => {
      if (!(k in params)) return m
      const v = params[k]
      return typeof v === 'number' ? v.toLocaleString(intlLocale(locale)) : String(v)
    })
  } else if (s.includes('|')) {
    s = pickPlural(locale, s, 2)
  }
  return s
}

// Module-level locale for the main and utility processes (the renderer keeps
// a reactive one in src/lib/i18n.js).
let current = DEFAULT_LOCALE
export const setLocale = (locale) => { current = locale in DICTS ? locale : DEFAULT_LOCALE }
export const getLocale = () => current
export const t = (key, params) => translate(current, key, params)
