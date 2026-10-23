import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastResultText, lastResultIsProblem, previousVersionText, rollbackCommand } from '../src/lib/update-result.ts'
import { formatDay } from '../src/lib/format-date.ts'

const base = { from: 'v1.66.0', to: 'v1.67.0', step: 'health', reason: 'database check failed', at: '2026-10-22T10:00:00Z' }

test('last result line per status', () => {
  assert.equal(lastResultText(null), null)
  assert.equal(lastResultText({ ...base, status: 'success' }), 'Updated from v1.66.0 to v1.67.0')
  assert.equal(
    lastResultText({ ...base, status: 'rolled-back' }),
    'Update to v1.67.0 failed at step health (database check failed). Rolled back to v1.66.0.',
  )
  assert.equal(
    lastResultText({ ...base, status: 'rollback-failed' }),
    'Update to v1.67.0 failed at step health (database check failed) and the rollback failed. Manual recovery is needed.',
  )
  assert.equal(lastResultText({ ...base, status: 'refused' }), 'Update to v1.67.0 refused at step health (database check failed).')
})

test('the rollback line names the version `update rollback` brings back', () => {
  assert.equal(previousVersionText(null, 'v1.67.0', formatDay), null)
  const text = previousVersionText({ version: 'v1.66.0', snapshot: 'v1.66.0-v1.67.0', snapshotCreated: '2026-10-22T10:00:00Z' }, 'v1.67.0', formatDay)
  assert.equal(
    text,
    `Previous version: v1.66.0 (database from ${formatDay('2026-10-22T10:00:00Z')}). To go back:`,
  )
})

test('the rollback command comes from the worker, with the hsi default', () => {
  assert.equal(rollbackCommand('sudo nas-worker update rollback'), 'sudo nas-worker update rollback')
  assert.equal(rollbackCommand(null), 'sudo hsi-worker update rollback')
  assert.equal(rollbackCommand(''), 'sudo hsi-worker update rollback')
})

test('a rollback target without a snapshot says so instead of formatting null', () => {
  assert.equal(
    previousVersionText({ version: 'v1.66.0', snapshot: null, snapshotCreated: null }, 'v1.67.0', formatDay),
    'Previous version: v1.66.0 (no database snapshot). To go back:',
  )
})

test('a manual rollback reads as an action, not a failure', () => {
  const manual = { ...base, status: 'rolled-back', step: 'manual', reason: 'rolled back by the administrator' }
  assert.equal(lastResultText(manual), 'Rolled back from v1.67.0 to v1.66.0 by hand.')
  assert.equal(lastResultIsProblem(manual), false)
  assert.equal(lastResultIsProblem({ ...base, status: 'success' }), false)
  assert.equal(lastResultIsProblem({ ...base, status: 'rolled-back' }), true)
  assert.equal(lastResultIsProblem({ ...manual, status: 'rollback-failed' }), true)
})

test('a rollback target newer than current is a version to return to', () => {
  const t = { version: 'v1.67.1', snapshot: 'v1.67.1-v1.67.0', snapshotCreated: '2026-10-23T05:00:00Z' }
  assert.equal(
    previousVersionText(t, 'v1.67.0', formatDay),
    `Version you can return to: v1.67.1 (database from ${formatDay('2026-10-23T05:00:00Z')}). To go back:`,
  )
  assert.match(previousVersionText({ ...t, version: 'v1.66.10' }, 'v1.66.9', formatDay) ?? '', /^Version you can return to/)
  assert.match(previousVersionText({ ...t, version: 'v1.66.9' }, 'v1.66.10', formatDay) ?? '', /^Previous version/)
  assert.match(previousVersionText({ ...t, version: 'v1.67.0' }, 'v1.67.0-rc1', formatDay) ?? '', /^Version you can return to/)
})

test('a reinstall reads as such', () => {
  assert.equal(lastResultText({ ...base, from: 'v1.67.0', to: 'v1.67.0', status: 'success', step: 'repair' }), 'Reinstalled v1.67.0')
})
