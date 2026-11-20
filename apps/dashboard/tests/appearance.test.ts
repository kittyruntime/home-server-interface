import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEMES, DARK_THEMES, LIGHT_THEMES, RETIRED_THEMES, DEFAULT_APPEARANCE, normalizeAppearance, fromLegacy, toLegacy, appearanceVars, hydrateAppearance, resolveStored } from '../src/lib/appearance.ts'

const styleCss = readFileSync(join(import.meta.dirname, '../src/style.css'), 'utf8')
const themeBlocks = [...styleCss.matchAll(/@plugin "daisyui\/theme" \{([^}]*)\}/g)].map(m => ({
  name: /name:\s*"([a-z]+)"/.exec(m[1]!)?.[1],
  scheme: /color-scheme:\s*(dark|light)/.exec(m[1]!)?.[1],
}))

test('theme lists are the HSI themes, light ones first', () => {
  assert.deepEqual(LIGHT_THEMES, ['light', 'fog', 'sage', 'chalk'])
  assert.deepEqual(DARK_THEMES, ['dark', 'ink', 'moss', 'plum', 'onyx'])
  assert.deepEqual(THEMES, [...LIGHT_THEMES, ...DARK_THEMES])
})

test('every theme is defined in style.css with the matching color scheme', () => {
  assert.deepEqual(themeBlocks.map(b => b.name).sort(), [...THEMES].sort())
  for (const b of themeBlocks) assert.equal(b.scheme, (DARK_THEMES as readonly string[]).includes(b.name!) ? 'dark' : 'light', b.name)
})

test('the pre-paint script knows the same themes', () => {
  const html = readFileSync(join(import.meta.dirname, '../index.html'), 'utf8')
  const list = /var themes = \[([^\]]*)\]/.exec(html)?.[1]?.match(/[a-z]+/g)
  assert.deepEqual(list?.sort(), [...THEMES].sort())
})

test('retired stock themes map to an HSI theme of the same scheme', () => {
  const darkStock = ['synthwave', 'halloween', 'forest', 'aqua', 'black', 'luxury', 'dracula', 'business', 'night', 'coffee', 'dim', 'sunset', 'abyss']
  assert.equal(Object.keys(RETIRED_THEMES).length, 33)
  for (const [old, now] of Object.entries(RETIRED_THEMES)) {
    assert.ok((THEMES as readonly string[]).includes(now), old)
    assert.equal((DARK_THEMES as readonly string[]).includes(now), darkStock.includes(old), old)
  }
})

test('normalizeAppearance falls back per field', () => {
  assert.deepEqual(normalizeAppearance({ theme: 'not-a-theme', accent: 'blue', radius: 9, density: 'x' }),
    { theme: 'auto', accent: 'blue', radius: 2, density: 'default' })
  assert.deepEqual(normalizeAppearance(null), DEFAULT_APPEARANCE)
})

test('normalizeAppearance keeps an HSI theme and moves a retired one to its successor', () => {
  const stored = { theme: 'moss', accent: 'theme', radius: 0, density: 'roomy' } as const
  assert.deepEqual(normalizeAppearance(stored), stored)
  assert.equal(normalizeAppearance({ theme: 'dracula' }).theme, 'plum')
  assert.equal(normalizeAppearance({ theme: 'nord' }).theme, 'fog')
})

test('fromLegacy treats orange as never chosen', () => {
  assert.equal(fromLegacy('dark', 'orange').accent, 'theme')
  assert.equal(fromLegacy('dark', 'blue').accent, 'blue')
  assert.equal(fromLegacy('dark', 'blue').theme, 'dark')
  assert.equal(fromLegacy(undefined, undefined).theme, 'auto')
})

test('toLegacy only emits values old releases accept', () => {
  assert.deepEqual(toLegacy({ ...DEFAULT_APPEARANCE, theme: 'plum', accent: 'red' }), { theme: 'dark', accent: 'orange' })
  assert.deepEqual(toLegacy({ ...DEFAULT_APPEARANCE, theme: 'sage', accent: 'theme' }), { theme: 'light', accent: 'orange' })
  assert.deepEqual(toLegacy({ ...DEFAULT_APPEARANCE, accent: 'purple' }), { theme: 'auto', accent: 'purple' })
})

test('appearanceVars leaves neutral positions unset', () => {
  assert.deepEqual(appearanceVars(DEFAULT_APPEARANCE), {})
  const v = appearanceVars({ ...DEFAULT_APPEARANCE, accent: 'blue', radius: 0, density: 'compact' })
  assert.equal(v['--color-primary'], '#3b82f6')
  assert.ok(v['--color-primary-content'])
  assert.equal(v['--radius-box'], '0rem')
  assert.equal(v['--size-field'], '0.21875rem')
})

test('appearanceVars maps accents, radius steps, and density', () => {
  const accents = {
    red: ['#d71921', '#ffffff'],
    orange: ['#f97316', '#1a1a1a'],
    blue: ['#3b82f6', '#1a1a1a'],
    green: ['#22c55e', '#1a1a1a'],
    purple: ['#a855f7', '#1a1a1a'],
  } as const
  for (const [accent, [primary, content]] of Object.entries(accents)) {
    const vars = appearanceVars({ ...DEFAULT_APPEARANCE, accent: accent as keyof typeof accents })
    assert.equal(vars['--color-primary'], primary)
    assert.equal(vars['--color-primary-content'], content)
  }
  for (const [radius, box, field, selector] of [
    [0, '0rem', '0rem', '0rem'],
    [1, '0.25rem', '0.25rem', '0.25rem'],
    [3, '1rem', '0.5rem', '1rem'],
    [4, '2rem', '1rem', '2rem'],
  ] as const) {
    const vars = appearanceVars({ ...DEFAULT_APPEARANCE, radius })
    assert.equal(vars['--radius-box'], box)
    assert.equal(vars['--radius-field'], field)
    assert.equal(vars['--radius-selector'], selector)
  }
  assert.deepEqual(appearanceVars({ ...DEFAULT_APPEARANCE, density: 'roomy' }), {
    '--size-field': '0.28125rem',
    '--size-selector': '0.28125rem',
  })
})

test('hydrateAppearance prefers the stored appearance', () => {
  const stored = { theme: 'ink', accent: 'red', radius: 0, density: 'roomy' }
  assert.deepEqual(hydrateAppearance({ appearance: stored, theme: 'light', accent: 'blue' }), stored)
})

test('hydrateAppearance falls back to the legacy pair with default radius and density', () => {
  assert.deepEqual(hydrateAppearance({ theme: 'dark', accent: 'green' }),
    { theme: 'dark', accent: 'green', radius: 2, density: 'default' })
})

test('hydrateAppearance gives defaults for an empty object', () => {
  assert.deepEqual(hydrateAppearance({}), DEFAULT_APPEARANCE)
})

test('normalizeAppearance rejects inherited object keys as accent or theme', () => {
  const a = normalizeAppearance({ accent: 'toString', theme: 'constructor' })
  assert.equal(a.accent, 'theme')
  assert.equal(a.theme, 'auto')
})

test('resolveStored uses the stored appearance when it has a theme', () => {
  assert.deepEqual(resolveStored('{"theme":"fog","accent":"blue"}', 'dark', 'red'),
    normalizeAppearance({ theme: 'fog', accent: 'blue' }))
})

test('resolveStored falls back to the legacy keys without a string theme', () => {
  assert.equal(resolveStored('{"accent":"blue"}', 'dark', undefined).theme, 'dark')
  assert.equal(resolveStored('{"theme":3}', 'dark', undefined).theme, 'dark')
  assert.equal(resolveStored('null', 'dark', undefined).theme, 'dark')
})

test('resolveStored falls back to the legacy keys on malformed or missing JSON', () => {
  assert.equal(resolveStored('{oops', 'dark', 'blue').theme, 'dark')
  assert.equal(resolveStored('{oops', 'dark', 'blue').accent, 'blue')
  assert.deepEqual(resolveStored(null, undefined, undefined), DEFAULT_APPEARANCE)
})
