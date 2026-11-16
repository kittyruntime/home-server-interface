import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeTime } from '../src/lib/relative-time.ts'

const now = Date.parse('2026-11-16T12:00:00Z')

test('picks the largest fitting unit', () => {
  assert.equal(relativeTime(now - 20_000, now, 'en'), 'now')
  assert.equal(relativeTime(now - 12 * 60_000, now, 'en'), '12 minutes ago')
  assert.equal(relativeTime(now - 3 * 3_600_000, now, 'en'), '3 hours ago')
  assert.equal(relativeTime(now - 86_400_000, now, 'en'), 'yesterday')
  assert.equal(relativeTime(new Date(now - 5 * 86_400_000).toISOString(), now, 'en'), '5 days ago')
})

test('speaks the given language', () => {
  assert.equal(relativeTime(now - 12 * 60_000, now, 'fr'), 'il y a 12 minutes')
})
