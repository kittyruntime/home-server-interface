import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shownWindows } from '../src/lib/desktop-order.ts'

const w = (id: string, zIndex: number, minimized = false) => ({ id, zIndex, minimized })

test('focusing a window does not move it in the page', () => {
  // Moving the element between pointerdown and pointerup loses the click:
  // the stacking comes from z-index, the order stays the opening order.
  assert.deepEqual(shownWindows([w('a', 5), w('b', 1), w('c', 3)]).map(x => x.id), ['a', 'b', 'c'])
})

test('minimized windows are not shown', () => {
  assert.deepEqual(shownWindows([w('a', 1, true), w('b', 2)]).map(x => x.id), ['b'])
})
