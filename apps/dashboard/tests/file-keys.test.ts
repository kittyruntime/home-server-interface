import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveIndex, ownsKeyboard, typeAhead } from '../src/lib/file-keys.ts'

test('arrows move one item, Home and End to the ends, clamped', () => {
  assert.equal(moveIndex(-1, 5, 'ArrowDown'), 0)
  assert.equal(moveIndex(2, 5, 'ArrowDown'), 3)
  assert.equal(moveIndex(4, 5, 'ArrowDown'), 4)
  assert.equal(moveIndex(2, 5, 'ArrowUp'), 1)
  assert.equal(moveIndex(0, 5, 'ArrowUp'), 0)
  assert.equal(moveIndex(-1, 5, 'ArrowUp'), 4)
  assert.equal(moveIndex(2, 5, 'ArrowRight'), 3)
  assert.equal(moveIndex(2, 5, 'ArrowLeft'), 1)
  assert.equal(moveIndex(2, 5, 'Home'), 0)
  assert.equal(moveIndex(2, 5, 'End'), 4)
  assert.equal(moveIndex(2, 0, 'ArrowDown'), -1)
  assert.equal(moveIndex(2, 5, 'x'), null)
})

test('typing jumps to the first name starting with the letters, ignoring case', () => {
  const names = ['Archives', 'boot', 'Bin', 'films']
  assert.equal(typeAhead(names, 'b'), 1)
  assert.equal(typeAhead(names, 'bi'), 2)
  assert.equal(typeAhead(names, 'F'), 3)
  assert.equal(typeAhead(names, 'z'), -1)
})

test('only the file manager in the front window answers keys', () => {
  const inside = (focused: boolean) => ({ closest: (s: string) => (s === '[data-window-focused]' && focused ? {} : null) })
  assert.equal(ownsKeyboard(inside(true), true), true)
  assert.equal(ownsKeyboard(inside(false), true), false)
  // Outside the desktop (a single file manager) it always does.
  assert.equal(ownsKeyboard(inside(false), false), true)
  assert.equal(ownsKeyboard(null, true), false)
})
