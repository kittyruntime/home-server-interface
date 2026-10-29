import { computed } from 'vue'
import { createI18n } from 'vue-i18n'
import en from './locales/en'
import fr from './locales/fr'

// Interface languages (#39). English is the source and the fallback: a key
// missing from another language shows in English. The language follows the
// account preference, else the last one chosen on this browser, else the
// browser's own.
export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
] as const
export type Locale = typeof LOCALES[number]['code']

const STORAGE_KEY = 'locale'

export function isLocale(v: unknown): v is Locale {
  return LOCALES.some(l => l.code === v)
}

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLocale(saved)) return saved
  } catch { /* storage unavailable: fall through */ }
  if (typeof navigator === 'undefined') return 'en'
  const browser = (navigator.languages ?? [navigator.language]).map(l => l.slice(0, 2).toLowerCase())
  return browser.find(isLocale) ?? 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'en',
  messages: { en, fr },
})

export const locale = computed(() => i18n.global.locale.value as Locale)

export function setLocale(code: Locale) {
  i18n.global.locale.value = code
  if (typeof document !== 'undefined') document.documentElement.lang = code
  try { localStorage.setItem(STORAGE_KEY, code) } catch { /* per-browser convenience only */ }
}

if (typeof document !== 'undefined') document.documentElement.lang = i18n.global.locale.value
