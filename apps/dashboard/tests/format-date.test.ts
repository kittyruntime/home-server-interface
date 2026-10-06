import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDay, formatDateTime } from '../src/lib/format-date.ts'

const d = '2026-10-06T14:05:09Z'

test('formatDay and formatDateTime use the same medium date', () => {
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(d))
  assert.equal(formatDay(d), day)
  assert.ok(formatDateTime(d).startsWith(day))
  assert.equal(formatDateTime(new Date(d)), new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d)))
  assert.equal(formatDateTime(d, { seconds: true }), new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(d)))
})

test('missing or invalid dates read as a dash', () => {
  assert.equal(formatDay(null), '-')
  assert.equal(formatDateTime('not a date'), '-')
})
