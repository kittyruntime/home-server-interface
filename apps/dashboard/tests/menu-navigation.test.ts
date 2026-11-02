import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextIndex, typeaheadIndex } from '../src/lib/menu-navigation.ts'

test('nextIndex wraps and skips disabled', () => {
  assert.equal(nextIndex('ArrowDown', 2, [false, true, false]), 0)
  assert.equal(nextIndex('ArrowUp', 0, [false, true, false]), 2)
  assert.equal(nextIndex('Home', 2, [true, false, false]), 1)
  assert.equal(nextIndex('End', 0, [false, false, true]), 1)
  assert.equal(nextIndex('ArrowDown', 0, [true, true]), 0)
})

test('nextIndex keeps the current index for an empty array', () => {
  assert.equal(nextIndex('ArrowDown', 3, []), 3)
})

test('typeaheadIndex searches after current, case insensitive', () => {
  assert.equal(typeaheadIndex('d', ['Delete', 'Rename', 'Download'], 0), 2)
  assert.equal(typeaheadIndex('R', ['Delete', 'Rename'], 1), 1)
  assert.equal(typeaheadIndex('z', ['Delete'], 0), -1)
})

test('typeaheadIndex returns no match for an empty query', () => {
  assert.equal(typeaheadIndex('', ['Delete', 'Rename'], 0), -1)
})
