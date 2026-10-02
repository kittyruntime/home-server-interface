import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmMatches, removeNotice } from '../src/lib/confirm-text.ts'

test('confirmMatches: the exact name, spaces around ignored', () => {
  assert.equal(confirmMatches(' data ', 'data'), true)
  assert.equal(confirmMatches('Data', 'data'), false)
  assert.equal(confirmMatches('', 'data'), false)
})

test('removeNotice says what is lost', () => {
  assert.equal(removeNotice('data3', '1.2 TB'), 'The 1.2 TB of data on data3 will be erased.')
  assert.equal(removeNotice('data3'), 'The data on data3 will be erased.')
})
