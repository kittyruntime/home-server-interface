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
