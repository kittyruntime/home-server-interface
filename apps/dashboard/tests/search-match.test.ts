import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldText, matchesQuery } from '../src/lib/search-match.ts'

const E_ACUTE = String.fromCharCode(0xe9)
const COMBINING_ACUTE = String.fromCharCode(0x301)

test('foldText strips accents and case', () => {
  assert.equal(foldText(`Th${E_ACUTE}ophile`), 'theophile')
  assert.equal(foldText(`Cre${COMBINING_ACUTE}me`), 'creme')
})

test('matchesQuery ignores accents on either side', () => {
  assert.ok(matchesQuery('theo', `Th${E_ACUTE}ophile`))
  assert.ok(matchesQuery(`th${E_ACUTE}o`, 'Theophile'))
  assert.ok(matchesQuery('admin', 'Bob', 'Admin'))
  assert.ok(matchesQuery('  ', 'Bob'))
  assert.ok(!matchesQuery('zz', 'Bob', 'Admin'))
})
