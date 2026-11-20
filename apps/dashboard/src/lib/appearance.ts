// HSI's own theme family (style.css): light ones first, then dark ones. They
// share one structure and differ by their neutrals and their signal color.
export const LIGHT_THEMES = ['light', 'fog', 'sage', 'chalk'] as const
export const DARK_THEMES = ['dark', 'ink', 'moss', 'plum', 'onyx'] as const
export const THEMES = [...LIGHT_THEMES, ...DARK_THEMES] as const

/**
 * The stock daisyUI themes earlier releases offered, mapped to the closest HSI
 * theme so a saved choice keeps its spirit (light or dark, cool or warm).
 */
export const RETIRED_THEMES: Readonly<Record<string, typeof THEMES[number]>> = {
  corporate: 'fog', winter: 'fog', nord: 'fog',
  emerald: 'sage', garden: 'sage', lemonade: 'sage',
  lofi: 'chalk', wireframe: 'chalk', cmyk: 'chalk',
  cupcake: 'light', bumblebee: 'light', retro: 'light', cyberpunk: 'light', valentine: 'light',
  pastel: 'light', fantasy: 'light', autumn: 'light', acid: 'light', caramellatte: 'light', silk: 'light',
  night: 'ink', business: 'ink', aqua: 'ink', abyss: 'ink',
  forest: 'moss',
  dracula: 'plum', synthwave: 'plum',
  black: 'onyx', luxury: 'onyx',
  halloween: 'dark', coffee: 'dark', sunset: 'dark', dim: 'dark',
}

export type AccentChoice = 'theme' | 'red' | 'orange' | 'blue' | 'green' | 'purple'
export type Density = 'compact' | 'default' | 'roomy'

export interface Appearance {
  theme: 'auto' | typeof THEMES[number]
  accent: AccentChoice
  radius: 0 | 1 | 2 | 3 | 4
  density: Density
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'auto',
  accent: 'theme',
  radius: 2,
  density: 'default',
}

export const ACCENT_COLORS = {
  red: ['#d71921', '#ffffff'],
  orange: ['#f97316', '#1a1a1a'],
  blue: ['#3b82f6', '#1a1a1a'],
  green: ['#22c55e', '#1a1a1a'],
  purple: ['#a855f7', '#1a1a1a'],
} as const

export const ACCENT_NAMES = Object.keys(ACCENT_COLORS) as (keyof typeof ACCENT_COLORS)[]

const RADIUS_STEPS = {
  0: ['0rem', '0rem', '0rem'],
  1: ['0.25rem', '0.25rem', '0.25rem'],
  3: ['1rem', '0.5rem', '1rem'],
  4: ['2rem', '1rem', '2rem'],
} as const

/** `includes` on a readonly tuple only accepts the tuple's own member type, so widen it once here. */
function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

function isTheme(value: unknown): value is Appearance['theme'] {
  return value === 'auto' || isOneOf(THEMES, value)
}

function toTheme(value: unknown): Appearance['theme'] {
  if (isTheme(value)) return value
  if (typeof value === 'string' && Object.hasOwn(RETIRED_THEMES, value)) return RETIRED_THEMES[value]!
  return DEFAULT_APPEARANCE.theme
}

function isAccent(value: unknown): value is AccentChoice {
  return value === 'theme' || isOneOf(ACCENT_NAMES, value)
}

function isRadius(value: unknown): value is Appearance['radius'] {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4
}

function isDensity(value: unknown): value is Density {
  return value === 'compact' || value === 'default' || value === 'roomy'
}

export function normalizeAppearance(raw: unknown): Appearance {
  const value = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    theme: toTheme(value.theme),
    accent: isAccent(value.accent) ? value.accent : DEFAULT_APPEARANCE.accent,
    radius: isRadius(value.radius) ? value.radius : DEFAULT_APPEARANCE.radius,
    density: isDensity(value.density) ? value.density : DEFAULT_APPEARANCE.density,
  }
}

export function fromLegacy(theme?: string, accent?: string): Appearance {
  return {
    ...DEFAULT_APPEARANCE,
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
    accent: accent === 'blue' || accent === 'green' || accent === 'purple' ? accent : 'theme',
  }
}

/** The browser's stored appearance. Without a usable one (missing, malformed, or no string theme) the legacy keys apply, as in index.html. */
export function resolveStored(raw: string | null, legacyTheme?: string, legacyAccent?: string): Appearance {
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { theme?: unknown }).theme === 'string') {
        return normalizeAppearance(parsed)
      }
    } catch { /* fall through to the legacy keys */ }
  }
  return fromLegacy(legacyTheme, legacyAccent)
}

/** Appearance for the signed-in account: never inherits radius or density from the browser's previous user. */
export function hydrateAppearance(server: { appearance?: unknown; theme?: string; accent?: string }): Appearance {
  if (server.appearance) return normalizeAppearance(server.appearance)
  return fromLegacy(server.theme, server.accent)
}

export function toLegacy(a: Appearance): { theme: 'auto' | 'light' | 'dark'; accent: 'orange' | 'blue' | 'green' | 'purple' } {
  const theme = a.theme === 'auto' ? 'auto' : isOneOf(DARK_THEMES, a.theme) ? 'dark' : 'light'
  const accent = a.accent === 'blue' || a.accent === 'green' || a.accent === 'purple' ? a.accent : 'orange'
  return { theme, accent }
}

export function appearanceVars(a: Appearance): Record<string, string> {
  const vars: Record<string, string> = {}
  if (a.accent !== 'theme') {
    const [primary, content] = ACCENT_COLORS[a.accent]
    vars['--color-primary'] = primary
    vars['--color-primary-content'] = content
  }
  if (a.radius !== 2) {
    const [box, field, selector] = RADIUS_STEPS[a.radius]
    vars['--radius-box'] = box
    vars['--radius-field'] = field
    vars['--radius-selector'] = selector
  }
  if (a.density !== 'default') {
    const size = a.density === 'compact' ? '0.21875rem' : '0.28125rem'
    vars['--size-field'] = size
    vars['--size-selector'] = size
  }
  return vars
}
