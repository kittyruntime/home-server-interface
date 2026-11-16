import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reasonKey } from '../src/lib/share-reasons.ts'

test('known reasons have their own text', () => {
  for (const r of ['wrong_password', 'unknown_user', 'account_disabled', 'no_access', 'blocked']) {
    assert.equal(reasonKey(r), `sharing.reason.${r}`)
  }
})

test('unknown reason', () => {
  assert.equal(reasonKey('xyz'), 'sharing.reason.other')
  assert.equal(reasonKey(''), 'sharing.reason.other')
})

import { eventKey } from '../src/lib/share-reasons.ts'

test('event sentences', () => {
  assert.equal(eventKey({ kind: 'connect', result: 'ok' }), 'sharing.event.connected')
  assert.equal(eventKey({ kind: 'disconnect', result: 'ok' }), 'sharing.event.disconnected')
  assert.equal(eventKey({ kind: 'auth', result: 'ok' }), 'sharing.event.signedIn')
  assert.equal(eventKey({ kind: 'auth', result: 'refused' }), 'sharing.event.refusedSignIn')
  assert.equal(eventKey({ kind: 'connect', result: 'refused' }), 'sharing.event.refusedShare')
})
