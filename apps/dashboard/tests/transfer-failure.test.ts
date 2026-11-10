import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stillRunningCount, transferFailureMessage } from '../src/lib/uploads.ts'
import { JobError } from '../src/lib/jobs.ts'

test('a failed copy names how many failed and the first reason', () => {
  assert.equal(transferFailureMessage('copy', 3, [new JobError('disk full', 'j1')]), 'Copy: 1 of 3 failed (disk full)')
  assert.equal(transferFailureMessage('move', 1, [new Error('denied')]), 'Move: 1 of 1 failed (denied)')
})

test('a copy the user cancelled is not an error', () => {
  assert.equal(transferFailureMessage('copy', 2, [new JobError('Cancelled', 'j1')]), null)
  assert.equal(transferFailureMessage('copy', 2, [new JobError('Cancelled', 'j1'), new JobError('disk full', 'j2')]), 'Copy: 1 of 2 failed (disk full)')
})

test('a copy still running after the wait is not a failure (the Activity panel follows it)', async () => {
  const { JobStillRunning } = await import('../src/lib/jobs.ts')
  assert.equal(transferFailureMessage('copy', 1, [new JobStillRunning('j1')]), null)
  assert.equal(stillRunningCount([new JobStillRunning('j1'), new JobError('disk full', 'j2')]), 1)
})
