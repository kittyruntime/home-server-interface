import assert from 'node:assert/strict'
import test from 'node:test'
import { isSavedBeforeStartFailure } from '../src/lib/app-deployment.ts'

test('a failed start plan identifies a completed save step for recovery', () => {
  assert.equal(isSavedBeforeStartFailure({ results: [{ status: 'done' }, { status: 'error' }] }), true)
  assert.equal(isSavedBeforeStartFailure({ results: [{ status: 'error' }] }), false)
  assert.equal(isSavedBeforeStartFailure({ results: [] }), false)
})
