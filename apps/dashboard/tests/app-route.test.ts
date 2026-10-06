import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appFromQuery, appQuery } from '../src/lib/app-route.ts'

const allowed = ['dashboard', 'files', 'storage', 'settings']

test('appFromQuery opens an app the user has, else Overview', () => {
  assert.equal(appFromQuery('storage', allowed), 'storage')
  assert.equal(appFromQuery(undefined, allowed), 'dashboard')
  assert.equal(appFromQuery('nope', allowed), 'dashboard')
  assert.equal(appFromQuery('monitor', allowed), 'dashboard') // not in this user's apps
  assert.equal(appFromQuery(['files', 'storage'], allowed), 'files')
})

test('appQuery keeps other parameters and drops app for Overview', () => {
  assert.deepEqual(appQuery({ x: '1' }, 'files'), { x: '1', app: 'files' })
  assert.deepEqual(appQuery({ x: '1', app: 'files' }, 'dashboard'), { x: '1' })
})
