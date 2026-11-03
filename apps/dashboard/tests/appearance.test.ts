import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { THEMES, DARK_THEMES, DEFAULT_APPEARANCE, normalizeAppearance, fromLegacy, toLegacy, appearanceVars, hydrateAppearance } from '../src/lib/appearance.ts'

test('theme lists contain the supported daisyUI themes in order', () => {
  assert.deepEqual(THEMES, ['light', 'dark', 'cupcake', 'bumblebee', 'emerald', 'corporate', 'synthwave', 'retro', 'cyberpunk', 'valentine', 'halloween', 'garden', 'forest', 'aqua', 'lofi', 'pastel', 'fantasy', 'wireframe', 'black', 'luxury', 'dracula', 'cmyk', 'autumn', 'business', 'acid', 'lemonade', 'night', 'coffee', 'winter', 'dim', 'nord', 'sunset', 'caramellatte', 'abyss', 'silk'])
  assert.deepEqual(DARK_THEMES, ['dark', 'synthwave', 'halloween', 'forest', 'aqua', 'black', 'luxury', 'dracula', 'business', 'night', 'coffee', 'dim', 'sunset', 'abyss'])
})

test('normalizeAppearance falls back per field', () => {
  assert.deepEqual(normalizeAppearance({ theme: 'not-a-theme', accent: 'blue', radius: 9, density: 'x' }),
    { theme: 'auto', accent: 'blue', radius: 2, density: 'default' })
  assert.deepEqual(normalizeAppearance(null), DEFAULT_APPEARANCE)
})

test('normalizeAppearance keeps a stored appearance from another release', () => {
  const stored = { theme: 'dracula', accent: 'theme', radius: 0, density: 'roomy' }
  assert.deepEqual(normalizeAppearance(stored), stored)
})

test('fromLegacy treats orange as never chosen', () => {
  assert.equal(fromLegacy('dark', 'orange').accent, 'theme')
  assert.equal(fromLegacy('dark', 'blue').accent, 'blue')
  assert.equal(fromLegacy('dark', 'blue').theme, 'dark')
  assert.equal(fromLegacy(undefined, undefined).theme, 'auto')
})

test('toLegacy only emits values old releases accept', () => {
  assert.deepEqual(toLegacy({ ...DEFAULT_APPEARANCE, theme: 'dracula', accent: 'red' }), { theme: 'dark', accent: 'orange' })
  assert.deepEqual(toLegacy({ ...DEFAULT_APPEARANCE, theme: 'cupcake', accent: 'theme' }), { theme: 'light', accent: 'orange' })
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

test('DARK_THEMES matches the color-scheme of each daisyUI theme file', () => {
  const themeDir = join(dirname(createRequire(import.meta.url).resolve('daisyui/package.json')), 'theme')
  for (const name of THEMES) {
    const css = readFileSync(join(themeDir, `${name}.css`), 'utf8')
    const scheme = /color-scheme:\s*(dark|light)/.exec(css)?.[1]
    assert.equal((DARK_THEMES as readonly string[]).includes(name), scheme === 'dark', name)
  }
})

test('hydrateAppearance prefers the stored appearance', () => {
  const stored = { theme: 'dracula', accent: 'red', radius: 0, density: 'roomy' }
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
