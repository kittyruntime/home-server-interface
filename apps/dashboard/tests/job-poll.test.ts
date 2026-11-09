import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollDelay } from '../src/lib/jobs.ts'

test('a job is checked quickly at first, then every 1.5 s', () => {
  assert.deepEqual([0, 1, 2, 3].map(pollDelay), [100, 250, 500, 1000])
  assert.equal(pollDelay(4), 1500)
  assert.equal(pollDelay(40), 1500)
  // A fast job (a new folder) is seen within the first two checks, well
  // under the former fixed 1.5 s.
  assert.ok(pollDelay(0) + pollDelay(1) < 500)
})
