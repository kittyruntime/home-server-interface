import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSecret, portCandidates } from '../src/components/store/install-helpers.ts'

test('generateSecret is long, URL-safe and different each time', () => {
  const a = generateSecret()
  const b = generateSecret()
  assert.match(a, /^[A-Za-z0-9_-]{43}$/) // 32 random bytes, base64url without padding
  assert.notEqual(a, b)
})

test('portCandidates skips the ports the form already uses', () => {
  assert.deepEqual(portCandidates(8081, new Set([8082, 8084]), 4), [8082 + 1, 8085, 8086, 8087])
})

test('portCandidates stays in the valid range', () => {
  assert.deepEqual(portCandidates(65534, new Set(), 5), [65535])
})
