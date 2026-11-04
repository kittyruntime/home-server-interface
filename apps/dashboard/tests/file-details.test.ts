import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes, formatDuration, formatExactBytes } from '../src/lib/file-details.ts'

test('sizes use 1024 steps, with more precision from GB', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 ** 3), '5.00 GB')
  assert.equal(formatBytes(Number.NaN), '0 B')
})

test('exact byte counts are grouped', () => {
  assert.equal(formatExactBytes(1234567, 'en'), '1,234,567')
})

test('durations read as m:ss, or h:mm:ss from an hour', () => {
  assert.equal(formatDuration(65.4), '1:05')
  assert.equal(formatDuration(3725), '1:02:05')
  assert.equal(formatDuration(-3), '0:00')
})
