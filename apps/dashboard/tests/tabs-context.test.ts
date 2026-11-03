import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepFocused, makeId } from '../src/components/ui/tabs/context.ts'

test('makeId encodes a value so the id holds no space', () => {
  const id = makeId('tabs-1', 'trigger', 'my tab/1')
  assert.equal(id, 'tabs-1-trigger-my%20tab%2F1')
  assert.ok(!/\s/.test(id))
})

test('makeId keeps trigger and content ids paired and distinct per value', () => {
  assert.notEqual(makeId('t', 'trigger', 'a b'), makeId('t', 'trigger', 'a_b'))
  assert.equal(makeId('t', 'trigger', 'x').replace('trigger', 'content'), makeId('t', 'content', 'x'))
})

test('keepFocused keeps a value whose trigger is still there', () => {
  assert.equal(keepFocused('b', ['a', 'b']), 'b')
})

test('keepFocused clears a value whose trigger is gone', () => {
  assert.equal(keepFocused('c', ['a', 'b']), null)
  assert.equal(keepFocused(null, ['a']), null)
})
