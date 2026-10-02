import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmMatches } from '../src/lib/confirm-text.ts'

test('confirmMatches: the exact name, spaces around ignored', () => {
  assert.equal(confirmMatches(' data ', 'data'), true)
  assert.equal(confirmMatches('Data', 'data'), false)
  assert.equal(confirmMatches('', 'data'), false)
})
