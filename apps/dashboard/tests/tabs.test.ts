import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTab } from '../src/lib/tabs.ts'

test('arrow keys, Home and End move between tabs', () => {
  const ids = ['overview', 'structure', 'activity']
  assert.equal(nextTab(ids, 'overview', 'ArrowRight'), 'structure')
  assert.equal(nextTab(ids, 'activity', 'ArrowRight'), 'overview', 'wraps at the end')
  assert.equal(nextTab(ids, 'overview', 'ArrowLeft'), 'activity', 'wraps at the start')
  assert.equal(nextTab(ids, 'structure', 'Home'), 'overview')
  assert.equal(nextTab(ids, 'structure', 'End'), 'activity')
  assert.equal(nextTab(ids, 'structure', 'Enter'), null)
})
