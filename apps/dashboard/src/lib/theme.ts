import { ref, watchEffect } from 'vue'

export type Theme = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'brume-theme'

function readStored(): Theme {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'auto'
}

const theme = ref<Theme>(readStored())

watchEffect(() => {
  const html = document.documentElement
  if (theme.value === 'auto') {
    html.removeAttribute('data-theme')
    localStorage.removeItem(STORAGE_KEY)
  } else {
    html.setAttribute('data-theme', theme.value)
    localStorage.setItem(STORAGE_KEY, theme.value)
  }
})

export function useTheme() {
  function cycle() {
    if (theme.value === 'auto')  theme.value = 'light'
    else if (theme.value === 'light') theme.value = 'dark'
    else theme.value = 'auto'
  }
  function setTheme(value: Theme) { theme.value = value }
  return { theme, cycle, setTheme }
}

// ── Accent ────────────────────────────────────────────────────────────────────

export type Accent = 'orange' | 'blue' | 'green' | 'purple'

const ACCENT_KEY = 'brume-accent'

function readAccent(): Accent {
  const v = localStorage.getItem(ACCENT_KEY)
  if (v === 'blue' || v === 'green' || v === 'purple') return v
  return 'orange'
}

const accent = ref<Accent>(readAccent())

watchEffect(() => {
  const html = document.documentElement
  if (accent.value === 'orange') {
    html.removeAttribute('data-accent')
    localStorage.removeItem(ACCENT_KEY)
  } else {
    html.setAttribute('data-accent', accent.value)
    localStorage.setItem(ACCENT_KEY, accent.value)
  }
})

export function useAccent() {
  function setAccent(value: Accent) {
    accent.value = value
  }
  return { accent, setAccent }
}
