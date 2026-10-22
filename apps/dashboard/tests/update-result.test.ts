import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastResultText, previousVersionText } from '../src/lib/update-result.ts'
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

test('previous version line names the date and the rollback command', () => {
  assert.equal(previousVersionText([], formatDay), null)
  const text = previousVersionText([{ version: 'v1.66.0', snapshot: 'v1.66.0-v1.67.0', snapshotCreated: '2026-10-22T10:00:00Z' }], formatDay)
  assert.equal(
    text,
    `Previous version: v1.66.0 (database from ${formatDay('2026-10-22T10:00:00Z')}). To go back:`,
  )
})

test('a previous version without a snapshot says so instead of formatting null', () => {
  assert.equal(
    previousVersionText([{ version: 'v1.66.0', snapshot: null, snapshotCreated: null }], formatDay),
    'Previous version: v1.66.0 (no database snapshot). To go back:',
  )
})
