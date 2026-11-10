import { test } from 'node:test'
import assert from 'node:assert/strict'
import { growLimit, revealLimit, LIST_STEP } from '../src/lib/progressive-list.ts'

test('scrolling near the end shows one more step, never past the list', () => {
  assert.equal(growLimit(LIST_STEP, 10_000), LIST_STEP * 2)
  assert.equal(growLimit(9_900, 10_000), 10_000)
  assert.equal(growLimit(10_000, 10_000), 10_000)
})

test('an item selected beyond what is shown gets shown, with a step after it', () => {
  assert.equal(revealLimit(LIST_STEP, 9_999), 10_000 + LIST_STEP - 1)
  assert.equal(revealLimit(LIST_STEP, 10), LIST_STEP)
})
