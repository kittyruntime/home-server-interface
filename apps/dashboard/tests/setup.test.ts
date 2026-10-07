import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupScreen, validHostname } from '../src/lib/setup.ts'

test('setupScreen: before the administrator exists, the token then the account', () => {
  assert.equal(setupScreen({ required: true, step: 'admin' }, false, false), 'token')
  assert.equal(setupScreen({ required: true, step: 'admin' }, false, true), 'admin')
  // A stale login from another install does not skip the token.
  assert.equal(setupScreen({ required: true, step: 'admin' }, true, false), 'token')
})

test('setupScreen: after, the recorded step behind the normal login', () => {
  assert.equal(setupScreen({ required: false, step: 'identity' }, false, false), 'login')
  assert.equal(setupScreen({ required: false, step: 'identity' }, true, false), 'identity')
  assert.equal(setupScreen({ required: false, step: 'next' }, true, false), 'next')
  assert.equal(setupScreen({ required: false, step: null }, true, false), 'done')
  assert.equal(setupScreen({ required: false, step: null }, false, true), 'done')
})

test('validHostname follows RFC 1123 labels', () => {
  for (const ok of ['nas', 'NAS-1', 'a', 'x'.repeat(63)]) assert.ok(validHostname(ok), ok)
  for (const bad of ['', '-nas', 'nas-', 'na_s', 'nas.local', 'x'.repeat(64)]) assert.ok(!validHostname(bad), bad)
})
