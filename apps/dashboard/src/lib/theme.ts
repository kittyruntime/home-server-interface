import { ref, watchEffect } from 'vue'
import {
  DEFAULT_APPEARANCE, appearanceVars, fromLegacy, normalizeAppearance, toLegacy,
  type Appearance,
} from './appearance'

const STORAGE_KEY = 'appearance'

function readItem(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeItem(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* storage unavailable, the appearance still applies for this session */ }
}

function readStored(): Appearance {
  const raw = readItem(STORAGE_KEY)
  if (raw !== null) {
    try { return normalizeAppearance(JSON.parse(raw)) } catch { /* fall through to legacy keys */ }
  }
  return fromLegacy(readItem('theme') ?? undefined, readItem('accent') ?? undefined)
}

const appearance = ref<Appearance>(readStored())

// Inline properties set on <html> by the previous run, to clear the ones that no longer apply.
let appliedVars: string[] = []

watchEffect(() => {
  const html = document.documentElement
  const a = appearance.value

  if (a.theme === 'auto') html.removeAttribute('data-theme')
  else html.setAttribute('data-theme', a.theme)

  const vars = appearanceVars(a)
  for (const name of appliedVars) if (!(name in vars)) html.style.removeProperty(name)
  for (const [name, value] of Object.entries(vars)) html.style.setProperty(name, value)
  appliedVars = Object.keys(vars)

  writeItem(STORAGE_KEY, JSON.stringify(a))
  // Read by the inline script in index.html to paint the right look before the bundle loads.
  writeItem('appearance-vars', Object.keys(vars).length ? JSON.stringify(vars) : null)
  const legacy = toLegacy(a)
  writeItem('theme', legacy.theme === 'auto' ? null : legacy.theme)
  writeItem('accent', legacy.accent === 'orange' ? null : legacy.accent)
})

export function useAppearance() {
  function setAppearance(patch: Partial<Appearance>) {
    appearance.value = normalizeAppearance({ ...appearance.value, ...patch })
  }
  function resetAppearance() { appearance.value = { ...DEFAULT_APPEARANCE } }
  return { appearance, setAppearance, resetAppearance }
}
