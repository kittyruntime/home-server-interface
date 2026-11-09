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

test('a place properties request asks the shell for that place access settings', async () => {
  const { focusPlaceAccess, pendingPlaceAccess } = await import('../src/lib/app-focus.ts')
  assert.equal(pendingPlaceAccess.value, null)
  focusPlaceAccess('place-1')
  assert.equal(pendingPlaceAccess.value, 'place-1')
})

test('a folder request is taken once, by the file manager that opens it', async () => {
  const { focusFolder, takeFolderFocus, pendingFolder } = await import('../src/lib/app-focus.ts')
  assert.equal(takeFolderFocus(), null)
  focusFolder('/srv/b/Archives')
  assert.equal(pendingFolder.value, '/srv/b/Archives')
  assert.equal(takeFolderFocus(), '/srv/b/Archives')
  assert.equal(takeFolderFocus(), null)
})
