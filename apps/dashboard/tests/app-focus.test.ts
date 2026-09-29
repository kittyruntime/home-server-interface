import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appToFocus } from '../src/lib/app-focus.ts'

const apps = [{ id: 'a1', name: 'web' }, { id: 'a2', name: 'demo1' }]

test('the new app is focused once it appears in the list', () => {
  assert.equal(appToFocus('demo1', apps)?.id, 'a2')
})

test('an app not listed yet (still syncing) stays pending', () => {
  assert.equal(appToFocus('demo2', apps), null)
})

test('nothing is focused without a pending request', () => {
  assert.equal(appToFocus(null, apps), null)
})
