import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SLOW_CLICK_MS, slowClick } from '../src/lib/slow-click.ts'

test('a click on the name of the only selected item renames it after a pause', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let renamed = 0
  const s = slowClick()
  s.arm(() => renamed++)
  mock.timers.tick(SLOW_CLICK_MS - 1)
  assert.equal(renamed, 0)
  mock.timers.tick(1)
  assert.equal(renamed, 1)
  mock.timers.reset()
})

test('a double click opens instead: the pending rename is dropped', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let renamed = 0
  const s = slowClick()
  s.arm(() => renamed++)
  mock.timers.tick(100)
  s.cancel()
  mock.timers.tick(SLOW_CLICK_MS)
  assert.equal(renamed, 0)
  mock.timers.reset()
})

test('a new click restarts the wait', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let renamed = 0
  const s = slowClick()
  s.arm(() => renamed++)
  mock.timers.tick(SLOW_CLICK_MS - 50)
  s.arm(() => renamed++)
  mock.timers.tick(SLOW_CLICK_MS - 1)
  assert.equal(renamed, 0)
  mock.timers.tick(1)
  assert.equal(renamed, 1)
  mock.timers.reset()
})
