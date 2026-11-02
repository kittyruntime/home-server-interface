import { test } from 'node:test'
import assert from 'node:assert/strict'
import en from '../src/i18n/locales/en.ts'
import fr from '../src/i18n/locales/fr.ts'

function keys(o: unknown, prefix = ''): string[] {
  if (typeof o !== 'object' || o === null) return [prefix]
  return Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
}

test('every language has exactly the English keys', () => {
  const english = new Set(keys(en))
  const french = new Set(keys(fr))
  assert.deepEqual([...english].filter(k => !french.has(k)), [], 'missing in French')
  assert.deepEqual([...french].filter(k => !english.has(k)), [], 'unknown to English')
})
