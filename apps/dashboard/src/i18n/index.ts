import { computed } from 'vue'
import { createI18n } from 'vue-i18n'
import en from './locales/en'

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
  // Typed with every language, though only English is loaded up front.
  messages: { en } as Partial<Record<Locale, typeof en>>,
})

// English ships in the main bundle; the other languages load on first use.
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<{ default: typeof en }>> = {
  fr: () => import('./locales/fr'),
}

export async function loadLocale(code: Locale): Promise<void> {
  if (code === 'en' || i18n.global.availableLocales.includes(code)) return
  i18n.global.setLocaleMessage(code, (await loaders[code]()).default)
}

export const locale = computed(() => i18n.global.locale.value as Locale)

export async function setLocale(code: Locale) {
  await loadLocale(code)
  i18n.global.locale.value = code
  if (typeof document !== 'undefined') document.documentElement.lang = code
  try { localStorage.setItem(STORAGE_KEY, code) } catch { /* per-browser convenience only */ }
}

if (typeof document !== 'undefined') document.documentElement.lang = i18n.global.locale.value
