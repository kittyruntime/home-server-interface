import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowFor, scrollTopFor } from '../src/lib/virtual-rows.ts'

test('only the rows in view (plus a margin) are rendered', () => {
  // 10,000 rows of 40 px, a 400 px view scrolled to row 1,000.
  const w = windowFor({ scrollTop: 40_000, viewport: 400, rowHeight: 40, total: 10_000, perRow: 1, overscan: 5 })
  assert.deepEqual(w, { start: 995, end: 1015, padTop: 995 * 40, padBottom: (10_000 - 1015) * 40 })
})

test('a grid renders whole rows of cards', () => {
  const w = windowFor({ scrollTop: 0, viewport: 300, rowHeight: 100, total: 25, perRow: 4, overscan: 1 })
  // Rows 0..3 in view plus one: 4 rows of 4 cards.
  assert.deepEqual(w, { start: 0, end: 16, padTop: 0, padBottom: (7 - 4) * 100 })
})

test('the window never goes past the list', () => {
  const w = windowFor({ scrollTop: 1_000_000, viewport: 400, rowHeight: 40, total: 50, perRow: 1, overscan: 5 })
  assert.equal(w.end, 50)
  assert.equal(w.padBottom, 0)
})

test('jumping to an item scrolls just enough to show it', () => {
  // Row 500 of 40 px, list starting 60 px down the scroll area, 400 px view.
  assert.equal(scrollTopFor({ index: 500, perRow: 1, rowHeight: 40, listTop: 60, scrollTop: 0, viewport: 400 }), 60 + 500 * 40 + 40 - 400)
  // Already in view: no scroll.
  assert.equal(scrollTopFor({ index: 2, perRow: 1, rowHeight: 40, listTop: 60, scrollTop: 0, viewport: 400 }), null)
  // Above the view: scrolls up to it.
  assert.equal(scrollTopFor({ index: 1, perRow: 1, rowHeight: 40, listTop: 60, scrollTop: 5_000, viewport: 400 }), 60 + 40)
})
